/**
 * CodeMirror 6 editor kernel — Phase 1 minimum viable skeleton.
 *
 * Implements the public `Editor` interface.
 * CM6 doc IS the markdown source, so:
 *   - no parser/serializer needed (getMarkdown = doc.toString())
 *   - no source-mode toggle (the whole doc is always source)
 *   - CM6 positions == markdown byte offsets
 *
 * CM6 doc positions are the markdown source offsets used by the public API.
 */

import { EditorSelection, EditorState, Transaction, type Extension, type Text as CMText } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  rectangularSelection,
  drawSelection,
} from "@codemirror/view";
import {
  history,
  undo as cmUndo,
  redo as cmRedo,
  defaultKeymap,
  historyKeymap,
} from "@codemirror/commands";
import { closeBrackets } from "@codemirror/autocomplete";
import {
  isMarkdownLinkOpenEvent,
  markdownLinkOpensNewWindow,
  markdownLinkPrimaryModifier,
} from "./markdown-link-events.ts";
import { vscodeCloseBrackets, vscodeDeleteBracketPairKeymap } from "./close-brackets-vscode.ts";
import { foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { disposeHighlightWorker } from "../code-highlight-async.ts";
import { disposeMathRuntime } from "../math-render.ts";
import {
  runCommandCM6,
  getBlockContextCM6,
  createQuickInsertRegistry,
  continueMarkdownBlock,
  exitEmptyMarkdownBlock,
  indentMarkdownBlock,
  tableNavigateCell,
  tableEnterSameColumn,
} from "./commands/index.ts";
import {
  pasteDataTransfer,
  pasteFromClipboard as runPasteFromClipboard,
  pastePlainText as runPastePlainText,
  type EditorPasteOptions,
} from "../paste.ts";
import { renderMarkdownHTML } from "../render-html.ts";
import { markdownLinkDestination } from "../markdown-link.ts";
import { getBlockMathRanges, positionInsideAnyRange } from "./math-ranges.ts";
import { scanInlineMathRanges } from "../inline-math.ts";
import { tocIndexFromState } from "./toc-index.ts";
import { resolveAnchorHeading } from "../heading-slug.ts";
import { skipOrderedListRenumber } from "./ordered-list-renumber.ts";
import { captureHeadingFoldKeys, restoreHeadingFoldKeys } from "./heading-fold.ts";
import { scheduleViewportDecorationRefresh } from "./viewport-refresh.ts";
import { createMarkdownFeatureExtensions } from "./extensions/index.ts";
import { beforeChangeDocumentEffect } from "./extensions/document-lifecycle.ts";
import {
  hasVisualMode,
  isVisualMode,
  orgEnvExitTarget,
  setVisualMode,
} from "./extensions/visual/index.ts";

import type { SyntaxNode } from "@lezer/common";
import type {
  Editor,
  EditorBlockContext,
  EditorCommand,
  EditorOptions,
  QuickInsertItem,
  QuickInsertProvider,
  SelectionOptions,
  SetMarkdownOptions,
  WritingModeOptions,
} from "../editor-api.ts";

function sourceRangeElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) {
    return target.closest<HTMLElement>("[data-cm-source-from][data-cm-source-to]");
  }
  if (target instanceof Text) {
    return target.parentElement?.closest<HTMLElement>("[data-cm-source-from][data-cm-source-to]") ?? null;
  }
  return null;
}

function mathBlockSourceAnchor(docText: string, from: number, to: number): number {
  const raw = docText.slice(from, to);
  const open = raw.indexOf("\\[");
  if (open < 0) return Math.min(to - 1, from + 1);
  const firstNewline = raw.indexOf("\n", open + 2);
  if (firstNewline < 0) return Math.min(to - 1, from + 2);
  return Math.min(to - 1, from + firstNewline + 1);
}

function sourceAnchorForClick(source: HTMLElement, event: MouseEvent, from: number, to: number): number {
  const explicit = Number(source.dataset.cmSourceAnchor);
  if (Number.isFinite(explicit)) {
    return Math.max(from, Math.min(to, explicit));
  }
  const rect = source.getBoundingClientRect();
  // Inline math is delimited by the two-character `\(` … `\)`; other inline
  // widgets use a single leading/trailing source character.
  const delimiter = source.classList.contains("cm-math-inline") ? 2 : 1;
  const innerFrom = Math.min(to - delimiter, from + delimiter);
  const innerTo = Math.max(innerFrom, to - delimiter);
  if (rect.width <= 0 || innerTo <= innerFrom) return innerFrom;
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  return Math.round(innerFrom + ratio * (innerTo - innerFrom));
}

function eventTargetElement(target: EventTarget | Node | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
}

type NativeCaretPosition = { node: Node; offset: number };

