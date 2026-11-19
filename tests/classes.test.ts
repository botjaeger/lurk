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
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
  const literal = (body: string, prop: string) => {
    const value = new RegExp(`(?:^|[;\\s])${prop}: (#[0-9a-f]{3}(?:[0-9a-f]{3})?);`, "i").exec(
      body,
    )?.[1];
    return value?.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
  };
  // The popup replica keeps the popup's light colours: its text sits on the card or on a row.
  const replica = rules.find((r) => r.selector === ".replica")?.body ?? "";
  const replicaSurfaces = [literal(replica, "background"), "#f0f3ef"];
  for (const { selector, body } of rules) {
    const fg = literal(body, "color");
    if (!fg) continue;
    const bg = literal(body, "background");
    // A literal text colour on its own literal background (avatar, bubbles, replica hero, status).
    const on = bg ? [bg] : selector.startsWith(".replica") ? replicaSurfaces : [];
    for (const surface of on)
      expect(contrast(fg, surface!), `${selector}: ${fg} on ${surface}`).toBeGreaterThanOrEqual(
        4.5,
      );
  }
  // Text faded with opacity: its token colour, blended into each surface, still meets 4.5:1.
  for (const { selector, body } of rules) {
    const alpha = /opacity: ([\d.]+);/.exec(body)?.[1];
    const token = /\bcolor: var\(--([\w-]+)\)/.exec(body)?.[1];
    if (!alpha || !token) continue;
    for (const surface of surfaces) {
      const [f, b] = [hex(t[token]), hex(surface)];
      const mixed = `#${f
        .map((v, i) =>
          Math.round(v * +alpha + b[i] * (1 - +alpha))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
      expect(
        contrast(mixed, surface),
        `${selector}: --${token} at ${alpha} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
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

// ---- C8: the website's static copy contradicts the store states in site/src/release.ts ----------
// main.ts rewrites the cards at load; the HTML must already say the same, for a visitor without
// scripts, a crawler and a link preview.
test("C8: each store card and the hero pill match release.ts", () => {
  const release = read("site/src/release.ts");
  const stores = [...release.matchAll(/(\w+): \{([^}]*)\}/g)].map(([, id, body]) => ({
    id,
    name: /name: "([^"]+)"/.exec(body)?.[1] ?? "",
    store: /store: "([^"]+)"/.exec(body)?.[1] ?? "",
    state: /state: "(live|pending)"/.exec(body)?.[1] ?? "",
    url: /url: "([^"]+)"/.exec(body)?.[1],
  }));
  expect(stores.map((s) => s.id)).toEqual(["chrome", "firefox", "safari"]);
  const html = read("site/index.html").replace(/\s+/g, " ");
  for (const s of stores) {
    const card = new RegExp(`data-store="${s.id}"(.*?)</div>`).exec(html)?.[1] ?? "";
    const status = /data-store-status>([^<]*)</.exec(card)?.[1].trim();
    const link = /<a ([^>]*data-store-link[^>]*)>/.exec(card)?.[1] ?? "";
    if (s.state === "live") {
      expect(s.url, `${s.id} url`).toMatch(/^https:\/\//);
      expect(status, s.id).toBe(`On the ${s.store}`);
      expect(link, s.id).toContain(`href="${s.url}"`);
      expect(link, s.id).not.toMatch(/\bhidden\b/);
    } else {
      expect(status, s.id).not.toMatch(/^On the /);
      expect(link, s.id).toMatch(/\bhidden\b/);
    }
  }
  const pill = /<span class="pill-dot"><\/span>([^<]*)</.exec(html)?.[1] ?? "";
  const soon = /([^·]*) soon\s*$/.exec(pill)?.[1] ?? "";
  for (const s of stores)
    if (s.state === "live")
      expect(pill.replace(soon, ""), `pill: ${s.name} live`).toContain(s.name);
    else expect(soon, `pill: ${s.name} soon`).toContain(s.name);
});

