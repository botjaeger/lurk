# gchat-unseen audit — 2026-11-16

## AUD-001 — Pass-through not proven against live Google Chat

- **Status:** OPEN (needs the user's OK to send one test message between their own two accounts)
- **Trigger:** blocking on, open an unread DM (receipt blocked, Chat retries ~18× then stops), click
  "Let receipts through for 10 s", reopen or click into the same chat.
- **Expected:** Chat sends `POST /u/N/api/mark_group_readstate` again within the 10 s; it returns 200 and the
  sender sees "Seen".
- **Actual:** unknown. Proven so far: during a pause the request is not blocked on the wire
  (`tests/e2e/extension.e2e.mjs`), and with blocking off from the start Chat sends it and "Seen" appears
  (live test 3). Not proven: that Chat re-sends it after its retries gave up.
- **Evidence:** live captures 2026-11-16 (tests 2–5), headless e2e 22/22.
- **Correction direction:** if Chat does not re-send, reword the popup hint (e.g. reload the chat tab during the
  pass-through) or drop the button.
- **Acceptance:** with the extension loaded, a message from account B opened by account A under blocking shows no
  "Seen"; after the pass-through plus the documented reopen step, B shows "Seen" (aria-label "Message viewed by …").

## AUD-002 — Non-Google apps not verified against live sessions

- **Status:** OPEN (needs the user to sign in to each web app in Chrome; the agent may not type credentials)
- **Scope:** Facebook, Messenger, Instagram, WhatsApp Web, Teams (Slack support removed 2026-11-17; project renamed to `lurk`; the extension
  must be re-loaded unpacked from the renamed folder).
- **Trigger:** signed in, Lurk loaded, open a chat with yourself (Messenger self-chat, WhatsApp "Message yourself",
  Teams chat with yourself); type; view your own story/status.
- **Expected:** the outgoing signal matches the shapes the code targets (Lightspeed label 3/21 frames and
  `last_read_watermark_ts`; Instagram story GraphQL names; WhatsApp `<receipt type=read>` / `<chatstate><composing>`
  reached through `crypto.subtle.encrypt` with comms on the main thread; Teams
  `consumptionhorizon` PUT and `Control/Typing` POST) and Lurk rewrites or answers it without page errors.
- **Actual:** unknown. All shapes come from open-source clients (mautrix/meta, Carrier, Ghostify, Baileys,
  WhatsApp Web Incognito, purple-teams, Squads, matrix-teams); headless suites
  `tests/e2e/social.e2e.mjs` and `tests/e2e/apps.e2e.mjs` pass against faked sites.
- **Evidence:** Chrome on 2026-11-16 was signed out of Facebook, Instagram, WhatsApp, Slack and TikTok; Teams sat
  on its splash screen.
- **Correction direction:** capture the real frames/requests in a self-chat and adjust matchers; for end-to-end
  encrypted Messenger chats find the worker message that carries Seen.
- **Acceptance:** for each app, a self-chat capture shows the signal leaving rewritten or not at all, and the app
  shows no error banner or retry loop.

## AUD-003 — TikTok built as a best guess, not verified

- **Status:** CLOSED 2026-11-17 — TikTok support removed.
- **Finding:** live test with the user's two accounts (web on this Chrome, the other on the iPad app), Lurk off:
  opening the chat and typing on tiktok.com sent no read or typing request on the IM socket
  (`im-ws-sg.tiktok.com`) or over HTTP, and the iPad showed neither "Seen" nor typing; app-to-app showed both.
  The socket's field 1 is a sequence number, not the command Tabslify's notes assumed, so the matcher was also
  wrong. Nothing to hide on the web: `content/tiktok.js`, its site entry, tests and website mentions removed.
- **Built:** `content/tiktok.js` fakes an "ok" for HTTP `…/v3/conversation/mark_read` and rewrites
  cmd 2002 (mark_read) / 411 (input_status) to 2001 in IM-socket envelopes (`im-ws.tiktok.com`, field 8);
  shapes from paul-schoettl/Tabslify `docs/tiktok-im-protokoll.md`; `tests/e2e/apps.e2e.mjs` covers them
  against built frames.
- **Unknown:** whether the web client sends mark_read over HTTP or the socket, whether its frames are
  compressed, whether the server accepts a rewritten cmd without an error the client shows, and how story
  views are sent.
- **Acceptance:** with account B messaging account A, A opens the chat and types; B sees neither "Seen" nor
  typing, and A's inbox shows no error or retry loop.
