// Stats in headless Chromium with the real extension: npm run e2e
// Each blocked signal is counted once per read / story / typing burst, per app, only while that
// signal is being hidden, and shown in the popup's Stats with a two-step reset. Sites are faked with
// Playwright routes (as in social.e2e.mjs and apps.e2e.mjs).
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extDir = fileURLToPath(new URL("../../dist/chrome", import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
const userDir = mkdtempSync(path.join(tmpdir(), "lurk-stats-e2e-"));
process.on("exit", () => rmSync(userDir, { recursive: true, force: true }));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
};
const wait = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const setLocal = (values) => sw.evaluate((v) => chrome.storage.local.set(v), values);
const stats = async () =>
  (await sw.evaluate(() => chrome.storage.local.get("stats"))).stats?.sites || {};
const n = async (site, kind) => (await stats())[site]?.[kind] || 0;

await ctx.route(
  /^https:\/\/(www\.facebook\.com|www\.instagram\.com|web\.whatsapp\.com|teams\.microsoft\.com|chat\.google\.com)\//,
  (route) =>
    route.request().resourceType() === "document"
      ? route.fulfill({ contentType: "text/html", body: "<!doctype html><p>fake" })
      : route.fulfill({ contentType: "application/json", body: "{}" }),
);
await ctx.routeWebSocket(/edge-chat/, () => {});

const pages = {};
async function open(origin, wsUrl) {
  if (pages[origin]) return pages[origin];
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check(`no page error on ${origin}`, false, String(e)));
  await page.goto(`${origin}/`);
  if (wsUrl) {
    await page.evaluate(
      (u) =>
        new Promise((resolve) => {
          window.__ws = new WebSocket(u);
          window.__ws.binaryType = "arraybuffer";
          window.__ws.onopen = resolve;
        }),
      wsUrl,
    );
  }
  pages[origin] = page;
  return page;
}
const FB = "https://www.facebook.com";
const IG = "https://www.instagram.com";
const WA = "https://web.whatsapp.com";
const TEAMS = "https://teams.microsoft.com";
const GCHAT = "https://chat.google.com";
const send = async (origin, frame) => {
  const page = await open(origin, "wss://edge-chat.facebook.com/chat");
  await page.evaluate((f) => window.__ws.send(f), frame);
};
const settle = () => wait(400);

const typing = JSON.stringify({
  payload: JSON.stringify({ label: "3", payload: JSON.stringify({ thread_key: 1, is_typing: 1 }) }),
  type: 4,
});
const markRead = (ts) =>
  JSON.stringify({
    payload: JSON.stringify({
      tasks: [
        { label: "21", payload: JSON.stringify({ thread_id: 7, last_read_watermark_ts: ts }) },
      ],
    }),
    type: 3,
  });

// WhatsApp nodes (see apps.e2e.mjs for the token numbers).
const STR = (s) => [252, s.length, ...Buffer.from(s)];
const node = (tag, attrs, children) => [
  248,
  1 + 2 * attrs.length + (children ? 1 : 0),
  tag,
  ...attrs.flat(),
  ...(children ? [248, children.length, ...children.flat()] : []),
];
const receipt = (msgId, to = [250, ...STR("659"), 3]) => [
  0,
  ...node(7, [
    [8, ...STR(msgId)],
    [17, ...to],
    [4, 42],
  ]),
];
const composing = [0, ...node(46, [[17, 250, ...STR("659"), 3]], [node(52, [])])];
const waSend = async (bytes) =>
  (await open(WA)).evaluate(async (input) => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
    ]);
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      key,
      new Uint8Array(input),
    );
  }, bytes);

const post = async (origin, url, init) =>
  (await open(origin)).evaluate(
    ([u, i]) =>
      fetch(u, i)
        .catch(() => null)
        .then(() => true),
    [url, init],
  );

