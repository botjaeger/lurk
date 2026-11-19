# Defect classes — whole project

One row per class of defect found by a sweep. Each class has a rule, a guard that fails when a new site
breaks the rule, and the grep that lists candidate sites. Re-check every class over the whole tree before a
sweep's other lenses run. Guards live in `tests/classes.test.ts` unless named otherwise.

## C1 — Read-then-write of storage off the worker's queue

- **Rule:** a storage write that depends on a read (a count, a new pause, a stats reset, the shortcut's toggle)
  runs on the worker's promise queue (`enqueue` in `src/background.ts`). The popup asks for it with a
  `PopupMessage`; it writes only `enabled`, `signals` and `theme` outright.
- **Guard:** `C1: outside the worker, scripts write only keys they set outright` and `C1: every storage write
  in the worker runs on its queue`. Negative control 2026-11-19: a popup `set({ pauseUntil })` and a
  `void resetStats()` off the queue each fail it.
- **Candidates:** `grep -rn "storage\.\(local\|session\|sync\)\.\(set\|remove\|clear\)(" src`
- **Instances:**
  - 2026-11-19 popup "Reset stats" wrote `stats` while the worker's `addCount` was between its read and
    write: the reset was lost (4/40 in a headless burst). Fixed: `lurk:reset-stats` on the queue.
  - 2026-11-19 popup "Let receipts through" wrote `pauseUntil` while `apply()` removed the previous, expired
    pause: the new pause was dropped (1–3/40). Fixed: `lurk:pause` on the queue.
  - 2026-11-19 the `toggle-blocking` shortcut read and wrote `enabled` off the queue. Moved onto it.

## C2 — The app list drifts from the manifest and the privacy policy

- **Rule:** every host an app is used on runs `bridge.js` and a page script, or is listed as rules-only with
  the reason; every manifest host maps to a `SITES` entry and is named in `site/privacy.html`.
- **Guard:** the three `C2:` tests (host table `APP_HOSTS`, `RULES_ONLY`). Negative control 2026-11-19:
  dropping Instagram from the bridge block, or `teams.live.com` from the policy, fails them.
- **Candidates:** `src/sites.ts`, `manifest.json` `content_scripts`, `site/privacy.html` permissions list,
  README table.
- **Instances:**
  - 2026-11-19 Chat in Gmail (`mail.google.com`): `sites.ts` and the popup cover it, `rules.json` blocks it,
    but no content script runs there, so Stats never counts it. Open decision: AUD-001 in
    `project-audit-2026-11-19.md`.
  - 2026-11-19 the privacy policy named neither `mail.google.com` nor Gmail, yet `rules.json` and
    `rules-typing.json` block requests there, and it said the extension "does nothing on any other site".
    Now named in the declarativeNetRequest bullet. Guard: `C2: every host a network rule acts on is named in
    the privacy policy` (negative control: dropping "(mail.google.com)" fails it).

## C3 — A content script cut off by an extension update

- **Rule:** after an update or reload, `bridge.ts` in open tabs may not call `chrome.*` from page events
  (`onPageEvent` checks `alive()`), and `push()` keeps the last settings so a running pause still ends.
  Only `bridge.ts` calls `chrome.*` in `src/content/`.
- **Guard:** `C3:` in `tests/classes.test.ts` (static) and the "update mid-pause" checks in
  `tests/e2e/restart.e2e.mjs` (behaviour). Negative control 2026-11-19: the previous `bridge.ts` fails both.
- **Candidates:** `grep -n "chrome\.\|addEventListener" src/content/*.ts`
- **Instances:**
  - 2026-11-19 an update during a 10 s pause left that tab sending story views and Seen until it was
    reloaded; each blocked signal then threw "Extension context invalidated" into the page.

## C4 — A live region rewritten with unchanged or ticking text

- **Rule:** a live region's spoken text is written only when it changes; counters inside it are
  `aria-hidden`.
- **Guard:** "status pill" checks in `tests/e2e/extension.e2e.mjs`. Negative control 2026-11-19: the previous
  popup spoke 5 times on 5 stats updates and once per second of a pause.
- **Candidates:** `grep -rn "aria-live\|role=\"status\"\|role=\"alert\"" src site`
- **Instances:**
  - 2026-11-19 popup `#status`: repeated on every stats update and every countdown second.

## C5 — Colours below contrast

- **Rule:** text 4.5:1 (3:1 large), switch tracks and icons 3:1 against what they sit on, in light and dark
  and in every hero state.
- **Guard:** `C5: popup token pairs meet contrast in light and dark` (token pairs from `popup.css`, both
  themes, and the stepped-back hero switch) and `C5: website text colours meet contrast on every surface`
  (`site/src/style.css` tokens, and every rule with white text on a literal colour). Negative control
  2026-11-19: the previous `popup.css` and `style.css` each fail them.
- **Candidates:** `grep -n "color:\|background:" src/popup/popup.css site/src/style.css`
- **Instances:**
  - 2026-11-19 popup off-switch track 1.65:1 (light) / 1.58:1 (dark); hero switch on the stepped-back card in
    dark mode 1.16:1. Fixed tokens.
  - 2026-11-19 website chat bubble white on `#2f6bff` 4.499:1. Now `#2b65f0` (4.9:1).
  - 2026-11-19 website chat avatar letter white on `#8e6bff` 3.7:1. Now `#7650e8` (5.1:1).
  - 2026-11-19 website `.receipt-struck` ("Seen 9:41"): `--muted` at `opacity: 0.7` on `--card` 4.28:1 (axe,
    every width). Now 0.8 (5.2:1). The website guard now also checks every rule with a literal text colour
    on its literal background (or, in the popup replica, on the replica's card and rows) and every rule
    that fades a token colour with `opacity`, blended into each surface. Negative control: `opacity: 0.7`,
    or `.replica-status` `#3aa060`, fails it.
  - 2026-11-19 popup hero switch focus ring: `outline-color: currentColor` on an `<input>`, which does not
    inherit `color`, so the ring was the browser's field text: white in dark mode, 1.95:1 on the green card
    (rendered, headless Chromium). Fixed: `.switch-hero { color: inherit; }` (ring = card ink in every
    state). Guard: the "hero switch focus ring 3:1 on its card" checks in `tests/e2e/extension.e2e.mjs`
    (rendered, light/dark x on/off). Negative control: without `color: inherit`, "dark, on" fails at 1.95.
    Every other `:focus-visible` ring is `--accent` on `--bg`/`--card`, covered by the token pairs.

## C6 — A workflow that can write by default

- **Rule:** every workflow's top-level `permissions` is read-only; a job that needs more (`contents: write`
  for a release, `pages`/`id-token` for a deploy or a keyless sign-in) asks for it on that job only. A step
  that needs an API the job cannot read is dropped, not given a wider token.
- **Guard:** `tests/workflows.test.ts` (copied from botjaeger/brainrot, which has the same rule). Negative
  control 2026-11-19: the previous `pages.yml` (top-level `pages: write`, `id-token: write`) fails it.
- **Candidates:** `grep -n "permissions" -A4 .github/workflows/*.yml`
- **Instances:**
  - 2026-11-19 `pages.yml` granted `pages: write` and `id-token: write` to its build job too. Moved to
    `deploy`; `configure-pages` (reads the Pages API, outputs unused) removed from the read-only build job.

## C7 — A release that leaves the tree half-changed

- **Rule:** `pnpm release` changes every version field together or none: each field's pattern must match its
  expected count, the browsers the gate needs are checked before anything is written, and a failed gate
  restores every field. The store refuses a version that is not higher than the published one.
- **Guard:** `tests/release.test.ts` (every field in `bumps()` matches the real files exactly as often as
  expected; browsers checked first). Negative control 2026-11-19: the Safari count set to 1 fails it.
  The restore path was run for real in a scratch clone (gate forced to fail: 4 files back to 0.1.1, tree
  clean, nothing committed).
- **Candidates:** `grep -rn '"version"\|MARKETING_VERSION' --include='*.json' --include='*.xcproj' .`
- **Instances:**
  - 2026-11-19 versions were bumped by hand in five places (0.1.1, 0.1.2, back to 0.1.1).
  - 2026-11-19 the first `scripts/release.mjs` wrote the bumped versions before running the gate and left
    them on failure, so a re-run refused the dirty tree.

## C8 — The website's static copy contradicts the store states

- **Rule:** `site/src/release.ts` is the one record of where each store listing stands. `main.ts` rewrites
  the cards at load, but the static HTML (no scripts, crawlers, link previews) must already say the same:
  a live store's card shows "On the <store>" and a visible link to its URL; a pending one hides the link;
  the hero pill names live stores outside its "… soon" part and pending ones inside it.
- **Guard:** `C8: each store card and the hero pill match release.ts`. Negative control 2026-11-19: Chrome set
  back to `pending`, or the old pill text "Chrome and Firefox · Safari soon", fails it.
- **Candidates:** `grep -n "data-store\|pill-dot\|soon" site/index.html`
- **Instances:**
  - 2026-11-19 the Chrome Web Store listing was public (0.1.0) while the site said "listing coming soon"
    and the pill said "Chrome and Firefox" with Firefox not listed. Chrome now `live`; pill reads "On the
    Chrome Web Store · Firefox and Safari soon".

## C9 — Website content cut off at 200% zoom

- **Rule:** at 200% zoom a 390 px phone is 195 CSS px wide and `body` clips horizontal overflow, so wider
  content is lost without a scrollbar. Grid tracks use `minmax(0, …)`, `body` wraps long words, and no
  fixed width inside a narrow-screen media query exceeds 195 px.
- **Guard:** `C9: website layout shrinks to 195 CSS px` (static), plus the lens sweep's collision check at
  195 px. Negative control 2026-11-19: `repeat(2, 1fr)`, `.mini-popup` `width: 250px`, or no
  `overflow-wrap` on `body`, each fails it.
- **Candidates:** `grep -n "grid-template-columns\|width: [0-9]" site/src/style.css`
- **Instances:**
  - 2026-11-19 at 195 px the home hero ("Nobody knows."), the popup card and the chat were cut off
    (content 278 px wide); privacy.html's text column grew to 252 px around "teams.cloud.microsoft" and
    "declarativeNetRequest:"; terms.html's footer links ran to 210 px. Fixed tracks, word wrapping, a
    300 px breakpoint for display type, wrapping footer nav and a shrinking `.pill-dot`/`.mini-popup`.

## C10 — A native patch that rebuilds the caller's arguments

- **Rule:** a patched native (fetch, XHR open/setRequestHeader/send, `WebSocket.send`, `postMessage`,
  `crypto.subtle.encrypt`, a page hook Lurk chains to) takes `...args` and calls the native with
  `native.apply(this, args)`, editing only the one argument it rewrites. Never `native.call(this, a, b)`.
- **Guard:** `C10: every patched native takes ...args and passes them on with apply` (static) and the
  behaviour checks "ws.send() with no argument throws TypeError like the native" and
  "WhatsApp encrypt() with 2 arguments fails like the native" (both `apps.e2e.mjs`; encrypt against an iframe's untouched
  copy). Negative control 2026-11-19: `nativeEncrypt.call(this, args[0], args[1], args[2])`, or a
  `send(data)` signature, fails the static guard; the previous `page.ts`/`whatsapp.ts` fail both e2e checks.
- **Candidates:** `grep -n "= function \|native\w*\.\(call\|apply\)(" src/content/*.ts`
- **Instances:**
  - 2026-11-19 `page.ts` `WebSocket.send`: `ws.send()` sent an empty frame instead of throwing TypeError.
  - 2026-11-19 `whatsapp.ts` `encrypt`: rebuilt 3 arguments (a 2-argument call failed with the wrong error).
  - 2026-11-19 `page.ts` `postMessage`, `setRequestHeader` and WhatsApp's chained `__onAfterModuleFactory`
    (dropped `this` and every argument after the first): moved to `...args` + `apply`. Checked, already
    right: `fetch`, XHR `open`/`send` (page.ts, gchat.ts), gchat `sendBeacon` (bound, spread).

## C11 — A surface that says more than the state it shows

- **Rule:** a surface that summarises state (toolbar title, badge, popup status, heading, switches) says
  only what is true for the current settings and the open site, from its first painted frame. The popup is
  hidden (`html[data-loading]`) until it has drawn the state for the open site.
- **Guard:** "Seen off: toolbar title names what is hidden" (`extension.e2e.mjs`) and "real popup: the
  first painted frame is already the Instagram state" (`social.e2e.mjs`, rAF recorder on the real toolbar
  popup). Negative control 2026-11-19: the title fixed to "read receipts blocked", or `siteKnown = true` with
  the early `refresh()`, fails them.
