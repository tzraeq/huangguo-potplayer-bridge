import { fetchWithRetry } from './retry.js';
import { recordDiagnostic } from './diagnostics.js';

export const SOURCE_ENTRY = 'https://huangguoai.ai';
const FALLBACK_SITE = 'https://huangguoai.com';
export let SITE = FALLBACK_SITE;
let sourceSelected = false;
let sourceSelection = null;

export const TABS = Object.freeze([
  { name: '首页', id: 'home' },
  { name: 'AI成人短剧', id: 'ai-duanju' },
  { name: 'AI成人漫剧', id: 'ai-manju' },
  { name: 'AI换脸', id: 'ai-huanlian' },
  { name: 'AI魔改', id: 'ai-mogai' },
  { name: '排行榜', id: 'ranks/hot' },
]);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const SITE_HEADERS = Object.freeze({
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  get Referer() { return `${SITE}/`; },
});

const catalogCache = new Map();
const detailCache = new Map();
const CACHE_MS = 5 * 60 * 1000;
const sourceStatus = {
  state: 'unknown',
  lastCheckedAt: '',
  area: '',
  message: '尚未检查内容源结构',
};

class SourceStructureError extends Error {
  constructor(area, message) {
    super(message);
    this.name = 'SourceStructureError';
    this.code = 'SOURCE_STRUCTURE_CHANGED';
    sourceStatus.state = 'changed';
    sourceStatus.lastCheckedAt = new Date().toISOString();
    sourceStatus.area = area;
    sourceStatus.message = message;
  }
}

function markStructureOk(area) {
  sourceStatus.state = 'ok';
  sourceStatus.lastCheckedAt = new Date().toISOString();
  sourceStatus.area = area;
  sourceStatus.message = '内容源页面结构正常';
}

export function getSourceStatus() {
  return { ...sourceStatus, entryUrl: SOURCE_ENTRY, baseUrl: sourceSelected ? SITE : '' };
}

function getCached(cache, key) {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    if (hit) cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(cache, key, value, ttl = CACHE_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return value;
}

export function fixUrl(value) {
  const input = decodeEntities(String(value || '').trim());
  if (!input) return '';
  if (input.startsWith('//')) return `https:${input}`;
  if (input.startsWith('/')) return `${SITE}${input}`;
  try {
    return new URL(input, SITE).href;
  } catch {
    return '';
  }
}

function stableImageUrl(value) {
  const fixed = fixUrl(value);
  if (!fixed) return '';
  try {
    const url = new URL(fixed);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return fixed.replace(/\?.*$/, '');
  }
}

export function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value) {
  return decodeEntities(
    String(value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeEntities(match[2]) : '';
}

function metaContent(html, property) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = attribute(tag, 'property') || attribute(tag, 'name');
    if (key.toLowerCase() === property.toLowerCase()) return attribute(tag, 'content');
  }
  return '';
}

