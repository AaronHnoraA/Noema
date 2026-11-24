/**
 * Unified responsive figure layout, positioning, wrap, and sizing engine.
 *
 * Single source of truth for all visual figures (`image`, `tikz`, `table`,
 * `diagram`) in CM6: target discovery, stale-doc transactional source writes,
 * context menu items, floating toolbar, responsive `%` width resize handle,
 * fixed-viewport height handle, adjacent pairing, and drag-to-reorder grip.
 */

import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { dispatchConstructEdit } from "./extensions/visual/constructs/index.ts";
import { imageLayoutFromAttrs, imageLayoutToAttrMap, type ImageLayoutAttrs } from "../image-attrs.ts";
import { LAYOUT_ATTR_KEYS, readLayoutAttrSuffix, readLayoutAttrsLine, readLayoutTrailingAttrs } from "../layout-attrs.ts";
import type { NoemaMenuItem } from "../menu-system.ts";
import { findTableAtPos } from "./table-source-cells.ts";
import { getBlockMathRanges } from "./math-ranges.ts";
import { getFencedCodeRanges } from "./code-ranges.ts";

export type FigureKind = "image" | "tikz" | "table" | "diagram";

export type FigureCapabilities = {
  readonly minWidthPct: number;
  /** Whether width changes clear stale height so aspect-ratio artwork never distorts. */
  readonly preservesAspect: boolean;
  /** Whether a bottom-edge height drag handle makes sense (fixed-viewport figures only). */
  readonly hasHeightHandle: boolean;
};

export type FigureLayoutTarget = {
  kind: FigureKind;
  from: number;
  to: number;
  baseTo: number;
  layout: ImageLayoutAttrs;
  document: Text;
};

export type FigureToolbarOptions = {
  /** Extra CSS classes added alongside `cm-figure-layout-toolbar`. */
  extraClass?: string;
  /** Whether to clear height when selecting a width preset (defaults to figure capability). */
  preservesAspect?: boolean;
  /** Whether to include the whole-figure drag/Alt+Up/Down move grip (default true). */
  includeMoveGrip?: boolean;
  /** Override the `↔` pair action (e.g. native image-row join before float pairing). */
  onArrangeNext?: () => void;
  /** Tooltip / aria-label for the `↔` pair button. */
  arrangeTitle?: string;
  /** Additional buttons appended at the end (e.g. HTML embed fullscreen button). */
  extraButtons?: readonly HTMLElement[];
  /** Called after an action commits (e.g. to close a popover). */
  onApplied?: () => void;
};

export type FigureResizeOptions = {
  /** Extra CSS class added alongside `cm-figure-resize-handle`. */
  extraClass?: string;
  /** Whether the figure sits inside a horizontal Flex image row. */
  isRowItem?: boolean;
  /** Whether width changes clear stale height (defaults to figure capability). */
  preservesAspect?: boolean;
  /** Optional hook to mirror live `%` width onto sibling DOM (e.g. editing table rows). */
  onPreviewWidth?: (widthCss: string | null) => void;
};

const FIGURE_SELECTOR = ".cm-image-widget, .cm-table-editable-block, .cm-mermaid-widget:not(.cm-mermaid-widget-preview)";
const LAYOUT_KEYS = new Set(LAYOUT_ATTR_KEYS);
const SNAP_WIDTH_PCTS = [25, 33, 50, 67, 75, 100] as const;
const WIDTH_PRESETS = ["25%", "50%", "75%", "100%"] as const;
const MENU_WIDTH_PRESETS = ["25%", "33%", "50%", "67%", "75%", "100%"] as const;

export function figureCapabilities(kind: FigureKind, options: { fixedViewport?: boolean } = {}): FigureCapabilities {
  if (kind === "table") return { minWidthPct: 30, preservesAspect: false, hasHeightHandle: false };
  if (kind === "diagram") return { minWidthPct: 25, preservesAspect: false, hasHeightHandle: true };
  if (kind === "tikz") return { minWidthPct: 15, preservesAspect: true, hasHeightHandle: false };
  if (options.fixedViewport) return { minWidthPct: 25, preservesAspect: false, hasHeightHandle: true };
  return { minWidthPct: 15, preservesAspect: true, hasHeightHandle: false };
}

