// ci-run.js — entrypoint used only by the GitHub Actions workflow (not by the
// Replit workflow, which uses start.js). Non-interactive: no terminal prompt.
// - Resumes any WhatsApp session(s) restored from the encrypted backup.
// - Starts the Telegram control bot if TELEGRAM_BOT_TOKEN is set.
// - Pairs a brand-new number if PAIR_NUMBER is set (from the workflow's
//   manual "phone_number" input) — the pairing code is printed to the
//   Actions log for the owner to read and enter on their phone.
import { resumeExistingSessions, startWhatsAppSession } from './bot.js';

process.on('unhandledRejection', (err) => console.log('Unhandled rejection (ignored):', err?.message || err));
process.on('uncaughtException', (err) => console.log('Uncaught exception (ignored):', err?.message || err));

async function pairNewNumberIfRequested() {
  const number = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');
  if (!number) return;

  console.log(`\nPairing new number +${number}...`);
  try {
    await startWhatsAppSession(number, {
      onPairingCode: (code) => {
        console.log(`\n=== PAIRING CODE for +${number}: ${code} ===`);
        console.log('On that WhatsApp number: Settings → Linked Devices → Link a Device → Link with phone number instead → enter this code within a few minutes.\n');
      },
      onConnected: () => console.log(`+${number} connected ✅`),
    });
  } catch (err) {
    console.error(`Pairing +${number} failed:`, err.message);
  }
}

async function main() {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN set — starting the Telegram control bot (it also resumes existing WhatsApp session(s) on its own)...\n');
    await import('./index.js');
  } else {
    console.log('No TELEGRAM_BOT_TOKEN set — resuming existing WhatsApp session(s) only (no Telegram control channel this run).\n');
    const resumed = await resumeExistingSessions();
    console.log(resumed.length ? `Resumed: ${resumed.map((n) => `+${n}`).join(', ')}` : 'No existing WhatsApp session found on disk.');
  }

  await pairNewNumberIfRequested();

  console.log('\nBot is running. It stays up until this job hits its time budget, then the workflow saves session state and a fresh job picks up automatically.\n');
}

main();
