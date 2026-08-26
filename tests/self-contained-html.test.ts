// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  collectDocumentStyles,
  createSelfContainedNoteHTML,
  inlineStylesheetResources,
} from "../src/self-contained-html.ts";

afterEach(() => document.head.replaceChildren());

describe("self-contained HTML export", () => {
  test("collects readable runtime styles and embeds their resources", async () => {
    const style = document.createElement("style");
    style.textContent = '@font-face { font-family: Demo; src: url("/fonts/demo.woff2") } .note { color: red }';
    document.head.appendChild(style);
    const css = collectDocumentStyles(document);
    expect(css).toContain("font-family: Demo");
    expect(css).toContain(".note");
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "font/woff2" },
    }));
    const inlined = await inlineStylesheetResources(css, {
      baseUrl: "http://noema.test/note",
      fetch: fetcher as typeof fetch,
    });
    expect(inlined).toContain("data:font/woff2;base64,AQID");
    expect(inlined).not.toContain("/fonts/demo.woff2");
  });

  test("exports a themed offline document with embedded images and no runtime assets", async () => {
    const style = document.createElement("style");
    style.textContent = ":root { --ink: #123; } #content { color: var(--ink); }";
    document.head.appendChild(style);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://noema.test/assets/pixel.png");
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    const html = await createSelfContainedNoteHTML("# Offline\n\n![Pixel](assets/pixel.png)", {
      title: "Offline",
      themeId: "mediki",
      alternateThemeId: "aaronnote",
      document,
      baseUrl: "http://noema.test/note",
      assetResolver: (source) => new URL(source, "http://noema.test/").toString(),
      fetch: fetcher as typeof fetch,
    });

    expect(html).toContain('data-noema-theme="mediki"');
    expect(html).toContain("data-noema-self-contained");
    expect(html).toContain("data:image/png;base64,iVBORw==");
    expect(html).toContain("data-standalone-theme");
    expect(html).toContain("data-published-toc");
    expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet/iu);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/iu);
    expect(html).not.toContain("http://noema.test/assets/pixel.png");
  });

  test("replaces an unavailable external image instead of retaining a hidden dependency", async () => {
    const html = await createSelfContainedNoteHTML("![Remote](https://example.invalid/image.png)", {
      title: "Offline",
      document,
      baseUrl: "http://noema.test/note",
      fetch: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch,
    });
    expect(html).toContain("data-noema-export-missing=\"true\"");
    expect(html).not.toContain("example.invalid/image.png");
  });
});
