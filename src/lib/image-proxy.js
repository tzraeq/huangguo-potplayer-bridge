import { createDecipheriv } from 'node:crypto';
import { fetchWithRetry } from './retry.js';

const IMAGE_KEY = Buffer.from('f5d965df75336270', 'utf8');
const IMAGE_IV = Buffer.from('97b60394abc2fbe1', 'utf8');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ITEMS = 160;

function signature(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  return '';
}

function trimImage(buffer, type) {
  let output = buffer;
  const padding = output.at(-1);
  if (padding >= 1 && padding <= 16 && output.subarray(-padding).every((byte) => byte === padding)) {
    output = output.subarray(0, output.length - padding);
  }
  if (type === 'image/jpeg') {
    const end = output.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (end >= 0) output = output.subarray(0, end + 2);
  } else if (type === 'image/png') {
    const marker = Buffer.from('49454e44ae426082', 'hex');
    const end = output.lastIndexOf(marker);
    if (end >= 0) output = output.subarray(0, end + marker.length);
  }
  return output;
}

function decryptIfNeeded(raw) {
  const originalType = signature(raw);
  if (originalType) return { body: raw, type: originalType };
  if (!raw.length || raw.length % 16 !== 0) return { body: raw, type: '' };
  try {
    const decipher = createDecipheriv('aes-128-cbc', IMAGE_KEY, IMAGE_IV);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(raw), decipher.final()]);
    const type = signature(decrypted);
    if (!type) return { body: raw, type: '' };
    return { body: trimImage(decrypted, type), type };
  } catch {
    return { body: raw, type: '' };
  }
}

export class ImageProxy {
  constructor(siteHeaders) {
    this.siteHeaders = siteHeaders;
    this.allowedHosts = new Set();
    this.cache = new Map();
  }

  allow(urlValue) {
    if (!urlValue) return;
    try {
      const url = new URL(urlValue);
      if (url.protocol === 'https:') this.allowedHosts.add(url.hostname.toLowerCase());
    } catch {}
  }

  getCached(key) {
    const value = this.cache.get(key);
    if (!value) return null;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  setCached(key, value) {
    this.cache.set(key, value);
    if (this.cache.size > MAX_CACHE_ITEMS) this.cache.delete(this.cache.keys().next().value);
  }

  async fetchLimited(url) {
    return fetchWithRetry(
      url,
      {
        headers: { ...this.siteHeaders, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        redirect: 'follow',
      },
      {
        timeoutMs: 20_000,
        label: '读取图片',
        consume: async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const declared = Number(response.headers.get('content-length') || 0);
          if (declared > MAX_IMAGE_BYTES) throw new Error('图片文件过大');
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片文件过大');
          return { buffer, contentType: response.headers.get('content-type') || '' };
        },
      }
    );
  }

  async handle(urlValue) {
    let url;
    try {
      url = new URL(urlValue);
    } catch {
      return new Response('无效图片地址', { status: 400 });
    }
    if (url.protocol !== 'https:' || !this.allowedHosts.has(url.hostname.toLowerCase())) {
      return new Response('图片来源未授权', { status: 403 });
    }
    const key = url.href;
    const cached = this.getCached(key);
    if (cached) return new Response(cached.body, { headers: cached.headers });
    try {
      let fetched;
      try {
        fetched = await this.fetchLimited(url.href);
      } catch (firstError) {
        if (!url.search) throw firstError;
        url.search = '';
        fetched = await this.fetchLimited(url.href);
      }
      const processed = decryptIfNeeded(fetched.buffer);
      const upstreamType = /^image\//i.test(fetched.contentType) ? fetched.contentType.split(';')[0] : '';
      const headers = {
        'Content-Type': processed.type || upstreamType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      };
      this.setCached(key, { body: processed.body, headers });
      return new Response(processed.body, { headers });
    } catch (error) {
      return new Response(`图片读取失败：${error.message}`, { status: 502 });
    }
  }
}
