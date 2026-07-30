import { defineConfig } from "vite-plus";
import { resolve } from "node:path";

// Lib mode build — produces a treeshakeable ESM bundle of the editor
// from src/lib.ts. Tests/website are not on this build's import graph,
// so the output stays lean. Markdown packages stay external.

export default defineConfig({
  // No public assets — the lib doesn't ship a favicon.
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, "src/lib.ts"),
      formats: ["es"],
      fileName: "typora-web",
    },
    outDir: "dist/lib",
    emptyOutDir: true,
    rollupOptions: {
      external: [
        "markdown-it",
        /^markdown-it-/,
        /^@codemirror\//,
        /^@lezer\//,
      ],
    },
  },
});
