import { expect, test } from "@voidzero-dev/vite-plus-test";
import { clearPreviewError, showPreviewError } from "../../src/cm6/extensions/visual/widgets/fenced-code.ts";

function figure(withDrawing: boolean) {
  const wrap = document.createElement("figure");
  const div = document.createElement("div");
  if (withDrawing) div.innerHTML = '<svg viewBox="0 0 10 10"></svg>';
  wrap.append(div);
  return { wrap, div };
}

test("an unfinished diagram keeps the last drawing, dimmed, with a one-line error", () => {
  const { wrap, div } = figure(true);
  expect(showPreviewError(div, wrap, "Parse error on line 3:\n...\nExpecting 'NODE', got 'EOF'")).toBe(true);
  expect(div.querySelector("svg")).toBeTruthy();
  expect(wrap.classList.contains("cm-diagram-stale")).toBe(true);
  const line = wrap.querySelector(".cm-diagram-error-line")!;
  expect(line.textContent).toBe("Parse error on line 3: Expecting 'NODE', got 'EOF'");
  // A second error reuses the line instead of stacking another.
  showPreviewError(div, wrap, "Another");
  expect(wrap.querySelectorAll(".cm-diagram-error-line")).toHaveLength(1);
  clearPreviewError(wrap);
  expect(wrap.classList.contains("cm-diagram-stale")).toBe(false);
  expect(wrap.querySelector(".cm-diagram-error-line")).toBeNull();
});

test("with no drawing yet the caller shows the error in place", () => {
  const { wrap, div } = figure(false);
  expect(showPreviewError(div, wrap, "bad")).toBe(false);
  expect(wrap.querySelector(".cm-diagram-error-line")).toBeNull();
});
