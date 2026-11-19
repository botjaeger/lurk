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

## AUD-002 — Any workflow in the repository can sign in as the store's service account

- **Status:** OPEN (needs the owner's decision: the provider is shared with botjaeger/brainrot and lives in
  the Google Cloud project `cws-publisher-094189`)
- **Trigger:** a workflow file on any branch of `botjaeger/lurk` or `botjaeger/brainrot` that asks for
  `id-token: write` and runs `google-github-actions/auth` with the same provider and service account.
- **Expected:** only the release workflow's `chrome` job, on a `v*` tag, in the `chrome-web-store`
  environment, gets a Chrome Web Store token.
- **Actual:** the `botjaeger` provider's condition is `assertion.repository in ['botjaeger/lurk',
  'botjaeger/brainrot']` and the `roles/iam.workloadIdentityUser` bindings are per repository, so any
  branch or workflow in either repository is admitted. Pull requests from forks get no `id-token`, so
  only someone with push access can use it.
- **Evidence:** `gcloud iam workload-identity-pools providers describe botjaeger --project=cws-publisher-094189
  --location=global --workload-identity-pool=github` (read 2026-11-19).
- **Correction direction:** narrow the condition, e.g. `assertion.repository in [...] &&
  assertion.environment == 'chrome-web-store' && assertion.ref.startsWith('refs/tags/v')`, and give the
  `chrome-web-store` environment in both repositories a deployment rule that allows only `v*` tags.
- **Acceptance:** a test workflow on a branch fails at the sign-in step; the next tagged release of each
  extension still signs in and uploads.
