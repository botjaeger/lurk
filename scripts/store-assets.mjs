// Chrome Web Store images, from the real popup: pnpm store-assets
// Loads dist/chrome in headless Chromium, shows the popup in a few states, and lays each one out on a
// 1280x800 screenshot (JPEG: the store wants no alpha). Also writes the 440x280 small promo tile and
// copies the store icon (icons/store-icon-128.png, from pnpm icons). Output: dist/store/. Needs CHROME_BIN (a Chromium that loads extensions, as for e2e) and
// the website's packages (pnpm install) for the display font.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const extDir = path.join(root, "dist/chrome");
const out = path.join(root, "dist/store");
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");

const font = readFileSync(
  path.join(
    root,
    "site/node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
  ),
).toString("base64");
const iconSvg = readFileSync(path.join(root, "icons/icon.svg"), "utf8");
const dataUri = (type, buf) => `data:${type};base64,${Buffer.from(buf).toString("base64")}`;

const userDir = mkdtempSync(path.join(tmpdir(), "lurk-store-"));
process.on("exit", () => rmSync(userDir, { recursive: true, force: true }));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_BIN,
  headless: true,
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
// eslint-disable-next-line no-undef -- runs in the extension's worker
const setLocal = (values) => sw.evaluate((v) => chrome.storage.local.set(v), values);

const errors = [];
const popup = await ctx.newPage();
popup.on("pageerror", (e) => errors.push(String(e)));
popup.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const DAY = 24 * 60 * 60 * 1000;
const STATS = {
  since: Date.now() - 12 * DAY,
  sites: {
    gchat: { seen: 41, stories: 0, typing: 17 },
    meta: { seen: 128, stories: 23, typing: 64 },
    instagram: { seen: 57, stories: 89, typing: 22 },
    whatsapp: { seen: 203, stories: 46, typing: 91 },
    teams: { seen: 36, stories: 0, typing: 12 },
  },
};

// One popup state -> PNG of the popup, at 2x.
// pauseSeconds starts "Let receipts through" as the shot is taken, so the countdown reads as just clicked.
async function shot({ url, theme, local, stats = false, pauseSeconds = 0 }) {
  await setLocal({
    enabled: true,
    signals: { seen: true, stories: true, typing: true },
    pauseUntil: pauseSeconds ? Date.now() + pauseSeconds * 1000 - 300 : 0,
    stats: STATS,
    theme,
    ...local,
  });
  await popup.setViewportSize({ width: 360, height: 900 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.evaluate((u) => globalThis.renderSite(u), url);
  if (stats) await popup.getByText("Stats", { exact: true }).click();
  await popup.waitForTimeout(400);
  const main = popup.locator("main");
  return { png: await main.screenshot(), box: await main.boundingBox() };
}

const SHOTS = [
  {
    file: "screenshot-1-messenger.jpg",
    title: "Read it.<br>Nobody knows.",
    text: "Lurk hides Seen, typing and story views in the chat apps you use on the web.",
    popup: { url: "https://www.messenger.com/t/1", theme: "dark" },
  },
  {
    file: "screenshot-2-switches.jpg",
    title: "Hide only what<br>you want hidden",
    text: "A switch each for Seen, typing and story views. Here WhatsApp still shows you typing, and hides the rest.",
    popup: {
      url: "https://web.whatsapp.com/",
      theme: "light",
      local: { signals: { seen: true, stories: true, typing: false } },
    },
  },
  {
    file: "screenshot-3-pass.jpg",
    title: "Want them<br>to know?",
    text: "Let receipts through for 10 seconds, reopen the chat, and Lurk turns itself back on.",
    popup: {
      url: "https://www.instagram.com/direct/inbox/",
      theme: "dark",
      pauseSeconds: 10,
    },
  },
  {
    file: "screenshot-4-stats.jpg",
    title: "See what<br>stayed quiet",
    text: "Stats count what Lurk hid on each app. Kept in your browser only: no account, no servers, nothing collected.",
    popup: { url: "https://chat.google.com/", theme: "light", stats: true },
  },
];

const css = `
@font-face { font-family: Bricolage; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 200 800; }
* { margin: 0; box-sizing: border-box; }
body { background: #0b0c0b; color: #eef1ec; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1, .brand { font-family: Bricolage, system-ui, sans-serif; letter-spacing: -0.02em; }
`;

const canvas = await ctx.newPage();
canvas.on("pageerror", (e) => errors.push(String(e)));

async function render(width, height, body, file, type = "jpeg") {
  await canvas.setViewportSize({ width, height });
  await canvas.setContent(`<!doctype html><style>${css}</style>${body}`);
  // eslint-disable-next-line no-undef -- runs in the page
  await canvas.evaluate(() => document.fonts.ready);
  const target = path.join(out, file);
  // scale "css": the context renders at 2x for a sharp popup, but the store wants exact pixel sizes.
  await canvas.screenshot({ path: target, type, quality: 92, scale: "css" });
  console.log("wrote", path.relative(root, target));
}

for (const s of SHOTS) {
  const {
    png,
    box: { width, height },
  } = await shot(s.popup);
  // The popup is scaled to fit 680 px of height, centred in the right half.
  const scale = Math.min(1.5, 680 / height);
  await render(
    1280,
    800,
    `<div style="position:absolute;inset:0;background:radial-gradient(900px 600px at 85% 50%, rgba(31,213,102,.16), transparent 70%)"></div>
     <div style="position:absolute;left:96px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center;gap:28px">
       <div style="display:flex;align-items:center;gap:14px">
         <img src="${dataUri("image/svg+xml", iconSvg)}" width="48" height="48" alt="">
         <span class="brand" style="font-size:30px;font-weight:700">Lurk</span>
       </div>
       <h1 style="font-size:68px;line-height:1.02;font-weight:750">${s.title}</h1>
       <p style="font-size:24px;line-height:1.45;color:#c9cfc8;max-width:520px">${s.text}</p>
     </div>
     <img src="${dataUri("image/png", png)}" alt="" style="position:absolute;left:${
       960 - (width * scale) / 2
     }px;top:${400 - (height * scale) / 2}px;width:${width * scale}px;height:${
       height * scale
     }px;border-radius:${16 * scale}px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(238,241,236,.12)">`,
    s.file,
  );
}

// Store icon, drawn by scripts/make-icons.mjs.
copyFileSync(path.join(root, "icons/store-icon-128.png"), path.join(out, "store-icon-128.png"));
console.log("wrote dist/store/store-icon-128.png");

// Small promo tile, 440x280.
await render(
  440,
  280,
  `<div style="position:absolute;inset:0;background:radial-gradient(360px 240px at 80% 30%, rgba(31,213,102,.22), transparent 70%)"></div>
   <div style="position:absolute;inset:0;padding:40px;display:flex;flex-direction:column;justify-content:center;gap:16px">
     <div style="display:flex;align-items:center;gap:14px">
       <img src="${dataUri("image/svg+xml", iconSvg)}" width="64" height="64" alt="">
       <span class="brand" style="font-size:46px;font-weight:750">Lurk</span>
     </div>
     <h1 style="font-size:30px;line-height:1.1;font-weight:700">Read it. Nobody knows.</h1>
     <p style="font-size:16px;color:#c9cfc8">Hides Seen, typing and story views.</p>
   </div>`,
  "promo-small-440x280.jpg",
);

await ctx.close();
if (errors.length) {
  console.error("page errors:", errors);
  process.exit(1);
}
