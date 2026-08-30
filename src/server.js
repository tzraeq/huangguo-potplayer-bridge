import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import html from './web/index.html' with { type: 'text' };
import css from './web/styles.css' with { type: 'text' };
import browserJs from './web/app.js' with { type: 'text' };
import {
  SITE,
  SITE_HEADERS,
  TABS,
  getCatalog,
  getDetail,
  getSourceStatus,
  resolveEpisode,
  searchCatalog,
} from './lib/scraper.js';
import { DataStore } from './lib/data-store.js';
import { diagnosticEvents, recordDiagnostic } from './lib/diagnostics.js';
import { preflightHls } from './lib/hls-check.js';
import { ImageProxy } from './lib/image-proxy.js';
import { RETRY_POLICY } from './lib/retry.js';
import { startTray } from './lib/tray.js';
import {
  detectPotPlayer,
  launchPotPlayer,
  launchPotPlayerPlaylist,
  validatePotPlayerPath,
} from './lib/potplayer.js';

const APP_ID = 'huangguo-potplayer-bridge';
const APP_NAME = '黄果 PotPlayer 点播台';
const VERSION = '1.1.0';
const PORTS = Array.from({ length: 9 }, (_, index) => 17891 + index);
const JOB_TTL_MS = 30 * 60 * 1000;
const runtimeName = path.basename(process.execPath).toLowerCase();
const sourceMode = runtimeName.startsWith('bun') || runtimeName.startsWith('node');
const appDirectory = sourceMode ? path.resolve(import.meta.dir, '..') : path.dirname(process.execPath);
const dataStore = new DataStore(appDirectory);
const imageProxy = new ImageProxy(SITE_HEADERS);
const sessionToken = randomBytes(24).toString('base64url');
const playlistJobs = new Map();
const startedAt = Date.now();
let baseOrigin = '';
let server;
let trayProcess = null;

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function errorJson(error, status = 500, context = 'request') {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  recordDiagnostic(status >= 500 ? 'error' : 'warn', context, message, {
    status,
    code: error?.code,
  });
  return json({ ok: false, error: message, code: error?.code || '' }, status);
}

function asset(body, type) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (type.startsWith('text/html')) {
    headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    headers['X-Frame-Options'] = 'DENY';
    headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()';
  }
  return new Response(body, { headers });
}

function potPlayerInfo() {
  return detectPotPlayer(dataStore.settings.potPlayerPath);
}

function trayIsRunning() {
  return Boolean(trayProcess && trayProcess.exitCode === null && !trayProcess.killed);
}

function allowImages(items) {
  for (const item of items || []) imageProxy.allow(item.image);
}

function hostAllowed(request) {
  if (!baseOrigin) return true;
  try {
    return new URL(request.url).host === new URL(baseOrigin).host;
  } catch {
    return false;
  }
}

function crossSiteAllowed(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== baseOrigin) return false;
  return request.headers.get('sec-fetch-site') !== 'cross-site';
}

function suppliedToken(request, url) {
  return request.headers.get('x-hg-token') || url.searchParams.get('token') || '';
}

function authorized(request, url) {
  const token = suppliedToken(request, url);
  if (!token || token.length !== sessionToken.length) return false;
  try {
    return Buffer.from(token).equals(Buffer.from(sessionToken));
  } catch {
    return false;
  }
}

async function requestBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 64 * 1024) throw new Error('请求内容过大');
  const text = await request.text();
  if (text.length > 64 * 1024) throw new Error('请求内容过大');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('请求数据不是有效 JSON');
  }
}

