// WhatsApp Web and Teams blocking in headless Chromium with the real extension: pnpm e2e
// The sites are faked with Playwright routes, so the real content scripts run on the real origins
// while nothing reaches WhatsApp or Microsoft. Shapes come from open-source clients
// (Baileys for WhatsApp nodes, purple-teams / Squads for Teams calls);
// none is captured from a live session yet.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extDir = fileURLToPath(new URL("../../dist/chrome", import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
const userDir = mkdtempSync(path.join(tmpdir(), "lurk-apps-e2e-"));
process.on("exit", () => rmSync(userDir, { recursive: true, force: true }));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
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

// Chrome silently drops a rule whose regex is over its memory limit; catch that here.
{
  const regexes = ["rules.json", "rules-typing.json"].flatMap((file) =>
    JSON.parse(readFileSync(path.join(extDir, file), "utf8"))
      .filter((rule) => rule.condition.regexFilter)
      .map((rule) => ({ file, id: rule.id, regex: rule.condition.regexFilter })),
  );
  const verdicts = await sw.evaluate(
    (list) =>
      Promise.all(
        list.map((r) => chrome.declarativeNetRequest.isRegexSupported({ regex: r.regex })),
      ),
    regexes,
  );
  const bad = regexes
    .map((rule, i) => ({ ...rule, ...verdicts[i] }))
    .filter((rule) => !rule.isSupported);
  check(`every regexFilter is accepted by Chrome (${regexes.length})`, bad.length === 0, bad);
}
const settle = () => wait(300);

const reached = [];
await ctx.route(
  /^https:\/\/(web\.whatsapp\.com|teams\.microsoft\.com|teams\.live\.com)\//,
  (route) => {
    const req = route.request();
    if (req.resourceType() === "document") {
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>t</title><p>fake",
      });
    }
    reached.push({ url: req.url(), method: req.method(), body: req.postData() || "" });
    return route.fulfill({ contentType: "application/json", body: '{"real":true}' });
  },
);

const pages = {};
async function open(origin) {
  if (pages[origin]) return pages[origin];
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check(`no page error on ${origin}`, false, String(e)));
  await page.goto(`${origin}/`);
  pages[origin] = page;
  return page;
}

// ---- WhatsApp: binary nodes, as Baileys encodes them -------------------------------------------
// Tokens: receipt 7, type 4, to 17, id 8, read 42, played 202, inactive 198, chatstate 46,
// composing 52, paused 154, media 55, audio 161, status 11, broadcast 13, s.whatsapp.net 3,
// message 19 (any non-receipt tag works for the pass-through check).
const STR = (s) => [252, s.length, ...Buffer.from(s)];
const JID = (user) => [250, ...STR(user), 3];
const STATUS = [250, 11, 13];
const node = (tag, attrs, children) => {
  const size = 1 + 2 * attrs.length + (children ? 1 : 0);
  return [
    248,
    size,
    tag,
    ...attrs.flat(),
    ...(children ? [248, children.length, ...children.flat()] : []),
  ];
};
const frame = (n) => [0, ...n];
const receipt = (type, to = JID("6591234567")) =>
  frame(
    node(7, [
      [8, ...STR("3EB0A1")],
      [17, ...to],
      [4, type],
    ]),
  );
const chatstate = (child) => frame(node(46, [[17, ...JID("6591234567")]], [child]));
const composing = node(52, []);
const recording = node(52, [[55, 161]]);
const message = frame([248, 4, 19, 17, ...JID("6591234567"), 252, 3, 7, 4, 42]); // content bytes look like a receipt

// Encrypts `bytes` in the page with AES-GCM through crypto.subtle (as WhatsApp does), then
// decrypts the result to see what would have gone out.
async function whatsappSends(bytes) {
  const page = await open("https://web.whatsapp.com");
  return page.evaluate(async (input) => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(input));
    return [...new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed))];
  }, bytes);
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const diff = (a, b) => a.map((x, i) => (x === b[i] ? null : [i, b[i], x])).filter(Boolean);

