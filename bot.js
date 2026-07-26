// bot.js — Crimson MD: Baileys socket lifecycle + command routing.
// No automatic replies of any kind — everything happens through a command.
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { isCommand, handleCommand, getSettings } from './commands.js';

const sessions = new Map(); // phoneNumber -> active socket
const MAX_RECONNECT_ATTEMPTS = 8;
const reconnectAttempts = new Map(); // phoneNumber -> consecutive failed-reconnect count

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
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
  });

  sessions.set(phoneNumber, sock);
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    await new Promise((r) => setTimeout(r, 3000)); // let the socket fully open before using it
    let code;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        code = await sock.requestPairingCode(phoneNumber);
        break;
      } catch (err) {
        console.log(`Pairing code attempt ${attempt}/4 failed: ${err.message}`);
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    onPairingCode(code);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      reconnectAttempts.set(phoneNumber, 0);
      onConnected();
      await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
        text: 'Crimson MD connected ✅\n\nSend .menu to see what I can do.',
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

      const delayMs = Math.min(30_000, 1000 * 2 ** (attempts - 1));
      console.log(`${phoneNumber}: connection closed, reconnecting in ${delayMs}ms (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(() => {
        startWhatsAppSession(phoneNumber, { onPairingCode: () => {}, onConnected: () => {} });
      }, delayMs);
    }
  });

  // Everything happens through a command now — no auto-reply of any kind.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg?.message) return;

    const jid = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text || !isCommand(text)) return; // ignore anything that isn't a command

    const settings = getSettings(phoneNumber);
    const allowed = msg.key.fromMe || settings.publicMode;
    if (!allowed) return; // private mode: only the owner's own account can use commands

    const senderJid = msg.key.participant || msg.key.remoteJid; // actual sender in a group vs. private chat

    try {
      const result = await handleCommand(text, { sock, msg, jid, phoneNumber, senderJid });
      if (result?.reply) await sock.sendMessage(jid, { text: result.reply, mentions: result.mentions });
    } catch (err) {
      console.error('Command failed:', err.message);
      await sock.sendMessage(jid, { text: "Something went wrong running that command." });
    }
  });

  return sock;
}
