// commands.js — Crimson MD: everything the bot can do lives here as a command.
// No automatic AI replies anymore — .ai and .tts are explicit, on-demand commands.
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { evaluate } from 'mathjs';
import QRCode from 'qrcode';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import * as googleTTS from 'google-tts-api';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

if (process.platform !== 'android' && ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath); // Termux: `pkg install ffmpeg` instead
}

const PREFIX = '!';
const BOT_NAME = 'Crimson MD';
const BOT_VERSION = '1.3.2';
const BOT_OWNER = 'Benfei Tech';

const AI_API = 'https://api-rebix.vercel.app/api/gpt-5';

const STYLE_INSTRUCTION =
  'Reply like a real person casually texting, not like an AI assistant. ' +
  'Keep it as short as possible, ideally one sentence. ' +
  'Do not use dashes, asterisks, hashtags, bullet points, or any markdown formatting. ' +
  'Do not bold, italicize, or highlight any words. Plain casual text only.';

function humanize(text) {
  return text
    .replace(/[—–]/g, ',')
    .replace(/\*\*?/g, '')
    .replace(/#+\s?/g, '')
    .replace(/_/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function getAIReply(text) {
  try {
    const prompt = `${STYLE_INSTRUCTION}\n\nMessage: ${text}`;
    const { data } = await axios.get(AI_API, { params: { q: prompt }, timeout: 20000 });
    return data?.results ? humanize(data.results) : "Sorry, I couldn't process that right now.";
  } catch (err) {
    console.error('AI API error:', err.message);
    return "Sorry, I'm having trouble replying right now.";
  }
}

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
    ffmpeg(mp3Path).audioCodec('libopus').format('ogg').on('end', resolve).on('error', reject).save(oggPath);
  });
  const oggBuffer = fs.readFileSync(oggPath);
  fs.unlinkSync(mp3Path);
  fs.unlinkSync(oggPath);
  return oggBuffer;
}

async function webpToJpgBuffer(webpBuffer) {
  const inPath = path.join('/tmp', `${Date.now()}-in.webp`);
  const outPath = path.join('/tmp', `${Date.now()}-out.jpg`);
  fs.writeFileSync(inPath, webpBuffer);
  await new Promise((resolve, reject) => {
    ffmpeg(inPath).outputOptions(['-frames:v', '1']).save(outPath).on('end', resolve).on('error', reject);
  });
  const outBuffer = fs.readFileSync(outPath);
  fs.unlinkSync(inPath);
  fs.unlinkSync(outPath);
  return outBuffer;
}

// ---- per-number settings ----
const DEFAULT_SETTINGS = { publicMode: true }; // public by default, per current design

const settingsCache = new Map();
function settingsPath(phoneNumber) {
  return path.join('sessions', phoneNumber, 'settings.json');
}
export function getSettings(phoneNumber) {
  if (settingsCache.has(phoneNumber)) return settingsCache.get(phoneNumber);
  let settings = { ...DEFAULT_SETTINGS };
  try {
    const file = settingsPath(phoneNumber);
    if (fs.existsSync(file)) settings = { ...settings, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    console.log(`Settings unreadable for ${phoneNumber}, using defaults:`, err.message);
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

// ---- message/context helpers ----
function getQuotedKey(msg, sock) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.stanzaId) return null;
  const bareNumber = (j) => j?.split('@')[0]?.split(':')[0];
  const isFromMe = sock?.user?.id ? bareNumber(contextInfo.participant) === bareNumber(sock.user.id) : false;
  return { remoteJid: msg.key.remoteJid, id: contextInfo.stanzaId, participant: contextInfo.participant, fromMe: isFromMe };
}
function getQuotedMessageContent(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}
function getMentionedJids(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}
async function isSenderGroupAdmin(sock, jid, senderJid) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const bare = (j) => j?.split('@')[0]?.split(':')[0];
    const participant = metadata.participants.find((p) => bare(p.id) === bare(senderJid));
    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch {
    return false;
  }
}
async function requireGroupAdmin(sock, jid, senderJid) {
  if (!jid.endsWith('@g.us')) return 'This only works in group chats.';
  const ok = await isSenderGroupAdmin(sock, jid, senderJid);
  if (!ok) return 'Only group admins can use this command.';
  return null;
}

