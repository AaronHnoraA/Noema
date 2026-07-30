import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, type BlockInfo } from "@codemirror/view";

export type MovableBlockKind = "paragraph" | "heading" | "list" | "fence" | "math" | "table" | "org-env" | "jupyter";

export type MovableBlock = {
  from: number;
  to: number;
  kind: MovableBlockKind;
  tooLarge: boolean;
};

const MAX_BLOCK_LINES = 20_000;
const MAX_BLOCK_BYTES = 1024 * 1024;
const STRUCTURAL_RE = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|\\\[\s*$|#\+begin\s+|@@cell\b|\|)/i;
const LIST_RE = /^([ \t]*)(?:[-*+]\s+|\d+[.)]\s+|- \[[ xX]\]\s+)/;
const protectedPreambleCache = new WeakMap<object, readonly { from: number; to: number }[]>();

function lineWithBreakTo(state: EditorState, lineNumber: number): number {
  return lineNumber < state.doc.lines ? state.doc.line(lineNumber + 1).from : state.doc.length;
}

function indentWidth(text: string): number {
  return [...(text.match(/^[ \t]*/)?.[0] ?? "")].reduce((sum, char) => sum + (char === "\t" ? 4 : 1), 0);
}

function cappedBlock(
  state: EditorState,
  startLine: number,
  endLine: number,
  kind: MovableBlockKind,
  forcedTooLarge = false,
): MovableBlock {
  const from = state.doc.line(startLine).from;
  const to = lineWithBreakTo(state, endLine);
  return {
    from,
    to,
    kind,
    tooLarge: forcedTooLarge || endLine - startLine + 1 > MAX_BLOCK_LINES || to - from > MAX_BLOCK_BYTES,
  };
}

function protectedPreambleRange(state: EditorState): readonly { from: number; to: number }[] {
  const cacheKey = state.doc as unknown as object;
  const cached = protectedPreambleCache.get(cacheKey);
  if (cached) return cached;
  const ranges: Array<{ from: number; to: number }> = [];
  let lineNumber = 1;
  if (state.doc.line(1).text.trim() === "---") {
    for (lineNumber = 2; lineNumber <= Math.min(1_024, state.doc.lines); lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (line.to > 256 * 1024) break;
      if (line.text.trim() === "---") { ranges.push({ from: 0, to: lineWithBreakTo(state, lineNumber) }); break; }
    }
  }
  for (lineNumber = 1; lineNumber <= Math.min(128, state.doc.lines); lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (!/^\s*#\+begin\s+meta\s*$/i.test(line.text)) continue;
    for (let close = lineNumber + 1; close <= state.doc.lines && close - lineNumber <= MAX_BLOCK_LINES; close += 1) {
      if (/^\s*#\+end\s+meta\s*$/i.test(state.doc.line(close).text)) {
        ranges.push({ from: line.from, to: lineWithBreakTo(state, close) });
        break;
      }
    }
    break;
  }
  protectedPreambleCache.set(cacheKey, ranges);
  return ranges;
}

function positionProtected(state: EditorState, pos: number): boolean {
  return protectedPreambleRange(state).some((range) => pos >= range.from && pos < range.to);
}

function blockBeginningAtLine(state: EditorState, startLine: number): MovableBlock | null {
  const start = state.doc.line(startLine);
  const text = start.text;
  if (!text.trim() || positionProtected(state, start.from)) return null;

  const heading = /^(#{1,6})\s+/.exec(text);
  if (heading) {
    const level = heading[1]!.length;
    let end = startLine;
    let tooLarge = false;
    for (let lineNumber = startLine + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) { tooLarge = true; break; }
      const next = /^(#{1,6})\s+/.exec(line.text);
      if (next && next[1]!.length <= level) break;
      end = lineNumber;
    }
    return cappedBlock(state, startLine, end, "heading", tooLarge);
  }

  const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
  if (fence) {
    const marker = fence[1]![0]!;
    const length = fence[1]!.length;
    let end = startLine;
    let closed = false;
    for (let lineNumber = startLine + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) break;
      end = lineNumber;
      if (new RegExp(`^\\s{0,3}${marker}{${length},}\\s*$`).test(line.text)) { closed = true; break; }
    }
    return cappedBlock(state, startLine, end, "fence", !closed);
  }

  if (/^\s*\\\[\s*$/.test(text)) {
    let end = startLine;
    let closed = false;
    for (let lineNumber = startLine + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) break;
      end = lineNumber;
      if (/^\s*\\\]\s*$/.test(line.text)) { closed = true; break; }
    }
    return cappedBlock(state, startLine, end, "math", !closed);
  }

  const org = /^\s*#\+begin\s+([A-Za-z][\w-]*)\b/i.exec(text);
  if (org) {
    const kind = org[1]!.toLowerCase();
    let depth = 1;
    let end = startLine;
    let closed = false;
    for (let lineNumber = startLine + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) break;
      if (new RegExp(`^\\s*#\\+begin\\s+${kind}\\b`, "i").test(line.text)) depth += 1;
      else if (new RegExp(`^\\s*#\\+end\\s+${kind}\\s*$`, "i").test(line.text)) depth -= 1;
      end = lineNumber;
      if (depth === 0) { closed = true; break; }
    }
    return cappedBlock(state, startLine, end, "org-env", !closed);
  }

  if (/^\s*@@cell\b/i.test(text)) return cappedBlock(state, startLine, startLine, "jupyter");

  const list = LIST_RE.exec(text);
  if (list) {
    const baseIndent = indentWidth(list[1] ?? "");
    let end = startLine;
    let sawBlank = false;
    for (let lineNumber = startLine + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) {
        return cappedBlock(state, startLine, end, "list", true);
      }
      if (!line.text.trim()) { sawBlank = true; end = lineNumber; continue; }
      const nextItem = LIST_RE.exec(line.text);
      const nextIndent = indentWidth(line.text);
      if (nextItem && nextIndent <= baseIndent) break;
      if (sawBlank && nextIndent <= baseIndent) break;
      if (!nextItem && nextIndent < baseIndent) break;
      sawBlank = false;
      end = lineNumber;
    }
    return cappedBlock(state, startLine, end, "list");
  }

  if (/^\s*\|/.test(text)) {
    const next = startLine < state.doc.lines ? state.doc.line(startLine + 1).text : "";
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(next)) {
      let end = startLine + 1;
      for (let lineNumber = startLine + 2; lineNumber <= state.doc.lines; lineNumber += 1) {
        const line = state.doc.line(lineNumber);
        if (!/^\s*\|/.test(line.text)) break;
        if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) return cappedBlock(state, startLine, end, "table", true);
        end = lineNumber;
      }
      return cappedBlock(state, startLine, end, "table");
    }
  }

  if (startLine > 1) {
    const previous = state.doc.line(startLine - 1).text;
    if (previous.trim() && !STRUCTURAL_RE.test(text)) return null;
  }
  let end = startLine;
  for (let lineNumber = startLine + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (!line.text.trim() || STRUCTURAL_RE.test(line.text)) break;
    if (lineNumber - startLine >= MAX_BLOCK_LINES || line.to - start.from > MAX_BLOCK_BYTES) return cappedBlock(state, startLine, end, "paragraph", true);
    end = lineNumber;
  }
  return cappedBlock(state, startLine, end, "paragraph");
}

