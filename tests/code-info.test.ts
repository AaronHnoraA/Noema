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
    expect(parseCodeInfo("c {3-1,0,2,2,1-99999999,9007199254740992}").highlight).toEqual([2]);
  });

  test("opts in to fence controls and separates quoted titles from options", () => {
    const info = parseCodeInfo('ts title="/filename/ {800} :no-line-numbers" line-numbers=98 :collapsed-lines=4 /store key/ whitespace indent-guides {2}');
    expect(info).toMatchObject({lang:"ts", title:"/filename/ {800} :no-line-numbers", highlight:[2], numbers:98,
      collapsedLines:4, words:["store key"], whitespace:true, indentGuides:true});
    expect(parseCodeInfo(":line-numbers :collapsed-lines no-line-numbers :no-collapsed-lines")).toMatchObject({lang:"", numbers:null, collapsedLines:null});
    expect(parseCodeInfo("ts collapsed-lines line-numbers")).toMatchObject({numbers:1, collapsedLines:15});
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

  test("reveals a code annotation at the caret and only folds the configured tail", async () => {
    const { createEditor } = await import("../src/editor-api.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const source = "Before\n\n```js title=history.js line-numbers=8 collapsed-lines=2 whitespace indent-guides /state/\n"
      + "    const state = 1; // [!code focus:1]\n    const last = state; // [!code ++]\n"
      + "    throw state; // [!code error]\n    last();\n```\n\nAfter.";
    const editor = createEditor(host, { initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      const rows = () => [...host.querySelectorAll<HTMLElement>(".cm-line[data-code-number]")];
      const toggle = () => host.querySelector<HTMLButtonElement>(".cm-code-fold-button");
      expect(rows().map((row) => row.dataset.codeNumber)).toEqual(["8", "9"]);
      expect(rows()[0]?.querySelector(".noema-code-word")?.textContent).toBe("state");
      expect(rows()[0]?.querySelector(".noema-code-guide")).toBeTruthy();
      expect(rows()[1]?.classList.contains("noema-code-add")).toBe(true);
      expect(rows()[0]?.querySelector(".syntax-hidden")?.textContent).toContain("[!code focus:1]");
      editor.setMarkdownSelection(source.indexOf("const state") + 2);
      expect(rows()[0]?.querySelector(".syntax-hint")?.textContent).toContain("[!code focus:1]");
      expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
      toggle()?.click();
      expect(rows().map((row) => row.dataset.codeNumber)).toEqual(["8", "9", "10", "11"]);
      expect(rows()[2]?.classList.contains("noema-code-error")).toBe(true);
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(editor.getMarkdown()).toBe(source);
      const opener = source.indexOf("```js");
      editor.replaceMarkdownRange(opener, opener, " ", "end");
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      editor.replaceMarkdownRange(opener, opener + 1, "", "end");
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      toggle()?.click();
      expect(rows()).toHaveLength(2);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("quote and list fences show options on selection and copy every code segment", async () => {
    const { createEditor } = await import("../src/editor-api.ts");
    const { setSystemClipboardWriter } = await import("../src/system-clipboard.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const source = "- Item\n\n  > ~~~sh line-numbers=3 collapsed-lines=1\n  > one # [!code highlight]\n  > two\n  > ~~~\n\nTail";
    let clipboard = "";
    setSystemClipboardWriter((text) => { clipboard = text; return Promise.resolve(true); });
    const editor = createEditor(host, { initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      const opener = () => host.querySelector(".cm-line:has(.cm-code-fold-button)");
      expect(opener()?.querySelector(".syntax-hidden")?.textContent).toContain("~~~");
      const button = host.querySelector<HTMLButtonElement>(".cm-code-copy-button");
      expect(button).toBeTruthy();
      button?.click();
      expect(clipboard).toBe("one # [!code highlight]\ntwo");
      editor.setMarkdownSelection(source.indexOf("collapsed-lines") + 2);
      expect([...opener()!.querySelectorAll(".syntax-hint")].some((item) => item.textContent?.includes("collapsed-lines=1"))).toBe(true);
      expect(editor.getMarkdown()).toBe(source);
    } finally {
      editor.destroy();
      host.remove();
      setSystemClipboardWriter(null);
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

  test("syntax overlays are readable in HTML and the hidden rows are included in PDF", async () => {
    const { renderMarkdownHTML, renderPublishedNoteHTML } = await import("../src/render-html.ts");
    const source = "```js title=history.js line-numbers=8 collapsed-lines=2 whitespace indent-guides /state/\n"
      + '    const state = 1; // [!code focus:1]\n    const last = state; // [!code ++]\n'
      + 'const literal = "[!code --]";\n    throw state; // [!code error]\n```';
    const host = document.createElement("div");
    host.innerHTML = renderMarkdownHTML(source);
    const rows = [...host.querySelectorAll<HTMLElement>(".noema-code-row")];
    expect(rows.map((row) => row.dataset.codeNumber)).toEqual(["8", "9", "10", "11"]);
    expect(rows[0]?.querySelector(".noema-code-word")?.textContent).toBe("state");
    expect(rows[1]?.classList.contains("noema-code-add")).toBe(true);
    expect(rows[1]?.classList.contains("noema-code-dim")).toBe(false);
    expect(rows[2]?.classList.contains("noema-code-dim")).toBe(true);
    expect(rows[2]?.textContent).toContain('"[!code --]"');
    expect(rows[3]?.classList.contains("noema-code-error")).toBe(true);
    expect(rows[3]?.textContent).not.toContain("[!code error]");
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(host.querySelector("summary")?.textContent).toBe("Show 2 more lines");
    host.innerHTML = renderPublishedNoteHTML(source, {title:"Code", format:"pdf"});
    expect(host.querySelectorAll(".noema-code-row")).toHaveLength(4);
    expect(host.querySelector("details:not([open])")).toBeNull();
  });
});

describe("code block card lines", () => {
  test("the fence opener is the card's header and the closer its last line", async () => {
    const { createEditor } = await import("../src/editor-api.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "intro\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\nafter" });
    try {
      editor.setMarkdownSelection(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const lines = [...host.querySelectorAll(".cm-line.cm-md-code-block")];
      expect(lines).toHaveLength(4);
      expect(lines[0]!.classList.contains("cm-md-code-header")).toBe(true);
      expect(lines[3]!.classList.contains("cm-md-code-last")).toBe(true);
      expect(lines.filter((line) => line.classList.contains("cm-md-code-first"))).toHaveLength(1);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
