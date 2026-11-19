// The Firefox build (dist/firefox) in headless Firefox: pnpm e2e:firefox
// Needs puppeteer-core (PUPPETEER=<path to the package> if it is not installed here) and a Firefox
// Developer Edition or Nightly binary (FIREFOX_BIN=<path>), which load an unsigned build. Run
// `node scripts/build.mjs firefox` first; pnpm e2e:firefox does.
// The sites are faked with request interception, so the real content scripts run on real origins
// while nothing reaches Meta, WhatsApp or Google.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const xpi = fileURLToPath(new URL("../../dist/lurk-firefox.zip", import.meta.url));
const puppeteer = createRequire(import.meta.url)(process.env.PUPPETEER || "puppeteer-core");
const ID = "lurk@botjaeger";
const UUID = "2f7c1b0e-4a5d-4c3e-9b8a-1d2e3f4a5b6c"; // fixed so the test knows the popup's address
const POPUP = `moz-extension://${UUID}/popup.html`;
// WebDriver BiDi will not navigate to extension pages, so the build is installed the way a user's
// profile holds it (unsigned: Firefox Developer Edition or Nightly) and Firefox starts on the popup.
const profile = mkdtempSync(path.join(tmpdir(), "lurk-firefox-e2e-"));
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
mkdirSync(path.join(profile, "extensions"));
copyFileSync(xpi, path.join(profile, "extensions", `${ID}.xpi`));
const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: process.env.FIREFOX_BIN,
  headless: true,
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" }, // Firefox 161+ reads this instead of the flag below
  userDataDir: profile,
  // -remote-allow-system-access: the popup is a privileged page; scripts in it need this. Newer Firefox
  // builds (161) drop the first start-up URL, so a blank page goes first and the popup second.
  args: ["-remote-allow-system-access", "about:blank", POPUP],
  extraPrefsFirefox: {
    "extensions.webextensions.uuids": JSON.stringify({ [ID]: UUID }),
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
  },
});
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
};
const wait = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