{
  let out = await whatsappSends(receipt(42));
  const d = diff(out, receipt(42));
  check(
    "WhatsApp read receipt: type read -> inactive, one byte, same length",
    d.length === 1 && d[0][1] === 42 && d[0][2] === 198 && out.length === receipt(42).length,
    d,
  );
  out = await whatsappSends(receipt(202));
  check("WhatsApp voice-note played receipt -> inactive", same(out, receipt(198)));
  out = await whatsappSends(receipt(42, STATUS));
  check(
    "WhatsApp status view (receipt to status@broadcast) -> inactive",
    same(out, receipt(198, STATUS)),
  );
  out = await whatsappSends(chatstate(composing));
  check("WhatsApp typing: composing -> paused", same(out, chatstate(node(154, []))));
  out = await whatsappSends(chatstate(recording));
  check(
    "WhatsApp recording (composing media=audio) -> paused",
    same(out, chatstate(node(154, [[55, 161]]))),
  );
  out = await whatsappSends(chatstate(node(154, [])));
  check("WhatsApp paused passes unchanged", same(out, chatstate(node(154, []))));
  out = await whatsappSends(receipt(198));
  check("WhatsApp delivery receipt passes unchanged", same(out, receipt(198)));
  out = await whatsappSends(message);
  check(
    "WhatsApp message whose content bytes look like a receipt passes unchanged",
    same(out, message),
  );
  const junk = [1, 2, 3, 248, 9, 7, 4, 42, 0, 0];
  out = await whatsappSends(junk);
  check("WhatsApp non-node data (handshake) passes unchanged", same(out, junk));
  const cbc = await (
    await open("https://web.whatsapp.com")
  ).evaluate(async (input) => {
    const key = await crypto.subtle.generateKey({ name: "AES-CBC", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const iv = new Uint8Array(16);
    const sealed = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new Uint8Array(input));
    return [...new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, sealed))];
  }, receipt(42));
  check("WhatsApp AES-CBC (message and media encryption) untouched", same(cbc, receipt(42)));

  await setLocal({ signals: { seen: false, stories: true, typing: true } });
  await settle();
  check(
    "WhatsApp seen off: read receipt passes",
    same(await whatsappSends(receipt(42)), receipt(42)),
  );
  check(
    "WhatsApp seen off: status view still hidden",
    same(await whatsappSends(receipt(42, STATUS)), receipt(198, STATUS)),
  );
  await setLocal({ signals: { seen: true, stories: false, typing: true } });
  await settle();
  check(
    "WhatsApp stories off: status view passes",
    same(await whatsappSends(receipt(42, STATUS)), receipt(42, STATUS)),
  );
  check(
    "WhatsApp stories off: read receipt still hidden",
    same(await whatsappSends(receipt(42)), receipt(198)),
  );
  await setLocal({ signals: { seen: true, stories: true, typing: false } });
  await settle();
  check(
    "WhatsApp typing off: composing passes",
    same(await whatsappSends(chatstate(composing)), chatstate(composing)),
  );
  await setLocal({ signals: { seen: true, stories: true, typing: true }, enabled: false });
  await settle();
  check(
    "WhatsApp master off: read receipt passes",
    same(await whatsappSends(receipt(42)), receipt(42)),
  );
  await setLocal({ enabled: true });
  await settle();
  check(
    "WhatsApp master on: read receipt hidden again",
    same(await whatsappSends(receipt(42)), receipt(198)),
  );

  // Comms stay on the page: WAWebCommsGating.isCommsInWorker is forced to false, by either route.
  const page = await open("https://web.whatsapp.com");
  const gating = await page.evaluate(async () => {
    const make = () => ({
      isCommsInWorker() {
        return "worker" === "worker"; // stands in for qex._("5241") === "worker" || … "worker_hrp"
      },
    });
    let chainedCalls = 0;
    window.__onAfterModuleFactory = () => chainedCalls++;
    const viaFactory = { exports: make() };
    window.__onAfterModuleFactory(viaFactory);
    const factory = { patched: viaFactory.exports.isCommsInWorker() === false, chainedCalls };
    return factory;
  });
  check(
    "WhatsApp comms gating via module factory hook: forced to the page, page's own hook still called",
    gating.patched && gating.chainedCalls === 1,
    gating,
  );
  const page2 = await ctx.newPage();
  await page2.addInitScript(() => {
    const gatingModule = {
      isCommsInWorker() {
        return "worker" === "worker";
      },
    };
    setTimeout(() => {
      window.require = (name) => (name === "WAWebCommsGating" ? gatingModule : undefined);
    }, 300);
    window.__gatingModule = gatingModule;
  });
  await page2.goto("https://web.whatsapp.com/?late");
  await wait(800);
  check(
    "WhatsApp comms gating via late window.require: forced to the page",
    await page2.evaluate(() => window.__gatingModule.isCommsInWorker() === false),
  );
  await page2.close();
}

// ---- Teams: read receipt (consumption horizon) and typing -------------------------------------------
const HORIZON = (host) =>
  `https://${host}/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc%40thread.v2/properties?name=consumptionhorizon`;
const MESSAGES = (host) =>
  `https://${host}/api/chatsvc/emea/v1/users/ME/conversations/19%3Aabc%40thread.v2/messages`;
