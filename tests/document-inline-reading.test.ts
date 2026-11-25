import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML, renderPublishedNoteHTML } from "../src/render-html.ts";

const sample = 'Read @@spoiler [the **answer**]{label="Answer"}, @@gloss [API]{text="Application interface"} and '
  + '@@annotation [Context]{text="[Appendix](guide.md)"}. Try @@kbd [Ctrl+K], @@badge [Ready]{tone=tip} and '
  + '@@color [#367886]{label="Blue"}. @@symbol [find-file]{text="Open a file"} @@hidden [Private draft].';

test("rendered inline reading widgets preserve paragraph semantics and protect private text", () => {
  const container = document.createElement("div");
  container.innerHTML = renderMarkdownHTML(sample);
  expect(container.querySelectorAll("p")).toHaveLength(1);
  expect(container.querySelector(".noema-inline-spoiler input")?.getAttribute("aria-label")).toBe("Answer");
  expect(container.querySelector(".noema-inline-spoiler strong")?.textContent).toBe("answer");
  expect(container.querySelector(".noema-inline-gloss .noema-inline-detail")?.textContent).toBe("Application interface");
  expect(container.querySelector(".noema-inline-annotation a")?.getAttribute("href")).toBe("guide.md");
  expect(container.querySelector("kbd.noema-inline-key")?.textContent).toBe("Ctrl+K");
  expect(container.querySelector(".noema-inline-badge[data-tone=tip]")?.textContent).toBe("Ready");
  expect(container.querySelector(".noema-inline-color")?.textContent).toBe("Blue");
  expect(container.querySelector(".noema-inline-symbol code")?.textContent).toBe("find-file");
  expect(container.textContent).not.toContain("Private draft");
  const literal = '\\@@spoiler [escaped] `@@badge [code]` \\(\\text{@@spoiler [math]}\\)';
  container.innerHTML = renderMarkdownHTML(literal);
  expect(container.querySelector(".noema-inline-reading")).toBeNull();
});

test("PDF expands spoiler and annotation bodies without adding private content", () => {
  const root = document.createElement("div");
  root.innerHTML = renderPublishedNoteHTML(sample, {title:"Reading", format:"pdf"});
  expect(root.querySelectorAll(".noema-inline-reading input")).toHaveLength(0);
  expect(root.querySelector(".noema-inline-spoiler strong")?.textContent).toBe("answer");
  expect(root.querySelector(".noema-inline-annotation a")?.textContent).toBe("Appendix");
  expect(root.textContent).not.toContain("Private draft");
});

test("source-only comments never survive inside HTML title attributes", () => {
  const body = "#+begin note Visible @@hidden [TITLE_SECRET]\nContent.\n#+end note\n\n"
    + "#+begin details Visible @@hidden [DETAILS_SECRET]\nText.\n#+end details\n\n"
    + "#+begin accordion Visible @@hidden [ACCORDION_SECRET]\n### Group\nText.\n#+end accordion\n\n"
    + "Public @@hidden [MALFORMED_SECRET]{ trailing text.";
  const title = "Document @@hidden [DOCUMENT_SECRET]";
  for (const rendered of [renderMarkdownHTML(body), renderPublishedNoteHTML(body, { title }), renderPublishedNoteHTML(body, { title, format: "pdf" })]) {
    expect(rendered).not.toMatch(/\b(?:TITLE|DETAILS|ACCORDION|MALFORMED|DOCUMENT)_SECRET\b/);
    expect(rendered).toContain("trailing text");
  }
});

test("source reveal and preceding edits preserve the chosen inline spoiler state", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `Background.\n\n${sample}\n\nTail.`;
  const editor = createEditor(host, {initialContent:source});
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    const spoiler = () => host.querySelector<HTMLInputElement>(".noema-inline-spoiler input");
    expect(spoiler()?.checked).toBe(false);
    spoiler()?.click();
    expect(spoiler()?.checked).toBe(true);
    editor.setMarkdownSelection(source.indexOf("the **answer**"));
    expect(spoiler()).toBeNull();
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    expect(spoiler()?.checked).toBe(true);
    editor.replaceMarkdownRange(0, 0, "Preface.\n\n", "end");
    await Promise.resolve();
    expect(spoiler()?.checked).toBe(true);
    expect(editor.getMarkdown()).toBe("Preface.\n\n" + source);
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("document-wide spoiler changes update mounted controls and reset for a new note", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = "First @@spoiler [answer].\n\nSecond @@spoiler [answer].\n\nTail.";
  const editor = createEditor(host, { initialContent: source });
  const checked = () => [...host.querySelectorAll<HTMLInputElement>(".noema-inline-toggle")].map((item) => item.checked);
  try {
    editor.setMarkdownSelection(source.length);
    await Promise.resolve();
    expect(editor.runCommand("toggle-spoilers")).toBe(true);
    expect(checked()).toEqual([true, true]);
    expect(editor.undo()).toBe(false);
    expect(editor.getMarkdown()).toBe(source);
    const next = "@@spoiler [new note].\n\nTail.";
    editor.setMarkdown(next, { history: "reset" });
    editor.setMarkdownSelection(next.length);
    await Promise.resolve();
    expect(checked()).toEqual([false]);
  } finally {
    editor.destroy();
    host.remove();
  }
});
