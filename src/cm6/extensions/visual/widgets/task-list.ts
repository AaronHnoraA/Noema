/**
 * Phase 6 — Task-list checkbox widget for the CM6 kernel.
 *
 * Lezer GFM task-list node structure:
 *   ListItem
 *     ListMark   — "- " or "* "
 *     TaskMarker — "[ ] " or "[x] "  (GFM extension node)
 *     …content…
 *
 * Behavior:
 *   cursor on same line → show raw source ([ ] / [x]) via live-preview hints
 *   cursor elsewhere   → Decoration.replace over TaskMarker range
 *                        with a visual checkbox span
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { getBlockMathRanges, rangeInsideAny } from "../../../math-ranges.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

class TaskCheckboxWidget extends MeasuredWidget {
  checked: boolean;
  from: number;
  to: number;

  constructor(checked: boolean, from: number, to: number) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: TaskCheckboxWidget): boolean {
    return this.checked === other.checked && this.from === other.from && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "cm-task-checkbox checkbox-frame";
    frame.setAttribute("role", "checkbox");
    frame.setAttribute("aria-checked", String(this.checked));
    frame.setAttribute("tabindex", "-1");

    const box = document.createElement("span");
    box.className = "checkbox";
    box.dataset.checked = this.checked ? "1" : "0";
    frame.append(box);

    frame.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    frame.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Replace exactly the marker range ([ ] or [x]) without adding extra space.
      const raw = view.state.doc.sliceString(this.from, this.to);
      const next = /\[x\]/i.test(raw) ? "[ ]" : "[x]";
      view.dispatch({ changes: { from: this.from, to: this.to, insert: next } });
    });
    return frame;
  }

  ignoreEvent(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

function buildTaskDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(sel.from).number;
  const blockMathRanges = getBlockMathRanges(view.state);

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter(node) {
        if (rangeInsideAny(node.from, node.to, blockMathRanges)) return false;
        if (node.name !== "TaskMarker") return;
        // Keep raw source when cursor is on the same line
        if (doc.lineAt(node.from).number === cursorLine) return false;

        const raw = doc.sliceString(node.from, node.to);
        const checked = /\[x\]/i.test(raw);
        // Replace marker + trailing space so the content starts cleanly
        const to = node.to;
        decos.push(
          Decoration.replace({
            widget: new TaskCheckboxWidget(checked, node.from, to),
          }).range(node.from, to),
        );
        return false;
      },
    });
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

const TASK_MARKER_LINE_RE = /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/;

function activeTaskMarkerLineKey(view: EditorView): string {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  return TASK_MARKER_LINE_RE.test(line.text) ? String(line.number) : "";
}

// ---------------------------------------------------------------------------
// ViewPlugin export
// ---------------------------------------------------------------------------

class TaskListPlugin {
  decorations: DecorationSet;
  private activeLineKey: string;

  constructor(view: EditorView) {
    this.activeLineKey = activeTaskMarkerLineKey(view);
    this.decorations = buildTaskDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    if (update.docChanged || update.viewportChanged || hasViewportDecorationRefresh(update)) {
      this.activeLineKey = activeTaskMarkerLineKey(update.view);
      this.decorations = buildTaskDecorations(update.view);
    } else if (update.selectionSet) {
      const nextLineKey = activeTaskMarkerLineKey(update.view);
      if (nextLineKey === this.activeLineKey) return;
      this.activeLineKey = nextLineKey;
      this.decorations = buildTaskDecorations(update.view);
    }
  }
}

export const taskListExtension = ViewPlugin.fromClass(TaskListPlugin, {
  decorations: (v) => v.decorations,
});
