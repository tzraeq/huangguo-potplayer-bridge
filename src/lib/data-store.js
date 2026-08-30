import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MAX_FAVORITES = 300;
const MAX_HISTORY = 120;
const PLAYLIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporary, filePath);
  } catch {
    copyFileSync(temporary, filePath);
    unlinkSync(temporary);
  }
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, maxLength);
}

function cleanItem(value) {
  const id = cleanText(value?.id, 32);
  if (!/^\d+$/.test(id)) throw new Error('无效的条目编号');
  return {
    id,
    title: cleanText(value?.title, 180) || `条目 ${id}`,
    image: /^https:\/\//i.test(String(value?.image || '')) ? String(value.image).slice(0, 2_000) : '',
    remark: cleanText(value?.remark, 180),
  };
}

export class DataStore {
  constructor(appDirectory) {
    const fallbackBase = path.join(appDirectory, 'data');
    const base = process.env.HG_DATA_DIR || process.env.LOCALAPPDATA || fallbackBase;
    this.directory = process.env.HG_DATA_DIR
      ? path.resolve(process.env.HG_DATA_DIR)
      : path.join(path.resolve(base), 'HuangguoPotPlayer');
    this.playlistDirectory = path.join(this.directory, 'playlists');
    this.settingsPath = path.join(this.directory, 'settings.json');
    this.libraryPath = path.join(this.directory, 'library.json');
    mkdirSync(this.playlistDirectory, { recursive: true });
    this.migrateLegacy(appDirectory);
    this.cleanupPlaylists();
    this.settings = this.loadSettings();
    this.library = this.loadLibrary();
  }

  migrateLegacy(appDirectory) {
    const legacySettings = path.join(appDirectory, 'settings.json');
    if (!existsSync(this.settingsPath) && existsSync(legacySettings)) {
      try { copyFileSync(legacySettings, this.settingsPath); } catch {}
    }

    const legacyPlaylists = path.join(appDirectory, 'playlists');
    if (!existsSync(legacyPlaylists) || path.resolve(legacyPlaylists) === path.resolve(this.playlistDirectory)) return;
    try {
      for (const name of readdirSync(legacyPlaylists)) {
        if (!/^huangguo-\d+\.m3u$/i.test(name)) continue;
        const destination = path.join(this.playlistDirectory, name);
        if (!existsSync(destination)) copyFileSync(path.join(legacyPlaylists, name), destination);
      }
    } catch {}
  }

  cleanupPlaylists(now = Date.now()) {
    let removed = 0;
    try {
      for (const name of readdirSync(this.playlistDirectory)) {
        if (!/^huangguo-\d+\.m3u$/i.test(name)) continue;
        const filePath = path.join(this.playlistDirectory, name);
        if (now - statSync(filePath).mtimeMs <= PLAYLIST_MAX_AGE_MS) continue;
        unlinkSync(filePath);
        removed += 1;
      }
    } catch {}
    return removed;
  }

  loadSettings() {
    const parsed = readJson(this.settingsPath, {});
    return { potPlayerPath: cleanText(parsed?.potPlayerPath, 1_000) };
  }

  saveSettings(potPlayerPath) {
    this.settings = { potPlayerPath: cleanText(potPlayerPath, 1_000) };
    writeJsonAtomic(this.settingsPath, this.settings);
    return this.settings;
  }

  loadLibrary() {
    const parsed = readJson(this.libraryPath, {});
    const favorites = Array.isArray(parsed?.favorites) ? parsed.favorites : [];
    const history = Array.isArray(parsed?.history) ? parsed.history : [];
    return {
      version: 1,
      favorites: favorites.filter((item) => /^\d+$/.test(String(item?.id || ''))).slice(0, MAX_FAVORITES),
      history: history.filter((item) => /^\d+$/.test(String(item?.id || ''))).slice(0, MAX_HISTORY),
    };
  }

  saveLibrary() {
    writeJsonAtomic(this.libraryPath, this.library);
  }

  snapshot() {
    return {
      favorites: this.library.favorites.map((item) => ({ ...item })),
      history: this.library.history.map((item) => ({ ...item })),
    };
  }

  setFavorite(detail, favorite) {
    const item = cleanItem(detail);
    this.library.favorites = this.library.favorites.filter((entry) => entry.id !== item.id);
    if (favorite) {
      this.library.favorites.unshift({ ...item, savedAt: new Date().toISOString() });
      this.library.favorites = this.library.favorites.slice(0, MAX_FAVORITES);
    }
    this.saveLibrary();
    return this.snapshot();
  }

  recordHistory(detail, episode) {
    const item = cleanItem(detail);
    const entry = {
      ...item,
      ep: cleanText(episode?.ep, 40),
      episodeName: cleanText(episode?.name, 100),
      lastPlayedAt: new Date().toISOString(),
    };
    this.library.history = [entry, ...this.library.history.filter((old) => old.id !== item.id)].slice(0, MAX_HISTORY);
    this.saveLibrary();
    return entry;
  }

  clearHistory() {
    this.library.history = [];
    this.saveLibrary();
    return this.snapshot();
  }

  playlistPath(id) {
    const value = String(id || '');
    if (!/^\d+$/.test(value)) throw new Error('无效的条目编号');
    return path.join(this.playlistDirectory, `huangguo-${value}.m3u`);
  }
}