/** Measure the effective inner prose measure width (excluding `.cm-content` horizontal padding). */
export function measureFigureContainerWidth(view: EditorView, surface: HTMLElement): number {
  const content = view.contentDOM;
  const contentWidth = content.clientWidth;
  if (contentWidth > 0) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(content) : null;
    const padL = style ? Number.parseFloat(style.paddingLeft) || 0 : 0;
    const padR = style ? Number.parseFloat(style.paddingRight) || 0 : 0;
    const inner = contentWidth - padL - padR;
    if (inner >= 120) return inner;
    return contentWidth;
  }
  const parentWidth = surface.parentElement?.clientWidth ?? 0;
  if (parentWidth >= 120) return parentWidth;
  return 720;
}

/** Convert a pixel width against CONTAINER_PX into a clamped responsive integer percentage. */
export function pxToResponsivePercent(
  targetPx: number,
  containerPx: number,
  minPct: number,
  snap = false,
): number {
  const denom = Math.max(120, containerPx);
  const raw = Math.max(minPct, Math.min(100, (targetPx / denom) * 100));
  if (snap) {
    for (const preset of SNAP_WIDTH_PCTS) {
      if (preset >= minPct && Math.abs(raw - preset) <= 1.5) return preset;
    }
  }
  return Math.max(minPct, Math.min(100, Math.round(raw)));
}

/** Step a figure's width by `deltaPct` (e.g. ±5%) for keyboard accessibility. */
export function stepResponsivePercent(
  currentWidthAttr: string,
  measuredPx: number,
  containerPx: number,
  deltaPct: number,
  minPct: number,
): number {
  let base: number;
  if (currentWidthAttr.endsWith("%")) {
    const parsed = Number.parseFloat(currentWidthAttr);
    base = Number.isFinite(parsed) ? parsed : 100;
  } else if (measuredPx > 0) {
    base = (measuredPx / Math.max(120, containerPx)) * 100;
  } else if (currentWidthAttr) {
    const parsedPx = Number.parseFloat(currentWidthAttr);
    base = Number.isFinite(parsedPx) ? (parsedPx / Math.max(120, containerPx)) * 100 : 50;
  } else {
    base = 100;
  }
  return Math.max(minPct, Math.min(100, Math.round(base + deltaPct)));
}

export function layoutSuffix(layout: ImageLayoutAttrs, previous: Record<string, string>): string {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!LAYOUT_KEYS.has(key)) attrs[key] = value;
  }
  Object.assign(attrs, imageLayoutToAttrMap(layout));
  // Keep a recognized layout key when only unrelated attrs remain, so the
  // widget continues to consume its own attribute block after a reset.
  if (Object.keys(attrs).length && !Object.keys(attrs).some((key) => LAYOUT_KEYS.has(key))) attrs.align = "center";
  const entries = Object.entries(attrs);
  return entries.length ? `{${entries.map(([key, value]) => `${key}=${/\s/.test(value) ? JSON.stringify(value) : value}`).join(" ")}}` : "";
}

/** Resolve a table's layout target from a live-editing `.cm-table-source-row` line. */
function tableSourceRowLayoutTarget(view: EditorView, rowEl: HTMLElement): FigureLayoutTarget | null {
  let pos: number;
  try { pos = view.posAtDOM(rowEl); } catch { return null; }
  const doc = view.state.doc;
  const excluded = [...getBlockMathRanges(view.state), ...getFencedCodeRanges(view.state)];
  const found = findTableAtPos(doc, pos, excluded);
  if (!found) return null;
  const baseTo = found.sourceTo;
  const nextLine = baseTo < doc.length ? doc.line(doc.lineAt(baseTo).number + 1) : null;
  const parsed = nextLine ? readLayoutAttrsLine(nextLine.text) : null;
  const to = parsed && nextLine ? nextLine.to : baseTo;
  return {
    kind: "table",
    from: found.from,
    to,
    baseTo,
    layout: imageLayoutFromAttrs(parsed?.attrs ?? {}),
    document: doc,
  };
}