// ---- Counting -------------------------------------------------------------------------------------
{
  for (let i = 0; i < 4; i++) await send(FB, typing);
  await settle();
  check(
    "Facebook: four typing frames in one burst count as 1",
    (await n("meta", "typing")) === 1,
    await stats(),
  );

  await send(FB, markRead(1763290000123));
  await send(FB, markRead(1763290000123));
  await settle();
  check("Facebook: the same read sent twice counts as 1", (await n("meta", "seen")) === 1);
  await send(FB, markRead(1763290009999));
  await settle();
  check("Facebook: a second chat read counts as 2", (await n("meta", "seen")) === 2);

  const storyBody = new URLSearchParams({
    fb_api_req_friendly_name: "PolarisStoriesV3SeenMutation",
    variables: '{"reelId":"1"}',
  }).toString();
  await post(IG, `${IG}/api/graphql`, {
    method: "POST",
    body: storyBody,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  await settle();
  check(
    "Instagram: a story view counts under Instagram, not Facebook",
    (await n("instagram", "stories")) === 1 && (await n("meta", "stories")) === 0,
    await stats(),
  );

  await waSend(receipt("A1"));
  await waSend(receipt("A1"));
  await waSend(receipt("B2"));
  await waSend(receipt("S1", [250, 11, 13]));
  await waSend(composing);
  await waSend(composing);
  await settle();
  const wa = (await stats()).whatsapp || {};
  check(
    "WhatsApp: 2 reads (one resent), 1 status view, 1 typing burst",
    wa.seen === 2 && wa.stories === 1 && wa.typing === 1,
    wa,
  );

  await post(
    TEAMS,
    `${TEAMS}/api/chatsvc/emea/v1/users/ME/conversations/19%3Aa/properties?name=consumptionhorizon`,
    { method: "PUT", body: '{"consumptionhorizon":"1;2;3"}' },
  );
  await post(TEAMS, `${TEAMS}/api/chatsvc/emea/v1/users/ME/conversations/19%3Aa/messages`, {
    method: "POST",
    body: '{"content":"","messagetype":"Control/Typing"}',
  });
  await settle();
  check(
    "Teams: read receipt and typing counted",
    (await n("teams", "seen")) === 1 && (await n("teams", "typing")) === 1,
    (await stats()).teams,
  );

  // Google Chat: the network rule blocks it; the page script counts it, retries once.
  for (let i = 0; i < 5; i++) {
    await post(GCHAT, `${GCHAT}/u/0/api/mark_group_readstate?c=${10 + i}`, {
      method: "POST",
      body: '[["dm/abc"],1763290000]',
    });
  }
  await post(GCHAT, `${GCHAT}/u/0/_/DynamiteWebUi/data/batchexecute?rpcids=uQwtvc&rt=c`, {
    method: "POST",
    body: "f.req=x",
  });
  await post(GCHAT, `${GCHAT}/u/0/_/DynamiteWebUi/data/batchexecute?rpcids=qL7xZc&rt=c`, {
    method: "POST",
    body: "f.req=y",
  });
  await settle();
  const gc = (await stats()).gchat || {};
  check(
    "Google Chat: five retries of one receipt count as 1; typing as 1; other calls not counted",
    gc.seen === 1 && gc.typing === 1 && !gc.stories,
    gc,
  );

  // Several apps at once: nothing lost.
  await Promise.all([
    send(FB, markRead(1763290005555)),
    waSend(receipt("C3")),
    post(TEAMS, `${TEAMS}/api/chatsvc/emea/v1/users/ME/conversations/19%3Aa/messages`, {
      method: "POST",
      body: '{"content":"","messagetype":"Control/Typing"}',
    }),
  ]);
  await wait(600);
  const now = await stats();
  check(
    "simultaneous counts from three tabs all land",
    now.meta.seen === 3 && now.whatsapp.seen === 3 && now.teams.typing === 1,
    now,
  );
}

// ---- Not counted when that signal is not being hidden ---------------------------------------------
{
  await setLocal({ signals: { seen: false, stories: true, typing: true } });
  await settle();
  await send(FB, markRead(1763299999999));
  await waSend(receipt("D4"));
  await settle();
  check(
    "Seen unticked: reads not counted",
    (await n("meta", "seen")) === 3 && (await n("whatsapp", "seen")) === 3,
  );

  await setLocal({ signals: { seen: true, stories: true, typing: true }, enabled: false });
  await settle();
  await send(FB, markRead(1763288888888));
  await post(GCHAT, `${GCHAT}/u/0/api/mark_group_readstate?c=99`, {
    method: "POST",
    body: '[["dm/zzz"],1]',
  });
  await settle();
  check(
    "switched off: nothing counted, Google Chat included",
    (await n("meta", "seen")) === 3 && (await n("gchat", "seen")) === 1,
  );
  await setLocal({ enabled: true });
  await settle();

  // A page can only add to its own app, and only a signal that app has.
  await (
    await open(TEAMS)
  ).evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("lurk:count", { detail: '{"kind":"stories","key":"x"}' }),
    ),
  );
  await (
    await open(TEAMS)
  ).evaluate(() =>
    document.dispatchEvent(new CustomEvent("lurk:count", { detail: '{"kind":"bogus"}' })),
  );
  await settle();
  const tm = (await stats()).teams;
  check(
    "Teams page claiming a story view (Teams has none) or a bogus kind is ignored",
    !tm.stories && Object.keys(tm).sort().join() === "seen,stories,typing",
    tm,
  );
}

