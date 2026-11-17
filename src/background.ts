// Keeps the static network rulesets in sync with the user's choice:
//   block_receipts (rules.json)        – Google Chat and Teams "Seen", on while blocking and signals.seen
//   block_typing   (rules-typing.json) – Google Chat "is typing", on while blocking and signals.typing
// Everything else (Facebook, Messenger, Instagram, WhatsApp, Teams in the page) is handled by
// content/page.ts and content/whatsapp.ts, fed by content/bridge.ts.
// local.enabled   – blocking switched on (default true), survives restarts.
// local.signals   – { seen, stories, typing }; each defaults to true.
// local.pauseUntil – epoch ms; while in the future, receipts are let through. Kept in local, not
//   session, storage: content/bridge.ts must read it, and Firefox cannot open session storage to
//   content scripts. A browser start clears it (see `queue` below), so a pause never outlives a restart.
// session.running – set once the worker has run since the browser started.
// Chrome and Safari run this as a service worker, Firefox as a background script.
import { isKind, readLocal, type CountMessage, type Kind } from "./shared";
import { siteFor } from "./sites";

const RULESETS: Partial<Record<Kind, string>> = { seen: "block_receipts", typing: "block_typing" };
const ALARM = "end-pause";

async function getState() {
  const {
    enabled = true,
    signals = {},
    pauseUntil = 0,
  } = await readLocal(["enabled", "signals", "pauseUntil"]);
  const paused = enabled && pauseUntil > Date.now();
  // With every Hide box unticked, nothing is blocked: the badge says OFF rather than look active.
  const anySignal = (["seen", "stories", "typing"] as const).some((key) => signals[key] !== false);
  return { enabled, paused, pauseUntil, blocking: enabled && !paused && anySignal, signals };
}

let tick = 0;

async function apply() {
  const state = await getState();

  const enable: string[] = [];
  const disable: string[] = [];
  for (const [signal, id] of Object.entries(RULESETS) as [Kind, string][]) {
    (state.blocking && state.signals[signal] !== false ? enable : disable).push(id);
  }
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enable,
    disableRulesetIds: disable,
  });

  const secondsLeft = Math.ceil((state.pauseUntil - Date.now()) / 1000);
  await chrome.action.setBadgeText({
    text: state.blocking ? "" : state.paused ? `${secondsLeft}s` : "OFF",
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#C5221F" });
  await chrome.action.setTitle({
    title: state.blocking
      ? "Lurk: read receipts blocked"
      : state.paused
        ? "Lurk: receipts let through briefly"
        : "Lurk: read receipts are being sent",
  });

  clearTimeout(tick);
  await chrome.alarms.clear(ALARM);
  if (state.paused) {
    // Tick once a second for the badge countdown; the alarm re-applies if the worker was stopped.
    tick = setTimeout(sync, Math.min(1000, state.pauseUntil - Date.now() + 50));
    await chrome.alarms.create(ALARM, { when: state.pauseUntil + 50 });
  } else if (state.pauseUntil) {
    // Pause ran out, or blocking was switched off (from any place) during it.
    await chrome.storage.local.remove("pauseUntil");
  }
}

// Runs apply() one at a time, so a slow earlier run can never overwrite a newer state.
// First in the queue: a pause never survives a browser restart. Session storage is emptied when the
// browser quits but kept while the worker merely sleeps and wakes, so a missing "running" mark means
// the browser has just started and any stored pause is from before.
let queue: Promise<void> = chrome.storage.session
  .get<{ running?: boolean }>("running")
  .then(async ({ running }) => {
    if (!running) await chrome.storage.local.remove("pauseUntil");
    await chrome.storage.session.set({ running: true });
  })
  .catch((error: unknown) => console.error("Lurk: startup check failed", error));
function sync() {
  queue = queue.then(apply).catch((error: unknown) => console.error("Lurk: apply failed", error));
  return queue;
}

// ---- Stats: local.stats = { since, sites: { <site id>: { seen, stories, typing } } } -------------
// Content scripts report each blocked signal (already de-duplicated, see content/bridge.ts). Counts
// are added one at a time on the same queue, so two tabs reporting at once never lose a count.
async function addCount(siteId: string, kind: Kind) {
  const { stats } = await readLocal(["stats"]);
  const next = { since: stats?.since || Date.now(), sites: { ...stats?.sites } };
  const counts = { seen: 0, stories: 0, typing: 0, ...next.sites[siteId] };
  counts[kind] += 1;
  next.sites[siteId] = counts;
  await chrome.storage.local.set({ stats: next });
}

chrome.runtime.onMessage.addListener((message: Partial<CountMessage> | null, sender) => {
  const kind = message?.kind;
  if (message?.type !== "lurk:count" || !isKind(kind)) return;
  let host: string;
  try {
    host = new URL(sender.url || sender.origin || "").hostname;
  } catch {
    return;
  }
  const site = siteFor(host);
  if (!site?.covers[kind]) return;
  queue = queue
    .then(() => addCount(site.id, kind))
    .catch((error: unknown) => console.error("Lurk: count failed", error));
});

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
// Only settings changes need the rules re-applied; a stats update does not.
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key !== "stats")) void sync();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void sync();
});
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-blocking") return;
  const { enabled = true } = await readLocal(["enabled"]);
  await chrome.storage.local.set({ enabled: !enabled });
});

void sync();
