import { EditorState, Text } from "@codemirror/state";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createFloatingTocPanel, inlineTagAnchorsFromText, markdownHeadingsFromText, orgEnvAnchorsFromText } from "../aaronnote/floating-toc.ts";
import { createEditor } from "../src/lib.ts";
import { tocIndexExtension, tocIndexFromState } from "../src/cm6/toc-index.ts";

describe("floating toc heading scan", () => {
  test("scans headings from CM6 Text without materializing markdown", () => {
    const doc = Text.of([
      "# Alpha",
      "body",
      "  ## Beta ###",
      "####Nope",
      "### Gamma",
    ]);

    expect(markdownHeadingsFromText(doc).map((heading) => ({
      level: heading.level,
      text: heading.text,
      pos: heading.pos,
    }))).toEqual([
      { level: 1, text: "Alpha", pos: 2 },
      { level: 2, text: "Beta", pos: 18 },
      { level: 3, text: "Gamma", pos: 40 },
    ]);
  });

  test("scans inline tag anchors without treating code as anchors", () => {
    const doc = Text.of([
      "# Alpha",
      "body @@tag[alpha]",
      "multi @@tag[first] and @@tag[second]",
      "`@@tag[code]`",
      "```",
      "@@tag[fenced]",
      "```",
      "tail @@tag[tail]",
    ]);

    expect(inlineTagAnchorsFromText(doc).map((anchor) => anchor.tag)).toEqual(["alpha", "first", "second", "tail"]);
  });

  test("does not treat fenced markdown-looking lines as headings", () => {
    const doc = Text.of([
      "# Alpha",
      "```",
      "# Example",
      "```",
      "## Beta",
    ]);

    expect(markdownHeadingsFromText(doc).map((heading) => heading.text)).toEqual(["Alpha", "Beta"]);
  });

  test("indexes org-env blocks by kind while excluding fences, math, and lean4", () => {
    const doc = Text.of([
      "#+begin convention tensor minimal subspaces",
      "body",
      "#+end convention",
      "#+begin theorem Spectral theorem",
      "#+end theorem",
      "```md",
      "#+begin remark hidden",
      "#+end remark",
      "```",
      "\\[",
      "#+begin claim also-hidden",
      "\\]",
      "#+begin lean4 old-code-cell",
      "#+end lean4",
    ]);

    expect(orgEnvAnchorsFromText(doc)).toEqual([
      expect.objectContaining({ kind: "convention", title: "tensor minimal subspaces", pos: 0 }),
      expect.objectContaining({ kind: "theorem", title: "Spectral theorem" }),
    ]);
  });

  test("keeps every structure inside meta summary out of external indexes", () => {
    const doc = Text.of([
      "#+begin meta",
      "title: Cover",
      "tags: cover-tag",
      "#+begin summary",
      "# Hidden heading",
      "@@section [Hidden semantic section]",
      "@@tag[hidden-anchor]",
      "#+begin theorem Hidden theorem",
      "@@todo(todo) [Hidden task]",
      "#+end theorem",
      "#+end summary",
      "#+end meta",
      "# Visible heading",
      "@@tag[visible-anchor]",
      "#+begin theorem Visible theorem",
      "#+end theorem",
    ]);

    expect(markdownHeadingsFromText(doc).map((heading) => heading.text)).toEqual(["Visible heading"]);
    expect(inlineTagAnchorsFromText(doc).map((anchor) => anchor.tag)).toEqual(["visible-anchor"]);
    expect(orgEnvAnchorsFromText(doc).map(({ kind, title }) => ({ kind, title }))).toEqual([
      { kind: "meta", title: "" },
      { kind: "theorem", title: "Visible theorem" },
    ]);
  });

  test("keeps meta summary excluded after incremental edits", () => {
    const source = [
      "#+begin meta",
      "title: Cover",
      "#+begin summary",
      "Abstract prose",
      "#+end summary",
      "#+end meta",
      "# Visible",
    ].join("\n");
    let state = EditorState.create({ doc: source, extensions: [tocIndexExtension] });
    const abstractPos = source.indexOf("Abstract prose") + "Abstract prose".length;
    state = state.update({ changes: { from: abstractPos, insert: "\n# Still hidden" } }).state;

    expect(tocIndexFromState(state).headings.map((heading) => heading.text)).toEqual(["Visible"]);
  });

  test("defers org-env scanning UI until its nested toggle and keeps tags visible", () => {
    const mount = document.createElement("div");
    const toc = document.createElement("aside");
    const list = document.createElement("nav");
    const toggleButton = document.createElement("button");
    toc.className = "is-collapsed";
    toc.appendChild(list);
    document.body.append(mount, toc);
    const editor = createEditor(mount);
    editor.setMarkdown("# Heading\n#+begin convention tensor minimal subspaces\nbody\n#+end convention");
    try {
      const panel = createFloatingTocPanel({
        toc,
        toggleButton,
        list,
        editor,
        getNotes: () => [{ id: "note", file: "note.md", title: "Note", tags: ["tensor"] }],
        getCurrentFile: () => "note.md",
        resolveNoteRef: () => undefined,
        openNote: () => {},
      });

      panel.toggle();
      panel.update();
      expect(toc.querySelector(".aaronnote-toc-org-env")).toBeNull();
      expect(toc.querySelector(".aaronnote-toc-org-filter")).toBeNull();
      expect(toc.querySelector(".aaronnote-toc-resize-handle")).toBeTruthy();
      expect(toc.textContent).toContain("#tensor");

      toc.querySelector<HTMLButtonElement>(".aaronnote-toc-org-toggle")!.click();
      const orgRow = toc.querySelector<HTMLElement>(".aaronnote-toc-org-row")!;
      expect(orgRow.querySelector(".aaronnote-toc-org-env")?.textContent).toBe("tensor minimal subspaces");
      expect(orgRow.querySelector(".aaronnote-toc-org-marker")?.textContent).toBe("C");
      expect(orgRow.style.getPropertyValue("--toc-org-color")).toContain("--c-convention");
      const outlineItems = Array.from(list.querySelectorAll<HTMLElement>(".aaronnote-toc-item"));
      expect(outlineItems.findIndex((item) => item.textContent === "Heading"))
        .toBeLessThan(outlineItems.findIndex((item) => item.textContent === "tensor minimal subspaces"));
      expect(toc.textContent).toContain("#tensor");

      const search = toc.querySelector<HTMLInputElement>(".aaronnote-toc-search")!;
      search.value = "no heading matches";
      search.dispatchEvent(new Event("input"));
      expect(toc.textContent).toContain("#tensor");
    } finally {
      editor.destroy();
      mount.remove();
      toc.remove();
    }
  });

  test("updates toc index around changed lines", () => {
    let state = EditorState.create({
      doc: "# Alpha\nbody @@tag[alpha]\n## Beta",
      extensions: [tocIndexExtension],
    });

    state = state.update({
      changes: { from: 0, to: "# Alpha".length, insert: "# Renamed" },
    }).state;
    state = state.update({
      changes: { from: state.doc.length, insert: "\nbody @@tag[tail]" },
    }).state;

    const index = tocIndexFromState(state);
    expect(index.headings.map((heading) => heading.text)).toEqual(["Renamed", "Beta"]);
    expect(index.anchors.map((anchor) => anchor.tag)).toEqual(["alpha", "tail"]);
  });

  test("semantic part and sections outrank markdown headings", () => {
    const doc = Text.of([
      "@@part [Foundations]",
      "@@section [Linear algebra]",
      "@@section(sub) [Inner products]{id: inner-products}",
      "# Markdown detail",
    ]);

    expect(markdownHeadingsFromText(doc)).toEqual([
      expect.objectContaining({ level: 1, text: "Foundations", source: "semantic" }),
      expect.objectContaining({ level: 2, text: "Linear algebra", source: "semantic" }),
      expect.objectContaining({ level: 3, text: "Inner products", slug: "inner-products", source: "semantic" }),
      expect.objectContaining({ level: 6, renderLevel: 1, text: "Markdown detail", source: "markdown" }),
    ]);
  });

  test("toc index falls back correctly when fence structure appears", () => {
    let state = EditorState.create({
      doc: "# Alpha\n@@tag[alpha]\n",
      extensions: [tocIndexExtension],
    });

    state = state.update({
      changes: { from: state.doc.length, insert: "```\n@@tag[code]\n```\n@@tag[tail]" },
    }).state;

    const index = tocIndexFromState(state);
    expect(index.anchors.map((anchor) => anchor.tag)).toEqual(["alpha", "tail"]);
  });

  test("toc index keeps fenced tag text out during body edits", () => {
    let state = EditorState.create({
      doc: "# Alpha\n@@tag[alpha]\n```\n# Example\n@@tag[code]\n```\n@@tag[tail]",
      extensions: [tocIndexExtension],
    });

    const codeLine = state.doc.line(5);
    state = state.update({
      changes: { from: codeLine.to, insert: " edited" },
    }).state;

    const index = tocIndexFromState(state);
    expect(index.headings.map((heading) => heading.text)).toEqual(["Alpha"]);
    expect(index.anchors.map((anchor) => anchor.tag)).toEqual(["alpha", "tail"]);
  });
});
