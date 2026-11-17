// Browser restarts keep the user's choice, and a pause never survives one: npm run e2e
// Same env as extension.e2e.mjs (PLAYWRIGHT, CHROME_BIN).
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extDir = fileURLToPath(new URL("../../dist/chrome", import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
const userDir = mkdtempSync(path.join(tmpdir(), "lurk-restart-"));
process.on("exit", () => rmSync(userDir, { recursive: true, force: true }));

const wait = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const launch = () =>
  chromium.launchPersistentContext(userDir, {
    executablePath: process.env.CHROME_BIN,
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
const worker = async (ctx) => ctx.serviceWorkers()[0] || ctx.waitForEvent("serviceworker");
const state = (sw) =>
  sw.evaluate(async () => ({
    blocking: (await chrome.declarativeNetRequest.getEnabledRulesets()).includes("block_receipts"),
    badge: await chrome.action.getBadgeText({}),
  }));
const results = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(actual));
};

let ctx = await launch();
let sw = await worker(ctx);
await wait(500);
check("fresh install blocks", await state(sw), { blocking: true, badge: "" });
await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
await sw.evaluate(() => chrome.storage.local.set({ pauseUntil: Date.now() + 10000 }));
await wait(500);
check("paused", await state(sw), { blocking: false, badge: "10s" });
await ctx.close();

ctx = await launch();
sw = await worker(ctx);
await wait(1000);
// The pause is kept in local storage, so this guards the worker's startup check (session "running"
// mark), which drops a pause left from before the restart. "off stays off" below guards the startup sync.
check("restart mid-pause comes back blocking", await state(sw), { blocking: true, badge: "" });
await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
await wait(500);
await ctx.close();

ctx = await launch();
sw = await worker(ctx);
await wait(1000);
check("off stays off after restart", await state(sw), { blocking: false, badge: "OFF" });
await ctx.close();

console.log(
  results.every(Boolean) ? "ALL PASS" : "SOME FAIL",
  `${results.filter(Boolean).length}/${results.length}`,
);
process.exitCode = results.every(Boolean) ? 0 : 1;
