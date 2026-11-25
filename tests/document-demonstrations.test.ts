import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { setSystemClipboardWriter } from "../src/system-clipboard.ts";

const content = "**Preview**\n\n- One\n- Two\n\n~~~text\nLiteral {width=30%}\n~~~";
const sample = `#+begin demo 布局演示\n${content}\n#+end demo`;

test("published demo displays normal Markdown and a window can omit padding", () => {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdownHTML(`${sample}\n\n#+begin window 阅读 {height=18rem no-padding=true}\nA [link](guide.md).\n#+end window`);
  expect(host.querySelector(".noema-document-demo strong")?.textContent).toBe("Preview");
  expect(host.querySelector(".noema-document-demo [data-demo-copy]")).toBeNull();
  const panel = host.querySelector<HTMLElement>(".noema-document-window")!;
  expect(panel.style.getPropertyValue("--document-window-height")).toBe("18rem");
  expect(panel.dataset.windowPadding).toBe("false");
  expect(panel.querySelector("a")?.getAttribute("href")).toBe("guide.md");
});

test("demo retains the preview while exposing and copying the authored Markdown", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `${sample}\n\nOther prose.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  let copied = "";
  setSystemClipboardWriter(async (text) => { copied = text; return true; });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const demo = () => host.querySelector(".noema-document-demo")!;
    expect(demo().querySelector(".noema-demo-code")).toBeNull();
    demo().querySelector<HTMLElement>("[data-demo-toggle]")!.click();
    expect(demo().querySelector(".noema-demo-code")?.textContent).toBe(content + "\n");
    expect(demo().querySelector(".noema-demo-preview strong")?.textContent).toBe("Preview");
    demo().querySelector<HTMLButtonElement>("[data-demo-copy]")!.click();
    expect(copied).toBe(content + "\n");
    editor.view.dispatch({changes: { from: 0, insert: "Start.\n\n" }});
    await Promise.resolve();
    expect(demo().querySelector(".noema-demo-code")?.textContent).toBe(content + "\n");
    expect(editor.getMarkdown()).toBe("Start.\n\n" + source);
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});

test("nested demo copies authored markup and publication retains only approved output", async () => {
  const content = "See [Example](target.md).\n\n#+begin ediff\n-Original\n+Revised\n#+end ediff\n";
  const nested = `#+begin demo Sample {open=true}\n${content}#+end demo`;
  const source = `#+begin tabs Guide\n### Demo\n${nested}\n\n### Next\nOther section.\n#+end tabs\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  let copied = "";
  setSystemClipboardWriter(async (text) => { copied = text; return true; });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    expect(host.querySelector(".noema-demo-code")?.textContent).toBe(content);
    host.querySelector<HTMLButtonElement>("[data-demo-copy]")!.click();
    expect(copied).toBe(content);
    const html = renderMarkdownHTML(source);
    expect(html).toContain("Original");
    expect(html).not.toContain("Revised");
    expect(html).not.toContain("data-document-source-body");
  } finally {
    setSystemClipboardWriter(null);
    editor.destroy();
    host.remove();
  }
});

test("demo in a Markdown container copies the authored annotations", async () => {
  for (const wrapper of ["quote", "list"]) {
    const content = "Note {==authored==}{>>#c-abcd<<}.\n";
    const inner = `#+begin demo Sample {open=true}\n${content}#+end demo`;
    const container = wrapper === "quote" ? inner.split("\n").map((line) => `> ${line}`).join("\n")
      : `- ${inner.replace(/\n/g, "\n  ")}`;
    const source = `#+begin window Frame\n${container}\n#+end window\n\nAfter.`;
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    let copied = "";
    setSystemClipboardWriter(async (text) => { copied = text; return true; });
    try {
      editor.setMarkdownSelection(source.length);
      await Promise.resolve();
      expect(host.querySelector(".noema-demo-code")?.textContent).toBe(content);
      host.querySelector<HTMLButtonElement>("[data-demo-copy]")!.click();
      expect(copied).toBe(content);
    } finally {
      setSystemClipboardWriter(null);
      editor.destroy();
      host.remove();
    }
  }
});
