// Isolated-world half of the content script: reads the user's settings and hands them to
// content/page.ts, whatsapp.ts and gchat.ts (MAIN world), which cannot use chrome.* APIs.
// Blocking is active when local.enabled is on and no local.pauseUntil pass-through is running;
// local.signals switches each signal (seen, stories, typing) on its own.
//
// When the extension is updated or reloaded, this script stays in open tabs but is cut off from the
// extension: every chrome.* call throws. The page scripts keep blocking with the last settings, and
// a pause that was running still ends on time (see push).
import {
  isKind,
  isSetting,
  readLocal,
  type CountMessage,
  type Kind,
  type Signals,
  type Stored,
} from "../shared";

let timer = 0;
let state: Signals = { seen: true, stories: true, typing: true };
let stored: Pick<Stored, "enabled" | "signals" | "pauseUntil"> = {};

/** False once the extension was updated or reloaded under this tab. */
const alive = () => {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

/** The page scripts' DOM events, ignored once this script is cut off from the extension. */
const onPageEvent = (type: string, handler: (event: Event) => void) =>
  document.addEventListener(type, (event) => {
    if (alive()) handler(event);
  });

// ---- Stats ---------------------------------------------------------------------------------------
// Page scripts fire "lurk:count" with { kind, key } for each signal they block. Repeats collapse:
// apps resend "typing" every few seconds while you type, and Google Chat retries a blocked receipt
// about 18 times, so one burst of typing, one read of a chat or one story view counts once.
const WINDOW_MS: Record<Kind, number> = { seen: 60_000, stories: 30_000, typing: 10_000 };
const lastSeen = new Map<string, number>();
onPageEvent("lurk:count", (event) => {
  let kind: unknown;
  let key: unknown;
  try {
    ({ kind, key } = JSON.parse((event as CustomEvent<string>).detail) as {
      kind?: unknown;
      key?: unknown;
    });
  } catch {
    return;
  }
  if (!isKind(kind) || !state[kind]) return;
  const id = kind === "typing" ? "typing" : `${kind}:${String(key ?? "").slice(0, 300)}`;
  const now = Date.now();
  if (now - (lastSeen.get(id) ?? -Infinity) < WINDOW_MS[kind]) {
    lastSeen.set(id, now);
    return;
  }
  lastSeen.set(id, now);
  if (lastSeen.size > 500) lastSeen.clear();
  const message: CountMessage = { type: "lurk:count", kind };
  chrome.runtime.sendMessage(message).catch(() => {
    // Worker restarting: one count lost, never the page.
  });
});

async function push() {
  // Cut off from the extension: keep the last settings; a pause in them has ended by now.
  if (alive()) {
    try {
      stored = await readLocal(["enabled", "signals", "pauseUntil"]);
    } catch {
      // Cut off while reading.
    }
  }
  const { enabled = true, signals = {}, pauseUntil = 0 } = stored;
  const now = Date.now();
  const active = enabled && !(pauseUntil > now);
  state = {
    seen: active && signals.seen !== false,
    stories: active && signals.stories !== false,
    typing: active && signals.typing !== false,
  };
  document.dispatchEvent(new CustomEvent("lurk:state", { detail: JSON.stringify(state) }));

  clearTimeout(timer);
  if (enabled && pauseUntil > now) timer = setTimeout(push, pauseUntil - now + 50);
}

// The popup asks which site the tab is on when Chrome has not shared the tab's URL with it.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message === "lurk:host") reply(location.hostname);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some(isSetting)) void push();
});
// The page scripts announce themselves; whichever script runs first, the state still gets across.
// (Not onPageEvent: a page script injected after the cut-off still needs the last settings.)
document.addEventListener("lurk:ready", () => void push());
void push();
