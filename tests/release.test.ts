// scripts/release.mjs: version order and every version field it bumps.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bumpText, bumps, compareSemver, missingBrowsers } from "../scripts/release.mjs";

const root = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), "utf8");
const { version: current } = JSON.parse(read("manifest.json")) as { version: string };

test("versions compare numerically, not as strings", () => {
  expect(compareSemver("0.1.10", "0.1.9")).toBeGreaterThan(0);
  expect(compareSemver("0.2.0", "0.10.0")).toBeLessThan(0);
  expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
});

test("every version field is found exactly as often as expected and bumped", () => {
  for (const [file, pattern, count] of bumps(current)) {
    const bumped = bumpText(read(file), pattern, count, "9.9.9", file);
    expect(bumped.split("9.9.9").length - 1, file).toBe(count);
    expect(bumped.match(new RegExp(pattern.source, "g")), file).toBeNull();
  }
});

test("a field that moved or doubled fails loudly", () => {
  const [, pattern] = bumps("1.2.3")[0];
  expect(() => bumpText('{"name": "x"}', pattern, 1, "1.2.4", "manifest.json")).toThrow(
    /expected 1 match\(es\), found 0/,
  );
  expect(() =>
    bumpText('"version": "1.2.3" "version": "1.2.3"', pattern, 1, "1.2.4", "manifest.json"),
  ).toThrow(/found 2/);
});

test("the end-to-end gate's browsers are checked before anything is written", () => {
  expect(missingBrowsers({})).toEqual(["CHROME_BIN", "FIREFOX_BIN"]);
  expect(missingBrowsers({ CHROME_BIN: "/c", FIREFOX_BIN: "" })).toEqual(["FIREFOX_BIN"]);
  expect(missingBrowsers({ CHROME_BIN: "/c", FIREFOX_BIN: "/f" })).toEqual([]);
});
