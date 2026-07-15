// scripts/session-backup.mjs — encrypt/decrypt the whole `sessions/` tree
// (WhatsApp creds, per-chat memory, owner settings) into a single committable
// file, so a throwaway CI runner can resume exactly where the last one left
// off. Run directly: `node scripts/session-backup.mjs pack|unpack`.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SESSIONS_DIR = 'sessions';
const BACKUP_FILE = 'session-backup.enc';
const KEY_ENV = 'SESSION_ENCRYPT_KEY';

function walk(dir, base = dir) {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(full, base));
    else files.push(path.relative(base, full));
  }
  return files;
}

function deriveKey(passphrase) {
  return crypto.createHash('sha256').update(passphrase).digest(); // -> 32 bytes, required for aes-256
}

export function pack() {
  const key = process.env[KEY_ENV];
  if (!key) {
    console.log(`Skipping session backup: ${KEY_ENV} is not set (add it as a repo secret to persist sessions across restarts).`);
    return;
  }

  const files = walk(SESSIONS_DIR);
  if (!files.length) {
    console.log('No session files on disk to back up.');
    return;
  }

  const payload = {};
  for (const rel of files) {
    payload[rel] = fs.readFileSync(path.join(SESSIONS_DIR, rel)).toString('base64');
  }

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(key), iv);
  const json = Buffer.from(JSON.stringify(payload));
  const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);

  fs.writeFileSync(BACKUP_FILE, JSON.stringify({ iv: iv.toString('base64'), data: encrypted.toString('base64') }));
  console.log(`Session backup written to ${BACKUP_FILE} (${files.length} file(s), AES-256 encrypted).`);
}

export function unpack() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.log('No session backup file found — starting fresh (pairing will be required).');
    return;
  }

  const key = process.env[KEY_ENV];
  if (!key) {
    console.log(`Session backup exists but ${KEY_ENV} is not set — cannot decrypt, starting fresh.`);
    return;
  }

  const { iv, data } = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(key), Buffer.from(iv, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  const payload = JSON.parse(decrypted.toString());

  for (const [rel, base64] of Object.entries(payload)) {
    const full = path.join(SESSIONS_DIR, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(base64, 'base64'));
  }
  console.log(`Session restored from backup (${Object.keys(payload).length} file(s)).`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'pack') pack();
  else if (cmd === 'unpack') unpack();
  else console.log('Usage: node scripts/session-backup.mjs pack|unpack');
}
