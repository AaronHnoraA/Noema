import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";

const oldText = "start\nconst count = 2;\nremove this\nend\n";
const newText = "start\nconst count = 3;\nend\n";
const markdown = `#+begin diff Review {before=Current after=Updated}\n~~~text\n${oldText}~~~\n\n~~~text\n${newText}~~~\n#+end diff`;

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  return root;
}

test("a read-only diff pairs changes and retains both line number sequences", () => {
  const root = render(markdown);
  const diff = root.querySelector(".noema-document-diff");
  const rows = [...diff!.querySelectorAll(".noema-diff-row")];
  expect(rows).toHaveLength(4);
  expect(rows[0]?.querySelectorAll("[data-diff-state='same']")).toHaveLength(2);
  expect(rows[1]?.querySelector("del")?.textContent).toBe("2");
  expect(rows[1]?.querySelector("ins")?.textContent).toBe("3");
  expect(rows[2]?.querySelector("[data-diff-state=removed] code")?.textContent).toBe("remove this");
  expect([...rows[3]!.querySelectorAll(".noema-diff-number")].map((item) => item.textContent)).toEqual(["4", "3"]);
  expect(diff?.querySelector("button, template")).toBeNull();
  expect(diff?.textContent).toContain("Current");
  expect(diff?.textContent).toContain("Updated");
});

test("protected diff fences keep literal annotation and layout syntax", () => {
  const literal = "{==literal==}{>>#c-abcd<<}\n|x|y|\n{width=50%}\n";
  const root = render(markdown.replace(oldText, literal));
  const before = [...root.querySelectorAll("[data-diff-side=before] code")].map((code) => code.textContent).join("\n");
  expect(before).toContain(literal.trimEnd());
  const fallback = render("#+begin diff\nBody **kept**.\n#+end diff");
  expect(fallback.querySelector("strong")?.textContent).toBe("kept");
});

test("oversize alignments keep every line literal even for diagram or raw fence labels", () => {
  const before = "graph LR; A --> B;\n" + Array.from({ length: 501 }, (_, index) => `%% before ${index}`).join("\n") + "\n";
  const after = "<span>literal HTML</span>\n" + Array.from({ length: 501 }, (_, index) => `line ${index}`).join("\n") + "\n";
  const root = render(`#+begin diff\n~~~mermaid\n${before}~~~\n\n~~~{=html}\n${after}~~~\n#+end diff`);
  expect([...root.querySelectorAll(".noema-diff-fallback pre code")].map((el) => el.textContent)).toEqual([before, after]);
  expect(root.querySelector(".noema-diagram-code, .noema-diagram-rendered, .language-mermaid")).toBeNull();
});

test("the editor switches layout and copies exact text without changing source", async () => {
  const source = `${markdown}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  let copied = "";
  setSystemClipboardWriter(async (text) => { copied = text; return true; });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const group = () => host.querySelector<HTMLElement>(".noema-document-diff")!;
    group().querySelector<HTMLButtonElement>("button[data-diff-mode=unified]")!.click();
    expect(group().dataset.diffMode).toBe("unified");
    group().querySelector<HTMLButtonElement>("button[data-diff-copy=before]")!.click();
    expect(copied).toBe(oldText);
    editor.view.dispatch({ changes: { from: 0, insert: "Before.\n\n" } });
    await Promise.resolve();
    expect(group().dataset.diffMode).toBe("unified");
    expect(editor.getMarkdown()).toBe(`Before.\n\n${source}`);
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});

test("nested diff lines use their real source positions in tabs and columns", async () => {
  const examples = [
    `#+begin tabs Read\n### Overview\nPage introduction.\n\n${markdown}\n\n### Notes\nOther notes.\n#+end tabs`,
    `#+begin columns\nColumn intro.\n\n#+col\n\n${markdown}\n#+end columns`,
  ];
  for (const example of examples) {
    const source = `${example}\n\nAfter.`;
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      await Promise.resolve();
      editor.view.dispatch({ changes: { from: 0, insert: "Prefix.\n\n" } });
      await Promise.resolve();
      const cell = [...host.querySelectorAll("[data-diff-side=after] code")].find((line) => line.textContent === "const count = 3;");
      expect(cell).toBeDefined();
      cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(editor.view.state.selection.main.anchor).toBe(editor.getMarkdown().indexOf("const count = 3;"));
      expect(editor.getMarkdown()).toBe(`Prefix.\n\n${source}`);
    } finally {
      editor.destroy();
      host.remove();
    }
  }
});
