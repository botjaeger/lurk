# Lurk website

Marketing site for [Lurk](..), the browser extension that hides Seen, story views and typing.
Static, three pages (home, privacy policy, terms), built with Vite. No analytics, no cookies, fonts
self-hosted.

```sh
npm install
npm run dev        # local server with reload
npm run check      # typecheck + production build
npm run build      # site/dist/ (on a push to main, ../.github/workflows/pages.yml publishes it to GitHub Pages)
```

On each extension release, update `src/release.ts`: each store's `state: "live"` and
`url` once its listing is public. Until then the install buttons lead to the "Get Lurk" section, which
says each listing is coming.

The privacy policy (`privacy.html`) describes what the extension stores and why it needs each
permission; keep it in step with `../manifest.json`. The version shown in the footer is read from that manifest.

Licence: MIT, see [../LICENSE](../LICENSE).