const EIGHT_BALL = ['Yes.', 'No.', 'Definitely.', 'Ask again later.', 'Very doubtful.', 'Without a doubt.', 'Maybe.', 'Absolutely not.', 'Signs point to yes.'];
const COMPLIMENTS = ['has great taste.', 'lights up the room.', 'is sharper than they realize.', 'makes everything more fun.', 'is a great listener.', 'has main character energy today.'];

function buildMenu({ pushName, publicMode }) {
  const timeStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return `╭━━〔 🤖 ʙᴏᴛ ɪɴғᴏ 〕━━┈⊷
┃✫✧│ ɴᴀᴍᴇ: ${BOT_NAME}
┃✫✧│ ᴏᴡɴᴇʀ: ${BOT_OWNER}
┃✫✧│ ᴠᴇʀsɪᴏɴ: ${BOT_VERSION}
┃✫✧│ ᴜsᴇʀ: ${pushName || 'Unknown'}
┃✫✧│ ᴍᴏᴅᴇ: ${publicMode ? 'Public' : 'Private'}
┃✫✧│ ᴛɪᴍᴇ: ${timeStr}
╰━━━━━━━━━━━━━━━┈⊷

👋 ʜɪ ${pushName || 'UNKNOWN'}!

╭━━〔 👑 ᴏᴡɴᴇʀ ᴄᴏᴍᴍᴀɴᴅs 〕━━┈⊷
┃✫✧│ ${PREFIX}tagall - ᴍᴇɴᴛɪᴏɴ ᴇᴠᴇʀʏᴏɴᴇ ɪɴ ᴛʜᴇ ɢʀᴏᴜᴘ
┃✫✧│ ${PREFIX}react <emoji> - ʀᴇᴀᴄᴛ ᴛᴏ ᴀ ʀᴇᴘʟɪᴇᴅ ᴍᴇssᴀɢᴇ
┃✫✧│ ${PREFIX}public on|off - ᴛᴏɢɢʟᴇ ᴘᴜʙʟɪᴄ/ᴘʀɪᴠᴀᴛᴇ ᴍᴏᴅᴇ
┃✫✧│ ${PREFIX}groupinfo - sʜᴏᴡ ɢʀᴏᴜᴘ ɴᴀᴍᴇ, ᴅᴇsᴄʀɪᴘᴛɪᴏɴ, ᴍᴇᴍʙᴇʀ ᴄᴏᴜɴᴛ
┃✫✧│ ${PREFIX}invitelink - ɢᴇᴛ ᴛʜᴇ ɢʀᴏᴜᴘ'ꜱ ɪɴᴠɪᴛᴇ ʟɪɴᴋ
┃✫✧│ ${PREFIX}kick @user - ʀᴇᴍᴏᴠᴇ ᴀ ɢʀᴏᴜᴘ ᴍᴇᴍʙᴇʀ (ᴀᴅᴍɪɴ ᴏɴʟʏ)
┃✫✧│ ${PREFIX}promote @user - ᴍᴀᴋᴇ sᴏᴍᴇᴏɴᴇ ᴀ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ (ᴀᴅᴍɪɴ ᴏɴʟʏ)
┃✫✧│ ${PREFIX}demote @user - ʀᴇᴍᴏᴠᴇ sᴏᴍᴇᴏɴᴇ'ꜱ ᴀᴅᴍɪɴ sᴛᴀᴛᴜs (ᴀᴅᴍɪɴ ᴏɴʟʏ)
╰━━━━━━━━━━━━━━━┈⊷

╭━━〔 🎮 ғᴜɴ ᴄᴏᴍᴍᴀɴᴅs 〕━━┈⊷
┃✫✧│ ${PREFIX}ai <question> - ᴀsᴋ ᴛʜᴇ ᴀɪ
┃✫✧│ ${PREFIX}tts <text> - ᴄᴏɴᴠᴇʀᴛ ᴛᴇxᴛ ᴛᴏ ᴀ ᴠᴏɪᴄᴇ ɴᴏᴛᴇ
┃✫✧│ ${PREFIX}8ball <question>
┃✫✧│ ${PREFIX}roll
┃✫✧│ ${PREFIX}flip
┃✫✧│ ${PREFIX}joke
┃✫✧│ ${PREFIX}fact
┃✫✧│ ${PREFIX}quote
┃✫✧│ ${PREFIX}ship @user1 @user2
┃✫✧│ ${PREFIX}rate <anything>
┃✫✧│ ${PREFIX}compliment @user
┃✫✧│ ${PREFIX}calc <expression>
┃✫✧│ ${PREFIX}qr <text or link>
┃✫✧│ ${PREFIX}time
┃✫✧│ ${PREFIX}pp @user
┃✫✧│ ${PREFIX}poll Question | Option 1 | Option 2
┃✫✧│ ${PREFIX}location <lat> <long>
┃✫✧│ ${PREFIX}vcf
┃✫✧│ ${PREFIX}sticker (reply to an image/video)
┃✫✧│ ${PREFIX}toimg (reply to a sticker)
┃✫✧│ ${PREFIX}forward <number> (reply to a message)
┃✫✧│ ${PREFIX}pin / ${PREFIX}unpin (reply to a message)
┃✫✧│ ${PREFIX}edit <new text> (reply to the bot's own message)
╰━━━━━━━━━━━━━━━┈⊷`;
}

