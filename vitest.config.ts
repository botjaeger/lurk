// Unit tests (tests/*.test.ts) in plain Node: the pure parts of src/ and scripts/. The extension in a
// real browser is tested by tests/e2e/ (pnpm e2e, pnpm e2e:firefox).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/*.test.ts"],
  },
});
