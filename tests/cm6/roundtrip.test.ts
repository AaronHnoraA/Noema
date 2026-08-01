/**
 * Phase 1 — CM6 kernel基础验证。
 *
 * 由于 CM6 doc 即 markdown 源码，round-trip 是结构性保证而非需要额外转换层。
 * 这组测试验证：
 *   1. getMarkdown() 返回 setMarkdown() 传入的内容（无 parse/serialize 失真）
 *   2. insertText / replaceMarkdownRange 的 markdown offset 语义一致
 *   3. undo/redo 工作
 *   4. onChange 回调在内容变化时触发
 *
 * 跑法（依赖安装后）：
 *   cd Noema && npx vp test --run tests/cm6/roundtrip.test.ts
 */

import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { foldedRanges, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { createEditor } from "../../src/editor-api.ts";
import { calibrateWrappedLayoutClick, markdownHrefAt } from "../../src/cm6/editor-cm6.ts";
import { setKnownRoamRefs } from "../../src/cm6/roam-link-status.ts";
import { MATH_RENDER_ERROR_MAX_LENGTH } from "../../src/math-render.ts";
import { createVimLite } from "../../aaronnote/vim-lite.ts";
import { indentMarkdownBlock } from "../../src/cm6/commands/index.ts";

// All tests in this file require CM6 deps installed.
// Flip `CM6_READY` to `true` after:
//   npm install @codemirror/state @codemirror/view @codemirror/language
//              @codemirror/commands @codemirror/lang-markdown @lezer/markdown
// and add `import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts"` to editor-api.ts.
const CM6_READY = true;

const maybeDescribe = CM6_READY ? describe : describe.skip;

function mountCM6(initialContent = "", options: Parameters<typeof createEditor>[1] = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent, ...options });
  return { editor, host, cleanup: () => { editor.destroy(); host.remove(); } };
}

function iframeSrc(iframe: HTMLIFrameElement): string {
  return iframe.getAttribute("src") || iframe.getAttribute("data-aaronnote-src") || "";
}