export async function handleCommand(text, { sock, msg, jid, phoneNumber, senderJid }) {
  const [cmdRaw, ...args] = text.trim().slice(PREFIX.length).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const settings = getSettings(phoneNumber);

  switch (cmd) {
    case 'menu':
    case 'help':
      return { reply: buildMenu({ pushName: msg.pushName, publicMode: settings.publicMode }) };

    case 'ai': {
      const query = args.join(' ');
      if (!query) return { reply: `Usage: ${PREFIX}ai <your question>` };
      return { reply: await getAIReply(query) };
    }

    case 'tts': {
      const ttsText = args.join(' ');
      if (!ttsText) return { reply: `Usage: ${PREFIX}tts <text to convert>` };
      try {
        const voiceNote = await textToVoiceNote(ttsText);
        await sock.sendMessage(jid, { audio: voiceNote, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      } catch (err) {
        console.error('.tts failed:', err.message);
        return { reply: "Couldn't generate that voice note, sorry." };
      }
      return { handled: true };
    }

    case 'tagall': {
      if (!jid.endsWith('@g.us')) return { reply: 'This only works in group chats.' };
      try {
        const metadata = await sock.groupMetadata(jid);
        const mentions = metadata.participants.map((p) => p.id);
        const list = mentions.map((m) => `@${m.split('@')[0]}`).join(' ');
        await sock.sendMessage(jid, { text: `📢 ${list}`, mentions });
      } catch (err) {
        console.error('tagall failed:', err.message);
        return { reply: "Couldn't fetch group members." };
      }
      return { handled: true };
    }

    case 'react': {
      const quoted = getQuotedKey(msg, sock);
      if (!quoted) return { reply: `Reply to a message with ${PREFIX}react <emoji> to react to it.` };
      await sock.sendMessage(jid, { react: { text: args[0] || '👍', key: quoted } });
      return { handled: true };
    }

    case 'public': {
      const v = args[0] === 'on' ? true : args[0] === 'off' ? false : undefined;
      if (v === undefined) return { reply: `Usage: ${PREFIX}public on|off` };
      settings.publicMode = v;
      saveSettings(phoneNumber, settings);
      return { reply: `Public mode turned *${args[0]}* — ${v ? 'anyone can now use commands, in any chat' : 'only you can use commands now'}.` };
    }

    case 'groupinfo': {
      if (!jid.endsWith('@g.us')) return { reply: 'This only works in group chats.' };
      try {
        const metadata = await sock.groupMetadata(jid);
        return { reply: `*${metadata.subject}*\n${metadata.desc || 'No description.'}\nMembers: ${metadata.participants.length}` };
      } catch {
        return { reply: "Couldn't fetch group info." };
      }
    }

    case 'invitelink': {
      if (!jid.endsWith('@g.us')) return { reply: 'This only works in group chats.' };
      try {
        const code = await sock.groupInviteCode(jid);
        return { reply: `https://chat.whatsapp.com/${code}` };
      } catch {
        return { reply: "Couldn't get the invite link — the bot may need to be an admin." };
      }
    }

    case 'kick': {
      const err = await requireGroupAdmin(sock, jid, senderJid);
      if (err) return { reply: err };
      const mentioned = getMentionedJids(msg);
      if (!mentioned.length) return { reply: `Mention who to remove, e.g. ${PREFIX}kick @user` };
      try {
        await sock.groupParticipantsUpdate(jid, mentioned, 'remove');
        return { reply: '✅ Removed.' };
      } catch {
        return { reply: "Couldn't remove them — am I an admin here?" };
      }
    }

    case 'promote': {
      const err = await requireGroupAdmin(sock, jid, senderJid);
      if (err) return { reply: err };
      const mentioned = getMentionedJids(msg);
      if (!mentioned.length) return { reply: `Mention who to promote, e.g. ${PREFIX}promote @user` };
      try {
        await sock.groupParticipantsUpdate(jid, mentioned, 'promote');
        return { reply: '✅ Promoted to admin.' };
      } catch {
        return { reply: "Couldn't promote them — am I an admin here?" };
      }
    }

    case 'demote': {
      const err = await requireGroupAdmin(sock, jid, senderJid);
      if (err) return { reply: err };
      const mentioned = getMentionedJids(msg);
      if (!mentioned.length) return { reply: `Mention who to demote, e.g. ${PREFIX}demote @user` };
      try {
        await sock.groupParticipantsUpdate(jid, mentioned, 'demote');
        return { reply: '✅ Admin status removed.' };
      } catch {
        return { reply: "Couldn't demote them — am I an admin here?" };
      }
    }

    case 'pin': {
      const quoted = getQuotedKey(msg, sock);
      if (!quoted) return { reply: `Reply to a message with ${PREFIX}pin to pin it.` };
      await sock.sendMessage(jid, { pin: { type: 1, time: 86400, key: quoted } });
      return { reply: '📌 Pinned for 24 hours.' };
    }

    case 'unpin': {
      const quoted = getQuotedKey(msg, sock);
      if (!quoted) return { reply: `Reply to a pinned message with ${PREFIX}unpin to remove the pin.` };
      await sock.sendMessage(jid, { pin: { type: 0, key: quoted } });
      return { reply: '📌 Unpinned.' };
    }

    case 'edit': {
      const quoted = getQuotedKey(msg, sock);
      const newText = args.join(' ');
      if (!quoted || !newText) return { reply: `Reply to one of the bot's own messages with ${PREFIX}edit <new text>.` };
      if (!quoted.fromMe) return { reply: 'I can only edit messages I sent myself.' };
      await sock.sendMessage(jid, { text: newText, edit: quoted });
      return { handled: true };
    }

    case 'sticker': {
      const quotedMessage = getQuotedMessageContent(msg);
      if (!quotedMessage?.imageMessage && !quotedMessage?.videoMessage) {
        return { reply: `Reply to an image or short video with ${PREFIX}sticker to convert it.` };
      }
      try {
        const buffer = await downloadMediaMessage({ message: quotedMessage, key: msg.key }, 'buffer', {});
        await sock.sendMessage(jid, { sticker: buffer });
      } catch (err) {
        console.error('Sticker conversion failed:', err.message);
        return { reply: "Couldn't turn that into a sticker, sorry." };
      }
      return { handled: true };
    }

    case 'toimg': {
      const quotedMessage = getQuotedMessageContent(msg);
      if (!quotedMessage?.stickerMessage) return { reply: `Reply to a sticker with ${PREFIX}toimg to convert it to an image.` };
      try {
        const webpBuffer = await downloadMediaMessage({ message: quotedMessage, key: msg.key }, 'buffer', {});
        const jpgBuffer = await webpToJpgBuffer(webpBuffer);
        await sock.sendMessage(jid, { image: jpgBuffer });
      } catch (err) {
        console.error('Sticker-to-image failed:', err.message);
        return { reply: "Couldn't convert that sticker, sorry." };
      }
      return { handled: true };
    }

    case 'forward': {
      const quotedMessage = getQuotedMessageContent(msg);
      const quotedKey = getQuotedKey(msg, sock);
      const target = args[0];
      if (!quotedMessage || !quotedKey || !target) {
        return { reply: `Reply to a message and send ${PREFIX}forward <number> to forward it there.` };
      }
      const targetJid = `${target.replace(/\D/g, '')}@s.whatsapp.net`;
      await sock.sendMessage(targetJid, { forward: { key: quotedKey, message: quotedMessage } });
      return { reply: `Forwarded to +${target.replace(/\D/g, '')}.` };
    }

    case '8ball':
      if (!args.length) return { reply: `Ask a question, e.g. ${PREFIX}8ball will it rain today` };
      return { reply: `🎱 ${EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)]}` };

    case 'roll':
      return { reply: `🎲 You rolled a ${Math.ceil(Math.random() * 6)}` };

    case 'flip':
      return { reply: `🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}` };

    case 'joke':
      try {
        const { data } = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 8000 });
        return { reply: `${data.setup}\n\n${data.punchline}` };
      } catch {
        return { reply: 'Why did the bot cross the road? The joke API was down. 😅' };
      }

    case 'fact':
      try {
        const { data } = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random', { timeout: 8000 });
        return { reply: `💡 ${data.text}` };
      } catch {
        return { reply: '💡 Octopuses have three hearts.' };
      }

    case 'quote':
      try {
        const { data } = await axios.get('https://zenquotes.io/api/random', { timeout: 8000 });
        const q = data?.[0];
        return { reply: q ? `"${q.q}" — ${q.a}` : 'Could not fetch a quote right now.' };
      } catch {
        return { reply: '"The only way to do great work is to love what you do." — Steve Jobs' };
      }

    case 'ship': {
      const mentioned = getMentionedJids(msg);
      if (mentioned.length < 2) return { reply: `Mention two people, e.g. ${PREFIX}ship @user1 @user2` };
      return { reply: `💘 Compatibility: ${Math.floor(Math.random() * 101)}%`, mentions: mentioned };
    }

    case 'rate': {
      const thing = args.join(' ');
      if (!thing) return { reply: `Rate what? e.g. ${PREFIX}rate pineapple on pizza` };
      return { reply: `I'd rate "${thing}" a solid ${Math.ceil(Math.random() * 10)}/10.` };
    }

    case 'compliment': {
      const mentioned = getMentionedJids(msg);
      const who = mentioned[0] ? `@${mentioned[0].split('@')[0]}` : 'You';
      return { reply: `${who} ${COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)]}`, mentions: mentioned };
    }

    case 'calc': {
      const expr = args.join(' ');
      if (!expr) return { reply: `Give me something to calculate, e.g. ${PREFIX}calc 12 * (3 + 4)` };
      try {
        return { reply: `${expr} = ${evaluate(expr)}` };
      } catch {
        return { reply: "Couldn't calculate that — check the expression." };
      }
    }

    case 'qr': {
      const qrText = args.join(' ');
      if (!qrText) return { reply: `Give me text or a link, e.g. ${PREFIX}qr https://example.com` };
      try {
        const buffer = await QRCode.toBuffer(qrText, { width: 400 });
        await sock.sendMessage(jid, { image: buffer, caption: `QR code for: ${qrText}` });
      } catch (err) {
        console.error('QR generation failed:', err.message);
        return { reply: "Couldn't generate that QR code." };
      }
      return { handled: true };
    }

    case 'time':
      return { reply: `🕒 ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` };

    case 'pp': {
      const mentioned = getMentionedJids(msg);
      const targetJid = mentioned[0] || jid;
      try {
        const url = await sock.profilePictureUrl(targetJid, 'image');
        await sock.sendMessage(jid, { image: { url } });
      } catch {
        return { reply: "Couldn't get that profile picture — they may not have one, or their privacy settings block it." };
      }
      return { handled: true };
    }

    case 'poll': {
      const parts = args.join(' ').split('|').map((p) => p.trim()).filter(Boolean);
      if (parts.length < 3) return { reply: `Usage: ${PREFIX}poll Question | Option 1 | Option 2` };
      const [question, ...options] = parts;
      await sock.sendMessage(jid, { poll: { name: question, values: options, selectableCount: 1 } });
      return { handled: true };
    }

    case 'location': {
      const [lat, long] = args.map(Number);
      if (!lat || !long) return { reply: `Usage: ${PREFIX}location <latitude> <longitude>` };
      await sock.sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: long } });
      return { handled: true };
    }

    case 'vcf': {
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${phoneNumber}\nTEL;type=CELL;type=VOICE;waid=${phoneNumber}:+${phoneNumber}\nEND:VCARD`;
      await sock.sendMessage(jid, { contacts: { displayName: phoneNumber, contacts: [{ vcard }] } });
      return { handled: true };
    }

    default:
      return { reply: `Unknown command \`${PREFIX}${cmd}\`. Send ${PREFIX}menu to see what's available.` };
  }
}
