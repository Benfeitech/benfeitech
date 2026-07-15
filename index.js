// index.js — Telegram control panel: pairs WhatsApp numbers via /pair <number>
import TelegramBot from 'node-telegram-bot-api';
import { startWhatsAppSession, resumeExistingSessions } from './bot.js';

// Safety net: on a flaky (e.g. mobile) connection, log unexpected errors instead of crashing the whole bot
process.on('unhandledRejection', (err) => console.log('Unhandled rejection (ignored):', err?.message || err));
process.on('uncaughtException', (err) => console.log('Uncaught exception (ignored):', err?.message || err));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // set in Replit Secrets tab
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID; // your Telegram numeric user ID (optional but recommended)

if (!TELEGRAM_TOKEN) {
  throw new Error('Set TELEGRAM_BOT_TOKEN in Replit Secrets (padlock icon in the sidebar).');
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 10 }, // shorter long-poll window recovers faster on flaky mobile connections
  },
});

// Network hiccups (common on mobile data) are normal here — the library retries on its own.
bot.on('polling_error', (err) => {
  console.log('Polling hiccup (auto-retrying):', err.code || err.message);
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Send /pair <number with country code, no + or spaces>\ne.g. /pair 2348123456789'
  );
});

bot.onText(/\/pair (\d+)/, async (msg, match) => {
  if (ADMIN_ID && String(msg.from.id) !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, 'Not authorized to pair numbers on this bot.');
  }

  const number = match[1];
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `Starting pairing for +${number}...`);

  try {
    await startWhatsAppSession(number, {
      onPairingCode: (code) =>
        bot.sendMessage(
          chatId,
          `Pairing code: *${code}*\n\nOn that WhatsApp number: Settings → Linked Devices → Link a Device → Link with phone number instead → enter this code.`,
          { parse_mode: 'Markdown' }
        ),
      onConnected: () =>
        bot.sendMessage(chatId, `✅ +${number} connected — AI auto-replies are now active.`),
    });
  } catch (err) {
    bot.sendMessage(chatId, `Pairing failed: ${err.message}`);
  }
});

// Reconnect any already-linked number automatically — pairing is only
// needed for a brand-new number or after an explicit logout on the phone.
resumeExistingSessions().then((resumed) => {
  if (resumed.length) console.log(`Reconnected already-linked number(s): ${resumed.map((n) => `+${n}`).join(', ')}`);
});

console.log('Telegram control bot is running. Send /pair <number> to it to begin.');
