// bot.js — Baileys socket lifecycle, AI reply lookup, and voice-note generation
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import * as googleTTS from 'google-tts-api';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { isCommand, handleCommand, getSettings } from './commands.js';

// ffmpeg-static only ships Linux/macOS/Windows binaries. On Termux (Android),
// skip it and let fluent-ffmpeg use the native `ffmpeg` installed via `pkg install ffmpeg`.
if (process.platform !== 'android' && ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const AI_API = 'https://api-rebix.vercel.app/api/gpt-5';
const sessions = new Map(); // phoneNumber -> active socket
const MAX_RECONNECT_ATTEMPTS = 8;
const reconnectAttempts = new Map(); // phoneNumber -> consecutive failed-reconnect count
const sessionStartedAt = new Map(); // phoneNumber -> Date.now() of first successful connect

// Get a short text reply from the AI API
async function getAIReply(text) {
  try {
    const { data } = await axios.get(AI_API, { params: { q: text }, timeout: 20000 });
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

// Compares a JID against the bot's own number, ignoring the "@server" suffix
// and any ":deviceId" part — used to detect @mentions and replies-to-bot in groups.
function isBotJid(sock, rawJid) {
  if (!rawJid || !sock.user?.id) return false;
  const bareNumber = (j) => j.split('@')[0].split(':')[0];
  return bareNumber(rawJid) === bareNumber(sock.user.id);
}

// Starts (or reconnects) the WhatsApp session for one phone number
export async function startWhatsAppSession(phoneNumber, { onPairingCode, onConnected }) {
  const sessionDir = path.join('sessions', phoneNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  // Always pin to WhatsApp Web's current version — pairing with a stale/hardcoded
  // version is a common cause of connections being silently rejected mid-handshake.
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('AI Assistant'),
    logger: pino({ level: 'silent' }),
  });

  sessions.set(phoneNumber, sock);
  sock.ev.on('creds.update', saveCreds);

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
      reconnectAttempts.set(phoneNumber, 0);
      if (!sessionStartedAt.has(phoneNumber)) sessionStartedAt.set(phoneNumber, Date.now());
      onConnected();
      await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
        text: 'Bot successfully connected and AI messages activated on this account ✅',
      });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        sessions.delete(phoneNumber);
        reconnectAttempts.delete(phoneNumber);
        return;
      }

      const attempts = (reconnectAttempts.get(phoneNumber) || 0) + 1;
      reconnectAttempts.set(phoneNumber, attempts);

      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        console.log(`${phoneNumber}: giving up after ${attempts - 1} reconnect attempts.`);
        sessions.delete(phoneNumber);
        return;
      }

      const delayMs = Math.min(30_000, 1000 * 2 ** (attempts - 1)); // 1s, 2s, 4s... capped at 30s
      console.log(`${phoneNumber}: connection closed, reconnecting in ${delayMs}ms (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(() => {
        startWhatsAppSession(phoneNumber, { onPairingCode: () => {}, onConnected: () => {} });
      }, delayMs);
    }
  });

  // Route every incoming message: commands (owner-only or public) vs. AI auto-reply
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message) return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text) return;

    const settings = getSettings(phoneNumber);

    // Commands: owner-only by default; anyone, in any chat (group or private),
    // when the owner has turned public mode on via `.public on`.
    if (isCommand(text)) {
      const allowed = msg.key.fromMe || settings.publicMode;
      if (!allowed) return; // silently ignore command attempts from non-owners in private mode
      const { reply } = handleCommand(text, { phoneNumber, startedAt: sessionStartedAt.get(phoneNumber) || Date.now() });
      await sock.sendMessage(jid, { text: reply });
      return;
    }

    if (msg.key.fromMe) return; // ignore the owner's own non-command chatter
    if (!settings.aiEnabled) return;

    // In groups, only speak up when @mentioned or replied to — never on every message
    if (isGroup) {
      const contextInfo = msg.message.extendedTextMessage?.contextInfo;
      const mentioned = (contextInfo?.mentionedJid || []).some((j) => isBotJid(sock, j));
      const repliedToBot = isBotJid(sock, contextInfo?.participant);
      if (!mentioned && !repliedToBot) return;
    }

    await sock.sendPresenceUpdate('composing', jid);

    const reply = await getAIReply(text);
    await sock.sendMessage(jid, { text: reply, ...(isGroup ? { quoted: msg } : {}) });

    // Voice notes only in private chats — text-only replies in groups
    if (settings.voiceReplies && !isGroup) {
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
