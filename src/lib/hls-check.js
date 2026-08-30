import { fetchWithRetry } from './retry.js';

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

function statusError(label, status) {
  const error = new Error(`${label}返回 HTTP ${status}`);
  error.status = status;
  return error;
}

function firstMediaReference(text) {
  const lines = String(text || '').split(/\r?\n/);
  let afterVariant = false;
  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    if (value.startsWith('#')) {
      afterVariant = /^#EXT-X-STREAM-INF:/i.test(value);
      continue;
    }
    return { value, playlist: afterVariant || /\.m3u8(?:$|[?#])/i.test(value) };
  }
  return null;
}

export async function fetchHlsManifest(url, headers, options = {}) {
  return fetchWithRetry(
    url,
    {
      headers,
      redirect: 'follow',
      signal: options.signal,
    },
    {
      timeoutMs: options.timeoutMs || 30_000,
      label: options.label || '连接视频 CDN',
      consume: async (response) => {
        if (!response.ok) throw statusError('视频 CDN ', response.status);
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_PLAYLIST_BYTES) throw new Error('视频清单异常过大');
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_PLAYLIST_BYTES) throw new Error('视频清单异常过大');
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('视频 CDN 返回的不是 HLS 清单');
        return { text, url: response.url || url };
      },
    }
  );
}

async function verifyMedia(url, headers, signal) {
  return fetchWithRetry(
    url,
    {
      headers: { ...headers, Range: 'bytes=0-2047' },
      redirect: 'follow',
      signal,
    },
    {
      timeoutMs: 30_000,
      label: '验证视频片段',
      consume: async (response) => {
        if (!response.ok && response.status !== 206) throw statusError('视频片段 ', response.status);
        if (!response.body) throw new Error('视频片段没有返回数据');
        const reader = response.body.getReader();
        try {
          const first = await reader.read();
          if (first.done || !first.value?.byteLength) throw new Error('视频片段没有返回数据');
        } finally {
          try { await reader.cancel(); } catch {}
        }
        return true;
      },
    }
  );
}

export async function preflightHls(resolved, options = {}) {
  let manifestUrl = resolved.source;
  let manifest;
  for (let depth = 0; depth < 3; depth += 1) {
    manifest = await fetchHlsManifest(manifestUrl, resolved.headers, {
      signal: options.signal,
      label: depth ? '验证视频清单' : '连接视频 CDN',
    });
    const reference = firstMediaReference(manifest.text);
    if (!reference) throw new Error('视频清单不包含可播放资源');
    const resourceUrl = new URL(reference.value, manifest.url).href;
    if (reference.playlist && depth < 2) {
      manifestUrl = resourceUrl;
      continue;
    }
    if (options.checkMedia !== false) await verifyMedia(resourceUrl, resolved.headers, options.signal);
    return { manifestUrl: manifest.url, mediaUrl: resourceUrl };
  }
  throw new Error('视频清单嵌套层级异常');
}
