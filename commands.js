// commands.js — Owner-only bot commands and per-number settings persistence.
//
// "Owner" = the WhatsApp account the bot is paired with. Baileys marks any
// message sent from that account (from any of its linked devices, including
// a "Message yourself" note-to-self chat) as `key.fromMe === true`. We use
// that as the command gate — nobody else can reach these commands.
import fs from 'fs';
import path from 'path';

const PREFIX = '.';

const DEFAULT_SETTINGS = {
  aiEnabled: true,
  voiceReplies: true,
};

const settingsCache = new Map(); // phoneNumber -> settings object

function settingsPath(phoneNumber) {
  return path.join('sessions', phoneNumber, 'settings.json');
}

export function getSettings(phoneNumber) {
  if (settingsCache.has(phoneNumber)) return settingsCache.get(phoneNumber);
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const file = settingsPath(phoneNumber);
    if (fs.existsSync(file)) {
      settings = { ...settings, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch (err) {
    console.log(`Settings file for ${phoneNumber} unreadable, using defaults:`, err.message);
  }
  settingsCache.set(phoneNumber, settings);
  return settings;
}

function saveSettings(phoneNumber, settings) {
  settingsCache.set(phoneNumber, settings);
  fs.mkdirSync(path.dirname(settingsPath(phoneNumber)), { recursive: true });
  fs.writeFileSync(settingsPath(phoneNumber), JSON.stringify(settings, null, 2));
}

export function isCommand(text) {
  return typeof text === 'string' && text.trim().startsWith(PREFIX) && text.trim().length > 1;
}

const MENU = `*Bot commands* _(only you can use these)_

${PREFIX}ping — check the bot is alive and see reply latency
${PREFIX}status — connection uptime & current settings
${PREFIX}ai on|off — turn AI auto-replies to others on/off
${PREFIX}voice on|off — turn voice-note replies on/off
${PREFIX}reset — clear this chat's AI conversation memory
${PREFIX}menu — show this list

_Everyone else (no command needed) can just ask in plain language for a wallpaper, a YouTube search/video, a book search, a styled text image, a waifu picture, or a shortened link._`;

// `clearHistory` and `startedAt` are injected by bot.js so this module stays
// stateless with respect to sockets/timers.
export function handleCommand(text, { phoneNumber, startedAt, clearHistory }) {
  const [cmdRaw, ...args] = text.trim().slice(PREFIX.length).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const settings = getSettings(phoneNumber);
  const onOff = (v) => (v === 'on' ? true : v === 'off' ? false : undefined);

  switch (cmd) {
    case 'ping':
      return { reply: `🏓 Pong — bot is connected and responding.` };

    case 'status': {
      const uptimeMin = Math.floor((Date.now() - startedAt) / 60000);
      return {
        reply:
          `*Bot status*\n` +
          `Connected: yes ✅\n` +
          `Uptime: ${uptimeMin}m\n` +
          `AI auto-replies: ${settings.aiEnabled ? 'on' : 'off'}\n` +
          `Voice notes: ${settings.voiceReplies ? 'on' : 'off'}`,
      };
    }

    case 'ai': {
      const v = onOff(args[0]);
      if (v === undefined) return { reply: `Usage: ${PREFIX}ai on|off` };
      settings.aiEnabled = v;
      saveSettings(phoneNumber, settings);
      return { reply: `AI auto-replies turned *${args[0]}*.` };
    }

    case 'voice': {
      const v = onOff(args[0]);
      if (v === undefined) return { reply: `Usage: ${PREFIX}voice on|off` };
      settings.voiceReplies = v;
      saveSettings(phoneNumber, settings);
      return { reply: `Voice-note replies turned *${args[0]}*.` };
    }

    case 'reset':
      clearHistory?.();
      return { reply: '🧹 Conversation memory cleared for this chat.' };

    case 'menu':
    case 'help':
      return { reply: MENU };

    default:
      return { reply: `Unknown command \`${PREFIX}${cmd}\`. Send ${PREFIX}menu to see what's available.` };
  }
}