function nativeCaretPositionFromPoint(x: number, y: number): NativeCaretPosition | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = doc.caretPositionFromPoint?.(x, y);
  if (caret?.offsetNode) return { node: caret.offsetNode, offset: caret.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

function hasWrappedLayout(view: EditorView): boolean {
  return Boolean(view.dom.querySelector(".aaronnote-image-wrap, .aaronnote-table-wrap, .aaronnote-diagram-wrap"));
}

function realRectContainsY(el: Element, y: number): boolean {
  const rects = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (rects.length === 0) return true;
  return rects.some((rect) => y >= rect.top - 4 && y <= rect.bottom + 4);
}

export function calibrateWrappedLayoutClick(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = eventTargetElement(event.target);
  if (
    target?.closest("input, textarea, select, button, a, [contenteditable='true'], .cm-diagram-toolbar, .cm-diagram-interactive svg")
    || sourceRangeElement(event.target)
    || !hasWrappedLayout(view)
  ) {
    return false;
  }

  const caret = nativeCaretPositionFromPoint(event.clientX, event.clientY);
  if (!caret || !view.contentDOM.contains(caret.node)) return false;
  const line = eventTargetElement(caret.node)?.closest<HTMLElement>(".cm-line");
  if (!line || !realRectContainsY(line, event.clientY)) return false;

  let anchor: number;
  try {
    anchor = view.posAtDOM(caret.node, caret.offset);
  } catch {
    return false;
  }
  if (!Number.isFinite(anchor)) return false;

  const mapped = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (mapped != null && Math.abs(mapped - anchor) <= 1) return false;

  event.preventDefault();
  event.stopPropagation();
  window.setTimeout(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({ selection: { anchor } });
    window.setTimeout(() => {
      if (view.dom.isConnected) view.focus();
    }, 0);
  }, 0);
  return true;
}

function hrefFromLinkNode(state: EditorState, from: number, to: number): string | null {
  let href: string | null = null;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (href) return false;
      if (node.name !== "URL") return;
      href = markdownLinkDestination(state.doc.sliceString(node.from, node.to));
      return false;
    },
  });
  if (href) return href;
  // No inline URL found — may be a reference-style link [text][id] or [text].
  // Scan the document for a matching LinkReference definition.
  // Only runs on user click (on-demand), never per keystroke.
  return resolveRefLinkHref(state, from, to);
}

function resolveRefLinkHref(state: EditorState, linkFrom: number, linkTo: number): string | null {
  // Extract the reference label from the Link node: [text][label] or [text] (collapsed ref).
  let label: string | null = null;
  syntaxTree(state).iterate({
    from: linkFrom,
    to: linkTo,
    enter(node) {
      if (label !== null) return false;
      if (node.name === "LinkLabel") {
        const raw = state.doc.sliceString(node.from, node.to).trim();
        // LinkLabel includes the brackets: [id] — strip them
        label = raw.replace(/^\[|\]$/g, "").trim().toLowerCase();
        return false;
      }
    },
  });
  // Collapsed reference [text] uses the link text as the label.
  if (!label) {
    const linkText = state.doc.sliceString(linkFrom, linkTo);
    const m = linkText.match(/^\[([^\]\n]+)\]\s*(?:\[\])?/);
    label = m?.[1]?.trim().toLowerCase() ?? null;
  }
  if (!label) return null;
  // Walk the syntax tree for a matching LinkReference anywhere in the doc.
  let resolved: string | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (resolved) return false;
      if (node.name !== "LinkReference") return;
      // The LinkReference has a LinkLabel child and a URL child.
      let defLabel: string | null = null;
      let defUrl: string | null = null;
      node.node.cursor().iterate((child) => {
        if (child.name === "LinkLabel") {
          defLabel = state.doc.sliceString(child.from, child.to).replace(/^\[|\]$/g, "").trim().toLowerCase();
        }
        if (child.name === "URL") {
          defUrl = markdownLinkDestination(state.doc.sliceString(child.from, child.to));
        }
      });
      if (defLabel === label && defUrl) resolved = defUrl;
      return false; // don't recurse into LinkReference children twice
    },
  });
  return resolved;
}

function markdownHrefFromLineAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length)));
  const re = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos < from || pos > to) continue;
    return markdownLinkDestination(match[1] || "") || null;
  }
  return null;
}

export function markdownHrefAt(state: EditorState, pos: number): string | null {
  const docLen = state.doc.length;
  const clamped = Math.max(0, Math.min(pos, docLen));
  if (positionInsideAnyRange(clamped, getBlockMathRanges(state))) return null;
  const line = state.doc.lineAt(clamped);
  if (positionInsideAnyRange(clamped, scanInlineMathRanges(line.text, line.from))) return null;

  const positions = clamped > 0 ? [clamped, clamped - 1] : [clamped];

  for (const targetPos of positions) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(targetPos, -1);
    while (node) {
      if (node.name === "Link" || node.name === "Autolink" || node.name === "Image") {
        const href = hrefFromLinkNode(state, node.from, node.to);
        if (href) {
          if (jupyterHref(href)) {
            const lineHref = markdownHrefFromLineAt(state, clamped);
            if (lineHref && jupyterHref(lineHref)) return lineHref;
          }
          return href;
        }
      }
      if (node.name === "URL") {
        const href = markdownLinkDestination(state.doc.sliceString(node.from, node.to));
        if (href) {
          if (jupyterHref(href)) {
            const lineHref = markdownHrefFromLineAt(state, clamped);
            if (lineHref && jupyterHref(lineHref)) return lineHref;
          }
          return href;
        }
      }
      node = node.parent;
    }
  }

  return markdownHrefFromLineAt(state, clamped);
}

