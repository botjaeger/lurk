// Facebook / Messenger / Instagram blocking in headless Chromium with the real extension: pnpm e2e
// The sites are faked with Playwright routes (pages, GraphQL endpoints and the chat WebSocket), so the
// real content scripts run on real origins while nothing reaches Meta.
// Frame shapes follow mautrix/meta (task labels "3" typing, "21" mark read) and Carrier's Lightspeed
// parser; they are not captured from a live session.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extDir = fileURLToPath(new URL("../../dist/chrome", import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || "playwright");
const userDir = mkdtempSync(path.join(tmpdir(), "lurk-social-e2e-"));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
process.on("exit", () => rmSync(userDir, { recursive: true, force: true }));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROME_BIN,
  headless: true,
  // The debugging port lets the test read the real toolbar popup, which Playwright does not expose.
  args: [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ],
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

// ---- Fake sites --------------------------------------------------------------------------------
const reached = []; // HTTP calls that got past the page
await ctx.route(/^https:\/\/(www\.)?(facebook|messenger|instagram)\.com\//, (route) => {
  const req = route.request();
  if (req.resourceType() === "document") {
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>t</title><p>fake",
    });
  }
  reached.push({
    url: req.url(),
    body: req.postData() || "",
    name: req.headers()["x-fb-friendly-name"] || "",
  });
  return route.fulfill({ contentType: "application/json", body: '{"data":{"real":true}}' });
});
const frames = []; // socket frames as they left the page
await ctx.routeWebSocket(/edge-chat|gateway|lightspeed/, (ws) =>
  ws.onMessage((m) => frames.push(m)),
);

// ---- Frame builders (run in Node, sent as bytes) ----------------------------------------------
const typingRequest = (isTyping, extra = "") =>
  JSON.stringify({
    app_id: "2220391788200892",
    payload: JSON.stringify({
      label: "3",
      payload:
        JSON.stringify({
          thread_key: 1234567,
          is_group_thread: 0,
          is_typing: isTyping,
          attribution: 0,
        }) + extra,
      version: "8965252033599985",
    }),
    request_id: 7,
    type: 4,
  }).replace("1234567", "9007199254740993"); // 64-bit id: would round if parsed
const markRead = (ts, extraTasks = []) =>
  JSON.stringify({
    app_id: "2220391788200892",
    payload: JSON.stringify({
      epoch_id: 7262871617430370,
      tasks: [
        {
          failure_count: null,
          label: "21",
          payload: JSON.stringify({
            thread_id: 100001234567890,
            last_read_watermark_ts: ts,
            sync_group: 1,
          }),
          queue_name: "100001234567890",
          task_id: 3,
        },
        ...extraTasks,
      ],
      version_id: "8965252033599985",
    }),
    request_id: 8,
    type: 3,
  });
const sendMessage = JSON.stringify({
  payload: JSON.stringify({
    tasks: [
      {
        label: "46",
        payload: JSON.stringify({
          text: '"is_typing":1 and "last_read_watermark_ts":1763290000123 in a message 😀',
          thread_id: 1,
        }),
      },
    ],
  }),
  type: 3,
});
// Lightspeed binary part: 0x0d, 2 bytes, 24-bit LE length (JSON + 2), 2 bytes, JSON.
const lightspeed = (json) => {
  const body = Buffer.from(json, "utf8");
  const len = body.length + 2;
  return Buffer.concat([
    Buffer.from([0x0d, 0, 0, len & 0xff, (len >> 8) & 0xff, len >> 16, 0, 0]),
    body,
  ]);
};
// MQTT PUBLISH (QoS 1) to /ls_req.
const mqtt = (json) => {
  const topic = Buffer.from("/ls_req");
  const payload = Buffer.from(json, "utf8");
  const rest = Buffer.concat([
    Buffer.from([0, topic.length]),
    topic,
    Buffer.from([0, 42]),
    payload,
  ]);
  const lenBytes = [];
  let n = rest.length;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    lenBytes.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([0x32, ...lenBytes]), rest]);
};

