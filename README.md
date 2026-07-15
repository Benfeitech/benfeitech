# WhatsApp AI Bot

A Node.js bot that links a WhatsApp number (via Baileys) and auto-replies to
incoming WhatsApp DMs with an AI-generated text reply plus a matching voice
note (Google TTS → ffmpeg → OGG/Opus). The account owner gets a private
command menu; everyone else just gets the AI auto-reply.

## Pairing a number
Run the **WhatsApp Pairing** workflow (or `node pair-cli.js` directly), type
the WhatsApp number when prompted (country code, no `+` or spaces), then on
that phone: **Settings → Linked Devices → Link a Device → Link with phone
number instead** and enter the pairing code shown in the console.

An alternate Telegram-based pairing flow (`index.js`, DM `/pair <number>` to
a Telegram bot) exists but is inactive until `TELEGRAM_BOT_TOKEN` (and
optionally `TELEGRAM_ADMIN_ID`) secrets are added.

## Owner-only commands
Once connected, message **yourself** on WhatsApp (the "Message yourself" /
note-to-self chat) with any of:

- `.ping` — confirms the bot is alive
- `.status` — uptime + current settings
- `.ai on|off` — toggle AI auto-replies to other people
- `.voice on|off` — toggle voice-note replies
- `.reset` — clear the AI's short conversation memory for a chat
- `.menu` — show this list

These only work from the linked account itself (Baileys marks that as
`fromMe`) — nobody messaging the bot from another number can run them.

## How it works
- Session credentials live per-number under `sessions/<number>/` (gitignored)
  so pairing survives restarts.
- `sessions/<number>/settings.json` stores the owner's `.ai` / `.voice`
  toggles.
- Reply text comes from a public, unauthenticated third-party API
  (`api-rebix.vercel.app`) — no key required, but it's outside our control.
- The AI keeps a short rolling memory (last few exchanges) per chat so
  replies feel like a continuous conversation, not one-off Q&A.
- Images/videos/documents sent to the bot are acknowledged (using their
  caption, if any) but not visually analyzed — the AI backend is text-only.
- Reconnects after a dropped connection use exponential backoff (capped at
  30s, up to 8 attempts) instead of retrying instantly and indefinitely.

## Running on GitHub Actions (instead of Replit)
The bot now runs as a GitHub Actions workflow (`.github/workflows/whatsapp-bot.yml`)
rather than a Replit workflow — Replit is only used to edit the code.

**Why it restarts every 6 hours:** GitHub caps every Actions job at 6 hours.
The workflow runs the bot for ~340 minutes, then saves session state (WhatsApp
credentials, per-chat memory, owner settings) into an encrypted file
(`session-backup.enc`) committed back to the repo, and a scheduled trigger
starts a fresh job every 6 hours that restores that file and picks up exactly
where the last run left off — no re-pairing needed.

**One-time setup you need to do on GitHub** (Settings → Secrets and variables
→ Actions → New repository secret):
- `SESSION_ENCRYPT_KEY` — a private passphrase that encrypts the session
  backup. Generate one yourself (don't paste it into chat with me) — e.g. run
  `openssl rand -base64 32` in a terminal and copy the output in. Required,
  or the session won't persist between runs.
- `TELEGRAM_BOT_TOKEN` — only needed if you want the Telegram `/pair` control
  channel active. Without it, use the manual pairing step below instead.
- `TELEGRAM_ADMIN_ID` — optional, restricts who can use the Telegram bot.
- `ZST_API_KEY` — needed for the content skills (wallpapers, YouTube, etc.).

**Since your repo is public**, note that `session-backup.enc` gets committed
into git history every run — it's AES-256 encrypted so it's unreadable
without `SESSION_ENCRYPT_KEY` (which only exists as a GitHub secret, never
in the repo), but anyone can still see that a backup file exists and changes
periodically.

**Pairing a number for the first time:** go to the repo's Actions tab → "WhatsApp Bot" →
"Run workflow" → enter the phone number (country code, no + or spaces) in the
`phone_number` field → Run. Watch that run's log for the pairing code and
enter it on your phone within a few minutes. Leave `phone_number` blank on
all later manual/scheduled runs.

## Staying connected across restarts
Once a number is paired, it stays paired: on every startup the bot scans
`sessions/` for numbers that already have stored WhatsApp credentials and
reconnects them automatically — no pairing code, no re-entering the number.
You'll only be asked to pair again if you explicitly log the device out from
WhatsApp itself (Settings → Linked Devices → remove it) or if you delete its
session folder.

## Per-user memory
Each WhatsApp chat (each contact, tracked by its JID) gets its own isolated
memory file under `sessions/<your number>/chats/<their jid>/` — one person's
conversation never bleeds into another's:
- `state.json` — the recent conversation (last ~15 exchanges) that's actually
  replayed into the AI prompt on every reply, plus any pending clarification
  (e.g. "reply with a number to pick a video").
- `full-log.jsonl` — every message either side has ever sent in that chat,
  appended forever. It's the durable long-term record, kept separate from the
  prompt so replies don't get slower/costlier as a conversation grows.
`.reset` (owner-only) clears a chat's recent-context memory so the AI starts
fresh, without touching the full log.

## Content skills (no command needed)
Anyone chatting with the bot — not just the owner — can ask in plain language
for:

- a wallpaper ("send me a wallpaper of ocean sunset")
- a YouTube search ("search youtube for lofi hip hop") — replies with a
  numbered list, then sends the actual video file once you pick one
- a book search ("find me a book called harry potter")
- a styled text image ("make a neon glitch image saying 'ZST LABS'",
  also supports "galaxy wallpaper" and "glossy silver 3d" styles)
- a waifu picture ("send a waifu hug")
- a shortened link ("shorten https://example.com")

These call an external content API. Its name/key/URL never appear in any
reply — including if someone directly asks "what API do you use" or tries to
prompt around it; those questions get a fixed, generic deflection instead of
being answered at all. Failures (e.g. an expired video link) fall back to a
generic "couldn't do that right now" message rather than surfacing raw errors.

**Known limitation:** YouTube video downloads can fail because the direct
video URL the API returns is tied to *its* server's IP address — when our
server (a different IP) tries to fetch it, YouTube sometimes rejects it. The
bot detects and reports this gracefully instead of sending a broken file, but
there's no full fix without a different underlying download approach.

## Notes on WhatsApp "interactive" features
Native WhatsApp buttons/list menus/carousels were deprecated by WhatsApp for
unofficial clients — most Baileys-based projects dropped support, and forks
that re-add them via reverse-engineered protocol calls carry real
ban/restriction risk for the linked number. This bot intentionally sticks to
plain text with WhatsApp's built-in formatting (`*bold*`, `_italic_`,
`` ```monospace``` ``) for menus instead.
