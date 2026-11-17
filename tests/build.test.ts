// Per-browser manifests and the file list behind scripts/build.mjs.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ASSETS, FILES, SCRIPTS, manifestFor, merge } from "../scripts/build.mjs";

// The parts of a manifest these tests read.
interface Manifest {
  background: { service_worker?: string; scripts?: string[] };
  action: { default_popup: string; default_icon: Record<string, string> };
  icons: Record<string, string>;
  declarative_net_request: { rule_resources: { path: string }[] };
  content_scripts: { js: string[] }[];
  browser_specific_settings?: {
    gecko?: { id: string; data_collection_permissions: unknown };
    safari?: { strict_min_version: string };
  };
}
const manifest = (target: string) => manifestFor(target) as Manifest;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const base = JSON.parse(read("manifest.json")) as Manifest;
const assets = ASSETS as Record<string, string>;
const scripts = SCRIPTS as Record<string, string>;
const files = FILES;

test("Chrome build uses manifest.json unchanged", () => {
  expect(manifest("chrome")).toEqual(base);
});

test("Firefox build: a background script instead of a service worker, gecko id", () => {
  const m = manifest("firefox");
  expect(m.background).toEqual({ scripts: ["background.js"] });
  expect(m.browser_specific_settings?.gecko?.id).toBe("lurk@botjaeger");
  expect(m.browser_specific_settings?.gecko?.data_collection_permissions).toEqual({
    required: ["none"],
  });
  expect(m.content_scripts).toEqual(base.content_scripts);
  expect(m.declarative_net_request).toEqual(base.declarative_net_request);
});

test("Safari build keeps the service worker and adds its minimum version", () => {
  const m = manifest("safari");
  expect(m.background).toEqual(base.background);
  expect(m.browser_specific_settings?.safari?.strict_min_version).toBe("26.0");
});

test("merge: null removes a key, objects merge, arrays and values replace", () => {
  expect(
    merge({ a: { b: 1, c: 2 }, d: [1], e: 1 }, { a: { c: null, x: 3 }, d: [2], e: 2 }),
  ).toEqual({ a: { b: 1, x: 3 }, d: [2], e: 2 });
});

test("every file a manifest names is in the build, and every build source exists", () => {
  for (const source of [...Object.values(assets), ...Object.values(scripts)])
    expect(existsSync(new URL(`../${source}`, import.meta.url)), source).toBe(true);
  for (const target of ["chrome", "firefox", "safari"]) {
    const m = manifest(target);
    const named = [
      m.background.service_worker,
      ...(m.background.scripts || []),
      m.action.default_popup,
      ...Object.values(m.action.default_icon),
      ...Object.values(m.icons),
      ...m.declarative_net_request.rule_resources.map((r) => r.path),
      ...m.content_scripts.flatMap((c) => c.js),
    ].filter((file): file is string => Boolean(file));
    for (const file of named)
      expect(files, `${target}: ${file} missing from FILES`).toContain(file);
  }
  // Every script and stylesheet popup.html loads is in the build.
  const popup = read(assets["popup.html"]);
  const loaded = [...popup.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(loaded.sort()).toEqual(["popup.css", "popup.js"]);
  for (const file of loaded) expect(files, `popup.html: ${file} missing`).toContain(file);
});

test("every TypeScript entry is bundled into its own script", () => {
  expect(Object.keys(scripts).sort()).toEqual([
    "background.js",
    "content/bridge.js",
    "content/gchat.js",
    "content/page.js",
    "content/whatsapp.js",
    "popup.js",
  ]);
  for (const [file, source] of Object.entries(scripts))
    expect(source.replace(/^src\/(popup\/)?/, "").replace(/\.ts$/, ".js")).toBe(file);
});
