import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { parseAttrArgs } from "../shared/layout-attrs.mjs";

const card = [
  '#+begin card 文档 {description="打开 **手册**" href="https://example.com" accent=info width=28rem}',
  "附带一个 [次要链接](https://example.org)。",
  "#+end card",
].join("\n");

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  return root;
}

test("card keeps the existing environment heading and separates its primary action from body links", () => {
  const root = render(card);
  const widget = root.querySelector<HTMLElement>(".noema-document-frame[data-frame=card]");
  expect(root.querySelector("org-env-block")?.getAttribute("data-title")).toBe("文档");
  expect(widget?.dataset.accent).toBe("info");
  expect(widget?.style.getPropertyValue("--document-frame-width")).toBe("28rem");
  expect(widget?.querySelector(".noema-document-card-description strong")?.textContent).toBe("手册");
  expect(widget?.querySelector(".noema-document-card-action")?.getAttribute("href")).toBe("https://example.com");
  expect(widget?.querySelector(".noema-document-frame-body a")?.getAttribute("href")).toBe("https://example.org");
  expect(render(card.replace("https://example.com", "javascript:alert(1)")).querySelector(".noema-document-card-action")).toBeNull();
});

test("boxes and panels use their authored layout and meaningful status", () => {
  const root = render([
    '#+begin box 背景 {surface=quiet padding=2ch text-align=center}', "Body.", "#+end box", "",
    '#+begin panel 构建 {variant=flat focus=true accent=warning status="正在检查"}', "#+end panel",
  ].join("\n"));
  const box = root.querySelector<HTMLElement>(".noema-document-frame[data-frame=box]");
  const panel = root.querySelector<HTMLElement>(".noema-document-frame[data-frame=panel]");
  expect(box?.dataset.surface).toBe("quiet");
  expect(box?.style.getPropertyValue("--document-frame-padding")).toBe("2ch");
  expect(box?.dataset.textAlign).toBe("center");
  expect(panel?.dataset.variant).toBe("flat");
  expect(panel?.dataset.focus).toBe("true");
  expect(panel?.querySelector(".noema-document-panel-status")?.textContent).toBe("正在检查");
});

test("alignment environments keep the authored Markdown hierarchy", () => {
  for (const align of ["center", "left", "right", "justify"]) {
    const root = render(`#+begin ${align}\nA **paragraph**.\n\n- One\n- Two\n#+end ${align}`);
    const body = root.querySelector(`.noema-document-alignment[data-text-align=${align}]`);
    expect(body?.querySelector("p strong")?.textContent).toBe("paragraph");
    expect(body?.querySelectorAll("li")).toHaveLength(2);
  }
});

test("quoted attributes preserve interleaved punctuation and application link destinations", () => {
  expect(parseAttrArgs('width=40%, align=center; description="Read, compare; then \\"apply\\""')).toEqual({
    width: "40%", align: "center", description: 'Read, compare; then "apply"',
  });
  const root = render('#+begin card Guide {description="First, second; third" href="marginnote4app://notes/a,b" action="Open, please"}\n#+end card');
  expect(root.querySelector(".noema-document-card-description")?.textContent).toBe("First, second; third");
  const link = root.querySelector(".noema-document-card-action");
  expect(link?.textContent).toBe("Open, please");
  expect(link?.getAttribute("href")).toBe("marginnote4app://notes/a,b");
});

test("primary card links use the host opener in a column without editing source", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `#+begin columns\n${card}\n#+col\nNotes.\n#+end columns\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  const opened: string[] = [];
  host.addEventListener("noema:open-url", (event) => {
    event.preventDefault();
    opened.push((event as CustomEvent<{ href: string }>).detail.href);
  });
  try {
    editor.setMarkdownSelection(source.length);
    const action = host.querySelector<HTMLAnchorElement>(".noema-document-card-action");
    action?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(action?.isConnected).toBe(true);
    action?.click();
    expect(opened).toEqual(["https://example.com"]);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("the editor uses normal source reveal and shows meaningful frames with an empty body", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `${card}\n\n#+begin panel 任务 {status="运行中"}\n#+end panel\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelector(".noema-document-frame[data-frame=card]")).not.toBeNull();
    expect(host.querySelector(".noema-document-panel-status")?.textContent).toBe("运行中");
    editor.setMarkdownSelection(source.indexOf("附带"));
    expect(host.querySelector(".noema-document-frame[data-frame=card]")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