test("C2: every host a network rule acts on is named in the privacy policy", () => {
  const privacy = read("site/privacy.html").replace(/\s+/g, " ");
  interface Rule {
    condition: { regexFilter?: string; urlFilter?: string; requestDomains?: string[] };
  }
  const hosts = ["rules.json", "rules-typing.json"].flatMap((file) =>
    (JSON.parse(read(file)) as Rule[]).flatMap(({ condition: c }) => {
      if (c.requestDomains) return c.requestDomains;
      // "^https://(chat|mail)\.google\.com/…" names chat.google.com and mail.google.com.
      const m = /^\^https:\/\/(?:\(([\w|]+)\))?((?:\\\.|[\w-])+)\//.exec(c.regexFilter ?? "");
      expect(m, `a rule without a readable host: ${JSON.stringify(c)}`).not.toBeNull();
      const rest = m![2].replace(/\\\./g, ".");
      return m![1] ? m![1].split("|").map((sub) => sub + rest) : [rest];
    }),
  );
  expect(hosts).toContain("mail.google.com");
  for (const host of new Set(hosts))
    expect(privacy.includes(host), `privacy.html names ${host}`).toBe(true);
});

// ---- C9: website content wider than a zoomed phone, cut off by body's overflow-x: clip ----------
// At 200% zoom a 390 px phone is 195 CSS px wide. body clips overflow, so anything wider is lost
// without a scrollbar. Grid tracks must be able to shrink, long words must wrap, and nothing on a
// narrow screen may have a fixed width over 195 px.
test("C9: website layout shrinks to 195 CSS px", () => {
  const css = read("site/src/style.css");
  const tracks = [...css.matchAll(/grid-template-columns: ([^;]+);/g)].map((m) => m[1]);
  for (const value of tracks)
    expect(value.replace(/minmax\([^)]*\)/g, ""), `grid track "${value}"`).not.toMatch(/\dfr/);
  const body = /\nbody \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(body).toMatch(/overflow-wrap: (break-word|anywhere);/);
  // Inside the narrow-screen media queries, no bare fixed width wider than the zoomed phone.
  for (const block of css.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g))
    for (const m of block[2].matchAll(/(?:^|[\s;])(?:min-)?width: (\d+)px;/g))
      expect(+m[1], `@media ${block[1]}px: width ${m[1]}px`).toBeLessThanOrEqual(195);
});

// ---- C10: a native patch that rebuilds the caller's arguments ------------------------------------
// The page's natives (fetch, XHR, WebSocket.send, postMessage, crypto.subtle.encrypt, the page's own
// hooks) are called with the caller's arguments and `this` passed on as given: `native.apply(this,
// args)`. Rebuilding them (`native.call(this, a, b)`) turns `ws.send()` into a sent "undefined" and
// `open(method, url, undefined)` into a synchronous request.
test("C10: every patched native takes ...args and passes them on with apply", () => {
  const offenders: string[] = [];
  for (const file of sources("src/content")) {
    const lines = read(file).split("\n");
    lines.forEach((line, i) => {
      if (/\b(native\w*|chained\b.*)\.call\(/.test(line))
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      // A patch: `x.y = function name(` (or a returned `function name(`) whose signature, within
      // the next lines, must take ...args.
      if (/(=|return|=>)\s*function \w+\(/.test(line) || /^\s+function \w+\(this/.test(line)) {
        const signature = lines.slice(i, i + 4).join(" ");
        if (!/\.\.\.args/.test(signature.slice(0, signature.indexOf("{") + 1 || undefined)))
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  expect(offenders, "take ...args and call native.apply(this, args)").toEqual([]);
});

// ---- C12: a request classified by what someone wrote, or by a call that only reads ---------------
test("C12: frames.ts classify() reads names and keys, never a body's free text", () => {
  const source = read("src/content/frames.ts");
  const classify = source.slice(source.indexOf("export function classify("));
  // Free-text searches of the body; TEAMS_TYPING is allowed only behind the Teams messages URL.
  expect(classify).not.toMatch(/body\.(toLowerCase\(\)\.)?includes\(|lowerBody/);
  expect(classify).toMatch(/TEAMS_MESSAGES\.test\(url\) && [^\n]*TEAMS_TYPING\.test\(body\)/);
  // URL checks for a marking call require its method.
  for (const m of classify.matchAll(/\/\\\/[^\n]*?\.test\(url\)/g))
    expect(classify.slice(Math.max(0, m.index - 40), m.index), m[0]).toMatch(/post &&|PUT/);
});
