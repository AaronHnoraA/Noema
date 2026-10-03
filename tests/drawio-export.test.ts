import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  drawioAttachmentP,
  drawioImageSrc,
  splitDrawioSource,
  visualAttachmentKind,
  visualMarkdownAttachmentP,
} from "../src/visual-attachments.ts";

const MEDIA = "aaronnote-asset://media?file=./attachments/demo.drawio&base=/notes/demo.md";

describe("draw.io references", () => {
  test("a .drawio file is a picture, never an embedded editor", () => {
    expect(drawioAttachmentP("./attachments/demo.drawio")).toBe(true);
    expect(drawioAttachmentP("./attachments/demo.dio")).toBe(true);
    expect(drawioAttachmentP("./attachments/demo.drawio.xml")).toBe(true);
    // The editor iframe is gone: nothing resolves to a "drawio" frame kind.
    expect(visualAttachmentKind("./attachments/demo.drawio")).toBeNull();
    expect(visualAttachmentKind("./attachments/panel.html")).toBe("html");
  });

  test("a .drawio.svg is already an image and stays on the image path", () => {
    expect(drawioAttachmentP("./attachments/demo.drawio.svg")).toBe(false);
    expect(drawioAttachmentP("./attachments/demo.drawio.png")).toBe(false);
    expect(visualMarkdownAttachmentP("./attachments/demo.drawio")).toBe(true);
  });

  test("a javascript: source is never treated as a diagram", () => {
    expect(drawioAttachmentP("javascript:alert(1)//x.drawio")).toBe(false);
  });

  test("the page marker is split off before the path is resolved", () => {
    expect(splitDrawioSource("a/b.drawio")).toEqual({ path: "a/b.drawio", page: 0 });
    expect(splitDrawioSource("a/b.drawio#page=1")).toEqual({ path: "a/b.drawio", page: 0 });
    expect(splitDrawioSource("a/b.drawio#page=3")).toEqual({ path: "a/b.drawio", page: 2 });
    expect(splitDrawioSource("a/b.drawio?page=2")).toEqual({ path: "a/b.drawio", page: 1 });
  });

  test("a Noema asset resolves to the export endpoint, carrying the page", () => {
    const url = new URL(drawioImageSrc(MEDIA, 2)!);
    expect(url.protocol).toBe("aaronnote-asset:");
    expect(url.hostname).toBe("drawio-svg");
    expect(url.searchParams.get("src")).toBe(MEDIA);
    expect(url.searchParams.get("page")).toBe("2");
  });

  test("the first page carries no page parameter", () => {
    const url = new URL(drawioImageSrc(MEDIA, 0)!);
    expect(url.searchParams.get("page")).toBeNull();
  });

  test("a diagram outside the vault has no exporter, so it gets no export URL", () => {
    expect(drawioImageSrc("https://example.com/demo.drawio", 0)).toBeNull();
  });
});

describe("the draw.io exporter's command line", () => {
  // These two arguments are each a bug this test exists to keep fixed:
  // draw.io counts pages from 1, and its default font embedding makes a simple
  // diagram roughly sixteen times larger (422 KB against 26 KB).
  test("asks for a 1-based page and no embedded fonts", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("server/lib/drawio-export.mjs", "utf8");
    expect(source).toContain('"-p", String(page + 1)');
    expect(source).toContain('"--embed-svg-fonts", "false"');
  });
});

describe("only the sheet follows the theme, never the diagram", () => {
  // The near-white sheet this asserts against is what glared in a dark editor.
  // Its colours were never the diagram's; the diagram's own are left alone.
  test("the figure sheet derives from the page surface", async () => {
    const { readFile } = await import("node:fs/promises");
    const theme = await readFile("src/styles/themes/theme-typora.css", "utf8");
    expect(theme).toContain("--note-figure-paper: var(--aaron-paper-soft");
    expect(theme).not.toContain("--note-figure-paper: #fbfaf7");
  });

  test("no figure surface restates color-scheme over a draw.io export", async () => {
    const { readFile } = await import("node:fs/promises");
    const widgets = await readFile("src/styles/widgets.css", "utf8");
    // draw.io's labels use light-dark() against the color-scheme its own SVG
    // root declares; restating it on the <img> resolves them to the wrong side.
    expect(widgets).not.toContain("color-scheme: light dark");
  });

  test("draw.io exports the authored colours, never an inverted theme", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("server/lib/drawio-export.mjs", "utf8");
    expect(source).toContain('"--svg-theme", "light"');
    expect(source).not.toContain("svgTheme");
  });

  test("Mermaid keeps its own palette", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/diagram-render.ts", "utf8");
    // Mermaid's own default theme for a plain diagram, and for an Aaron mind map
    // the palette its own frontmatter declares — nothing derived from the editor.
    expect(source).toContain('theme: "default"');
    expect(source).not.toContain("themeVariables: ");
    expect(source).not.toContain("diagramThemeVariables");
  });
});
