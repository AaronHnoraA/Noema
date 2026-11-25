import { expect, test } from "@voidzero-dev/vite-plus-test";
import { renderMarkdownHTML, renderPublishedNoteHTML } from "../src/render-html.ts";
import { createEditor } from "../src/editor-api.ts";

function read(source: string, pdf = false): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = pdf ? renderPublishedNoteHTML(source, { title: "Callouts", format: "pdf" }) : renderMarkdownHTML(source);
  return root;
}

test("standard callouts get a default title and retain all nested Markdown", () => {
  const root = read("> [!CAUTION]\n> Keep **both** files.\n>\n> - [Guide](guide.md)");
  const callout = root.querySelector("[data-callout='caution']")!;
  expect(callout.querySelector(".callout-title")?.textContent).toBe("Caution");
  expect(callout.querySelector("strong")?.textContent).toBe("both");
  expect(callout.querySelector("a")?.getAttribute("href")).toBe("guide.md");
  expect(read("> Ordinary quote.\n>\n> [!NOTE]\n> Ordinary text.").querySelector(".callout")).toBeNull();
});

test("Markdown callout modifiers set default disclosure and PDF expands it", () => {
  const source = "> [!TIP]- **配置**\n> Open the editor.\n\n> [!WARNING]+\n> Close the editor.";
  const root = read(source);
  const result = [...root.querySelectorAll<HTMLDetailsElement>("details.callout")];
  expect(result.map((item) => item.open)).toEqual([false, true]);
  expect(result[0]?.querySelector("summary strong")?.textContent).toBe("配置");
  expect(result[1]?.querySelector("summary")?.textContent).toBe("Warning");
  expect(read(source, true).querySelectorAll("details.callout[open]")).toHaveLength(2);
});

test("a collapsible native callout keeps its Noema heading and wraps only its body", () => {
  const source = "#+begin warning 兼容性 {collapsible=true open=false}\nKeep Emacs **30**.\n#+end warning";
  const block = read(source).querySelector("org-env-block[data-kind=warning]")!;
  expect(block.getAttribute("data-title")).toBe("兼容性");
  const body = block.querySelector<HTMLDetailsElement>(".org-env-content > details")!;
  expect(body.open).toBe(false);
  expect(body.querySelector("strong")?.textContent).toBe("30");
  expect(read(source, true).querySelector("org-env-block details[open]")).not.toBeNull();
});

test("editor toggles quoted and native callouts and preserves authored Markdown on source reveal", async () => {
  const markdown = "> [!TIP]- Setup\n> [Guide](guide.md)\n\n"
    + "#+begin warning Versions {collapsible=true open=false}\nBold **content**.\n#+end warning\n\nAfter.";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  try {
    editor.setMarkdownSelection(markdown.length);
    await Promise.resolve();
    const quoted = () => host.querySelector<HTMLDetailsElement>(".noema-callout-widget details");
    const native = () => host.querySelector<HTMLDetailsElement>(".noema-native-callout-body");
    const nativeToggle = () => host.querySelector<HTMLButtonElement>(".cm-org-env-disclosure-toggle");
    expect(quoted()?.open).toBe(false);
    expect(native()?.open).toBe(false);
    expect(nativeToggle()?.getAttribute("aria-expanded")).toBe("false");
    quoted()?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
    nativeToggle()?.click();
    expect(quoted()?.open).toBe(true);
    expect(native()?.querySelector("strong")?.textContent).toBe("content");
    expect(nativeToggle()?.getAttribute("aria-expanded")).toBe("true");
    editor.setMarkdownSelection(markdown.indexOf("content"));
    expect(native()).toBeNull();
    editor.setMarkdownSelection(markdown.length);
    await Promise.resolve();
    expect(native()?.open).toBe(true);
    host.querySelector<HTMLButtonElement>(".noema-callout-widget button")?.click();
    expect(quoted()).toBeNull();
    editor.setMarkdownSelection(markdown.length);
    await Promise.resolve();
    expect(quoted()?.open).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("a folded quote inside an already rendered window has one interactive body", async () => {
  const source = "#+begin window Frame\n> [!TIP]- Embedded\n> Body.\n#+end window\n\nAfter.";
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const callout = host.querySelector<HTMLDetailsElement>(".noema-window-body details.callout")!;
    expect(host.querySelectorAll("details.callout")).toHaveLength(1);
    expect(callout.open).toBe(false);
    expect(callout.querySelector(".noema-disclosure-body")?.textContent).toBe("");
    callout.querySelector("summary")!.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
    expect(callout.open).toBe(true);
    expect(callout.querySelector(".noema-disclosure-body")?.textContent).toContain("Body.");
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("a list callout remains interactive and a folded quote remembers its state inside tabs", async () => {
  const source = [
    "- > [!TIP]- List item", "  > List body.", "",
    "#+begin tabs", "### First", "> [!TIP]- Tab item", "> Tab body.", "",
    "### Second", "Other page.", "#+end tabs", "", "After.",
  ].join("\n");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  const activate = (element: Element | null) => element?.dispatchEvent(new MouseEvent("click", {bubbles:true, cancelable:true}));
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const list = host.querySelector<HTMLDetailsElement>(".noema-callout-widget li details.callout")!;
    expect(list.open).toBe(false);
    activate(list.querySelector("summary"));
    expect(list.open).toBe(true);
    const tab = () => host.querySelector<HTMLDetailsElement>(".noema-tab-pane details.callout");
    activate(tab()?.querySelector("summary") ?? null);
    expect(tab()?.open).toBe(true);
    host.querySelector<HTMLButtonElement>(".noema-tab-button[title=Second]")!.click();
    expect(tab()).toBeNull();
    host.querySelector<HTMLButtonElement>(".noema-tab-button[title=First]")!.click();
    expect(tab()?.open).toBe(true);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
