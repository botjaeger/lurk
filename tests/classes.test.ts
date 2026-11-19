// Guards for the defect classes in docs/workstreams/project-defect-classes.md. Each test reads the
// source tree, so a new site of the same shape fails here instead of in a later sweep.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SITES, siteFor } from "../src/sites";

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const sources = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );

// ---- C1: read-then-write on shared storage off the worker's queue ------------------------------
const WRITE = /storage\.(local|session|sync)\.(set|remove|clear)\(/;

test("C1: outside the worker, scripts write only keys they set outright (no read first)", () => {
  // Keys the popup writes from what is on screen; nothing else may read-then-write them.
  const outright = new Set(["signals", "theme", "enabled"]);
  const offenders: string[] = [];
  for (const file of sources("src").filter((f) => f !== "src/background.ts")) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (!WRITE.test(line)) return;
        // One key, written in one line: `.set({ key })` or `.set({ key: value })`, no comma.
        const key = /\.set\(\{\s*(\w+)\s*(?::[^,]*)?\}\)/.exec(line)?.[1];
        const ok = key !== undefined && outright.has(key);
        if (!ok) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(offenders, "send a PopupMessage and write it on the worker's queue").toEqual([]);
});

test("C1: every storage write in the worker runs on its queue", () => {
  const source = read("src/background.ts");
  const lines = source.split("\n");
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (!WRITE.test(line)) return;
    // The enclosing function: the nearest named function or enqueue(async () => …) above.
    let owner = "";
    for (let j = i; j >= 0 && !owner; j--) {
      const named = /^(?:async )?function (\w+)/.exec(lines[j]);
      if (named) owner = named[1];
      else if (/enqueue\(async/.test(lines[j])) owner = "<enqueued>";
      else if (/^let queue\b/.test(lines[j])) owner = "<queue start>";
    }
    const queued =
      owner === "<enqueued>" ||
      owner === "<queue start>" ||
      (owner === "apply" && /enqueue\(apply\b/.test(source)) ||
      new RegExp(`enqueue\\((\\(\\) => )?${owner}\\b`).test(source);
    if (!queued) offenders.push(`background.ts:${i + 1} (${owner || "top level"})`);
  });
  expect(offenders).toEqual([]);
});

// ---- C3: a content script cut off by an extension update throws or strands the tab -------------
// The behaviour is tested in tests/e2e/restart.e2e.mjs; this keeps new code on the same path.
test("C3: only bridge.ts calls chrome.*, and its page-event handlers go through onPageEvent", () => {
  for (const file of sources("src/content").filter((f) => !f.endsWith("bridge.ts")))
    expect(/\bchrome\./.test(read(file)), `${file} runs in the page: no chrome.*`).toBe(false);
  const bridge = read("src/content/bridge.ts");
  const raw = [...bridge.matchAll(/document\.addEventListener\("([\w:]+)"/g)].map((m) => m[1]);
  // onPageEvent's own call has a variable type; the only direct one is lurk:ready (see bridge.ts).
  expect(raw).toEqual(["lurk:ready"]);
  expect(bridge).toMatch(/async function push\(\) \{\n(.*\n){0,2}\s*if \(alive\(\)\)/);
});

// ---- C5: popup colours below contrast ----------------------------------------------------------
const hex = (value: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`not a 6-digit colour: ${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
};
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(hex(a)), luminance(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("C5: popup token pairs meet contrast in light and dark", () => {
  const css = read("src/popup/popup.css");
  const block = (selector: string) => {
    const at = css.indexOf(selector);
    const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    return Object.fromEntries(
      [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
    );
  };
  const light = block(":root {");
  const dark = { ...light, ...block(':root[data-theme="dark"] {') };
  // The system-dark block must match the explicit dark one.
  expect(block(':root:not([data-theme="light"]) {')).toEqual(block(':root[data-theme="dark"] {'));
  const heroTrack = /\.switch-hero:checked \{\s*background: (#[0-9a-f]{6});/i.exec(css)?.[1] ?? "";
  // On the stepped-back card (off, paused) the hero switch uses --accent, checked below on --card.
  expect(css).toMatch(
    /\.hero\[data-state="off"\] \.switch-hero:checked \{\s*background: var\(--accent\);/,
  );
  for (const [name, t] of Object.entries({ light, dark })) {
    // [foreground, background, minimum]
    const pairs: [string, string, number][] = [
      [t.ink, t.bg, 4.5],
      [t.ink, t.card, 4.5],
      [t.muted, t.bg, 4.5],
      [t.muted, t.card, 4.5],
      [t.accent, t.bg, 4.5], // the pass button's text
      [t.warn, t.bg, 4.5], // the off pill sits on --bg
      [t["hero-ink"], t.hero, 4.5],
      [t["track-off"], t.card, 3], // an off switch on its row
      [t.accent, t.card, 3], // an on switch on its row, and the hero switch when the card steps back
      [heroTrack, t.hero, 3], // the hero switch, on, on the green card
    ];
    for (const [fg, bg, min] of pairs)
      expect(contrast(fg, bg), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
  }
});

test("C5: website text colours meet contrast on every surface they sit on", () => {
  const css = read("site/src/style.css");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const t = Object.fromEntries(
    [...root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]),
  );
  const surfaces = [t.bg, t["bg-2"], t.card, t["card-2"]];
  for (const ink of [t.ink, t["ink-2"], t.muted, t.accent])
    for (const surface of surfaces)
      expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(t["on-accent"], t.accent)).toBeGreaterThanOrEqual(4.5);
  // Every rule that sets white text on a literal colour (the mock chat's avatar and bubbles).
  for (const rule of css.matchAll(/\{[^}]*\}/g)) {
    const bg = /background: (#[0-9a-f]{6});/i.exec(rule[0])?.[1];
    if (bg && /\bcolor: #fff;/.test(rule[0]))
      expect(contrast("#ffffff", bg), `#fff on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});

// ---- C2: the app list drifts from the manifest and the privacy policy --------------------------
interface ContentScript {
  matches: string[];
  js: string[];
}
const manifest = JSON.parse(read("manifest.json")) as { content_scripts: ContentScript[] };
const hostOf = (pattern: string) => /^https:\/\/([^/]+)\//.exec(pattern)?.[1] ?? pattern;
// "*.facebook.com" stands for www.facebook.com and facebook.com.
const samples = (host: string) =>
  host.startsWith("*.") ? [host.slice(2), `www.${host.slice(2)}`] : [host];
const bridgeHosts = manifest.content_scripts
  .filter((c) => c.js.includes("content/bridge.js"))
  .flatMap((c) => c.matches.map(hostOf));
const pageScriptHosts = manifest.content_scripts
  .filter((c) => !c.js.includes("content/bridge.js"))
  .flatMap((c) => c.matches.map(hostOf));

// Every host each app is used on (README table). A host listed here must be one sites.ts knows.
const APP_HOSTS: Record<string, string[]> = {
  gchat: ["chat.google.com", "mail.google.com"],
  meta: ["www.facebook.com", "facebook.com", "www.messenger.com", "messenger.com"],
  instagram: ["www.instagram.com", "instagram.com"],
  whatsapp: ["web.whatsapp.com"],
  teams: ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"],
};
// Hosts where Lurk blocks with network rules only, so no script runs and Stats cannot count there.
const RULES_ONLY: Record<string, string> = {
  "mail.google.com":
    "Chat in Gmail: rules.json blocks it; a content script on Gmail would widen the permissions",
};

test("C2: the app list, its hosts and the test's host table agree", () => {
  expect(Object.keys(APP_HOSTS).sort()).toEqual(SITES.map((s) => s.id).sort());
  for (const [id, hosts] of Object.entries(APP_HOSTS))
    for (const host of hosts) expect(siteFor(host)?.id, host).toBe(id);
});

test("C2: every host an app is used on runs the bridge and a page script (or is rules-only)", () => {
  const covered = (list: string[], host: string) =>
    list.some((pattern) => samples(pattern).includes(host));
  for (const host of Object.values(APP_HOSTS).flat()) {
    if (host in RULES_ONLY) {
      expect(covered(bridgeHosts, host), `${host} is listed as rules-only`).toBe(false);
      continue;
    }
    expect(covered(bridgeHosts, host), `bridge.js on ${host}`).toBe(true);
    expect(covered(pageScriptHosts, host), `page script on ${host}`).toBe(true);
  }
});

test("C2: every manifest host is a supported app and named in the privacy policy", () => {
  const privacy = read("site/privacy.html").replace(/\s+/g, " ");
  for (const pattern of new Set([...bridgeHosts, ...pageScriptHosts])) {
    for (const host of samples(pattern)) expect(siteFor(host), host).not.toBeNull();
    const named = pattern.replace(/^\*\./, "");
    expect(privacy.includes(named), `privacy.html names ${named}`).toBe(true);
  }
});
