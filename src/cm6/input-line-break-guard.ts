import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Text the browser types at a bare caret never joins two lines.
 *
 * WebKit can put typed or composed text into the wrong DOM node next to a
 * block widget (the label that replaces `#+begin proof`, a heading, a
 * figure): it flattens the line after the widget into the previous one, and
 * CodeMirror reads that as "replace the line break with the text". With a
 * Chinese input method this pulled the next line up onto the block's header
 * and moved the composed text away from the caret, and the mangled document
 * was then saved.
 *
 * Only DOM-originated input reaches this handler; keymap commands, paste and
 * programmatic edits do not. An input that deletes a line break while the
 * caret is empty and inserts text without one is rewritten to keep the line
 * break: the text goes to the caret when the browser put it elsewhere, or
 * just after the kept break when the caret was in the replaced range. Pure
 * deletions (Backspace at a line start) are left alone.
 */
export function inputLineBreakGuard(): Extension {
  return Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
    const selection = view.state.selection;
    if (view.state.readOnly || from === to || text.length === 0 || text.includes("\n")) return false;
    if (selection.ranges.length !== 1 || !selection.main.empty) return false;
    const deleted = view.state.doc.sliceString(from, to);
    const lastBreak = deleted.lastIndexOf("\n");
    if (lastBreak < 0) return false;
    const keptTo = from + lastBreak + 1;
    const head = selection.main.head;
    const caretInRange = head >= from && head <= to;
    const change = caretInRange
      ? { from: keptTo, to, insert: text }
      : { from: head, to: head, insert: text };
    const caret = caretInRange ? keptTo + text.length : head + text.length;
    view.dispatch({
      changes: change,
      selection: { anchor: caret },
      userEvent: view.composing ? "input.type.compose" : "input.type",
      scrollIntoView: true,
    });
    return true;
  }));
}