// ---- Page helpers --------------------------------------------------------------------------------
const pages = {};
async function site(origin) {
  if (pages[origin]) return pages[origin];
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check(`no page error on ${origin}`, false, String(e)));
  await page.goto(`${origin}/`);
  await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        window.__ws = new WebSocket(url);
        window.__ws.binaryType = "arraybuffer";
        window.__ws.onopen = resolve;
      }),
    origin.includes("instagram")
      ? "wss://edge-chat.instagram.com/chat"
      : "wss://edge-chat.facebook.com/chat",
  );
  pages[origin] = page;
  return page;
}
// Sends one frame from the page and returns it as it left (Buffer or string).
async function sendFrame(origin, frame) {
  const page = await site(origin);
  const before = frames.length;
  await page.evaluate(
    ([data, binary]) => window.__ws.send(binary ? new Uint8Array(data) : data),
    [typeof frame === "string" ? frame : [...frame], typeof frame !== "string"],
  );
  for (let i = 0; i < 50 && frames.length === before; i++) await wait(20);
  return frames[before];
}
const asText = (f) => (typeof f === "string" ? f : Buffer.from(f).toString("utf8"));

// HTTP: returns { reached: bool, status, text } for a request made by the page.
async function http(origin, { url, form, header, xhr = false }) {
  const page = await site(origin);
  const before = reached.length;
  const result = await page.evaluate(
    ([u, f, h, x]) => {
      const body = new FormData();
      for (const [k, v] of Object.entries(f || {})) body.append(k, v);
      const headers = h ? { "X-FB-Friendly-Name": h } : {};
      if (!x)
        return fetch(u, { method: "POST", body, headers }).then(async (r) => ({
          status: r.status,
          text: await r.text(),
        }));
      return new Promise((resolve) => {
        const req = new XMLHttpRequest();
        req.open("POST", u);
        for (const [k, v] of Object.entries(headers)) req.setRequestHeader(k, v);
        req.onload = () => resolve({ status: req.status, text: req.responseText });
        req.onerror = () => resolve({ status: -1, text: "" });
        req.send(body);
      });
    },
    [url, form, header, xhr],
  );
  await wait(150);
  return { ...result, reached: reached.length > before };
}
const setLocal = (values) => sw.evaluate((v) => chrome.storage.local.set(v), values);
const settle = () => wait(300);

const FB = "https://www.facebook.com";
const MSG = "https://www.messenger.com";
const IG = "https://www.instagram.com";

// ---- Typing --------------------------------------------------------------------------------------
{
  const text = await sendFrame(FB, typingRequest(1));
  check(
    "typing (text frame): is_typing 1 -> 0, same length",
    text === typingRequest(0),
    text.length,
  );
  check("typing: 64-bit thread id kept verbatim", text.includes("9007199254740993"));

  const bin = await sendFrame(FB, lightspeed(typingRequest(1)));
  check(
    "typing (Lightspeed binary): edited, header and length intact",
    Buffer.compare(Buffer.from(bin), lightspeed(typingRequest(0))) === 0,
  );

  const ig = await sendFrame(IG, mqtt(typingRequest(1)));
  check(
    "typing (Instagram MQTT): edited",
    Buffer.compare(Buffer.from(ig), mqtt(typingRequest(0))) === 0,
  );

  const stop = await sendFrame(FB, typingRequest(0));
  check("typing stopped frame passes unchanged", stop === typingRequest(0));

  const other = '{"is_typing_enabled":1,"is_typing_x":1}';
  check("similar keys untouched", (await sendFrame(FB, other)) === other);

  const msgPage = await site(MSG);
  check(
    "typing blocked on messenger.com too",
    asText(await sendFrame(MSG, typingRequest(1))) === typingRequest(0),
    !!msgPage,
  );

  const idle = await (
    await site(FB)
  ).evaluate(
    () =>
      new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port2.onmessage = (e) => resolve(e.data);
        port1.postMessage([
          {
            type: "request",
            content: { name: "sendChatStateFromComposer", arg: { state: "typing", thread: "1" } },
          },
          { type: "request", content: { name: "sendMessage", arg: { text: "hi" } } },
        ]);
      }),
  );
  check(
    "typing (encrypted chat worker port): state forced idle, other requests untouched",
    idle[0].content.arg.state === "idle" &&
      idle[0].content.arg.thread === "1" &&
      idle[1].content.arg.text === "hi",
    idle,
  );
}

