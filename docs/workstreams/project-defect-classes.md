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
