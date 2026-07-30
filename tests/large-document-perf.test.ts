import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEditor } from "../src/editor-api.ts";
import { SnippetSession } from "../aaronnote/snippets.ts";

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
// KNOWN-SCAN: opening a math/diagram fence currently triggers a full-document
// rescan in blockMathRangesField / mermaid fenced-code collection (a pre-existing
// design trade-off, see docs/audit-2026-06.md). We only guard against a runaway
// (e.g. an accidental second full pass), not against the scan itself.
const KNOWN_SCAN_CEILING_MS = 2000;

function medianEditLatency(content: string, insert: string): number {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: content });
  const position = Math.floor(editor.getMarkdownLength() / 2);
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
  ];
  for (const [name, insert, ceiling = BOUNDED_CEILING_MS] of boundedCases) {
    test(`bounded latency for ${name} edits in the 5 MB fixture`, () => {
      expect(medianEditLatency(content, insert)).toBeLessThan(ceiling);
    }, 20_000);
  }

  const knownScanCases: Array<[name: string, insert: string]> = [
    ["block math fence", "\\["],
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
});