// ---- Seen ----------------------------------------------------------------------------------------
{
  const ts = 1763290000123;
  const out = asText(await sendFrame(FB, markRead(ts)));
  const task = JSON.parse(JSON.parse(JSON.parse(out).payload).tasks[0].payload);
  check(
    "seen (label 21): watermark moved to the oldest same-length time",
    task.last_read_watermark_ts === 1000000000000,
    task,
  );
  check(
    "seen: thread id and the rest of the task kept",
    task.thread_id === 100001234567890 && task.sync_group === 1,
  );
  check("seen: frame length unchanged", out.length === markRead(ts).length);

  const mq = Buffer.from(await sendFrame(FB, mqtt(markRead(ts))));
  check(
    "seen (MQTT binary): edited in place, header intact",
    Buffer.compare(mq, mqtt(markRead(1000000000000))) === 0,
  );

  const igSeen = asText(await sendFrame(IG, lightspeed(markRead(ts))));
  check(
    "seen on Instagram socket edited",
    igSeen.includes("1000000000000") && !igSeen.includes(String(ts)),
  );

  const msg = await sendFrame(FB, Buffer.from(sendMessage, "utf8"));
  check(
    "ordinary message frame passes byte-for-byte (emoji kept)",
    Buffer.compare(Buffer.from(msg), Buffer.from(sendMessage, "utf8")) === 0,
  );

  // One batch: a real read mark plus a message whose text quotes the same key.
  const text = 'I typed "last_read_watermark_ts":1763290000123 on purpose 😀';
  const mixed = markRead(1763290000123, [
    { label: "46", payload: JSON.stringify({ text, thread_id: 1 }) },
  ]);
  const mixedOut = Buffer.from(await sendFrame(FB, lightspeed(mixed)))
    .subarray(8)
    .toString("utf8");
  const tasks = JSON.parse(JSON.parse(mixedOut).payload).tasks;
  check(
    "mixed batch: read mark rewritten, message text left exactly as typed",
    JSON.parse(tasks[0].payload).last_read_watermark_ts === 1000000000000 &&
      JSON.parse(tasks[1].payload).text === text,
    tasks.map((t) => t.payload),
  );
  check(
    "mixed batch: byte length unchanged",
    Buffer.byteLength(mixedOut) === Buffer.byteLength(mixed),
  );
}

// ---- Story views and HTTP seen ------------------------------------------------------------------
const STORY_FB = {
  url: `${FB}/api/graphql/`,
  form: { fb_api_req_friendly_name: "storiesUpdateSeenStateMutation", doc_id: "1" },
};
const STORY_IG_XHR = {
  url: `${IG}/graphql/query`,
  header: "PolarisStoriesV3SeenMutation",
  form: { doc_id: "2" },
  xhr: true,
};
const STORY_IG_REST = { url: `${IG}/api/v1/stories/reel/seen`, form: { reelMediaId: "1" } };
const DM_SEEN_IG = {
  url: `${IG}/api/graphql`,
  form: { fb_api_req_friendly_name: "usePolarisMarkThreadSeenMutation" },
};
const FEED = {
  url: `${FB}/api/graphql/`,
  form: { fb_api_req_friendly_name: "CometNewsFeedPaginationQuery", variables: '{"seen":1}' },
};
const SEND = {
  url: `${IG}/api/graphql`,
  form: { fb_api_req_friendly_name: "IGDirectTextSendMutation" },
};
{
  let r = await http(FB, STORY_FB);
  check("story view (Facebook fetch): never sent, fake 200", !r.reached && r.status === 200, r);
  r = await http(IG, STORY_IG_XHR);
  check(
    "story view (Instagram XHR, header name): never sent, load fires with 200",
    !r.reached && r.status === 200,
    r,
  );
  r = await http(IG, STORY_IG_REST);
  check("story view (Instagram REST reel/seen): never sent", !r.reached && r.status === 200, r);
  r = await http(IG, DM_SEEN_IG);
  check("DM seen (Instagram GraphQL): never sent", !r.reached, r);
  r = await http(FB, FEED);
  check(
    "feed query reaches the server with its real answer",
    r.reached && r.text.includes("real"),
    r,
  );
  r = await http(IG, SEND);
  check("sending a DM reaches the server", r.reached, r);
}

