/**
 * CodeMirror 6 editor kernel — Phase 1 minimum viable skeleton.
 *
 * Implements the public `Editor` interface.
 * CM6 doc IS the markdown source, so:
 *   - no parser/serializer needed (getMarkdown = doc.toString())
 *   - no source-mode toggle (the whole doc is always source)
 *   - CM6 positions == Markdown UTF-16 code-unit offsets
 *
 * JavaScript and CM6 share UTF-16 positions. The Go persistence boundary
 * converts them to UTF-8 byte offsets when it applies an incremental save.
 */

import { Compartment, EditorSelection, EditorState, findClusterBreak, Transaction, type Extension, type SelectionRange, type Text as CMText } from "@codemirror/state";
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
import { wikiLinkAt } from "../../shared/wiki-link.mjs";
import { vscodeCloseBrackets } from "./close-brackets-vscode.ts";
import { texSourceInput } from "./tex-source-input.ts";
import { runEditorDelete, runEditorEnter, runEditorTab } from "./input-commands.ts";
import { isWordChar } from "./text-boundaries.ts";
import {
  pasteTargetExtension,
  resolveEditorPasteTarget,
} from "./paste-target.ts";
import { foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { disposeHighlightWorker } from "../code-highlight-async.ts";
import { disposeMathRuntime } from "../math-render.ts";
import {
  runCommandCM6,
  getBlockContextCM6,
  createQuickInsertRegistry,
} from "./commands/index.ts";
import {
  pasteDataTransfer,
  pasteFromClipboard as runPasteFromClipboard,
  pastePlainText as runPastePlainText,
  type EditorPasteOptions,
} from "../paste.ts";
import { renderMarkdownHTML } from "../render-html.ts";
import {
  applyMarkdownFormat,
  captureMarkdownFormat,
  getCommonFormatPainterSnapshot,
  shouldKeepFormatPainterActive,
  type FormatPainterMode,
  type FormatPainterSnapshot,
} from "../format-painter.ts";
import { markdownLinkDestination } from "../markdown-link.ts";
import { pauseImageAnimationTemporarily } from "../image-animation.ts";
import { getBlockMathRanges, positionInsideAnyRange } from "./math-ranges.ts";
import { scanInlineMathRanges } from "../inline-math.ts";
import { tocIndexFromState } from "./toc-index.ts";
import {
  headingNumberingExtension,
  setHeadingNumbering as configureHeadingNumbering,
  type HeadingNumberingConfiguration,
} from "./heading-number.ts";
import { resolveAnchorHeading } from "../heading-slug.ts";
import { skipOrderedListRenumber } from "./ordered-list-renumber.ts";
import { captureHeadingFoldKeys, restoreHeadingFoldKeys } from "./heading-fold.ts";
import { scheduleViewportDecorationRefresh } from "./viewport-refresh.ts";
import { createMarkdownFeatureExtensions } from "./extensions/index.ts";
import {
  beforeChangeDocumentEffect,
  hasBeforeChangeDocumentEffect,
} from "./extensions/document-lifecycle.ts";
import {
  EditorViewportStabilizer,
  mapPositionAcrossText,
  minimalDocumentChange,
} from "./viewport-stability.ts";
import {
  finishInlineMathEditing,
  hasVisualMode,
  isVisualMode,
  orgEnvExitTarget,
  formulaRangeAtWidgetPosition,
  revealFormulaSource,
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

/** Live document position of a replace-decoration widget's root element. */
function widgetSourcePosition(view: EditorView, source: HTMLElement): number | null {
  try {
    const position = view.posAtDOM(source, -1);
    return Number.isFinite(position) ? position : null;
  } catch (_) {
    // The element may already be detached from the current view tree.
    return null;
  }
}

function formulaSourceOffsetForClick(source: HTMLElement, event: MouseEvent, sourceLength: number): number {
  const rect = source.getBoundingClientRect();
  if (rect.width <= 0 || sourceLength <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  return Math.round(sourceLength * ratio);
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

  let codeNode: SyntaxNode | null = syntaxTree(state).resolveInner(clamped, -1);
  while (codeNode) {
    if (["InlineCode", "FencedCode", "CodeBlock", "IndentedCode"].includes(codeNode.name)) return null;
    codeNode = codeNode.parent;
  }
  const wiki = wikiLinkAt(line.text, clamped, line.from);
  if (wiki?.href) return wiki.href;

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
    detail: { href, x: event.clientX, y: event.clientY, persistent: true },
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
  let formatPainter: { mode: FormatPainterMode; snapshot: FormatPainterSnapshot } | null = null;
  const headingNumbering: HeadingNumberingConfiguration = {
    enabled: options.headingNumbering?.enabled ?? false,
    format: options.headingNumbering?.format ?? "decimal-hierarchical",
  };
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
  const historyCompartment = new Compartment();
  const historyExtension = history({ minDepth: 200, newGroupDelay: 500 });
  let activeDocumentKey = currentDocumentKey();
  const createState = (doc: string, visual = true): EditorState => EditorState.create({
    doc,
    extensions: buildExtensions(
      options,
      visual,
      rememberHeadingFolds,
      "standalone",
      (update) => externalUpdateListeners.forEach((listener) => listener(update)),
      historyCompartment.of(historyExtension),
    ),
  });

  let viewportStabilizer: EditorViewportStabilizer | null = null;
  const view = new EditorView({
    state: createState(initialDoc),
    parent: editorHost,
    dispatchTransactions: (transactions, transactionView) => {
      // A transaction must be applied before any viewport/layout work. In an
      // xwidget, reading layout may synchronously deliver a focus/DOM update;
      // doing that first advances EditorState and makes this transaction stale.
      transactionView.update(transactions);
      viewportStabilizer?.afterUpdate(transactions);
    },
  });
  viewportStabilizer = new EditorViewportStabilizer(view, host);
  const onEditorScroll = (): void => pauseImageAnimationTemporarily(view.contentDOM, 256);
  view.scrollDOM.addEventListener("scroll", onEditorScroll, { passive: true });
  scheduleViewportDecorationRefresh(view);
  void document.fonts?.ready.then(() => {
    if (view.dom.isConnected) view.requestMeasure();
  });

  const onSourceWidgetMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
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
    const inlineMath = source.dataset.cmInlineMath === "static";
    if (!openSource && !mathBlock) return;
    if (view.state.readOnly || options.passiveReader) {
      // CM6 otherwise maps the pointer into the hidden source range, which
      // replaces the visual widget with authoring source even in read-only
      // mode. Reader mode keeps the same widget rendering but makes that
      // source-reveal interaction inert.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    // The widget's own dataset is only a hint: it is written once at toDOM()
    // time and goes stale as soon as an edit elsewhere shifts the document, so
    // the live decoration position is the authority.
    const widgetPosition = widgetSourcePosition(view, source);
    const datasetFrom = Number(source.dataset.cmSourceFrom);
    const datasetTo = Number(source.dataset.cmSourceTo);
    const formula = mathBlock || inlineMath
      ? formulaRangeAtWidgetPosition(view.state, widgetPosition ?? datasetFrom)
      : null;
    const from = formula?.from ?? datasetFrom;
    const to = formula?.to ?? datasetTo;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const anchor = sourceAnchorForClick(source, event, from, to);
    // The pointer already identifies visible content.  Asking CM6 to reveal
    // the new source cursor scrolls the old viewport while the replacement
    // widget is expanding, which is both unnecessary and disorienting.
    if (formula) {
      revealFormulaSource(
        view,
        formula.from,
        formula.to,
        formulaSourceOffsetForClick(source, event, formula.contentTo - formula.contentFrom),
      );
      if (!formula.display) view.contentDOM.focus({ preventScroll: true });
    } else if (mathBlock || inlineMath) {
      return;
    } else {
      view.dispatch({ selection: { anchor } });
      view.contentDOM.focus({ preventScroll: true });
    }
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

  function pasteInsertRanges(options: EditorPasteOptions | undefined, text: string): {
    ranges: Array<{ from: number; to: number; text: string }>;
    ownsSelection: boolean;
    mainIndex: number;
    vimRegister: boolean;
  } | null {
    const placement = options?.placement;
    const target = options?.target
      ? resolveEditorPasteTarget(view, options.target)
      : null;
    if (options?.target && !target) return null;
    const selections = target?.ranges ?? view.state.selection.ranges;
    const ownsSelection = target?.ownsSelection ?? true;
    const useFragments = target?.fragments?.length === selections.length
      && target.clipboardText === text;
    const inserts = selections.map((selection, index) => {
      let insert = useFragments ? target.fragments![index]! : text;
      const rangePlacement = placement;
      if (!rangePlacement || !("where" in rangePlacement)) {
        return { from: selection.from, to: selection.to, text: insert };
      }

      if (rangePlacement.kind === "character") {
        const line = view.state.doc.lineAt(Math.max(0, Math.min(selection.from, view.state.doc.length)));
        const from = rangePlacement.where === "after"
          ? Math.min(line.to, selection.to)
          : selection.from;
        return { from, to: from, text: insert };
      }

      if (!insert.includes("\n")) {
        const line = view.state.doc.lineAt(Math.max(0, Math.min(selection.from, view.state.doc.length)));
        const from = rangePlacement.where === "after"
          ? Math.min(line.to, selection.to)
          : selection.from;
        return { from, to: from, text: insert };
      }

      const docLength = view.state.doc.length;
      const line = view.state.doc.lineAt(Math.max(0, Math.min(selection.from, docLength)));
      insert = insert.endsWith("\n") ? insert : `${insert}\n`;
      let from = line.from;
      if (rangePlacement.where === "after") {
        if (line.to < docLength) {
          from = line.to + 1;
        } else {
          from = line.to;
          // Appending past the last line, there is no following line for the
          // register's trailing newline to sit in front of, so keeping it as
          // well as adding the leading separator left a stray blank line at the
          // end of the file — which then gets saved and shows up in every diff.
          // Spend that newline as the separator instead.
          const body = insert.endsWith("\n") ? insert.slice(0, -1) : insert;
          insert = docLength > 0 ? `\n${body}` : body;
        }
      }
      return { from, to: from, text: insert };
    });
    const unique = [...new Map(inserts.map((range) => [`${range.from}:${range.to}`, range])).values()]
      .sort((left, right) => left.from - right.from || left.to - right.to);
    return {
      ranges: unique,
      ownsSelection,
      mainIndex: Math.min(view.state.selection.mainIndex, Math.max(0, unique.length - 1)),
      vimRegister: Boolean(target?.fragments),
    };
  }

  function insertPastedMarkdown(text: string, pasteOptions?: EditorPasteOptions): boolean {
    if (options.readOnly) return false;
    if (!text) return false;
    const insertion = pasteInsertRanges(pasteOptions, text);
    if (!insertion || insertion.ranges.length === 0) return false;
    const changeSet = view.state.changes(insertion.ranges.map((range) => ({
      from: range.from,
      to: range.to,
      insert: range.text,
    })));
    const nextRanges = insertion.ranges.map((range) => {
      if (!insertion.vimRegister) {
        return EditorSelection.cursor(changeSet.mapPos(range.from, 1));
      }
      const start = changeSet.mapPos(range.from, -1);
      if (pasteOptions?.placement?.kind === "line" && range.text.includes("\n")) {
        const contentStart = range.text.startsWith("\n") ? 1 : 0;
        const indent = range.text.slice(contentStart).match(/^[ \t]*/u)?.[0].length ?? 0;
        return EditorSelection.cursor(start + contentStart + indent);
      }
      return EditorSelection.cursor(
        start + findClusterBreak(range.text, range.text.length, false),
      );
    });
    view.dispatch(view.state.update({
      changes: changeSet,
      ...(insertion.ownsSelection ? {
        selection: EditorSelection.create(nextRanges, insertion.mainIndex),
      } : {}),
      scrollIntoView: insertion.ownsSelection,
    }));
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
      finishInlineMathEditing(view);
      if (setOptions.history === "reset") {
        const source = getMarkdown();
        const nextDocumentKey = currentDocumentKey();
        if (setOptions.preserveView && nextDocumentKey === activeDocumentKey) {
          const selection = EditorSelection.create(
            view.state.selection.ranges.map((range) => {
              const anchorAssoc = range.empty ? range.assoc : range.anchor <= range.head ? -1 : 1;
              const headAssoc = range.empty ? range.assoc : -anchorAssoc;
              const anchor = mapPositionAcrossText(source, md, range.anchor, anchorAssoc);
              const head = mapPositionAcrossText(source, md, range.head, headAssoc);
              return range.empty
                ? EditorSelection.cursor(
                    anchor,
                    range.assoc,
                    range.bidiLevel ?? undefined,
                    range.goalColumn,
                  )
                : EditorSelection.range(
                    anchor,
                    head,
                    range.goalColumn,
                    range.bidiLevel ?? undefined,
                    range.assoc,
                  );
            }),
            view.state.selection.mainIndex,
          );
          const change = minimalDocumentChange(source, md);
          viewportStabilizer!.preserve(() => {
            view.dispatch({
              ...(change ? { changes: change } : {}),
              selection,
              effects: beforeChangeDocumentEffect.of(undefined),
              annotations: [
                Transaction.addToHistory.of(false),
                skipOrderedListRenumber.of(true),
              ],
            });
            // Removing and re-adding the history compartment clears stale
            // local undo events without calling setState (which tears down the
            // document DOM and collapses the outer scroll host).
            view.dispatch({ effects: historyCompartment.reconfigure([]) });
            view.dispatch({ effects: historyCompartment.reconfigure(historyExtension) });
          }, (position) => mapPositionAcrossText(source, md, position, 1));
          documentResetListeners.forEach((listener) => listener());
          scheduleViewportDecorationRefresh(view);
          return;
        }
        rememberHeadingFolds();
        formatPainter = null;
        activeDocumentKey = nextDocumentKey;
        const visual = isVisualMode(view);
        view.dispatch({ effects: beforeChangeDocumentEffect.of(undefined) });
        view.setState(createState(md, visual));
        viewportStabilizer!.resetBaseline();
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

    preserveViewport<T>(update: () => T): T {
      return viewportStabilizer!.preserve(update);
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

    setHeadingNumbering(next): void {
      if (typeof next.enabled === "boolean") headingNumbering.enabled = next.enabled;
      if (next.format) headingNumbering.format = next.format;
      configureHeadingNumbering(view, next);
    },

    captureFormat(mode = "once"): FormatPainterSnapshot | undefined {
      const source = view.state.doc.toString();
      const segments = view.state.selection.ranges
        .map((range) => captureMarkdownFormat(source, range.from, range.to))
        .filter((snapshot): snapshot is FormatPainterSnapshot => Boolean(snapshot));
      if (segments.length !== view.state.selection.ranges.length) return undefined;
      const snapshot = getCommonFormatPainterSnapshot(segments.map((segment) => ({
        styles: segment.styles,
        types: segment.types,
      })));
      if (!snapshot) return undefined;
      formatPainter = { mode, snapshot };
      return { styles: { ...snapshot.styles }, types: [...snapshot.types] };
    },

    applyCapturedFormat(): boolean {
      if (options.readOnly || !formatPainter) return false;
      const source = view.state.doc.toString();
      const changes = view.state.selection.ranges.map((range) => (
        applyMarkdownFormat(source, range.from, range.to, formatPainter!.snapshot)
      ));
      if (changes.some((change) => !change)) return false;
      const resolved = changes as Array<NonNullable<(typeof changes)[number]>>;
      let offset = 0;
      const paintedSelections = resolved.map((change) => {
        const selection = EditorSelection.range(
          change.selectionFrom + offset,
          change.selectionTo + offset,
        );
        offset += change.insert.length - (change.to - change.from);
        return selection;
      });
      view.dispatch({
        changes: resolved.map(({ from, to, insert }) => ({ from, to, insert })),
        selection: EditorSelection.create(paintedSelections, view.state.selection.mainIndex),
        scrollIntoView: true,
      });
      if (!shouldKeepFormatPainterActive(formatPainter.mode)) formatPainter = null;
      return true;
    },

    getFormatPainterState(): { mode: FormatPainterMode; snapshot: FormatPainterSnapshot } | null {
      return formatPainter ? {
        mode: formatPainter.mode,
        snapshot: { styles: { ...formatPainter.snapshot.styles }, types: [...formatPainter.snapshot.types] },
      } : null;
    },

    clearFormatPainter(): void {
      formatPainter = null;
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
      finishInlineMathEditing(view);
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
      finishInlineMathEditing(view);
      externalUpdateListeners.clear();
      documentResetListeners.clear();
      view.contentDOM.removeEventListener("mousedown", onSourceWidgetMouseDown, { capture: true });
      view.scrollDOM.removeEventListener("scroll", onEditorScroll);
      viewportStabilizer!.destroy();
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
  standaloneHistory: Extension = history({ minDepth: 200, newGroupDelay: 500 }),
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
      standaloneHistory,
    ] : []),
    texSourceInput(),
    pasteTargetExtension,
    vscodeCloseBrackets(),
    closeBrackets(),
    EditorView.inputHandler.of(wrapSelectedMarkdownInput),
    ...(standalone ? [rectangularSelection()] : []),
    keymap.of([
      { key: "Backspace", run: (view) => runEditorDelete(view, "backward") },
      { key: "Delete", run: (view) => runEditorDelete(view, "forward") },
      { key: "Enter", run: runEditorEnter },
      { key: "Mod-Enter", run: exitCurrentOrgEnv },
      { key: "Tab", run: (view) => runEditorTab(view) },
      { key: "Shift-Tab", run: (view) => runEditorTab(view, true) },
      { key: "Mod-d", run: selectNextMarkdownOccurrence },
      { key: "Mod-Shift-z", run: cmRedo },
      { key: "Meta-Shift-z", run: cmRedo },
      ...(standalone ? defaultKeymap : []),
      ...(standalone ? historyKeymap : []),
    ]),
    createMarkdownFeatureExtensions({ initialVisualMode }),
    headingNumberingExtension({
      enabled: options.headingNumbering?.enabled ?? false,
      format: options.headingNumbering?.format ?? "decimal-hierarchical",
    }),
    highlightActiveLine(),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      const documentReset = hasBeforeChangeDocumentEffect(update);
      if (!documentReset) notifyExternalUpdate?.(update);
      if (update.docChanged && options.onChange && !documentReset) {
        if (options.onChange.length === 0) {
          (options.onChange as () => void)();
        } else {
          const md = update.state.doc.toString();
          options.onChange(md);
        }
      }
      if ((update.selectionSet || update.docChanged) && options.onSelectionChange && !documentReset) {
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
  let from = offset;
  let to = offset;
  while (from > 0 && isWordChar(line.text[from - 1] ?? "")) from--;
  while (to < line.text.length && isWordChar(line.text[to] ?? "")) to++;
  if (from === to) return null;
  return { from: line.from + from, to: line.from + to };
}

function findMarkdownText(
  doc: CMText,
  query: string,
  from: number,
  to: number = doc.length,
): number {
  if (!query || from >= to) return -1;
  const iterator = doc.iterRange(from, to);
  const overlap = Math.max(0, query.length - 1);
  let carry = "";
  let consumed = from;
  for (;;) {
    iterator.next();
    if (iterator.done) return -1;
    const chunk = iterator.value;
    const combined = carry + chunk;
    const index = combined.indexOf(query);
    if (index >= 0) return consumed - carry.length + index;
    consumed += chunk.length;
    carry = overlap > 0 ? combined.slice(-overlap) : "";
  }
}

/** Add RANGE to the selection as the new main range, keeping document order. */
function addOccurrenceRange(view: EditorView, added: SelectionRange): boolean {
  const kept = view.state.selection.ranges.filter((range) => (
    !range.empty && !(range.from === added.from && range.to === added.to)
  ));
  const ranges = [...kept, added].sort((a, b) => a.from - b.from || a.to - b.to);
  const mainIndex = ranges.findIndex((range) => range.from === added.from && range.to === added.to);
  view.dispatch({
    selection: EditorSelection.create(ranges, Math.max(0, mainIndex)),
    scrollIntoView: true,
  });
  return true;
}

export function selectNextMarkdownOccurrence(view: EditorView): boolean {
  const state = view.state;
  const main = state.selection.main;

  // A bare caret selects the word under it and stops there, the way VSCode and
  // Sublime do. This used to jump straight to the next match in the same press,
  // which both skipped a step and left the command doing nothing at all on a
  // word that occurs only once — the search failed, so nothing was selected.
  if (main.empty) {
    const word = wordRangeAt(state, main.from);
    if (!word) return false;
    return addOccurrenceRange(view, EditorSelection.range(word.from, word.to));
  }

  const query = state.doc.sliceString(main.from, main.to);
  if (!query) return false;
  let from = findMarkdownText(state.doc, query, main.to);
  if (from < 0) {
    from = findMarkdownText(state.doc, query, 0, Math.max(0, main.from));
    if (from < 0) return false;
  }
  return addOccurrenceRange(view, EditorSelection.range(from, from + query.length));
}
