import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'huangguo-store-test-'));
const appDirectory = path.join(root, 'app');
const dataDirectory = path.join(root, 'data');
mkdirSync(path.join(appDirectory, 'playlists'), { recursive: true });
writeFileSync(path.join(appDirectory, 'settings.json'), JSON.stringify({ potPlayerPath: 'D:\\PotPlayerMini64.exe' }));
writeFileSync(path.join(appDirectory, 'playlists', 'huangguo-123.m3u'), '#EXTM3U\n');
process.env.HG_DATA_DIR = dataDirectory;

try {
  const { DataStore } = await import('../src/lib/data-store.js');
  const store = new DataStore(appDirectory);
  assert.equal(store.directory, dataDirectory);
  assert.equal(store.settings.potPlayerPath, 'D:\\PotPlayerMini64.exe');
  assert.equal(readFileSync(path.join(store.playlistDirectory, 'huangguo-123.m3u'), 'utf8'), '#EXTM3U\n');

  const detail = { id: '123', title: '测试短剧', image: 'https://example.com/poster.jpg', remark: '3 集' };
  let library = store.setFavorite(detail, true);
  assert.equal(library.favorites.length, 1);
  assert.equal(library.favorites[0].title, '测试短剧');

  const history = store.recordHistory(detail, { ep: '2', name: '第2集' });
  assert.equal(history.ep, '2');
  library = store.snapshot();
  assert.equal(library.history[0].episodeName, '第2集');

  library = store.setFavorite(detail, false);
  assert.equal(library.favorites.length, 0);
  library = store.clearHistory();
  assert.equal(library.history.length, 0);

  const reloaded = new DataStore(appDirectory);
  assert.equal(reloaded.snapshot().favorites.length, 0);
  assert.equal(reloaded.snapshot().history.length, 0);
  assert.ok(readFileSync(reloaded.libraryPath, 'utf8').includes('"version": 1'));

  console.log(JSON.stringify({ ok: true, migrationChecked: true, libraryPersistenceChecked: true }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.HG_DATA_DIR;
}