// ---- Google Chat typing (declarativeNetRequest) -------------------------------------------------
// Captured live 2026-11-16: typing in a DM sends batchexecute rpcids=uQwtvc with
// f.req [[["uQwtvc","[1,[[\"dm/<id>\",\"<id>\",5]]]",null,"generic"]]]; blocking it hides "is typing".
const chatRpc = (rpcids, host = "chat.google.com", prefix = "") =>
  `https://${host}${prefix}/u/0/_/DynamiteWebUi/data/batchexecute?rpcids=${rpcids}&source-path=%2Fu%2F0%2Fapp%2Fhome&hl=en&rt=c`;
// true when Chrome refused the request (ERR_BLOCKED_BY_CLIENT).
async function chatBlocked(url) {
  const page = await site(FB);
  const failed = new Promise((resolve) => {
    const onFail = (req) =>
      req.url() === url && (ctx.off("requestfailed", onFail), resolve(req.failure()?.errorText));
    ctx.on("requestfailed", onFail);
    setTimeout(() => (ctx.off("requestfailed", onFail), resolve("none")), 3000);
  });
  await page.evaluate(
    (u) => fetch(u, { method: "POST", mode: "no-cors", body: "f.req=x" }).catch(() => {}),
    url,
  );
  return (await failed) === "net::ERR_BLOCKED_BY_CLIENT";
}
await ctx.route(/^https:\/\/(chat|mail)\.google\.com\//, (route) =>
  route.fulfill({ body: ")]}'\n" }),
);
{
  check("Chat typing (uQwtvc) blocked", await chatBlocked(chatRpc("uQwtvc")));
  check(
    "Chat typing blocked for another account (/u/2)",
    await chatBlocked(chatRpc("uQwtvc").replace("/u/0/", "/u/2/")),
  );
  check(
    "Chat typing blocked in Gmail's Chat path",
    await chatBlocked(chatRpc("uQwtvc", "mail.google.com", "/chat")),
  );
  check("other batchexecute call passes", !(await chatBlocked(chatRpc("qL7xZc"))));
  check(
    "batch that also carries other calls passes",
    !(await chatBlocked(chatRpc("uQwtvc,qL7xZc"))),
  );
  check("look-alike rpc id passes", !(await chatBlocked(chatRpc("uQwtvcX"))));
}

