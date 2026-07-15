// memory.js — durable per-chat state (rolling conversation history plus any
// pending clarification the bot is waiting on, e.g. "which video did you
// mean?"). Stored as JSON per chat so a workflow restart never wipes an
// ongoing conversation.
import fs from 'fs';
import path from 'path';

const HISTORY_TURNS = 15; // exchanges kept in the AI prompt itself (bounded, so each request stays a reasonable size)
const cache = new Map(); // "phoneNumber|jid" -> state object

function chatDir(phoneNumber, jid) {
  const safeJid = jid.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join('sessions', phoneNumber, 'chats', safeJid);
}

function stateFile(phoneNumber, jid) {
  return path.join(chatDir(phoneNumber, jid), 'state.json');
}

// Every message is also appended to a full, never-trimmed log per chat — this
// is the durable long-term record of "everything this person has ever said"
// even though only the most recent turns are replayed into the AI prompt
// (an unbounded prompt would get slower/costlier with every message).
function logFile(phoneNumber, jid) {
  return path.join(chatDir(phoneNumber, jid), 'full-log.jsonl');
}

function appendToFullLog(phoneNumber, jid, role, text) {
  const file = logFile(phoneNumber, jid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ role, text, at: new Date().toISOString() }) + '\n');
}

function load(phoneNumber, jid) {
  const key = `${phoneNumber}|${jid}`;
  if (cache.has(key)) return cache.get(key);
  let state = { history: [], pending: null };
  try {
    const file = stateFile(phoneNumber, jid);
    if (fs.existsSync(file)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch (err) {
    console.log(`Chat memory for ${jid} unreadable, starting fresh:`, err.message);
  }
  cache.set(key, state);
  return state;
}

function persist(phoneNumber, jid, state) {
  cache.set(`${phoneNumber}|${jid}`, state);
  const file = stateFile(phoneNumber, jid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function getHistory(phoneNumber, jid) {
  return load(phoneNumber, jid).history;
}

export function pushHistory(phoneNumber, jid, role, text) {
  appendToFullLog(phoneNumber, jid, role, text);
  const state = load(phoneNumber, jid);
  state.history.push({ role, text });
  while (state.history.length > HISTORY_TURNS * 2) state.history.shift();
  persist(phoneNumber, jid, state);
}

export function clearHistory(phoneNumber, jid) {
  const state = load(phoneNumber, jid);
  state.history = [];
  persist(phoneNumber, jid, state);
}

export function getPending(phoneNumber, jid) {
  return load(phoneNumber, jid).pending;
}

export function setPending(phoneNumber, jid, pending) {
  const state = load(phoneNumber, jid);
  state.pending = pending;
  persist(phoneNumber, jid, state);
}

export function clearPending(phoneNumber, jid) {
  setPending(phoneNumber, jid, null);
}
