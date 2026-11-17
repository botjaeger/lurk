# AGENTS.md

Guide for coding agents (Codex, Claude Code via `CLAUDE.md`) and contributors. Product overview: `README.md`.

Lurk: Manifest V3 browser extension that hides read receipts ("Seen"), typing indicators and story views on
Messenger/Facebook, Instagram, WhatsApp Web, Google Chat and Teams. Targets Chromium, Firefox 142+ and
desktop Safari 26+. No backend and no run-time dependencies. The extension is TypeScript in `src/`;
`scripts/build.mjs` bundles each entry with esbuild into one unminified classic script per browser build in
`dist/`. The repo also holds the website (`site/`).

Scope stays narrow: hide those three signals, a short pass-through, local stats. No accounts, sync, remote
services or analytics. TikTok and Slack were removed on purpose (TikTok's web chat sends neither signal;
Slack has no read receipts); do not add them back without a live capture showing a signal to hide.

## Commands

```bash
npm install            # dev tools + sets core.hooksPath=.githooks (pre-commit runs npm run check)
npm --prefix site install  # once: check lints site/ with type-aware rules, which read its types
npm run format         # Prettier --write (.prettierrc.json, .prettierignore); format:check only checks
npm run lint           # ESLint (eslint.config.js)
npm run typecheck      # tsc --noEmit over src/ (tsconfig.json)
npm run check          # Gate: Prettier check + ESLint + typecheck + node:test (tests/*.test.mjs)
npm run e2e            # Builds dist/chrome, runs it in headless Chromium against faked sites (5 suites)
npm run e2e:firefox    # Builds dist/firefox, runs it in headless Firefox Developer Edition
npm run build          # dist/chrome, dist/firefox, dist/safari + the two store zips
npm run build:firefox  # one target (likewise build:chrome, build:safari)
npm run safari:app     # build:safari + xcodebuild (unsigned) -> dist/Lurk.app
npm run icons          # icons/*.png (and the store icon) from scripts/make-icons.mjs
npm run store-assets   # Chrome Web Store screenshots, promo tile, icon -> dist/store (needs CHROME_BIN)
npm run site:dev       # website dev server (npm --prefix site install once)
npm run site:build     # website typecheck + build -> site/dist
node tests/e2e/stats.e2e.mjs   # one e2e suite
```

E2E environment: `CHROME_BIN` (a full Chromium or Chrome for Testing; Playwright's headless shell cannot load
extensions) and `FIREFOX_BIN` (Developer Edition or Nightly, which load an unsigned add-on). `PLAYWRIGHT` and
`PUPPETEER` override the package paths; by default the local devDependencies are used. UI tests run headless
only.

The full local gate before a change is done: `npm run check`, `npm run e2e`, `npm run e2e:firefox`,
`npm run build`, plus `npm run site:build` when `site/` changed and `npm run safari:app` when the manifest
or file list changed. Each e2e suite prints `ALL PASS n/n`; check the exit code, not only the output.

The pre-commit hook (`.githooks/pre-commit`) runs `npm run check`, and `npm run site:build` when staged files
touch `site/`. CI (`.github/workflows/ci.yml`) runs check + build + site build, the Chromium suites and the
Firefox suite (Nightly) on every push and pull request; `.github/workflows/pages.yml` deploys the website from
`main`. Safari is built and tested only locally (macOS + Xcode).

## Layout

| Path | Role |
|---|---|
| `manifest.json` | Base manifest (Chrome). `manifest.firefox.json` / `manifest.safari.json` are overlays. |
| `src/background.ts` | Service worker (Firefox: background script). Applies state: toggles the DNR rulesets, badge, title, pass-through alarm; adds Stats counts. |
| `rules.json`, `rules-typing.json` | Static DNR rulesets `block_receipts` (Google Chat + Teams Seen) and `block_typing` (Google Chat typing). |
| `src/sites.ts` | The one list of supported apps (`SITES`: id, host regex, name, `covers`, optional `note`) and `siteFor(host)`. Imported by the popup and the worker. |
| `src/shared.ts` | Types and helpers for every script: `Kind`, `KINDS`, the `Stored` storage shape, `readLocal`, `CountMessage`. |
| `src/content/page.ts` | MAIN world on Facebook, Messenger, Instagram, Teams: socket-frame edits, fetch/XHR answers, worker `postMessage` hook. |
| `src/content/whatsapp.ts` | MAIN world on WhatsApp: rewrites binary nodes before `crypto.subtle.encrypt`, keeps comms off the worker. |
| `src/content/gchat.ts` | MAIN world on Google Chat: blocks nothing, only reports counts (the DNR rules block). |
| `src/content/events.ts` | The page scripts' side of the DOM events: `count()` and `followState()`. |
| `src/content/bridge.ts` | Isolated world everywhere: sends settings to the page scripts, de-duplicates and forwards counts, answers the popup's `lurk:host`. |
| `src/popup/` | Toolbar popup (`popup.html`, `popup.css`, `popup.ts`). |
| `scripts/build.mjs` | Bundles `SCRIPTS` (esbuild, IIFE, unminified) and copies `ASSETS` into `dist/<browser>`, merges the overlay, zips Chrome and Firefox. |
| `tsconfig.json` | Strict TypeScript for `src/` (`@types/chrome`); `site/` has its own. |
| `safari/Lurk/` | Xcode project (Xcode 27 `project.xcproj` format) wrapping `dist/safari`. |
| `site/` | Website: own `package.json`, Vite, deployed by `.github/workflows/pages.yml`. |
| `tests/` | `*.test.mjs` (node:test, run by `check`) and `e2e/*.e2e.mjs`. |
| `eslint.config.js` | ESLint flat config (with typescript-eslint): type-aware rules for all TypeScript, browser/webextension globals for `src/`, no `import()` there, Node for scripts and tests. |
| `.prettierrc.json`, `.prettierignore` | Prettier, width 100. Markdown is hand-wrapped and not formatted. |
| `.githooks/pre-commit`, `.github/workflows/` | Pre-commit gate; CI (`ci.yml`) and website deploy (`pages.yml`). |
| `docs/workstreams/` | Audit tracker (`AUD-NNN` items) for open live-verification work. |

