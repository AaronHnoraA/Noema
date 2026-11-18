/**
 * The comment card that pops up above a `@@comment` (C79).
 *
 * A comment stands on its own in the text as a small mark
 * (`InlineCommentWidget`).  Its card opens above the line when the caret is
 * on the comment — the source is then shown for editing, and the card shows
 * what it says — or when the pointer rests on the mark.  Both use CM6's own
 * tooltips, which take no part in scrolling.  Only the caret's line is read:
 * a comment's body never spans lines.
 */

import { StateField, type EditorState } from "@codemirror/state";
import { EditorView, hoverTooltip, showTooltip, type Tooltip } from "@codemirror/view";
import { renderInlineMarkdownHTML } from "../../../../render-html.ts";
// @ts-ignore Node source module
import { scanComments } from "../../../../../shared/comments.mjs";

type LineComment = { id: string; done: boolean; text: string; from: number; to: number };

/** Return the comment of POS's line that contains POS (ends included), or null. */
export function commentAt(state: EditorState, pos: number): LineComment | null {
  const line = state.doc.lineAt(pos);
  if (!line.text.includes("@@comment")) return null;
  for (const comment of scanComments(line.text) as LineComment[]) {
    const from = line.from + comment.from, to = line.from + comment.to;
    if (pos >= from && pos <= to) return { ...comment, from, to };
  }
  return null;
}

/** Return the card showing COMMENT. */
export function commentCard(comment: LineComment): HTMLElement {
  const card = document.createElement("div");
  card.className = `noema-comment-card${comment.done ? " noema-comment-card-done" : ""}`;
  const head = document.createElement("div");
  head.className = "noema-comment-card-head";
  const mark = document.createElement("span");
  mark.className = "noema-comment-card-mark";
  mark.textContent = comment.done ? "✓" : "";
  const title = document.createElement("strong");
  title.textContent = comment.done ? "Done" : "Comment";
  head.append(mark, title);
  if (comment.id) {
    const id = document.createElement("small");
    id.textContent = comment.id;
    head.append(id);
  }
  const body = document.createElement("div");
  body.className = "noema-comment-card-body";
  body.innerHTML = renderInlineMarkdownHTML(comment.text.trim() || "(empty)");
  const foot = document.createElement("div");
  foot.className = "noema-comment-card-foot";
  foot.textContent = comment.done ? "A finished task" : "A task: hand it to an agent from H-t";
  card.append(head, body, foot);
  return card;
}

function tooltipFor(comment: LineComment): Tooltip {
  return { pos: comment.from, end: comment.to, above: true, arrow: false,
    create: () => {
      // CM6 makes the returned element the tooltip itself; the card sits
      // inside it so the tooltip's own theme never paints over the card.
      const dom = document.createElement("div");
      dom.className = "noema-comment-tooltip";
      dom.append(commentCard(comment));
      return { dom };
    } };
}

/** The card while the caret is on a comment. */
const caretCommentField = StateField.define<Tooltip | null>({
  create: (state) => caretTooltip(state),
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return caretTooltip(transaction.state);
  },
  provide: (field) => showTooltip.from(field),
});

function caretTooltip(state: EditorState): Tooltip | null {
  const range = state.selection.main;
  if (!range.empty) return null;
  const comment = commentAt(state, range.head);
  // Only inside the source: at its very edges the caret is beside the mark.
  return comment && range.head > comment.from && range.head < comment.to ? tooltipFor(comment) : null;
}

/** The card while the pointer rests on a comment's mark. */
const hoverComment = hoverTooltip((view, pos) => {
  const comment = commentAt(view.state, pos);
  return comment ? tooltipFor(comment) : null;
}, { hoverTime: 250 });

export const commentPopoverExtension = [
  caretCommentField,
  hoverComment,
  EditorView.baseTheme({
    ".cm-tooltip.noema-comment-tooltip, .cm-tooltip:has(> .noema-comment-tooltip)": { border: "none", background: "transparent" },
  }),
];
