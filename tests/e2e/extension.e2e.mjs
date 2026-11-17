// End-to-end walk of the real extension in headless Chromium: npm run e2e
// Needs Playwright. PLAYWRIGHT = path to the playwright package (default: resolve "playwright");
// CHROME_BIN = Chromium/Chrome for Testing binary (default: Playwright's own).
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extDir = fileURLToPath(new URL("../../dist/chrome", import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
const userDir = mkdtempSync(path.join(tmpdir(), "lurk-e2e-"));
process.on("exit", () => rmSync(userDir, { recursive: true, force: true }));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
const errors = [];
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
};
const wait = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const swState = () =>
  sw.evaluate(async () => ({
    rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
    badge: await chrome.action.getBadgeText({}),
    title: await chrome.action.getTitle({}),
    local: await chrome.storage.local.get(null),
  }));

// Network probe: does a POST to the receipt endpoint get blocked by the extension?
const probe = await ctx.newPage();
probe.on("pageerror", (e) => errors.push(String(e)));
await probe.goto("about:blank");
// transport: "fetch" (resource type xmlhttprequest) or "beacon" (resource type ping).
const fires = async (url, transport = "fetch") => {
  const failed = new Promise((resolve) => {
    const onFail = (req) =>
      req.url() === url && (ctx.off("requestfailed", onFail), resolve(req.failure()?.errorText));
    ctx.on("requestfailed", onFail);
    setTimeout(() => (ctx.off("requestfailed", onFail), resolve("none")), 4000);
  });
  await probe.evaluate(
    ([u, t]) =>
      t === "beacon"
        ? navigator.sendBeacon(u, "x")
        : fetch(u, { method: "POST", mode: "no-cors", body: "x" }).catch(() => {}),
    [url, transport],
  );
  const err = await failed;
  return err !== "net::ERR_BLOCKED_BY_CLIENT";
};
const RECEIPT = "https://chat.google.com/u/0/api/mark_group_readstate?c=1";
const OTHER = "https://chat.google.com/u/0/api/get_group?c=1";

await wait(500);
check("fresh: receipt blocked on the wire", !(await fires(RECEIPT)));
check("fresh: receipt sent as a beacon is blocked", !(await fires(RECEIPT, "beacon")));
check("fresh: other Chat call goes out", await fires(OTHER));
check("fresh: other Chat beacon goes out", await fires(OTHER, "beacon"));

const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`chrome-extension://${id}/popup.html`);
await page.waitForTimeout(500);
// The popup was opened as a page, so it names no site; show it as if opened on Instagram.
await page.evaluate(() => renderSite("https://www.instagram.com/"));
await page.waitForTimeout(200);

check(
  "switch has a stable accessible name",
  (await page.getByRole("switch", { name: "Lurk mode", exact: true }).count()) === 1,
);
const desc = await page
  .locator("#enabled")
  .evaluate((el) => el.ariaDescribedByElements?.[0]?.id ?? el.getAttribute("aria-describedby"));
check("switch described by status", desc === "status", desc);

// Pause: real click, then the receipt must reach the network, then be blocked again after 10 s.
await page.locator("#pass").click();
await page.waitForTimeout(700);
check("pause: receipt goes out", await fires(RECEIPT));
const p = await swState();
check("pause: badge counts down", /^\d+s$/.test(p.badge), p.badge);
check(
  "pause: popup says letting through",
  (await page.locator("#status").textContent()).startsWith("Letting receipts through"),
);
check(
  "pause: button aria-disabled, keeps focus",
  (await page.locator("#pass").getAttribute("aria-disabled")) === "true" &&
    (await page.evaluate(() => document.activeElement?.id)) === "pass",
);
const before = (await sw.evaluate(() => chrome.storage.local.get("pauseUntil"))).pauseUntil;
// Playwright's click() waits for aria-disabled to clear, so press the real mouse on the box.
const box = await page.locator("#pass").boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
const after = (await sw.evaluate(() => chrome.storage.local.get("pauseUntil"))).pauseUntil;
check("pause: click while aria-disabled does not extend", before === after, { before, after });

// Switch off during the pause (same storage write the shortcut makes): pause must be dropped.
await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
await wait(700);
let s = await swState();
check(
  "off during pause: pause cleared, badge OFF",
  !("pauseUntil" in s.local) && s.badge === "OFF",
  s,
);
await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
await wait(700);
s = await swState();
check(
  "back on: blocking immediately, not paused",
  s.rulesets.includes("block_receipts") && s.badge === "",
  s,
);
check("back on: receipt blocked", !(await fires(RECEIPT)));

// Pause runs out on its own.
await page.locator("#pass").click();
await wait(11000);
s = await swState();
check(
  "pause expiry: blocking again",
  s.rulesets.includes("block_receipts") && s.badge === "" && !("pauseUntil" in s.local),
  s,
);
check("pause expiry: receipt blocked", !(await fires(RECEIPT)));
check(
  "pause expiry: popup back to On",
  (await page.locator("#status").textContent()) === "Hiding Seen, story views and typing",
);

// Keyboard: Shift+Tab from the button back through the three Hide boxes to the switch, Space toggles.
await page.bringToFront();
await page.locator("#pass").focus();
const tabStops = [];
for (let i = 0; i < 4; i++) {
  await page.keyboard.press("Shift+Tab");
  tabStops.push(
    await page.evaluate(() => document.activeElement?.id || document.activeElement?.dataset.signal),
  );
}
check(
  "keyboard: tab order button -> story views, typing, seen -> switch",
  tabStops.join() === "stories,typing,seen,enabled",
  tabStops,
);
const focused = tabStops.at(-1);
await page.keyboard.press("Space");
await wait(700);
s = await swState();
check(
  "keyboard: Space on switch turns off",
  focused === "enabled" && s.local.enabled === false && s.badge === "OFF",
  { focused, s },
);
check("off: receipt goes out", await fires(RECEIPT));
await page.keyboard.press("Space");
await wait(700);

// Rapid clicks: 9 real clicks, final state must match the switch.
for (let i = 0; i < 9; i++) await page.locator("#enabled").click();
await wait(1500);
s = await swState();
const checked = await page.locator("#enabled").isChecked();
check(
  "rapid 9 clicks: worker, storage and switch agree (off)",
  checked === false &&
    s.local.enabled === false &&
    !s.rulesets.includes("block_receipts") &&
    s.badge === "OFF",
  { checked, s },
);
await page.locator("#enabled").click();
await wait(700);
s = await swState();
check("final on", s.rulesets.includes("block_receipts") && s.badge === "");

check("no console/page errors", errors.length === 0, errors);
await ctx.close();
console.log(
  results.every(Boolean) ? "ALL PASS" : "SOME FAIL",
  `${results.filter(Boolean).length}/${results.length}`,
);
process.exitCode = results.every(Boolean) ? 0 : 1;
