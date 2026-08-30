import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const origin = process.env.HG_TEST_ORIGIN || 'http://127.0.0.1:17891';
let sessionToken = '';

async function json(url, options = {}, authenticated = true) {
  const headers = new Headers(options.headers || {});
  if (authenticated && sessionToken) headers.set('X-HG-Token', sessionToken);
  const response = await fetch(url, { ...options, headers });
  const body = await response.json();
  assert.equal(response.ok, true, `${url}: ${response.status} ${body.error || ''}`);
  assert.equal(body.ok, true, `${url}: ${body.error || ''}`);
  return body;
}

async function waitForJob(jobId, terminal = ['complete', 'failed', 'cancelled']) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await json(`${origin}/api/playlist-jobs/${jobId}`);
    if (terminal.includes(result.job.status)) return result.job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`playlist job timed out: ${jobId}`);
}

const health = await json(`${origin}/api/health`, {}, false);
sessionToken = health.sessionToken;
assert.equal(health.appId, 'huangguo-potplayer-bridge');
assert.equal(health.version, '1.1.0');
assert.match(sessionToken, /^[A-Za-z0-9_-]{20,}$/);
assert.ok(health.dataDirectory);
assert.equal(typeof health.trayRunning, 'boolean');
assert.deepEqual(health.retry, {
  maxRetries: 3,
  backoffMs: [350, 800, 1600],
  playlistConcurrency: 2,
});
assert.equal(health.potPlayer.found, true, 'PotPlayer should be detected from the registry');
assert.match(health.potPlayer.path, /PotPlayerMini64\.exe$/i);

for (const route of ['/', '/assets/styles.css', '/assets/app.js']) {
  const response = await fetch(`${origin}${route}`);
  assert.equal(response.status, 200, route);
  if (route === '/') {
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy') || '', /form-action 'self'/);
  }
  assert.ok(Number(response.headers.get('content-length') || 1) > 0 || (await response.text()).length > 0, route);
}

const catalog = await json(`${origin}/api/catalog?tab=home&page=1`);
assert.ok(catalog.list.length > 0, 'catalog should contain cards');
assert.equal(catalog.sourceStatus.state, 'ok');
const item = catalog.list[0];
assert.match(item.id, /^\d+$/);
assert.ok(item.title);

const category = await json(`${origin}/api/catalog?tab=ai-duanju&page=1`);
assert.ok(category.list.length > 0, 'category should contain cards');
assert.equal(typeof category.hasMore, 'boolean');

const beyondLastPage = await json(`${origin}/api/catalog?tab=ai-duanju&page=100`);
assert.deepEqual(beyondLastPage.list, [], 'a page beyond the end should return an empty list');
assert.equal(beyondLastPage.hasMore, false, 'a page beyond the end should not expose another page');

const search = await json(`${origin}/api/search?q=${encodeURIComponent('人妻')}&page=1`);
assert.ok(search.list.length > 0, 'search should contain cards');
assert.equal(search.page, 1);
assert.equal(typeof search.hasMore, 'boolean');
const searchBeyond = await json(`${origin}/api/search?q=${encodeURIComponent('人妻')}&page=100`);
assert.deepEqual(searchBeyond.list, []);
assert.equal(searchBeyond.hasMore, false);

