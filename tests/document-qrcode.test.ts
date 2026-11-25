import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { cleanEditorHTML } from "../src/export-html.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const payload = "阅读手册 https://example.com/notes?a=1&b=2";
const source = `#+begin qrcode 手册 {text="${payload}"}\n扫描后打开阅读手册。\n#+end qrcode`;

function render(markdown: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(markdown);
  return root;
}

test("a QR code keeps its actual value, caption, and SVG in published HTML", () => {
  const root = render(source);
  const figure = root.querySelector("figure.noema-document-qr");
  expect(figure?.querySelector(".noema-qr-value")?.textContent).toBe(payload);
  expect(figure?.querySelector("p")?.textContent).toBe("扫描后打开阅读手册。");
  expect(figure?.querySelector("a, img, iframe")).toBeNull();
  const svg = figure?.querySelector("svg");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.querySelector("rect")?.getAttribute("fill")).toBe("white");
  expect(svg?.querySelector("path")?.getAttribute("d")).toMatch(/^M4,4/);
  const published = document.createElement("div");
  published.innerHTML = cleanEditorHTML(root);
  expect(published.querySelector("svg path")?.getAttribute("d")).toBe(svg?.querySelector("path")?.getAttribute("d"));
  expect(published.querySelector(".noema-qr-value")?.textContent).toBe(payload);
});

test("a fenced payload keeps its literal punctuation and internal line breaks", () => {
  const text = "[阅读手册] <tag>\n  第二行  ";
  const root = render(`#+begin qrcode\n~~~text\n${text}\n~~~\n#+end qrcode`);
  expect(root.querySelector(".noema-qr-value")?.textContent).toBe(text);
  expect(root.querySelector("tag")).toBeNull();
  expect(root.querySelector("figure svg path")).not.toBeNull();
});

test("literal QR data bypasses comment and layout preprocessing", () => {
  const payload = "{==literal==}{>>#c-abcd<<}\n|first|second|\n{width=50%}";
  const source = `Before {==keep==}{>>#c-abcd<<}.\n\n#+begin qrcode\n~~~text\n${payload}\n~~~\n#+end qrcode`;
  for (const newline of ["\n", "\r\n", "\r"]) {
    const root = render(source.replaceAll("\n", newline));
    expect(root.querySelector("p")?.textContent).toBe("Before keep.");
    expect(root.querySelector(".noema-qr-value")?.textContent).toBe(payload);
  }
});

test("QR fences honor Markdown container prefixes and actual fence indentation", () => {
  const payload = "Alpha\n    ~~~\n{==keep==}{>>#c-abcd<<}\nOmega";
  const source = `#+begin qrcode\n~~~text\n${payload}\n~~~\n#+end qrcode`;
  expect(render(source).querySelector(".noema-qr-value")?.textContent).toBe(payload);
  const quote = source.split("\n").map((line) => `> ${line}`).join("\n");
  expect(render(quote).querySelector("blockquote .noema-qr-value")?.textContent).toBe(payload);
  const nested = `#+begin box\n${source}\n#+end box`.split("\n").map((line) => `> ${line}`).join("\n");
  expect(render(nested).querySelector("blockquote .noema-document-frame .noema-qr-value")?.textContent).toBe(payload);
  expect(render(quote.replace("> Alpha", "Alpha")).querySelector(".noema-qr-value")).toBeNull();
});

test("a value beyond QR capacity remains readable and an ordinary body stays Markdown", () => {
  const text = "x".repeat(7090);
  const root = render(`#+begin qrcode\n\`\`\`text\n${text}\n\`\`\`\n#+end qrcode`);
  expect(root.querySelector(".noema-qr-value")?.textContent).toBe(text);
  expect(root.querySelector(".noema-qr-message")?.textContent).toMatch(/too long/i);
  expect(root.querySelector("figure svg")).toBeNull();
  const fallback = render("#+begin qrcode\nAn **ordinary** caption.\n#+end qrcode");
  expect(fallback.querySelector("strong")?.textContent).toBe("ordinary");
});

test("the editor uses the original org environment and reveals the QR source", () => {
  const markdown = `#+begin qrcode Scan {text="${payload}"}\n#+end qrcode\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  try {
    editor.setMarkdownSelection(markdown.length);
    expect(host.querySelector(".cm-org-env-line[data-org-env-kind=qrcode] figure svg")).not.toBeNull();
    editor.setMarkdownSelection(markdown.indexOf("text="));
    expect(host.querySelector(".noema-document-qr")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  } finally {
    editor.destroy();
    host.remove();
  }
});
