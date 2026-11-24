import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, type MouseSelectionStyle, type ViewUpdate } from "@codemirror/view";

/**
 * Where a pointer lands in the document: the one answer for every click and
 * drag in the editor (scroll-ownership's sibling for the caret).
 *
 * CodeMirror's `posAtCoords` first picks a line from its height map, which is
 * an estimate wherever a widget (an image, TikZ, a diagram, display math)
 * measured its real height after it was drawn. Until that estimate catches
 * up, a click lands on the wrong line or the wrong place in the right one.
 * The browser's own hit test reads the layout as painted, so it is the
 * authority whenever it lands on text inside a real editor line under the
 * pointer; CodeMirror's answer is the fallback for widgets, gaps and margins.
 */
export function pointerPosition(view: EditorView, x: number, y: number): number | null {
  const content = view.contentDOM as HTMLElement | undefined;
  const native = content ? nativeCaretPositionFromPoint(content.ownerDocument, x, y) : null;
  if (native && content!.contains(native.node)) {
    const element = native.node instanceof Element ? native.node : native.node.parentElement;
    const line = element?.closest<HTMLElement>(".cm-line");
    // Text inside a drawn widget is not document text; its widget decides.
    const widget = element?.closest("[contenteditable='false']");
    const insideWidget = Boolean(widget && widget !== view.contentDOM && view.contentDOM.contains(widget));
    if (line && view.contentDOM.contains(line) && !insideWidget && rectsContainY(line, y)) {
      try {
        const position = view.posAtDOM(native.node, native.offset);
        if (Number.isFinite(position)) return position;
      } catch {
        // The node left the view between hit test and mapping.
      }
    }
  }
  return view.posAtCoords({ x, y });
}

type NativeCaret = { node: Node; offset: number };

function nativeCaretPositionFromPoint(doc: Document, x: number, y: number): NativeCaret | null {
  const withCaret = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = withCaret.caretPositionFromPoint?.(x, y);
  if (caret?.offsetNode) return { node: caret.offsetNode, offset: caret.offset };
  const range = withCaret.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * Map a pointer (X, Y) inside a rendered DOM container (such as a rendered
 * table cell) to its visible character offset and total visible text length.
 * Lives in pointer-position.ts so all native hit-testing stays under one owner.
 */
export function renderedTextOffsetAtPoint(
  container: Element,
  x: number,
  y: number,
  skipSelector?: string,
): { offset: number; total: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return null;
  const doc = container.ownerDocument;
  const hit = nativeCaretPositionFromPoint(doc, x, y);
  if (!hit || !container.contains(hit.node)) return null;
  const hitElement = hit.node instanceof Element ? hit.node : hit.node.parentElement;
  if (skipSelector && hitElement?.closest(skipSelector)) return null;

  const skipped = (node: Node): boolean => {
    if (!skipSelector) return false;
    const el = node instanceof Element ? node : node.parentElement;
    return Boolean(el?.closest(skipSelector));
  };

  let targetNode: Node | null = hit.node;
  let targetOffset = hit.offset;
  if (targetNode.nodeType === Node.ELEMENT_NODE) {
    const children = targetNode.childNodes;
    if (targetOffset < children.length) {
      targetNode = children[targetOffset]!;
      targetOffset = 0;
    } else {
      targetNode = null;
    }
  }

  let total = 0;
  let foundOffset: number | null = null;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let textNode: Node | null;
  while ((textNode = walker.nextNode())) {
    if (skipped(textNode)) continue;
    const len = textNode.textContent?.length ?? 0;
    if (foundOffset === null && targetNode && (textNode === targetNode || targetNode.contains(textNode))) {
      foundOffset = total + Math.max(0, Math.min(len, textNode === targetNode ? targetOffset : 0));
    }
    total += len;
  }

  if (foundOffset !== null) return { offset: foundOffset, total };
  if (targetNode === null) return { offset: total, total };
  return null;
}

function rectsContainY(element: Element, y: number): boolean {
  const rects = Array.from(element.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length === 0) return true;
  return rects.some((rect) => y >= rect.top - 1 && y <= rect.bottom + 1);
}

/** The unit a click selects: a point, a word (double click) or a line (triple click). */
function unitAt(state: EditorState, position: number, clicks: number): SelectionRange {
  if (clicks === 2) {
    const word = state.wordAt(position);
    if (word) return word;
  }
  if (clicks >= 3) {
    const line = state.doc.lineAt(position);
    return EditorSelection.range(line.from, Math.min(state.doc.length, line.to + 1));
  }
  return EditorSelection.cursor(position);
}

const SKIP_TARGETS = "input, textarea, select, button, a, [contenteditable='true'], [contenteditable='false'], "
  + ".cm-diagram-toolbar, .cm-diagram-interactive svg, [data-cm-source-from]";

/**
 * CodeMirror's mouse selection with positions from `pointerPosition`. A press
 * on a widget, a control or with a modifier other than Shift keeps
 * CodeMirror's default, which those features rely on.
 */
export const pointerSelectionStyle = EditorView.mouseSelectionStyle.of((view, event): MouseSelectionStyle | null => {
  if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return null;
  const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
  // The content element itself is contenteditable (false when read-only);
  // only a control or widget inside it keeps CodeMirror's default.
  const skip = target?.closest(SKIP_TARGETS);
  if (skip && skip !== view.contentDOM) return null;
  let start = pointerPosition(view, event.clientX, event.clientY);
  if (start == null) return null;
  const clicks = Math.min(3, Math.max(1, event.detail || 1));
  // Shift-click extends the existing selection from its anchor.
  let anchor = event.shiftKey ? view.state.selection.main.anchor : null;
  return {
    get(current, extend) {
      const head = pointerPosition(view, current.clientX, current.clientY) ?? start!;
      const state = view.state;
      if (extend && anchor != null) return EditorSelection.single(anchor, head);
      const from = unitAt(state, start!, clicks);
      const to = unitAt(state, head, clicks);
      if (from.empty && to.empty) return EditorSelection.single(start!, head);
      return head >= start!
        ? EditorSelection.single(Math.min(from.from, to.from), Math.max(from.to, to.to))
        : EditorSelection.single(Math.max(from.to, to.to), Math.min(from.from, to.from));
    },
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      start = update.changes.mapPos(start!);
      if (anchor != null) anchor = update.changes.mapPos(anchor);
    },
  };
});
