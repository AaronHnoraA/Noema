import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createEditor } from "../src/editor-api.ts";
import { createWritingStatsController } from "../aaronnote/features/writing-stats/controller.ts";
import { countWritingStats } from "../aaronnote/writing-stats.ts";
import {
  isPointerSelecting,
  pointerSelectionEffect,
  pointerSelectionExtension,
} from "../src/cm6/extensions/visual/selection.ts";
import { createMarkdownLanguageExtension } from "../src/cm6/languages/markdown/index.ts";
import { setVisualMode } from "../src/cm6/extensions/visual/visual-mode.ts";
import {
  blockMathAtomicRangeVisitCount,
  blockMathDecoRangeVisitCount,
} from "../src/cm6/extensions/visual/widgets/math.ts";

function bigDoc(paragraphs: number): string {
  const line = "Reduction preserves the promise, and the mapping stays total. 中文与标点也要计入统计。";
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i++) out.push(`## Section ${i}`, "", `${line} (${i})`, "");
  return out.join("\n");
}

describe("drag-select cost", () => {
  test("extending a selection across a large document stays bounded", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const doc = bigDoc(9000);
    const editor = createEditor(host, { initialContent: doc });
    const label = document.createElement("span");
    const stats = createWritingStatsController(editor, label);
    const steps = 60;
    const heads = Array.from({ length: steps }, (_, i) => Math.floor((doc.length * (i + 1)) / steps));
    try {
      stats.updateNow(); // Warm the full-document scope, as opening a note does.

      let transactions = 0;
      const cm6Started = performance.now();
      for (const head of heads) {
        editor.view.dispatch({ selection: EditorSelection.range(0, head) });
        transactions++;
      }
      const cm6Elapsed = performance.now() - cm6Started;

      const statsStarted = performance.now();
      for (const head of heads) {
        editor.view.dispatch({ selection: EditorSelection.range(0, head) });
        stats.updateNow();
      }
      const statsElapsed = performance.now() - statsStarted;

      // What the same passes cost before the selection scope was chunked.
      const inlineStarted = performance.now();
      for (const head of heads) countWritingStats(editor.view.state.doc, 0, head, null);
      const inlineElapsed = performance.now() - inlineStarted;

      // eslint-disable-next-line no-console
      console.log(
        `[drag-select] doc=${doc.length}B steps=${steps}`
        + ` cm6-only=${(cm6Elapsed / steps).toFixed(2)}ms/step`
        + ` with-stats=${(statsElapsed / steps).toFixed(2)}ms/step`
        + ` inline-count-was=${(inlineElapsed / steps).toFixed(2)}ms/step`,
      );
      expect(transactions).toBe(steps);
      // The point of the change: a selection pass no longer scales with the
      // selection, so it must be far cheaper than counting it inline.
      expect(statsElapsed).toBeLessThan(inlineElapsed);
    } finally {
      stats.destroy();
      editor.destroy?.();
      host.remove();
    }
  });

  test("crossing rendered formulas in the 5 MB fixture stays frame-bounded", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const doc = readFileSync(join(process.cwd(), "tests", "synthetic_qc_note_5mb.md"), "utf8");
    const decoVisitsBefore = blockMathDecoRangeVisitCount();
    const atomicVisitsBefore = blockMathAtomicRangeVisitCount();
    const editor = createEditor(host, { initialContent: doc });
    const initialDecoVisits = blockMathDecoRangeVisitCount() - decoVisitsBefore;
    const initialAtomicVisits = blockMathAtomicRangeVisitCount() - atomicVisitsBefore;
    // Keep all 21k display formulas indexed, but instantiate only the opening
    // render window. A regression to whole-document block decorations makes
    // every later CM6 selection transaction expensive even off screen.
    expect(initialDecoVisits).toBeLessThan(2_000);
    expect(initialAtomicVisits).toBeLessThan(2_000);
    const formulaFrom = doc.indexOf("\\[");
    const formulaTo = doc.indexOf("\\]", formulaFrom + 2) + 2;
    expect(formulaFrom).toBeGreaterThan(0);
    expect(formulaTo).toBeGreaterThan(formulaFrom);

    const anchor = Math.max(0, doc.lastIndexOf("\n", Math.max(0, formulaFrom - 600)) + 1);
    const end = Math.min(doc.length, formulaTo + 600);
    const steps = 60;
    const heads = Array.from(
      { length: steps },
      (_, index) => anchor + Math.floor(((end - anchor) * (index + 1)) / steps),
    );
    const samples: number[] = [];
    try {
      editor.view.dispatch({
        selection: EditorSelection.cursor(anchor),
        effects: pointerSelectionEffect.of(true),
      });
      expect(isPointerSelecting(editor.view.state)).toBe(true);
      for (const head of heads) {
        const started = performance.now();
        editor.view.dispatch({ selection: EditorSelection.range(anchor, head) });
        samples.push(performance.now() - started);
      }
      editor.view.dispatch({ effects: pointerSelectionEffect.of(false) });
      expect(isPointerSelecting(editor.view.state)).toBe(false);

      samples.sort((a, b) => a - b);
      const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? Infinity;
      const maximum = samples.at(-1) ?? Infinity;

      editor.view.dispatch(setVisualMode(false));
      const sourceSamples: number[] = [];
      for (const head of heads) {
        const started = performance.now();
        editor.view.dispatch({ selection: EditorSelection.range(anchor, head) });
        sourceSamples.push(performance.now() - started);
      }
      sourceSamples.sort((a, b) => a - b);
      const sourceP95 = sourceSamples[Math.max(0, Math.ceil(sourceSamples.length * 0.95) - 1)]
        ?? Infinity;

      const minimalHost = document.createElement("div");
      document.body.appendChild(minimalHost);
      const minimal = new EditorView({
        parent: minimalHost,
        state: EditorState.create({
          doc,
          extensions: [
            drawSelection({ cursorBlinkRate: -1 }),
            EditorView.lineWrapping,
            pointerSelectionExtension,
          ],
        }),
      });
      const minimalSamples: number[] = [];
      try {
        minimal.dispatch({
          selection: EditorSelection.cursor(anchor),
          effects: pointerSelectionEffect.of(true),
        });
        for (const head of heads) {
          const started = performance.now();
          minimal.dispatch({ selection: EditorSelection.range(anchor, head) });
          minimalSamples.push(performance.now() - started);
        }
      } finally {
        minimal.destroy();
        minimalHost.remove();
      }
      minimalSamples.sort((a, b) => a - b);
      const minimalP95 = minimalSamples[Math.max(0, Math.ceil(minimalSamples.length * 0.95) - 1)]
        ?? Infinity;

      const languageHost = document.createElement("div");
      document.body.appendChild(languageHost);
      const languageView = new EditorView({
        parent: languageHost,
        state: EditorState.create({
          doc,
          extensions: [
            createMarkdownLanguageExtension(),
            drawSelection({ cursorBlinkRate: -1 }),
            EditorView.lineWrapping,
            pointerSelectionExtension,
          ],
        }),
      });
      const languageSamples: number[] = [];
      try {
        languageView.dispatch({
          selection: EditorSelection.cursor(anchor),
          effects: pointerSelectionEffect.of(true),
        });
        for (const head of heads) {
          const started = performance.now();
          languageView.dispatch({ selection: EditorSelection.range(anchor, head) });
          languageSamples.push(performance.now() - started);
        }
      } finally {
        languageView.destroy();
        languageHost.remove();
      }
      languageSamples.sort((a, b) => a - b);
      const languageP95 = languageSamples[Math.max(0, Math.ceil(languageSamples.length * 0.95) - 1)]
        ?? Infinity;
      // eslint-disable-next-line no-console
      console.log(
        `[formula-drag] doc=${doc.length}B span=${end - anchor}B steps=${steps}`
        + ` full-p95=${p95.toFixed(2)}ms full-max=${maximum.toFixed(2)}ms`
        + ` source-p95=${sourceP95.toFixed(2)}ms`
        + ` minimal-p95=${minimalP95.toFixed(2)}ms language-p95=${languageP95.toFixed(2)}ms`,
      );
      // Happy DOM does not model WebKit layout, but it does execute every
      // synchronous CM6 state field and visual ViewPlugin. Keep that portion
      // comfortably below one 60 Hz frame; the packaged probe covers layout.
      expect(p95).toBeLessThan(16);
    } finally {
      editor.destroy?.();
      host.remove();
    }
  }, 20_000);
});
