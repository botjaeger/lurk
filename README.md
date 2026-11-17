<p align="center">
  <img src="icons/icon.svg" alt="Lurk logo: two eyes peeking over a green bar" width="128" height="128">
</p>

<h1 align="center">Lurk</h1>

<p align="center"><strong>Read it. Nobody knows.</strong></p>

Lurk is a free, open-source browser extension for Chrome, Firefox and Safari. It stops chat apps from
telling people that you read their message, watched their story or are typing. Open the chat, read every
word, answer when you're ready.

No account, no servers, nothing collected. Everything happens in your browser.

## What it hides

| App | Seen on messages | Typing | Story views |
|---|---|---|---|
| Messenger and Facebook (`messenger.com`, `facebook.com`) | yes, except end-to-end encrypted chats | yes | yes |
| Instagram (`instagram.com`) | yes | yes | yes |
| WhatsApp (`web.whatsapp.com`) | yes (blue ticks, voice-note plays) | yes (typing, recording) | yes (status views) |
| Google Chat (`chat.google.com`, Chat in Gmail) | yes | yes | – (no stories) |
| Teams (`teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`) | yes | yes | – (no stories) |

Each signal has its own switch, so you can, say, hide "Seen" but still show that you are typing.

**How far it has been checked.** Google Chat was tested live with two signed-in accounts (Seen and typing
both hidden, no retries or errors). The other apps are matched against the formats used by current
open-source clients (mautrix/meta, Carrier and Ghostify for Meta; Baileys and WhatsApp Web Incognito for
WhatsApp; purple-teams, Squads and matrix-teams for Teams) and covered by headless tests, but not yet
against a live signed-in session.

## Install

Lurk is not in the browser stores yet. Build it and load it yourself:

```sh
git clone https://github.com/botjaeger/lurk.git
cd lurk
pnpm install
pnpm build        # writes dist/chrome, dist/firefox and dist/safari
```

- **Chrome, Edge, Brave:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
  and choose `dist/chrome`.
- **Firefox 142 or later:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**
  and choose `dist/firefox/manifest.json`. Firefox removes it when it quits.
- **Safari 26 or later (macOS 14+):** `pnpm safari:app` builds `dist/Lurk.app` (needs Xcode). In Safari,
  turn on **Settings → Advanced → Show features for web developers**, then **Develop → Allow Unsigned
  Extensions**. Open `dist/Lurk.app` once and turn Lurk on in **Settings → Extensions**. With an Apple
  developer account, `DEVELOPMENT_TEAM=<team id> pnpm safari:app:signed` builds a signed app instead.

The build needs Node.js (tested on 22), pnpm and the `zip` command. Lurk is written in TypeScript (`src/`);
the build bundles each script with esbuild, unminified. The extension has no run-time dependencies.

## Using it

- **Lurk mode** (the green card in the toolbar popup) is the main switch. Its status line says what is
  hidden on the site you are on.
- **Hide on <site>** has a switch each for Seen on messages, Typing and Story views. A signal the site does
  not have says "Not on <site>" instead.
- **Let receipts through for 10 s:** when you do want someone to see you read it, click this, then reopen the
  chat. Lurk turns back on by itself.
- **Stats** counts how many Seen receipts, typing bursts and story views Lurk hid, per app, kept only in your
  browser.
- `Alt+Shift+U` turns Lurk on or off from any tab. The toolbar badge shows `OFF` when nothing is hidden and a
  countdown while receipts are let through.
- The sun/moon button switches the popup between light and dark.

## Good to know

- **Replying counts as reading.** Sending a message marks the chat read on the server. No extension can
  stop that.
- Chats you open stay unread for you, on every device, until you reply or let a receipt through.
- Only the web apps in this browser are covered. Phone and desktop apps, and replying from a notification,
  still send receipts.
- **End-to-end encrypted Messenger chats** still send "Seen"; typing there is hidden.
- **WhatsApp:** your phone and other linked devices still show the chat as read to you. The sender is not
  told.
- **Teams:** typing sent from a Teams background worker, if the app does that, is not covered.
- **TikTok and Slack are not supported.** TikTok's web chat sends no "Seen" or typing signal at all (checked
  live with two accounts), and Slack has no read receipts.
- **Safari:** the Safari build compiles but has not yet been run in Safari, and Safari only lets Lurk act on
  sites you allow it to.
- These are the apps' internal formats. If an app changes how it sends receipts, hiding can stop on that app
  until Lurk is updated.

## How it works

Lurk never reads or stores your messages. It looks only at the few requests an app sends to report a read,
a story view or typing, and changes or stops just those.

