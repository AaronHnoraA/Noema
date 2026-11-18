// Comments are side comments of the note (C79).
//
// ⌘⌥M, or Comment on the selection toolbar, opens one small input at the
// selection; Enter writes ` @@scomment [text] {id: …}` right after the
// selected passage as one undoable edit, and the comment is drawn beside the
// text like every side comment.  There is no rail, no thread and no reply:
// a comment is a task, and tasks are handed to agents from Emacs's
// collaboration panel (`H-t`).

import type { EditorView } from "@codemirror/view";
// @ts-ignore Node source module
import { newScommentId, scommentSource } from "../shared/scomment.mjs";

export type CommentsController = {
  startComment(): void;
  destroy(): void;
};

type Options = {
  view: EditorView;
  readOnly: () => boolean;
  setStatus: (message: string) => void;
};

/** Return the text that inserts a comment with TEXT and ID after BEFORE, the
 * character that precedes the insertion point. */
export function commentInsertion(text: string, id: string, before: string): string {
  return `${before && !/\s$/.test(before) ? " " : ""}${scommentSource({ text, id })}`;
}

export function installComments({ view, readOnly, setStatus }: Options): CommentsController {
  let box: HTMLElement | null = null;

  const close = (refocus = true) => {
    box?.remove();
    box = null;
    if (refocus) view.focus();
  };

  const startComment = () => {
    if (readOnly()) { setStatus("Read-only pane"); return; }
    close(false);
    const at = view.state.selection.main.to;
    const coords = view.coordsAtPos(at);
    box = document.createElement("div");
    box.className = "noema-scomment-input";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.placeholder = "Comment — Enter to add, Shift-Enter for a new line, Esc to cancel";
    box.append(input);
    document.body.append(box);
    const rect = box.getBoundingClientRect();
    box.style.left = `${Math.min(Math.max(8, coords?.left ?? 40), window.innerWidth - rect.width - 8)}px`;
    box.style.top = `${Math.min((coords?.bottom ?? 40) + 6, window.innerHeight - rect.height - 8)}px`;
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) { close(); return; }
        const position = Math.min(at, view.state.doc.length);
        const insert = commentInsertion(text, newScommentId(), view.state.sliceDoc(Math.max(0, position - 1), position));
        view.dispatch({
          changes: { from: position, insert },
          selection: { anchor: position + insert.length },
          userEvent: "input.comment",
        });
        close();
      }
    });
    input.addEventListener("blur", () => { if (box && !input.value.trim()) close(false); });
    input.focus({ preventScroll: true });
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey && event.altKey && !event.ctrlKey && event.code === "KeyM") {
      event.preventDefault();
      event.stopPropagation();
      startComment();
    }
  };
  view.dom.addEventListener("keydown", onKey, true);

  return {
    startComment,
    destroy() {
      view.dom.removeEventListener("keydown", onKey, true);
      close(false);
    },
  };
}
