// pair-cli.js — Interactive terminal alternative to the Telegram control bot.
// Run with `node pair-cli.js`, type a WhatsApp number when prompted, and the
// pairing code will be printed right here in the terminal.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { startWhatsAppSession, resumeExistingSessions } from './bot.js';

process.on('unhandledRejection', (err) => console.log('Unhandled rejection (ignored):', err?.message || err));
process.on('uncaughtException', (err) => console.log('Uncaught exception (ignored):', err?.message || err));

const rl = readline.createInterface({ input, output });

async function main() {
  console.log('WhatsApp pairing (terminal mode)');

  // Reconnect any number that's already linked (has stored credentials on
  // disk) automatically — no pairing code, no terminal input needed. Pairing
  // is only required the first time, or after an explicit logout on the phone.
  const resumed = await resumeExistingSessions();
  if (resumed.length) {
    console.log(`Reconnecting already-linked number(s): ${resumed.map((n) => `+${n}`).join(', ')}\n`);
  }

  console.log('To link a new/additional number, enter it with country code, no + or spaces (e.g. 2348123456789).');
  console.log('Or just press Enter to skip and keep only the already-linked session(s) above.\n');

  const number = (await rl.question('WhatsApp number to pair (optional): ')).trim().replace(/\D/g, '');

  if (!number) {
    console.log(resumed.length ? 'No new number entered — staying connected with the existing session(s).' : 'No number entered, exiting.');
    rl.close();
    return;
  }

  console.log(`\nStarting pairing for +${number}...`);

  try {
    await startWhatsAppSession(number, {
      onPairingCode: (code) => {
        console.log(`\nPairing code: ${code}`);
        console.log('On that WhatsApp number: Settings → Linked Devices → Link a Device → Link with phone number instead → enter this code.\n');
      },
      onConnected: () => {
        console.log(`\n✅ +${number} connected — AI auto-replies are now active. Leave this running to keep the session alive.\n`);
      },
    });
  } catch (err) {
    console.error(`Pairing failed: ${err.message}`);
  }

  rl.close();
  // Keep the process alive after pairing so the socket (and its reconnect logic) stays up.
}

main();
