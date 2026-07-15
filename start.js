// start.js — single entrypoint that picks the right pairing method automatically:
// - TELEGRAM_BOT_TOKEN set  -> Telegram control bot (index.js), which also
//   resumes any already-linked WhatsApp session(s) on boot.
// - no token                -> terminal pairing fallback (pair-cli.js), which
//   does the same WhatsApp session resume plus an interactive prompt.
// Only one of these should run at a time (both manage the same WhatsApp
// sessions), so this replaces running index.js/pair-cli.js directly.
if (process.env.TELEGRAM_BOT_TOKEN) {
  console.log('TELEGRAM_BOT_TOKEN found — starting the Telegram control bot (+ resuming WhatsApp session(s))...\n');
  await import('./index.js');
} else {
  console.log('No TELEGRAM_BOT_TOKEN set — using terminal pairing instead.\n');
  await import('./pair-cli.js');
}
