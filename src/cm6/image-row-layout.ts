/** Adjacent Markdown images share a row without adding a storage syntax. */
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { dropTarget, resizePair, weightsFromWidths, type ItemBox, type RowBox } from "../../vendor/adjustable-media-pure/geometry.ts";
import { readImageTrailingAttrs, type ImageLayoutAttrs } from "../image-attrs.ts";
import { applyFigureLayouts, figureLayoutTarget } from "./figure-layout-menu.ts";

interface ImageSpan { from: number; to: number }
interface ImageRow { from: number; to: number; source: string; images: ImageSpan[] }

const rowCache = new WeakMap<Text, Map<number, ImageRow | null>>();

function imageSpansOnLine(state: EditorState, from: number, to: number): ImageSpan[] {
  const images: ImageSpan[] = [];
  syntaxTree(state).iterate({ from, to, enter(node) {
    if (node.name !== "Image") return;
    const trailing = readImageTrailingAttrs(state.doc.sliceString(node.to, to), 0);
    images.push({ from: node.from, to: node.to + (trailing?.to ?? 0) });
    return false;
  } });
  images.sort((a, b) => a.from - b.from);
  return images;
}

function onlyImagesOnLine(state: EditorState, from: number, to: number, images: ImageSpan[]): boolean {
  let cursor = from;
  return images.every((image) => {
    const gap = state.doc.sliceString(cursor, image.from);
    cursor = image.to;
    return !gap.trim() && image.to <= to;
  }) && !state.doc.sliceString(cursor, to).trim();
}

/** Lezer owns image recognition; the native image spans may have existing `{...}` attrs. */
export function imageRowAt(state: EditorState, at: number): ImageRow | null {
  const line = state.doc.lineAt(at);
  let cache = rowCache.get(state.doc);
  if (!cache) { cache = new Map(); rowCache.set(state.doc, cache); }
  if (cache.has(line.from)) return cache.get(line.from) ?? null;
  const images = imageSpansOnLine(state, line.from, line.to);
  const valid = images.length >= 2 && onlyImagesOnLine(state, line.from, line.to, images);
  const row = valid ? { from: line.from, to: line.to, source: line.text, images } : null;
  // An incomplete incremental Lezer tree may acquire the second image later
  // without changing Text identity, so do not memoize a negative parse.
  if (row) cache.set(line.from, row);
  return row;
}

/** Join adjacent native media lines, keeping each embed and attr block verbatim. */
export function joinNextImage(view: EditorView, at: number, write = true): boolean {
  const state = view.state;
  if (state.readOnly) return false;
  const first = state.doc.lineAt(at);
  const firstImages = imageSpansOnLine(state, first.from, first.to);
  if (firstImages.length < 1 || firstImages.length >= 4 ||
      !firstImages.some((image) => at >= image.from && at <= image.to) ||
      !onlyImagesOnLine(state, first.from, first.to, firstImages)) return false;
  let nextNumber = first.number + 1;
  if (nextNumber > state.doc.lines) return false;
  let next = state.doc.line(nextNumber);
  if (!next.text.trim() && nextNumber < state.doc.lines) next = state.doc.line(++nextNumber);
  const nextImages = imageSpansOnLine(state, next.from, next.to);
  if (nextImages.length !== 1 || !onlyImagesOnLine(state, next.from, next.to, nextImages)) return false;
  if (!write) return true;
  const insert = `${first.text.trimEnd()} ${next.text.trimStart()}`;
  view.dispatch({ changes: { from: first.from, to: next.to, insert },
    annotations: isolateHistory.of("full"), userEvent: "input.layout", scrollIntoView: false });
  return true;
}

function moveImage(view: EditorView, row: ImageRow, sourceIndex: number, targetIndex: number, newLine: boolean): boolean {
  if (view.state.readOnly || view.state.doc.sliceString(row.from, row.to) !== row.source) return false;
  const chunks = row.images.map((image) => view.state.doc.sliceString(image.from, image.to));
  const leading = view.state.doc.sliceString(row.from, row.images[0]!.from);
  const trailing = view.state.doc.sliceString(row.images.at(-1)!.to, row.to);
  const [moved] = chunks.splice(sourceIndex, 1);
  if (!moved) return false;
  let next: string;
  if (newLine) next = targetIndex === 0
    ? `${leading}${moved}\n${leading}${chunks.join(" ")}${trailing}`
    : `${leading}${chunks.join(" ")}\n${leading}${moved}${trailing}`;
  else { chunks.splice(targetIndex, 0, moved); next = leading + chunks.join(" ") + trailing; }
  if (next === row.source) return false;
  view.dispatch({ changes: { from: row.from, to: row.to, insert: next },
    annotations: isolateHistory.of("full"), userEvent: "input.layout", scrollIntoView: false });
  return true;
}