// ---- Switches ----------------------------------------------------------------------------------
{
  await setLocal({ signals: { seen: true, stories: true, typing: false } });
  await settle();
  check(
    "typing switched off: typing frame passes",
    (await sendFrame(FB, typingRequest(1))) === typingRequest(1),
  );
  check(
    "typing switched off: seen still blocked",
    asText(await sendFrame(FB, markRead(1763290000123))).includes("1000000000000"),
  );
  const portState = await (
    await site(FB)
  ).evaluate(
    () =>
      new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port2.onmessage = (e) => resolve(e.data[0].content.arg.state);
        port1.postMessage([
          {
            type: "request",
            content: { name: "sendChatStateFromComposer", arg: { state: "typing" } },
          },
        ]);
      }),
  );
  check("typing switched off: worker port passes", portState === "typing", portState);
  check("typing switched off: Chat typing passes", !(await chatBlocked(chatRpc("uQwtvc"))));

  await setLocal({ signals: { seen: true, stories: false, typing: true } });
  await settle();
  check("stories switched off: story view sent", (await http(FB, STORY_FB)).reached);
  check(
    "stories switched off: typing blocked again",
    (await sendFrame(FB, typingRequest(1))) === typingRequest(0),
  );

  await setLocal({ signals: { seen: false, stories: true, typing: true } });
  await settle();
  check(
    "seen switched off: mark-read passes",
    asText(await sendFrame(FB, markRead(1763290000123))).includes("1763290000123"),
  );
  check("seen switched off: IG DM seen sent", (await http(IG, DM_SEEN_IG)).reached);
  const onlyTyping = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  check(
    "seen switched off: only the Chat typing ruleset stays on",
    onlyTyping.join() === "block_typing",
    onlyTyping,
  );
  check("seen switched off: Chat typing still blocked", await chatBlocked(chatRpc("uQwtvc")));
  check("seen switched off: story still blocked", !(await http(FB, STORY_FB)).reached);

  await setLocal({ signals: { seen: true, stories: true, typing: true }, enabled: false });
  await settle();
  check("master off: typing passes", (await sendFrame(FB, typingRequest(1))) === typingRequest(1));
  check("master off: story view sent", (await http(IG, STORY_IG_XHR)).reached);
  check("master off: Chat typing passes", !(await chatBlocked(chatRpc("uQwtvc"))));

  await setLocal({ enabled: true });
  await settle();
  check("master on: typing blocked", (await sendFrame(FB, typingRequest(1))) === typingRequest(0));
  const both = (await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).sort();
  check(
    "master on: both Google Chat rulesets enabled",
    both.join() === "block_receipts,block_typing",
    both,
  );

  await sw.evaluate(() => chrome.storage.local.set({ pauseUntil: Date.now() + 2000 }));
  await settle();
  check("pause: typing passes", (await sendFrame(FB, typingRequest(1))) === typingRequest(1));
  check("pause: story view sent", (await http(FB, STORY_FB)).reached);
  await wait(2200);
  check(
    "pause over: typing blocked again",
    (await sendFrame(FB, typingRequest(1))) === typingRequest(0),
  );
  check("pause over: story blocked again", !(await http(FB, STORY_FB)).reached);
}

// New tab opened while switched off starts with the stored state, not the blocking default.
{
  await setLocal({ enabled: false });
  await settle();
  const page = await ctx.newPage();
  await page.goto(`${IG}/`);
  await wait(300);
  const sent = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const ws = new WebSocket("wss://edge-chat.instagram.com/chat");
        ws.onopen = () => resolve(ws.send('{"is_typing":1}'));
      }),
  );
  await wait(200);
  check("fresh tab while off: typing passes", frames.at(-1) === '{"is_typing":1}', sent);
  await page.close();
  await setLocal({ enabled: true });
}