// ---- Popup ----------------------------------------------------------------------------------------
{
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await wait(400);
  await popup.getByText("Stats", { exact: true }).click();
  const total = await popup.locator("#stats-total").textContent();
  check(
    "popup: total names every kind",
    /Hidden since .+: 8 Seen, 2 story views and 4 typing/.test(total),
    total,
  );
  const rows = await popup.$$eval("#stats-list li", (els) =>
    els.map((li) => li.innerText.replace(/\s+/g, " ")),
  );
  check(
    "popup: one row per app with counts, in the popup's app order",
    rows.join(" | ") ===
      "Google Chat 1 Seen and 1 typing | Facebook and Messenger 3 Seen and 1 typing | Instagram 1 story view | WhatsApp 3 Seen, 1 story view and 1 typing | Teams 1 Seen and 1 typing",
    rows,
  );
  await sw.evaluate(() =>
    chrome.storage.local.get("stats").then(({ stats }) => {
      stats.sites.teams.typing = 2;
      return chrome.storage.local.set({ stats });
    }),
  );
  await wait(300);
  check(
    "popup: updates live while open",
    (await popup.locator("#stats-list").innerText()).includes("2 typing"),
  );

  await popup.getByRole("button", { name: "Reset stats" }).click();
  await wait(4300);
  check(
    "popup: an armed reset disarms by itself",
    (await popup.getByRole("button", { name: "Reset stats" }).count()) === 1 &&
      (await n("meta", "seen")) === 3,
  );
  await popup.getByRole("button", { name: "Reset stats" }).click();
  await wait(200);
  check(
    "popup: first Reset click only asks",
    (await popup.getByRole("button", { name: "Click again to reset" }).count()) === 1 &&
      (await n("meta", "seen")) === 3,
  );
  await popup.getByRole("button", { name: "Click again to reset" }).click();
  await wait(300);
  const after = {
    total: await popup.locator("#stats-total").textContent(),
    rows: await popup.locator("#stats-list li").count(),
    resetShown: await popup.locator("#reset-stats").isVisible(),
    stored: await stats(),
  };
  check(
    "popup: second click clears; Reset hides when there is nothing to reset",
    after.total === "Nothing hidden yet. Open a chat on a supported app." &&
      after.rows === 0 &&
      !after.resetShown &&
      Object.keys(after.stored).length === 0,
    after,
  );

  await popup.getByText("Stats", { exact: true }).focus();
  await popup.keyboard.press("Enter");
  check(
    "popup: Stats closes from the keyboard",
    !(await popup.locator("details.stats").evaluate((d) => d.open)),
  );
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  check(
    "a stats write does not re-apply the rules (rulesets unchanged)",
    rules.sort().join() === "block_receipts,block_typing",
    rules,
  );
}

await ctx.close();
const passed = results.filter(Boolean).length;
console.log(
  passed === results.length
    ? `ALL PASS ${passed}/${results.length}`
    : `FAILED ${results.length - passed}/${results.length}`,
);
process.exitCode = passed === results.length ? 0 : 1;
