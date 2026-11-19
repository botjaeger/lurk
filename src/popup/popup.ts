// The toolbar popup: main switch, per-signal switches for the open site, pass-through, Stats.
import {
  KINDS,
  readLocal,
  type Kind,
  type PopupMessage,
  type Signals,
  type Stats,
  type Stored,
} from "../shared";
import { SITES, siteFor, type Site } from "../sites";

// Pauses and resets are written by the background worker, on its queue (see PopupMessage).
const ask = (message: PopupMessage) =>
  chrome.runtime.sendMessage(message).catch((error: unknown) => {
    console.error("Lurk: the background worker did not answer", error);
  });

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const enabledEl = byId<HTMLInputElement>("enabled");
const heroEl = byId("hero");
const statusEl = byId("status");
// The status pill is a live region: its words, plus a countdown kept aria-hidden so a pause is
// announced once, not every second. One wrapper span, so the pill's flex gap stays outside the text.
const statusTextEl = document.createElement("span");
const statusCountEl = document.createElement("span");
statusCountEl.setAttribute("aria-hidden", "true");
const statusWrapEl = document.createElement("span");
statusWrapEl.append(statusTextEl, statusCountEl);
statusEl.append(statusWrapEl);
const passEl = byId<HTMLButtonElement>("pass");
const headingEl = byId("site-heading");
const tipEl = byId("tip");
const signalEls = [...document.querySelectorAll<HTMLInputElement>("[data-signal]")];
const signalOf = (box: HTMLInputElement) => box.dataset.signal as Kind;

const DEFAULT_TIP = "Want them to see it? Let receipts through, then reopen the chat.";

byId("version").textContent = `v${chrome.runtime.getManifest().version}`;
byId("works-on").textContent = `Works on ${SITES.map((site) => site.name).join(" · ")}`;

const listWords = (words: string[]) =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

// ---- The open site ----------------------------------------------------------------------------
// none: no website, or Chrome would not share the address (every box usable); site: an app Lurk
// knows; other: a website Lurk does nothing on.
type Page = { kind: "none" } | { kind: "site"; site: Site } | { kind: "other"; host: string };
let page: Page = { kind: "none" };

// `url` is the tab's address, or undefined when it could not be found out. Chrome shares the address
// of every site Lurk supports (on the icon click, or through Lurk's page script), so an unknown
// address is a page Lurk does nothing on, like a chrome:// page.
function renderSite(url: string | undefined) {
  let host = "";
  try {
    const parsed = new URL(url ?? "");
    if (parsed.protocol === "https:" || parsed.protocol === "http:") host = parsed.hostname;
  } catch {
    // No URL, or a browser page.
  }
  const site = host ? siteFor(host) : null;
  page = site ? { kind: "site", site } : host ? { kind: "other", host } : { kind: "none" };
  return refresh();
}
// The e2e tests call renderSite to show the popup as it looks on a given site.
Object.assign(globalThis, { renderSite });

// What the open site supports, or null for "everything".
const coversHere = (): Partial<Site["covers"]> | null =>
  page.kind === "site" ? page.site.covers : page.kind === "other" ? {} : null;

function renderPage() {
  const covers = coversHere();
  const name = page.kind === "site" ? page.site.name : "this site";
  headingEl.textContent = page.kind === "none" ? "Hide" : `Hide on ${name}`;
  // A switch the open site has no support for is greyed out; the setting itself is kept for other sites.
  for (const box of signalEls) {
    const supported = !covers || covers[signalOf(box)] === true;
    box.disabled = !supported;
    const hint = box.closest("label")?.querySelector(".unsupported");
    if (hint) hint.textContent = supported ? "" : `Not on ${name}`;
  }
  const note = page.kind === "site" ? page.site.note : "";
  tipEl.textContent = note || DEFAULT_TIP;
  tipEl.dataset.tone = note ? "note" : "";
}

// ---- Settings ---------------------------------------------------------------------------------
// Each switch writes the whole signals object from the switches' current state.
for (const box of signalEls) {
  box.addEventListener("change", () => {
    const signals = Object.fromEntries(signalEls.map((el) => [signalOf(el), el.checked]));
    void chrome.storage.local.set({ signals });
  });
}

const STATUS_WORDS: Record<Kind, string> = {
  seen: "Seen",
  stories: "story views",
  typing: "typing",
};

interface Status {
  enabled: boolean;
  paused: boolean;
  signals: Partial<Signals>;
}

// The status pill: what is happening here and now. Returns [text, tone].
function statusFor({ enabled, paused, signals }: Status): [string, string] {
  if (!enabled) return ["Off: people see when you read", "warn"];
  if (paused) return ["Letting receipts through", "warn"];
  const covers = coversHere();
  // No website (new tab, chrome:// pages): nothing to hide here, but every switch stays usable.
  if (page.kind === "none") return ["Lurk does nothing on this page", "idle"];
  if (covers && !KINDS.some((key) => covers[key] === true))
    return ["Lurk does nothing on this site", "idle"];
  const hiding = KINDS.filter((key) => signals[key] !== false && (!covers || covers[key] === true));
  if (!hiding.length) return ["On, but nothing is switched on below", "warn"];
  return [`Hiding ${listWords(hiding.map((key) => STATUS_WORDS[key]))}`, "ok"];
}