export function movableBlockAt(state: EditorState, pos: number): MovableBlock | null {
  const safe = Math.max(0, Math.min(pos, state.doc.length));
  const line = state.doc.lineAt(safe);
  for (let candidate = line.number; candidate >= Math.max(1, line.number - MAX_BLOCK_LINES); candidate -= 1) {
    const block = blockBeginningAtLine(state, candidate);
    if (!block) continue;
    if (safe >= block.from && safe < block.to) return block;
    if (block.to <= safe && candidate < line.number - 2) break;
  }
  return null;
}

function blockStartsNear(state: EditorState, fromLine: number, direction: -1 | 1): MovableBlock | null {
  for (let offset = 0; offset < MAX_BLOCK_LINES; offset += 1) {
    const lineNumber = fromLine + offset * direction;
    if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
    const block = blockBeginningAtLine(state, lineNumber);
    if (block) return block;
  }
  return null;
}

function moveBlockTo(view: EditorView, block: MovableBlock, target: number): boolean {
  if (block.tooLarge || target >= block.from && target <= block.to) return false;
  const source = view.state.doc.sliceString(block.from, block.to);
  const relativeSelection = Math.max(0, Math.min(view.state.selection.main.from - block.from, source.length));
  if (target < block.from) {
    const middle = view.state.doc.sliceString(target, block.from);
    view.dispatch({
      changes: { from: target, to: block.to, insert: source + middle },
      selection: { anchor: target + relativeSelection },
      scrollIntoView: true,
    });
  } else {
    const middle = view.state.doc.sliceString(block.to, target);
    const nextFrom = target - (block.to - block.from);
    view.dispatch({
      changes: { from: block.from, to: target, insert: middle + source },
      selection: { anchor: nextFrom + relativeSelection },
      scrollIntoView: true,
    });
  }
  return true;
}