/** Weight follows explicit width or intrinsic aspect ratio, as in Adjustable Media. */
const pendingImageLoads = new WeakSet<HTMLImageElement>();

export function sizeImageRowItem(figure: HTMLElement, image: HTMLImageElement | null, layout: ImageLayoutAttrs): void {
  const explicit = Number.parseFloat(layout.width);
  const width = Number.isFinite(explicit) && explicit > 0
    ? layout.width.endsWith("%") ? explicit / 100 : explicit / 220
    : image?.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1;
  figure.style.setProperty("--cm-image-row-weight", String(Math.max(0.25, Math.min(4, width))));
  if (image && !image.complete && !pendingImageLoads.has(image)) {
    pendingImageLoads.add(image);
    image.addEventListener("load", () => sizeImageRowItem(figure, image, layout), { once: true });
  }
}

/** A dedicated grip keeps image viewing and video playback separate from dragging. */
export function imageRowGrip(view: EditorView, figure: HTMLElement): HTMLButtonElement | null {
  const initial = imageRowAt(view.state, Number(figure.dataset.cmSourceFrom));
  if (!initial || view.state.readOnly) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-image-row-grip";
  button.textContent = "⋮⋮";
  button.title = "Move image within row (Alt+←/→)";
  button.setAttribute("aria-label", button.title);
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  const current = (): { row: ImageRow; index: number } | null => {
    const from = Number(figure.dataset.cmSourceFrom);
    const row = imageRowAt(view.state, from);
    const index = row?.images.findIndex((span) => span.from === from) ?? -1;
    return row && index >= 0 ? { row, index } : null;
  };
  button.addEventListener("keydown", (event) => {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const active = current();
    if (!active) return;
    const target = active.index + (event.key === "ArrowLeft" ? -1 : 1);
    if (target >= 0 && target < active.row.images.length) moveImage(view, active.row, active.index, target, false);
  });
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.state.readOnly) return;
    const active = current();
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    const snapshot = view.state.doc;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    button.setPointerCapture?.(event.pointerId);
    const cleanup = () => {
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", finish);
      button.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      button.classList.remove("is-dragging");
    };
    const move = (pointer: PointerEvent) => {
      if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
      dragging = true;
      button.classList.add("is-dragging");
      pointer.preventDefault();
    };
    const finish = (pointer: PointerEvent) => {
      cleanup();
      if (!dragging || view.state.doc !== snapshot) return;
      pointer.preventDefault();
      const line = figure.parentElement;
      if (!line) return;
      const figures = [...line.children].filter((node): node is HTMLElement =>
        node instanceof HTMLElement && node.classList.contains("cm-image-widget"));
      const rows: RowBox[] = [{ row: 0, rect: line.getBoundingClientRect() }];
      const items: ItemBox[] = figures.map((item, index) => ({ row: 0, index, rect: item.getBoundingClientRect() }));
      const target = dropTarget(pointer.clientX, pointer.clientY, rows, items);
      if (!target) return;
      if (target.kind === "newRow") moveImage(view, active.row, active.index, target.beforeRow, true);
      else {
        const at = target.position.index + (target.side === "after" ? 1 : 0);
        moveImage(view, active.row, active.index, Math.max(0, Math.min(figures.length - 1, at > active.index ? at - 1 : at)), false);
      }
    };
    const cancel = () => cleanup();
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); cancel(); } };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  });
  return button;
}

