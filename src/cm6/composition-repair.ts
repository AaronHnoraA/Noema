import { Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * The drawn text always matches the document.
 *
 * An input method writes into the page's DOM itself, and WebKit sometimes
 * writes into the wrong node beside a rendered construct (a block label, a
 * citation, a list marker). CodeMirror's own DOM bookkeeping can then believe
 * a line is current while it shows doubled or missing characters
 * ("SSteane", "量量子纠错协", a citation drawn twice); the document is right,
 * only the drawing is wrong, and since CodeMirror reuses line DOM it never
 * repairs it, Refresh included.
 *
 * After every composition, and on request (Refresh), each text node of the
 * visible lines that is document text (outside widgets) is compared with the
 * document at the position CodeMirror maps it to. A line that does not match
 * is redrawn by replacing its text with the same text: the document and the
 * selection are unchanged, CodeMirror rebuilds that DOM from state. A line
 * that still does not match after one repair is reported once and left alone,
 * so a systematic difference can never loop.
 */

/** Ranges of document lines whose drawn text differs from the document. */
export function mismatchedDrawnLines(view: EditorView): Array<{ from: number; to: number }> {
  const doc = view.state.doc;
  const content = view.contentDOM;
  const found: Array<{ from: number; to: number }> = [];
  const add = (pos: number): void => {
    const line = doc.lineAt(Math.max(0, Math.min(doc.length, pos)));
    const last = found[found.length - 1];
    if (last && line.from <= last.to + 1) last.to = Math.max(last.to, line.to);
    else found.push({ from: line.from, to: line.to });
  };
  const ownerDocument = content.ownerDocument;
  for (const line of Array.from(content.children)) {
    if (!(line instanceof HTMLElement) || !line.classList.contains("cm-line")) continue;
    const walker = ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const widget = node.parentElement?.closest("[contenteditable='false']");
        return widget && widget !== content && line.contains(widget)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      if (!text) continue;
      let pos: number;
      try {
        pos = view.posAtDOM(node, 0);
      } catch {
        // A node CodeMirror cannot place is not one it drew.
        try { add(view.posAtDOM(line, 0)); } catch { /* the line left the view */ }
        break;
      }
      if (doc.sliceString(pos, pos + text.length) !== text) {
        add(pos);
        break;
      }
    }
  }
  return found;
}

const repairedOnce = new WeakMap<EditorView, Set<string>>();

/** Redraw every visible line whose drawn text differs from the document. Returns the number redrawn. */
export function repairDrawnText(view: EditorView): number {
  if (view.composing || view.compositionStarted) return 0;
  const ranges = mismatchedDrawnLines(view);
  if (ranges.length === 0) return 0;
  const doc = view.state.doc;
  let seen = repairedOnce.get(view);
  if (!seen) repairedOnce.set(view, seen = new Set());
  const fresh = ranges.filter((range) => {
    const key = `${range.from}:${doc.sliceString(range.from, range.to)}`;
    if (seen!.has(key)) return false;
    seen!.add(key);
    if (seen!.size > 256) seen!.clear();
    return true;
  });
  if (fresh.length < ranges.length) {
    console.warn("[noema] drawn text still differs from the document after a repair", ranges);
  }
  if (fresh.length === 0) return 0;
  view.dispatch({
    changes: fresh.map((range) => ({ from: range.from, to: range.to, insert: doc.sliceString(range.from, range.to) })),
    selection: view.state.selection,
    annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("noema.repair")],
  });
  return fresh.length;
}

/** Checks the drawing after each composition ends (the only time the browser writes the DOM itself). */
export function compositionDomRepair(): Extension {
  return ViewPlugin.fromClass(class {
    private timer = 0;
    private readonly view: EditorView;
    private readonly onEnd = (): void => this.schedule();

    constructor(view: EditorView) {
      this.view = view;
      view.contentDOM.addEventListener("compositionend", this.onEnd);
    }

    private schedule(): void {
      window.clearTimeout(this.timer);
      // After CodeMirror has read the composition's last change.
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        if (!this.view.dom.isConnected) return;
        if (this.view.composing || this.view.compositionStarted) {
          this.schedule();
          return;
        }
        repairDrawnText(this.view);
      }, 80);
    }

    destroy(): void {
      window.clearTimeout(this.timer);
      this.view.contentDOM.removeEventListener("compositionend", this.onEnd);
    }
  });
}
