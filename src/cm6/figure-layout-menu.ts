import type { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import type { Text } from "@codemirror/state";
import { imageLayoutFromAttrs, imageLayoutToAttrMap, type ImageLayoutAttrs } from "../image-attrs.ts";
import { LAYOUT_ATTR_KEYS, readLayoutAttrSuffix, readLayoutAttrsLine, readLayoutTrailingAttrs } from "../layout-attrs.ts";
import type { NoemaMenuItem } from "../menu-system.ts";

type FigureKind = "image" | "tikz" | "table" | "diagram";

export type FigureLayoutTarget = {
  kind: FigureKind;
  from: number;
  to: number;
  baseTo: number;
  layout: ImageLayoutAttrs;
  document: Text;
};

const FIGURE_SELECTOR = ".cm-image-widget, .cm-table-editable-block, .cm-mermaid-widget:not(.cm-mermaid-widget-preview)";
const LAYOUT_KEYS = new Set(LAYOUT_ATTR_KEYS);

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

/** Read only the widget's own source span, never the whole document. */
export function figureLayoutTarget(view: EditorView, node: EventTarget | null): FigureLayoutTarget | null {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const widget = element?.closest<HTMLElement>(FIGURE_SELECTOR);
  if (!widget || !view.dom.contains(widget)) return null;
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
  view.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: "input.layout", scrollIntoView: false });
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
  view.dispatch({
    changes: { from: left.from, to: right.to, insert: rightSource + gap + leftSource },
    annotations: isolateHistory.of("full"),
    userEvent: "move.layout",
    scrollIntoView: false,
  });
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
      ...["25%", "50%", "75%", "100%"].map((width) => ({ label: width, checked: target.layout.width === width, run: apply({ width, height: "" }) })),
      { label: "Auto", checked: !target.layout.width, run: apply({ width: "", height: "" }) },
    ] },
    { label: "Reset Layout", disabled, run: apply({ align: "center", wrap: false, width: "", height: "" }) },
  ];
}

/** The same source-backed layout controls for every block figure. */
export function figureLayoutToolbar(view: EditorView, widget: HTMLElement, current: ImageLayoutAttrs): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cm-figure-layout-toolbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Figure layout");
  bar.addEventListener("mousedown", (event) => event.stopPropagation());
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
      event.stopPropagation();
      const target = figureLayoutTarget(view, widget);
      if (target) applyFigureLayout(view, target, patch);
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
    ...["25%", "50%", "75%", "100%"].map((width) => button(width, `Width ${width}`, current?.width === width, { width, height: "" })),
    button("Auto", "Reset width", !current?.width, { width: "", height: "" }),
    sep(),
  );
  const pair = document.createElement("button");
  pair.type = "button";
  pair.className = "cm-image-tool-button";
  pair.textContent = "↔";
  pair.title = "Place beside next figure";
  pair.setAttribute("aria-label", pair.title);
  pair.addEventListener("click", (event) => { event.stopPropagation(); arrangeWithNextFigure(view, widget); });
  bar.append(pair, figureMoveGrip(view, widget));
  return bar;
}