/** Splitter writes all item ratios through one CM6 transaction. */
export function imageRowSplitHandle(view: EditorView, figure: HTMLElement): HTMLButtonElement | null {
  const row = imageRowAt(view.state, Number(figure.dataset.cmSourceFrom));
  const index = row?.images.findIndex((span) => span.from === Number(figure.dataset.cmSourceFrom)) ?? -1;
  if (!row || index < 0 || index >= row.images.length - 1 || view.state.readOnly) return null;
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cm-image-row-split";
  handle.title = "Drag to resize adjacent images";
  handle.setAttribute("aria-label", handle.title);
  handle.addEventListener("mousedown", (event) => event.stopPropagation());
  const startGesture = (startX: number) => {
    const currentRow = imageRowAt(view.state, Number(figure.dataset.cmSourceFrom));
    const at = currentRow?.images.findIndex((span) => span.from === Number(figure.dataset.cmSourceFrom)) ?? -1;
    if (!currentRow || at < 0 || at >= currentRow.images.length - 1) return null;
    const parent = figure.parentElement;
    if (!parent) return null;
    const figures = [...parent.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node.classList.contains("cm-image-row-item"));
    const targets = figures.map((item) => figureLayoutTarget(view, item));
    if (targets.length !== currentRow.images.length || targets.some((target) => !target || target.kind !== "image")) return null;
    const snapshot = view.state.doc;
    const widths = figures.map((item) => item.getBoundingClientRect().width ||
      (Number.parseFloat(item.style.getPropertyValue("--cm-image-row-weight")) || 1) * 100);
    const originalWeights = figures.map((item) => item.style.getPropertyValue("--cm-image-row-weight"));
    const paint = (values: number[]) => figures.forEach((item, at) => item.style.setProperty("--cm-image-row-weight", String(values[at] ?? 1)));
    const restore = () => figures.forEach((item, index) => {
      const weight = originalWeights[index];
      if (weight) item.style.setProperty("--cm-image-row-weight", weight);
      else item.style.removeProperty("--cm-image-row-weight");
    });
    const commit = (delta: number): boolean => {
      if (view.state.doc !== snapshot) { restore(); return false; }
      const resized = resizePair(widths, at, delta, 64);
      const weights = weightsFromWidths(resized);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      return applyFigureLayouts(view, targets.map((target, at) => {
        const figureTarget = target!;
        const percent = Math.round((weights[at]! / total) * 1000) / 10;
        return { target: figureTarget, patch: { width: `${percent}%`, height: "" } };
      }));
    };
    return { widths, paint, restore, commit, startX, at };
  };
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    startGesture(0)?.commit(event.key === "ArrowLeft" ? -16 : 16);
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.state.readOnly) return;
    const gesture = startGesture(event.clientX);
    if (!gesture) return;
    event.preventDefault();
    event.stopPropagation();
    let delta = 0;
    let frame = 0;
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("is-resizing");
    const cleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      handle.classList.remove("is-resizing");
    };
    const restore = gesture.restore;
    const move = (pointer: PointerEvent) => {
      pointer.preventDefault();
      delta = pointer.clientX - gesture.startX;
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = resizePair(gesture.widths, gesture.at, delta, 64);
        gesture.paint(weightsFromWidths(next));
        view.requestMeasure();
      });
    };
    const finish = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pointer.stopPropagation();
      cleanup();
      if (!gesture.commit(delta)) restore();
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

export function imageRowHeightHandle(view: EditorView, figure: HTMLElement): HTMLButtonElement | null {
  const initial = imageRowAt(view.state, Number(figure.dataset.cmSourceFrom));
  if (!initial || initial.images[0]?.from !== Number(figure.dataset.cmSourceFrom) || view.state.readOnly) return null;
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cm-image-row-height";
  handle.title = "Drag to change row height";
  handle.setAttribute("aria-label", handle.title);
  handle.addEventListener("mousedown", (event) => event.stopPropagation());
  const startGesture = (startY: number) => {
    const row = imageRowAt(view.state, Number(figure.dataset.cmSourceFrom));
    if (!row || row.images[0]?.from !== Number(figure.dataset.cmSourceFrom)) return null;
    const parent = figure.parentElement;
    if (!parent) return null;
    const figures = [...parent.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node.classList.contains("cm-image-row-item"));
    const targets = figures.map((item) => figureLayoutTarget(view, item));
    if (targets.length !== row.images.length || targets.some((target) => !target || target.kind !== "image")) return null;
    const snapshot = view.state.doc;
    const oldHeights = figures.map((item) => item.style.getPropertyValue("--aaronnote-image-height"));
    const initialHeight = Number.parseFloat(targets[0]!.layout.height) ||
      figure.querySelector<HTMLImageElement>("img.cm-image-render")?.getBoundingClientRect().height || 220;
    const paint = (height: number) => figures.forEach((item) => item.style.setProperty("--aaronnote-image-height", `${height}px`));
    const restore = () => figures.forEach((item, at) => {
      const old = oldHeights[at];
      if (old) item.style.setProperty("--aaronnote-image-height", old);
      else item.style.removeProperty("--aaronnote-image-height");
    });
    const commit = (delta: number) => {
      if (view.state.doc !== snapshot) { restore(); return false; }
      const height = Math.max(80, Math.min(900, Math.round(initialHeight + delta)));
      return applyFigureLayouts(view, targets.map((target) => ({ target: target!, patch: { height: `${height}px` } })));
    };
    return { startY, initialHeight, paint, restore, commit };
  };
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    startGesture(0)?.commit(event.key === "ArrowUp" ? -16 : 16);
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || view.state.readOnly) return;
    const gesture = startGesture(event.clientY);
    if (!gesture) return;
    event.preventDefault();
    event.stopPropagation();
    let delta = 0;
    let frame = 0;
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("is-resizing");
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
      delta = pointer.clientY - gesture.startY;
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        gesture.paint(Math.max(80, Math.min(900, Math.round(gesture.initialHeight + delta))));
        view.requestMeasure();
      });
    };
    const finish = (pointer: PointerEvent) => {
      pointer.preventDefault();
      pointer.stopPropagation();
      cleanup();
      if (!gesture.commit(delta)) gesture.restore();
    };
    const cancel = () => { cleanup(); gesture.restore(); };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); cancel(); } };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  });
  return handle;
}
