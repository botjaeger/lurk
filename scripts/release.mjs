#!/usr/bin/env node
// Bumps every version field, runs the local gate, commits, tags v<version> and pushes. The tag push
// triggers .github/workflows/release.yml, which publishes to the Chrome Web Store and
// addons.mozilla.org and creates the GitHub release. Same process as botjaeger/brainrot.
//
// Usage: pnpm release <version> [--dry-run]
// The gate needs CHROME_BIN and FIREFOX_BIN (AGENTS.md, "Commands").
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((arg) => !arg.startsWith("--"));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command) {
  console.log(`$ ${command}`);
  execSync(command, { cwd: rootDir, stdio: "inherit" });
}

function output(command) {
  return execSync(command, { cwd: rootDir, encoding: "utf8" }).trim();
}

/**
 * Negative, zero or positive, like a sort comparator, for two major.minor.patch versions.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Every version field, with how many times its pattern must match (a moved field fails loudly).
 * @param {string} current
 * @returns {Array<[string, RegExp, number]>}
 */
export function bumps(current) {
  const escaped = current.replaceAll(".", "\\.");
  const json = new RegExp(`("version": ")${escaped}(")`);
  return [
    ["manifest.json", json, 1],
    ["package.json", json, 1],
    ["site/package.json", json, 1],
    [
      "safari/Lurk/Lurk.xcodeproj/project.xcproj",
      new RegExp(`("MARKETING_VERSION": ")${escaped}(")`),
      2,
    ],
  ];
}

/**
 * `text` with every match of `pattern` set to `version`; throws unless it matched `count` times.
 * @param {string} text
 * @param {RegExp} pattern
 * @param {number} count
 * @param {string} version
 * @param {string} file
 * @returns {string}
 */
export function bumpText(text, pattern, count, version, file) {
  const all = new RegExp(pattern.source, "g");
  const found = (text.match(all) ?? []).length;
  if (found !== count) throw new Error(`${file}: expected ${count} match(es), found ${found}`);
  return text.replace(all, (_, before, after) => `${before}${version}${after}`);
}

/**
 * The browser variables the end-to-end gate needs that `env` lacks.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function missingBrowsers(env) {
  return ["CHROME_BIN", "FIREFOX_BIN"].filter((name) => !env[name]);
}

function main() {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail("usage: pnpm release <major.minor.patch> [--dry-run]");
  }
  const current = JSON.parse(readFileSync(resolve(rootDir, "manifest.json"), "utf8")).version;
  if (compareSemver(version, current) <= 0) {
    fail(`${version} is not greater than the current version ${current}`);
  }
  if (!dryRun && output("git status --porcelain") !== "") {
    fail("working tree is not clean; commit or stash first");
  }
  if (!dryRun) {
    run("git fetch --quiet origin");
    const behind = output("git rev-list --count HEAD..@{upstream}");
    if (behind !== "0") fail(`branch is ${behind} commit(s) behind its upstream; pull first`);
  }
  const missing = dryRun ? [] : missingBrowsers(process.env);
  if (missing.length) fail(`set ${missing.join(" and ")} for the end-to-end gate (AGENTS.md)`);

  /** path -> [original text, bumped text] */
  const files = new Map();
  for (const [file, pattern, count] of bumps(current)) {
    const path = resolve(rootDir, file);
    const original = files.get(path)?.[0] ?? readFileSync(path, "utf8");
    try {
      files.set(path, [original, bumpText(original, pattern, count, version, file)]);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    console.log(`${file}: ${current} -> ${version}`);
  }

  if (dryRun) {
    console.log("dry run: no files written, nothing committed or pushed");
    return;
  }
  for (const [path, [, bumped]] of files) writeFileSync(path, bumped);

  try {
    run("pnpm check");
    run("pnpm e2e");
    run("pnpm e2e:firefox");
  } catch {
    // Put every version field back, so the tree is clean and the release can simply be re-run.
    for (const [path, [original]] of files) writeFileSync(path, original);
    fail(`the gate failed; version fields restored to ${current}, nothing committed`);
  }

  const tag = `v${version}`;
  run(`git commit -am "chore(release): ${version}"`);
  run(`git tag ${tag}`);
  run("git push origin HEAD");
  run(`git push origin ${tag}`);
  console.log(`Pushed ${tag}. Store publishing runs in GitHub Actions.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
