import { defineConfig } from "vite-plus";
import { resolve } from "node:path";

export default defineConfig(({ command }) => ({
  root: "aaronnote",
  base: command === "build" ? "./" : "/",
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [resolve("."), resolve("..")],
    },
  },
  build: {
    outDir: "../dist/aaronnote",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    modulePreload: {
      resolveDependencies(filename, deps) {
        if (filename.includes("diagram-render") || filename.includes("index-")) {
          return deps.filter((dep) =>
            !dep.includes("vendor-diagram")
            && !dep.includes("vendor-d3")
            && !dep.includes("vendor-layout")
            && !dep.includes("vendor-cytoscape")
            && !dep.includes("vendor-rough")
            && !dep.includes("mermaid"));
        }
        return deps;
      },
    },
    rolldownOptions: {
      input: {
        index: resolve("aaronnote/index.html"),
        agenda: resolve("aaronnote/agenda.html"),
        slides: resolve("aaronnote/slides.html"),
      },
      checks: {
        eval: false,
      },
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return undefined;
          if (id.includes("/node_modules/@codemirror/") || id.includes("/node_modules/@lezer/")) {
            return "vendor-editor";
          }
          if (id.includes("/node_modules/katex")) return "vendor-katex";
          if (id.includes("/node_modules/dompurify") || id.includes("/node_modules/turndown")) return "vendor-sanitize";
          if (id.includes("/node_modules/d3")) return "vendor-d3";
          if (
            id.includes("/node_modules/dagre") ||
            id.includes("/node_modules/elkjs")
          ) return "vendor-layout";
          if (id.includes("/node_modules/cytoscape")) return "vendor-cytoscape";
          if (
            id.includes("/node_modules/khroma") ||
            id.includes("/node_modules/roughjs")
          ) return "vendor-rough";
          if (
            id.includes("/node_modules/markdown-it") ||
            id.includes("/node_modules/markdown-it-emoji") ||
            id.includes("/node_modules/linkify-it") ||
            id.includes("/node_modules/mdurl") ||
            id.includes("/node_modules/entities") ||
            id.includes("/node_modules/uc.micro")
          ) {
            return "vendor-markdown";
          }
          return undefined;
        },
      },
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
}));