// Returns the pause end so the caller knows whether to keep ticking.
async function render() {
  const {
    enabled = true,
    signals = {},
    stats,
    theme,
    pauseUntil = 0,
  } = await readLocal(["enabled", "signals", "stats", "theme", "pauseUntil"]);
  const secondsLeft = Math.ceil((pauseUntil - Date.now()) / 1000);
  const paused = enabled && secondsLeft > 0;
  applyTheme(theme);
  renderPage();
  renderStats(stats);

  enabledEl.checked = enabled;
  for (const box of signalEls) box.checked = signals[signalOf(box)] !== false;
  // aria-disabled, not disabled: a disabled button drops keyboard focus right after it is clicked.
  passEl.setAttribute("aria-disabled", String(!enabled || paused));

  const [text, tone] = statusFor({ enabled, paused, signals });
  // Written only when it changes: rewriting the same words would have the live region repeat them
  // on every stats update and every countdown tick.
  if (statusTextEl.textContent !== text) statusTextEl.textContent = text;
  statusCountEl.textContent = paused ? `: ${secondsLeft} s` : "";
  statusEl.dataset.tone = tone;
  heroEl.dataset.state = tone === "warn" ? "off" : "on";
  return paused ? pauseUntil : 0;
}

// ---- Theme: follows the system until the button picks one (local.theme = "light" | "dark") -------
const themeEl = byId<HTMLButtonElement>("theme");
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let themeChoice: Stored["theme"];
function applyTheme(theme: Stored["theme"]) {
  themeChoice = theme;
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  const dark = theme ? theme === "dark" : systemDark.matches;
  root.dataset.dark = String(dark);
  themeEl.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
}
themeEl.addEventListener("click", () => {
  const dark = themeChoice ? themeChoice === "dark" : systemDark.matches;
  void chrome.storage.local.set({ theme: dark ? "light" : "dark" });
});
systemDark.addEventListener("change", () => applyTheme(themeChoice));

// ---- Stats (local.stats = { since, sites: { <site id>: { seen, stories, typing } } }) ------------
type Counts = Partial<Record<Kind, number>>;
const STAT_WORDS: Record<Kind, (n: number) => string> = {
  seen: (n) => `${n.toLocaleString()} Seen`,
  stories: (n) => `${n.toLocaleString()} ${n === 1 ? "story view" : "story views"}`,
  typing: (n) => `${n.toLocaleString()} typing`,
};
const sumOf = (counts: Counts | undefined) =>
  KINDS.reduce((sum, key) => sum + (counts?.[key] || 0), 0);
const phrase = (counts: Counts) =>
  listWords(
    KINDS.filter((key) => (counts[key] ?? 0) > 0).map((key) => STAT_WORDS[key](counts[key] ?? 0)),
  );

function renderStats(stats: Stats | undefined) {
  const sites = stats?.sites || {};
  const totals = { seen: 0, stories: 0, typing: 0 };
  for (const counts of Object.values(sites))
    for (const key of KINDS) totals[key] += counts?.[key] || 0;
  const totalEl = byId("stats-total");
  const listEl = byId("stats-list");
  listEl.replaceChildren();
  resetEl.hidden = !sumOf(totals);
  if (!sumOf(totals)) {
    totalEl.textContent = "Nothing hidden yet. Open a chat on a supported app.";
    return;
  }
  const since = new Date(stats?.since || Date.now()).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  totalEl.textContent = `Hidden since ${since}: ${phrase(totals)}`;
  for (const site of SITES) {
    const counts = sites[site.id];
    if (!counts || !sumOf(counts)) continue;
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "stats-site";
    name.textContent = site.name;
    const value = document.createElement("span");
    value.className = "stats-value";
    value.textContent = phrase(counts);
    item.append(name, value);
    listEl.append(item);
  }
}

// Two steps, so one stray click cannot wipe the counts.
const resetEl = byId<HTMLButtonElement>("reset-stats");
const statsSummaryEl = document.querySelector<HTMLElement>(".stats summary");
let resetArmed = 0;
resetEl.addEventListener("click", async () => {
  if (!resetArmed) {
    resetEl.textContent = "Click again to reset";
    resetArmed = setTimeout(() => {
      resetArmed = 0;
      resetEl.textContent = "Reset stats";
    }, 4000);
    return;
  }
  clearTimeout(resetArmed);
  resetArmed = 0;
  resetEl.textContent = "Reset stats";
  // The button hides once there is nothing to reset: keep keyboard focus in the Stats section.
  statsSummaryEl?.focus();
  await ask({ type: "lurk:reset-stats" });
});

// ---- Main switch and pass-through -------------------------------------------------------------
// The background worker clears a running pause when blocking is switched off.
enabledEl.addEventListener("change", () => {
  void chrome.storage.local.set({ enabled: enabledEl.checked });
});

passEl.addEventListener("click", () => {
  if (passEl.getAttribute("aria-disabled") === "true") return;
  void ask({ type: "lurk:pause" });
});

// Re-render only when stored state changes, plus once a second while a pause counts down.
// (Polling storage on a timer could read the old value mid-click and flip the switch back.)
let ticker = 0;
async function refresh() {
  const pauseUntil = await render();
  clearTimeout(ticker);
  if (pauseUntil) ticker = setTimeout(refresh, 1000);
}

// activeTab shares the URL of the tab the popup was clicked open on; nothing else is read. When
// the popup opens some other way, Lurk's own page script answers with the site's host name.
async function detectSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return renderSite(undefined);
  if (tab.url) return renderSite(tab.url);
  try {
    if (tab.id !== undefined) {
      const host: unknown = await chrome.tabs.sendMessage(tab.id, "lurk:host", { frameId: 0 });
      if (typeof host === "string" && host) return renderSite(`https://${host}/`);
    }
  } catch {
    // No Lurk script in that tab.
  }
  return renderSite(undefined);
}

chrome.storage.onChanged.addListener(() => void refresh());
void refresh();
detectSite().catch(() => renderSite(undefined));
