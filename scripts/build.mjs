// Builds one copy of the extension per browser:
//   dist/chrome   + dist/lurk-chrome.zip   (Chrome, Edge, Brave: manifest.json as is)
//   dist/firefox  + dist/lurk-firefox.zip  (manifest.json merged with manifest.firefox.json)
//   dist/safari                            (manifest.json merged with manifest.safari.json; the
//                                           Xcode project in safari/ wraps it into a Mac app)
// Usage: node scripts/build.mjs [chrome|firefox|safari ...]   (no argument: all three)
// The TypeScript in src/ is bundled by esbuild: one self-contained classic script (IIFE) per entry,
// not minified, so store reviewers can read it. Types are checked separately (pnpm typecheck).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// Bundled scripts: build path -> TypeScript entry.
export const SCRIPTS = {
  "background.js": "src/background.ts",
  "popup.js": "src/popup/popup.ts",
  "content/page.js": "src/content/page.ts",
  "content/bridge.js": "src/content/bridge.ts",
  "content/whatsapp.js": "src/content/whatsapp.ts",
  "content/gchat.js": "src/content/gchat.ts",
};

// Copied as they are: build path -> source path. Includes the licences.
export const ASSETS = {
  LICENSE: "LICENSE",
  "THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
  "rules.json": "rules.json",
  "rules-typing.json": "rules-typing.json",
  "popup.html": "src/popup/popup.html",
  "popup.css": "src/popup/popup.css",
  "icons/icon-16.png": "icons/icon-16.png",
  "icons/icon-32.png": "icons/icon-32.png",
  "icons/icon-48.png": "icons/icon-48.png",
  "icons/icon-128.png": "icons/icon-128.png",
};

// Everything the extension holds at run time, besides manifest.json.
export const FILES = [...Object.keys(ASSETS), ...Object.keys(SCRIPTS)];

const OVERLAYS = { chrome: null, firefox: "manifest.firefox.json", safari: "manifest.safari.json" };
const ZIPPED = new Set(["chrome", "firefox"]);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// Overlay keys replace or extend the base; null removes a key (Firefox has no service_worker).
export function merge(base, overlay) {
  if (!isObject(base) || !isObject(overlay)) return overlay;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) delete out[key];
    else out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

const readJson = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

export function manifestFor(target) {
  const base = readJson("manifest.json");
  return OVERLAYS[target] ? merge(base, readJson(OVERLAYS[target])) : base;
}

function build(target) {
  const out = join(dist, target);
  rmSync(out, { recursive: true, force: true });
  for (const [file, source] of Object.entries(ASSETS)) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    cpSync(join(root, source), join(out, file));
  }
  buildSync({
    entryPoints: Object.entries(SCRIPTS).map(([file, source]) => ({
      in: join(root, source),
      out: file.replace(/\.js$/, ""),
    })),
    outdir: out,
    bundle: true,
    format: "iife",
    target: "es2022",
    platform: "browser",
    charset: "utf8",
    logLevel: "warning",
  });
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifestFor(target), null, 2)}\n`);
  let line = `dist/${target}`;
  if (ZIPPED.has(target)) {
    const zip = join(dist, `lurk-${target}.zip`);
    rmSync(zip, { force: true });
    execFileSync("zip", ["-qrX", zip, "."], { cwd: out });
    line += ` + dist/lurk-${target}.zip`;
  }
  console.log(`built ${line} (${FILES.length + 1} files)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  for (const target of targets) {
    if (!(target in OVERLAYS)) {
      console.error(`Unknown target "${target}". Use chrome, firefox or safari.`);
      process.exit(1);
    }
  }
  for (const target of targets.length ? targets : Object.keys(OVERLAYS)) build(target);
}