// Popup checkboxes write storage.
{
  const id = new URL(sw.url()).host;
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await wait(300);
  // Opened as a page, the popup names no site; show it as if opened on Instagram (all three apply).
  const onInstagram = () => popup.evaluate(() => renderSite("https://www.instagram.com/"));
  await onInstagram();
  const initial = await popup.$$eval("[data-signal]", (els) => els.map((e) => e.checked));
  check("popup: all three signals ticked", initial.every(Boolean) && initial.length === 3, initial);
  await popup.getByLabel("Story views").uncheck();
  await wait(200);
  const stored = await sw.evaluate(() => chrome.storage.local.get("signals"));
  check(
    "popup: unticking Story views stores it",
    stored.signals?.stories === false && stored.signals?.seen === true,
    stored,
  );
  await popup.reload();
  await wait(300);
  await onInstagram();
  check("popup: state survives reopening", !(await popup.getByLabel("Story views").isChecked()));
  await popup.getByLabel("Story views").focus();
  await popup.keyboard.press("Space");
  await wait(200);
  check(
    "popup: keyboard ticks it back",
    (await sw.evaluate(() => chrome.storage.local.get("signals"))).signals.stories === true,
  );

  // Status line and badge follow the Hide boxes.
  const status = () => popup.locator("#status").textContent();
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  check(
    "status with every switch on",
    (await status()) === "Hiding Seen, story views and typing" && (await badge()) === "",
    await status(),
  );
  await setLocal({ signals: { seen: true, stories: false, typing: true } });
  await wait(300);
  check(
    "status names what is hidden",
    (await status()) === "Hiding Seen and typing",
    await status(),
  );
  await setLocal({ signals: { seen: false, stories: false, typing: true } });
  await wait(300);
  check("status with one switch", (await status()) === "Hiding typing", await status());
  await setLocal({ signals: { seen: false, stories: false, typing: false } });
  await wait(300);
  const none = {
    status: await status(),
    tone: await popup.locator("#status").getAttribute("data-tone"),
    hero: await popup.locator("#hero").getAttribute("data-state"),
    badge: await badge(),
  };
  check(
    "nothing switched on: warning status, hero steps back, OFF badge",
    none.status === "On, but nothing is switched on below" &&
      none.tone === "warn" &&
      none.hero === "off" &&
      none.badge === "OFF",
    none,
  );
  await setLocal({ signals: { seen: true, stories: true, typing: true } });
  await wait(300);
  check("ticked again: badge clears", (await badge()) === "");

  // Each kind of page: the "Hide on …" heading, the status pill, the tip, and each row's switch.
  const view = async (url) => {
    await popup.evaluate((u) => renderSite(u), url);
    await wait(100);
    return popup.evaluate(() => ({
      heading: document.getElementById("site-heading").textContent,
      status: document.getElementById("status").textContent,
      tip: document.getElementById("tip").textContent,
      boxes: Object.fromEntries(
        [...document.querySelectorAll("[data-signal]")].map((e) => [
          e.dataset.signal,
          {
            disabled: e.disabled,
            checked: e.checked,
            shown: e.offsetWidth > 0,
            why: e.closest("label").querySelector(".unsupported").textContent,
          },
        ]),
      ),
    }));
  };
  const usable = (b) => Object.values(b).every((x) => !x.disabled && x.shown && x.why === "");
  let v = await view("https://www.instagram.com/direct/t/1/");
  check(
    "Instagram: heading, all three hidden, every switch usable",
    v.heading === "Hide on Instagram" &&
      v.status === "Hiding Seen, story views and typing" &&
      usable(v.boxes),
    v,
  );
  v = await view("https://www.messenger.com/t/1");
  check(
    "Messenger: names the encrypted-chat gap in the tip",
    v.heading === "Hide on Facebook and Messenger" && /encrypted chats still send Seen/.test(v.tip),
    v,
  );
  v = await view("https://chat.google.com/u/2/app");
  check(
    "Google Chat: Seen and typing hidden; Story views says why, no switch, setting kept",
    v.status === "Hiding Seen and typing" &&
      v.boxes.stories.disabled &&
      !v.boxes.stories.shown &&
      v.boxes.stories.why === "Not on Google Chat" &&
      v.boxes.stories.checked &&
      !v.boxes.seen.disabled,
    v,
  );
  v = await view("https://mail.google.com/chat/u/0/");
  check("Chat in Gmail counts as Google Chat", v.heading === "Hide on Google Chat", v);
  v = await view("https://www.tiktok.com/messages");
  check(
    "TikTok: not covered (its web chat sends no Seen or typing)",
    v.status === "Lurk does nothing on this site" && v.heading === "Hide on this site",
    v,
  );
  v = await view("https://web.whatsapp.com/");
  check(
    "WhatsApp: all three hidden, phone note in the tip",
    v.status === "Hiding Seen, story views and typing" && usable(v.boxes) && /phone/.test(v.tip),
    v,
  );
  v = await view("https://app.slack.com/client/T1/D1");
  check(
    "Slack: not covered (support removed)",
    v.status === "Lurk does nothing on this site" && v.heading === "Hide on this site",
    v,
  );
  for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) {
    v = await view(`https://${host}/v2/`);
    check(
      `Teams (${host}): Seen and typing hidden, Story views locked`,
      v.heading === "Hide on Teams" &&
        v.status === "Hiding Seen and typing" &&
        v.boxes.stories.why === "Not on Teams",
      v,
    );
  }
  v = await view("https://example.com/");
  check(
    'unsupported site: says Lurk does nothing, every row locked as "Not on this site"',
    v.heading === "Hide on this site" &&
      v.status === "Lurk does nothing on this site" &&
      Object.values(v.boxes).every((x) => x.disabled && x.why === "Not on this site"),
    v,
  );
  v = await view("https://notfacebook.com/");
  check("look-alike domain is not Facebook", v.status === "Lurk does nothing on this site", v);
  v = await view("chrome://newtab/");
  check(
    "browser page: Lurk does nothing on this page, switches stay usable",
    v.heading === "Hide" && v.status === "Lurk does nothing on this page" && usable(v.boxes),
    v,
  );
  v = await view(undefined);
  check(
    "page Chrome will not share: same as a browser page",
    v.status === "Lurk does nothing on this page" && usable(v.boxes),
    v,
  );

  await view("https://chat.google.com/u/0/");
  await popup.getByLabel("Typing").uncheck();
  await wait(200);
  const kept = (await sw.evaluate(() => chrome.storage.local.get("signals"))).signals;
  check(
    "changing a switch on Google Chat keeps the locked Story views setting",
    kept.stories === true && kept.typing === false,
    kept,
  );
  check(
    "Google Chat with typing off: status names only Seen",
    (await popup.locator("#status").textContent()) === "Hiding Seen",
  );
  await popup.getByLabel("Typing").check();
  await wait(200);

  await view("https://www.instagram.com/");
  await setLocal({ enabled: false });
  await wait(300);
  const off = {
    status: await popup.locator("#status").textContent(),
    hero: await popup.locator("#hero").getAttribute("data-state"),
  };
  check(
    "switched off: status warns, hero steps back",
    off.status === "Off: people see when you read" && off.hero === "off",
    off,
  );
  await setLocal({ enabled: true });
  await wait(300);

  // Theme button: picks the other theme, remembers it, and says what it will do next.
  const theme = async () =>
    popup.evaluate(() => ({
      attr: document.documentElement.dataset.theme || "",
      label: document.getElementById("theme").getAttribute("aria-label"),
    }));
  await popup.emulateMedia({ colorScheme: "light" });
  await popup.getByRole("button", { name: "Switch to dark theme" }).click();
  await wait(200);
  let t = await theme();
  check(
    "theme button: light → dark, label flips",
    t.attr === "dark" && t.label === "Switch to light theme",
    t,
  );
  check(
    "theme stored",
    (await sw.evaluate(() => chrome.storage.local.get("theme"))).theme === "dark",
  );
  await popup.reload();
  await wait(300);
  t = await theme();
  check("theme survives reopening", t.attr === "dark", t);
  await popup.getByRole("button", { name: "Switch to light theme" }).click();
  await wait(200);
  t = await theme();
  check("theme button: dark → light", t.attr === "light" && t.label === "Switch to dark theme", t);
  await sw.evaluate(() => chrome.storage.local.remove("theme"));
  await onInstagram();
  check(
    "version shown from the manifest",
    (await popup.locator("#version").textContent()) ===
      `v${await sw.evaluate(() => chrome.runtime.getManifest().version)}`,
  );
}

// The real toolbar popup, opened on an Instagram tab without a click: Chrome shares no URL then, so
// the site comes from Lurk's page script.
{
  const tab = await site(IG);
  await tab.bringToFront();
  await sw.evaluate(() => chrome.action.openPopup());
  let popupText = null;
  for (let i = 0; i < 20 && !popupText; i++) {
    await wait(150);
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    const target = targets.find((t) => t.url.endsWith("/popup.html"));
    if (!target) continue;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => {
      ws.onopen = r;
    });
    const reply = await new Promise((resolve) => {
      ws.onmessage = (m) => resolve(JSON.parse(m.data));
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression:
              "new Promise((r) => setTimeout(r, 400)).then(() => document.getElementById('site-heading').textContent + ' | ' + document.getElementById('status').textContent)",
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    });
    ws.close();
    popupText = reply.result?.result?.value ?? null;
  }
  check(
    "real popup on an Instagram tab shows Instagram",
    popupText === "Hide on Instagram | Hiding Seen, story views and typing",
    popupText,
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