- **Candidates:** `grep -n "setTitle\|setBadgeText\|textContent = " src/background.ts src/popup/popup.ts`
- **Instances:**
  - 2026-11-19 toolbar title "Lurk: read receipts blocked" with Seen switched off (Seen was being sent).
    Now "Lurk: hiding story views and typing" (names what is hidden; all on keeps the old title).
  - 2026-11-19 popup opened on every supported app painted "Hide | Lurk does nothing on this page" (and, on
    a first run, an unticked main switch) before the site was known, and the live region took both texts.
  - Checked, right: badge (`""` / `Ns` / `OFF`), status pill (`statusFor` reads covers + signals), Stats.
    Not a user path: `chrome.action.openPopup()` on Chat in Gmail shows "this page" because no Lurk script
    runs there and no activeTab grant is given (an icon click grants it); see AUD-001.

## C12 — A request classified by what someone wrote, or by a call that only reads

- **Rule:** `classify()` decides from the URL with its method, the GraphQL friendly name, and the body's
  key names (a JSON body's keys, a form's field names and its `variables` keys), never from free text in a
  body; GraphQL names ending in `Query` only read and are never faked; REST checks are anchored path
  segments.
- **Guard:** `C12:` in `tests/classes.test.ts` (no body text search in `classify`, URL checks gated by
  method, Teams typing only on the messages URL) and the `frames.test.ts` cases "loading an Instagram
  thread is not a Seen" and "a message or comment quoting a story-view id is sent, not faked". Negative
  control 2026-11-19: the previous `frames.ts` fails all three; a `lowerBody` search or `isQuery` off fails.