function openMarkdownLinkFromEvent(view: EditorView, event: MouseEvent): boolean {
  if (!isMarkdownLinkOpenEvent(event)) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const href = markdownHrefAt(view.state, pos);
  if (!href) return false;

  event.preventDefault();
  event.stopPropagation();
  const customEvent = new CustomEvent("aaronnote:open-url", {
    bubbles: true,
    cancelable: true,
    detail: { href, newWindow: markdownLinkOpensNewWindow(href, event) },
  });
  const handled = !view.dom.dispatchEvent(customEvent);
  if (!handled && href.startsWith("#")) {
    const heading = resolveAnchorHeading(tocIndexFromState(view.state).headings, href);
    if (heading) {
      view.dispatch({ selection: { anchor: heading.pos }, scrollIntoView: true });
      view.focus();
      const dom = view.domAtPos(heading.pos).node;
      const el = dom instanceof Element ? dom : dom.parentElement;
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  return true;
}

function previewMarkdownLinkFromEvent(view: EditorView, event: MouseEvent): boolean {
  if (!markdownLinkPrimaryModifier(event)) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const href = markdownHrefAt(view.state, pos);
  if (!href) return false;

  event.preventDefault();
  event.stopPropagation();
  view.dom.dispatchEvent(new CustomEvent("aaronnote:preview-url", {
    bubbles: true,
    detail: { href, x: event.clientX, y: event.clientY },
  }));
  return true;
}

function jupyterHref(href: string): boolean {
  return /\.ipynb(?:[?@#]|$)/i.test(String(href || "").trim());
}

function attachmentHref(href: string): boolean {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#")) return false;
  const protocol = raw.match(/^([A-Za-z][\w+.-]*):/)?.[1]?.toLowerCase();
  if (protocol && protocol !== "file") return false;
  const path = raw
    .replace(/^file:(?:\/\/)?/i, "")
    .split(/[?#]/, 1)[0]
    ?.trim() ?? "";
  return Boolean(path) && !/\.(?:md|markdown|typ)$/i.test(path);
}

function resolveSourceWidgetHref(view: EditorView, event: MouseEvent): string | null {
  // Walk up from event target to find a widget with data-cm-source-from/to
  let el: Element | null = event.target instanceof Element ? event.target : null;
  while (el) {
    const fromStr = (el as HTMLElement).dataset?.cmSourceFrom;
    const toStr = (el as HTMLElement).dataset?.cmSourceTo;
    if (fromStr != null && toStr != null) {
      const from = Number(fromStr);
      const to = Number(toStr);
      const text = view.state.doc.sliceString(from, to);
      // Extract markdown image/link destination: ![alt](src) or [text](href)
      const m = text.match(/^!?\[[^\]]*\]\(([^)]+)\)/);
      if (m?.[1]) return m[1].trim();
      return null;
    }
    el = el.parentElement;
  }
  return null;
}

function openAttachmentSmartFromEvent(view: EditorView, event: MouseEvent): boolean {
  // Cmd+click (Mac) on image/attachment widgets — the main use case is images
  // which currently have no click handler. Text attachment links also benefit.
  if (!markdownLinkPrimaryModifier(event) || event.shiftKey || event.button !== 0) return false;
  const widgetHref = resolveSourceWidgetHref(view, event);
  if (!widgetHref) return false; // Only intercept widget clicks; text links handled by openMarkdownLinkFromEvent
  if (!attachmentHref(widgetHref) && !/\.(png|jpe?g|gif|svg|webp|bmp|tiff?|avif|heic|pdf|mp4|mov|mp3|wav|docx?|xlsx?|pptx?|zip|tar|gz)$/i.test(widgetHref)) return false;
  event.preventDefault();
  event.stopPropagation();
  view.dom.dispatchEvent(new CustomEvent("aaronnote:open-attachment", {
    bubbles: true,
    cancelable: true,
    detail: { href: widgetHref },
  }));
  return true;
}

function openAttachmentContextMenuFromEvent(view: EditorView, event: MouseEvent): boolean {
  if (markdownLinkPrimaryModifier(event)) return previewMarkdownLinkFromEvent(view, event);
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const href = markdownHrefAt(view.state, pos);
  if (!href || !attachmentHref(href)) return false;

  event.preventDefault();
  event.stopPropagation();
  view.dom.dispatchEvent(new CustomEvent("aaronnote:attachment-context-menu", {
    bubbles: true,
    detail: { href, x: event.clientX, y: event.clientY },
  }));
  return true;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createEditorCM6(host: HTMLElement, options: EditorOptions): Editor {
  const qiRegistry = createQuickInsertRegistry();
  const externalUpdateListeners = new Set<(update: import("@codemirror/view").ViewUpdate) => void>();
  const documentResetListeners = new Set<() => void>();
  // Preserve the stable outer DOM shape so themes and layout CSS work
  // without coupling to the editor implementation.
  const wrap = document.createElement("div");
  wrap.className = "typora-web-wrap";
  const editorHost = document.createElement("div");
  editorHost.className = "typora-web-editor-host";
  wrap.append(editorHost);
  host.append(wrap);
  const initialDoc = options.initialContent ?? "";
  const headingFoldMemory = new Map<string, string[]>();
  let activeDocumentKey = currentDocumentKey();
  const createState = (doc: string, visual = true): EditorState => EditorState.create({
    doc,
    extensions: buildExtensions(
      options,
      visual,
      rememberHeadingFolds,
      "standalone",
      (update) => externalUpdateListeners.forEach((listener) => listener(update)),
    ),
  });

  const view = new EditorView({
    state: createState(initialDoc),
    parent: editorHost,
  });
  scheduleViewportDecorationRefresh(view);
  void document.fonts?.ready.then(() => {
    if (view.dom.isConnected) view.requestMeasure();
  });

  type PointerScrollSnapshot = {
    hostTop: number;
    hostLeft: number;
    editorTop: number;
    editorLeft: number;
    windowX: number;
    windowY: number;
  };

  const capturePointerScroll = (): PointerScrollSnapshot => ({
    hostTop: host.scrollTop,
    hostLeft: host.scrollLeft,
    editorTop: view.scrollDOM.scrollTop,
    editorLeft: view.scrollDOM.scrollLeft,
    windowX: window.scrollX || 0,
    windowY: window.scrollY || 0,
  });

  const restorePointerScroll = (snapshot: PointerScrollSnapshot): void => {
    if (!view.dom.isConnected) return;
    host.scrollTop = snapshot.hostTop;
    host.scrollLeft = snapshot.hostLeft;
    view.scrollDOM.scrollTop = snapshot.editorTop;
    view.scrollDOM.scrollLeft = snapshot.editorLeft;
    window.scrollTo(snapshot.windowX, snapshot.windowY);
  };

  const preservePointerScrollThroughLayout = (snapshot: PointerScrollSnapshot): void => {
    // Opening a replacement widget changes CM6's height map.  Restore only
    // across the two layout frames belonging to this click; no scroll listener
    // or polling remains active afterwards.
    restorePointerScroll(snapshot);
    window.requestAnimationFrame(() => {
      restorePointerScroll(snapshot);
      window.requestAnimationFrame(() => restorePointerScroll(snapshot));
    });
  };

  const onSourceWidgetMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element
      && target.closest("input, textarea, select, button, a")
    ) {
      return;
    }
    if (
      target instanceof Element
      && target.closest(".cm-diagram-toolbar, .cm-diagram-interactive svg")
    ) {
      return;
    }
    const source = sourceRangeElement(event.target);
    if (!source) return;
    const openSource = source.dataset.cmOpenSource === "true";
    const mathBlock = source.dataset.cmMathBlock === "true";
    if (!openSource && !mathBlock) return;
    const from = Number(source.dataset.cmSourceFrom);
    const to = Number(source.dataset.cmSourceTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const scroll = capturePointerScroll();
    const anchor = mathBlock
      ? mathBlockSourceAnchor(view.state.doc.toString(), from, to)
      : sourceAnchorForClick(source, event, from, to);
    // The pointer already identifies visible content.  Asking CM6 to reveal
    // the new source cursor scrolls the old viewport while the replacement
    // widget is expanding, which is both unnecessary and disorienting.
    view.dispatch({ selection: { anchor } });
    view.contentDOM.focus({ preventScroll: true });
    preservePointerScrollThroughLayout(scroll);
    flashCaret();
  };
  view.contentDOM.addEventListener("mousedown", onSourceWidgetMouseDown, { capture: true });

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // Memoize the full-document serialization by CM6's immutable `Text` identity.
  // `view.state.doc` is a fresh instance after any edit, so this cache invalidates
  // automatically and lets the many per-cycle callers (save, assist, word count,
  // roam graph, copilot) share one toString() instead of each rebuilding a
  // multi-MB string.
  let markdownCacheDoc: CMText | null = null;
  let markdownCacheStr = "";
  function getMarkdown(): string {
    const doc = view.state.doc;
    if (doc !== markdownCacheDoc) {
      markdownCacheStr = doc.toString();
      markdownCacheDoc = doc;
    }
    return markdownCacheStr;
  }

  function currentDocumentKey(): string {
    return String(options.getCurrentFile?.() || "");
  }

  function rememberHeadingFolds(key = activeDocumentKey): void {
    if (!key) return;
    headingFoldMemory.set(key, captureHeadingFoldKeys(view.state));
  }

  function restoreHeadingFolds(key = activeDocumentKey): void {
    if (!key) return;
    restoreHeadingFoldKeys(view, headingFoldMemory.get(key));
  }

  function dispatchWithSelect(
    from: number,
    to: number,
    text: string,
    select: "start" | "end" | "all" | undefined,
  ): { from: number; to: number } {
    if (options.readOnly) {
      const selection = view.state.selection.main;
      return { from: selection.from, to: selection.to };
    }
    const insertTo = from + text.length;
    const anchor =
      select === "start" ? from :
      select === "all"   ? from :
      insertTo; // "end" or undefined
    const head = select === "all" ? insertTo : anchor;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor, head },
      scrollIntoView: true,
    });
    return { from: anchor, to: head };
  }

  function pasteInsertRange(options: EditorPasteOptions | undefined, text: string): { from: number; to: number; text: string } {
    const placement = options?.placement;
    const selection = view.state.selection.main;
    if (!placement || placement.kind == null || placement.kind === "selection") {
      return { from: selection.from, to: selection.to, text };
    }

    if (placement.kind === "character") {
      const line = view.state.doc.lineAt(Math.max(0, Math.min(selection.from, view.state.doc.length)));
      const from = placement.where === "after"
        ? Math.min(line.to, selection.to)
        : selection.from;
      return { from, to: from, text };
    }
    if (placement.kind !== "line") {
      return { from: selection.from, to: selection.to, text };
    }

    if (!text.includes("\n")) {
      const line = view.state.doc.lineAt(Math.max(0, Math.min(selection.from, view.state.doc.length)));
      const from = placement.where === "after"
        ? Math.min(line.to, selection.to)
        : selection.from;
      return { from, to: from, text };
    }

    const docLength = view.state.doc.length;
    const line = view.state.doc.lineAt(Math.max(0, Math.min(selection.from, docLength)));
    let insert = text.endsWith("\n") ? text : `${text}\n`;
    let from = line.from;
    if (placement.where === "after") {
      if (line.to < docLength) {
        from = line.to + 1;
      } else {
        from = line.to;
        if (docLength > 0) insert = `\n${insert}`;
      }
    }
    return { from, to: from, text: insert };
  }

  function insertPastedMarkdown(text: string, pasteOptions?: EditorPasteOptions): boolean {
    if (options.readOnly) return false;
    if (!text) return false;
    const range = pasteInsertRange(pasteOptions, text);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: range.text },
      selection: { anchor: range.from + range.text.length },
      scrollIntoView: true,
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Editor interface implementation
  // ---------------------------------------------------------------------------

  const editor: Editor = {
    getMarkdown,

    getMarkdownLength(): number {
      return view.state.doc.length;
    },

    async getMarkdownAsync(): Promise<string> {
      return getMarkdown();
    },

    getHTML(): string {
      return renderMarkdownHTML(getMarkdown());
    },

    setMarkdown(md: string, setOptions: SetMarkdownOptions = {}): void {
      if (setOptions.history === "reset") {
        rememberHeadingFolds();
        activeDocumentKey = currentDocumentKey();
        const visual = isVisualMode(view);
        view.dispatch({ effects: beforeChangeDocumentEffect.of(undefined) });
        view.setState(createState(md, visual));
        documentResetListeners.forEach((listener) => listener());
        restoreHeadingFolds();
        scheduleViewportDecorationRefresh(view);
        return;
      }
      const len = view.state.doc.length;
      view.dispatch({
        changes: { from: 0, to: len, insert: md },
        selection: { anchor: 0 },
        scrollIntoView: true,
        annotations: [
          // Programmatic loads must not trigger ordered-list renumber — it would
          // silently rewrite user content (e.g. a list deliberately starting at 5).
          skipOrderedListRenumber.of(true),
          ...(setOptions.history === "skip" ? [Transaction.addToHistory.of(false)] : []),
        ],
      });
    },

    insertText(text: string, deleteBefore = 0): { from: number; to: number } {
      const { from, to } = view.state.selection.main;
      if (options.readOnly) return { from, to };
      const insertFrom = from - deleteBefore;
      view.dispatch({
        changes: { from: insertFrom, to, insert: text },
        selection: { anchor: insertFrom + text.length },
        scrollIntoView: true,
      });
      return { from: insertFrom, to: insertFrom + text.length };
    },

    async pasteFromClipboard(pasteOptions: EditorPasteOptions = {}): Promise<boolean> {
      if (options.readOnly) return false;
      return runPasteFromClipboard({
        currentFile: options.getCurrentFile,
        assets: options.pasteAssets,
        readSystemClipboardFallback: options.readSystemClipboardFallback,
        insertMarkdown: insertPastedMarkdown,
      }, pasteOptions);
    },

    async pasteFromDataTransfer(data: DataTransfer, pasteOptions: EditorPasteOptions = {}): Promise<boolean> {
      if (options.readOnly) return false;
      return pasteDataTransfer(data, {
        currentFile: options.getCurrentFile,
        assets: options.pasteAssets,
        readSystemClipboardFallback: options.readSystemClipboardFallback,
        insertMarkdown: insertPastedMarkdown,
      }, pasteOptions);
    },

    pastePlainText(text: string, pasteOptions: EditorPasteOptions = {}): boolean {
      if (options.readOnly) return false;
      return runPastePlainText(text, {
        currentFile: options.getCurrentFile,
        assets: options.pasteAssets,
        readSystemClipboardFallback: options.readSystemClipboardFallback,
        insertMarkdown: insertPastedMarkdown,
      }, pasteOptions);
    },

    setSelection(from: number, to?: number, selectionOptions: SelectionOptions = {}): void {
      view.dispatch({
        selection: { anchor: from, head: to ?? from },
        scrollIntoView: selectionOptions.scrollIntoView !== false,
      });
    },

    setMarkdownSelection(from: number, to?: number, selectionOptions: SelectionOptions = {}): void {
      editor.setSelection(from, to, selectionOptions);
    },

    getMarkdownSelection(): { from: number; to: number } {
      const { from, to } = view.state.selection.main;
      return { from, to };
    },

    getMarkdownSelectionRange(): { anchor: number; head: number } {
      const { anchor, head } = view.state.selection.main;
      return { anchor, head };
    },

    getSelection(): { from: number; to: number } {
      return editor.getMarkdownSelection();
    },

    replaceMarkdownRange(
      from: number,
      to: number,
      text: string,
      select?: "start" | "end" | "all",
    ): { from: number; to: number } {
      return dispatchWithSelect(from, to, text, select);
    },

    textBetween(from: number, to: number): string {
      return view.state.doc.sliceString(from, to);
    },

    markdownBetween(from: number, to: number): string {
      const docLen = view.state.doc.length;
      const safeFrom = Math.max(0, Math.min(from, docLen));
      const safeTo = Math.max(safeFrom, Math.min(to, docLen));
      return view.state.doc.sliceString(safeFrom, safeTo);
    },

    replaceRange(
      from: number,
      to: number,
      text: string,
      select?: "start" | "end" | "all",
    ): { from: number; to: number } {
      return dispatchWithSelect(from, to, text, select);
    },

    undo(): boolean {
      if (options.readOnly) return false;
      return cmUndo(view);
    },

    redo(): boolean {
      if (options.readOnly) return false;
      return cmRedo(view);
    },

    runCommand(command: EditorCommand, value = ""): boolean {
      if (options.readOnly) return false;
      return runCommandCM6(view, command, value);
    },

    getBlockContext(): EditorBlockContext {
      return getBlockContextCM6(view);
    },

    registerQuickInsertProvider(provider: QuickInsertProvider): () => void {
      return qiRegistry.register(provider);
    },

    getQuickInsertItems(query = ""): QuickInsertItem[] {
      return qiRegistry.getItems(view, query);
    },

    runQuickInsert(item: QuickInsertItem): boolean {
      return qiRegistry.run(view, item);
    },

    setWritingMode(modeOptions: WritingModeOptions): void {
      wrap.classList.toggle("typora-web-focus-mode", !!modeOptions.focusMode);
      wrap.classList.toggle("typora-web-typewriter-mode", !!modeOptions.typewriterMode);
    },

    cursorContext(maxChars = 512): {
      before: string;
      after: string;
      rect: { left: number; top: number; bottom: number } | null;
      rectAtOffset: (offset: number) => { left: number; top: number; bottom: number } | null;
    } {
      const { from } = view.state.selection.main;
      const docLen = view.state.doc.length;
      const beforeStart = Math.max(0, from - maxChars);
      const afterEnd = Math.min(docLen, from + maxChars);
      const before = view.state.doc.sliceString(beforeStart, from);
      const after = view.state.doc.sliceString(from, afterEnd);

      function rectAt(offset: number) {
        try {
          const coords = view.coordsAtPos(offset);
          if (!coords) return null;
          return { left: coords.left, top: coords.top, bottom: coords.bottom };
        } catch {
          return null;
        }
      }

      return { before, after, rect: rectAt(from), rectAtOffset: (offset: number) => rectAt(beforeStart + offset) };
    },

    cursorRect(): { left: number; top: number; bottom: number } | null {
      const { from } = view.state.selection.main;
      try {
        const coords = view.coordsAtPos(from);
        return coords ? { left: coords.left, top: coords.top, bottom: coords.bottom } : null;
      } catch {
        return null;
      }
    },

    toggleSource(): void {
      const { head } = view.state.selection.main;
      const beforeTop = coordsTopAt(head);
      const enteringPreview = !isVisualMode(view);
      view.dispatch(setVisualMode(enteringPreview));
      preserveCursorScreenTop(head, beforeTop, enteringPreview);
      view.focus();
    },

    isSourceMode(): boolean {
      return !isVisualMode(view);
    },

    focus(): void {
      view.focus();
    },

    revealCursor(): void {
      const { from } = view.state.selection.main;
      view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
      flashCaret();
    },

    destroy(): void {
      externalUpdateListeners.clear();
      documentResetListeners.clear();
      view.contentDOM.removeEventListener("mousedown", onSourceWidgetMouseDown, { capture: true });
      view.destroy();
      wrap.remove();
      disposeHighlightWorker();
      void import("../diagram-render.ts").then(({ disposeDiagramRuntime }) => disposeDiagramRuntime());
      disposeMathRuntime();
    },

    onViewUpdate(listener): () => void {
      externalUpdateListeners.add(listener);
      return () => externalUpdateListeners.delete(listener);
    },

    onDocumentReset(listener): () => void {
      documentResetListeners.add(listener);
      return () => documentResetListeners.delete(listener);
    },

    // Expose the CM6 EditorView as an escape hatch.
    get view() {
      return view;
    },
  };

  return editor;

  function flashCaret(): void {
    // No-op: caret-flash animation removed for performance.
  }

  function coordsTopAt(pos: number): number | null {
    try {
      return view.coordsAtPos(pos)?.top ?? null;
    } catch {
      return null;
    }
  }

  function preserveCursorScreenTop(pos: number, beforeTop: number | null, repeatAfterWidgetLoad: boolean): void {
    const adjust = (): void => {
      if (!view.dom.isConnected) return;
      const afterTop = coordsTopAt(pos);
      if (beforeTop != null && afterTop != null) {
        const delta = afterTop - beforeTop;
        if (Math.abs(delta) >= 1) scrollEditorSurface(delta);
      }
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "nearest" }) });
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(adjust));
    if (repeatAfterWidgetLoad) {
      window.setTimeout(adjust, 240);
      window.setTimeout(adjust, 800);
    }
  }

  function scrollEditorSurface(delta: number): void {
    const before = host.scrollTop;
    host.scrollTop += delta;
    if (Math.abs(host.scrollTop - before) < 1) window.scrollBy(0, delta);
  }
}