/** Read only the widget's own source span, never the whole document. */
export function figureLayoutTarget(view: EditorView, node: EventTarget | null): FigureLayoutTarget | null {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!element || !view.dom.contains(element)) return null;
  const widget = element.closest<HTMLElement>(FIGURE_SELECTOR);
  if (!widget || !view.dom.contains(widget)) {
    const sourceRow = element.closest<HTMLElement>(".cm-table-source-row");
    return sourceRow && view.dom.contains(sourceRow) ? tableSourceRowLayoutTarget(view, sourceRow) : null;
  }
  const from = Number(widget.dataset.cmSourceFrom);
  const to = Number(widget.dataset.cmSourceTo);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > view.state.doc.length) return null;
  const doc = view.state.doc;
  let kind: FigureKind;
  let baseTo: number;
  let attrs: Record<string, string> = {};
  if (widget.classList.contains("cm-tikz-env-widget")) {
    kind = "tikz";
    const line = doc.lineAt(from);
    if (line.from !== from || !/^\s*#\+\s*begin\s+tikz\b/i.test(line.text)) return null;
    baseTo = line.to;
    const brace = line.text.indexOf("{");
    const parsed = brace >= 0 ? readLayoutAttrSuffix(line.text, brace) : null;
    if (parsed) attrs = parsed.attrs;
  } else if (widget.classList.contains("cm-table-editable-block")) {
    kind = "table";
    baseTo = Number(widget.dataset.cmSourceBaseTo);
    if (!Number.isSafeInteger(baseTo) || baseTo < from || baseTo > to || !doc.lineAt(from).text.includes("|")) return null;
    const next = baseTo < doc.length ? doc.line(doc.lineAt(baseTo).number + 1) : null;
    attrs = next && next.to === to ? readLayoutAttrsLine(next.text)?.attrs ?? {} : {};
  } else if (widget.classList.contains("cm-mermaid-widget")) {
    kind = "diagram";
    if (!/^\s*(?:`{3,}|~{3,})\s*(?:mermaid|mindmap|marmind|markmind)\b/i.test(doc.lineAt(from).text)) return null;
    const last = doc.lineAt(to);
    const parsed = last.to === to ? readLayoutAttrsLine(last.text) : null;
    baseTo = parsed && last.number > doc.lineAt(from).number ? doc.line(last.number - 1).to : to;
    attrs = parsed && baseTo < to ? parsed.attrs : {};
  } else {
    kind = "image";
    baseTo = Number(widget.dataset.cmSourceBaseTo);
    if (!Number.isSafeInteger(baseTo) || baseTo <= from || baseTo > to || !/^(?:!\[|\[\]\()/.test(doc.sliceString(from, Math.min(baseTo, from + 3)))) return null;
    const parsed = readLayoutTrailingAttrs(doc.sliceString(baseTo, to), 0);
    if (parsed) attrs = parsed.attrs;
  }
  return { kind, from, to, baseTo, layout: imageLayoutFromAttrs(attrs), document: doc };
}

type LayoutEdit = { target: FigureLayoutTarget; patch: Partial<ImageLayoutAttrs> };
type SourceChange = { from: number; to: number; insert: string };

/** Plan a source change without touching the editor. All figure kinds use the
 * same stale-document guard and one transaction, including grouped gestures. */
function planFigureLayout(doc: Text, target: FigureLayoutTarget, patch: Partial<ImageLayoutAttrs>): SourceChange | null {
  if (target.document !== doc || target.to > doc.length) return null;
  const next = { ...target.layout, ...patch };
  if (target.kind === "tikz") {
    const line = doc.lineAt(target.from);
    if (line.to !== target.baseTo || !/^\s*#\+\s*begin\s+tikz\b/i.test(line.text)) return null;
    const brace = line.text.indexOf("{");
    const old = brace >= 0 ? readLayoutAttrSuffix(line.text, brace) : null;
    const previous = old?.attrs ?? {};
    const head = old ? line.text.slice(0, old.from).trimEnd() : line.text.trimEnd();
    const suffix = layoutSuffix(next, previous);
    const insert = head + (suffix ? ` ${suffix}` : "");
    return { from: line.from, to: line.to, insert };
  } else if (target.kind === "image") {
    if (target.baseTo > target.to || !/^(?:!\[|\[\]\()/.test(doc.sliceString(target.from, Math.min(target.baseTo, target.from + 3)))) return null;
    const old = readLayoutTrailingAttrs(doc.sliceString(target.baseTo, target.to), 0);
    const insert = layoutSuffix(next, old?.attrs ?? {});
    return { from: target.baseTo, to: target.to, insert };
  } else {
    if (target.baseTo > target.to || doc.lineAt(target.baseTo).to !== target.baseTo) return null;
    const oldLine = target.baseTo < target.to ? doc.line(doc.lineAt(target.baseTo).number + 1) : null;
    const old = oldLine && oldLine.to === target.to ? readLayoutAttrsLine(oldLine.text) : null;
    if (target.baseTo < target.to && !old) return null;
    const suffix = layoutSuffix(next, old?.attrs ?? {});
    const from = oldLine && old ? oldLine.from : target.baseTo;
    const to = oldLine && old ? oldLine.to : target.baseTo;
    const insert = suffix ? (old ? suffix : `\n${suffix}`) : "";
    if (!suffix && old) {
      // Remove the separator newline along with the now-empty attribute line.
      return { from: target.baseTo, to, insert: "" };
    }
    return { from, to, insert };
  }
}

export function applyFigureLayouts(view: EditorView, edits: readonly LayoutEdit[]): boolean {
  if (view.state.readOnly || !edits.length) return false;
  const doc = view.state.doc;
  const changes: SourceChange[] = [];
  for (const { target, patch } of edits) {
    const change = planFigureLayout(doc, target, patch);
    if (!change) return false;
    if (doc.sliceString(change.from, change.to) !== change.insert) changes.push(change);
  }
  changes.sort((a, b) => a.from - b.from);
  if (!changes.length || changes.some((change, index) => index > 0 && change.from < changes[index - 1]!.to)) return false;
  dispatchConstructEdit(view, { changes, scrollIntoView: false }, "layout");
  view.requestMeasure();
  return true;
}

export function applyFigureLayout(view: EditorView, target: FigureLayoutTarget, patch: Partial<ImageLayoutAttrs>): boolean {
  return applyFigureLayouts(view, [{ target, patch }]);
}

/** Put adjacent, visible figures beside one another using existing wrap attrs.
 * The two source edits are atomic; prose or another block between them blocks
 * pairing. Discovery runs only on an explicit user action. */
export function arrangeWithNextFigure(view: EditorView, widget: HTMLElement): boolean {
  const first = figureLayoutTarget(view, widget);
  if (!first) return false;
  let next: FigureLayoutTarget | null = null;
  for (const element of view.dom.querySelectorAll<HTMLElement>(FIGURE_SELECTOR)) {
    if (element === widget) continue;
    const target = figureLayoutTarget(view, element);
    if (!target || target.from <= first.from || target.from < first.to) continue;
    if (!next || target.from < next.from) next = target;
  }
  if (!next || view.state.doc.lineAt(first.from).number === view.state.doc.lineAt(next.from).number ||
      view.state.doc.sliceString(first.to, next.from).trim()) return false;
  return applyFigureLayouts(view, [
    { target: first, patch: { align: "left", wrap: true, width: "48%", height: "" } },
    { target: next, patch: { align: "right", wrap: true, width: "48%", height: "" } },
  ]);
}

/** Move complete, adjacent figure sources. The gap is kept byte-for-byte, so
 * dragging never rewrites Markdown or drops a table's attribute line. */
export function swapAdjacentFigures(view: EditorView, first: FigureLayoutTarget, second: FigureLayoutTarget): boolean {
  if (view.state.readOnly || first.document !== view.state.doc || second.document !== view.state.doc) return false;
  const doc = view.state.doc;
  const [left, right] = first.from < second.from ? [first, second] : [second, first];
  if (left.from === right.from || left.to > right.from || doc.sliceString(left.to, right.from).trim()) return false;
  const wholeLine = (target: FigureLayoutTarget) =>
    doc.lineAt(target.from).from === target.from && doc.lineAt(target.to).to === target.to;
  if (!wholeLine(left) || !wholeLine(right)) return false;
  const leftSource = doc.sliceString(left.from, left.to);
  const rightSource = doc.sliceString(right.from, right.to);
  const gap = doc.sliceString(left.to, right.from);
  if (leftSource === rightSource) return false;
  dispatchConstructEdit(view, {
    changes: { from: left.from, to: right.to, insert: rightSource + gap + leftSource },
    scrollIntoView: false,
  }, "move");
  return true;
}

function adjacentFigure(view: EditorView, current: FigureLayoutTarget, direction: -1 | 1): FigureLayoutTarget | null {
  let found: FigureLayoutTarget | null = null;
  for (const element of view.dom.querySelectorAll<HTMLElement>(FIGURE_SELECTOR)) {
    const target = figureLayoutTarget(view, element);
    if (!target || target.from === current.from || direction * (target.from - current.from) <= 0) continue;
    if (!found || direction * (target.from - found.from) < 0) found = target;
  }
  if (!found) return null;
  const [left, right] = current.from < found.from ? [current, found] : [found, current];
  return view.state.doc.sliceString(left.to, right.from).trim() ? null : found;
}

const draggedFigure = new WeakMap<EditorView, FigureLayoutTarget>();

/** Keyboard and pointer grip shared by image, table, TikZ and diagram widgets. */
export function figureMoveGrip(view: EditorView, widget: HTMLElement): HTMLButtonElement {
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "cm-figure-move-grip";
  grip.textContent = "⠿";
  grip.title = "Drag to reorder figures; Alt+Up/Down moves one figure";
  grip.setAttribute("aria-label", grip.title);
  grip.draggable = true;
  grip.addEventListener("keydown", (event) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    const current = figureLayoutTarget(view, widget);
    const other = current && adjacentFigure(view, current, event.key === "ArrowUp" ? -1 : 1);
    if (!current || !other) return;
    event.preventDefault();
    event.stopPropagation();
    swapAdjacentFigures(view, current, other);
  });
  grip.addEventListener("dragstart", (event) => {
    const target = figureLayoutTarget(view, widget);
    if (!target || view.state.readOnly) { event.preventDefault(); return; }
    draggedFigure.set(view, target);
    event.dataTransfer?.setData("text/x-noema-figure", String(target.from));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  grip.addEventListener("dragend", () => draggedFigure.delete(view));
  widget.addEventListener("dragover", (event) => {
    if (!draggedFigure.has(view) || !figureLayoutTarget(view, widget)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  widget.addEventListener("drop", (event) => {
    const source = draggedFigure.get(view);
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    draggedFigure.delete(view);
    const destination = figureLayoutTarget(view, widget);
    if (destination) swapAdjacentFigures(view, source, destination);
  });
  return grip;
}

export function figureLayoutMenuItems(view: EditorView, target: FigureLayoutTarget, disabled = false): NoemaMenuItem[] {
  const caps = figureCapabilities(target.kind);
  const apply = (patch: Partial<ImageLayoutAttrs>) => () => { if (!disabled) applyFigureLayout(view, target, patch); };
  const align = target.layout.align;
  const wrap = target.layout.wrap;
  return [
    { label: "Align Left", checked: align === "left" && !wrap, disabled, run: apply({ align: "left", wrap: false }) },
    { label: "Align Center", checked: align === "center" && !wrap, disabled, run: apply({ align: "center", wrap: false }) },
    { label: "Align Right", checked: align === "right" && !wrap, disabled, run: apply({ align: "right", wrap: false }) },
    { separator: true, label: "" },
    { label: "Wrap Text Left", checked: align === "left" && wrap, disabled, run: apply({ align: "left", wrap: true }) },
    { label: "Wrap Text Right", checked: align === "right" && wrap, disabled, run: apply({ align: "right", wrap: true }) },
    { separator: true, label: "" },
    { label: "Width", detail: target.layout.width || "Auto", disabled, submenu: [
      ...MENU_WIDTH_PRESETS.map((width) => ({
        label: width,
        checked: target.layout.width === width,
        run: apply(caps.preservesAspect ? { width, height: "" } : { width }),
      })),
      { label: "Auto", checked: !target.layout.width, run: apply({ width: "", height: "" }) },
    ] },
    { label: "Reset Layout", disabled, run: apply({ align: "center", wrap: false, width: "", height: "" }) },
  ];
}

/** Shared source-backed layout controls for every figure (image, TikZ, diagram, and table popover). */
export function figureLayoutToolbar(
  view: EditorView,
  widget: HTMLElement,
  current: ImageLayoutAttrs,
  options: FigureToolbarOptions = {},
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = options.extraClass
    ? `cm-figure-layout-toolbar ${options.extraClass}`
    : "cm-figure-layout-toolbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Figure layout");
  bar.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const clearHeightOnWidth = options.preservesAspect ?? true;

  const button = (label: string, title: string, selected: boolean, patch: Partial<ImageLayoutAttrs>) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "cm-image-tool-button";
    el.textContent = label;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.setAttribute("aria-pressed", String(selected));
    if (selected) el.classList.add("is-active");
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = figureLayoutTarget(view, widget);
      if (target) {
        applyFigureLayout(view, target, patch);
        options.onApplied?.();
      }
    });
    return el;
  };

  const sep = () => {
    const el = document.createElement("span");
    el.className = "cm-image-tool-sep";
    el.setAttribute("aria-hidden", "true");
    return el;
  };

  bar.append(
    button("L", "Align left", current?.align === "left" && !current.wrap, { align: "left", wrap: false }),
    button("C", "Align center", current?.align === "center" && !current.wrap, { align: "center", wrap: false }),
    button("R", "Align right", current?.align === "right" && !current.wrap, { align: "right", wrap: false }),
    sep(),
    button("◧", "Wrap text left", current?.align === "left" && !!current.wrap, { align: "left", wrap: true }),
    button("◨", "Wrap text right", current?.align === "right" && !!current.wrap, { align: "right", wrap: true }),
    sep(),
    ...WIDTH_PRESETS.map((width) => button(
      width,
      `Width ${width}`,
      current?.width === width,
      clearHeightOnWidth ? { width, height: "" } : { width },
    )),
    button("Auto", "Reset width", !current?.width, { width: "", height: "" }),
    sep(),
  );

  const pair = document.createElement("button");
  pair.type = "button";
  pair.className = "cm-image-tool-button";
  pair.textContent = "↔";
  pair.title = options.arrangeTitle ?? "Place beside next figure";
  pair.setAttribute("aria-label", pair.title);
  pair.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (options.onArrangeNext) options.onArrangeNext();
    else arrangeWithNextFigure(view, widget);
    options.onApplied?.();
  });
  bar.append(pair);

  if (options.includeMoveGrip !== false) {
    bar.append(figureMoveGrip(view, widget));
  }
  if (options.extraButtons?.length) {
    bar.append(sep(), ...options.extraButtons);
  }
  return bar;
}

/** Create or update the live numeric feedback pill on a resize handle during active drag. */
function setResizeBadge(handle: HTMLElement, text: string | null): void {
  let badge = handle.querySelector<HTMLElement>(".cm-figure-resize-badge");
  if (text === null) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "cm-figure-resize-badge";
    badge.setAttribute("aria-hidden", "true");
    handle.append(badge);
  }
  badge.textContent = text;
}

/**
 * One unified responsive `%` width resize gesture for ALL figures
 * (`image`, `tikz`, `table`, `diagram`).
 *
 * Writes relative percentage widths (`{width=62%}`) so notes adapt cleanly
 * across desktop, split Emacs xwidget panes, mobile readers, and LaTeX export.
 */
export function figureResizeHandle(
  view: EditorView,
  widget: HTMLElement,
  kind: FigureKind,
  surface: HTMLElement = widget,
  options: FigureResizeOptions = {},
): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = options.extraClass
    ? `cm-figure-resize-handle ${options.extraClass}`
    : "cm-figure-resize-handle";
  handle.title = `Drag to resize ${kind} width (%); arrow keys adjust by 5%`;
  handle.setAttribute("aria-label", handle.title);

  const caps = figureCapabilities(kind);
  const cssKind = kind === "tikz" ? "image" : kind;
  const widthVar = `--noema-${cssKind}-width`;
  const blockWidthVar = "--noema-block-layout-width";
  const maxVar = `--noema-${cssKind}-max-width`;
  const clearHeight = options.preservesAspect ?? caps.preservesAspect;

  const commitPercent = (target: FigureLayoutTarget, pct: number): boolean => {
    const patch: Partial<ImageLayoutAttrs> = clearHeight
      ? { width: `${pct}%`, height: "" }
      : { width: `${pct}%` };
    return applyFigureLayout(view, target, patch);
  };

  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const containerPx = measureFigureContainerWidth(view, surface);
    const measuredPx = surface.getBoundingClientRect().width;
    const step = event.key === "ArrowRight" ? 5 : -5;
    const nextPct = stepResponsivePercent(target.layout.width, measuredPx, containerPx, step, caps.minWidthPct);
    commitPercent(target, nextPct);
  });

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const containerPx = measureFigureContainerWidth(view, surface);
    const measuredPx = surface.getBoundingClientRect().width;
    const fallbackPx = target.layout.width.endsWith("%")
      ? (Number.parseFloat(target.layout.width) / 100) * containerPx
      : Number.parseFloat(target.layout.width) || (target.layout.wrap ? containerPx * 0.45 : containerPx * 0.5);
    const startWidth = measuredPx > 0 ? measuredPx : fallbackPx;

    const oldWidth = surface.style.getPropertyValue(widthVar);
    const oldBlockWidth = surface.style.getPropertyValue(blockWidthVar);
    const oldMax = surface.style.getPropertyValue(maxVar);
    const hadWidthClass = surface.classList.contains("noema-layout-has-width");
    const rowItem = options.isRowItem ?? surface.classList.contains("cm-image-row-item");
    const oldRowWeight = surface.style.getPropertyValue("--cm-image-row-weight");

    const direction = target.layout.align === "right" ? -1 : target.layout.align === "center" && !target.layout.wrap ? 2 : 1;
    let pendingPct = pxToResponsivePercent(startWidth, containerPx, caps.minWidthPct, false);
    let moved = false;
    let frame = 0;

    handle.classList.add("is-resizing");
    widget.classList.add("is-resizing");
    handle.setPointerCapture?.(event.pointerId);

    const cleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.classList.remove("is-resizing");
      widget.classList.remove("is-resizing");
      setResizeBadge(handle, null);
    };

    const restore = () => {
      if (oldWidth) surface.style.setProperty(widthVar, oldWidth); else surface.style.removeProperty(widthVar);
      if (oldBlockWidth) surface.style.setProperty(blockWidthVar, oldBlockWidth); else surface.style.removeProperty(blockWidthVar);
      if (oldMax) surface.style.setProperty(maxVar, oldMax); else surface.style.removeProperty(maxVar);
      if (!hadWidthClass) surface.classList.remove("noema-layout-has-width");
      if (rowItem) {
        if (oldRowWeight) surface.style.setProperty("--cm-image-row-weight", oldRowWeight);
        else surface.style.removeProperty("--cm-image-row-weight");
      }
      options.onPreviewWidth?.(null);
      view.requestMeasure();
    };

    const move = (pointer: PointerEvent) => {
      pointer.preventDefault();
      moved = true;
      const targetPx = startWidth + (pointer.clientX - startX) * direction;
      pendingPct = pxToResponsivePercent(targetPx, containerPx, caps.minWidthPct, true);
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!widget.isConnected) return;
        const pctCss = `${pendingPct}%`;
        surface.style.setProperty(widthVar, pctCss);
        surface.style.setProperty(blockWidthVar, pctCss);
        surface.style.setProperty(maxVar, "none");
        surface.classList.add("noema-layout-has-width");
        if (rowItem) {
          surface.style.setProperty("--cm-image-row-weight", String(Math.max(0.25, Math.min(4, (pendingPct / 100) * 2))));
        }
        options.onPreviewWidth?.(pctCss);
        setResizeBadge(handle, pctCss);
        view.requestMeasure();
      });
    };

    const finish = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pointer.stopPropagation();
      cleanup();
      if (!moved || !commitPercent(target, pendingPct)) restore();
    };

    const cancel = () => {
      cleanup();
      restore();
    };

    const escape = (key: KeyboardEvent) => {
      if (key.key === "Escape") {
        key.preventDefault();
        cancel();
      }
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  });

  return handle;
}

/**
 * Bottom-edge height control for fixed-viewport figures (`diagram` and HTML/PDF
 * `iframe` embeds). Aspect-ratio artwork and text-flow tables omit it so users
 * never distort ratios or collide with table edge strips.
 */
export function figureHeightHandle(
  view: EditorView,
  widget: HTMLElement,
  kind: FigureKind,
  surface: HTMLElement = widget,
): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cm-figure-height-handle";
  handle.title = `Drag to change ${kind} height; arrow keys adjust height`;
  handle.setAttribute("aria-label", handle.title);

  const cssKind = kind === "tikz" ? "image" : kind;
  const heightVar = `--noema-${cssKind}-height`;
  const blockHeightVar = "--noema-block-layout-height";

  const change = (target: FigureLayoutTarget, delta: number, initial: number): boolean =>
    applyFigureLayout(view, target, { height: `${Math.max(80, Math.min(1200, Math.round(initial + delta)))}px` });

  const heightOf = (target: FigureLayoutTarget): number =>
    Number.parseFloat(target.layout.height) ||
    surface.querySelector<HTMLElement>("iframe, .cm-mermaid-block, svg, img, video")?.getBoundingClientRect().height ||
    surface.getBoundingClientRect().height || 240;

  handle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    change(target, event.key === "ArrowDown" ? 16 : -16, heightOf(target));
  });

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const initial = heightOf(target);
    const previous = surface.style.getPropertyValue(heightVar);
    const previousBlock = surface.style.getPropertyValue(blockHeightVar);
    let pending = Math.round(initial);
    let moved = false;
    let frame = 0;

    handle.classList.add("is-resizing");
    handle.setPointerCapture?.(event.pointerId);

    const restore = () => {
      if (previous) surface.style.setProperty(heightVar, previous);
      else surface.style.removeProperty(heightVar);
      if (previousBlock) surface.style.setProperty(blockHeightVar, previousBlock);
      else surface.style.removeProperty(blockHeightVar);
      view.requestMeasure();
    };

    const cleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.classList.remove("is-resizing");
      setResizeBadge(handle, null);
    };

    const move = (pointer: PointerEvent) => {
      pointer.preventDefault();
      moved = true;
      pending = Math.max(80, Math.min(1200, Math.round(initial + pointer.clientY - startY)));
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!widget.isConnected) return;
        const pxCss = `${pending}px`;
        surface.style.setProperty(heightVar, pxCss);
        surface.style.setProperty(blockHeightVar, pxCss);
        setResizeBadge(handle, pxCss);
        view.requestMeasure();
      });
    };

    const finish = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pointer.stopPropagation();
      cleanup();
      if (!moved || !change(target, pending - initial, initial)) restore();
    };

    const cancel = () => { cleanup(); restore(); };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); cancel(); } };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  });

  return handle;
}
