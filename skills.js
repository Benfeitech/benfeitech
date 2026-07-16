// skills.js — natural-language skill router. No slash-commands: everyday
// requests ("find me a wallpaper of...", "download this youtube video...")
// are matched here and answered with a real file; anything that doesn't
// match falls through to the general AI reply in bot.js.
//
// Meta-questions ("who made you", "what powers you", "your api" etc.) are
// intercepted here rather than forwarded to the AI, so the answer stays
// consistent and never leaks the actual underlying API/content providers —
// it just credits Benfei Tech and explains the bot's purpose instead.
import * as zst from './zstlab.js';
import { getPending, setPending, clearPending } from './memory.js';

const META_QUESTION = /\b(api|apis|source ?code|which (ai|model|llm)|what (ai|model|llm)|powered by|built (with|using)|who (made|built|created) you|your (creator|provider|backend|source))\b/i;

export function isMetaQuestion(text) {
  return META_QUESTION.test(text);
}

// Several variants so the bot doesn't repeat itself on every meta-question.
const DEV_RESPONSES = [
  "I was built by Benfei Tech to help automate WhatsApp replies for a client — still under development, so thanks for bearing with me! 🙂",
  "Benfei Tech built me to handle WhatsApp messages for a client automatically. Still a work in progress, so I'm improving over time.",
  "I'm a WhatsApp automation assistant made by Benfei Tech, built to help a client manage incoming messages. Still being actively developed!",
  "Made by Benfei Tech — my job is to automate WhatsApp replies for a client. Development is ongoing, so expect more improvements soon.",
  "Benfei Tech is the team behind me. I was created to help automate a client's WhatsApp account, and I'm still evolving as work continues.",
];

export function getMetaResponse() {
  return DEV_RESPONSES[Math.floor(Math.random() * DEV_RESPONSES.length)];
}

function extractQuoted(text) {
  const m = text.match(/["“']([^"”']+)["”']/);
  return m ? m[1] : null;
}

function extractAfter(text, keywords) {
  for (const kw of keywords) {
    const idx = text.indexOf(kw);
    if (idx !== -1) {
      const rest = text.slice(idx + kw.length).trim();
      if (rest) return rest;
    }
  }
  return null;
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
}

function extractNumber(text) {
  const m = text.match(/\b(\d{1,3})\b/);
  return m ? parseInt(m[1], 10) : null;
}

async function runMedia(fn, kind, filename) {
  try {
    const { buffer, mimetype } = await fn();
    return { media: { buffer, mimetype: mimetype || 'image/jpeg', filename, kind } };
  } catch (err) {
    console.error('Media skill failed:', err.message);
    return { reply: "Sorry, I couldn't get that for you right now." };
  }
}

async function downloadYoutubeVideo(url) {
  try {
    const { buffer, mimetype } = await zst.youtubeDownload(url);
    return { media: { buffer, mimetype: mimetype || 'video/mp4', filename: 'video.mp4', kind: 'video' } };
  } catch (err) {
    console.error('YouTube download failed:', err.message);
    return { reply: "Sorry, I couldn't download that video right now." };
  }
}

