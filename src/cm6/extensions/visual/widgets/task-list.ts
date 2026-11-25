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
 *                        with an undoable mouse and keyboard control
 */

import { EditorView } from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import { dispatchConstructEdit, inlineConstruct } from "../constructs/index.ts";

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

class TaskCheckboxWidget extends MeasuredWidget {
  readonly checked: boolean;
  readonly label: string;

  constructor(checked: boolean, label: string) {
    super();
    this.checked = checked;
    this.label = label;
  }

  protected measureKey(): string { return ""; }
  protected get measuredBlock(): boolean { return false; }

  eq(other: TaskCheckboxWidget): boolean {
    return this.checked === other.checked && this.label === other.label;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const glyph = dom.firstElementChild;
    if (!(dom instanceof HTMLButtonElement) || !(glyph instanceof HTMLElement)) return false;
    dom.setAttribute("aria-checked", String(this.checked));
    dom.setAttribute("aria-label", this.label || "Task");
    dom.disabled = view.state.readOnly;
    glyph.dataset.checked = this.checked ? "1" : "0";
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("button");
    frame.type = "button";
    frame.className = "cm-task-checkbox checkbox-frame";
    frame.setAttribute("role", "checkbox");

    const box = document.createElement("span");
    box.className = "checkbox";
    box.setAttribute("aria-hidden", "true");
    frame.append(box);
    this.updateDOM(frame, view);

    frame.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    frame.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const from = view.posAtDOM(frame, -1);
      const to = from + 3;
      const raw = view.state.doc.sliceString(from, to);
      if (!/^\[[ xX]\]$/.test(raw)) return;
      const next = /\[x\]/i.test(raw) ? "[ ]" : "[x]";
      dispatchConstructEdit(view, { changes: { from, to, insert: next } });
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
    const label = line.text.slice(marker.to - line.from).trim();
    yield {
      from: marker.from,
      to: marker.to,
      widget: () => new TaskCheckboxWidget(checked, label),
      revealRegion: { from: line.from, to: line.to },
    };
  },
});
