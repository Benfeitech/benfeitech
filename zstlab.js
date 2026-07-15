// zstlab.js — thin client for the external content API (wallpapers, YouTube
// search/download, book search, generated images, waifu images, link
// shortening). Every function here talks to one external provider.
//
// IMPORTANT: nothing in this file's exported errors or return values should
// ever mention the provider's name or domain — only generic messages, so a
// caller can safely forward failures to a chat without leaking the source.
import axios from 'axios';

const BASE_URL = 'https://zstlab.cyou/api/v1';

function apiKey() {
  const key = process.env.ZST_API_KEY;
  if (!key) throw new Error('Content API key is not configured');
  return key;
}

// Every endpoint here is a plain GET; some return JSON (with a media URL
// buried somewhere inside), others return the raw file directly. Fetching as
// a raw buffer first and branching on Content-Type handles both uniformly.
async function fetchRaw(endpoint, params) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, {
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    params,
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: () => true,
  });
  const contentType = res.headers['content-type'] || '';
  if (res.status >= 400) {
    const bodyText = contentType.includes('json') ? safeJsonMessage(res.data) : `status ${res.status}`;
    throw new Error(`Request failed (${bodyText})`);
  }
  return { buffer: Buffer.from(res.data), contentType };
}

function safeJsonMessage(buffer) {
  try {
    const parsed = JSON.parse(Buffer.from(buffer).toString('utf8'));
    return parsed?.message || parsed?.error || `status ${parsed?.statusCode || 'unknown'}`;
  } catch {
    return 'unknown error';
  }
}

async function fetchJson(endpoint, params) {
  const { buffer, contentType } = await fetchRaw(endpoint, params);
  if (!contentType.includes('json')) throw new Error('Unexpected response format');
  return JSON.parse(buffer.toString('utf8'));
}

// Hunts for the first plausible direct-file URL in an arbitrary JSON shape —
// each endpoint names this field a little differently.
function findMediaUrl(payload) {
  // Order matters: prefer an actual direct-file URL over a redirect/short
  // link that might live on the same object (e.g. wallpaper results carry
  // both a direct `url` and a `short_url` redirect page — we want the former).
  const urlKeys = ['url', 'imageUrl', 'directDownload', 'downloadUrl', 'download_url', 'videoUrl', 'audioUrl', 'image', 'video', 'audio', 'link', 'result'];
  const seen = new Set();
  function search(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const key of urlKeys) {
      if (typeof node[key] === 'string' && /^https?:\/\//.test(node[key])) return node[key];
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = typeof item === 'string' && /^https?:\/\//.test(item) ? item : search(item);
          if (found) return found;
        }
      } else if (value && typeof value === 'object') {
        const found = search(value);
        if (found) return found;
      }
    }
    return null;
  }
  return search(payload);
}

async function downloadUrl(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
  const mimetype = res.headers['content-type'] || 'application/octet-stream';
  // Some upstream CDN links (e.g. Google-signed video URLs) are bound to the
  // IP that originally requested them and reject anyone else with a
  // plain-text/HTML error even at HTTP 200 — never treat that as real media.
  if (res.status >= 400 || mimetype.startsWith('text/')) {
    throw new Error(`Media link did not return a file (status ${res.status}, ${mimetype})`);
  }
  return { buffer: Buffer.from(res.data), mimetype };
}

// Endpoints that hand back either raw media bytes directly, or JSON wrapping
// a media URL — resolve either shape down to a ready-to-send buffer.
async function fetchMedia(endpoint, params) {
  const { buffer, contentType } = await fetchRaw(endpoint, params);
  if (contentType.includes('json')) {
    const payload = JSON.parse(buffer.toString('utf8'));
    if (payload?.status === false) throw new Error(payload?.message || 'API reported failure');
    const url = findMediaUrl(payload);
    if (!url) throw new Error('No media found in response');
    return downloadUrl(url);
  }
  return { buffer, mimetype: contentType || 'application/octet-stream' };
}

export async function wallpaperSearch(query) {
  return fetchMedia('/wallpaper/search', { q: query, limit: 1 });
}

export async function youtubeSearch(query, limit = 5) {
  return fetchJson('/search/youtube', { q: query, limit });
}

export async function bookSearch(query, limit = 10) {
  return fetchJson('/search/book', { q: query, limit });
}

export async function youtubeDownload(url, quality = '720') {
  return fetchMedia('/youtube/download', { url, quality });
}

export async function ephotoGalaxyWallpaper(text) {
  return fetchMedia('/ephotos/galaxy-wallpaper', { text });
}

export async function ephotoNeonGlitch(text) {
  return fetchMedia('/ephotos/neon-glitch', { text });
}

export async function ephotoGlossySilver3D(text) {
  return fetchMedia('/ephotos/glossy-silver-3d', { text });
}

export async function waifuMany(type = 'waifu', count = 1) {
  return fetchMedia('/waifu/many', { type, count });
}

export async function waifuDownload(type = 'waifu') {
  return fetchMedia('/waifu/download', { type });
}

export async function shortenUrl(url) {
  const data = await fetchJson('/shortner/isgd', { url });
  const short = data?.shortUrl || data?.short_url || data?.result || findMediaUrl(data);
  if (!short) throw new Error('No short link in response');
  return short;
}