// Returns `{ reply }`, `{ media }`, or `null` (nothing matched — caller
// should fall back to the general AI reply).
export async function routeSkill(text, { phoneNumber, jid }) {
  const lower = text.toLowerCase();
  const pending = getPending(phoneNumber, jid);

  if (pending?.type === 'youtube-choice') {
    const choice = extractNumber(text);
    const picked = choice && pending.results[choice - 1];
    if (!picked) {
      return { reply: `Please reply with a number from 1 to ${pending.results.length} to pick a video, or just send something else to cancel.` };
    }
    clearPending(phoneNumber, jid);
    return downloadYoutubeVideo(picked.url || picked.link);
  }

  if (/galaxy wallpaper/.test(lower)) {
    const label = extractQuoted(text) || extractAfter(lower, ['saying', 'text']) || 'Wallpaper';
    return runMedia(() => zst.ephotoGalaxyWallpaper(label), 'image', 'galaxy-wallpaper.jpg');
  }

  if (/neon glitch/.test(lower)) {
    const label = extractQuoted(text) || extractAfter(lower, ['saying', 'text']) || 'Neon';
    return runMedia(() => zst.ephotoNeonGlitch(label), 'image', 'neon-glitch.jpg');
  }

  if (/(glossy silver|silver 3d)/.test(lower)) {
    const label = extractQuoted(text) || extractAfter(lower, ['saying', 'text']) || '3D';
    return runMedia(() => zst.ephotoGlossySilver3D(label), 'image', 'glossy-silver-3d.jpg');
  }

  if (/wallpaper/.test(lower)) {
    const query = extractAfter(lower, ['wallpaper of', 'wallpaper for', 'wallpaper']) || text;
    return runMedia(() => zst.wallpaperSearch(query.trim()), 'image', 'wallpaper.jpg');
  }

  if (/waifu/.test(lower)) {
    const type = (lower.match(/waifu\s+(hug|kiss|pat|slap|cry|smile|dance)/) || [])[1] || 'waifu';
    return runMedia(() => zst.waifuDownload(type), 'image', 'waifu.jpg');
  }

  if (/(shorten|short link)/.test(lower)) {
    const url = extractUrl(text);
    if (!url) return { reply: 'Send me the link you want shortened.' };
    try {
      const short = await zst.shortenUrl(url);
      return { reply: `Here's your short link: ${short}` };
    } catch (err) {
      console.error('Shortener failed:', err.message);
      return { reply: "Sorry, I couldn't shorten that link right now." };
    }
  }

  if (/book/.test(lower) && /(search|find|look for|recommend)/.test(lower)) {
    const query = extractAfter(lower, ['book called', 'book named', 'book']) || text;
    try {
      const data = await zst.bookSearch(query.trim());
      const items = (data?.data?.books || data?.books || data?.results || []).slice(0, 5);
      if (!items.length) return { reply: `Couldn't find any books for "${query.trim()}".` };
      const list = items
        .map((b, i) => {
          const author = Array.isArray(b.authors) ? b.authors.join(', ') : b.author;
          return `${i + 1}. *${b.title || b.name}*${author ? ` — ${author}` : ''}`;
        })
        .join('\n');
      return { reply: `Here's what I found:\n\n${list}` };
    } catch (err) {
      console.error('Book search failed:', err.message);
      return { reply: "Sorry, I couldn't search books right now." };
    }
  }

  const mentionsYoutube = /youtube\.com|youtu\.be/.test(lower) || /\byoutube\b/.test(lower);
  const explicitUrl = mentionsYoutube ? extractUrl(text) : null;

  if (explicitUrl && /download/.test(lower)) {
    return downloadYoutubeVideo(explicitUrl);
  }

  if (mentionsYoutube && /(search|find|look for)/.test(lower) && !explicitUrl) {
    const query = extractAfter(lower, ['youtube for', 'youtube video of', 'youtube', 'video of']) || text;
    try {
      const data = await zst.youtubeSearch(query.trim());
      const items = (data?.data?.videos || data?.videos || data?.results || []).slice(0, 5);
      if (!items.length) return { reply: `Couldn't find any videos for "${query.trim()}".` };
      const list = items.map((v, i) => `${i + 1}. ${v.title}${v.durationText ? ` (${v.durationText})` : ''}`).join('\n');
      setPending(phoneNumber, jid, { type: 'youtube-choice', results: items });
      return { reply: `Found these — reply with a number and I'll send you the video:\n\n${list}` };
    } catch (err) {
      console.error('YouTube search failed:', err.message);
      return { reply: "Sorry, I couldn't search YouTube right now." };
    }
  }

  return null;
}
