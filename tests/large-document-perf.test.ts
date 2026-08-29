import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEditor } from "../src/editor-api.ts";
import { SnippetSession } from "../aaronnote/snippets.ts";
import {
  blockMathAtomicFullRebuildCount,
  blockMathAtomicRangeVisitCount,
  blockMathDecoRangeVisitCount,
  blockMathFullRebuildCount,
  revealFormulaSource,
  texHighlightScanCount,
} from "../src/cm6/extensions/visual/widgets/math.ts";

// Happy DOM is slower and noisier than WebKit, and the 5 MB syntax tree is
// already fully parsed at editor creation, so absolute numbers are inflated and
// jittery. These ceilings are not the 16 ms browser goal — they exist to catch
// an *accidental* O(document) edit path slipping into a previously bounded key.
//
// BOUNDED: single-character typing whose decoration work is window-bounded by
// design (line decos, table window, heading index). Must not blow up.
const BOUNDED_CEILING_MS = 480;
// A line-count-changing transaction makes Lezer rebalance more of its tree in
// Happy DOM even after Noema's own decorations stay locally patched. This
// tighter Enter-specific ceiling still rejects the previous 610-650 ms
// full-document block-extra scan while allowing the measured 480-500 ms path.
const NEWLINE_CEILING_MS = 520;
// KNOWN-SCAN: diagram fences still trigger a full-document collection. We only
// guard against a runaway (e.g. an accidental second full pass), not against
// that pre-existing scan itself.
const KNOWN_SCAN_CEILING_MS = 2000;

function medianEditLatency(
  content: string,
  insert: string,
  positionValue?: number,
  lineBreaking: "optimal" | "native" = "optimal",
): number {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: content, lineBreaking });
  const position = positionValue ?? Math.floor(editor.getMarkdownLength() / 2);
  const latencies: number[] = [];

  for (let index = 0; index < 7; index++) {
    const start = performance.now();
    editor.view.dispatch({ changes: { from: position, insert } });
    editor.view.dispatch({ changes: { from: position, to: position + insert.length } });
    latencies.push(performance.now() - start);
  }

  latencies.sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)] ?? Infinity;
  editor.destroy();
  host.remove();
  return median;
}

