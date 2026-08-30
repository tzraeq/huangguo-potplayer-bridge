import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { launchPotPlayerPlaylist } from '../src/lib/potplayer.js';

const origin = process.env.HG_TEST_ORIGIN || 'http://127.0.0.1:17891';
const health = await (await fetch(`${origin}/api/health`)).json();
assert.equal(health.ok, true);
assert.equal(health.potPlayer.found, true);

const catalog = await (await fetch(`${origin}/api/catalog?tab=home&page=1`)).json();
assert.ok(catalog.list.length > 0);
const item = catalog.list[0];

const createdResponse = await fetch(`${origin}/api/playlist-jobs`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-HG-Token': health.sessionToken,
  },
  body: JSON.stringify({ id: item.id }),
});
assert.equal(createdResponse.status, 202);
const created = await createdResponse.json();

let job;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const response = await fetch(`${origin}/api/playlist-jobs/${created.job.id}`, {
    headers: { 'X-HG-Token': health.sessionToken },
  });
  assert.equal(response.status, 200);
  job = (await response.json()).job;
  if (['complete', 'failed', 'cancelled'].includes(job.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

assert.equal(job?.status, 'complete', job?.message || 'playlist job timed out');
assert.equal(existsSync(job.result.playlistPath), true);
const playlist = readFileSync(job.result.playlistPath, 'utf8');
const directUrls = playlist
  .replace(/^\ufeff/, '')
  .split(/\r?\n/)
  .filter((line) => /^https?:\/\//.test(line));
assert.equal(directUrls.length, job.succeeded);
assert.ok(directUrls.every((line) => !line.startsWith(origin)));
assert.ok(!playlist.includes('token='));
assert.ok(!playlist.includes('/vod/'));

if (process.argv.includes('--launch')) {
  launchPotPlayerPlaylist(health.potPlayer.path, job.result.playlistPath);
}

console.log(JSON.stringify({
  ok: true,
  itemId: item.id,
  episodes: directUrls.length,
  directPlaylistValidated: true,
  launched: process.argv.includes('--launch'),
}, null, 2));