if (item.image) {
  const image = await fetch(`${origin}/api/image?url=${encodeURIComponent(item.image)}`);
  assert.equal(image.status, 200, `image: ${image.status}`);
  assert.match(image.headers.get('content-type') || '', /^image\//);
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert.ok(bytes.length > 32);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF';
  const isGif = String.fromCharCode(...bytes.slice(0, 3)) === 'GIF';
  assert.ok(isJpeg || isPng || isWebp || isGif, 'proxied image should have a valid image signature');
}

const blockedImage = await fetch(`${origin}/api/image?url=${encodeURIComponent('https://example.com/a.jpg')}`);
assert.equal(blockedImage.status, 403, 'unlisted image hosts must be blocked');

const detailResult = await json(`${origin}/api/detail/${item.id}`);
const detail = detailResult.detail;
assert.ok(detail.episodes.length > 0, 'detail should contain episodes');

const play = await json(`${origin}/api/play`, {
  method: 'POST',
  body: JSON.stringify({ id: item.id, ep: detail.episodes[0].ep, launch: false }),
});
assert.equal(play.launched, false);
assert.equal(play.history, null);
assert.match(play.streamUrl, /^https:\/\//);
assert.ok(!play.streamUrl.startsWith(origin));

const hlsResponse = await fetch(play.streamUrl);
assert.equal(hlsResponse.status, 200);
const hls = await hlsResponse.text();
assert.ok(hls.startsWith('#EXTM3U'));
const mediaLine = hls.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
assert.ok(mediaLine, 'HLS playlist should contain a media resource');

const jobCreated = await json(`${origin}/api/playlist-jobs`, {
  method: 'POST',
  body: JSON.stringify({ id: item.id }),
});
assert.ok(['queued', 'running'].includes(jobCreated.job.status));
const completedJob = await waitForJob(jobCreated.job.id);
assert.equal(completedJob.status, 'complete', completedJob.message);
assert.equal(completedJob.total, detail.episodes.length);
assert.equal(completedJob.completed, detail.episodes.length);
assert.ok(completedJob.succeeded > 0);
assert.equal(existsSync(completedJob.result.playlistPath), true);
const localPlaylist = readFileSync(completedJob.result.playlistPath, 'utf8');
assert.ok(localPlaylist.startsWith('\ufeff#EXTM3U'));
const directPlaylistUrls = localPlaylist
  .replace(/^\ufeff/, '')
  .split(/\r?\n/)
  .filter((line) => /^https?:\/\//.test(line));
assert.equal(directPlaylistUrls.length, completedJob.succeeded);
assert.ok(directPlaylistUrls.every((line) => !line.startsWith(origin)));
assert.ok(!localPlaylist.includes('token='));
assert.ok(!localPlaylist.includes('/vod/'));
assert.ok(!localPlaylist.includes('/stream/'));

const playlistUrl = `${origin}/api/playlist/${item.id}.m3u?token=${encodeURIComponent(sessionToken)}`;
const unauthorizedPlaylist = await fetch(`${origin}/api/playlist/${item.id}.m3u`);
assert.equal(unauthorizedPlaylist.status, 403, 'generated playlist download should require a session token');
const playlistHead = await fetch(playlistUrl, { method: 'HEAD' });
assert.equal(playlistHead.status, 200);
assert.ok(Number(playlistHead.headers.get('content-length')) > 0);
const playlistResponse = await fetch(playlistUrl);
assert.equal(playlistResponse.status, 200);
assert.equal(Number(playlistResponse.headers.get('content-length')), Buffer.byteLength(localPlaylist, 'utf8'));
assert.equal(await playlistResponse.text(), localPlaylist.replace(/^\ufeff/, ''));

const openedJob = await json(`${origin}/api/playlist-jobs/${completedJob.id}/open`, {
  method: 'POST',
  body: JSON.stringify({ launch: false }),
});
assert.equal(openedJob.launched, false);
assert.equal(openedJob.includedEpisodes, completedJob.succeeded);

const cancelCreated = await json(`${origin}/api/playlist-jobs`, {
  method: 'POST',
  body: JSON.stringify({ id: item.id }),
});
await json(`${origin}/api/playlist-jobs/${cancelCreated.job.id}/cancel`, {
  method: 'POST',
  body: '{}',
});
const cancelledJob = await waitForJob(cancelCreated.job.id);
assert.equal(cancelledJob.status, 'cancelled');

const favoriteOn = await json(`${origin}/api/favorites`, {
  method: 'POST',
  body: JSON.stringify({ id: item.id, favorite: true }),
});
assert.ok(favoriteOn.favorites.some((entry) => entry.id === item.id));
const library = await json(`${origin}/api/library`);
assert.ok(library.favorites.some((entry) => entry.id === item.id));
const favoriteOff = await json(`${origin}/api/favorites`, {
  method: 'POST',
  body: JSON.stringify({ id: item.id, favorite: false }),
});
assert.ok(!favoriteOff.favorites.some((entry) => entry.id === item.id));

const diagnostics = await json(`${origin}/api/diagnostics`);
assert.equal(diagnostics.diagnostics.app.version, '1.1.0');
assert.equal(diagnostics.diagnostics.source.state, 'ok');
assert.ok(Array.isArray(diagnostics.diagnostics.events));
assert.ok(!JSON.stringify(diagnostics.diagnostics).includes(sessionToken));

const unauthorizedPost = await fetch(`${origin}/api/play`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
assert.equal(unauthorizedPost.status, 403, 'mutations without a session token must be blocked');

const crossOrigin = await fetch(`${origin}/api/play`, {
  method: 'POST',
  headers: {
    Origin: 'https://example.com',
    'X-HG-Token': sessionToken,
    'Content-Type': 'application/json',
  },
  body: '{}',
});
assert.equal(crossOrigin.status, 403, 'cross-origin mutations must be blocked even with a token');

const originUrl = new URL(origin);
const rawHostResponse = await new Promise((resolve, reject) => {
  const socket = createConnection({ host: originUrl.hostname, port: Number(originUrl.port) });
  let response = '';
  socket.setEncoding('utf8');
  socket.once('error', reject);
  socket.on('data', (chunk) => { response += chunk; });
  socket.on('end', () => resolve(response));
  socket.once('connect', () => {
    socket.end('GET /api/health HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: close\r\n\r\n');
  });
});
assert.match(rawHostResponse, /^HTTP\/1\.1 421 /, 'untrusted Host headers must be rejected');

const removedLegacyProxy = await fetch(`${origin}/stream/not-a-session/root/index.m3u8`);
assert.equal(removedLegacyProxy.status, 404, 'unused legacy HLS proxy route should be removed');
const removedDynamicVod = await fetch(`${origin}/vod/${item.id}/${detail.episodes[0].ep}/index.m3u8?token=${encodeURIComponent(sessionToken)}`);
assert.equal(removedDynamicVod.status, 404, 'unreliable local dynamic VOD route should be removed');

console.log(JSON.stringify({
  ok: true,
  potPlayer: health.potPlayer.path,
  cards: catalog.list.length,
  episodes: detail.episodes.length,
  imageChecked: Boolean(item.image),
  playbackPreflightChecked: true,
  directPlaylistChecked: true,
  playlistProgressAndCancelChecked: true,
  paginationAndSearchChecked: true,
  libraryChecked: true,
  diagnosticsChecked: true,
  securityChecked: true,
}, null, 2));
