import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorSelection } from "@codemirror/state";

import { createEditor } from "../src/editor-api.ts";
import { createWritingStatsController } from "../aaronnote/features/writing-stats/controller.ts";
import { countWritingStats } from "../aaronnote/writing-stats.ts";

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
});
