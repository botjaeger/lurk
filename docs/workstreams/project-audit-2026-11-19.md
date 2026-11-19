# Whole-project sweep — 2026-11-19

Open items the sweep could not close on its own. Classes and their guards: `project-defect-classes.md`.

## AUD-001 — Stats never count Chat in Gmail

- **Status:** OPEN (needs the owner's decision: it widens the extension's permissions to Gmail)
- **Trigger:** use Google Chat inside Gmail (`https://mail.google.com/chat/u/0/…`) with Lurk on; open an
  unread chat and type.
- **Expected:** the popup's Stats count the hidden Seen and typing under Google Chat, as on
  `chat.google.com`.
- **Actual:** `rules.json` and `rules-typing.json` block both requests on `mail.google.com` (so the signals
  are hidden), and the popup on Gmail says "Hiding Seen and typing", but no Lurk script runs on
  `mail.google.com` (`manifest.json` `content_scripts` list only `chat.google.com`), so `gchat.js` never sees
  the calls and Stats stay at "Nothing hidden yet".
- **Evidence:** `manifest.json` content_scripts; `tests/classes.test.ts` lists `mail.google.com` in
  `RULES_ONLY`; README and the website promise "Chat in Gmail" for hiding only.
- **Correction direction:** either add `https://mail.google.com/*` to the `gchat.js` and `bridge.js`
  blocks (the store listing then says Lurk can read and change data on mail.google.com; update
  `site/privacy.html`, `README.md` and remove the `RULES_ONLY` entry), or keep the permissions narrow and
  say in the Stats hint and README that Chat in Gmail is hidden but not counted.
- **Acceptance:** either a Gmail Chat receipt blocked in a faked `mail.google.com` page adds one Seen to
  Google Chat in Stats (`stats.e2e.mjs`), or the popup on `mail.google.com` and the README say it is not
  counted.
