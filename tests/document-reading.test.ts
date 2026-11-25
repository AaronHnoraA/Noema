import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const log = "#+begin log Build\n- 09:17:12 WARN Slow **render**\n- Plain message with no level\n- [INFO] Ready\n#+end log";
const status = '#+begin statusbar Review {mode="READ" keys="C-f:Search, C-x C-s:Save" note="Awaiting review"}\n#+end statusbar';

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  return root;
}

test("logs separate actual severity and time while retaining ordinary messages", () => {
  const root = render(log);
  const rows = Array.from(root.querySelectorAll(".noema-document-log > li"));
  expect(rows).toHaveLength(3);
  expect(rows[0]?.querySelector("time")?.textContent).toBe("09:17:12");
  expect(rows[0]?.querySelector("[data-log-level=warning]")?.textContent).toBe("WARN");
  expect(rows[0]?.querySelector("strong")?.textContent).toBe("render");
  expect(rows[1]?.textContent).toBe("Plain message with no level");
  expect(rows[2]?.querySelector("[data-log-level=info]")?.textContent).toBe("INFO");
});

test("list items with several paragraphs use the normal Markdown fallback", () => {
  const root = render("#+begin log Build\n- First description\n\n  Second paragraph\n-\n#+end log");
  expect(root.querySelector(".noema-document-log")).toBeNull();
  expect(root.querySelector("ul li p + p")?.textContent).toBe("Second paragraph");
  expect(render("#+begin log Build\n4. INFO Ready\n#+end log").querySelector("ol")?.getAttribute("start")).toBe("4");
});

test("status and shortcut views keep chord order and inline labels", () => {
  const root = render(`${status}\n\n#+begin keymap Commands\n- C-x C-f / ⌘O : **Open** a file\n- M-: : Evaluate\n#+end keymap`);
  const panel = root.querySelector(".noema-document-statusbar");
  expect(panel?.querySelector(".noema-statusbar-mode")?.textContent).toBe("READ");
  expect(panel?.querySelector(".noema-statusbar-note")?.textContent).toBe("Awaiting review");
  expect([...panel!.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(["C-f", "C-x", "C-s"]);
  const mapping = root.querySelector(".noema-document-keymap");
  expect([...mapping!.querySelectorAll("kbd")].map((node) => node.textContent)).toEqual(["C-x", "C-f", "⌘O", "M-:"]);
  expect(mapping?.querySelector("dd strong")?.textContent).toBe("Open");
});

test("shortcut punctuation keeps the key and label associated", () => {
  const root = render('#+begin statusbar {mode=READ keys="C-,:Previous, C-.:Next"}\nOrdinary status description.\n#+end statusbar'
    + "\n\n#+begin keymap\n- `:`: Enter command mode\n- C-x: Use : here\n#+end keymap");
  expect(root.querySelector(".noema-statusbar-mode")?.textContent).toBe("READ");
  expect([...root.querySelectorAll(".noema-document-statusbar kbd")].map((node) => node.textContent)).toEqual(["C-,", "C-."]);
  expect(root.querySelector(".noema-document-statusbar")?.textContent).toContain("Previous");
  expect(root.querySelector(".org-env-content > p")?.textContent).toBe("Ordinary status description.");
  expect([...root.querySelectorAll(".noema-document-keymap kbd")].map((node) => node.textContent)).toEqual([":", "C-x"]);
  expect([...root.querySelectorAll(".noema-document-keymap dd")].map((node) => node.textContent)).toEqual(["Enter command mode", "Use : here"]);
});

test("breadcrumbs keep their links and identify the final entry", () => {
  const root = render('#+begin breadcrumb Path {separator="/"}\n- [Home](index.md)\n- **Guide**\n- Current\n#+end breadcrumb');
  expect(root.querySelector("nav.noema-document-breadcrumb")?.getAttribute("aria-label")).toBe("Breadcrumb");
  expect(root.querySelector("nav a")?.getAttribute("href")).toBe("index.md");
  expect(root.querySelector("li[aria-current=page]")?.textContent).toContain("Current");
  expect(root.querySelector(".noema-breadcrumb-separator")?.textContent).toBe("/");
});

test("pros and cons use authored labels and retain nested Markdown", () => {
  const root = render('#+begin pros-cons Choice {pros="Advantages" cons="Limits"}\n- Easier **review**\n\n#+col\n\n> Longer build\n#+end pros-cons');
  expect(root.querySelector("[data-comparison=pros] .noema-comparison-heading")?.textContent).toBe("Advantages");
  expect(root.querySelector("[data-comparison=pros] strong")?.textContent).toBe("review");
  expect(root.querySelector("[data-comparison=cons] blockquote")?.textContent).toContain("Longer build");
});

test("comparison panes share references and keep indented markers as code", () => {
  const root = render("#+begin pros-cons Choice\n- [Read][same]\n\n#+col\n\n- Follow up\n\n[same]: https://example.com\n#+end pros-cons");
  expect(root.querySelector("[data-comparison=pros] a")?.getAttribute("href")).toBe("https://example.com");
  const ordinary = render("#+begin pros-cons Choice\nFirst.\n\n    #+col\n\nLast.\n#+end pros-cons");
  expect(ordinary.querySelector(".noema-document-comparison")).toBeNull();
  expect(ordinary.querySelector("pre > code")?.textContent).toContain("#+col");
});

test("metadata-only status bars and log source belong to the normal editor", () => {
  const source = `${log}\n\n${status}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelector(".noema-document-statusbar")).not.toBeNull();
    expect(host.querySelector(".noema-document-log")).not.toBeNull();
    editor.setMarkdownSelection(source.indexOf("Slow"));
    expect(host.querySelector(".noema-document-log")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