function cleanM3uText(value) {
  return String(value || '').replace(/["\r\n,]+/g, ' ').trim();
}

function makePlaylist(detail, episodes) {
  const lines = ['#EXTM3U'];
  for (const episode of episodes) {
    const source = new URL(episode.source);
    if (!['http:', 'https:'].includes(source.protocol)) throw new Error('剧集播放地址不是 HTTP 地址');
    const label = cleanM3uText(`${detail.title} · ${episode.name}`);
    lines.push(`#EXTINF:-1 group-title="${cleanM3uText(detail.title)}",${label}`);
    lines.push(source.href);
  }
  return { detail, episodes, text: `${lines.join('\r\n')}\r\n` };
}

function writeLocalPlaylist(playlist) {
  const filePath = dataStore.playlistPath(playlist.detail.id);
  writeFileSync(filePath, `\ufeff${playlist.text}`, 'utf8');
  return filePath;
}

function shouldRefreshPlayback(error) {
  if (error?.name === 'AbortError' || error?.name === 'RetryExhaustedError') return false;
  return [401, 403, 404, 410].includes(error?.status) || /HLS|清单|播放资源|视频片段/i.test(error?.message || '');
}

async function resolvePlayable(id, ep, signal) {
  let resolved = await resolveEpisode(id, ep, { signal });
  try {
    await preflightHls(resolved, { signal, checkMedia: true });
  } catch (error) {
    if (!shouldRefreshPlayback(error)) throw error;
    recordDiagnostic('warn', 'playback.refresh', '首次播放预检失败，正在重新解析', { status: error?.status });
    resolved = await resolveEpisode(id, ep, { signal, forceDetail: true });
    await preflightHls(resolved, { signal, checkMedia: true });
  }
  recordDiagnostic('info', 'playback.preflight', '播放清单和首个媒体片段验证通过', {
    itemId: resolved.detail.id,
    episode: resolved.episode.ep,
  });
  return resolved;
}

function publicJob(job) {
  return {
    id: job.id,
    itemId: job.itemId,
    title: job.title,
    status: job.status,
    total: job.total,
    completed: job.completed,
    succeeded: job.succeeded,
    failed: job.failed,
    failures: job.failures.slice(0, 20),
    message: job.message,
    result: job.result,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of playlistJobs) {
    if (now - job.updatedAt > JOB_TTL_MS && !['queued', 'running', 'cancelling'].includes(job.status)) {
      playlistJobs.delete(id);
    }
  }
}

async function runPlaylistJob(job) {
  job.status = 'running';
  job.message = '正在读取剧集';
  job.updatedAt = Date.now();
  const signal = job.controller.signal;
  try {
    const detail = await getDetail(job.itemId, false, signal);
    job.title = detail.title;
    job.total = detail.episodes.length;
    job.message = '正在逐集验证';
    const verified = new Array(detail.episodes.length);
    let cursor = 0;

    async function worker() {
      while (!signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= detail.episodes.length) return;
        const episode = detail.episodes[index];
        try {
          const resolved = await resolveEpisode(detail.id, episode.ep, { signal });
          await preflightHls(resolved, { signal, checkMedia: false });
          verified[index] = { ...episode, source: resolved.source };
          job.succeeded += 1;
        } catch (error) {
          if (signal.aborted) return;
          job.failed += 1;
          job.failures.push({ ep: episode.ep, name: episode.name, error: error.message || '解析失败' });
        } finally {
          if (!signal.aborted) job.completed += 1;
          job.updatedAt = Date.now();
        }
      }
    }

    const workers = Math.min(2, detail.episodes.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (signal.aborted) {
      job.status = 'cancelled';
      job.message = '任务已取消';
      return;
    }

    const episodes = verified.filter(Boolean);
    if (!episodes.length) throw new Error('没有任何剧集通过播放验证');
    const playlist = makePlaylist(detail, episodes);
    const playlistPath = writeLocalPlaylist(playlist);
    job.result = {
      playlistPath,
      includedEpisodes: episodes.length,
      skippedEpisodes: job.failed,
    };
    job.status = 'complete';
    job.message = job.failed ? `已完成，跳过 ${job.failed} 集` : '全部剧集验证通过';
    recordDiagnostic('info', 'playlist.complete', job.message, {
      itemId: detail.id,
      succeeded: job.succeeded,
      failed: job.failed,
    });
  } catch (error) {
    if (signal.aborted) {
      job.status = 'cancelled';
      job.message = '任务已取消';
    } else {
      job.status = 'failed';
      job.message = error.message || '整剧解析失败';
      recordDiagnostic('error', 'playlist.failed', job.message, { itemId: job.itemId });
    }
  } finally {
    job.updatedAt = Date.now();
  }
}

function createPlaylistJob(itemId) {
  cleanupJobs();
  const id = randomBytes(15).toString('base64url');
  const now = Date.now();
  const job = {
    id,
    itemId: String(itemId || ''),
    title: '',
    status: 'queued',
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
    message: '任务已创建',
    result: null,
    controller: new AbortController(),
    createdAt: now,
    updatedAt: now,
  };
  if (!/^\d+$/.test(job.itemId)) throw new Error('无效的条目编号');
  playlistJobs.set(id, job);
  void runPlaylistJob(job);
  return job;
}

function openBrowser(url) {
  try {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

function restartSelf() {
  const args = sourceMode ? [path.join(import.meta.dir, 'server.js')] : [];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HG_RESTART_CHILD: '1' },
  });
  child.unref();
}

async function existingInstance() {
  for (const port of PORTS) {
    const origin = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (!response.ok) continue;
      const data = await response.json();
      if (data?.appId === APP_ID) return origin;
    } catch {}
  }
  return '';
}

function diagnosticsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      id: APP_ID,
      name: APP_NAME,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      origin: baseOrigin,
      dataDirectory: dataStore.directory,
      trayRunning: trayIsRunning(),
    },
    potPlayer: potPlayerInfo(),
    source: getSourceStatus(),
    retry: {
      maxRetries: RETRY_POLICY.attempts - 1,
      backoffMs: RETRY_POLICY.delaysMs,
      playlistConcurrency: 2,
    },
    jobs: [...playlistJobs.values()].slice(-10).map((job) => {
      const view = publicJob(job);
      if (view.result) {
        view.result = {
          includedEpisodes: view.result.includedEpisodes,
          skippedEpisodes: view.result.skippedEpisodes,
        };
      }
      return view;
    }),
    events: diagnosticEvents(80),
  };
}

async function handle(request) {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);

  if (!hostAllowed(request)) return new Response('Misdirected Request', { status: 421 });
  if (!crossSiteAllowed(request)) return errorJson(new Error('拒绝跨站访问本地服务'), 403, 'security.cross_site');

  if (request.method === 'GET' && pathname === '/') return asset(html, 'text/html; charset=utf-8');
  if (request.method === 'GET' && pathname === '/assets/styles.css') return asset(css, 'text/css; charset=utf-8');
  if (request.method === 'GET' && pathname === '/assets/app.js') return asset(browserJs, 'text/javascript; charset=utf-8');
  if (request.method === 'GET' && pathname === '/favicon.ico') return new Response(null, { status: 204 });

  if (request.method === 'GET' && pathname === '/api/health') {
    return json({
      ok: true,
      appId: APP_ID,
      name: APP_NAME,
      version: VERSION,
      site: SITE,
      origin: baseOrigin,
      sessionToken,
      dataDirectory: dataStore.directory,
      trayRunning: trayIsRunning(),
      sourceStatus: getSourceStatus(),
      retry: {
        maxRetries: RETRY_POLICY.attempts - 1,
        backoffMs: RETRY_POLICY.delaysMs,
        playlistConcurrency: 2,
      },
      tabs: TABS,
      potPlayer: potPlayerInfo(),
    });
  }

  if (request.method === 'GET' && pathname === '/api/catalog') {
    try {
      const result = await getCatalog(url.searchParams.get('tab') || 'home', url.searchParams.get('page') || '1');
      allowImages(result.list);
      return json({ ok: true, ...result, sourceStatus: getSourceStatus() });
    } catch (error) {
      return errorJson(error, 502, 'catalog.load');
    }
  }

  if (request.method === 'GET' && pathname === '/api/search') {
    try {
      const result = await searchCatalog(
        url.searchParams.get('q') || '',
        url.searchParams.get('page') || '1'
      );
      allowImages(result.list);
      return json({ ok: true, ...result, sourceStatus: getSourceStatus() });
    } catch (error) {
      return errorJson(error, 502, 'search.load');
    }
  }

  const detailMatch = pathname.match(/^\/api\/detail\/(\d+)$/);
  if (request.method === 'GET' && detailMatch) {
    try {
      const detail = await getDetail(detailMatch[1]);
      imageProxy.allow(detail.image);
      return json({ ok: true, detail, sourceStatus: getSourceStatus() });
    } catch (error) {
      return errorJson(error, 502, 'detail.load');
    }
  }

  const playlistMatch = pathname.match(/^\/api\/playlist\/(\d+)\.m3u$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && playlistMatch) {
    if (!authorized(request, url)) return new Response('播放列表令牌无效或已过期', { status: 403 });
    try {
      const playlistPath = dataStore.playlistPath(playlistMatch[1]);
      if (!existsSync(playlistPath)) {
        return new Response('请先在点播台创建整剧播放列表', { status: 404 });
      }
      const body = readFileSync(playlistPath);
      const fileName = encodeURIComponent(`huangguo-${playlistMatch[1]}.m3u`);
      const headers = {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Content-Disposition': `inline; filename*=UTF-8''${fileName}`,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
      };
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(body, { headers });
    } catch (error) {
      return errorJson(error, 502, 'playlist.download');
    }
  }

  if (request.method === 'GET' && pathname === '/api/image') {
    return imageProxy.handle(url.searchParams.get('url') || '');
  }

  if (request.method === 'GET' && pathname === '/api/library') {
    if (!authorized(request, url)) return errorJson(new Error('本地会话令牌无效'), 403, 'security.token');
    const library = dataStore.snapshot();
    allowImages([...library.favorites, ...library.history]);
    return json({ ok: true, ...library });
  }

  if (request.method === 'GET' && pathname === '/api/diagnostics') {
    if (!authorized(request, url)) return errorJson(new Error('本地会话令牌无效'), 403, 'security.token');
    return json({ ok: true, diagnostics: diagnosticsSnapshot() });
  }

  const jobMatch = pathname.match(/^\/api\/playlist-jobs\/([A-Za-z0-9_-]+)$/);
  if (request.method === 'GET' && jobMatch) {
    if (!authorized(request, url)) return errorJson(new Error('本地会话令牌无效'), 403, 'security.token');
    const job = playlistJobs.get(jobMatch[1]);
    return job ? json({ ok: true, job: publicJob(job) }) : errorJson(new Error('整剧任务不存在或已经过期'), 404, 'playlist.job_missing');
  }

  if (request.method === 'POST' && !authorized(request, url)) {
    return errorJson(new Error('本地会话令牌无效，请刷新页面'), 403, 'security.token');
  }

  if (request.method === 'POST' && pathname === '/api/play') {
    try {
      const body = await requestBody(request);
      const resolved = await resolvePlayable(body.id, body.ep);
      if (body.launch !== false) launchPotPlayer(potPlayerInfo().path, resolved.source);
      const history = body.launch === false ? null : dataStore.recordHistory(resolved.detail, resolved.episode);
      return json({
        ok: true,
        title: resolved.detail.title,
        episode: resolved.episode.name,
        streamUrl: resolved.source,
        launched: body.launch !== false,
        history,
      });
    } catch (error) {
      return errorJson(error, 502, 'playback.launch');
    }
  }

  if (request.method === 'POST' && pathname === '/api/playlist-jobs') {
    try {
      const body = await requestBody(request);
      const job = createPlaylistJob(body.id);
      return json({ ok: true, job: publicJob(job) }, 202);
    } catch (error) {
      return errorJson(error, 400, 'playlist.job_create');
    }
  }

  const cancelJobMatch = pathname.match(/^\/api\/playlist-jobs\/([A-Za-z0-9_-]+)\/cancel$/);
  if (request.method === 'POST' && cancelJobMatch) {
    const job = playlistJobs.get(cancelJobMatch[1]);
    if (!job) return errorJson(new Error('整剧任务不存在或已经过期'), 404, 'playlist.job_missing');
    if (['queued', 'running'].includes(job.status)) {
      job.status = 'cancelling';
      job.message = '正在取消';
      job.updatedAt = Date.now();
      job.controller.abort(new DOMException('用户取消任务', 'AbortError'));
    }
    return json({ ok: true, job: publicJob(job) });
  }

  const openJobMatch = pathname.match(/^\/api\/playlist-jobs\/([A-Za-z0-9_-]+)\/open$/);
  if (request.method === 'POST' && openJobMatch) {
    try {
      const body = await requestBody(request);
      const job = playlistJobs.get(openJobMatch[1]);
      if (!job || job.status !== 'complete' || !job.result?.playlistPath) {
        throw new Error('整剧任务尚未完成或已经过期');
      }
      if (body.launch !== false) launchPotPlayerPlaylist(potPlayerInfo().path, job.result.playlistPath);
      return json({ ok: true, ...job.result, launched: body.launch !== false });
    } catch (error) {
      return errorJson(error, 409, 'playlist.job_open');
    }
  }

  if (request.method === 'POST' && pathname === '/api/favorites') {
    try {
      const body = await requestBody(request);
      const detail = await getDetail(body.id);
      imageProxy.allow(detail.image);
      const library = dataStore.setFavorite(detail, body.favorite !== false);
      return json({ ok: true, ...library });
    } catch (error) {
      return errorJson(error, 400, 'library.favorite');
    }
  }

  if (request.method === 'POST' && pathname === '/api/history/clear') {
    return json({ ok: true, ...dataStore.clearHistory() });
  }

  if (request.method === 'POST' && pathname === '/api/settings') {
    try {
      const body = await requestBody(request);
      const validated = validatePotPlayerPath(body.potPlayerPath);
      dataStore.saveSettings(validated);
      return json({ ok: true, potPlayer: potPlayerInfo() });
    } catch (error) {
      return errorJson(error, 400, 'settings.save');
    }
  }

  if (request.method === 'POST' && pathname === '/api/restart') {
    recordDiagnostic('info', 'service.restart', '用户请求重启本地服务');
    restartSelf();
    setTimeout(() => {
      try { server?.stop(true); } finally { process.exit(0); }
    }, 350);
    return json({ ok: true, message: '服务正在重启' });
  }

  if (request.method === 'POST' && pathname === '/api/shutdown') {
    recordDiagnostic('info', 'service.shutdown', '用户请求关闭本地服务');
    setTimeout(() => {
      try { server?.stop(true); } finally { process.exit(0); }
    }, 250);
    return json({ ok: true, message: '服务正在关闭' });
  }

  return new Response('Not Found', { status: 404 });
}

