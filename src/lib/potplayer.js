import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function cleanPath(value) {
  return String(value || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/,\d+$/, '')
    .trim();
}

function validExecutable(value) {
  const candidate = cleanPath(value);
  return candidate && /PotPlayerMini(?:64)?\.exe$/i.test(candidate) && existsSync(candidate) ? candidate : '';
}

function queryRegistry(key, valueName = '') {
  try {
    const args = ['query', key];
    if (valueName) args.push('/v', valueName);
    else args.push('/ve');
    const output = execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const lines = output.split(/\r?\n/).filter((line) => /REG_(?:SZ|EXPAND_SZ)/.test(line));
    for (const line of lines) {
      const value = line.replace(/^.*?REG_(?:SZ|EXPAND_SZ)\s+/, '');
      const found = validExecutable(value);
      if (found) return found;
    }
  } catch {}
  return '';
}

export function detectPotPlayer(configuredPath = '') {
  const configured = validExecutable(configuredPath);
  if (configured) return { found: true, path: configured, source: 'settings' };

  const environment = validExecutable(process.env.POTPLAYER_PATH);
  if (environment) return { found: true, path: environment, source: 'environment' };

  const appPathKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini64.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini64.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini.exe',
  ];
  for (const key of appPathKeys) {
    const found = queryRegistry(key);
    if (found) return { found: true, path: found, source: 'registry' };
  }

  const uninstallKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer64',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PotPlayer',
  ];
  for (const key of uninstallKeys) {
    const found = queryRegistry(key, 'DisplayIcon');
    if (found) return { found: true, path: found, source: 'registry' };
  }

  const drives = ['C:', 'D:', 'E:'];
  const suffixes = [
    '\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    '\\Program Files\\PotPlayer\\PotPlayerMini64.exe',
    '\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
  ];
  for (const drive of drives) {
    for (const suffix of suffixes) {
      const found = validExecutable(`${drive}${suffix}`);
      if (found) return { found: true, path: found, source: 'common-path' };
    }
  }
  return { found: false, path: '', source: '' };
}

export function validatePotPlayerPath(value) {
  const candidate = validExecutable(value);
  if (!candidate) throw new Error('没有在该路径找到 PotPlayerMini64.exe 或 PotPlayerMini.exe');
  return path.resolve(candidate);
}

export function launchPotPlayer(executable, mediaUrl) {
  const pathValue = validExecutable(executable);
  if (!pathValue) throw new Error('尚未找到 PotPlayer，请先在设置中指定程序路径');
  const parsed = new URL(mediaUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('拒绝打开非 HTTP 媒体地址');
  const child = spawn(pathValue, [parsed.href], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

export function launchPotPlayerPlaylist(executable, playlistPath) {
  const pathValue = validExecutable(executable);
  if (!pathValue) throw new Error('尚未找到 PotPlayer，请先在设置中指定程序路径');
  const localPlaylist = path.resolve(String(playlistPath || ''));
  if (!/\.m3u8?$/i.test(localPlaylist) || !existsSync(localPlaylist)) {
    throw new Error('本地播放列表文件不存在');
  }
  const child = spawn(pathValue, [localPlaylist, '/ADD'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}
