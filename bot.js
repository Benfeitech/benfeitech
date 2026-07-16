// bot.js — Baileys socket lifecycle, message routing (skills -> AI fallback),
// owner-only commands, and voice-note generation.
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import * as googleTTS from 'google-tts-api';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { getSettings, isCommand, handleCommand } from './commands.js';
import { getHistory, pushHistory, clearHistory } from './memory.js';
import { routeSkill, isMetaQuestion, getMetaResponse } from './skills.js';

// ffmpeg-static only ships Linux/macOS/Windows binaries. On Termux (Android),
// skip it and let fluent-ffmpeg use the native `ffmpeg` installed via `pkg install ffmpeg`.
if (process.platform !== 'android' && ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const AI_API = 'https://api-rebix.vercel.app/api/gpt-5';
const sessions = new Map(); // phoneNumber -> active socket
const sessionStartedAt = new Map(); // phoneNumber -> Date.now() of first successful connect

const MAX_RECONNECT_ATTEMPTS = 8;
const reconnectAttempts = new Map(); // phoneNumber -> consecutive failed-reconnect count

// Build a short conversation-style prompt (using durable per-chat history) so
// replies stay consistent with what was said earlier, instead of treating
// every message in isolation.
function buildPrompt(phoneNumber, jid, text) {
  const history = getHistory(phoneNumber, jid);
  if (history.length === 0) return text;
  const transcript = history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');
  return `${transcript}\nUser: ${text}\nAssistant:`;
}

// Get a short text reply from the AI API, with light conversation memory.
async function getAIReply(phoneNumber, jid, text) {
  try {
    const { data } = await axios.get(AI_API, { params: { q: buildPrompt(phoneNumber, jid, text) }, timeout: 20000 });
    return data?.results || "Sorry, I couldn't process that right now.";
  } catch (err) {
    console.error('AI API error:', err.message);
    return "Sorry, I'm having trouble replying right now.";
  }
}

// Convert reply text into an OGG/Opus buffer (WhatsApp's required voice-note format)
async function textToVoiceNote(text) {
  const parts = googleTTS.getAllAudioUrls(text.slice(0, 600), {
    lang: 'en',
    slow: false,
    host: 'https://translate.google.com',
    splitPunct: ',.?',
  });

  const buffers = [];
  for (const part of parts) {
    const res = await axios.get(part.url, { responseType: 'arraybuffer' });
    buffers.push(Buffer.from(res.data));
  }

  const mp3Path = path.join('/tmp', `${Date.now()}.mp3`);
  const oggPath = mp3Path.replace('.mp3', '.ogg');
  fs.writeFileSync(mp3Path, Buffer.concat(buffers));

  await new Promise((resolve, reject) => {
    ffmpeg(mp3Path)
      .audioCodec('libopus')
      .format('ogg')
      .on('end', resolve)
      .on('error', reject)
      .save(oggPath);
  });

  const oggBuffer = fs.readFileSync(oggPath);
  fs.unlinkSync(mp3Path);
  fs.unlinkSync(oggPath);
  return oggBuffer;
}

// Pulls a usable text out of any incoming message type. Baileys splits every
// message kind (plain text, replies, images, videos, documents...) into a
// different key under `message`, so a message isn't just `.conversation`.
function extractText(message) {
  if (!message) return { text: '', mediaType: null };
  if (message.conversation) return { text: message.conversation, mediaType: null };
  if (message.extendedTextMessage?.text) return { text: message.extendedTextMessage.text, mediaType: null };

  const mediaTypes = {
    imageMessage: 'image',
    videoMessage: 'video',
    documentMessage: 'file',
    audioMessage: 'audio',
    stickerMessage: 'sticker',
  };
  for (const [key, label] of Object.entries(mediaTypes)) {
    if (message[key]) {
      // Caption if the sender added one, otherwise fall back to a generic note
      // so the AI still gets *something* to respond to (the API here is
      // text-only — it can't see the actual image/video/file content).
      return { text: message[key].caption || `[received a${label === 'audio' ? 'n' : ''} ${label}]`, mediaType: label };
    }
  }
  return { text: '', mediaType: null };
}

// Sends a fetched media buffer back to a chat as the right WhatsApp message type.
async function sendMedia(sock, jid, media) {
  const { buffer, mimetype, filename, kind } = media;
  if (kind === 'video') return sock.sendMessage(jid, { video: buffer, mimetype: mimetype || 'video/mp4' });
  if (kind === 'audio') return sock.sendMessage(jid, { audio: buffer, mimetype: mimetype || 'audio/mpeg' });
  if (kind === 'image' || (mimetype || '').startsWith('image/')) return sock.sendMessage(jid, { image: buffer, mimetype: mimetype || 'image/jpeg' });
  return sock.sendMessage(jid, { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: filename || 'file' });
}

// Auto-reconnects every already-paired number found on disk. Call this once
// at process startup so a workflow/container restart resumes existing
// WhatsApp sessions silently instead of forcing the owner to pair again —
// pairing is only needed the first time (or after an explicit WhatsApp logout).
export async function resumeExistingSessions() {
  const baseDir = 'sessions';
  if (!fs.existsSync(baseDir)) return [];

  const numbers = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((number) => fs.existsSync(path.join(baseDir, number, 'creds.json')));

  for (const number of numbers) {
    console.log(`Resuming existing WhatsApp session for +${number}...`);
    startWhatsAppSession(number, {
      onPairingCode: () => console.log(`+${number}: unexpectedly asked to re-pair — its stored credentials may have been invalidated (e.g. logged out from the phone).`),
      onConnected: () => console.log(`+${number}: reconnected ✅`),
    }).catch((err) => console.error(`Failed to resume +${number}:`, err.message));
  }

  return numbers;
}

// Starts (or reconnects) the WhatsApp session for one phone number
export async function startWhatsAppSession(phoneNumber, { onPairingCode, onConnected }) {
  const sessionDir = path.join('sessions', phoneNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  // Always pin to WhatsApp Web's current version — pairing with a stale/hardcoded
  // version is the #1 cause of the generic "something went wrong, try again later"
  // error shown on the phone when linking a device.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
  });

  sessions.set(phoneNumber, sock);
  sock.ev.on('creds.update', saveCreds);

  // Only a brand-new device link needs the "connected" welcome text — a
  // reconnect (network blip, workflow restart, container restart) reuses the
  // stored credentials and should stay silent instead of re-announcing itself.
  const justPaired = !sock.authState.creds.registered;

  if (!sock.authState.creds.registered) {
    await new Promise((r) => setTimeout(r, 3000)); // let the socket fully open before using it — mobile networks need more time than Wi-Fi/server connections
    let code;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        code = await sock.requestPairingCode(phoneNumber);
        break;
      } catch (err) {
        console.log(`Pairing code attempt ${attempt}/4 failed: ${err.message}`);
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 3000 * attempt)); // back off before retrying
      }
    }
    onPairingCode(code);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      reconnectAttempts.set(phoneNumber, 0); // a clean connect resets the backoff counter
      if (!sessionStartedAt.has(phoneNumber)) sessionStartedAt.set(phoneNumber, Date.now());
      onConnected();
      if (justPaired) {
        await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
          text:
            'Bot successfully connected and AI messages activated on this account ✅\n\n' +
            'Send yourself *.menu* any time to see the owner-only commands.',
        });
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        sessions.delete(phoneNumber);
        sessionStartedAt.delete(phoneNumber);
        reconnectAttempts.delete(phoneNumber);
        return;
      }

      // Exponential backoff instead of reconnecting immediately/forever — an
      // unconditional instant retry loop is what turns a transient network
      // blip into a rapid-fire reconnect storm (and can look like WhatsApp
      // itself is rejecting the account).
      const attempts = (reconnectAttempts.get(phoneNumber) || 0) + 1;
      reconnectAttempts.set(phoneNumber, attempts);

      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        console.log(`${phoneNumber}: giving up after ${attempts - 1} reconnect attempts.`);
        sessions.delete(phoneNumber);
        return;
      }

      const delayMs = Math.min(30_000, 1000 * 2 ** (attempts - 1)); // 1s, 2s, 4s, ... capped at 30s
      console.log(`${phoneNumber}: connection closed, reconnecting in ${delayMs}ms (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(() => {
        startWhatsAppSession(phoneNumber, { onPairingCode: () => {}, onConnected: () => {} });
      }, delayMs);
    }
  });

  // Route every incoming message: owner-only commands vs. skills vs. AI auto-reply.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message) return;
    if (msg.key.remoteJid.endsWith('@g.us')) return; // skip group chats

    const jid = msg.key.remoteJid;
    const { text, mediaType } = extractText(msg.message);
    if (!text) return;

    // Owner control channel: only messages the linked account itself sent
    // (e.g. from a "Message yourself" chat) can issue commands.
    if (msg.key.fromMe) {
      if (!isCommand(text)) return; // ignore the bot's own non-command outgoing messages
      const { reply } = handleCommand(text, {
        phoneNumber,
        startedAt: sessionStartedAt.get(phoneNumber) || Date.now(),
        clearHistory: () => clearHistory(phoneNumber, jid),
      });
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    // Everyone else: AI auto-reply, gated by the owner's `.ai` setting.
    const settings = getSettings(phoneNumber);
    if (!settings.aiEnabled) return;

    await sock.sendPresenceUpdate('composing', jid);

    // Meta-questions about how the bot is built are deflected before anything
    // else touches them — never forwarded to a skill or the AI.
    if (isMetaQuestion(text)) {
  await sock.sendMessage(jid, { text: getMetaResponse() });
      return;
    }

    // Natural-language skills (wallpapers, YouTube, books, generated images,
    // link shortening, ...) get first shot; only unmatched messages fall
    // through to the general AI reply.
    const skillResult = await routeSkill(text, { phoneNumber, jid });
    if (skillResult) {
      if (skillResult.media) await sendMedia(sock, jid, skillResult.media);
      if (skillResult.reply) await sock.sendMessage(jid, { text: skillResult.reply });
      return;
    }

    const reply = await getAIReply(phoneNumber, jid, text);
    pushHistory(phoneNumber, jid, 'user', text);
    pushHistory(phoneNumber, jid, 'assistant', reply);

    await sock.sendMessage(jid, { text: reply });

    if (mediaType) {
      console.log(`${phoneNumber}: received a ${mediaType} from ${jid} — replied using its caption/text only (no vision support).`);
    }

    if (settings.voiceReplies) {
      try {
        const voiceNote = await textToVoiceNote(reply);
        await sock.sendMessage(jid, { audio: voiceNote, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      } catch (err) {
        console.error('Voice note generation failed:', err.message);
      }
    }
  });

  return sock;
}