async function fetchPage(url, referer, options = {}) {
  return fetchWithRetry(
    url,
    {
      headers: { ...SITE_HEADERS, Referer: referer },
      redirect: 'follow',
      signal: options.signal,
    },
    {
      timeoutMs: options.timeoutMs || 20_000,
      attempts: options.attempts,
      label: '连接内容源',
      consume: async (response) => {
        if (!response.ok) {
          const error = new Error(`目标站点返回 HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > 5_000_000) throw new Error('目标页面异常过大，已停止读取');
        return { html: await response.text(), url: response.url || url };
      },
    }
  );
}

export async function fetchHtml(url, referer = `${SITE}/`, options = {}) {
  return (await fetchPage(url, referer, options)).html;
}

export function parseSourceRoutes(html) {
  const routes = new Set();
  for (const tag of String(html || '').match(/<a\b[^>]*>/gi) || []) {
    if (!attribute(tag, 'class').split(/\s+/).includes('use-btn')) continue;
    try {
      const url = new URL(attribute(tag, 'href'), `${SOURCE_ENTRY}/`);
      if (url.protocol === 'https:' && url.origin !== SOURCE_ENTRY && !url.username && !url.password) {
        routes.add(url.origin);
      }
    } catch {}
  }
  return [...routes];
}

async function selectSource() {
  let routes = [];
  try {
    const html = await fetchHtml(`${SOURCE_ENTRY}/`, `${SOURCE_ENTRY}/`, { timeoutMs: 10_000, attempts: 2 });
    routes = parseSourceRoutes(html);
    if (!routes.length) throw new Error('发布页没有返回线路按钮');
  } catch (error) {
    recordDiagnostic('warn', 'source.discovery', '线路发布页读取失败，将验证永久域名', { reason: error.message });
  }

  for (const candidate of new Set([...routes, FALLBACK_SITE])) {
    try {
      const page = await fetchPage(`${candidate}/`, `${candidate}/`, { attempts: 1 });
      if (!/\bhg-card-grid\b/i.test(page.html) || !parseGridCards(page.html, true).length) {
        throw new Error('线路首页没有可解析的目录内容');
      }
      SITE = new URL(page.url).origin;
      sourceSelected = true;
      setCached(catalogCache, 'home:1', {
        tab: 'home', page: 1, list: parseGridCards(page.html, true), hasMore: false,
      });
      markStructureOk('catalog');
      recordDiagnostic('info', 'source.selected', '已选定可用的内容源线路', { host: new URL(SITE).host });
      return;
    } catch (error) {
      recordDiagnostic('warn', 'source.probe', '内容源线路不可用，继续尝试下一条', {
        host: new URL(candidate).host, reason: error.message,
      });
    }
  }
  throw new Error('没有可用的内容源线路，请检查网络或稍后重试');
}

async function ensureSource(signal) {
  signal?.throwIfAborted();
  if (!sourceSelected) {
    sourceSelection ||= selectSource().finally(() => { sourceSelection = null; });
    await sourceSelection;
  }
  signal?.throwIfAborted();
}

export function hasNextPage(html) {
  const linkTags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  if (linkTags.some((tag) => {
    const rel = attribute(tag, 'rel').toLowerCase().split(/\s+/);
    return rel.includes('next') && Boolean(attribute(tag, 'href'));
  })) return true;

  const anchorTags = String(html || '').match(/<a\b[^>]*>/gi) || [];
  return anchorTags.some((tag) => {
    const classes = attribute(tag, 'class').split(/\s+/);
    return classes.includes('hg-pager__arrow') && attribute(tag, 'title') === '下一页' && Boolean(attribute(tag, 'href'));
  });
}

function gridSlices(html, allGrids) {
  const regex = /<div\s+class=(["'])[^"']*\bhg-card-grid\b[^"']*\1[^>]*>/gi;
  const starts = [];
  let match;
  while ((match = regex.exec(html)) !== null) starts.push(match.index + match[0].length);
  if (!starts.length) return [];
  const count = allGrids ? starts.length : 1;
  return starts.slice(0, count).map((start, index) => {
    const end = starts[index + 1] || html.length;
    return html.slice(start, end);
  });
}

function cardBlocks(slice) {
  const regex = /<div\s+class=(["'])[^"']*\bhg-drama-card\b[^"']*\1[^>]*>/gi;
  const starts = [];
  let match;
  while ((match = regex.exec(slice)) !== null) starts.push(match.index);
  return starts.map((start, index) => slice.slice(start, starts[index + 1] || slice.length));
}

function parseCardBlock(block) {
  const detail = block.match(/href=(["'])[^"']*\/video\/(\d+)\/[^"']*\1/i);
  if (!detail) return null;
  const imageTag = block.match(/<(?:img|source)\b[^>]*(?:data-src|src)=(["'])[^"']+\1[^>]*>/i)?.[0] || '';
  const image = attribute(imageTag, 'data-src') || attribute(imageTag, 'src');
  const titleMatch = block.match(/hg-drama-card__title[^>]*>([\s\S]*?)<\/a>/i);
  const fallbackTitle = block.match(/<a[^>]+href=(["'])[^"']*\/video\/\d+\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/i);
  const title = stripTags(titleMatch?.[1] || fallbackTitle?.[2] || '');
  if (!title) return null;
  const episode = stripTags(block.match(/hg-drama-card__episode[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
  const score = stripTags(block.match(/hg-drama-card__score[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
  return {
    id: detail[2],
    title,
    image: stableImageUrl(image),
    remark: [episode, score].filter(Boolean).join(' · '),
  };
}

function parseGridCards(html, allGrids) {
  const output = [];
  const seen = new Set();
  for (const slice of gridSlices(html, allGrids)) {
    for (const block of cardBlocks(slice)) {
      const item = parseCardBlock(block);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      output.push(item);
    }
  }
  return output;
}

function parseRanks(html) {
  const marker = html.match(/<div\s+class=(["'])[^"']*\bhg-rank-list\b[^"']*\1[^>]*>/i);
  const slice = marker ? html.slice(marker.index + marker[0].length) : html;
  const regex = /<div\s+class=(["'])[^"']*\bhg-rank-item\b[^"']*\1[^>]*>/gi;
  const starts = [];
  let match;
  while ((match = regex.exec(slice)) !== null) starts.push(match.index);
  const output = [];
  const seen = new Set();
  for (let index = 0; index < starts.length; index += 1) {
    const block = slice.slice(starts[index], starts[index + 1] || slice.length);
    const detail = block.match(/href=(["'])[^"']*\/video\/(\d+)\/[^"']*\1/i);
    if (!detail || seen.has(detail[2])) continue;
    const title = stripTags(
      block.match(/hg-rank-item__title[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ||
      block.match(/<a[^>]+href=(["'])[^"']*\/video\/\d+\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/i)?.[2] ||
      ''
    );
    if (!title) continue;
    const imageTag = block.match(/<(?:img|source)\b[^>]*(?:data-src|src)=(["'])[^"']+\1[^>]*>/i)?.[0] || '';
    const image = attribute(imageTag, 'data-src') || attribute(imageTag, 'src');
    const remark = stripTags(block.match(/hg-rank-item__tags[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    seen.add(detail[2]);
    output.push({ id: detail[2], title, image: stableImageUrl(image), remark });
  }
  return output;
}

function checkParsedCards(html, list, area) {
  if (!list.length && /<div\b[^>]*\bclass=(["'])[^"']*\bhg-(?:drama-card|rank-item)\b[^"']*\1/i.test(html)) {
    throw new SourceStructureError(area, '内容源页面存在条目，但无法解析，请检查页面结构是否已经更新');
  }
  return list;
}

function ensureId(id) {
  const value = String(id || '');
  if (!/^\d+$/.test(value)) throw new Error('无效的条目编号');
  return value;
}

function ensureTab(id) {
  const value = String(id || 'home').replace(/^\/+/, '');
  if (!TABS.some((tab) => tab.id === value)) throw new Error('未知分类');
  return value;
}

export async function getCatalog(tabId = 'home', pageValue = 1, options = {}) {
  const tab = ensureTab(tabId);
  const page = Math.max(1, Math.min(100, Number.parseInt(pageValue, 10) || 1));
  await ensureSource(options.signal);
  const key = `${tab}:${page}`;
  const cached = getCached(catalogCache, key);
  if (cached) return cached;
  let url;
  if (tab === 'home') url = `${SITE}/`;
  else url = `${SITE}/${tab}/${page > 1 ? `${page}/` : ''}`;
  let html;
  try {
    html = await fetchHtml(url, `${SITE}/`, options);
  } catch (error) {
    if (page > 1 && error?.status === 404) {
      return { tab, page, list: [], hasMore: false };
    }
    throw error;
  }
  const ranks = tab.includes('rank');
  const expectedMarker = ranks ? /\bhg-rank-list\b/i : /\bhg-card-grid\b/i;
  if (!expectedMarker.test(html)) {
    throw new SourceStructureError('catalog', '内容源目录结构可能已经更新，请检查新版程序');
  }
  const list = checkParsedCards(html, ranks ? parseRanks(html) : parseGridCards(html, tab === 'home'), 'catalog');
  markStructureOk('catalog');
  return setCached(catalogCache, key, {
    tab,
    page,
    list,
    hasMore: tab !== 'home' && hasNextPage(html),
  });
}

export async function searchCatalog(query, pageValue = 1, options = {}) {
  const text = String(query || '').trim().slice(0, 80);
  const page = Math.max(1, Math.min(100, Number.parseInt(pageValue, 10) || 1));
  if (!text) return { query: '', page, list: [], hasMore: false };
  await ensureSource(options.signal);
  const key = `search:${text}:${page}`;
  const cached = getCached(catalogCache, key);
  if (cached) return cached;
  const url = `${SITE}/search/video/${encodeURIComponent(text)}/${page > 1 ? `${page}/` : ''}`;
  let html;
  try {
    html = await fetchHtml(url, `${SITE}/`, options);
  } catch (error) {
    if (page > 1 && error?.status === 404) return { query: text, page, list: [], hasMore: false };
    throw error;
  }
  if (!/\bhg-card-grid\b/i.test(html)) {
    throw new SourceStructureError('search', '内容源搜索结构可能已经更新，请检查新版程序');
  }
  const list = checkParsedCards(html, parseGridCards(html, false), 'search');
  markStructureOk('search');
  return setCached(catalogCache, key, {
    query: text,
    page,
    list,
    hasMore: hasNextPage(html),
  });
}

function episodeAnchors(html) {
  const output = [];
  const seen = new Set();
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const anchor of anchors) {
    const episodeId = attribute(anchor, 'data-ep-id');
    if (!episodeId && !/\bdata-ep-id\s*=/i.test(anchor)) continue;
    const href = fixUrl(attribute(anchor, 'href'));
    if (!href || seen.has(href)) continue;
    const label = stripTags(anchor);
    output.push({
      ep: episodeId || String(output.length + 1),
      name: episodeId ? `第${episodeId}集` : label || `第${output.length + 1}集`,
      playUrl: href,
    });
    seen.add(href);
  }
  return output;
}

export async function getDetail(idValue, force = false, signal) {
  const id = ensureId(idValue);
  await ensureSource(signal);
  if (!force) {
    const cached = getCached(detailCache, id);
    if (cached) return cached;
  }
  const detailUrl = `${SITE}/video/${id}/`;
  const html = await fetchHtml(detailUrl, `${SITE}/`, { signal });
  let episodes = episodeAnchors(html);
  if (!episodes.length) {
    const playTag = html.match(/<a\b[^>]*class=(["'])[^"']*\bhg-web-detail__play\b[^"']*\1[^>]*>/i)?.[0] || '';
    const playUrl = fixUrl(attribute(playTag, 'href'));
    if (playUrl) episodes = [{ ep: '1', name: '第1集', playUrl }];
  }
  const heading = stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const title = decodeEntities(metaContent(html, 'og:title')) || heading || `条目 ${id}`;
  const description = decodeEntities(metaContent(html, 'og:description'));
  const image = stableImageUrl(metaContent(html, 'og:image'));
  if (!episodes.length || (!heading && !metaContent(html, 'og:title'))) {
    throw new SourceStructureError('detail', '内容源详情页结构可能已经更新，请检查新版程序');
  }
  markStructureOk('detail');
  return setCached(detailCache, id, { id, title, description, image, episodes, detailUrl }, 10 * 60 * 1000);
}

function normalizePlaySource(value) {
  let source = typeof value === 'string' ? value.trim() : '';
  source = source.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
  if (!/^https?:\/\//i.test(source)) source = source.match(/https?:\/\/[^\s"']+/i)?.[0] || '';
  if (!source) throw new Error('播放页没有返回可用的视频地址');
  const parsed = new URL(source);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('播放地址协议不受支持');
  return parsed.href;
}

export async function resolveEpisode(idValue, episodeValue, options = {}) {
  const detail = await getDetail(idValue, Boolean(options.forceDetail), options.signal);
  if (!detail.episodes.length) throw new Error('该条目没有可播放剧集');
  const requested = String(episodeValue || detail.episodes[0].ep);
  const episode = detail.episodes.find((item) => String(item.ep) === requested) || detail.episodes[0];
  const html = await fetchHtml(episode.playUrl, detail.detailUrl, { signal: options.signal });
  const script = html.match(/<script\b[^>]*id=(["'])videoInitialData\1[^>]*>([\s\S]*?)<\/script>/i);
  if (!script) throw new SourceStructureError('play', '内容源播放页结构可能已经更新，请检查新版程序');
  let data;
  try {
    data = JSON.parse(script[2].trim());
  } catch {
    throw new SourceStructureError('play', '内容源播放数据格式已经变化，请检查新版程序');
  }
  const byEpisode = data?.epPlaySrcs || {};
  const source = normalizePlaySource(byEpisode[episode.ep] || data?.videoSrc || Object.values(byEpisode)[0]);
  markStructureOk('play');
  return {
    detail,
    episode,
    source,
    headers: {
      'User-Agent': USER_AGENT,
      Referer: `${SITE}/`,
      Accept: '*/*',
    },
  };
}
