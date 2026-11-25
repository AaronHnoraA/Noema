import { expect, test } from "@voidzero-dev/vite-plus-test";
import { collectDocumentComponents } from "../shared/document-components.mjs";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML, renderPublishedNoteHTML } from "../src/render-html.ts";

const sample = [
  "#+begin component Summary {use=report}",
  "First instance.",
  "#+end component",
  "",
  "#+begin component report {kind=card accent=info width=36ch}",
  "#+end component",
  "",
  "#+begin columns",
  "Other column.",
  "#+col",
  "#+begin component Detail {use=report accent=warning}",
  "Second instance.",
  "#+end component",
  "#+end columns",
  "",
  "#+begin component Clear fallback {use=report width=wide}",
  "Undecorated reading.",
  "#+end component",
  "",
  "#+begin comment",
  "#+begin component private {kind=card}",
  "#+end component",
  "#+end comment",
  "",
  "```md",
  "#+begin component literal {kind=card}",
  "#+end component",
  "```",
  "",
  "End.",
].join("\n");

test("document components inherit typed defaults through nested blocks and preserve fallback bodies", () => {
  expect([...collectDocumentComponents(sample).keys()]).toEqual(["report"]);
  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdownHTML(sample);
  const frames = [...rendered.querySelectorAll<HTMLElement>(".noema-document-frame")];
  expect(frames.map((frame) => [frame.dataset.frame, frame.dataset.accent, frame.style.getPropertyValue("--document-frame-width")]))
    .toEqual([["card", "info", "36ch"], ["card", "warning", "36ch"]]);
  expect(rendered.textContent).toContain("Undecorated reading.");
  expect(rendered.querySelector('org-env-block[data-title="report"]')).toBeNull();
  const printed = renderPublishedNoteHTML(sample, { title: "Components", format: "pdf" });
  expect(printed).toContain("First instance.");
  expect(printed).toContain("Second instance.");
});

test("literal openers and duplicate definitions leave the first real declaration in scope", () => {
  const source = [
    "\t#+begin note Indented example", "",
    "#+begin html", "<pre>", "#+begin note Raw example", "</pre>", "#+end html", "",
    "#+begin comment", "#+begin note Comment example", "#+end comment", "",
    "#+begin component report {kind=card accent=info description=\"Summary @@hidden [Private]\"}",
    "#+end component", "",
    "#+begin component report {kind=card accent=danger}", "#+end component", "",
    "#+begin component Summary {use=report}", "Body.", "#+end component",
  ].join("\n");
  const published = renderPublishedNoteHTML(source, { title: "Report" });
  const rendered = document.createElement("div");
  rendered.innerHTML = published;
  expect(rendered.querySelector(".noema-document-frame")?.getAttribute("data-accent")).toBe("info");
  expect(rendered.querySelector(".noema-document-card-description")?.textContent?.trim()).toBe("Summary");
  expect(published).not.toContain("Private");
});

test("an editor column cannot register its fragment's declaration as a document component", () => {
  const source = [
    "#+begin columns", "First column.", "#+col",
    "#+begin component local {kind=card}", "#+end component", "",
    "#+begin component Instance {use=local}", "Readable body.", "#+end component", "#+end columns", "", "End.",
  ].join("\n");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    const pane = host.querySelector(".cm-columns-widget .cm-column-pane:last-of-type");
    expect(pane?.textContent).toContain("Readable body.");
    expect(pane?.querySelector(".noema-document-frame")).toBeNull();
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("editing a component declaration updates mounted instances and preserves exactly the authored source", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: sample });
  try {
    const neutralPosition = sample.indexOf("\n\n") + 1;
    editor.setMarkdownSelection(neutralPosition, neutralPosition, { scrollIntoView: false });
    const accents = () => [...host.querySelectorAll<HTMLElement>(".noema-document-frame")].map((frame) => frame.dataset.accent);
    expect(accents()).toEqual(["info", "warning"]);
    const start = sample.indexOf("accent=info") + "accent=".length;
    editor.view.dispatch({ changes: { from: start, to: start + "info".length, insert: "success" } });
    expect(accents()).toEqual(["success", "warning"]);
    expect(editor.getMarkdown()).toBe(sample.replace("accent=info", "accent=success"));
  } finally {
    editor.destroy();
    host.remove();
  }
});

test("a component using a native callout keeps disclosure state when its source is revealed", async () => {
  const source = [
    "#+begin component Review {use=review-note}", "Read the **details**.", "#+end component", "",
    "#+begin component review-note {kind=note collapsible=true open=false}", "#+end component", "", "End.",
  ].join("\n");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: source });
  const disclosure = () => host.querySelector<HTMLDetailsElement>("details.noema-native-callout-body");
  try {
    const nearby = source.indexOf("\n\n") + 1;
    editor.setMarkdownSelection(nearby, nearby, { scrollIntoView: false });
    await Promise.resolve();
    const heading = host.querySelector(".cm-org-env-heading-widget[data-org-env-kind=note]");
    const toggle = heading?.querySelector<HTMLButtonElement>(".cm-org-env-disclosure-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    toggle?.click();
    expect(disclosure()?.querySelector("strong")?.textContent).toBe("details");
    editor.setMarkdownSelection(source.indexOf("details"));
    expect(disclosure()).toBeNull();
    editor.setMarkdownSelection(nearby, nearby, { scrollIntoView: false });
    await Promise.resolve();
    expect(disclosure()?.open).toBe(true);
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
