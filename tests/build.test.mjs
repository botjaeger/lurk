// Per-browser manifests and the file list behind scripts/build.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ASSETS, FILES, SCRIPTS, manifestFor, merge } from "../scripts/build.mjs";

const base = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("Chrome build uses manifest.json unchanged", () => {
  assert.deepEqual(manifestFor("chrome"), base);
});

test("Firefox build: a background script instead of a service worker, gecko id", () => {
  const m = manifestFor("firefox");
  assert.deepEqual(m.background, { scripts: ["background.js"] });
  assert.equal(m.browser_specific_settings.gecko.id, "lurk@botjaeger");
  assert.deepEqual(m.browser_specific_settings.gecko.data_collection_permissions, {
    required: ["none"],
  });
  assert.deepEqual(m.content_scripts, base.content_scripts);
  assert.deepEqual(m.declarative_net_request, base.declarative_net_request);
});

test("Safari build keeps the service worker and adds its minimum version", () => {
  const m = manifestFor("safari");
  assert.deepEqual(m.background, base.background);
  assert.equal(m.browser_specific_settings.safari.strict_min_version, "26.0");
});

test("merge: null removes a key, objects merge, arrays and values replace", () => {
  assert.deepEqual(
    merge({ a: { b: 1, c: 2 }, d: [1], e: 1 }, { a: { c: null, x: 3 }, d: [2], e: 2 }),
    { a: { b: 1, x: 3 }, d: [2], e: 2 },
  );
});

test("every file a manifest names is in the build, and every build source exists", () => {
  for (const source of [...Object.values(ASSETS), ...Object.values(SCRIPTS)])
    assert.ok(existsSync(new URL(`../${source}`, import.meta.url)), source);
  for (const target of ["chrome", "firefox", "safari"]) {
    const m = manifestFor(target);
    const named = [
      m.background.service_worker,
      ...(m.background.scripts || []),
      m.action.default_popup,
      ...Object.values(m.action.default_icon),
      ...Object.values(m.icons),
      ...m.declarative_net_request.rule_resources.map((r) => r.path),
      ...m.content_scripts.flatMap((c) => c.js),
    ].filter(Boolean);
    for (const file of named)
      assert.ok(FILES.includes(file), `${target}: ${file} missing from FILES`);
  }
  // Every script and stylesheet popup.html loads is in the build.
  const popup = readFileSync(new URL(`../${ASSETS["popup.html"]}`, import.meta.url), "utf8");
  const loaded = [...popup.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(loaded.sort(), ["popup.css", "popup.js"]);
  for (const file of loaded) assert.ok(FILES.includes(file), `popup.html: ${file} missing`);
});

test("every TypeScript entry is bundled into its own script", () => {
  assert.deepEqual(Object.keys(SCRIPTS).sort(), [
    "background.js",
    "content/bridge.js",
    "content/gchat.js",
    "content/page.js",
    "content/whatsapp.js",
    "popup.js",
  ]);
  for (const [file, source] of Object.entries(SCRIPTS))
    assert.equal(source.replace(/^src\/(popup\/)?/, "").replace(/\.ts$/, ".js"), file);
});
