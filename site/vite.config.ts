import { defineConfig } from "vite";
import { resolve } from "node:path";

// Static multi-page site: home, privacy policy, terms. Output in dist/, published to GitHub Pages.
// base "./" keeps every link relative, so it works at user.github.io/<repo>/ and on a custom domain.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
      },
    },
  },
});