export function moveBlockAtCursor(view: EditorView, direction: -1 | 1): boolean {
  const block = movableBlockAt(view.state, view.state.selection.main.from);
  if (!block || block.tooLarge) return false;
  if (direction < 0) {
    const line = view.state.doc.lineAt(Math.max(0, block.from - 1));
    const previous = blockStartsNear(view.state, line.number, -1);
    if (!previous || previous.to > block.from) return false;
    return moveBlockTo(view, block, previous.from);
  }
  const nextLine = block.to >= view.state.doc.length ? view.state.doc.lines + 1 : view.state.doc.lineAt(block.to).number;
  const next = blockStartsNear(view.state, nextLine, 1);
  if (!next || next.from < block.to) return false;
  return moveBlockTo(view, block, next.to);
}

class BlockHandleMarker extends GutterMarker {
  readonly from: number;
  readonly disabled: boolean;
  readonly kind: MovableBlockKind;
  constructor(from: number, disabled: boolean, kind: MovableBlockKind) {
    super();
    this.from = from;
    this.disabled = disabled;
    this.kind = kind;
  }
  eq(other: BlockHandleMarker): boolean {
    return this.from === other.from && this.disabled === other.disabled && this.kind === other.kind;
  }
  toDOM(): Node {
    const handle = document.createElement("span");
    handle.className = `cm-block-drag-handle${this.disabled ? " is-disabled" : ""}`;
    handle.textContent = "⠿";
    handle.draggable = !this.disabled;
    handle.dataset.blockFrom = String(this.from);
    handle.title = this.disabled ? "Block exceeds the 1 MiB / 20,000 line move limit" : `Drag ${this.kind}`;
    handle.setAttribute("aria-label", handle.title);
    return handle;
  }
}

const draggedBlocks = new WeakMap<EditorView, MovableBlock>();

function blockForGutterLine(view: EditorView, line: BlockInfo): MovableBlock | null {
  const block = blockBeginningAtLine(view.state, view.state.doc.lineAt(line.from).number);
  return block?.from === line.from ? block : null;
}

function blockForGutterEvent(view: EditorView, line: BlockInfo, event: Event): MovableBlock | null {
  const element = event.target instanceof Element
    ? event.target.closest<HTMLElement>(".cm-block-drag-handle")
    : null;
  const markerFrom = Number(element?.dataset.blockFrom);
  if (Number.isFinite(markerFrom)) {
    const block = movableBlockAt(view.state, markerFrom);
    if (block?.from === markerFrom) return block;
  }
  return blockForGutterLine(view, line);
}

export const blockMoveGutterExtension: Extension = gutter({
  class: "cm-block-drag-gutter",
  lineMarker(view, line) {
    const block = blockForGutterLine(view, line);
    return block ? new BlockHandleMarker(block.from, block.tooLarge, block.kind) : null;
  },
  lineMarkerChange: (update) => update.docChanged || update.viewportChanged,
  domEventHandlers: {
    dragstart(view, line, event) {
      const block = blockForGutterEvent(view, line, event);
      if (!block || block.tooLarge) return false;
      draggedBlocks.set(view, block);
      const drag = event as DragEvent;
      drag.dataTransfer?.setData("text/x-aaronnote-block", String(block.from));
      if (drag.dataTransfer) drag.dataTransfer.effectAllowed = "move";
      return true;
    },
    dragover(view, _line, event) {
      if (!draggedBlocks.has(view)) return false;
      event.preventDefault();
      const drag = event as DragEvent;
      if (drag.dataTransfer) drag.dataTransfer.dropEffect = "move";
      const rect = view.scrollDOM.getBoundingClientRect();
      if (drag.clientY < rect.top + 28) view.scrollDOM.scrollBy({ top: -24 });
      else if (drag.clientY > rect.bottom - 28) view.scrollDOM.scrollBy({ top: 24 });
      return true;
    },
    drop(view, line, event) {
      const block = draggedBlocks.get(view);
      draggedBlocks.delete(view);
      if (!block) return false;
      event.preventDefault();
      const target = blockForGutterEvent(view, line, event) ?? movableBlockAt(view.state, line.from);
      if (!target) return true;
      const coords = view.coordsAtPos(target.from);
      // A visible gutter line normally has coordinates.  Keep a deterministic
      // fallback for virtualized/off-screen lines (and non-layout DOMs): a
      // downward drag lands after its target, an upward drag before it.
      const after = coords
        ? (event as DragEvent).clientY > (coords.top + coords.bottom) / 2
        : target.from > block.from;
      moveBlockTo(view, block, after ? target.to : target.from);
      return true;
    },
    dragend(view) {
      draggedBlocks.delete(view);
      return false;
    },
  },
});