if (process.env.HG_RESTART_CHILD === '1') {
  await new Promise((resolve) => setTimeout(resolve, 900));
}

const current = await existingInstance();
if (current) {
  if (process.env.HG_NO_BROWSER !== '1') openBrowser(current);
  process.exit(0);
}

for (const port of PORTS) {
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: handle,
      error(error) {
        console.error(error);
        return errorJson(new Error('本地服务发生异常'), 500, 'server.unhandled');
      },
    });
    break;
  } catch {}
}

if (!server) throw new Error('端口 17891–17899 均被占用，无法启动本地服务');
baseOrigin = `http://127.0.0.1:${server.port}`;
const removedPlaylists = dataStore.cleanupPlaylists();
recordDiagnostic('info', 'service.started', `${APP_NAME} 已启动`, {
  version: VERSION,
  port: server.port,
  removedPlaylists,
});
trayProcess = startTray(dataStore.directory, baseOrigin, sessionToken);
console.log(`${APP_NAME} ${VERSION}：${baseOrigin}`);
if (process.env.HG_NO_BROWSER !== '1') setTimeout(() => openBrowser(baseOrigin), 350);

const cleanupTimer = setInterval(() => {
  cleanupJobs();
  const removed = dataStore.cleanupPlaylists();
  if (removed) recordDiagnostic('info', 'playlist.cleanup', '已清理过期播放列表', { removed });
}, 6 * 60 * 60 * 1000);
cleanupTimer.unref?.();
