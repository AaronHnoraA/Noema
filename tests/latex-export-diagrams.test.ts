import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-expect-error -- plain .mjs server module, as the other server tests import it
import { diagramKey, prepareLatexDiagrams, scanDiagramFences } from "../server/lib/latex-export-diagrams.mjs";
import { exportDiagramFences, exportDiagramKey } from "../aaronnote/export-diagrams.ts";
import { diagramFenceKey, renderMarkdownHTML } from "../src/render-html.ts";

const NOTE = [
  "# Note",
  "",
  "```marmind",
  "Root",
  "  Branch",
  "```",
  "",
  "![Map](attachments/map.drawio)",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "~~~mermaid",
  "graph LR",
  "A-->B",
  "~~~",
  "",
].join("\n");

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>Root</text></svg>';

describe("diagram fences an export has to turn into pictures", () => {
  test("the server finds every diagram fence and leaves other code alone", () => {
    expect(scanDiagramFences(NOTE).map((fence: { lang: string }) => fence.lang)).toEqual(["marmind", "mermaid"]);
    expect(scanDiagramFences(NOTE)[0]!.source).toBe("Root\n  Branch");
  });

  test("the page finds the same fences", () => {
    expect(exportDiagramFences(NOTE).map((fence) => fence.lang)).toEqual(["marmind", "mermaid"]);
    expect(exportDiagramFences(NOTE)[1]!.source).toBe("graph LR\nA-->B");
  });

  // The page renders the pictures and the server files them; if the two sides
  // computed identity differently every diagram would silently stay source.
  test("page and server agree on a fence's identity", async () => {
    for (const fence of exportDiagramFences(NOTE)) {
      expect(await exportDiagramKey(fence.lang, fence.source)).toBe(diagramKey(fence.lang, fence.source));
    }
    expect(diagramKey("MARMIND", " Root ")).toBe(diagramKey("marmind", "Root"));
  });
});

describe("preparing a LaTeX export", () => {
  test("a fence with no supplied picture stays source and is reported", async () => {
    const result = await prepareLatexDiagrams(NOTE, { sourceDir: "/nowhere" });
    expect(result.markdown).toContain("```marmind");
    expect(result.files).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("marmind");
    expect(result.warnings.join("\n")).toContain("mermaid");
  });

  test("a draw.io file that cannot be exported is reported, not silently dropped", async () => {
    const result = await prepareLatexDiagrams("![Map](missing.drawio)\n", { sourceDir: "/nowhere" });
    expect(result.markdown).toContain("missing.drawio");
    expect(result.warnings.join("\n")).toContain("missing.drawio");
  });

  test("an unknown fence language is never touched", async () => {
    const source = "```python\nprint(1)\n```\n";
    const result = await prepareLatexDiagrams(source, { sourceDir: "/nowhere" });
    expect(result.markdown.trim()).toBe(source.trim());
    expect(result.warnings).toEqual([]);
  });
});

describe("diagrams in exported HTML", () => {
  test("a supplied picture is inlined, and without one the source stays readable", () => {
    const markdown = "```marmind\nRoot\n  Branch\n```\n";
    const withPicture = renderMarkdownHTML(markdown, {
      diagrams: { [diagramFenceKey("marmind", "Root\n  Branch\n")]: SVG },
    });
    expect(withPicture).toContain("<svg");
    expect(withPicture).toContain("aaronnote-diagram-figure");
    expect(withPicture).not.toContain("<code");

    const without = renderMarkdownHTML(markdown);
    expect(without).not.toContain("<svg");
    expect(without).toContain("Root");
  });

  test("a supplied picture is still sanitized", () => {
    const markdown = "```marmind\nRoot\n```\n";
    const html = renderMarkdownHTML(markdown, {
      diagrams: {
        [diagramFenceKey("marmind", "Root\n")]:
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>Root</text></svg>',
      },
    });
    expect(html).toContain("<svg");
    expect(html).not.toContain("alert(1)");
  });

  test("a draw.io figure carries its own path so a published file can inline it", () => {
    const html = renderMarkdownHTML("![Map](attachments/map.drawio#page=2)");
    // The export URL only resolves against a live host; the path is what lets
    // the publish step put the SVG into a standalone file.
    expect(html).toContain('data-aaronnote-drawio-src="attachments/map.drawio"');
    expect(html).toContain('data-aaronnote-drawio-page="1"');
  });
});