describe("large-document bounded editing", () => {
  const content = readFileSync(join(process.cwd(), "tests", "synthetic_qc_note_5mb.md"), "utf8");

  // Newline is the important regression guard: an Enter press must stay on the
  // near-change line-decoration patch path (lineDecoField), never fall back to a
  // whole-document buildLineDecos rebuild.
  const boundedCases: Array<[name: string, insert: string, ceiling?: number]> = [
    ["plain text", "x"],
    ["newline (Enter)", "\n", NEWLINE_CEILING_MS],
    ["table pipe", "|"],
    ["heading marker", "#"],
    ["block math fence", "\\["],
  ];
  for (const [name, insert, ceiling = BOUNDED_CEILING_MS] of boundedCases) {
    test(`bounded latency for ${name} edits in the 5 MB fixture`, () => {
      expect(medianEditLatency(content, insert)).toBeLessThan(ceiling);
    }, 20_000);
  }

  test("optimal line breaking adds no material synchronous typing cost", () => {
    const position = Math.floor(content.length / 2);
    const native = medianEditLatency(content, "x", position, "native");
    const optimal = medianEditLatency(content, "x", position, "optimal");

    // The KP work itself is delayed until the shared 120 ms typing-settle
    // refresh. This comparison guards the synchronous transaction path, with a
    // small fixed allowance for timer/cache bookkeeping and Happy DOM jitter.
    expect(optimal).toBeLessThanOrEqual(native * 1.25 + 15);
  }, 30_000);

  test("org-env identity title patches remain bounded in the 5 MB fixture", () => {
    const prefix = "#+begin theorem Spectral {#0198fbac-0780-7c99-85e6-333333333333}\nBody.\n#+end theorem\n\n";
    const identityContent = prefix + content;
    const position = identityContent.indexOf("Spectral") + "Spectral".length;
    expect(medianEditLatency(identityContent, "x", position)).toBeLessThan(BOUNDED_CEILING_MS);
  }, 20_000);

  const knownScanCases: Array<[name: string, insert: string]> = [
    ["code fence", "```"],
    // "(" forces a full block-extra redecoration (canMapBlockExtraDecos bails on
    // it), which rebuilds every @@cell decoration in the doc. The fixture now
    // contains @@cell blocks, so this guards against that rebuild becoming
    // super-linear (e.g. an accidental O(cells·doc) scan) rather than the
    // full-doc pass itself, which is a known trade-off.
    ["paren over @@cell blocks", "("],
  ];
  for (const [name, insert] of knownScanCases) {
    test(`no runaway latency for ${name} edits in the 5 MB fixture`, () => {
      expect(medianEditLatency(content, insert)).toBeLessThan(KNOWN_SCAN_CEILING_MS);
    }, 20_000);
  }

  test("snippet transaction mapping remains bounded in the 5 MB fixture", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: content });
    const position = Math.floor(editor.getMarkdownLength() / 2);
    editor.setSelection(position);
    const session = new SnippetSession(editor);
    session.insert({ key: "bench", mode: "tex-mode", body: "${1:value}-${2:next}$0" });
    const latencies: number[] = [];
    for (let index = 0; index < 7; index++) {
      const field = editor.getSelection();
      const value = `v${index}`;
      const started = performance.now();
      editor.view.dispatch({
        changes: { from: field.from, to: field.to, insert: value },
        selection: { anchor: field.from + value.length },
      });
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length / 2)] ?? Infinity).toBeLessThan(BOUNDED_CEILING_MS);
    expect(session.active()).toBe(true);
    editor.destroy();
    host.remove();
  }, 20_000);

  test("editing revealed display source patches only its formula window", () => {
    const formulaCount = 1_200;
    const formulas = Array.from(
      { length: formulaCount },
      (_, index) => `section ${index}\n\\[\nx_${index}=y_${index}\n\\]`,
    );
    const document = formulas.join("\n\n");
    const middle = Math.floor(formulaCount / 2);
    const body = `x_${middle}=y_${middle}`;
    const bodyFrom = document.indexOf(body);
    const formulaFrom = document.lastIndexOf("\\[", bodyFrom);
    const formulaTo = document.indexOf("\\]", bodyFrom) + 2;
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: document });
    expect(revealFormulaSource(editor.view, formulaFrom, formulaTo, 2)).toBe(true);

    const latencies: number[] = [];
    const position = bodyFrom + 2;
    for (let index = 0; index < 9; index++) {
      const started = performance.now();
      editor.view.dispatch({
        changes: { from: position, insert: "q" },
        selection: { anchor: position + 1 },
      });
      editor.view.dispatch({
        changes: { from: position, to: position + 1 },
        selection: { anchor: position },
      });
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length / 2)] ?? Infinity).toBeLessThan(120);
    editor.destroy();
    host.remove();
  }, 20_000);

  test("moving the caret inside revealed display source touches no other formula", () => {
    const formulaCount = 1_200;
    const formulas = Array.from(
      { length: formulaCount },
      (_, index) => `section ${index}\n\\[\nx_${index}=y_${index}\n\\]`,
    );
    const document = formulas.join("\n\n");
    const middle = Math.floor(formulaCount / 2);
    const body = `x_${middle}=y_${middle}`;
    const bodyFrom = document.indexOf(body);
    const formulaFrom = document.lastIndexOf("\\[", bodyFrom);
    const formulaTo = document.indexOf("\\]", bodyFrom) + 2;
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: document });
    expect(revealFormulaSource(editor.view, formulaFrom, formulaTo, 2)).toBe(true);

    // Pure selection transactions. While a formula was revealed these used to
    // rebuild the decorations for every display formula in the note, so arrow
    // keys cost the same as a full re-render.
    const rebuildsBefore = blockMathFullRebuildCount();
    const visitsBefore = blockMathDecoRangeVisitCount();
    const atomicRebuildsBefore = blockMathAtomicFullRebuildCount();
    const atomicVisitsBefore = blockMathAtomicRangeVisitCount();
    const highlightScansBefore = texHighlightScanCount();
    for (let index = 0; index < 12; index++) {
      editor.view.dispatch({ selection: { anchor: bodyFrom + 1 + (index % body.length) } });
    }
    expect(blockMathFullRebuildCount()).toBe(rebuildsBefore);
    expect(blockMathAtomicFullRebuildCount()).toBe(atomicRebuildsBefore);
    expect(blockMathAtomicRangeVisitCount() - atomicVisitsBefore).toBeLessThan(24);
    // Moving the caret within one revealed formula must not even look at the
    // other 1_199: the window patch binary-searches to its own formula, and a
    // move that changes no key skips the patch entirely.
    expect(blockMathDecoRangeVisitCount() - visitsBefore).toBeLessThan(24);

    // Highlighting only ever tokenizes the one revealed formula, so a caret
    // move costs at most a constant number of scans regardless of how many
    // formulas the note holds.
    expect(texHighlightScanCount() - highlightScansBefore).toBeLessThan(24);

    // The same must hold while editing that revealed source.
    const position = bodyFrom + 2;
    for (let index = 0; index < 6; index++) {
      editor.view.dispatch({
        changes: { from: position, insert: "q" },
        selection: { anchor: position + 1 },
      });
      editor.view.dispatch({
        changes: { from: position, to: position + 1 },
        selection: { anchor: position },
      });
    }
    expect(blockMathFullRebuildCount()).toBe(rebuildsBefore);
    expect(blockMathAtomicFullRebuildCount()).toBe(atomicRebuildsBefore);
    // 12 caret moves + 12 edits over a 1_200-formula note.
    expect(texHighlightScanCount() - highlightScansBefore).toBeLessThan(64);
    editor.destroy();
    host.remove();
  }, 20_000);
});
