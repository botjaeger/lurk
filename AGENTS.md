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
pnpm install        # dev tools + sets core.hooksPath=.githooks (pre-commit runs pnpm check)
pnpm format         # Prettier --write (.prettierrc.json, .prettierignore); format:check only checks
pnpm lint           # ESLint (eslint.config.js)
pnpm typecheck      # tsc --noEmit over src/ (tsconfig.json) and tests/ (tests/tsconfig.json)
pnpm check          # Gate: Prettier check + ESLint + typecheck + Vitest (tests/*.test.ts)
pnpm test           # Vitest unit tests once (pnpm test:watch reruns them on save)
pnpm e2e            # Builds dist/chrome, runs it in headless Chromium against faked sites (5 suites)
pnpm e2e:firefox    # Builds dist/firefox, runs it in headless Firefox Developer Edition
pnpm build          # dist/chrome, dist/firefox, dist/safari + the two store zips
pnpm build:firefox  # one target (likewise build:chrome, build:safari)
pnpm safari:app     # build:safari + xcodebuild (unsigned) -> dist/Lurk.app
pnpm icons          # icons/*.png (and the store icon) from scripts/make-icons.mjs
pnpm store-assets   # Chrome Web Store screenshots, promo tile, icon -> dist/store (needs CHROME_BIN)
pnpm site:dev       # website dev server (pnpm install covers it)
pnpm site:build     # website typecheck + build -> site/dist
pnpm release 0.1.2  # bump, gate, commit, tag, push; the tag makes CI publish (--dry-run to preview)
node tests/e2e/stats.e2e.mjs   # one e2e suite
```

E2E environment: `CHROME_BIN` (a full Chromium or Chrome for Testing; Playwright's headless shell cannot load
extensions) and `FIREFOX_BIN` (Developer Edition or Nightly, which load an unsigned add-on). `PLAYWRIGHT` and
`PUPPETEER` override the package paths; by default the local devDependencies are used. UI tests run headless
only.

The full local gate before a change is done: `pnpm check`, `pnpm e2e`, `pnpm e2e:firefox`,
`pnpm build`, plus `pnpm site:build` when `site/` changed and `pnpm safari:app` when the manifest
or file list changed. Each e2e suite prints `ALL PASS n/n`; check the exit code, not only the output.

The pre-commit hook (`.githooks/pre-commit`) runs `pnpm check`, and `pnpm site:build` when staged files
touch `site/`. CI (`.github/workflows/ci.yml`) runs check + build + site build, the Chromium suites and the
Firefox suite (Nightly) on every push and pull request; `.github/workflows/pages.yml` deploys the website from
`main`. Safari is built and tested only locally (macOS + Xcode).

Releases follow the same process as botjaeger/brainrot; keep the two in step. `pnpm release <version>`
(`scripts/release.mjs`) bumps every version field, runs check + both e2e sets, commits, tags `v<version>`
and pushes. The tag runs `.github/workflows/release.yml`: a `build` job (tag check, check, Chromium e2e,
`pnpm build`, `dist/lurk-source.zip`), then `chrome` (`scripts/cws-publish.mjs`, API v2, keyless sign-in
as the shared service account, `chrome-web-store` environment), `firefox` (`web-ext sign`, AMO secrets)
and `github-release` in parallel; a store without credentials is skipped with a warning. Every workflow
is read-only at the top level and a job asks for more (`tests/workflows.test.ts`). Setup: `README.md`,
"Releasing".

## Layout

| Path | Role |
|---|---|
| `manifest.json` | Base manifest (Chrome). `manifest.firefox.json` / `manifest.safari.json` are overlays. |
| `src/background.ts` | Service worker (Firefox: background script). Applies state: toggles the DNR rulesets, badge, title, pass-through alarm; adds Stats counts. |
| `rules.json`, `rules-typing.json` | Static DNR rulesets `block_receipts` (Google Chat + Teams Seen) and `block_typing` (Google Chat typing). |
| `src/sites.ts` | The one list of supported apps (`SITES`: id, host regex, name, `covers`, optional `note`) and `siteFor(host)`. Imported by the popup and the worker. |
| `src/shared.ts` | Types and helpers for every script: `Kind`, `KINDS`, the `Stored` storage shape, `readLocal`, `CountMessage`. |
| `src/content/page.ts` | MAIN world on Facebook, Messenger, Instagram, Teams: hooks `WebSocket.send`, fetch/XHR and worker `postMessage`; the decisions are in `frames.ts`. |
| `src/content/frames.ts` | Pure: socket-frame edits (`editFrame`), worker messages (`idleChatStates`), HTTP `classify`. Unit-tested. |
| `src/content/whatsapp.ts` | MAIN world on WhatsApp: hooks `crypto.subtle.encrypt`, keeps comms off the worker. |
| `src/content/wabinary.ts` | Pure: WhatsApp binary-node reader (`readString`, `readNode`) and `editStanza`. Unit-tested. |
| `src/content/gchat.ts` | MAIN world on Google Chat: blocks nothing, only reports counts (the DNR rules block). |
| `src/content/events.ts` | The page scripts' side of the DOM events: `count()` and `followState()`. |
| `src/content/bridge.ts` | Isolated world everywhere: sends settings to the page scripts, de-duplicates and forwards counts, answers the popup's `lurk:host`. |
| `src/popup/` | Toolbar popup (`popup.html`, `popup.css`, `popup.ts`). |
| `scripts/build.mjs` | Bundles `SCRIPTS` (esbuild, IIFE, unminified) and copies `ASSETS` into `dist/<browser>`, merges the overlay, zips Chrome and Firefox. |
| `scripts/release.mjs`, `scripts/cws-publish.mjs` | `pnpm release` (bump, gate, commit, tag, push) and the Chrome Web Store upload the release workflow runs. Both unit-tested (`tests/release.test.ts`, `tests/cws.test.ts`). |
| `pnpm-workspace.yaml` | pnpm workspace: the root (extension tooling) and `site/`, one `pnpm-lock.yaml`; esbuild may run its install script. |
| `tsconfig.json` | Strict TypeScript for `src/` (`@types/chrome`); `site/` has its own. |
| `safari/Lurk/` | Xcode project (Xcode 27 `project.xcproj` format) wrapping `dist/safari`. |
| `site/` | Website: own `package.json`, Vite, deployed by `.github/workflows/pages.yml`. |
| `tests/` | `*.test.ts` (Vitest, run by `check`; `tests/tsconfig.json`) and `e2e/*.e2e.mjs`. |
| `eslint.config.js` | ESLint flat config (with typescript-eslint): type-aware rules for all TypeScript, browser/webextension globals for `src/`, no `import()` there, Node for scripts and tests. |
| `.prettierrc.json`, `.prettierignore` | Prettier, width 100. Markdown is hand-wrapped and not formatted. |
| `.githooks/pre-commit`, `.github/workflows/` | Pre-commit gate; CI (`ci.yml`), website deploy (`pages.yml`) and store release (`release.yml`). |
| `docs/workstreams/` | Audit trackers (`AUD-NNN` items) for open work, and `project-defect-classes.md`: each defect class found, its rule and its guard in `tests/classes.test.ts`. |

## How the pieces talk

- Page scripts (MAIN world) cannot use `chrome.*`. `bridge.ts` dispatches `lurk:state` with
  `detail` = JSON string `{seen, stories, typing}`; page scripts dispatch `lurk:ready` and `lurk:count` with
  `detail` = JSON string `{kind, key}`. Always pass strings across the boundary: Firefox's Xray wrappers block
  page access to object details sent from a content script.
- Until the first `lurk:state` arrives, page scripts block everything.
- An extension update or reload leaves `bridge.ts` in open tabs cut off from the extension (every `chrome.*`
  call throws). It then keeps the last settings, still ends a running pause on time, and ignores the page
  scripts' events (`alive()`, `onPageEvent`). `restart.e2e.mjs` covers it.
- `bridge.ts` collapses repeats (`WINDOW_MS`: seen 60 s per key, stories 30 s per key, typing 10 s per tab)
  and sends `{type: "lurk:count", kind}` to the worker, which counts it only if `sites.ts` says that app
  covers that kind (`sender.url` decides the app, never the message).
- The worker runs `apply()` through one promise queue (`sync()`), so a slow run never overwrites a newer
  state. Stats-only storage changes do not re-apply.
- Every read-then-write of storage (counts, a new pause, the stats reset, the shortcut's toggle) runs on that
  queue. The popup asks for a pause or a reset with a `PopupMessage` (`lurk:pause`, `lurk:reset-stats`),
  accepted only from the extension's own pages; it writes `enabled`, `signals` and `theme` directly.
  `tests/classes.test.ts` fails on a new write outside these rules.

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

- **Never touch user content.** Socket edits parse the frame (`findKeys`, `escapeTimes` in `frames.ts`) and
  change only a real key, never text that merely contains it; WhatsApp edits act on the parsed node.
- **Keep byte lengths and never drop a request the app waits for.** Rewrite in place, or answer with a fake
  success, so the app does not retry or show an error. A request is only dropped outright when the app
  expects no answer.
- Every entry in `SCRIPTS` ships as one classic script: static imports are bundled in, `import()` is
  forbidden (ESLint), and nothing leaks into the page's globals (the IIFE wraps it) except the
  deliberate ones: the non-enumerable double-injection flags `__lurkPatched` (`page.ts`) and
  `__lurkWhatsApp` (`whatsapp.ts`), and WhatsApp's own `__onAfterModuleFactory` hook, which
  `whatsapp.ts` chains. A page can see them; add no others. Code shared between
  entries is copied into each; keep shared modules free of side effects.
- Patching a native (`fetch`, `XMLHttpRequest.prototype.open`, …) passes the caller's arguments on exactly
  (`...args`): `open(method, url, undefined)` would make the request synchronous.
- A DNR regex must pass `chrome.declarativeNetRequest.isRegexSupported` (Chrome silently drops rules over its
  memory limit); prefer `urlFilter` + `requestDomains`. `tests/rules.test.ts` checks every rule.
- `requestMethods` in a DNR rule needs Safari 26, which is why `manifest.safari.json` sets that minimum.
- Firefox runs `background.js` as a background script (an event page with a DOM); Chrome and Safari run it as
  a service worker. Keep it to APIs both have.
- Bump the version only for a release, never as part of other work, and only with `pnpm release`: it
  changes every field together (`manifest.json`, `package.json`, `site/package.json`, the Safari
  project's two `MARKETING_VERSION`; `tests/release.test.ts` fails when one moves). Every Chrome Web
  Store upload needs a higher `version` than the published one. The website reads the version from
  `manifest.json`.

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

- Vitest (`tests/*.test.ts`, plain Node, `vitest.config.ts`, typed by `tests/tsconfig.json`) for the pure
  parts of `src/` and `scripts/`: keep page hooks thin and put decisions in pure modules it can import.
  Playwright (Chromium) and puppeteer-core (Firefox, WebDriver BiDi) for the real extension. Sites are faked
  with request routing, so content scripts run on the real origins while nothing reaches the apps.
- Every new test gets a negative control: break the code it guards, watch it fail, restore.
- Frame and request shapes come from open-source clients unless captured live. Prefer a captured shape.
- Live checks use only the tester's own accounts (a chat with yourself, or between two of your own
  accounts). Never open a real person's conversation: it sends them a real receipt.

## Website (`site/`)

Static multi-page Vite site: `index.html`, `privacy.html`, `terms.html`, `src/main.ts`, `src/style.css`,
`src/release.ts` (store listing states; the version comes from `../manifest.json`). `base: "./"` keeps every
URL relative, so it works under `https://<user>.github.io/<repo>/`; the one exception is `public/404.html`
(GitHub Pages serves it at any depth, so it is self-contained with absolute links). Fonts are self-hosted; the site makes no
third-party requests and has no analytics. `site/public/mark.svg` and the icon PNGs are copies of `icons/`;
update them together. The privacy and terms pages are the store listings' policy URLs: keep their facts
(permissions, hosts, stored values) true when the code changes.