// via: "fetch" (url + init), "request" (fetch(new Request(…)), body inside the Request) or "xhr".
async function teams(host, { url, method, body, xhr = false, via = xhr ? "xhr" : "fetch" }) {
  const page = await open(`https://${host}`);
  const before = reached.length;
  const res = await page.evaluate(
    ([u, m, b, v]) => {
      const headers = { "content-type": "application/json" };
      if (v === "fetch")
        return fetch(u, { method: m, body: b, headers }).then(async (r) => ({ status: r.status }));
      if (v === "request")
        return fetch(new Request(u, { method: m, body: b, headers })).then(async (r) => ({
          status: r.status,
        }));
      return new Promise((resolve) => {
        const req = new XMLHttpRequest();
        req.open(m, u);
        req.onload = () => resolve({ status: req.status });
        req.onerror = () => resolve({ status: -1 });
        req.send(b);
      });
    },
    [url, method, body, via],
  );
  await wait(150);
  return { ...res, reached: reached.length > before };
}
const typingBody = JSON.stringify({
  content: "",
  contenttype: "Application/Message",
  messagetype: "Control/Typing",
});
const clearBody = JSON.stringify({
  content: "",
  contenttype: "Application/Message",
  messagetype: "Control/ClearTyping",
});
const realMessage = JSON.stringify({
  content: 'look: "messagetype":"Control/Typing"',
  contenttype: "text",
  messagetype: "RichText/Html",
});
const horizonBody = JSON.stringify({ consumptionhorizon: "1763290000123;1763290000456;8812" });
{
  for (const host of ["teams.microsoft.com", "teams.live.com"]) {
    let r = await teams(host, { url: HORIZON(host), method: "PUT", body: horizonBody });
    check(
      `Teams read receipt (${host}, fetch PUT): never sent, fake 200`,
      !r.reached && r.status === 200,
      r,
    );
    r = await teams(host, { url: HORIZON(host), method: "PUT", body: horizonBody, xhr: true });
    check(
      `Teams read receipt (${host}, XHR PUT): never sent, load 200`,
      !r.reached && r.status === 200,
      r,
    );
  }
  const host = "teams.microsoft.com";
  let r = await teams(host, { url: HORIZON(host), method: "GET" });
  check("Teams reading the horizon (GET) passes", r.reached, r);
  r = await teams(host, {
    url: HORIZON(host).replace("consumptionhorizon", "favorite"),
    method: "PUT",
    body: "{}",
  });
  check("Teams other property PUT passes", r.reached, r);
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: typingBody });
  check("Teams typing message never sent", !r.reached && r.status === 200, r);
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: clearBody, xhr: true });
  check("Teams clear-typing message never sent (XHR)", !r.reached && r.status === 200, r);
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: realMessage });
  check("Teams real message quoting Control/Typing is sent", r.reached, r);
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: typingBody, via: "request" });
  check("Teams typing inside a Request object never sent", !r.reached && r.status === 200, r);
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: realMessage, via: "request" });
  const sentBody = reached.at(-1)?.body;
  check(
    "Teams real message inside a Request object is sent with its body intact",
    r.reached && sentBody === realMessage,
    { r, sentBody },
  );
  r = await teams(host, { url: HORIZON(host), method: "PUT", body: horizonBody, via: "request" });
  check("Teams read receipt inside a Request object never sent", !r.reached && r.status === 200, r);

  // Requests from a worker skip the page patch; the declarativeNetRequest rule still stops receipts.
  const page = await open(`https://${host}`);
  const workerResult = await page.evaluate(async (url) => {
    const src = `onmessage = async (e) => { try { await fetch(e.data, { method: "PUT", body: "{}" }); postMessage("sent"); } catch (err) { postMessage("blocked: " + err.message); } };`;
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    return new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(url);
    });
  }, HORIZON(host));
  check(
    "Teams read receipt from a worker blocked by the network rule",
    workerResult.startsWith("blocked"),
    workerResult,
  );

  await setLocal({ signals: { seen: false, stories: true, typing: true } });
  await settle();
  r = await teams(host, { url: HORIZON(host), method: "PUT", body: horizonBody });
  check("Teams seen off: read receipt sent", r.reached, r);
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: typingBody });
  check("Teams seen off: typing still hidden", !r.reached, r);
  await setLocal({ signals: { seen: true, stories: true, typing: false } });
  await settle();
  r = await teams(host, { url: MESSAGES(host), method: "POST", body: typingBody });
  check("Teams typing off: typing sent", r.reached, r);
  await setLocal({ signals: { seen: true, stories: true, typing: true } });
  await settle();
}

await ctx.close();
const passed = results.filter(Boolean).length;
console.log(
  passed === results.length
    ? `ALL PASS ${passed}/${results.length}`
    : `FAILED ${results.length - passed}/${results.length}`,
);
process.exitCode = passed === results.length ? 0 : 1;