try {
  // ---- Extension page: background state, storage, popup ------------------------------------------
  let ext;
  for (let i = 0; i < 40 && !ext; i++) {
    ext = (await browser.pages()).find((p) => p.url() === POPUP);
    if (!ext) await wait(250);
  }
  check(
    "Firefox loads the build and opens its popup page",
    Boolean(ext),
    (await browser.pages()).map((p) => p.url()),
  );
  const extErrors = [];
  ext.on("pageerror", (e) => extErrors.push(String(e)));
  await wait(1500);
  const bg = () =>
    ext.evaluate(async () => ({
      rulesets: (await chrome.declarativeNetRequest.getEnabledRulesets()).sort(),
      badge: await chrome.action.getBadgeText({}),
      local: await chrome.storage.local.get(null),
    }));
  const setLocal = (values) => ext.evaluate((v) => chrome.storage.local.set(v), values);
  let s = await bg();
  check(
    "background ran: both rulesets on, no badge",
    s.rulesets.join() === "block_receipts,block_typing" && s.badge === "",
    s,
  );
  await ext.evaluate(() => renderSite("https://www.instagram.com/"));
  await wait(200);
  const popupText = await ext.evaluate(() => [
    document.getElementById("site-heading").textContent,
    document.getElementById("status").textContent,
  ]);
  check(
    "popup renders: Hide on Instagram, hiding all three",
    popupText.join(" | ") === "Hide on Instagram | Hiding Seen, story views and typing",
    popupText,
  );

  // ---- Fake sites --------------------------------------------------------------------------------
  const reached = [];
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isNavigationRequest()) {
      return req.respond({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>t</title><p>fake",
      });
    }
    reached.push(req.url());
    return req.respond({ status: 200, contentType: "application/json", body: '{"real":true}' });
  });
  const post = async (url, form) => {
    const before = reached.length;
    const result = await page.evaluate(
      ([u, f]) => {
        const body = new FormData();
        for (const [k, v] of Object.entries(f)) body.append(k, v);
        return fetch(u, { method: "POST", body }).then(
          async (r) => ({ status: r.status, text: await r.text() }),
          (e) => ({ status: -1, text: String(e) }),
        );
      },
      [url, form],
    );
    await wait(200);
    return { ...result, reached: reached.length > before };
  };

  // Facebook: page script (MAIN world) + bridge (isolated world) + background counts.
  const FB = "https://www.facebook.com";
  const STORY = { fb_api_req_friendly_name: "storiesUpdateSeenStateMutation", doc_id: "1" };
  await page.goto(`${FB}/`);
  await wait(500);
  let r = await post(`${FB}/api/graphql/`, STORY);
  check("Facebook story view: never sent, fake 200", !r.reached && r.status === 200, r);
  r = await post(`${FB}/api/graphql/`, {
    fb_api_req_friendly_name: "CometNewsFeedPaginationQuery",
  });
  check("Facebook feed query: reaches the server", r.reached && r.text.includes("real"), r);
  await wait(300);
  s = await bg();
  check(
    "Stats: the blocked story view is counted for Facebook",
    s.local.stats?.sites?.meta?.stories === 1,
    s.local.stats,
  );

  await setLocal({ signals: { seen: true, stories: false, typing: true } });
  await wait(400);
  check(
    "Story views switched off: story view sent",
    (await post(`${FB}/api/graphql/`, STORY)).reached,
  );
  await setLocal({ signals: { seen: true, stories: true, typing: true } });
  await wait(400);
  check("Story views back on: blocked again", !(await post(`${FB}/api/graphql/`, STORY)).reached);

  // Pass-through: the popup's button asks the background script, which starts a 10 s pause.
  // Firefox refuses input actions on the privileged popup page; Chromium suites click for real.
  await ext.evaluate(() => document.getElementById("pass").click());
  await wait(600);
  s = await bg();
  check(
    "popup button: background starts a 10 s pause",
    s.local.pauseUntil - Date.now() > 8000 && s.local.pauseUntil - Date.now() <= 10_000,
    s.local.pauseUntil - Date.now(),
  );
  // Page scripts and network rules both let receipts out, then block again (shortened to 3 s).
  await setLocal({ pauseUntil: Date.now() + 3000 });
  await wait(600);
  s = await bg();
  check("pause: story view sent", (await post(`${FB}/api/graphql/`, STORY)).reached);
  check(
    "pause: rulesets off, badge counts down",
    s.rulesets.length === 0 && /^[1-3]s$/.test(s.badge),
    s,
  );
  await wait(3200);
  s = await bg();
  check(
    "pause over: rulesets back, badge clear, pause removed",
    s.rulesets.length === 2 && s.badge === "" && !("pauseUntil" in s.local),
    s,
  );
  check("pause over: story view blocked again", !(await post(`${FB}/api/graphql/`, STORY)).reached);

  // WhatsApp: the read receipt is rewritten just before AES-GCM encryption.
  await page.goto("https://web.whatsapp.com/");
  await wait(500);
  const STR = (t) => [252, t.length, ...Buffer.from(t)];
  const receipt = (type) => [
    0,
    248,
    7,
    7,
    8,
    ...STR("3EB0A1"),
    17,
    250,
    ...STR("6591234567"),
    3,
    4,
    type,
  ];
  const sends = (bytes) =>
    page.evaluate(async (input) => {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const iv = new Uint8Array(12);
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new Uint8Array(input),
      );
      return [...new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed))];
    }, bytes);
  const out = await sends(receipt(42));
  check("WhatsApp read receipt -> delivery receipt", out.join() === receipt(198).join(), out);

  // Google Chat: the network rule blocks the receipt; other calls pass. (Firefox reports the request
  // to the test before its network rules run, so "blocked" is the page's fetch failing.)
  await page.goto("https://chat.google.com/u/0/");
  await wait(500);
  const RECEIPT = "https://chat.google.com/u/0/api/mark_group_readstate?c=1";
  r = await post(RECEIPT, { a: "1" });
  check("Google Chat receipt blocked by the network rule", r.status === -1, r);
  r = await post("https://chat.google.com/u/0/api/get_group?c=1", { a: "1" });
  check("Google Chat other call passes", r.reached && r.status === 200, r);
  await setLocal({ signals: { seen: false, stories: true, typing: true } });
  await wait(600);
  r = await post(RECEIPT, { a: "1" });
  check("Seen switched off: Google Chat receipt goes through", r.status === 200, r);
  await setLocal({ signals: { seen: true, stories: true, typing: true } });

  // Reset stats: two clicks in the popup; the background script clears the counts.
  await ext.evaluate(() => (document.querySelector("details.stats").open = true));
  await wait(200);
  await ext.evaluate(() => document.getElementById("reset-stats").click());
  await ext.evaluate(() => document.getElementById("reset-stats").click());
  await wait(600);
  s = await bg();
  check(
    "popup Reset stats: background clears the counts",
    Object.keys(s.local.stats?.sites ?? { x: 1 }).length === 0,
    s.local.stats,
  );

  check("no page errors", pageErrors.length === 0 && extErrors.length === 0, [
    ...pageErrors,
    ...extErrors,
  ]);
} catch (error) {
  check("run finished", false, String(error?.stack || error));
} finally {
  await browser.close();
}
console.log(
  results.every(Boolean) ? "ALL PASS" : "SOME FAIL",
  `${results.filter(Boolean).length}/${results.length}`,
);
process.exit(results.every(Boolean) ? 0 : 1);
