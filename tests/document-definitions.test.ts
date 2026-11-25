import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderedDefinitionLines } from "../src/cm6/extensions/visual/definition-lines.ts";
import { renderedDocumentReferences } from "../src/cm6/extensions/visual/document-references.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const sample = [
  "Read API and RAPID. Keep `API` literal.",
  "",
  "#pragma",
  "Decoder",
  ": Read **the bytes**.",
  "",
  ": Preserve their order.",
  "",
  "Renderer",
  "~ Paint the result.",
  "",
  "    Continue with **detail** and [guide](https://example.test).",
  "",
  "#+begin card Example",
  "API is visible here.",
  "#+end card",
  "",
  "*[API]: Application interface",
  "",
  "<!--",
  "*[RAPID]: A hidden comment expansion",
  "-->",
  "",
  "```text",
  "Term",
  ": literal",
  "*[RAPID]: A literal label",
  "```",
  "",
  "End.",
].join("\n");

test("definition aliases, repeat definitions and scoped abbreviations use their semantic HTML", () => {
  const rendered = document.createElement("div");
  rendered.innerHTML = renderMarkdownHTML(sample);
  expect([...rendered.querySelectorAll("dl dt")].map((element) => element.textContent))
    .toEqual(["#pragma", "Decoder", "Renderer"]);
  expect([...rendered.querySelectorAll("dl dd")].map((element) => element.textContent?.trim()))
    .toEqual(["Read the bytes.", "Preserve their order.", "Paint the result.\nContinue with detail and guide."]);
  expect(rendered.querySelector("dd strong")?.textContent).toBe("the bytes");
  expect([...rendered.querySelectorAll("abbr")].map((element) => [element.textContent, element.title]))
    .toEqual([["API", "Application interface"], ["API", "Application interface"]]);
  expect(rendered.querySelector(".noema-document-frame abbr")?.textContent).toBe("API");
  expect(rendered.querySelector("pre")?.textContent).toContain("*[RAPID]: A literal label");
});

test("the editor styles definition markers and updates abbreviation explanations from source", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: sample });
  try {
    editor.setMarkdownSelection(sample.length);
    expect(host.querySelectorAll(".cm-md-definition-term")).toHaveLength(3);
    expect(host.querySelectorAll(".cm-md-definition-body")).toHaveLength(3);
    const continuation = [...host.querySelectorAll(".cm-line")].find((line) => line.textContent?.includes("Continue with"));
    expect(continuation?.classList.contains("cm-md-code-block")).toBe(false);
    expect(continuation?.querySelector(".cm-strong")?.textContent).toContain("detail");
    expect([...host.querySelectorAll("abbr")].map((element) => element.title))
      .toEqual(["Application interface", "Application interface"]);
    const start = sample.indexOf("Application interface");
    editor.view.dispatch({ changes: { from: start, to: start + "Application interface".length, insert: "Public interface" } });
    expect([...host.querySelectorAll("abbr")].map((element) => element.title))
      .toEqual(["Public interface", "Public interface"]);
    const { state } = editor.view;
    const definitions = state.field(renderedDefinitionLines);
    const references = state.field(renderedDocumentReferences);
    editor.view.dispatch({ changes: { from: state.doc.length, insert: " Continue here." } });
    expect(editor.view.state.field(renderedDefinitionLines)).toBe(definitions);
    expect(editor.view.state.field(renderedDocumentReferences)).toBe(references);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: "\n: New definition." } });
    expect(editor.view.state.field(renderedDefinitionLines)).not.toBe(definitions);
    expect(host.querySelectorAll(".cm-md-definition-body")).toHaveLength(4);
  } finally {
    editor.destroy();
    host.remove();
  }
});