/** One width gesture for tables, TikZ and diagrams, using their existing attrs. */
export function figureResizeHandle(view: EditorView, widget: HTMLElement, kind: "table" | "tikz" | "diagram", surface: HTMLElement = widget): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cm-figure-resize-handle";
  handle.title = `Drag to resize ${kind}; arrow keys adjust width`;
  handle.setAttribute("aria-label", handle.title);
  const cssKind = kind === "tikz" ? "image" : kind;
  const widthVar = `--aaronnote-${cssKind}-width`;
  const maxVar = `--aaronnote-${cssKind}-max-width`;
  const resize = (delta: number, target: FigureLayoutTarget, startWidth: number, oldWidth: string, oldMax: string): boolean => {
    const maxWidth = Math.max(96, view.contentDOM.clientWidth || surface.parentElement?.clientWidth || 960);
    const direction = target.layout.align === "right" ? -1 : target.layout.align === "center" && !target.layout.wrap ? 2 : 1;
    const next = Math.max(96, Math.min(maxWidth, Math.round(startWidth + delta * direction)));
    const changed = applyFigureLayout(view, target, { width: `${next}px`, height: "" });
    if (!changed) {
      if (oldWidth) surface.style.setProperty(widthVar, oldWidth); else surface.style.removeProperty(widthVar);
      if (oldMax) surface.style.setProperty(maxVar, oldMax); else surface.style.removeProperty(maxVar);
    }
    return changed;
  };
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
    const startWidth = surface.getBoundingClientRect().width || Number.parseFloat(target.layout.width) || 320;
    resize(event.key === "ArrowRight" ? 16 : -16, target, startWidth,
      surface.style.getPropertyValue(widthVar), surface.style.getPropertyValue(maxVar));
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = surface.getBoundingClientRect().width || Number.parseFloat(target.layout.width) || 320;
    const oldWidth = surface.style.getPropertyValue(widthVar);
    const oldMax = surface.style.getPropertyValue(maxVar);
    const direction = target.layout.align === "right" ? -1 : target.layout.align === "center" && !target.layout.wrap ? 2 : 1;
    const maxWidth = Math.max(96, view.contentDOM.clientWidth || surface.parentElement?.clientWidth || 960);
    let pendingWidth = Math.round(startWidth);
    let frame = 0;
    handle.classList.add("is-resizing");
    widget.classList.add("is-resizing");
    handle.setPointerCapture?.(event.pointerId);
    const cleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.classList.remove("is-resizing");
      widget.classList.remove("is-resizing");
    };
    const restore = () => {
      if (oldWidth) surface.style.setProperty(widthVar, oldWidth); else surface.style.removeProperty(widthVar);
      if (oldMax) surface.style.setProperty(maxVar, oldMax); else surface.style.removeProperty(maxVar);
      view.requestMeasure();
    };
    const move = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pendingWidth = Math.max(96, Math.min(maxWidth, Math.round(startWidth + (pointer.clientX - startX) * direction)));
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!widget.isConnected) return;
        surface.style.setProperty(widthVar, `${pendingWidth}px`);
        surface.style.setProperty(maxVar, "none");
        view.requestMeasure();
      });
    };
    const finish = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pointer.stopPropagation();
      cleanup();
      if (!applyFigureLayout(view, target, { width: `${pendingWidth}px`, height: "" })) restore();
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

/** Bottom-edge height control. It writes the same attrs for every figure kind. */
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
  const heightVar = `--aaronnote-${cssKind}-height`;
  const change = (target: FigureLayoutTarget, delta: number, initial: number): boolean =>
    applyFigureLayout(view, target, { height: `${Math.max(80, Math.min(1200, Math.round(initial + delta)))}px` });
  const heightOf = (target: FigureLayoutTarget): number =>
    Number.parseFloat(target.layout.height) ||
    surface.querySelector<HTMLElement>("img, video, svg, table, .cm-mermaid-block")?.getBoundingClientRect().height ||
    surface.getBoundingClientRect().height || 220;
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || view.state.readOnly) return;
    const target = figureLayoutTarget(view, widget);
    if (!target) return;
    event.preventDefault();
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
    let pending = Math.round(initial);
    let frame = 0;
    handle.classList.add("is-resizing");
    handle.setPointerCapture?.(event.pointerId);
    const restore = () => {
      if (previous) surface.style.setProperty(heightVar, previous);
      else surface.style.removeProperty(heightVar);
      view.requestMeasure();
    };
    const cleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.classList.remove("is-resizing");
    };
    const move = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pending = Math.max(80, Math.min(1200, Math.round(initial + pointer.clientY - startY)));
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!widget.isConnected) return;
        surface.style.setProperty(heightVar, `${pending}px`);
        view.requestMeasure();
      });
    };
    const finish = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pointer.stopPropagation();
      cleanup();
      if (!change(target, pending - initial, initial)) restore();
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
