import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { parseCodeInfo } from "../src/code-info.ts";

describe("code fence info string", () => {
  test("language, title and highlighted lines", () => {
    const info = parseCodeInfo('python title="ridge.py" {2-3,5} max-lines=4');
    expect(info).toMatchObject({ lang: "python", langFrom: 0, langTo: 6, title: "ridge.py", highlight: [2, 3, 5] });
  });

  test("a bare language is still just a language", () => {
    expect(parseCodeInfo("  ts")).toMatchObject({ lang: "ts", langFrom: 2, langTo: 4, title: "", highlight: [] });
  });

  test("attributes without a language, and single-quoted or bare titles", () => {
    expect(parseCodeInfo('{1} title=main.go')).toMatchObject({ lang: "", title: "main.go", highlight: [1] });
    expect(parseCodeInfo("js title='a b.js'").title).toBe("a b.js");
  });

  test("bad and huge ranges are ignored, duplicates merged", () => {
    expect(parseCodeInfo("c {3-1,0,2,2,1-99999999}").highlight).toEqual([2]);
  });
});

describe("code fence attributes in the editor", () => {
  test("highlighted lines get a line class, the title a caption, and the language still highlights", async () => {
    const { createEditor } = await import("../src/editor-api.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, {
      initialContent: 'intro\n\n```python title="ridge.py" {2}\na = 1\nb = 2\nc = 3\n```\n\nafter',
    });
    try {
      editor.setMarkdownSelection(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const marked = [...host.querySelectorAll(".cm-line.cm-code-line-highlight")].map((line) => line.textContent);
      expect(marked).toEqual(["b = 2"]);
      expect(host.querySelector(".cm-code-file-title")?.textContent).toBe("ridge.py");
      expect(host.querySelector(".cm-code-lang-badge")?.textContent).toBe("python");
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});

describe("code fence attributes in exported HTML", () => {
  test("the title is a caption, the language alone reaches the code class", async () => {
    const { renderMarkdownHTML } = await import("../src/render-html.ts");
    const html = renderMarkdownHTML('```python title="a<b>.py" {2}\nx = 1\ny = 2\n```\n');
    expect(html).toContain('<figure class="noema-code" data-highlight-lines="2">');
    expect(html).toContain('<figcaption class="noema-code-title">a&lt;b&gt;.py</figcaption>');
    expect(html).toMatch(/class="[^"]*language-python[^"]*"/);
    expect(html).not.toContain("title=&quot;");
  });
});