## How the pieces talk

- Page scripts (MAIN world) cannot use `chrome.*`. `bridge.ts` dispatches `lurk:state` with
  `detail` = JSON string `{seen, stories, typing}`; page scripts dispatch `lurk:ready` and `lurk:count` with
  `detail` = JSON string `{kind, key}`. Always pass strings across the boundary: Firefox's Xray wrappers block
  page access to object details sent from a content script.
- Until the first `lurk:state` arrives, page scripts block everything.
- `bridge.ts` collapses repeats (`WINDOW_MS`: seen 60 s per key, stories 30 s per key, typing 10 s per tab)
  and sends `{type: "lurk:count", kind}` to the worker, which counts it only if `sites.ts` says that app
  covers that kind (`sender.url` decides the app, never the message).
- The worker runs `apply()` through one promise queue (`sync()`), so a slow run never overwrites a newer
  state. Stats-only storage changes do not re-apply.

## Storage

| Key | Area | Meaning |
|---|---|---|
| `enabled` | local | Main switch, default true. |
| `signals` | local | `{seen, stories, typing}`, each default true. |
| `pauseUntil` | local | Epoch ms while "Let receipts through" runs. Local, not session: Firefox cannot open session storage to content scripts. |
| `stats` | local | `{since, sites: {<site id>: {seen, stories, typing}}}`. |
| `theme` | local | `"light"` / `"dark"`; absent = follow the system. |
| `running` | session | Set on the worker's first run after browser start; when missing, a stale `pauseUntil` is removed, so a pause never survives a restart. |

A new stored value must also be listed in `site/privacy.html` ("What the extension stores on your device").

## Rules for changes

- **Never touch user content.** Socket edits parse the frame (`findKeys`, `escapeTimes` in `page.ts`) and
  change only a real key, never text that merely contains it; WhatsApp edits act on the parsed node.
- **Keep byte lengths and never drop a request the app waits for.** Rewrite in place, or answer with a fake
  success, so the app does not retry or show an error. A request is only dropped outright when the app
  expects no answer.
- Every entry in `SCRIPTS` ships as one classic script: static imports are bundled in, `import()` is
  forbidden (ESLint), and nothing leaks into the page's globals (the IIFE wraps it). Code shared between
  entries is copied into each; keep shared modules free of side effects.
- Patching a native (`fetch`, `XMLHttpRequest.prototype.open`, …) passes the caller's arguments on exactly
  (`...args`): `open(method, url, undefined)` would make the request synchronous.
- A DNR regex must pass `chrome.declarativeNetRequest.isRegexSupported` (Chrome silently drops rules over its
  memory limit); prefer `urlFilter` + `requestDomains`. `tests/rules.test.mjs` checks every rule.
- `requestMethods` in a DNR rule needs Safari 26, which is why `manifest.safari.json` sets that minimum.
- Firefox runs `background.js` as a background script (an event page with a DOM); Chrome and Safari run it as
  a service worker. Keep it to APIs both have.
- Version stays `0.1.0` until the first release. Do not bump it as part of other work. The website reads the
  version from `manifest.json`; the Safari project has its own `MARKETING_VERSION`.

### Adding or removing a supported app

Every one of these changes together:

- `src/sites.ts` entry (`covers`: true = hidden, null = the app has no such signal, false = not yet covered)
- `manifest.json` `content_scripts` matches: the page-script block and the `bridge.js` block
- the matcher in `src/content/page.ts` (or a new MAIN-world script: a `SCRIPTS` entry in `scripts/build.mjs`,
  the manifest and the Safari project's "Lurk Extension" target)
- tests: the per-app e2e checks, the popup `view()` checks in `social.e2e.mjs`, the Stats rows in
  `stats.e2e.mjs`
- `README.md` (table, how it works, limits), `site/index.html` (intro, app strip, table, footer),
  `site/privacy.html` (host list), `site/terms.html` (not-affiliated list)

## Testing

- `node:test` for pure checks; Playwright (Chromium) and puppeteer-core (Firefox, WebDriver BiDi) for the
  real extension. Sites are faked with request routing, so content scripts run on the real origins while
  nothing reaches the apps.
- Every new test gets a negative control: break the code it guards, watch it fail, restore.
- Frame and request shapes come from open-source clients unless captured live. Prefer a captured shape.
- Live checks use only the tester's own accounts (a chat with yourself, or between two of your own
  accounts). Never open a real person's conversation: it sends them a real receipt.

## Website (`site/`)

Static multi-page Vite site: `index.html`, `privacy.html`, `terms.html`, `src/main.ts`, `src/style.css`,
`src/release.ts` (store listing states; the version comes from `../manifest.json`). `base: "./"` keeps every
URL relative, so it works under `https://<user>.github.io/<repo>/`. Fonts are self-hosted; the site makes no
third-party requests and has no analytics. `site/public/mark.svg` and the icon PNGs are copies of `icons/`;
update them together. The privacy and terms pages are the store listings' policy URLs: keep their facts
(permissions, hosts, stored values) true when the code changes.
