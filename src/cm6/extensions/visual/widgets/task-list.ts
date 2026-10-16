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

import { EditorView } from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import { inlineConstruct } from "../constructs/index.ts";

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
// Construct family
// ---------------------------------------------------------------------------

/** A task marker without the editor's tree: list item prefix, optionally quoted. */
const TASK_MARKER_RE = /^((?:[ \t]*>)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)(\[[ xX]\])/;

/** The `[ ]`/`[x]` marker on LINE, from the editor's tree when it has reached the line. */
function taskMarkerOnLine(state: EditorState, line: Line): { from: number; to: number } | null {
  if (!line.text.includes("[")) return null;
  if (syntaxTreeAvailable(state, line.to)) {
    let marker: { from: number; to: number } | null = null;
    syntaxTree(state).iterate({
      from: line.from,
      to: line.to,
      enter(node) {
        if (marker) return false;
        if (node.name !== "TaskMarker") return;
        marker = { from: node.from, to: node.to };
        return false;
      },
    });
    return marker;
  }
  const match = TASK_MARKER_RE.exec(line.text);
  return match ? { from: line.from + match[1]!.length, to: line.from + match[1]!.length + 3 } : null;
}

export const taskListExtension = inlineConstruct({
  kind: "task-marker",
  // The marker opens while the caret is anywhere on its line, so the item's
  // whole Markdown is visible while it is being edited.
  reveal: "edge",
  maxPerViewport: 2_000,
  *match(line, state) {
    const marker = taskMarkerOnLine(state, line);
    if (!marker) return;
    const checked = /\[x\]/i.test(state.doc.sliceString(marker.from, marker.to));
    yield {
      from: marker.from,
      to: marker.to,
      widget: () => new TaskCheckboxWidget(checked, marker.from, marker.to),
      revealRegion: { from: line.from, to: line.to },
    };
  },
});