function iframeSrcdoc(iframe: HTMLIFrameElement): string {
  return iframe.getAttribute("srcdoc") || iframe.getAttribute("data-aaronnote-srcdoc") || "";
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function settlePaste(): Promise<void> {
  await nextTick();
  await nextTick();
}

function foldedRangeCount(state: EditorState): number {
  let count = 0;
  foldedRanges(state).between(0, state.doc.length, () => { count += 1; });
  return count;
}

// ---------------------------------------------------------------------------
// getMarkdown / setMarkdown
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: getMarkdown / setMarkdown", () => {
  test("empty initial doc", () => {
    const { editor, cleanup } = mountCM6("");
    expect(editor.getMarkdown()).toBe("");
    cleanup();
  });

  test("preserves plain paragraph", () => {
    const md = "Hello world";
    const { editor, cleanup } = mountCM6(md);
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("preserves heading", () => {
    const md = "# Heading\n\nBody text";
    const { editor, cleanup } = mountCM6(md);
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("semantic heading spacing stays inside the measured widget", () => {
    const md = "@@part [Foundations]\n\nBody text";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const heading = document.querySelector<HTMLElement>(".aaronnote-section-heading");
    expect(heading).toBeTruthy();
    expect(heading!.classList.contains("cm-aaronnote-measured-widget")).toBe(true);
    expect(heading!.firstElementChild?.classList.contains("aaronnote-section-heading-inner")).toBe(true);
    expect(heading!.dataset.cmMeasureKey).toContain("sem:");
    expect(heading!.dataset.cmMeasureGroupKey).toContain("sem:level:1");
    cleanup();
  });

  test("preserves bold delimiters verbatim", () => {
    const md = "**bold**";
    const { editor, cleanup } = mountCM6(md);
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("preserves inline math", () => {
    const md = "The value \\(x = 1\\) is given.";
    const { editor, cleanup } = mountCM6(md);
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("does not treat dollar signs as inline math (dollar syntax removed)", () => {
    const md = "$ I like this but it is not math $ and $10 is a price\n\n$plain words are prose$";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-math-inline")).toBeNull();
    cleanup();
  });

  test("renders multiple inline math spans", () => {
    const md = "Try \\(x^4 + y - 10\\), \\(A \\leq_p B\\), and \\(\\mathrm{GI}\\) here.";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelectorAll(".cm-math-inline")).toHaveLength(3);
    cleanup();
  });

  test("does not pair underscores across separate inline math ranges as emphasis", () => {
    const md = String.raw`\(i_j\). Thus every standard basis vector of \(W_G\) lies in \((W_G)_{T_G}\), while the reverse inclusion is immediate; hence \((W_G)_{T_G}=W_G\).`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const nodeNames: string[] = [];
    syntaxTree(editor.view.state).iterate({ enter: (node) => { nodeNames.push(node.name); } });
    expect(nodeNames.filter((name) => name === "InlineMath")).toHaveLength(4);
    expect(nodeNames).not.toContain("Emphasis");
    expect(document.querySelector(".cm-em")).toBeNull();
    expect(document.querySelectorAll(".cm-math-inline")).toHaveLength(4);
    cleanup();
  });

  test("keeps deliberate emphasis around inline math", () => {
    const md = String.raw`*before \(W_G\) after*`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-em")).toBeTruthy();
    expect(document.querySelector(".cm-math-inline")).toBeTruthy();
    cleanup();
  });

  test("renders inline math spans with brackets and spaces in the content", () => {
    const md = "Given a graph \\([asdas] s asd asd\\) and \\(asdas s asd asd\\) and \\(x\\).";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const rendered = Array.from(document.querySelectorAll<HTMLElement>(".cm-math-inline"))
      .map((el) => md.slice(Number(el.dataset.cmSourceFrom), Number(el.dataset.cmSourceTo)));
    expect(rendered).toEqual(["\\([asdas] s asd asd\\)", "\\(asdas s asd asd\\)", "\\(x\\)"]);
    cleanup();
  });

  test("renders inline TeX that starts with a digit", () => {
    const md = "Numbers \\(1\\) and \\(3\\times 4\\times 5\\) render.";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const rendered = Array.from(document.querySelectorAll<HTMLElement>(".cm-math-inline"));
    expect(rendered).toHaveLength(2);
    expect(rendered[0]!.textContent).toContain("1");
    expect(rendered[1]!.textContent).toContain("3");
    cleanup();
  });

  test("shows bounded math render errors in preview widgets", () => {
    const md = String.raw`Bad \(\notacommand\).

\[
\notacommand
\]`;
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(0);
      const errors = Array.from(document.querySelectorAll<HTMLElement>(".cm-math-error"));

      expect(errors).toHaveLength(2);
      expect(errors.every((el) => (el.textContent || "").includes("KaTeX parse error"))).toBe(true);
      expect(errors.every((el) => (el.textContent || "").length <= MATH_RENDER_ERROR_MAX_LENGTH)).toBe(true);
      expect(errors.some((el) => (el.textContent || "").includes("\\["))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("does not render inline math inside a fenced code block", () => {
    const md = "```\ninline \\(x+1\\) here\n```\n";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-math-inline")).toBeNull();
    cleanup();
  });

  test("does not render inline math inside an inline code span", () => {
    const md = "text `\\(x+1\\)` more";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-math-inline")).toBeNull();
    cleanup();
  });

  test("renders double-bracket Wiki links and resolves them as internal URLs", () => {
    const md = "see [[Note Title]] ref";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-internal-link-text")?.textContent).toBe("Note Title");
    expect(markdownHrefAt(editor.view.state, md.indexOf("Note"))).toBe("roam://wiki/Note%20Title");
    expect(Array.from(document.querySelectorAll<HTMLElement>(".syntax-hidden"))
      .map((element) => element.textContent)).toEqual(expect.arrayContaining(["[[", "]]" ]));
    cleanup();
  });

  test("cmd-click on a Wiki link dispatches the unified open-url event", () => {
    const md = "see [[roam://page-id|Note Title]] ref";
    const { editor, cleanup } = mountCM6(md);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    const view = editor.view as typeof editor.view & {
      contentDOM: HTMLElement;
      posAtCoords: (coords: { x: number; y: number }) => number | null;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(view, "posAtCoords");
    document.addEventListener("aaronnote:open-url", listener);
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => md.indexOf("Note Title"),
    });

    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 1,
      clientY: 1,
      metaKey: true,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(events[0]?.detail).toEqual({ href: "roam://wiki/roam%3A%2F%2Fpage-id", newWindow: false });
    document.removeEventListener("aaronnote:open-url", listener);
    if (originalDescriptor) Object.defineProperty(view, "posAtCoords", originalDescriptor);
    else delete (view as { posAtCoords?: unknown }).posAtCoords;
    cleanup();
  });

  test("does not apply markdown link preview inside active inline math", () => {
    const md = "Given a graph \\([asdas] s asd asd\\)";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("asdas"));

    expect(document.querySelector(".cm-math-inline")).toBeNull();
    expect(document.querySelector(".cm-link-text")).toBeNull();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("\\([asdas] s asd asd\\)");
    cleanup();
  });

  test("does not render inline command or image widgets inside inline math", () => {
    const md = "Math \\(@@tag[qc] \\) and \\(![x](y) \\)";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".inline-tag-widget")).toBeNull();
    expect(document.querySelector(".cm-image-widget")).toBeNull();
    expect(document.querySelectorAll(".cm-math-inline")).toHaveLength(2);
    cleanup();
  });

  test("does not render org-env blocks inside fenced markdown code", () => {
    const md = [
      "```md",
      "#+begin meta",
      "tags: algebra, linear-algebra, math, reading",
      "#+end meta",
      "```",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-org-env-block[data-kind='meta']")).toBeNull();
    expect(document.querySelector(".cm-code-copy-button")).toBeTruthy();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("#+begin meta");
    cleanup();
  });

  test("preserves display math", () => {
    const md = "\\[\na^2 + b^2 = c^2\n\\]";
    const { editor, cleanup } = mountCM6(md);
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("editing one display math block preserves unrelated math widget DOM", () => {
    const md = "top\n\n\\[\na\n\\]\n\nmiddle\n\n\\[\nb\n\\]";
    const { editor, cleanup } = mountCM6(md);

    editor.setMarkdownSelection(md.indexOf("a"));
    const secondBlock = document.querySelector<HTMLElement>(".cm-math-block");
    expect(secondBlock).toBeTruthy();

    editor.insertText("+c");

    expect(document.querySelector(".cm-math-block")).toBe(secondBlock);
    cleanup();
  });

  test("preserves fenced code with lang", () => {
    const md = "```ts\nconst x = 1;\n```";
    const { editor, cleanup } = mountCM6(md);
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("copies fenced code body from the top-right code button", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        },
      },
    });

    const md = "```ts\nconst x = 1;\n```";
    const { cleanup } = mountCM6(md);
    try {
      const button = document.querySelector<HTMLButtonElement>(".cm-code-copy-button");
      expect(button).toBeTruthy();
      expect(button!.closest(".cm-line")).toBeTruthy();

      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(copied.trim()).toBe("const x = 1;");
      expect(copied).not.toContain("```");
      expect(button!.textContent).toBe("Copied");
    } finally {
      cleanup();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  test("edits the fenced code language and folds without changing its body", async () => {
    const md = "```ts\nconst x = 1;\nconst y = 2;\n```\n\nTail";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const language = document.querySelector<HTMLElement>(".cm-code-lang-editor");
    expect(language).toBeTruthy();
    language!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const input = language!.querySelector<HTMLInputElement>(".cm-code-lang-input");
    expect(input).toBeTruthy();
    input!.value = "javascript";
    input!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await nextTick();
    expect(editor.getMarkdown()).toContain("```javascript\nconst x = 1;");

    const fold = document.querySelector<HTMLButtonElement>(".cm-code-fold-button");
    expect(fold).toBeTruthy();
    fold!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector(".cm-code-fold-placeholder")).toBeTruthy();
    expect(editor.getMarkdown()).toContain("const x = 1;\nconst y = 2;");

    document.querySelector<HTMLButtonElement>(".cm-code-fold-button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector(".cm-code-fold-placeholder")).toBeNull();
    cleanup();
  });

  test("previews standard footnotes and jumps to their definitions", () => {
    const md = "Claim[^proof].\n\nMiddle\n\n[^proof]: Definition.";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("Middle") + 2);

    const reference = document.querySelector<HTMLButtonElement>(".cm-footnote-reference button");
    expect(reference).toBeTruthy();
    expect(document.querySelector(".cm-footnote-definition-label")).toBeTruthy();
    expect(editor.getMarkdown()).toBe(md);

    reference!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("[^proof]:"));
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("resizes an image on pointer release with one source attribute update", async () => {
    const md = "![plot](./plot.png)\n\nTail";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const handle = document.querySelector<HTMLElement>(".cm-image-resize-handle");
    expect(handle).toBeTruthy();
    expect(editor.getMarkdown()).toBe(md);
    handle!.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0, clientX: 10,
    }));
    handle!.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, cancelable: true, button: 0, clientX: 90,
    }));
    expect(editor.getMarkdown()).toBe(md);
    handle!.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, button: 0, clientX: 90,
    }));
    await nextTick();
    expect(editor.getMarkdown()).toContain("{width: 400px}");
    cleanup();
  });

  test("setMarkdown replaces entire doc", () => {
    const { editor, cleanup } = mountCM6("old content");
    editor.setMarkdown("# New\n\nnew content");
    expect(editor.getMarkdown()).toBe("# New\n\nnew content");
    cleanup();
  });

  test("setMarkdown to empty string", () => {
    const { editor, cleanup } = mountCM6("something");
    editor.setMarkdown("");
    expect(editor.getMarkdown()).toBe("");
    cleanup();
  });

  test("setMarkdown records undo by default", () => {
    const { editor, cleanup } = mountCM6("old content");
    editor.setMarkdown("new content");
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("old content");
    cleanup();
  });

  test("setMarkdown can reset stale undo history when loading another document", () => {
    const { editor, cleanup } = mountCM6("previous file");
    editor.setMarkdownSelection(editor.getMarkdown().length);
    editor.insertText(" edit");
    expect(editor.undo()).toBe(true);
    editor.redo();

    editor.setMarkdown("current file", { history: "reset" });

    expect(editor.undo()).toBe(false);
    expect(editor.getMarkdown()).toBe("current file");
    cleanup();
  });

  test("getHTML renders current markdown through shared export pipeline", () => {
    const { editor, cleanup } = mountCM6("# Title\n\n**bold**\n\n\\[\nx+1\n\\]");
    const html = editor.getHTML();
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>");
    expect(html).toContain("math-block-rendered");
    cleanup();
  });

  test("org-env body remains normal CM6 markdown with math widgets", () => {
    const md = String.raw`#+begin theorem
Inline \(x+1\).

\[
y^2
\]
#+end theorem`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("Inline"));
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeTruthy();
    expect(document.querySelector(".cm-org-env-body-line")).toBeTruthy();
    expect(document.querySelector(".cm-math-inline")).toBeTruthy();
    const mathBlock = document.querySelector<HTMLElement>(".cm-math-block");
    expect(mathBlock).toBeTruthy();
    expect(mathBlock!.dataset.orgEnvKind).toBe("theorem");
    expect(mathBlock!.style.getPropertyValue("--org-env-depth")).toBe("0");
    cleanup();
  });

  test("org-env list display math renders as separate CM6 math blocks", () => {
    const md = String.raw`#+begin define
1. Conjugate symmetry 共轭对称性:

   \[
   \langle v,w \rangle
   =
   \overline{\langle w,v \rangle}
   \]

2. Additivity in the first variable 第一变量加法线性:

   \[
   \langle v_1 + v_2, w \rangle
   =
   \langle v_1,w \rangle
   +
   \langle v_2,w \rangle
   \]

3. Homogeneity in the first variable 第一变量齐次线性:

   \[
   \langle \lambda v,w \rangle
   =
   \lambda \langle v,w \rangle
   \]
#+end define`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(0);

    const mathBlocks = Array.from(document.querySelectorAll<HTMLElement>(".cm-math-block"));
    expect(mathBlocks).toHaveLength(3);
    expect(mathBlocks.every((block) => block.dataset.orgEnvKind === "define")).toBe(true);
    expect(mathBlocks.map((block) => block.textContent).join("\n")).not.toContain("\\[");
    const firstOpenLine = md.indexOf("   \\[");
    const firstCloseLine = md.indexOf("   \\]");
    expect(Number(mathBlocks[0]!.dataset.cmSourceFrom)).toBe(firstOpenLine);
    expect(Number(mathBlocks[0]!.dataset.cmSourceTo)).toBe(firstCloseLine + "   \\]".length);
    expect(document.querySelector("link[data-aaronnote-katex-css]")).toBeTruthy();
    cleanup();
  });

  test("resolves markdown link hrefs at source positions", () => {
    const md = "Go [there](target.md#eq-x), [roam](roam://node-id#eq-x), [nb](./attachments/tset.ipynb@test file), ![plot](./images/plot.png), and https://example.com";
    const { editor, cleanup } = mountCM6(md);

    expect(markdownHrefAt(editor.view.state, md.indexOf("there"))).toBe("target.md#eq-x");
    expect(markdownHrefAt(editor.view.state, md.indexOf("roam]"))).toBe("roam://node-id#eq-x");
    expect(markdownHrefAt(editor.view.state, md.indexOf("nb]"))).toBe("./attachments/tset.ipynb@test file");
    expect(markdownHrefAt(editor.view.state, md.indexOf("plot"))).toBe("./images/plot.png");
    expect(markdownHrefAt(editor.view.state, md.indexOf("https://") + 3)).toBe("https://example.com");

    cleanup();
  });

  test("resolves angle-bracket hrefs containing spaces", () => {
    const md = "See [there](<target with spaces.md>) for more.";
    const { editor, cleanup } = mountCM6(md);

    expect(markdownHrefAt(editor.view.state, md.indexOf("there"))).toBe("target with spaces.md");
    cleanup();
  });

  test("renders and resolves a local heading fragment containing spaces", () => {
    const md = "1. [Step 1](#step 1):\n\n## step 1";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(markdownHrefAt(editor.view.state, md.indexOf("Step 1"))).toBe("#step 1");
    expect(document.querySelector(".cm-link-text")).toBeTruthy();
    expect(Array.from(document.querySelectorAll<HTMLElement>(".syntax-hidden"))
      .map((element) => element.textContent || "")
      .join(""))
      .toContain("#step 1");
    cleanup();
  });

  test("resolves link labels containing an escaped closing bracket", () => {
    const md = String.raw`[a\]b](target.md) after`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(markdownHrefAt(editor.view.state, md.indexOf("a"))).toBe("target.md");
    expect(Array.from(document.querySelectorAll<HTMLElement>(".syntax-hidden"))
      .map((el) => el.textContent || "")
      .join(""))
      .toContain("target.md");
    cleanup();
  });

  test.each([
    ["a nested bracket", "See [link [inner] rest](target.md) after", "link"],
    ["multiple nested brackets", "See [a [b] c [d] e](target.md) after", "a"],
    ["a nested image-alt bracket", "See ![plot [draft]](plot.png) after", "plot"],
  ])("preserves %s inside inline link text", (_name, md, anchor) => {
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(markdownHrefAt(editor.view.state, md.indexOf(anchor))).toBe(
      md.includes("plot.png") ? "plot.png" : "target.md",
    );
    if (md.includes("plot.png")) {
      expect(document.querySelector(".cm-image-widget")).toBeTruthy();
    } else {
      expect(Array.from(document.querySelectorAll<HTMLElement>(".syntax-hidden"))
        .map((el) => el.textContent || "")
        .join(""))
        .toContain("target.md");
    }
    cleanup();
  });

  test("renders ordinary markdown links outside the editable span", () => {
    const md = "- [related paper](./graph-tensor-background.md)\n\nsad";
    const { editor, cleanup } = mountCM6(md);
    const linkEnd = md.indexOf(")") + 1;

    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-link-text")).toBeTruthy();
    expect(Array.from(document.querySelectorAll<HTMLElement>(".syntax-hidden"))
      .map((el) => el.textContent || "")
      .join(""))
      .toContain("./graph-tensor-background.md");

    editor.setMarkdownSelection(linkEnd);
    expect(document.querySelector(".cm-link-text")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("related"));
    expect(document.querySelector(".cm-link-text")).toBeNull();
    cleanup();
  });

  test("does not resolve markdown links inside inline math", () => {
    const md = "Math \\([x](y.md) \\) and [real](z.md)";
    const { editor, cleanup } = mountCM6(md);

    expect(markdownHrefAt(editor.view.state, md.indexOf("x"))).toBeNull();
    expect(markdownHrefAt(editor.view.state, md.indexOf("real"))).toBe("z.md");
    cleanup();
  });

  test("does not feed double-bracket text to roam link diagnostics", () => {
    const md = "Plain [[Ghost Note]] and math \\([[X]] \\).";
    const { editor, cleanup } = mountCM6(md);

    editor.view.dispatch({ effects: setKnownRoamRefs.of([]) });

    const broken = Array.from(document.querySelectorAll<HTMLElement>(".cm-roam-link-broken"))
      .map((el) => el.textContent);
    expect(broken).not.toContain("X");
    expect(broken).not.toContain("Ghost Note");
    cleanup();
  });

  test("cmd-click on a markdown link dispatches open-url", () => {
    const md = "Go [there](target.md#eq-x)";
    const { editor, cleanup } = mountCM6(md);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    const view = editor.view as typeof editor.view & {
      contentDOM: HTMLElement;
      posAtCoords: (coords: { x: number; y: number }) => number | null;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(view, "posAtCoords");

    document.addEventListener("aaronnote:open-url", listener);
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => md.indexOf("there"),
    });

    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 1,
      clientY: 1,
      metaKey: true,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(events[0]?.detail).toEqual({ href: "target.md#eq-x", newWindow: false });

    document.removeEventListener("aaronnote:open-url", listener);
    if (originalDescriptor) Object.defineProperty(view, "posAtCoords", originalDescriptor);
    else delete (view as { posAtCoords?: unknown }).posAtCoords;
    cleanup();
  });

  test("cmd-click on a meta summary link uses the ordinary open-url route", () => {
    const md = [
      "#+begin meta",
      "title: Paper",
      "#+begin summary",
      "Read [the source](target.md#result).",
      "#+end summary",
      "#+end meta",
    ].join("\n");
    const { host, cleanup } = mountCM6(md);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    document.addEventListener("aaronnote:open-url", listener);

    const anchor = host.querySelector<HTMLAnchorElement>(".aaronnote-meta-abstract a[href]")!;
    const plainClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(plainClick);
    expect(plainClick.defaultPrevented).toBe(true);
    expect(events).toEqual([]);

    const open = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    anchor.dispatchEvent(open);
    expect(open.defaultPrevented).toBe(true);
    expect(events[0]?.detail).toEqual({ href: "target.md#result", newWindow: false });

    document.removeEventListener("aaronnote:open-url", listener);
    cleanup();
  });

  test("plain click on a jupyter link does not dispatch open-url", () => {
    const md = "Go [nb](./attachments/tset.ipynb@test file)";
    const { editor, cleanup } = mountCM6(md);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    const view = editor.view as typeof editor.view & {
      contentDOM: HTMLElement;
      posAtCoords: (coords: { x: number; y: number }) => number | null;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(view, "posAtCoords");

    document.addEventListener("aaronnote:open-url", listener);
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => md.indexOf("nb"),
    });

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 1,
      clientY: 1,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(events).toEqual([]);

    document.removeEventListener("aaronnote:open-url", listener);
    if (originalDescriptor) Object.defineProperty(view, "posAtCoords", originalDescriptor);
    else delete (view as { posAtCoords?: unknown }).posAtCoords;
    cleanup();
  });

  test("cmd-middle-click on a markdown link dispatches open-url for a new window", () => {
    const md = "Go [there](target.md@heading)";
    const { editor, cleanup } = mountCM6(md);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    const view = editor.view as typeof editor.view & {
      contentDOM: HTMLElement;
      posAtCoords: (coords: { x: number; y: number }) => number | null;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(view, "posAtCoords");

    document.addEventListener("aaronnote:open-url", listener);
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => md.indexOf("there"),
    });

    const event = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
      clientX: 1,
      clientY: 1,
      metaKey: true,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(events[0]?.detail).toEqual({ href: "target.md@heading", newWindow: true });

    document.removeEventListener("aaronnote:open-url", listener);
    if (originalDescriptor) Object.defineProperty(view, "posAtCoords", originalDescriptor);
    else delete (view as { posAtCoords?: unknown }).posAtCoords;
    cleanup();
  });

  test("right-click on a markdown attachment dispatches its context menu", () => {
    const md = "P.S: ![IMG_6118.jpeg](./images/GraphTensor/IMG_6118.jpeg)";
    const { editor, cleanup } = mountCM6(md);
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    const view = editor.view as typeof editor.view & {
      contentDOM: HTMLElement;
      posAtCoords: (coords: { x: number; y: number }) => number | null;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(view, "posAtCoords");

    document.addEventListener("aaronnote:attachment-context-menu", listener);
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => md.indexOf("IMG_6118.jpeg"),
    });

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 1,
      clientY: 1,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(events[0]?.detail).toEqual({ href: "./images/GraphTensor/IMG_6118.jpeg", x: 1, y: 1 });

    document.removeEventListener("aaronnote:attachment-context-menu", listener);
    if (originalDescriptor) Object.defineProperty(view, "posAtCoords", originalDescriptor);
    else delete (view as { posAtCoords?: unknown }).posAtCoords;
    cleanup();
  });

  test("jupyter cell insert inherits previous language kernel and session", () => {
    const md = "@@cell(python, sagemath-10.9, analysis) [a]\nplain";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(editor.runCommand("jupyter-cell")).toBe(true);
    expect(editor.getMarkdown().match(/@@cell\(python, sagemath-10\.9, analysis\)/g)?.length).toBe(2);

    cleanup();
  });

  test("bare jupyter cell widget inherits previous runtime defaults", async () => {
    const md = "@@cell(python, sagemath-10.9, analysis) [a]\n@@cell";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-ceil-label")?.textContent).toBe("CELL");
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    expect(editor.getMarkdown()).toMatch(/@@cell\(python, sagemath-10\.9, analysis\) \[ceil-[^\]]+\]/);

    cleanup();
  });

  test("html env stays previewed until source mode", () => {
    const md = [
      "before",
      "",
      "#+begin html",
      '<section class="raw-panel"><strong>Raw HTML</strong></section>',
      "#+end html",
      "",
      "after",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    const view = editor.view as typeof editor.view & { contentDOM: HTMLElement };
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-html-env-widget .raw-panel strong")?.textContent).toBe("Raw HTML");
    expect(view.contentDOM.textContent).not.toContain("#+begin html");
    expect(document.querySelector('.cm-org-env-rail[data-org-env-kind="html"]')).toBeNull();

    editor.setMarkdownSelection(md.indexOf("<section") + 2);
    expect(document.querySelector(".cm-html-env-widget .raw-panel strong")?.textContent).toBe("Raw HTML");
    expect(view.contentDOM.textContent).not.toContain("<section");
    expect(document.querySelector(".cm-org-env-heading-widget[data-org-env-kind='html']")).toBeNull();

    editor.toggleSource();
    expect(view.contentDOM.textContent).toContain("#+begin html");
    expect(view.contentDOM.textContent).toContain("<section");
    cleanup();
  });

  test("tikz env stays previewed as a stable rendered svg asset", async () => {
    const originalApi = window.aaronnoteApi;
    const originalCurrentFile = window.AaronnoteCurrentFile;
    const originalResolveAssetUrl = window.AaronnoteResolveAssetUrl;
    window.AaronnoteCurrentFile = () => "/notes/demo.md";
    window.AaronnoteResolveAssetUrl = (src: string) => `asset://${src}`;
    window.aaronnoteApi = {
      assets: {
        renderTikz: async (body: unknown) => ({
          ok: true,
          markdownPath: "./images/demo/tikz-axis.svg",
          body,
        }),
      },
    } as typeof window.aaronnoteApi;
    const md = [
      "before",
      "",
      "#+ begin tikz axis 20260525-120000 {size:320 align:right wrap}",
      "\\draw (0,0) -- (1,1);",
      "#+ end tikz",
      "",
      "after",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    try {
      const view = editor.view as typeof editor.view & { contentDOM: HTMLElement };
      editor.setMarkdownSelection(md.length);

      expect(document.querySelector(".cm-tikz-env-widget")?.classList.contains("cm-image-widget")).toBe(true);
      expect(document.querySelector(".cm-tikz-env-widget")?.classList.contains("aaronnote-image-align-right")).toBe(true);
      expect(document.querySelector(".cm-tikz-env-widget")?.classList.contains("aaronnote-image-wrap")).toBe(true);
      expect((document.querySelector<HTMLElement>(".cm-tikz-env-widget")?.style.getPropertyValue("--aaronnote-image-width") || "").trim()).toBe("320px");
      expect(document.querySelector('.cm-org-env-rail[data-org-env-kind="tikz"]')).toBeNull();
      expect(view.contentDOM.textContent).not.toContain("#+ begin tikz");

      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const img = document.querySelector<HTMLImageElement>(".cm-tikz-env-widget img");
      expect(img).toBeTruthy();
      expect(img!.src).toBe("asset://./images/demo/tikz-axis.svg");

      editor.toggleSource();
      expect(view.contentDOM.textContent).toContain("#+ begin tikz");
    } finally {
      cleanup();
      window.aaronnoteApi = originalApi;
      window.AaronnoteCurrentFile = originalCurrentFile;
      window.AaronnoteResolveAssetUrl = originalResolveAssetUrl;
    }
  });

  test("tikz env fills missing id and timestamp on first preview", async () => {
    const originalApi = window.aaronnoteApi;
    const originalCurrentFile = window.AaronnoteCurrentFile;
    window.AaronnoteCurrentFile = () => "/notes/demo.md";
    window.aaronnoteApi = {
      assets: {
        renderTikz: async () => ({
          ok: true,
          markdownPath: "./images/demo/tikz-auto.svg",
        }),
      },
    } as typeof window.aaronnoteApi;
    const md = [
      "#+ begin tikz {wrap}",
      "\\draw (0,0) -- (1,1);",
      "#+ end tikz",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      expect(editor.getMarkdown()).toMatch(/^#\+ begin tikz tikz-\d{8}-\d{6} \d{8}-\d{6} \{wrap\}/);
    } finally {
      cleanup();
      window.aaronnoteApi = originalApi;
      window.AaronnoteCurrentFile = originalCurrentFile;
    }
  });

  test("tikz env bumps timestamp after body edits before rerendering", async () => {
    const originalApi = window.aaronnoteApi;
    const originalCurrentFile = window.AaronnoteCurrentFile;
    window.AaronnoteCurrentFile = () => "/notes/demo.md";
    const renderCalls: Array<{ timestamp?: string }> = [];
    window.aaronnoteApi = {
      assets: {
        renderTikz: async (body: { timestamp?: string }) => {
          renderCalls.push(body);
          return {
            ok: true,
            markdownPath: "./images/demo/tikz-axis.svg",
          };
        },
      },
    } as typeof window.aaronnoteApi;
    const md = [
      "#+ begin tikz dirty-axis 20260525-120000",
      "\\draw (0,0) -- (1,1);",
      "#+ end tikz",
      "",
      "after",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(renderCalls.length).toBe(1);

      editor.toggleSource();
      const from = editor.getMarkdown().indexOf("(1,1)");
      editor.view.dispatch({
        changes: { from, to: from + "(1,1)".length, insert: "(2,2)" },
        selection: { anchor: editor.getMarkdown().length },
      });
      editor.toggleSource();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));

      expect(editor.getMarkdown()).toMatch(/^#\+ begin tikz dirty-axis (?!20260525-120000)\d{8}-\d{6}/);
      expect(renderCalls.at(-1)?.timestamp).not.toBe("20260525-120000");
    } finally {
      cleanup();
      window.aaronnoteApi = originalApi;
      window.AaronnoteCurrentFile = originalCurrentFile;
    }
  });

  test("clicking org-env display math uses the same source opening as outside", () => {
    const md = String.raw`#+begin theorem
Before

\[
y^2
\]
#+end theorem`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(0);
    const math = document.querySelector<HTMLElement>(".cm-math-block");
    expect(math).toBeTruthy();

    math!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("y^2"));
    expect(document.querySelector(".cm-math-block")).toBeNull();
    cleanup();
  });

  test("renders markdown table as a directly editable table widget", () => {
    const { cleanup } = mountCM6("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(document.querySelector(".cm-table-block table")).toBeTruthy();
    expect(document.querySelector(".cm-table-toolbar")).toBeTruthy();
    expect(document.querySelectorAll(".cm-table-block td, .cm-table-block th")).toHaveLength(4);
    expect(document.querySelector(".cm-table-block-preview")).toBeNull();
    cleanup();
  });

  test("table widgets consume trailing layout attrs", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n{size:75%; align:right; wrap:on}\n\nDone";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const tableBlock = document.querySelector<HTMLElement>(".cm-table-block");
    expect(tableBlock).toBeTruthy();
    expect(tableBlock!.classList.contains("cm-aaronnote-measured-widget")).toBe(true);
    expect(tableBlock!.classList.contains("aaronnote-table-align-right")).toBe(true);
    expect(tableBlock!.classList.contains("aaronnote-table-wrap")).toBe(true);
    expect(tableBlock!.style.getPropertyValue("--aaronnote-table-width")).toBe("75%");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("{size:75%");

    editor.setMarkdownSelection(md.indexOf("size"));
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("{size:75%; align:right; wrap:on}");
    cleanup();
  });

  test("aligned table widget clicks do not use visual coords as cursor offsets", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n{size:75%; align:right}\n\nDone";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const before = editor.getMarkdownSelection().from;

    const tableBlock = document.querySelector<HTMLElement>(".cm-table-block");
    expect(tableBlock).toBeTruthy();
    tableBlock!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 10_000,
    }));

    expect(editor.getMarkdownSelection().from).toBe(before);
    cleanup();
  });

  test("renders markdown formatting inside table cells before editing", () => {
    const md = "| A | B |\n| --- | ---: |\n| **one** | 2 |\n\nDone";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const table = document.querySelector<HTMLTableElement>(".cm-table-block table");
    expect(table).toBeTruthy();
    expect(table!.querySelectorAll("th")).toHaveLength(2);
    expect(table!.querySelector("strong")?.textContent).toBe("one");
    expect(table!.querySelector("tbody td:last-child")?.getAttribute("style")).toContain("text-align: right");
    cleanup();
  });

  test("edits table cells directly without a lower preview copy", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("1"));
    const cell = document.querySelector<HTMLElement>("tbody td");
    expect(cell).toBeTruthy();
    expect(document.querySelector(".cm-table-block-preview")).toBeNull();
    cell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const input = cell!.querySelector<HTMLInputElement>(".cm-table-cell-input");
    expect(input).toBeTruthy();
    input!.value = "edited";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.getMarkdown()).toContain("| edited | 2 |");
    cleanup();
  });

  test("opening a table cell keeps editor coordinates fresh", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nTail";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const selectionBefore = editor.getMarkdownSelection();
    let measureCount = 0;
    const originalRequestMeasure = editor.view.requestMeasure.bind(editor.view);
    editor.view.requestMeasure = ((...args: Parameters<typeof editor.view.requestMeasure>) => {
      measureCount += 1;
      return originalRequestMeasure(...args);
    }) as typeof editor.view.requestMeasure;

    const cell = document.querySelector<HTMLElement>("tbody td");
    expect(cell).toBeTruthy();
    cell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(editor.getMarkdownSelection()).toEqual(selectionBefore);
    expect(cell!.querySelector<HTMLInputElement>(".cm-table-cell-input")).toBeTruthy();
    expect(measureCount).toBeGreaterThan(0);
    cleanup();
  });

  test("table toolbar inserts rows and columns in markdown", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    const firstBodyCell = document.querySelector<HTMLElement>("tbody td");
    firstBodyCell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    document.querySelector<HTMLButtonElement>(".cm-table-toolbar button[title='Insert row below']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.getMarkdown()).toContain("|  |  |");

    document.querySelector<HTMLElement>("tbody td")!.focus();
    document.querySelector<HTMLButtonElement>(".cm-table-toolbar button[title='Insert column right']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.getMarkdown().split("\n")[0]).toBe("| A |  | B |");
    cleanup();
  });

  test("table mouse controls resize from a bounded grid and expose drag handles", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    expect(document.querySelectorAll(".cm-table-row-drag-handle")).toHaveLength(1);
    expect(document.querySelectorAll(".cm-table-column-drag-handle")).toHaveLength(2);
    expect(document.querySelector(".cm-table-edge-add-row")).toBeTruthy();
    expect(document.querySelector(".cm-table-edge-add-column")).toBeTruthy();

    document.querySelector<HTMLButtonElement>(".cm-table-toolbar button[title='Resize table with grid']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const target = document.querySelector<HTMLButtonElement>(".cm-table-size-cell[title='4 rows × 3 columns']");
    expect(target).toBeTruthy();
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(editor.getMarkdown().split("\n")).toHaveLength(5);
    expect(editor.getMarkdown().split("\n")[0]).toBe("| A | B |  |");
    cleanup();
  });

  test("table row drag reorders source once on drop", async () => {
    const md = "| A | B |\n| --- | --- |\n| first | 1 |\n| second | 2 |";
    const { editor, cleanup } = mountCM6(md);
    const handles = document.querySelectorAll<HTMLElement>(".cm-table-row-drag-handle");
    const rows = document.querySelectorAll<HTMLTableRowElement>(".cm-markdown-table-editable tbody tr");
    expect(handles).toHaveLength(2);
    handles[0]!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdown()).toBe(md);
    rows[1]!.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(editor.getMarkdown().split("\n").slice(2)).toEqual([
      "| second | 2 |",
      "| first | 1 |",
    ]);
    cleanup();
  });

  test("enter in a table cell commits and moves editing to the next row", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const { editor, cleanup } = mountCM6(md);
    const firstBodyCell = document.querySelector<HTMLElement>("tbody td");
    firstBodyCell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const input = firstBodyCell!.querySelector<HTMLInputElement>(".cm-table-cell-input");
    expect(input).toBeTruthy();

    input!.value = "edited";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    expect(editor.getMarkdown()).toContain("| edited | 2 |");
    const activeInput = document.activeElement as HTMLInputElement | null;
    expect(activeInput?.classList.contains("cm-table-cell-input")).toBe(true);
    expect(activeInput?.value).toBe("3");
    cleanup();
  });

  test("escape in a table cell cancels editing without committing", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    const firstBodyCell = document.querySelector<HTMLElement>("tbody td");
    firstBodyCell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const input = firstBodyCell!.querySelector<HTMLInputElement>(".cm-table-cell-input");
    expect(input).toBeTruthy();

    input!.value = "discarded";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(editor.getMarkdown()).toBe(md);
    expect(firstBodyCell!.querySelector(".cm-table-cell-input")).toBeNull();
    expect(firstBodyCell!.textContent).toBe("1");
    cleanup();
  });

  test("tab at the last table cell appends a new row", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    const lastBodyCell = document.querySelector<HTMLElement>("tbody td:last-child");
    lastBodyCell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const input = lastBodyCell!.querySelector<HTMLInputElement>(".cm-table-cell-input");
    expect(input).toBeTruthy();

    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    const activeInput = document.activeElement as HTMLInputElement | null;
    expect(activeInput?.classList.contains("cm-table-cell-input")).toBe(true);
    expect(activeInput?.value).toBe("");
    expect(editor.getMarkdown()).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n|  |  |");
    cleanup();
  });

  test("table cell edits preserve deliberate outer spaces", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    const firstBodyCell = document.querySelector<HTMLElement>("tbody td");
    firstBodyCell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const input = firstBodyCell!.querySelector<HTMLInputElement>(".cm-table-cell-input");
    input!.value = "  spaced  ";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    expect(editor.getMarkdown()).toContain("|   spaced   | 2 |");
    cleanup();
  });

  test("table toolbar keeps focus on the inserted row cell", async () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { cleanup } = mountCM6(md);
    const firstBodyCell = document.querySelector<HTMLElement>("tbody td");
    firstBodyCell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    document.querySelector<HTMLButtonElement>(".cm-table-toolbar button[title='Insert row below']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    const activeInput = document.activeElement as HTMLInputElement | null;
    expect(activeInput?.classList.contains("cm-table-cell-input")).toBe(true);
    expect(activeInput?.value).toBe("");
    cleanup();
  });

  test("typing ordinary text above a table preserves the table widget DOM", () => {
    const md = "above\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    const { editor, cleanup } = mountCM6(md);
    const tableBlock = document.querySelector<HTMLElement>(".cm-table-block");
    expect(tableBlock).toBeTruthy();

    editor.setMarkdownSelection(0);
    editor.insertText("x");

    expect(document.querySelector(".cm-table-block")).toBe(tableBlock);
    cleanup();
  });

  test("typing ordinary text above mermaid preserves the mermaid widget DOM", () => {
    const md = "above\n\n```mermaid\ngraph TD\nA-->B\n```";
    const { editor, cleanup } = mountCM6(md);
    const mermaidBlock = document.querySelector<HTMLElement>(".cm-mermaid-block");
    expect(mermaidBlock).toBeTruthy();

    editor.setMarkdownSelection(0);
    editor.insertText("x");

    expect(document.querySelector(".cm-mermaid-block")).toBe(mermaidBlock);
    cleanup();
  });

  test("mermaid widgets consume trailing diagram layout attrs", () => {
    const md = "```mermaid\ngraph LR\nA --- B\n```\n{size:180; align: right, wrap: on}\n\nDone";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const widget = document.querySelector<HTMLElement>(".cm-mermaid-widget");
    const diagram = document.querySelector<HTMLElement>(".cm-mermaid-block");
    expect(widget).toBeTruthy();
    expect(diagram).toBeTruthy();
    expect(widget!.classList.contains("cm-aaronnote-measured-widget")).toBe(true);
    expect(widget!.classList.contains("aaronnote-image-wrap")).toBe(false);
    expect(diagram!.classList.contains("aaronnote-diagram-align-right")).toBe(true);
    expect(diagram!.classList.contains("aaronnote-diagram-wrap")).toBe(true);
    expect(diagram!.style.getPropertyValue("--aaronnote-diagram-width")).toBe("180px");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("{size:180");

    editor.setMarkdownSelection(md.indexOf("size"));
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("{size:180; align: right, wrap: on}");
    cleanup();
  });

  test("mermaid preview source stays inside the fence when editing trailing attrs", () => {
    const md = [
      "\\[",
      "x",
      "\\]",
      "```mermaid",
      "graph LR",
      "  subgraph L[\"L, #L = ell\"]",
      "    L1((1))",
      "  end",
      "```",
      "{align: right; wrap:on; size:240}",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("align"));

    const preview = document.querySelector<HTMLElement>(".cm-mermaid-block-preview");
    expect(preview).toBeTruthy();
    expect(preview!.dataset.diagramRenderKey).toContain("graph LR");
    expect(preview!.dataset.diagramRenderKey).not.toContain("align:");
    cleanup();
  });

  test("aligned marmind widgets open source at the diagram body anchor", () => {
    const md = "```marmind\ngraph LR\nA --- B\n```\n{size:180%; align:right}\n\nDone";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const diagram = document.querySelector<HTMLElement>(".cm-mermaid-widget");
    expect(diagram).toBeTruthy();
    diagram!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 10_000,
    }));

    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("graph LR"));
    cleanup();
  });

  test("typing a heading marker updates line styling on the changed line", () => {
    const { editor, cleanup } = mountCM6("Title\n\nBody");

    editor.setMarkdownSelection(0);
    editor.insertText("# ");

    expect(document.querySelector(".cm-md-h1")).toBeTruthy();
    cleanup();
  });

  test("semantic outline does not demote markdown heading rendering", () => {
    const md = "@@part [Foundations]\n\n# Construction";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const headingLine = document.querySelector<HTMLElement>(".cm-md-h1");
    expect(headingLine).toBeTruthy();
    expect(headingLine!.textContent).toContain("Construction");
    expect(document.querySelector(".cm-md-h6")).toBeNull();
    cleanup();
  });

  test("folds every ATX heading marker level through the toc index", () => {
    const md = "@@part [Foundations]\n\n# One\n\n### Three\n\n###### Six\n\nBody";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-md-h1")?.textContent).toContain("One");
    expect(document.querySelector(".cm-md-h3")?.textContent).toContain("Three");
    expect(document.querySelector(".cm-md-h6")?.textContent).toContain("Six");
    const hidden = Array.from(document.querySelectorAll<HTMLElement>(".syntax-hidden"))
      .map((el) => el.textContent);
    expect(hidden).toEqual(expect.arrayContaining(["# ", "### ", "###### "]));
    cleanup();
  });

  test("typing a code fence marker updates the affected code block line styling", () => {
    const { editor, cleanup } = mountCM6("``\n# Hidden\n```");
    expect(document.querySelector(".cm-md-h1")).toBeTruthy();

    editor.setMarkdownSelection(2);
    editor.insertText("`");

    expect(document.querySelector(".cm-md-h1")).toBeNull();
    expect(document.querySelector(".cm-md-code-block")).toBeTruthy();
    cleanup();
  });

  test("typing inside mermaid source updates the rendered widget source", () => {
    const md = "above\n\n```mermaid\ngraph TD\nA-->B\n```";
    const { editor, cleanup } = mountCM6(md);
    const insertAt = md.indexOf("graph TD") + "graph TD".length;

    editor.setMarkdownSelection(insertAt);
    editor.insertText("X");
    editor.setMarkdownSelection(0);

    const mermaidBlock = document.querySelector<HTMLElement>(".cm-mermaid-block");
    expect(mermaidBlock?.dataset.diagramRenderKey).toContain("graph TDX");
    cleanup();
  });

  test("editing one mermaid block preserves unrelated mermaid widget DOM", () => {
    const md = [
      "```mermaid",
      "graph TD",
      "A-->B",
      "```",
      "",
      "```mermaid",
      "graph TD",
      "C-->D",
      "```",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    const insertAt = md.indexOf("A-->B") + 1;

    editor.setMarkdownSelection(insertAt);
    const secondBlock = document.querySelector<HTMLElement>(".cm-mermaid-block");
    expect(secondBlock).toBeTruthy();

    editor.insertText("X");

    expect(document.querySelector(".cm-mermaid-block")).toBe(secondBlock);
    cleanup();
  });

  test("typing ordinary text above org-env preserves boundary widget DOM", () => {
    const md = "above\n\n#+begin theorem\nBody\n#+end theorem";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const heading = document.querySelector<HTMLElement>(".cm-org-env-heading-widget");
    expect(heading).toBeTruthy();

    editor.setMarkdownSelection(0);
    editor.insertText("x");

    expect(document.querySelector(".cm-org-env-heading-widget")).toBe(heading);
    cleanup();
  });

  test("editing one org-env title patches only that boundary widget", () => {
    const md = [
      "#+begin theorem One",
      "A",
      "#+end theorem",
      "",
      "#+begin lemma Two",
      "B",
      "#+end lemma",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const headings = Array.from(document.querySelectorAll<HTMLElement>(".cm-org-env-heading-widget"));
    const secondHeading = headings[1];
    expect(secondHeading).toBeTruthy();

    const from = md.indexOf("One");
    const insert = "Alpha";
    editor.view.dispatch({
      changes: { from, to: from + "One".length, insert },
      selection: { anchor: md.length + insert.length - "One".length },
    });

    const updated = Array.from(document.querySelectorAll<HTMLElement>(".cm-org-env-heading-widget"));
    expect(updated[0]?.querySelector(".org-env-heading-title")?.textContent).toBe("Alpha");
    expect(updated[1]).toBe(secondHeading);
    cleanup();
  });

  test("inserting a newline inside org-env body styles the new body line", () => {
    const md = "#+begin proof\nBody\n#+end proof";
    const { editor, cleanup } = mountCM6(md);

    editor.setMarkdownSelection(md.indexOf("Body") + "Body".length);
    editor.insertText("\nNext");

    expect(document.querySelectorAll(".cm-org-env-body-line")).toHaveLength(2);
    cleanup();
  });

  test("renders horizontal rule lines when cursor leaves the line", () => {
    const { editor, cleanup } = mountCM6("before\n\n---\n\nafter");
    editor.setMarkdownSelection(editor.getMarkdown().length);
    expect(document.querySelector(".cm-horizontal-rule")).toBeTruthy();
    cleanup();
  });

  test("renders a first-line horizontal rule after the cursor moves below it", () => {
    const { editor, cleanup } = mountCM6("---\n");
    editor.setMarkdownSelection(editor.getMarkdown().length);
    expect(document.querySelector(".cm-horizontal-rule")).toBeTruthy();
    cleanup();
  });

  test("renders highlight spans and hides delimiters away from the selection", () => {
    const md = "before ==important== after";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-highlight")?.textContent).toBe("==important==");
    expect(document.querySelectorAll(".cm-highlight .syntax-hidden")).toHaveLength(2);
    cleanup();
  });

  test("does not render highlight syntax inside inline code", () => {
    const md = "`==raw==` and ==shown== after";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    expect(document.querySelectorAll(".cm-highlight")).toHaveLength(1);
    expect(document.querySelector(".cm-highlight")?.textContent).toBe("==shown==");
    cleanup();
  });

  test("typing a horizontal rule marker updates block extra ranges", () => {
    const { editor, cleanup } = mountCM6("before\n\n--\n\nafter");

    editor.setMarkdownSelection("before\n\n--".length);
    editor.insertText("-");
    editor.setMarkdownSelection(editor.getMarkdown().length);

    expect(document.querySelector(".cm-horizontal-rule")).toBeTruthy();
    cleanup();
  });

  test("newline edits patch line-owned block extras without a document rescan", () => {
    const md = "before\n\n---tail\n\nafter";
    const { editor, cleanup } = mountCM6(md);
    const splitAt = md.indexOf("---") + 3;

    editor.view.dispatch({ changes: { from: splitAt, insert: "\n" } });
    editor.setMarkdownSelection(editor.getMarkdown().length);
    expect(document.querySelector(".cm-horizontal-rule")).toBeTruthy();

    editor.view.dispatch({ changes: { from: splitAt, to: splitAt + 1 } });
    editor.setMarkdownSelection(editor.getMarkdown().length);
    expect(document.querySelector(".cm-horizontal-rule")).toBeNull();
    cleanup();
  });

  test("renders CM6 toc from document headings and jumps on click", () => {
    const md = "# Title\n\n[toc]\n\n## Child\n\nBody";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const items = Array.from(document.querySelectorAll<HTMLElement>(".cm-toc .toc-item"));
    expect(items.map((item) => item.textContent)).toEqual(["Title", "Child"]);
    expect(items[1]!.style.getPropertyValue("--toc-depth")).toBe("1");
    items[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("Child"));
    cleanup();
  });

  test("toc fold state is scoped to duplicate heading instances", () => {
    const md = "# Course\n\n[toc]\n\n## Homework\n\n# Course\n\n## Homework";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    document.querySelector<HTMLButtonElement>(".cm-toc .toc-fold-chevron")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const items = Array.from(document.querySelectorAll<HTMLElement>(".cm-toc .toc-item"));
    expect(items.map((item) => item.querySelector(".toc-item-text")?.textContent)).toEqual([
      "Course",
      "Course",
      "Homework",
    ]);
    expect(items[0]!.querySelector(".toc-fold-chevron")?.classList.contains("is-folded")).toBe(true);
    expect(items[1]!.querySelector(".toc-fold-chevron")?.classList.contains("is-folded")).toBe(false);
    cleanup();
  });

  test("toc widget stays mounted during ordinary body edits", () => {
    const md = "# Title\n\n[toc]\n\n## Child\n\nBody";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const toc = document.querySelector<HTMLElement>(".cm-toc");
    expect(toc).toBeTruthy();

    editor.insertText(" edited");
    editor.setMarkdownSelection(editor.getMarkdown().length);

    expect(document.querySelector<HTMLElement>(".cm-toc")).toBe(toc);
    document.querySelectorAll<HTMLElement>(".cm-toc .toc-item")[1]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe(editor.getMarkdown().indexOf("Child"));
    cleanup();
  });

  test("toc folding a middle sibling keeps following sibling children visible", () => {
    const md = "# Course 1\n\n[toc]\n\n## A\n\n# Course 2\n\n## B\n\n# Course 3\n\n## C";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    document.querySelectorAll<HTMLButtonElement>(".cm-toc .toc-fold-chevron")[1]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const items = Array.from(document.querySelectorAll<HTMLElement>(".cm-toc .toc-item"));
    expect(items.map((item) => item.querySelector(".toc-item-text")?.textContent)).toEqual([
      "Course 1",
      "A",
      "Course 2",
      "Course 3",
      "C",
    ]);
    cleanup();
  });

  test("rendered CM6 toc ignores headings inside fenced code", () => {
    const md = "# Title\n\n[toc]\n\n```\n# Example\n```\n\n## Child";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const items = Array.from(document.querySelectorAll<HTMLElement>(".cm-toc .toc-item"));
    expect(items.map((item) => item.textContent)).toEqual(["Title", "Child"]);
    cleanup();
  });

  test("clicking an org-env heading reveals only the boundary line", () => {
    const { editor, cleanup } = mountCM6(String.raw`#+begin theorem
Body
#+end theorem`);
    editor.setMarkdownSelection(editor.getMarkdown().length);
    const heading = document.querySelector<HTMLElement>(".cm-org-env-heading-widget");
    expect(heading).toBeTruthy();
    heading!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe("#+begin theorem".length);
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeNull();
    cleanup();
  });

  test("org-env closing boundary collapses when a selection leaves the line", () => {
    const md = String.raw`#+begin proposition
Body
#+end proposition`;
    const { editor, cleanup } = mountCM6(md);
    const bodyFrom = md.indexOf("Body");
    const closeFrom = md.indexOf("#+end proposition");

    editor.setMarkdownSelection(closeFrom + 2);
    expect(document.querySelector(".cm-org-env-end-widget")).toBeNull();

    // This range still intersects the closing boundary, but its active end has
    // moved back into the body.  The source boundary must not remain cached.
    editor.setMarkdownSelection(bodyFrom, closeFrom + 2);
    expect(document.querySelector(".cm-org-env-end-widget")).toBeTruthy();
    cleanup();
  });

  test("editing an org-env title keeps typing on the open line", () => {
    const md = String.raw`#+begin summary title
Body
#+end summary`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const heading = document.querySelector<HTMLElement>(".cm-org-env-heading-widget");
    expect(heading).toBeTruthy();
    heading!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("title"));

    editor.insertText("ab");
    expect(editor.getMarkdown().split("\n")[0]).toBe("#+begin summary abtitle");
    expect(editor.getMarkdown().split("\n")[1]).toBe("Body");
    cleanup();
  });

  test("org-env body edits through the main CM6 document", () => {
    const md = String.raw`#+begin theorem Spectral
Body line
#+end theorem`;
    const { editor, cleanup } = mountCM6(md);
    const bodyEnd = md.indexOf("\n#+end theorem");
    editor.setMarkdownSelection(bodyEnd);
    editor.insertText("\n\nNext paragraph");

    expect(document.querySelector(".cm-org-env-heading-widget")).toBeTruthy();
    expect(document.querySelectorAll(".cm-org-env-body-line").length).toBeGreaterThan(0);
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent).not.toContain("#+begin");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent).not.toContain("#+end");
    expect(editor.getMarkdown()).toBe(String.raw`#+begin theorem Spectral
Body line

Next paragraph
#+end theorem`);
    cleanup();
  });

  test("empty org-env body accepts normal insertion between boundary lines", () => {
    const { editor, cleanup } = mountCM6(String.raw`#+begin theorem
#+end theorem`);
    editor.setMarkdownSelection("#+begin theorem\n".length);
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent).not.toContain("#+end");
    editor.insertText("Statement.\n");
    expect(editor.getMarkdown()).toBe(String.raw`#+begin theorem
Statement.
#+end theorem`);
    cleanup();
  });

  test("org-env has no nested content editor", () => {
    const md = String.raw`#+begin proof ada
Proof.
#+end proof`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("Proof."));
    expect(document.querySelector(".cm-org-env-content")).toBeNull();
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeTruthy();
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("nested org-env blocks render as nested CM6 chrome", () => {
    const md = String.raw`#+begin proof
outer

#+begin theorem Inner
inside
#+end theorem

#+end proof`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("inside"));

    const headings = Array.from(document.querySelectorAll<HTMLElement>(".cm-org-env-heading-widget"));
    expect(headings.map((heading) => heading.dataset.orgEnvKind)).toEqual(["proof", "theorem"]);
    expect(headings[0]!.style.getPropertyValue("--org-env-depth")).toBe("0");
    expect(headings[1]!.style.getPropertyValue("--org-env-depth")).toBe("1");

    const innerBodyLine = Array.from(document.querySelectorAll<HTMLElement>(".cm-org-env-body-line"))
      .find((line) => line.textContent?.includes("inside"));
    expect(innerBodyLine?.dataset.orgEnvDepth).toBe("1");
    cleanup();
  });

  test("dense org-env blocks keep body line chrome on every body line", () => {
    const md = Array.from({ length: 4 }, (_, index) => String.raw`#+begin theorem Block ${index + 1}
Line ${index + 1} one has enough words to exercise wrapped org-env body layout.

Line ${index + 1} two remains normal editable markdown.
#+end theorem`).join("\n\n");
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);

      expect(document.querySelectorAll(".cm-org-env-heading-widget")).toHaveLength(4);
      const textBodyLines = Array.from(document.querySelectorAll<HTMLElement>(".cm-org-env-body-line"))
        .filter((line) => line.textContent?.includes("Line "));
      expect(textBodyLines).toHaveLength(8);
      expect(textBodyLines.every((line) => line.dataset.orgEnvDepth === "0")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("Mod-Enter exits one org-env level at a time", () => {
    const md = String.raw`#+begin proof
outer

#+begin theorem Inner
inside
#+end theorem

#+end proof
outside`;
    const { editor, cleanup } = mountCM6(md);
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;

    function pressModEnter(): void {
      const before = editor.getMarkdownSelection().from;
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
      if (editor.getMarkdownSelection().from !== before) return;
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    }

    editor.setMarkdownSelection(md.indexOf("inside"));
    pressModEnter();
    const innerClose = md.indexOf("#+end theorem");
    expect(editor.getMarkdownSelection().from).toBe(innerClose + "#+end theorem\n".length);

    pressModEnter();
    const outerClose = md.indexOf("#+end proof");
    expect(editor.getMarkdownSelection().from).toBe(outerClose + "#+end proof\n".length);
    cleanup();
  });

  test("vim-lite handles org-env through normal editor selection", () => {
    const md = String.raw`#+begin proof
Line one

Line two
#+end proof`;
    const { editor, cleanup } = mountCM6(md);
    const vim = createVimLite(editor, document.body);
    vim.setMode("insert");
    editor.setMarkdownSelection(md.indexOf("Line one"));
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    expect(vim.handleKeyDown(event)).toBe(false);
    expect(document.querySelector(".cm-org-env-body-line")).toBeTruthy();
    cleanup();
  });

  test("meta cover edits one property range without rewriting the block", async () => {
    const md = String.raw`#+begin meta
title: Alpha
tags: one, two
#+end meta`;
    const { editor, cleanup } = mountCM6(md);
    expect(document.querySelector(".aaronnote-meta-title")?.textContent).toBe("Alpha");
    expect(document.querySelector(".aaronnote-meta-roam-badge")).toBeTruthy();
    const details = document.querySelector<HTMLDetailsElement>(".aaronnote-meta-properties")!;
    details.open = true;
    const values = document.querySelectorAll<HTMLInputElement>(".aaronnote-meta-property-value");
    expect(values).toHaveLength(2);
    values[0]!.value = "Beta";
    values[0]!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await nextTick();
    expect(editor.getMarkdown()).toBe(md.replace("title: Alpha", "title: Beta"));
    expect(document.querySelector(".aaronnote-meta-title")?.textContent).toBe("Beta");
    cleanup();
  });

  test("meta renders its nested summary as a single abstract cover widget", () => {
    const md = String.raw`#+begin meta
title: Tensor Isomorphism
date: 2026-07-13
tags: algebra, graph, tensor
#+begin summary
We present **three results**.

1. First reduction.
2. Second reduction.
#+end summary
#+end meta`;
    const { editor, cleanup } = mountCM6(md);

    expect(document.querySelectorAll(".cm-org-env-block[data-kind='meta']")).toHaveLength(1);
    expect(document.querySelector(".aaronnote-meta-abstract-title")?.textContent).toBe("Abstract");
    expect(document.querySelector(".aaronnote-meta-abstract-content strong")?.textContent).toBe("three results");
    expect(document.querySelectorAll(".aaronnote-meta-tags .aaronnote-meta-tag")).toHaveLength(3);
    expect(document.querySelector("[data-kind='summary']")).toBeNull();
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("meta summary fields always use native input outside Vim mode", () => {
    const md = String.raw`#+begin meta
title: Native Summary
#+begin summary
First draft.
#+end summary
#+end meta`;
    const { editor, host, cleanup } = mountCM6(md);
    const summaryEditor = host.querySelector<HTMLElement>(".aaronnote-meta-summary-editor")!;
    const textarea = summaryEditor.querySelector<HTMLTextAreaElement>("textarea")!;
    const vim = createVimLite(editor, host);
    vim.setMode("normal");

    expect(summaryEditor.dataset.aaronnoteVim).toBe("native");
    for (const key of ["a", "x", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: textarea });
      expect(vim.handleKeyDown(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(vim.mode()).toBe("normal");
    }
    vim.destroy();
    cleanup();
  });

  test("meta is recognized only in the short document preamble", () => {
    const prefix = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const md = `${prefix}\n#+begin meta\ntitle: Mid-document\n#+end meta`;
    const { editor, cleanup } = mountCM6(md);

    expect(document.querySelector(".cm-org-env-block[data-kind='meta']")).toBeNull();
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  test("clicking a rendered display math block opens source without revealing the old cursor", () => {
    const md = "before\n\n\\[\na+b\n\\]\n\nafter";
    const { editor, host, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(0);
    host.scrollTop = 420;
    editor.view.scrollDOM.scrollTop = 37;
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const focus = vi.spyOn(editor.view.contentDOM, "focus");
    const block = document.querySelector<HTMLElement>(".cm-math-block");
    expect(block).toBeTruthy();
    block!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const selection = editor.getMarkdownSelection();
    expect(selection.from).toBe(md.indexOf("a+b"));
    expect(document.querySelector(".cm-math-block")).toBeNull();
    expect(document.querySelector(".cm-math-block-preview")).toBeNull();
    expect(document.querySelectorAll(".cm-math-source-line")).toHaveLength(3);
    expect(document.querySelectorAll(".syntax-hint").length).toBeGreaterThanOrEqual(2);
    const pointerSelection = dispatch.mock.calls
      .map(([spec]) => spec as { selection?: unknown; scrollIntoView?: boolean })
      .find((spec) => spec.selection != null);
    expect(pointerSelection?.scrollIntoView).not.toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(host.scrollTop).toBe(420);
    expect(editor.view.scrollDOM.scrollTop).toBe(37);
    cleanup();
  });

  test("passive reader keeps rendered display math closed on click", () => {
    const md = "before\n\n\\[\na+b\n\\]\n\nafter";
    const { editor, cleanup } = mountCM6(md, { readOnly: true, passiveReader: true });
    editor.setMarkdownSelection(0);
    const block = document.querySelector<HTMLElement>(".cm-math-block");
    expect(block).toBeTruthy();

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    block!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(0);
    expect(document.querySelector(".cm-math-block")).toBeTruthy();
    expect(document.querySelectorAll(".cm-math-source-line")).toHaveLength(0);
    cleanup();
  });

  test("expanded org-env display math is source-only", () => {
    const md = String.raw`#+begin proof
\[
\langle v,w_1+w_2 \rangle
=
\overline{\langle w_1,v \rangle}
+
\overline{\langle w_2,v \rangle}.
\]
#+end proof`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("w_1,v"));

    expect(document.querySelector(".cm-math-block")).toBeNull();
    expect(document.querySelector(".cm-math-block-preview")).toBeNull();
    expect(document.querySelectorAll(".cm-math-source-line")).toHaveLength(7);
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain(String.raw`\overline{\langle w_1,v \rangle}`);
    cleanup();
  });

  test("expanded display math suppresses other preview widgets inside org-env", () => {
    const md = String.raw`#+begin proof
\[
\langle \cdot,\cdot \rangle : V \times V \to F.
# Stack
@@todo(done) [sample]{ddl=2026-01-01}
![alt](missing.png)
$x$
\]
#+end proof`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("# Stack") + 2);

    expect(document.querySelector(".cm-math-block")).toBeNull();
    expect(document.querySelector(".cm-math-inline")).toBeNull();
    expect(document.querySelector(".cm-md-h1")).toBeNull();
    expect(document.querySelector(".inline-todo-widget")).toBeNull();
    expect(document.querySelector(".cm-image-widget")).toBeNull();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("# Stack");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("@@todo(done) [sample]{ddl=2026-01-01}");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("$x$");
    cleanup();
  });

  test("renders compact inline tags as inline anchor markers", () => {
    const md = "alpha @@tag[qc]\nplain";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const tag = document.querySelector<HTMLElement>(".inline-tag-widget");
    expect(tag).toBeTruthy();
    expect(tag!.textContent).toBe("§qc");
    expect(tag!.querySelector(".inline-tag-anchor")?.textContent).toBe("§");
    expect(tag!.querySelector(".inline-tag-label")?.textContent).toBe("qc");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@tag[qc]");

    editor.setMarkdownSelection(md.indexOf("@@tag") + 2);
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("@@tag[qc]");
    cleanup();
  });

  test("renders multiple inline tags as inline anchor markers", () => {
    const { cleanup } = mountCM6("alpha @@tag[first] @@tag[second]\nplain");
    const tags = Array.from(document.querySelectorAll<HTMLElement>(".inline-tag-widget"))
      .map((tag) => tag.textContent);
    expect(tags).toEqual(["§first", "§second"]);
    cleanup();
  });

  test("renders note-code commands as highlighted read-only code cards", async () => {
    const previous = window.aaronnoteApi;
    const openCalls: Array<{ file?: string; tag?: string }> = [];
    window.aaronnoteApi = {
      noteCode: {
        readRegion: async (body: unknown) => ({
          ok: true,
          file: "/Proofs/Sample.lean",
          body: "theorem sample : True := by\n  trivial",
          language: "lean4",
          ...(body as Record<string, unknown>),
        }),
      },
      emacs: {
        open: async (body: { file: string; tag?: string }) => {
          openCalls.push(body);
        },
      },
    };
    const md = "@@note-code(/Proofs/Sample.lean)[sample]\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const card = document.querySelector<HTMLElement>(".cm-note-code-widget");
      expect(card).toBeTruthy();
      expect(card!.textContent).toContain("/Proofs/Sample.lean [sample]");
      expect(card!.textContent).toContain("theorem sample");
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
        .not.toContain("@@note-code");

      const openButton = card!.querySelector<HTMLButtonElement>(".cm-note-code-open-btn");
      expect(openButton).toBeTruthy();
      expect(openButton!.disabled).toBe(false);
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      openButton!.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);

      openButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(openCalls).toEqual([]);
      openButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
      expect(openCalls).toEqual([{ file: "/Proofs/Sample.lean", tag: "sample" }]);
    } finally {
      cleanup();
      window.aaronnoteApi = previous;
    }
  });

  test("renders itodo widgets with a right-side rail", () => {
    const md = "@@itodo(doing) [write proof]{ddl=2026-05-20}\nplain";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const todo = document.querySelector<HTMLElement>(".inline-todo-widget");
    expect(todo).toBeTruthy();
    expect(todo!.dataset.command).toBe("itodo");
    expect(todo!.dataset.status).toBe("doing");
    expect(todo!.dataset.shape).toBe("inline");
    expect(todo!.textContent).toContain("[write proof]");
    const datePill = todo!.querySelector<HTMLElement>(".inline-todo-date");
    expect(datePill).toBeTruthy();
    expect(datePill!.dataset.key).toBe("ddl");
    expect(datePill!.querySelector(".inline-todo-date-value")!.textContent).toBe("2026-05-20");
    expect(todo!.querySelector(".inline-todo-rail")).toBeTruthy();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@itodo");

    editor.setMarkdownSelection(md.indexOf("@@itodo") + 2);
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("@@itodo(doing) [write proof]");
    cleanup();
  });

  test("renders block itodo widgets as a right-side rail card using block attrs", () => {
    const md = [
      "@@itodo(doing) [write proof] {",
      "  project: iso-202603",
      "  sche: 2026-07-06",
      "  end: 2026-07-10",
      "  prio: A",
      "  effort: 3h",
      "}",
      "plain",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const todo = document.querySelector<HTMLElement>(".inline-todo-widget");
    expect(todo).toBeTruthy();
    expect(todo!.dataset.command).toBe("itodo");
    expect(todo!.dataset.status).toBe("doing");
    expect(todo!.dataset.shape).toBe("block");
    expect(todo!.querySelector(".inline-todo-rail")).toBeTruthy();
    expect(todo!.querySelector(".inline-todo-card")).toBeTruthy();
    expect(todo!.textContent).toContain("write proof");
    expect(todo!.textContent).toContain("iso-202603");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@itodo(doing) [write proof]");
    expect(document.querySelector(".cm-itodo-block-anchor-line")).toBeTruthy();
    expect(document.querySelector(".cm-itodo-block-hidden-line")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("project:"));
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("@@itodo(doing) [write proof]");
    expect(document.querySelector(".cm-itodo-block-anchor-line")).toBeNull();
    expect(document.querySelector(".cm-itodo-block-hidden-line")).toBeNull();
    cleanup();
  });

  test("renders todo widgets as local planning cards", () => {
    const md = "@@todo(doing) [write proof]{ddl=2026-05-20, project=iso-202603}\nplain";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const todo = document.querySelector<HTMLElement>(".inline-planning-widget[data-kind='todo']");
    expect(todo).toBeTruthy();
    expect(todo!.dataset.status).toBe("doing");
    expect(todo!.dataset.planningKind).toBe("todo");
    expect(todo!.dataset.planningSourceFrom).toBe("0");
    expect(Number(todo!.dataset.planningSourceTo)).toBe(md.indexOf("\nplain"));
    expect(todo!.textContent).toContain("TODO");
    expect(todo!.textContent).toContain("DOING");
    expect(todo!.textContent).toContain("write proof");
    expect(todo!.textContent).toContain("iso-202603");
    expect(todo!.querySelector(".inline-todo-rail")).toBeNull();
    expect(document.querySelector(".inline-todo-widget")).toBeNull();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@todo");

    editor.setMarkdownSelection(md.indexOf("@@todo") + 2);
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("@@todo(doing) [write proof]");
    cleanup();
  });

  test("renders planning commands as local block cards", () => {
    const md = [
      "@@project(active) ISO 202603 tensor paper {",
      "  project: iso-202603",
      "  area: UNSW",
      "  owner: Aaron",
      "}",
      "",
      "@@milestone Internal proof freeze {project: iso-202603, date: 2026-07-17}",
      "",
      "@@clock Clean graph tensor definitions {",
      "  project: iso-202603",
      "  from: \"2026-07-06 09:30\"",
      "  to: \"2026-07-06 11:00\"",
      "}",
      "plain",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const cards = Array.from(document.querySelectorAll<HTMLElement>(".inline-planning-widget"));
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.dataset.kind)).toEqual(["project", "milestone", "clock"]);
    expect(cards[0]!.textContent).toContain("PROJECT");
    expect(cards[0]!.textContent).toContain("ACTIVE");
    expect(cards[0]!.textContent).toContain("ISO 202603 tensor paper");
    expect(cards[0]!.textContent).toContain("Aaron");
    expect(cards[1]!.textContent).toContain("Internal proof freeze");
    expect(cards[2]!.textContent).toContain("Clean graph tensor definitions");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@project(active)");
    expect(document.querySelector(".cm-planning-block-hidden-line")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("owner:"));
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("@@project(active) ISO 202603 tensor paper");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("owner: Aaron");
    cleanup();
  });

  test("renders bracketed math inside local todo widgets", () => {
    const md = String.raw`@@todo [prove \(\alpha_{[i]}\) and \(\sqrt[3]{x}\)]{ddl=2026-06-01}` + "\nplain";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const todo = document.querySelector<HTMLElement>(".inline-planning-widget[data-kind='todo']");
    expect(todo).toBeTruthy();
    expect(todo!.textContent).toContain("prove");
    expect(todo!.querySelector(".katex")).toBeTruthy();
    expect(todo!.querySelector(".inline-todo-date-value")!.textContent).toBe("2026-06-01");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@todo");
    cleanup();
  });

  test("renders bare todo text as a local card through the line end", () => {
    const md = "@@todo 把 λ, κ 的证明与想法整理为可靠资料\nplain";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const todo = document.querySelector<HTMLElement>(".inline-planning-widget[data-kind='todo']");
    expect(todo).toBeTruthy();
    expect(todo!.dataset.status).toBe("todo");
    expect(todo!.textContent).toContain("把 λ, κ 的证明与想法整理为可靠资料");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("@@todo");
    cleanup();
  });

  test("org-env scanner ignores boundary-looking lines inside display math", () => {
    const md = String.raw`#+begin proof
before
\[
#+end proof
\]
after
#+end proof`;
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.indexOf("after"));

    const headings = Array.from(document.querySelectorAll<HTMLElement>(".cm-org-env-heading-widget"));
    expect(headings).toHaveLength(1);
    expect(headings[0]!.dataset.orgEnvKind).toBe("proof");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("after");
    cleanup();
  });

  test("ArrowDown and ArrowUp do not force org-env back into source mode", () => {
    const md = "before\n\n#+begin theorem\nBody\n#+end theorem\n\nafter";
    const { editor, cleanup } = mountCM6(md);
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;

    editor.setMarkdownSelection(2);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeTruthy();

    editor.setMarkdownSelection(md.length);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeTruthy();
    cleanup();
  });

  test("clicking rendered inline widgets opens their markdown source", () => {
    const md = "before \\(x+1\\) after\n\n- [ ] task\n\n![alt](missing.png)";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const inlineMath = document.querySelector<HTMLElement>(".cm-math-inline");
    expect(inlineMath).toBeTruthy();
    inlineMath!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("\\(x+1\\)") + 2);
    expect(document.querySelector(".cm-math-inline")).toBeNull();

    editor.setMarkdownSelection(0);
    const image = document.querySelector<HTMLElement>(".cm-image-widget");
    expect(image).toBeTruthy();
    image!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("![alt]") + 1);
    cleanup();
  });

  test("selection-only updates open and restore CM6 inline widget source", () => {
    const md = [
      "before \\(x+1\\) after",
      "",
      "@@itodo(doing) [write proof]",
      "",
      "- [ ] task",
      "",
      "![alt](missing.png)",
      "",
      "plain",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-math-inline")).toBeTruthy();
    expect(document.querySelector(".inline-todo-widget")).toBeTruthy();
    expect(document.querySelector(".cm-task-checkbox")).toBeTruthy();
    expect(document.querySelector(".cm-image-widget")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("x+1"));
    expect(document.querySelector(".cm-math-inline")).toBeNull();
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-math-inline")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("@@itodo") + 2);
    expect(document.querySelector(".inline-todo-widget")).toBeNull();
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".inline-todo-widget")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("[ ]") + 1);
    expect(document.querySelector(".cm-task-checkbox")).toBeNull();
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-task-checkbox")).toBeTruthy();

    editor.setMarkdownSelection(md.indexOf("![alt]") + 1);
    expect(document.querySelector(".cm-image-widget")).toBeNull();
    editor.setMarkdownSelection(md.length);
    expect(document.querySelector(".cm-image-widget")).toBeTruthy();
    cleanup();
  });

  test("image widgets resolve note-relative asset urls through Noema resolver", () => {
    const original = window.AaronnoteResolveAssetUrl;
    window.AaronnoteResolveAssetUrl = (src) => `/api/media?file=${encodeURIComponent(src)}&base=note.md`;
    const { editor, cleanup } = mountCM6("before\n\n![alt](img/example.png)");
    editor.setMarkdownSelection(0);
    const image = document.querySelector<HTMLImageElement>(".cm-image-widget img");
    expect(image).toBeTruthy();
    expect(image!.getAttribute("src")).toBe("/api/media?file=img%2Fexample.png&base=note.md");
    cleanup();
    window.AaronnoteResolveAssetUrl = original;
  });

  test("image widgets keep parent-directory asset paths before resolving", () => {
    const original = window.AaronnoteResolveAssetUrl;
    window.AaronnoteResolveAssetUrl = (src) => `/api/media?file=${encodeURIComponent(src)}&base=notes%2Ftopic.md`;
    const { editor, cleanup } = mountCM6("before\n\n![alt](<../images/example.png> \"Plot\")");
    editor.setMarkdownSelection(0);
    const image = document.querySelector<HTMLImageElement>(".cm-image-widget img");
    expect(image).toBeTruthy();
    expect(image!.getAttribute("src")).toBe("/api/media?file=..%2Fimages%2Fexample.png&base=notes%2Ftopic.md");
    cleanup();
    window.AaronnoteResolveAssetUrl = original;
  });

  test("image widgets render alt text as a caption", () => {
    const md = "![Diagram title](missing.png)\n\ntext";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);
    const caption = document.querySelector<HTMLElement>(".cm-image-caption");
    expect(caption).toBeTruthy();
    expect(caption!.textContent).toBe("Diagram title");
    cleanup();
  });

  test("draw.io attachments render through the image widget iframe", () => {
    const md = "![Diagram title](attachments/demo.drawio)\n\ntext";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const iframe = document.querySelector<HTMLIFrameElement>(".cm-visual-embed-drawio");
    expect(iframe).toBeTruthy();
    expect(iframeSrcdoc(iframe!)).toContain("embed.diagrams.net");
    expect(iframeSrcdoc(iframe!)).toContain('action: "load"');
    expect(document.querySelector(".cm-image-widget img")).toBeNull();
    cleanup();
  });

  test("html attachments render through an isolated image widget iframe", () => {
    const md = "![Panel](attachments/demo.html)\n\ntext";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const iframe = document.querySelector<HTMLIFrameElement>(".cm-visual-embed-html");
    expect(iframe).toBeTruthy();
    expect(iframeSrc(iframe!)).toContain("attachments/demo.html");
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-downloads");
    expect(document.querySelector(".cm-image-widget img")).toBeNull();
    cleanup();
  });

  test("empty html links render through the image widget iframe", () => {
    const md = "[](attachments/demo.html)\n\ntext";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const iframe = document.querySelector<HTMLIFrameElement>(".cm-visual-embed-html");
    expect(iframe).toBeTruthy();
    expect(iframeSrc(iframe!)).toContain("attachments/demo.html");
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-downloads");
    expect(document.querySelector(".cm-image-widget img")).toBeNull();
    cleanup();
  });

  test("image widgets consume trailing layout attrs", () => {
    const md = "![Diagram title](missing.png){size:300%; align:left; wrap:on}\n\ntext";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const figure = document.querySelector<HTMLElement>(".cm-image-widget");
    expect(figure).toBeTruthy();
    expect(figure!.classList.contains("cm-aaronnote-measured-widget")).toBe(false); // wrap images are non-measured (float)
    expect(figure!.classList.contains("aaronnote-image-align-left")).toBe(true);
    expect(figure!.classList.contains("aaronnote-image-wrap")).toBe(true);
    expect(figure!.style.getPropertyValue("--aaronnote-image-width")).toBe("300%");
    expect(figure!.style.getPropertyValue("--aaronnote-image-max-width")).toBe("none");
    expect(figure!.style.getPropertyValue("--aaronnote-image-max-height")).toBe("none");
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .not.toContain("{size:300%");

    editor.setMarkdownSelection(md.indexOf("size"));
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("{size:300%; align:left; wrap:on}");
    cleanup();
  });

  test("aligned image widgets open source at a stable anchor", () => {
    const md = "![Diagram title](missing.png){size:300%; align:right}\n\ntext";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const figure = document.querySelector<HTMLElement>(".cm-image-widget");
    expect(figure).toBeTruthy();
    figure!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 10_000,
    }));

    expect(editor.getMarkdownSelection().from).toBe(md.indexOf("![Diagram title]") + 1);
    cleanup();
  });

  test("wrapped layout clicks use native text hit-testing when CM coords drift", async () => {
    const md = "![alt](missing.png){size:160; align:left; wrap:on}\n\nhello world";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const walker = document.createTreeWalker(editor.view.contentDOM, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node instanceof Text && node.nodeValue?.includes("hello world")) {
        textNode = node;
        break;
      }
    }
    expect(textNode).toBeTruthy();

    const range = document.createRange();
    range.setStart(textNode!, 2);
    range.collapse(true);
    const docWithCaret = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const originalCaretRangeFromPoint = docWithCaret.caretRangeFromPoint;
    const view = editor.view as typeof editor.view & {
      posAtCoords: (coords: { x: number; y: number }) => number | null;
    };
    const originalPosAtCoords = Object.getOwnPropertyDescriptor(view, "posAtCoords");

    docWithCaret.caretRangeFromPoint = () => range;
    Object.defineProperty(view, "posAtCoords", {
      configurable: true,
      value: () => 0,
    });

    try {
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      const handled = calibrateWrappedLayoutClick(editor.view, event);
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      expect(handled).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(md.indexOf("hello") + 2);
    } finally {
      if (originalCaretRangeFromPoint) docWithCaret.caretRangeFromPoint = originalCaretRangeFromPoint;
      else delete (docWithCaret as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
      if (originalPosAtCoords) Object.defineProperty(view, "posAtCoords", originalPosAtCoords);
      else delete (view as { posAtCoords?: unknown }).posAtCoords;
      cleanup();
    }
  });

  test("clicking task checkbox toggles its checked state directly", () => {
    // Use a header line to park the cursor away from both task lines,
    // so both checkboxes render (task-list hides raw marker only on the cursor line).
    const md = "# heading\n\n- [ ] task one\n- [x] task two";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(0); // cursor on heading line

    const checkboxes = document.querySelectorAll<HTMLElement>(".cm-task-checkbox");
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0]!.querySelector(".checkbox")).toBeTruthy();
    expect(checkboxes[1]!.querySelector(".checkbox")?.getAttribute("data-checked")).toBe("1");

    // Click unchecked → checked
    checkboxes[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdown()).toContain("- [x] task one");

    // Click checked → unchecked
    checkboxes[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.getMarkdown()).toContain("- [ ] task two");
    cleanup();
  });

  test("renders comment org-env with CM6 comment chip and toggleable popup", () => {
    const md = "#+begin comment reviewer\nHidden **note**\n#+end comment\n\nAfter";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const comment = document.querySelector<HTMLElement>('org-env-block[data-kind="comment"]');
    expect(comment).toBeTruthy();
    expect(comment!.classList.contains("cm-org-env-comment-widget")).toBe(true);
    expect(document.querySelector('.cm-org-env-rail[data-org-env-kind="comment"]')).toBeNull();

    const button = comment!.querySelector<HTMLButtonElement>(".org-env-comment-button");
    const content = comment!.querySelector<HTMLElement>(".org-env-content");
    expect(button?.querySelector(".org-env-comment-label")?.textContent).toBe("reviewer");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(content?.hidden).toBe(true);

    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(content?.hidden).toBe(false);
    expect(content?.querySelector("strong")?.textContent).toBe("note");
    expect(comment!.classList.contains("org-env-comment-open")).toBe(true);

    editor.setMarkdownSelection(md.indexOf("Hidden"));
    expect(document.querySelector('org-env-block[data-kind="comment"]')).toBeNull();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("Hidden **note**");
    cleanup();
  });

  test("renders fold org-env collapsed with markdown title and transient open state", () => {
    const md = "#+begin fold **Details**\nHidden **body**\n#+end fold\n\nAfter";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);

      const fold = document.querySelector<HTMLElement>('org-env-block[data-kind="fold"]');
      expect(fold).toBeTruthy();
      expect(fold!.classList.contains("cm-org-env-fold-widget")).toBe(true);
      expect(fold!.getAttribute("data-fold-open")).toBe("false");
      expect(document.querySelector('.cm-org-env-rail[data-org-env-kind="fold"]')).toBeNull();

      const button = fold!.querySelector<HTMLButtonElement>(".org-env-fold-summary");
      const content = fold!.querySelector<HTMLElement>(".org-env-fold-content");
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      expect(button?.querySelector(".org-env-fold-title strong")?.textContent).toBe("Details");
      expect(content?.hidden).toBe(true);

      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(button?.getAttribute("aria-expanded")).toBe("true");
      expect(content?.hidden).toBe(false);
      expect(content?.querySelector("strong")?.textContent).toBe("body");
      expect(fold!.classList.contains("org-env-fold-open")).toBe(true);

      editor.setMarkdown(md, { history: "reset" });
      editor.setMarkdownSelection(md.length);
      const reloaded = document.querySelector<HTMLElement>('org-env-block[data-kind="fold"]');
      expect(reloaded?.getAttribute("data-fold-open")).toBe("false");
      expect(reloaded?.querySelector<HTMLElement>(".org-env-fold-content")?.hidden).toBe(true);

      editor.setMarkdownSelection(md.indexOf("Hidden"));
      expect(document.querySelector('org-env-block[data-kind="fold"]')).toBeNull();
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
        .toContain("Hidden **body**");
    } finally {
      cleanup();
    }
  });

  test("renders diagram fences inside collapsed comment content", () => {
    const md = [
      "#+begin comment diagram",
      "```marmind",
      "graph LR",
      "  A --- B",
      "```",
      "#+end comment",
      "",
      "After",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const button = document.querySelector<HTMLButtonElement>(".org-env-comment-button");
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const content = document.querySelector<HTMLElement>(".cm-org-env-comment-widget .org-env-content");
    expect(content?.querySelector(".cm-mermaid-block-preview")).toBeTruthy();
    expect(content?.querySelector("pre > code.language-marmind")).toBeNull();
    cleanup();
  });

  test("html org-env keeps embedded controls interactive", () => {
    const md = [
      "#+begin html",
      '<input class="raw-input" value="x">',
      "#+end html",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    const input = document.querySelector<HTMLInputElement>(".cm-html-env-widget .raw-input");
    expect(input).toBeTruthy();
    input!.focus();
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    input!.dispatchEvent(event);

    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(false);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// insertText / replaceMarkdownRange / textBetween
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: text mutations", () => {
  test("insertText appends at cursor", () => {
    const { editor, cleanup } = mountCM6("hello");
    // cursor at end after setMarkdown; insertText appends
    editor.setMarkdownSelection(5, 5);
    editor.insertText(" world");
    expect(editor.getMarkdown()).toBe("hello world");
    cleanup();
  });

  test("insertText with deleteBefore", () => {
    const { editor, cleanup } = mountCM6("hello");
    editor.setMarkdownSelection(5, 5);
    editor.insertText("!", 5); // delete 5 chars before cursor, insert "!"
    expect(editor.getMarkdown()).toBe("!");
    cleanup();
  });

  test("replaceMarkdownRange replaces mid-doc", () => {
    const { editor, cleanup } = mountCM6("foo bar baz");
    editor.replaceMarkdownRange(4, 7, "qux");
    expect(editor.getMarkdown()).toBe("foo qux baz");
    cleanup();
  });

  test("textBetween reads source slice", () => {
    const { editor, cleanup } = mountCM6("abcdef");
    expect(editor.textBetween(2, 5)).toBe("cde");
    cleanup();
  });

  test("paste inserts markdown-looking plain text as source", () => {
    const { editor, cleanup } = mountCM6("");
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData: Pick<DataTransfer, "files" | "getData">;
    };
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => type === "text/plain" ? "## Title" : "",
      },
    });
    (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getMarkdown()).toBe("## Title");
    cleanup();
  });

  test("paste converts clipboard html to markdown when plain text is not source", () => {
    const { editor, cleanup } = mountCM6("");
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
      clipboardData: Pick<DataTransfer, "files" | "getData">;
    };
    Object.defineProperty(event, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => {
          if (type === "text/plain") return "Title\nPlain body";
          if (type === "text/html") return "<h2>Title</h2><p>Plain body</p>";
          return "";
        },
      },
    });
    (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getMarkdown()).toBe("## Title\n\nPlain body");
    cleanup();
  });

  test("paste stores image files through the editor asset adapter", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = createEditor(host, {
      kernel: "cm6",
      initialContent: "",
      getCurrentFile: () => "/notes/topic.md",
      pasteAssets: {
        uploadBlobAsset: async (_blob, meta) => ({
          ok: true,
          isImage: true,
          name: meta.name,
          type: meta.type,
          markdownPath: "./images/topic/plot.png",
        }),
      },
    });
    try {
      const file = new File(["PNG"], "plot.png", { type: "image/png" });
      const handled = await editor.pasteFromDataTransfer({
        files: [file],
        items: [],
        getData: () => "",
      } as unknown as DataTransfer);
      expect(handled).toBe(true);
      expect(editor.getMarkdown()).toBe("![plot.png](./images/topic/plot.png)");
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// getMarkdownSelection / setMarkdownSelection
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: selection", () => {
  test("setMarkdownSelection moves cursor", () => {
    const { editor, cleanup } = mountCM6("hello world");
    editor.setMarkdownSelection(6, 11);
    const sel = editor.getMarkdownSelection();
    expect(sel.from).toBe(6);
    expect(sel.to).toBe(11);
    cleanup();
  });

  test("collapsed selection", () => {
    const { editor, cleanup } = mountCM6("hello");
    editor.setMarkdownSelection(3);
    const sel = editor.getMarkdownSelection();
    expect(sel.from).toBe(3);
    expect(sel.to).toBe(3);
    cleanup();
  });

  test("vim-lite moves CM6 cursor with ArrowUp/ArrowDown and j/k", () => {
    const { editor, cleanup } = mountCM6("aa\nbbbb\ncc");
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body);
    function press(key: string): void {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    }

    editor.setMarkdownSelection(1);
    vim.setMode("normal");
    press("ArrowDown");
    expect(editor.getMarkdownSelection().from).toBe(4);
    press("ArrowDown");
    expect(editor.getMarkdownSelection().from).toBe(9);
    press("ArrowUp");
    expect(editor.getMarkdownSelection().from).toBe(4);
    press("j");
    expect(editor.getMarkdownSelection().from).toBe(9);
    press("k");
    expect(editor.getMarkdownSelection().from).toBe(4);
    cleanup();
  });

  test("vim-lite delegates insert-mode vertical movement to CM6", () => {
    const { editor, cleanup } = mountCM6("ab\ncd");
    const vim = createVimLite(editor, document.body);
    editor.setMarkdownSelection(2);
    expect(vim.handleKey({ key: "ArrowDown" })).toBe(false);
    expect(editor.getMarkdownSelection()).toEqual({ from: 2, to: 2 });
    cleanup();
  });

  test("vim-lite j/k use CM6 screen rows and preserve its pixel goal column", () => {
    const { editor, cleanup } = mountCM6("a very long physical line that wraps");
    const content = editor.view.contentDOM;
    const rect = vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240,
      width: 320, height: 240, toJSON: () => ({}),
    } as DOMRect);
    const move = vi.spyOn(editor.view, "moveVertically")
      .mockReturnValueOnce(EditorSelection.cursor(12, 0, undefined, 73))
      .mockReturnValueOnce(EditorSelection.cursor(4, 0, undefined, 73));
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(2);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "j" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: 12, to: 12 });
    expect(vim.handleKey({ key: "k" })).toBe(true);
    expect(move.mock.calls[1]![0].goalColumn).toBe(73);
    expect(editor.getMarkdownSelection()).toEqual({ from: 4, to: 4 });

    rect.mockRestore();
    cleanup();
  });

  test("vim-lite j/k enter display math instead of skipping its replacement widget", () => {
    const md = String.raw`Before
\[
x + y
\]
After`;
    const { editor, cleanup } = mountCM6(md);
    const content = editor.view.contentDOM;
    const rect = vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240,
      width: 320, height: 240, toJSON: () => ({}),
    } as DOMRect);
    const before = md.indexOf("Before");
    const formula = md.indexOf("x + y");
    const after = md.indexOf("After");
    const move = vi.spyOn(editor.view, "moveVertically")
      .mockReturnValueOnce(EditorSelection.cursor(after))
      .mockReturnValueOnce(EditorSelection.cursor(before));
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(before);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "j" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: formula, to: formula });
    expect(document.querySelector(".cm-math-block")).toBeNull();

    editor.setMarkdownSelection(after);
    expect(vim.handleKey({ key: "k" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: formula, to: formula });
    expect(document.querySelector(".cm-math-block")).toBeNull();

    move.mockRestore();
    rect.mockRestore();
    cleanup();
  });

  test("vim-lite j/k enter org-env headings instead of skipping their replacement widget", () => {
    const md = [
      "Before",
      "#+begin theorem bipartite graph disconnected theorem",
      "Body",
      "#+end theorem",
      "After",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    const content = editor.view.contentDOM;
    const rect = vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240,
      width: 320, height: 240, toJSON: () => ({}),
    } as DOMRect);
    const before = md.indexOf("Before");
    const title = md.indexOf("bipartite graph disconnected theorem");
    const body = md.indexOf("Body");
    const move = vi.spyOn(editor.view, "moveVertically")
      .mockReturnValueOnce(EditorSelection.cursor(body))
      .mockReturnValueOnce(EditorSelection.cursor(before));
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(before);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "j" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: title, to: title });
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeNull();

    editor.setMarkdownSelection(body);
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeTruthy();
    expect(vim.handleKey({ key: "k" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: title, to: title });
    expect(document.querySelector(".cm-org-env-heading-widget")).toBeNull();

    move.mockRestore();
    rect.mockRestore();
    cleanup();
  });

  test("vim-lite j/k enter crossed blank lines symmetrically", () => {
    const md = "Above\n\nBelow";
    const { editor, cleanup } = mountCM6(md);
    const content = editor.view.contentDOM;
    const rect = vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240,
      width: 320, height: 240, toJSON: () => ({}),
    } as DOMRect);
    const above = md.indexOf("Above");
    const blank = md.indexOf("\n") + 1;
    const below = md.indexOf("Below");
    const move = vi.spyOn(editor.view, "moveVertically")
      .mockReturnValueOnce(EditorSelection.cursor(below))
      .mockReturnValueOnce(EditorSelection.cursor(above));
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(above);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "j" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: blank, to: blank });

    editor.setMarkdownSelection(below);
    expect(vim.handleKey({ key: "k" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: blank, to: blank });

    move.mockRestore();
    rect.mockRestore();
    cleanup();
  });

  test("vim-lite normal-mode >> and << use semantic list nesting", () => {
    const { editor, cleanup } = mountCM6("1. parent\n2. child\n3. tail");
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body, {
      onIndent: (direction) => indentMarkdownBlock(editor.view, direction),
    });
    const press = (key: string): void => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    };
    editor.setMarkdownSelection(editor.getMarkdown().indexOf("child"));
    vim.setMode("normal");
    press(">");
    press(">");
    expect(editor.getMarkdown()).toBe("1. parent\n    1. child\n2. tail");
    press("<");
    press("<");
    expect(editor.getMarkdown()).toBe("1. parent\n2. child\n3. tail");
    cleanup();
  });

  test("vim-lite restores core normal and visual commands on CM6", async () => {
    const { editor, cleanup } = mountCM6("abc\ndef\nghi");
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body);
    function press(key: string): void {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    }

    editor.setMarkdownSelection(1);
    vim.setMode("normal");
    press("h");
    expect(editor.getMarkdownSelection().from).toBe(0);
    press("l");
    expect(editor.getMarkdownSelection().from).toBe(1);
    press("x");
    expect(editor.getMarkdown()).toBe("ac\ndef\nghi");
    await nextTick();
    press("p");
    await settlePaste();
    expect(editor.getMarkdown()).toBe("abc\ndef\nghi");

    editor.setMarkdown("one\ntwo\nthree");
    editor.setMarkdownSelection(5);
    vim.setMode("normal");
    press("d");
    press("d");
    expect(editor.getMarkdown()).toBe("one\nthree");

    editor.setMarkdown("abcd");
    editor.setMarkdownSelection(0);
    vim.setMode("normal");
    press("v");
    press("l");
    press("l");
    press("y");
    editor.setMarkdownSelection(editor.getMarkdown().length);
    vim.setMode("normal");
    press("p");
    await settlePaste();
    expect(editor.getMarkdown()).toBe("abcdabc");
    cleanup();
  });

  test("vim-lite s jump uses avy-style timed multi-character input", () => {
    const { editor, cleanup } = mountCM6("zero ab one ab two");
    const vim = createVimLite(editor, document.body, { jumpTimeoutMs: 5 });

    vi.useFakeTimers();
    try {
      editor.setMarkdownSelection(0);
      expect(vim.handleKey({ key: "s" })).toBe(false);
      expect(editor.getMarkdown()).toBe("zero ab one ab two");

      vim.setMode("normal");
      expect(vim.handleKey({ key: "s" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(2);
      vi.advanceTimersByTime(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(2);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(0);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  test("vim-lite s jump refines candidates with additional chars before timeout", () => {
    const { editor, cleanup } = mountCM6("theta beta alphabet beta");
    const vim = createVimLite(editor, document.body, { jumpTimeoutMs: 5 });

    vi.useFakeTimers();
    try {
      editor.setMarkdownSelection(0);
      vim.setMode("normal");
      expect(vim.handleKey({ key: "s" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(vim.handleKey({ key: "l" })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(1);
      vi.advanceTimersByTime(5);
      expect(editor.getMarkdownSelection().from).toBe(11);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(0);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  test("vim-lite s jump matches document text case-insensitively", () => {
    const { editor, cleanup } = mountCM6("A x a");
    const vim = createVimLite(editor, document.body, { jumpTimeoutMs: 5 });

    vi.useFakeTimers();
    try {
      editor.setMarkdownSelection(0);
      vim.setMode("normal");
      expect(vim.handleKey({ key: "s" })).toBe(true);
      expect(vim.handleKey({ key: "A" })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(0);
      vi.advanceTimersByTime(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(2);
      vi.advanceTimersByTime(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(2);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(4);

      editor.setMarkdownSelection(0);
      expect(vim.handleKey({ key: "s" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      vi.advanceTimersByTime(5);
      expect(vim.handleKey({ key: "A" })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  test("vim-lite s jump cancels reliably with Escape in normal mode", () => {
    const { editor, cleanup } = mountCM6("zero ab one ab two");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(0);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "s" })).toBe(true);
    expect(vim.handleKey({ key: "a" })).toBe(true);
    expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(2);
    expect(vim.handleKey({ key: "Escape" })).toBe(true);
    expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
    expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(0);

    expect(vim.handleKey({ key: "j" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(0);
    expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
    cleanup();
  });

  test("vim-lite destroy cancels pending jump work and rejects later keys", () => {
    const { editor, cleanup } = mountCM6("zero ab one ab two");
    const vim = createVimLite(editor, document.body, { jumpTimeoutMs: 5 });

    vi.useFakeTimers();
    try {
      editor.setMarkdownSelection(0);
      vim.setMode("normal");
      expect(vim.handleKey({ key: "s" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(2);

      vim.destroy();
      vi.advanceTimersByTime(10);
      expect(document.querySelectorAll(".cm-vim-jump-preview").length).toBe(0);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      expect(vim.handleKey({ key: "x" })).toBe(false);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  test("vim-lite S jump prioritizes visible matches before the cursor", () => {
    const { editor, cleanup } = mountCM6("a zero a one a two");
    const vim = createVimLite(editor, document.body, { jumpTimeoutMs: 5 });

    vi.useFakeTimers();
    try {
      editor.setMarkdownSelection(13);
      vim.setMode("normal");
      expect(vim.handleKey({ key: "S" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
      vi.advanceTimersByTime(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(3);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(7);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(0);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  test("cm6 read-only mode rejects editing APIs while preserving navigation", () => {
    const { editor, cleanup } = mountCM6("abc", { readOnly: true });
    editor.setMarkdownSelection(1);
    expect(editor.insertText("X")).toEqual({ from: 1, to: 1 });
    expect(editor.replaceMarkdownRange(0, 1, "Z")).toEqual({ from: 1, to: 1 });
    expect(editor.runCommand("bold")).toBe(false);
    expect(editor.pastePlainText("P")).toBe(false);
    expect(editor.getMarkdown()).toBe("abc");
    expect(editor.getMarkdownSelection().from).toBe(1);
    cleanup();
  });

  test("vim-lite heading folds use z commands and remember state per file", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let currentFile = "a.md";
    const mdA = "# A\n\n## B\n\nBody\n\n# C\n\nTail";
    const mdB = "# Other\n\nBody";
    const editor = createEditor(host, {
      kernel: "cm6",
      initialContent: mdA,
      getCurrentFile: () => currentFile,
    });
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body, {
      onFold: (action) => {
        if (action === "close") return editor.runCommand("fold-heading");
        if (action === "open") return editor.runCommand("unfold-heading");
        if (action === "toggle") return editor.runCommand("toggle-fold");
        if (action === "close-all") return editor.runCommand("fold-all-headings");
        return editor.runCommand("unfold-all-headings");
      },
    });
    function press(key: string): void {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    }

    try {
      editor.setMarkdownSelection(0);
      vim.setMode("normal");

      press("z");
      press("M");
      expect(foldedRangeCount(editor.view.state)).toBe(2);

      press("z");
      press("R");
      expect(foldedRangeCount(editor.view.state)).toBe(0);

      press("z");
      press("c");
      expect(foldedRangeCount(editor.view.state)).toBe(1);

      currentFile = "b.md";
      editor.setMarkdown(mdB, { history: "reset" });
      expect(foldedRangeCount(editor.view.state)).toBe(0);

      currentFile = "a.md";
      editor.setMarkdown(mdA, { history: "reset" });
      expect(foldedRangeCount(editor.view.state)).toBe(1);

      press("z");
      press("o");
      expect(foldedRangeCount(editor.view.state)).toBe(0);

      press("z");
      press("a");
      expect(foldedRangeCount(editor.view.state)).toBe(1);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("vim-lite linewise register does not force external single-line paste below", async () => {
    let clipboardText = "external";
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => clipboardText,
        writeText: async (text: string) => { clipboardText = text; },
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = createEditor(host, {
      kernel: "cm6",
      initialContent: "alpha\nbeta",
      readSystemClipboardFallback: async () => ({ kind: "text", text: clipboardText }),
    });
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body);
    function press(key: string): void {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    }

    try {
      editor.setMarkdownSelection(editor.getMarkdown().indexOf("beta"));
      vim.setMode("normal");
      press("d");
      press("d");
      expect(editor.getMarkdown()).toBe("alpha\n");

      clipboardText = "X";
      editor.setMarkdown("alpha beta", { history: "reset" });
      editor.setMarkdownSelection("alpha".length);
      vim.setMode("normal");
      press("p");
      await settlePaste();
      expect(editor.getMarkdown()).toBe("alphaX beta");
    } finally {
      editor.destroy();
      host.remove();
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("vim-lite a, A, and i preserve Vim insertion boundaries", () => {
    const { editor, cleanup } = mountCM6("abc\ndef");
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body);
    function press(key: string): void {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    }

    editor.setMarkdownSelection(3);
    vim.setMode("normal");
    press("a");
    expect(vim.mode()).toBe("insert");
    expect(editor.getMarkdownSelection()).toEqual({ from: 3, to: 3 });

    vim.setMode("normal");
    editor.setMarkdownSelection(3);
    press("i");
    expect(vim.mode()).toBe("insert");
    expect(editor.getMarkdownSelection()).toEqual({ from: 3, to: 3 });

    vim.setMode("normal");
    editor.setMarkdownSelection(1);
    press("A");
    expect(vim.mode()).toBe("insert");
    expect(editor.getMarkdownSelection()).toEqual({ from: 3, to: 3 });
    cleanup();
  });

  test("vim-lite Escape matches Vim cursor placement for i, a, I, and moved insert cursors", () => {
    const { editor, cleanup } = mountCM6("  abc");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(3);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "i" })).toBe(true);
    expect(vim.handleKey({ key: "Escape" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(3);

    expect(vim.handleKey({ key: "a" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(4);
    expect(vim.handleKey({ key: "Escape" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(3);

    expect(vim.handleKey({ key: "I" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(2);
    expect(vim.handleKey({ key: "Escape" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(2);

    editor.setMarkdownSelection(3);
    expect(vim.handleKey({ key: "i" })).toBe(true);
    editor.setMarkdownSelection(5); // native insert-mode cursor movement
    expect(vim.handleKey({ key: "Escape" })).toBe(true);
    expect(editor.getMarkdownSelection().from).toBe(4);
    cleanup();
  });

  test("vim-lite visual mode selects and deletes one full grapheme under the cursor", () => {
    const { editor, cleanup } = mountCM6("A👍🏽B");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(1);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "v" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: 1, to: 5 });
    expect(vim.handleKey({ key: "x" })).toBe(true);
    expect(editor.getMarkdown()).toBe("AB");
    expect(editor.getMarkdownSelection()).toEqual({ from: 1, to: 1 });
    cleanup();
  });

  test("vim-lite visual mode selects blank-line newlines and can swap its active end", () => {
    const { editor, cleanup } = mountCM6("a\n\nb");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(2);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "v" })).toBe(true);
    expect(editor.getMarkdownSelectionRange()).toEqual({ anchor: 2, head: 3 });
    expect(vim.handleKey({ key: "x" })).toBe(true);
    expect(editor.getMarkdown()).toBe("a\nb");

    editor.setMarkdown("abcd", { history: "reset" });
    editor.setMarkdownSelection(1);
    vim.setMode("normal");
    vim.handleKey({ key: "v" });
    vim.handleKey({ key: "l" });
    expect(editor.getMarkdownSelectionRange()).toEqual({ anchor: 1, head: 3 });
    expect(vim.handleKey({ key: "o" })).toBe(true);
    expect(editor.getMarkdownSelectionRange()).toEqual({ anchor: 3, head: 1 });
    cleanup();
  });

  test("vim-lite w/b distinguish Markdown punctuation while W/B use Vim WORDs", () => {
    const { editor, cleanup } = mountCM6("foo.bar baz");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(0);
    vim.setMode("normal");
    vim.handleKey({ key: "w" });
    expect(editor.getMarkdownSelection().from).toBe(3); // punctuation word
    vim.handleKey({ key: "w" });
    expect(editor.getMarkdownSelection().from).toBe(4);
    vim.handleKey({ key: "b" });
    expect(editor.getMarkdownSelection().from).toBe(3);

    editor.setMarkdownSelection(0);
    vim.handleKey({ key: "W" });
    expect(editor.getMarkdownSelection().from).toBe(8);
    vim.handleKey({ key: "B" });
    expect(editor.getMarkdownSelection().from).toBe(0);
    cleanup();
  });

  test("vim-lite visual mode extends backward past the anchor", async () => {
    const { editor, cleanup } = mountCM6("abcdef");
    const target = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    const vim = createVimLite(editor, document.body);
    function press(key: string): void {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      vim.handleKeyDown(event);
    }

    editor.setMarkdownSelection(3);
    vim.setMode("normal");
    press("v");
    press("h");
    press("h"); // head must keep moving left past the anchor, not stick

    const range = editor.getMarkdownSelectionRange();
    expect(range.anchor).toBe(4);
    expect(range.head).toBe(1);
    expect(editor.getMarkdownSelection()).toEqual({ from: 1, to: 4 });

    press("y");
    editor.setMarkdownSelection(editor.getMarkdown().length);
    vim.setMode("normal");
    press("p");
    await settlePaste();
    expect(editor.getMarkdown()).toBe("abcdefbcd");
    cleanup();
  });

  test("vim-lite x and X use character-under-cursor semantics at line boundaries", () => {
    const { editor, cleanup } = mountCM6("abc\ndef");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(3);
    vim.setMode("normal");
    expect(vim.handleKey({ key: "x" })).toBe(true);
    expect(editor.getMarkdown()).toBe("ab\ndef");

    editor.setMarkdown("abc", { history: "reset" });
    editor.setMarkdownSelection(2);
    expect(vim.handleKey({ key: "X" })).toBe(true);
    expect(editor.getMarkdown()).toBe("ac");
    cleanup();
  });

  test("vim-lite adopts mouse and Shift-click CM6 selections into visual mode", () => {
    const { editor, cleanup } = mountCM6("abcdef");
    const vim = createVimLite(editor, document.body);

    editor.setMarkdownSelection(1, 4);
    vim.syncSelectionFromEditor();
    expect(vim.mode()).toBe("visual");
    expect(editor.getMarkdownSelectionRange()).toEqual({ anchor: 1, head: 4 });

    expect(vim.handleKey({ key: "l" })).toBe(true);
    expect(editor.getMarkdownSelection()).toEqual({ from: 1, to: 5 });

    editor.setMarkdownSelection(2);
    vim.syncSelectionFromEditor();
    expect(vim.mode()).toBe("normal");
    expect(editor.getMarkdownSelection()).toEqual({ from: 2, to: 2 });
    cleanup();
  });

  test("vim-lite x deletes exactly the highlighted external selection including its closing delimiter", () => {
    const md = String.raw`Before \(T\). After`;
    const { editor, cleanup } = mountCM6(md);
    const vim = createVimLite(editor, document.body);
    const from = md.indexOf(String.raw`\(`);
    const to = md.indexOf(String.raw`\)`) + 2;

    editor.setMarkdownSelection(from, to);
    vim.syncSelectionFromEditor();
    expect(vim.mode()).toBe("visual");
    expect(vim.handleKey({ key: "x" })).toBe(true);
    expect(editor.getMarkdown()).toBe("Before . After");

    cleanup();
  });

  test("vim-lite s jump reaches visible candidates beyond the one-key label set", () => {
    const { editor, cleanup } = mountCM6("a ".repeat(25));
    const vim = createVimLite(editor, document.body, { jumpTimeoutMs: 5 });

    vi.useFakeTimers();
    try {
      editor.setMarkdownSelection(0);
      vim.setMode("normal");
      expect(vim.handleKey({ key: "s" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      vi.advanceTimersByTime(5);
      expect(document.querySelectorAll(".cm-vim-jump-label").length).toBe(25);

      expect(vim.handleKey({ key: "p" })).toBe(true);
      expect(vim.handleKey({ key: "a" })).toBe(true);
      expect(editor.getMarkdownSelection().from).toBe(34);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// undo / redo
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: undo/redo", () => {
  test("undo reverses insertText", () => {
    const { editor, cleanup } = mountCM6("hello");
    editor.setMarkdownSelection(5, 5);
    editor.insertText(" world");
    expect(editor.getMarkdown()).toBe("hello world");
    editor.undo();
    expect(editor.getMarkdown()).toBe("hello");
    cleanup();
  });

  test("redo re-applies after undo", () => {
    const { editor, cleanup } = mountCM6("hello");
    editor.setMarkdownSelection(5, 5);
    editor.insertText(" world");
    editor.undo();
    editor.redo();
    expect(editor.getMarkdown()).toBe("hello world");
    cleanup();
  });

  test("Mod-Shift-z re-applies after undo", () => {
    const { editor, cleanup } = mountCM6("hello");
    editor.setMarkdownSelection(5, 5);
    editor.insertText(" world");
    editor.undo();

    const event = new KeyboardEvent("keydown", {
      key: "z",
      bubbles: true,
      cancelable: true,
      metaKey: true,
      shiftKey: true,
    });
    editor.view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.getMarkdown()).toBe("hello world");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// onChange callback
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: onChange", () => {
  test("fires with new markdown on insertText", () => {
    const received: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = createEditor(host, {
      kernel: "cm6",
      initialContent: "a",
      onChange: (md) => received.push(md),
    });
    editor.setMarkdownSelection(1, 1);
    editor.insertText("b");
    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1]).toBe("ab");
    editor.destroy();
  });
});

// ---------------------------------------------------------------------------
// isSourceMode / toggleSource / destroy
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: surface", () => {
  test("toggleSource disables and restores CM6 live preview decorations", () => {
    const { editor, cleanup } = mountCM6("**bold**\n\n---\n\nend");
    expect(editor.isSourceMode()).toBe(false);
    editor.setMarkdownSelection(editor.getMarkdown().length);
    expect(document.querySelector(".cm-horizontal-rule")).toBeTruthy();
    expect(document.querySelector(".syntax-hidden")).toBeTruthy();

    editor.toggleSource();
    expect(editor.isSourceMode()).toBe(true);
    expect(document.querySelector(".cm-horizontal-rule")).toBeNull();
    expect(document.querySelector(".syntax-hidden")).toBeNull();

    editor.toggleSource();
    expect(editor.isSourceMode()).toBe(false);
    expect(document.querySelector(".cm-horizontal-rule")).toBeTruthy();
    cleanup();
  });

  test("resetting the document keeps source mode source-only", () => {
    const { editor, cleanup } = mountCM6("**old**");
    editor.toggleSource();
    editor.setMarkdown("**new**", { history: "reset" });

    expect(editor.isSourceMode()).toBe(true);
    expect(document.querySelector(".syntax-hidden")).toBeNull();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("**new**");
    cleanup();
  });

  test("resetting the document recalculates CJK font spans", () => {
    const { editor, cleanup } = mountCM6("plain ascii");
    expect(editor.view.dom.querySelector(".cm-cjk-text")).toBeNull();

    editor.setMarkdown("中文 line", { history: "reset" });

    const cjk = editor.view.dom.querySelector<HTMLElement>(".cm-cjk-text");
    expect(cjk).toBeTruthy();
    expect(cjk!.textContent).toContain("中文");
    cleanup();
  });

  test("destroy removes DOM", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: "x" });
    editor.destroy();
    expect(host.children.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// README coverage-table parity: backslash escape input UX, indented code,
// and CommonMark rule-of-three nested emphasis.
// ---------------------------------------------------------------------------

maybeDescribe("cm6 kernel: README parity", () => {
  test("revealing the cursor preserves a non-empty selection", () => {
    const md = "alpha beta gamma";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(6, 10);

    editor.revealCursor();

    expect(editor.getMarkdownSelection()).toEqual({ from: 6, to: 10 });
    cleanup();
  });

  test("backslash escape is hidden with the cursor outside, dimmed when inside", () => {
    const md = "escaped \\* star";
    const { editor, cleanup } = mountCM6(md);
    const backslash = md.indexOf("\\");

    editor.setMarkdownSelection(md.length);
    let mark = document.querySelector<HTMLElement>(".syntax-hidden");
    expect(mark).toBeTruthy();
    expect(mark!.textContent).toBe("\\");

    editor.setMarkdownSelection(backslash + 1);
    expect(document.querySelector(".syntax-hidden")).toBeNull();
    mark = document.querySelector<HTMLElement>(".syntax-hint");
    expect(mark).toBeTruthy();
    expect(mark!.textContent).toBe("\\");
    cleanup();
  });

  test("TeX delimiters stay visible while a display formula is incomplete or adjacent to prose", () => {
    const formula = "\\[\nx + y\n\\]";
    const { editor, cleanup } = mountCM6(formula);
    editor.setMarkdownSelection(formula.length);
    editor.insertText("after\\");
    const md = `${formula}after\\`;

    expect(editor.getMarkdown()).toBe(md);
    const visibleText = editor.view.contentDOM.textContent ?? "";
    expect(visibleText).toContain("\\[");
    expect(visibleText).toContain("\\]after\\");
    expect(Array.from(editor.view.dom.querySelectorAll<HTMLElement>(".syntax-hidden"))
      .some((mark) => mark.textContent === "\\")).toBe(false);
    cleanup();
  });

  test("formula cut/move/paste never hides adjacent TeX backslashes", () => {
    const formula = "\\[\nx + y\n\\]";
    const { editor, cleanup } = mountCM6(`${formula}\nafter`);

    editor.replaceMarkdownRange(0, formula.length + 1, "", "start");
    editor.replaceMarkdownRange(0, 0, `${formula}after\\`, "end");

    expect(editor.getMarkdown()).toBe(`${formula}after\\after`);
    expect(editor.view.contentDOM.textContent).toContain("\\]after\\after");
    cleanup();
  });

  test("4-space indented code blocks round-trip byte-for-byte and render as code", () => {
    const md = "Paragraph.\n\n    indented code line\n    second line\n\nAfter.";
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(0);

    expect(document.querySelector(".cm-inline-code")).toBeNull();
    expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
      .toContain("indented code line");

    editor.setMarkdownSelection(md.length);
    editor.insertText("");
    expect(editor.getMarkdown()).toBe(md);
    cleanup();
  });

  function visibleText(root: HTMLElement): string {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".syntax-hidden").forEach((el) => el.remove());
    return clone.textContent || "";
  }

  test.each([
    ["***x***", ["cm-em", "cm-strong"]],
    ["**a *b***", ["cm-strong", "cm-em"]],
    ["*a **b***", ["cm-em", "cm-strong"]],
    ["**a*b***", ["cm-strong", "cm-em"]],
  ])("nests emphasis correctly for %s (CommonMark rule-of-three)", (md, expectedClasses) => {
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    for (const cls of expectedClasses) {
      expect(document.querySelector(`.${cls}`)).toBeTruthy();
    }
    expect(document.querySelectorAll(".syntax-hidden").length).toBeGreaterThan(0);
    const contentDOM = (editor.view as unknown as { contentDOM: HTMLElement }).contentDOM;
    expect(visibleText(contentDOM)).not.toContain("*");
    cleanup();
  });

  test.each([
    "_[[_]",
    "[[*]*",
    "ordinary [unfinished _label] text",
  ])("does not let incomplete bracket text change emphasis resolution for %s", (md) => {
    const { editor, cleanup } = mountCM6(md);
    editor.setMarkdownSelection(md.length);

    expect(document.querySelector(".cm-em")).toBeNull();
    expect(document.querySelector(".cm-strong")).toBeNull();
    cleanup();
  });
});
