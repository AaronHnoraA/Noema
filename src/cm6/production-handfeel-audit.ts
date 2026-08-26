import { EditorView } from "@codemirror/view";

import { createEditor, type Editor } from "../editor-api.ts";

export type ProductionHandfeelAudit = {
  installed: boolean;
  scratchOnly: true;
  orderedListEnter: boolean;
  bracketCompletion: boolean;
  bracketTypeOver: boolean;
  selectionWrapping: boolean;
  unicodeGraphemeDelete: boolean;
  undoRedo: boolean;
  programmaticLoadPreservesNumbers: boolean;
  passed: boolean;
  error?: string;
};

type InputHandler = (view: EditorView, from: number, to: number, insert: string) => boolean;

function pressKey(editor: Editor, key: string): void {
  editor.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  }));
}

// Synthetic keydown cannot invoke a browser's trusted contenteditable default
// insertion. Run the exact production CM6 input-handler facet, then use the
// same input.type fallback CodeMirror would receive from the browser.
function typeCharacter(editor: Editor, character: string): void {
  const view = editor.view;
  const { from, to } = view.state.selection.main;
  const handlers = view.state.facet(EditorView.inputHandler) as unknown as readonly InputHandler[];
  for (const handler of handlers) {
    if (handler(view, from, to, character)) return;
  }
  view.dispatch(view.state.update(
    view.state.replaceSelection(character),
    { userEvent: "input.type" },
  ));
}

/**
 * Exercise production CM6 behavior without touching the live note/editor.
 *
 * The scratch editor has no persistence callback or host bridge, lives outside
 * the viewport, and is destroyed before the report is returned. This makes the
 * packaged smoke a behavior check instead of a source-code/build-presence check.
 */
export function auditProductionHandfeel(doc: Document = document): ProductionHandfeelAudit {
  const failed: ProductionHandfeelAudit = {
    installed: false,
    scratchOnly: true,
    orderedListEnter: false,
    bracketCompletion: false,
    bracketTypeOver: false,
    selectionWrapping: false,
    unicodeGraphemeDelete: false,
    undoRedo: false,
    programmaticLoadPreservesNumbers: false,
    passed: false,
  };
  if (!doc.body) return failed;

  const host = doc.createElement("div");
  host.dataset.noemaProductionHandfeelAudit = "scratch";
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "900px",
    height: "600px",
    opacity: "0",
    pointerEvents: "none",
    contain: "strict",
  });
  doc.body.append(host);

  let editor: Editor | null = null;
  try {
    editor = createEditor(host, { initialContent: "" });

    editor.setMarkdown("1. one", { history: "reset" });
    editor.setMarkdownSelection(6);
    pressKey(editor, "Enter");
    const orderedListEnter = editor.getMarkdown() === "1. one\n2. ";

    editor.setMarkdown("end.", { history: "reset" });
    editor.setMarkdownSelection(3);
    typeCharacter(editor, "(");
    const bracketCompletion = editor.getMarkdown() === "end()." &&
      editor.getMarkdownSelection().from === 4;
    typeCharacter(editor, ")");
    const bracketTypeOver = editor.getMarkdown() === "end()." &&
      editor.getMarkdownSelection().from === 5;

    editor.setMarkdown("word", { history: "reset" });
    editor.setMarkdownSelection(0, 4);
    typeCharacter(editor, "(");
    const wrappedSelection = editor.getMarkdownSelection();
    const selectionWrapping = editor.getMarkdown() === "(word)" &&
      wrappedSelection.from === 1 && wrappedSelection.to === 5;

    const family = "👨‍👩‍👧‍👦";
    editor.setMarkdown(`A${family}B`, { history: "reset" });
    editor.setMarkdownSelection(1 + family.length);
    pressKey(editor, "Backspace");
    const unicodeGraphemeDelete = editor.getMarkdown() === "AB" &&
      editor.getMarkdownSelection().from === 1;

    editor.setMarkdown("", { history: "reset" });
    editor.insertText("x");
    const undoApplied = editor.undo() && editor.getMarkdown() === "";
    const redoApplied = editor.redo() && editor.getMarkdown() === "x";
    const undoRedo = undoApplied && redoApplied;

    editor.setMarkdown("1. temporary\n2. source", { history: "reset" });
    const deliberateNumbers = "5. deliberate\n9. keep";
    editor.setMarkdown(deliberateNumbers, { history: "skip", preserveView: true });
    const programmaticLoadPreservesNumbers = editor.getMarkdown() === deliberateNumbers;

    const checks = {
      orderedListEnter,
      bracketCompletion,
      bracketTypeOver,
      selectionWrapping,
      unicodeGraphemeDelete,
      undoRedo,
      programmaticLoadPreservesNumbers,
    };
    return {
      installed: true,
      scratchOnly: true,
      ...checks,
      passed: Object.values(checks).every(Boolean),
    };
  } catch (error) {
    return {
      ...failed,
      installed: true,
      error: String(error instanceof Error ? error.message : error),
    };
  } finally {
    editor?.destroy();
    host.remove();
  }
}