**Google Chat.** Opening a conversation sends `POST …/u/<N>/api/mark_group_readstate`, which shows your
avatar as "Seen". A `declarativeNetRequest` rule (`rules.json`) blocks that request for every signed-in
account. Typing is `POST …/_/DynamiteWebUi/data/batchexecute?rpcids=uQwtvc`; `rules-typing.json` blocks it
only when it carries nothing else, so batched calls are never lost. Chat does not retry or show an error.
`src/content/gchat.ts` blocks nothing; it only notices those calls so Stats can count them.

**Messenger, Facebook, Instagram.** These send their signals inside WebSocket frames and GraphQL bodies,
which network rules cannot see. `src/content/page.ts` runs in the page before the app's own scripts:

- **Typing:** `is_typing: 1` in an outgoing socket frame becomes `0`. In end-to-end encrypted Messenger
  chats, the composer state handed to Messenger's worker is forced to `idle`.
- **Seen:** `last_read_watermark_ts` in an outgoing mark-read task is set to the oldest time with the same
  number of digits, so your read mark never moves past their messages.
- **Story views:** the call that marks a story viewed gets a fake empty success and is never sent. Instagram
  DM "seen" calls made over HTTP are handled the same way.

Frames are parsed and only a real key is edited, so text you type is never changed. Edits keep the frame's
byte length and nothing is dropped, so the app never waits for or retries a missing request.

**WhatsApp.** Every stanza is a binary node encrypted with AES-GCM before it goes on the socket.
`src/content/whatsapp.ts` reads each outgoing node just before `crypto.subtle.encrypt` and swaps one token: a
`read` or `played` receipt becomes an `inactive` (delivered) receipt, which also covers status views, and
`composing` becomes `paused`. Newer WhatsApp builds can move the socket into a worker; WhatsApp's own
`WAWebCommsGating.isCommsInWorker` switch is set to false so it stays on the page.

**Teams.** A read receipt is `PUT …/conversations/<id>/properties?name=consumptionhorizon`; typing is a
message with `messagetype` `Control/Typing`. Both get a fake success in the page and are never sent. A
network rule also blocks the read receipt when it comes from a Teams worker.

`src/content/bridge.ts` hands your settings to the page scripts and passes their counts to the background
worker. `src/sites.ts` is the one list of apps and what each covers, shared by the popup and the worker.

## Develop

```sh
pnpm install      # dev tools (TypeScript, esbuild, Prettier, ESLint, Vitest, Playwright, puppeteer-core) and the pre-commit hook
pnpm format       # Prettier
pnpm typecheck    # tsc --noEmit over src/ and tests/
pnpm check        # Prettier check + ESLint + typecheck + unit tests (Vitest)
pnpm test:watch   # unit tests, rerun on save
pnpm e2e          # builds dist/chrome, runs it in headless Chromium against faked sites
pnpm e2e:firefox  # the Firefox build in headless Firefox Developer Edition or Nightly
pnpm build        # dist/chrome, dist/firefox, dist/safari + dist/lurk-chrome.zip, dist/lurk-firefox.zip
pnpm safari:app   # dist/Lurk.app from the Xcode project in safari/
pnpm icons        # regenerate icons/*.png from scripts/make-icons.mjs
```

`CHROME_BIN` points the Chromium suites at a full Chromium or Chrome for Testing build (`pnpm exec playwright install
chromium` provides one); `FIREFOX_BIN` points the Firefox suite at Firefox Developer Edition or Nightly, which
load an unsigned add-on. The pre-commit hook runs `pnpm check` (and the website build when `site/` changed);
CI (`.github/workflows/ci.yml`) runs everything above on every push and pull request.
[AGENTS.md](AGENTS.md) describes the code layout and the rules for changing it.

## Website

`site/` is the project website (home, privacy policy, terms), a small static Vite site:

```sh
pnpm site:dev     # local server at http://localhost:5173
pnpm site:build   # typecheck + site/dist/
```

A push to `main` publishes it to GitHub Pages through `.github/workflows/pages.yml` (set the repository's
**Settings → Pages → Source** to "GitHub Actions" once).

## Privacy

Lurk collects nothing and sends nothing. It keeps its settings and the Stats counts in your browser's own
extension storage. The full policy is in [site/privacy.html](site/privacy.html).

## License

MIT, see [LICENSE](LICENSE). The WhatsApp node reader is adapted from
[Baileys](https://github.com/WhiskeySockets/Baileys) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Lurk is not affiliated with Meta, Google or Microsoft.
