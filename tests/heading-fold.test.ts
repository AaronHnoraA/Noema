import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createEditor } from "../src/editor-api.ts";
import { createMarkdownLanguageExtension } from "../src/cm6/languages/markdown/index.ts";
import {
  captureHeadingFoldKeys,
  foldAllHeadings,
  foldHeadingAtCursor,
  headingFoldExtension,
  restoreHeadingFoldKeys,
  toggleFoldAtCursor,
  unfoldAllHeadings,
} from "../src/cm6/heading-fold.ts";
import { tocIndexExtension, tocIndexFromState, type MarkdownHeading } from "../src/cm6/toc-index.ts";

/**
 * The whole-document O(headings^2) fold-range scan this module used to run on
 * every keystroke. Kept as the executable definition of the fold semantics:
 * a heading owns everything up to the line before the next heading of the same
 * or a shallower level.
 */
function referenceFoldRanges(state: EditorState): Map<number, { from: number; to: number }> {
  const doc = state.doc;
  const headings = tocIndexFromState(state).headings
    .filter((heading) => heading.source === "markdown")
    .map((heading) => ({
      ...heading,
      lineNumber: doc.lineAt(heading.markerFrom ?? heading.pos).number,
    }));
  const out = new Map<number, { from: number; to: number }>();
  for (const heading of headings) {
    const headingLine = doc.line(heading.lineNumber);
    let end = doc.line(doc.lines).to;
    for (const other of headings) {
      if (other === heading || other.lineNumber <= heading.lineNumber) continue;
      if ((other.renderLevel ?? other.level) <= (heading.renderLevel ?? heading.level)) {
        end = doc.line(other.lineNumber - 1).to;
        break;
      }
    }
    if (end <= headingLine.to) continue;
    out.set(headingLine.from, { from: headingLine.to, to: end });
  }
  return out;
}

/** The viewport scan `buildChevronDecos` performs, run over the whole document. */
function currentFoldRanges(state: EditorState): Map<number, { from: number; to: number }> {
  const doc = state.doc;
  const headings: MarkdownHeading[] = tocIndexFromState(state).headings;
  const docEnd = doc.line(doc.lines).to;
  const out = new Map<number, { from: number; to: number }>();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    if (heading.source !== "markdown") continue;
    const markerPos = heading.markerFrom ?? heading.pos;
    const headingLine = doc.lineAt(markerPos);
    const level = heading.renderLevel ?? heading.level;
    let end = docEnd;
    for (let next = index + 1; next < headings.length; next++) {
      const other = headings[next]!;
      if (other.source !== "markdown") continue;
      const otherPos = other.markerFrom ?? other.pos;
      if (otherPos <= markerPos) continue;
      if ((other.renderLevel ?? other.level) <= level) {
        end = doc.lineAt(otherPos).from - 1;
        break;
      }
    }
    if (end <= headingLine.to) continue;
    out.set(headingLine.from, { from: headingLine.to, to: end });
  }
  return out;
}

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [tocIndexExtension] });
}

describe("heading fold ranges", () => {
  test("match the whole-document reference on nested outlines", () => {
    const shapes = [
      "# a\nx\n## b\ny\n### c\nz\n# d\nw\n",
      "### deep first\nx\n# shallow after\ny\n",
      "# only heading\n",
      "# a\n## b\n## c\n### d\n#### e\n## f\n# g\n",
      "# a\n\n```\n# fenced, not a heading\n```\n\n## b\ntext\n",
      "###### six\ntext\n###### six again\ntext\n# one\n",
      "no headings at all\njust prose\n",
      "# trailing heading with no body\n",
    ];
    for (const shape of shapes) {
      const state = stateFor(shape);
      expect({ shape, ranges: [...currentFoldRanges(state).entries()] })
        .toEqual({ shape, ranges: [...referenceFoldRanges(state).entries()] });
    }
  });

  test("match the reference across the 5 MB fixture", () => {
    const doc = readFileSync(join(process.cwd(), "tests", "synthetic_qc_note_5mb.md"), "utf8");
    const state = stateFor(doc);
    const reference = referenceFoldRanges(state);
    const current = currentFoldRanges(state);
    expect(reference.size).toBeGreaterThan(1_000);
    expect(current.size).toBe(reference.size);
    for (const [lineStart, range] of reference) expect(current.get(lineStart)).toEqual(range);
  });
});

describe("heading fold commands", () => {
  const doc = "# alpha\nbody a\n## beta\nbody b\n# gamma\nbody g\n";

  test("fold at cursor covers the section body only", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = createEditor(host, { initialContent: doc });
    try {
      editor.view.dispatch({ selection: { anchor: 0 } });
      expect(foldHeadingAtCursor(editor.view)).toBe(true);
      const folded: Array<{ from: number; to: number }> = [];
      foldedRanges(editor.view.state).between(0, doc.length, (from, to) => { folded.push({ from, to }); });
      expect(folded).toHaveLength(1);
      // "# alpha" ends at offset 7; "# gamma" starts the line after "body b".
      expect(folded[0]!.from).toBe(doc.indexOf("\n"));
      expect(folded[0]!.to).toBe(doc.indexOf("# gamma") - 1);
    } finally {
      editor.destroy?.();
      host.remove();
    }
  });

  test("toggle unfolds what it folded, and fold-all/unfold-all round-trip", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const editor = createEditor(host, { initialContent: doc });
    try {
      editor.view.dispatch({ selection: { anchor: 0 } });
      expect(toggleFoldAtCursor(editor.view)).toBe(true);
      expect(toggleFoldAtCursor(editor.view)).toBe(true);
      let folded = 0;
      foldedRanges(editor.view.state).between(0, doc.length, () => { folded += 1; });
      expect(folded).toBe(0);

      expect(foldAllHeadings(editor.view)).toBe(true);
      const keys = captureHeadingFoldKeys(editor.view.state);
      expect(keys.length).toBeGreaterThan(0);

      expect(unfoldAllHeadings(editor.view)).toBe(true);
      folded = 0;
      foldedRanges(editor.view.state).between(0, doc.length, () => { folded += 1; });
      expect(folded).toBe(0);

      expect(restoreHeadingFoldKeys(editor.view, keys)).toBe(true);
      expect(captureHeadingFoldKeys(editor.view.state)).toEqual(keys);
    } finally {
      editor.destroy?.();
      host.remove();
    }
  });
});

describe("heading fold cost", () => {
  test("a keystroke does not scale with the document's heading count", () => {
    const big = readFileSync(join(process.cwd(), "tests", "synthetic_qc_note_5mb.md"), "utf8");
    const host = document.createElement("div");
    document.body.appendChild(host);
    // Only the layers under test, so this stays a guard on heading folding
    // rather than on whatever else the full editor composes.
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: big,
        extensions: [
          EditorView.lineWrapping,
          createMarkdownLanguageExtension(),
          tocIndexExtension,
          headingFoldExtension,
        ],
      }),
    });
    try {
      expect(tocIndexFromState(view.state).headings.length).toBeGreaterThan(5_000);
      // Typing at the start shifts every heading position in the index, which
      // is the worst case for anything that walks the whole outline.
      const samples: number[] = [];
      for (let index = 0; index < 40; index += 1) {
        const started = performance.now();
        view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 } });
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? Infinity;
      // Scanning the whole outline for every heading cost ~29 ms per keystroke
      // on this fixture. The bound is loose enough for a loaded CI machine but
      // still fails long before the quadratic scan could come back.
      expect(p95).toBeLessThan(16);
    } finally {
      view.destroy();
      host.remove();
    }
  }, 60_000);
});
