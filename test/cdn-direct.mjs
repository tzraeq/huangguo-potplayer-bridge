import { resolveEpisode } from '../src/lib/scraper.js';
import { detectPotPlayer, launchPotPlayer } from '../src/lib/potplayer.js';

const resolved = await resolveEpisode(process.argv[2] || '3439', process.argv[3] || '1');
const playlistResponse = await fetch(resolved.source, { redirect: 'follow' });
const playlistText = await playlistResponse.text();
const lines = playlistText.split(/\r?\n/);
const keyValue = playlistText.match(/URI=["']([^"']+)/i)?.[1] || '';
const mediaValue = lines.find((line) => line && !line.startsWith('#')) || '';
const keyUrl = keyValue ? new URL(keyValue, playlistResponse.url).href : '';
const mediaUrl = mediaValue ? new URL(mediaValue, playlistResponse.url).href : '';
const keyResponse = keyUrl ? await fetch(keyUrl) : null;
const mediaResponse = mediaUrl ? await fetch(mediaUrl, { headers: { Range: 'bytes=0-2047' } }) : null;
const keyBytes = keyResponse ? (await keyResponse.arrayBuffer()).byteLength : 0;
const mediaBytes = mediaResponse ? (await mediaResponse.arrayBuffer()).byteLength : 0;

if (process.argv.includes('--launch')) {
  const player = detectPotPlayer();
  launchPotPlayer(player.path, resolved.source);
}

console.log(JSON.stringify({
  playlist: {
    status: playlistResponse.status,
    type: playlistResponse.headers.get('content-type'),
    hls: playlistText.startsWith('#EXTM3U'),
  },
  key: keyResponse ? {
    status: keyResponse.status,
    type: keyResponse.headers.get('content-type'),
    bytes: keyBytes,
  } : null,
  media: mediaResponse ? {
    status: mediaResponse.status,
    type: mediaResponse.headers.get('content-type'),
    bytes: mediaBytes,
  } : null,
  launched: process.argv.includes('--launch'),
}, null, 2));