- **Candidates:** `grep -n "\.test(url)\|\.test(body)\|includes(" src/content/frames.ts`
- **Instances:**
  - 2026-11-19 `GET …/direct_v2/threads/<id>/?visual_message_return_type=unseen` was classified "seen" and
    faked (the thread never loaded). Now POST + `…/items/<id>/seen/` or `…/mark_read/`.
  - 2026-11-19 a DM or comment containing `xdt_mark_story_reel_seen`/`forceSeenStoryId` was faked and never
    sent (user content). Now matched only as a key or the friendly name.
  - 2026-11-19 sibling: a name with "seen" + "story" (a viewers-list `…Query`) was faked; Teams typing was
    matched in any site's body. Both fixed.

## C13 — A faked answer that does not look like the real one

- **Rule:** a faked XHR answer matches the request's `responseType`, and the fields it sets on the request
  object are removed when the app reuses it (`open()` again).
- **Guard:** "faked XHR with responseType arraybuffer answers an ArrayBuffer" and "a reused XHR reports
  its real answer after a faked one" (`social.e2e.mjs`). Negative control 2026-11-19: the previous
  `page.ts` fails both.
- **Candidates:** `grep -n "defineProperty\|fakeBody\|fakeResponse" src/content/*.ts`
- **Instances:**
  - 2026-11-19 `page.ts` XHR fake: a string for every `responseType`; the own `status`/`responseText`/…
    stayed on the object, so its next real request reported the fake. (The fetch fake is a fresh
    `Response`: fine.)

## C14 — Stats de-duplication keyed on text that does not tell signals apart

- **Rule:** the key a page script gives `count()` identifies the signal (the story, the thread): GraphQL
  friendly name + a hash of the URL and `variables` (`requestKey` in `frames.ts`), not a prefix of the body.
- **Guard:** "two different story views count as two" (`social.e2e.mjs`). Negative control 2026-11-19: the
  previous `url + body.slice(0, 200)` counts 1.
- **Candidates:** `grep -n "count(" src/content/*.ts`
- **Instances:**
  - 2026-11-19 Facebook/Instagram form bodies open with 200+ characters of session fields, so different
    story views within 30 s counted once. Checked: socket Seen (keyed on the read-mark time, `frames.ts`), WhatsApp
    (`to:id` of the node). Not checked: Google Chat keys on the first 300 characters of its receipt body, whose shape
    is not captured.