// ---------------------------------------------------------------------------
// Extension setup
// ---------------------------------------------------------------------------

function exitCurrentOrgEnv(view: EditorView): boolean {
  const target = orgEnvExitTarget(view.state);
  if (target == null) return false;
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  return true;
}

const SELECTION_WRAP_INPUT_PAIRS = new Map<string, string>([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["<", ">"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["*", "*"],
  ["_", "_"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
]);

export function wrapSelectedMarkdownInput(view: EditorView, _from: number, _to: number, text: string): boolean {
  const close = SELECTION_WRAP_INPUT_PAIRS.get(text);
  if (close == null) return false;

  const ranges = view.state.selection.ranges;
  if (ranges.length === 0 || ranges.some((range) => range.empty)) return false;

  const changes = ranges.map((range) => ({
    from: range.from,
    to: range.to,
    insert: text + view.state.doc.sliceString(range.from, range.to) + close,
  }));

  let offset = 0;
  const nextRanges = ranges.map((range) => {
    const from = range.from + offset + text.length;
    const to = range.to + offset + text.length;
    offset += text.length + close.length;
    return EditorSelection.range(from, to);
  });

  view.dispatch({
    changes,
    selection: EditorSelection.create(nextRanges),
    scrollIntoView: true,
  });
  return true;
}

export type AaronnoteMarkdownExtensionMode = "standalone" | "embedded";

export function toggleAaronnoteMarkdownSource(view: EditorView): boolean {
  if (!hasVisualMode(view)) return false;
  view.dispatch(setVisualMode(!isVisualMode(view)));
  return true;
}

export function isAaronnoteMarkdownSource(view: EditorView): boolean {
  return hasVisualMode(view) ? !isVisualMode(view) : false;
}

export function createAaronnoteMarkdownExtensions(
  options: EditorOptions = {},
): Extension {
  return [
    EditorView.editorAttributes.of({ class: "aaronnote-embedded-markdown" }),
    buildExtensions(
      options,
      true,
      () => undefined,
      "embedded",
    ),
  ];
}

function buildExtensions(
  options: EditorOptions,
  initialVisualMode: boolean,
  onFoldStateChanged: () => void,
  mode: AaronnoteMarkdownExtensionMode,
  notifyExternalUpdate?: (update: import("@codemirror/view").ViewUpdate) => void,
): Extension[] {
  const standalone = mode === "standalone";
  return [
    EditorState.allowMultipleSelections.of(true),
    ...(standalone ? [
      EditorState.readOnly.of(!!options.readOnly),
      EditorView.editable.of(!options.readOnly),
    ] : []),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey || event.metaKey || event.ctrlKey),
    ...(standalone ? [
      drawSelection({ cursorBlinkRate: -1 }),
      history({ minDepth: 200, newGroupDelay: 500 }),
    ] : []),
    vscodeCloseBrackets(),
    closeBrackets(),
    EditorView.inputHandler.of(wrapSelectedMarkdownInput),
    ...(standalone ? [rectangularSelection()] : []),
    keymap.of([
      ...vscodeDeleteBracketPairKeymap,
      { key: "Enter", run: (view) => tableEnterSameColumn(view) || exitEmptyMarkdownBlock(view) || continueMarkdownBlock(view) },
      { key: "Mod-Enter", run: exitCurrentOrgEnv },
      { key: "Tab", run: (view) => tableNavigateCell(view, 1) || indentMarkdownBlock(view, 1) },
      { key: "Shift-Tab", run: (view) => tableNavigateCell(view, -1) || indentMarkdownBlock(view, -1) },
      { key: "Mod-d", run: selectNextMarkdownOccurrence },
      { key: "Mod-Shift-z", run: cmRedo },
      { key: "Meta-Shift-z", run: cmRedo },
      ...(standalone ? defaultKeymap : []),
      ...(standalone ? historyKeymap : []),
    ]),
    createMarkdownFeatureExtensions({ initialVisualMode }),
    highlightActiveLine(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      notifyExternalUpdate?.(update);
      if (update.docChanged && options.onChange) {
        if (options.onChange.length === 0) {
          (options.onChange as () => void)();
        } else {
          const md = update.state.doc.toString();
          options.onChange(md);
        }
      }
      if ((update.selectionSet || update.docChanged) && options.onSelectionChange) {
        const { from, to } = update.state.selection.main;
        options.onSelectionChange({ from, to });
      }
      if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect)))) {
        onFoldStateChanged();
      }
    }),
    EditorView.domEventHandlers({
      mousedown: (event, eventView) => event.button === 0 && (
        openAttachmentSmartFromEvent(eventView, event)
        || openMarkdownLinkFromEvent(eventView, event)
        || calibrateWrappedLayoutClick(eventView, event)
      ),
      auxclick: (event, eventView) => event.button === 1 && (
        openMarkdownLinkFromEvent(eventView, event)
      ),
      contextmenu: (event, eventView) => openAttachmentContextMenuFromEvent(eventView, event),
      focus: () => { options.onFocus?.(); return false; },
      blur: () => { options.onBlur?.(); return false; },
      paste: (event, pasteView) => {
        const data = event.clipboardData;
        if (!data) return false;
        if (options.readOnly) {
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        pasteView.focus();
        void pasteDataTransfer(data, {
          currentFile: options.getCurrentFile,
          assets: options.pasteAssets,
          readSystemClipboardFallback: options.readSystemClipboardFallback,
          insertMarkdown: (markdown, pasteOptions) => {
            if (!markdown) return false;
            const selection = pasteView.state.selection.main;
            pasteView.dispatch({
              changes: { from: selection.from, to: selection.to, insert: markdown },
              selection: { anchor: selection.from + markdown.length },
              scrollIntoView: true,
            });
            void pasteOptions;
            return true;
          },
        }).catch(() => {});
        return true;
      },
    }),
  ];
}

function wordRangeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const offset = pos - line.from;
  const isWord = (ch: string): boolean => /[\p{L}\p{N}_-]/u.test(ch);
  let from = offset;
  let to = offset;
  while (from > 0 && isWord(line.text[from - 1] ?? "")) from--;
  while (to < line.text.length && isWord(line.text[to] ?? "")) to++;
  if (from === to) return null;
  return { from: line.from + from, to: line.from + to };
}

function selectNextMarkdownOccurrence(view: EditorView): boolean {
  const state = view.state;
  const main = state.selection.main;
  let query = main.empty ? "" : state.doc.sliceString(main.from, main.to);
  let firstFrom = main.from;
  let firstTo = main.to;
  if (!query) {
    const word = wordRangeAt(state, main.from);
    if (!word) return false;
    query = state.doc.sliceString(word.from, word.to);
    firstFrom = word.from;
    firstTo = word.to;
  }
  if (!query) return false;
  const start = main.to;
  const after = state.doc.sliceString(start);
  let index = after.indexOf(query);
  let from = index >= 0 ? start + index : -1;
  if (from < 0) {
    const before = state.doc.sliceString(0, Math.max(0, firstFrom));
    index = before.indexOf(query);
    if (index < 0) return false;
    from = index;
  }
  const range = EditorSelection.range(from, from + query.length);
  const ranges = [
    ...state.selection.ranges,
    ...(main.empty && !state.selection.ranges.some((r) => r.from === firstFrom && r.to === firstTo)
      ? [EditorSelection.range(firstFrom, firstTo)]
      : []),
    range,
  ].sort((a, b) => a.from - b.from || a.to - b.to);
  view.dispatch({
    selection: EditorSelection.create(ranges, ranges.length - 1),
    scrollIntoView: true,
  });
  return true;
}
