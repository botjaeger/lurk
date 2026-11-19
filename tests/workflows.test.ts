// .github/workflows: every workflow is read-only by default; a job that needs more asks for it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

/** The lines of the top-level `permissions:` block, or null when the workflow has none. */
function topLevelPermissions(text: string): string[] | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^permissions:/.test(line));
  if (start === -1) return null;
  const inline = lines[start].slice("permissions:".length).trim();
  if (inline) return [inline];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    block.push(line.trim());
  }
  return block;
}

test("workflows exist", () => {
  expect(workflows.length).toBeGreaterThan(0);
});

test.each(workflows)("%s: top-level permissions are read-only", (name) => {
  const permissions = topLevelPermissions(readFileSync(join(dir, name), "utf8"));
  expect(permissions, `${name} has no top-level permissions block`).not.toBeNull();
  expect(permissions?.filter((line) => /write|write-all/.test(line))).toEqual([]);
});
