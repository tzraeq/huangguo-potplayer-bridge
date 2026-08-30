import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const tray = readFileSync(new URL('../src/lib/tray.js', import.meta.url), 'utf8');

const referencedIds = [...app.matchAll(/\$\('#([^']+)'\)/g)].map((match) => match[1]);
const missingIds = referencedIds.filter((id) => !new RegExp(`\\bid=["']${id}["']`).test(html));
assert.deepEqual(missingIds, [], `app.js references missing HTML ids: ${missingIds.join(', ')}`);

for (const id of [
  'favorite-button',
  'resume-button',
  'playlist-progress',
  'cancel-playlist',
  'diagnostics-dialog',
  'source-alert',
  'clear-history',
  'restart-button',
]) {
  assert.match(html, new RegExp(`\\bid=["']${id}["']`), id);
}

for (const feature of [
  '/api/playlist-jobs',
  '/api/favorites',
  '/api/history/clear',
  '/api/diagnostics',
  '/api/restart',
]) {
  assert.ok(app.includes(feature), `frontend should use ${feature}`);
  assert.ok(server.includes(feature.replace(/-/g, '\\-')) || server.includes(feature), `server should expose ${feature}`);
}

assert.ok(app.includes("{ name: '收藏', id: 'favorites' }"));
assert.ok(app.includes("{ name: '观看记录', id: 'history' }"));
assert.ok(css.includes('.playlist-progress'));
assert.ok(css.includes('.source-alert'));
assert.ok(css.includes('.diagnostics-dialog'));
assert.ok(tray.includes("$menu.Items.Add('打开点播台')"));
assert.ok(tray.includes("$menu.Items.Add('重启服务')"));
assert.ok(tray.includes("$menu.Items.Add('退出服务')"));
assert.ok(!tray.includes('detached: true'), 'tray helper must stay attached to the service process on Windows');
assert.ok(!server.includes("./lib/hls-proxy.js"));
assert.ok(!server.includes("/stream/([A-Za-z0-9_-]+)"));

const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
assert.equal(openBraces, closeBraces, 'CSS braces should be balanced');

console.log(JSON.stringify({
  ok: true,
  referencedElementCount: referencedIds.length,
  libraryUiChecked: true,
  playlistProgressUiChecked: true,
  diagnosticsUiChecked: true,
  trayMenuChecked: true,
}, null, 2));
