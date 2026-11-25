import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML, renderPublishedNoteHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";

const files = [
  '#+begin file-tree Paths {collapsible=true clickable=true open-depth=1 lines=false icon=colored}',
  '- src', '  - render.ts # Rendering entry', '  - [Guide](guide.md)',
  '- docs', '  - 中文笔记.md', '#+end file-tree',
].join("\n");

const code = [
  '#+begin code-tree Examples {height=6}',
  '### src/render.ts', '~~~typescript', 'const value = 7;', '~~~', '',
  '### tools/format.py', '~~~python', 'print("ready")', '~~~', '#+end code-tree',
].join("\n");

function render(source: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdownHTML(source);
  return host;
}

test("file trees keep structure, explicit links, relative names, and descriptions", () => {
  const root = render(files);
  const tree = root.querySelector(".noema-document-tree");
  expect(tree?.getAttribute("data-tree-lines")).toBe("false");
  expect(tree?.querySelectorAll("details[open]")).toHaveLength(2);
  expect(tree?.querySelector("[href='./src/render.ts']")?.textContent).toBe("render.ts");
  expect(tree?.querySelector("[href='guide.md']")?.textContent).toBe("Guide");
  expect(tree?.querySelector(".noema-tree-description")?.textContent).toBe("Rendering entry");
  expect(tree?.querySelector("[href='./docs/%E4%B8%AD%E6%96%87%E7%AC%94%E8%AE%B0.md']")).not.toBeNull();
  const passive = render(files.replace("clickable=true", "clickable=false"));
  expect([...passive.querySelectorAll(".noema-document-tree a")].map((link) => link.getAttribute("href"))).toEqual(["guide.md"]);
  expect(render("#+begin file-tree\nOrdinary **Markdown**.\n#+end file-tree").querySelector("strong")).not.toBeNull();
});

test("file tree preserves URL and email links and accepts explicitly relative names", () => {
  const source = ["#+begin file-tree {clickable=true}", "- www.example.com", "- alice@example.com", "- ./relative.md", "- ../parent.md", "#+end file-tree"].join("\n");
  const hrefs = [...render(source).querySelectorAll(".noema-document-tree a[href]")].map((link) => link.getAttribute("href"));
  expect(hrefs).toEqual(["http://www.example.com", "mailto:alice@example.com", "./relative.md"]);
});

test("file tree supports added and removed paths, emphasis with descriptions, and empty folders", () => {
  const source = ["#+begin file-tree {clickable=true}", "- ++ **new.md** # First read", "- -- old.ts", "- empty/", "#+end file-tree"].join("\n");
  const tree = render(source).querySelector(".noema-document-tree")!;
  expect(tree.querySelector("[data-tree-change='added'] strong a, [data-tree-change='added'] a strong")?.textContent).toBe("new.md");
  expect(tree.querySelector("[data-tree-change='added'] a")?.getAttribute("href")).toBe("./new.md");
  expect(tree.querySelector("[data-tree-change='removed'] a")?.getAttribute("href")).toBe("./old.ts");
  expect(tree.querySelector(".noema-tree-description")?.textContent).toBe("First read");
  expect(tree.querySelector("[data-tree-type='directory']")?.textContent).toBe("empty/");
  expect(tree.querySelector("[href='./empty']")).toBeNull();
});

test("PDF output includes children of every directory while published HTML keeps opening depths", () => {
  const source = files.replace("open-depth=1", "open-depth=0");
  expect(render(source).querySelectorAll(".noema-document-tree details[open]")).toHaveLength(0);
  const host = document.createElement("div");
  host.innerHTML = renderPublishedNoteHTML(source, { title: "Paths", format: "pdf" });
  expect(host.querySelectorAll(".noema-document-tree details[open]")).toHaveLength(2);
});

test("collapsed folders keep their state and file links open in the host", async () => {
  const source = `${files}\n\nEnd.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  const opened: string[] = [];
  host.addEventListener("noema:open-url", (event) => {
    event.preventDefault();
    opened.push((event as CustomEvent<{ href: string }>).detail.href);
  });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    host.querySelector<HTMLAnchorElement>("[href='guide.md']")?.click();
    expect(opened).toEqual(["guide.md"]);
    host.querySelector(".noema-document-tree summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(host.querySelector<HTMLDetailsElement>(".noema-document-tree details")?.open).toBe(false);
    editor.view.dispatch({ changes: { from: 0, insert: "Before.\n\n" } });
    await Promise.resolve();
    expect(host.querySelector<HTMLDetailsElement>(".noema-document-tree details")?.open).toBe(false);
    expect(editor.getMarkdown()).toBe(`Before.\n\n${source}`);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("code tree selection copies the selected snippet and static output keeps all files", async () => {
  const published = render(code);
  expect([...published.querySelectorAll("pre code")].map((item) => item.textContent)).toEqual(["const value = 7;\n", 'print("ready")\n']);
  const source = `${code}\n\nEnd.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  let copied = "";
  setSystemClipboardWriter(async (text) => { copied = text; return true; });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const group = () => host.querySelector(".noema-document-code-tree")!;
    const preview = () => group().querySelector(".noema-code-tree-preview code")?.textContent;
    expect(preview()).toBe("const value = 7;\n");
    group().querySelector<HTMLButtonElement>("button[data-tree-file='1']")?.click();
    expect(preview()).toBe('print("ready")\n');
    group().querySelector<HTMLButtonElement>("button[data-tree-copy]")?.click();
    expect(copied).toBe('print("ready")\n');
    editor.view.dispatch({ changes: { from: 0, insert: "Before.\n\n" } });
    await Promise.resolve();
    expect(preview()).toBe('print("ready")\n');
    expect(editor.getMarkdown()).toBe(`Before.\n\n${source}`);
    const newFile = "### new/main.js\n~~~javascript\nrun();\n~~~\n\n";
    editor.view.dispatch({ changes: { from: editor.getMarkdown().indexOf("### src"), insert: newFile } });
    await Promise.resolve();
    expect(preview()).toBe('print("ready")\n');
    expect(group().querySelector("[aria-pressed='true']")?.textContent).toBe("format.py");
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});
