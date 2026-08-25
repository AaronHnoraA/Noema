/**
 * Noema block-identity indicator. Ordinary Markdown blocks carry an explicit
 * trailing `{#id}` only after the user gives that block an identity (reference,
 * embed, attribute view, ...). Org environments already render identities in
 * block-extras.ts, so this extension deliberately skips `#+begin` lines.
 *
 * This is a viewport-local Visual-mode projection. It never changes source;
 * touching the anchor with the selection reveals the raw `{#id}` text.
 */

import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { BLOCK_ANCHOR_SOURCE, shortBlockId } from "../../../../../shared/block-identity.mjs";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeInsideAny } from "../../../math-ranges.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";

const BLOCK_ANCHOR_RE = new RegExp(BLOCK_ANCHOR_SOURCE, "g");
const MAX_VIEWPORT_BADGES = 2_000;

class BlockAnchorWidget extends WidgetType {
  readonly id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }

  eq(other: BlockAnchorWidget): boolean { return this.id === other.id; }

  toDOM(): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "cm-noema-block-id";
    badge.textContent = `#${shortBlockId(this.id)}`;
    badge.title = this.id;
    badge.setAttribute("role", "button");
    badge.setAttribute("aria-label", `Copy block ID ${this.id}`);
    badge.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard?.writeText(this.id).then(() => {
        badge.classList.add("cm-noema-block-id-copied");
        window.setTimeout(() => badge.classList.remove("cm-noema-block-id-copied"), 600);
      }).catch(() => {});
    });
    return badge;
  }

  ignoreEvent(): boolean { return true; }
}

function excludedRanges(view: EditorView): Array<{ from: number; to: number }> {
  const ranges = blockMathRangesOverlapping(view.state, view.visibleRanges)
    .map(({ from, to }) => ({ from, to }));
  for (const visible of view.visibleRanges) {
    ranges.push(...scanInlineMathRanges(view.state.doc.sliceString(visible.from, visible.to), visible.from));
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (["FencedCode", "CodeBlock", "IndentedCode", "InlineCode"].includes(node.name)) {
          ranges.push({ from: node.from, to: node.to });
          return false;
        }
        return true;
      },
    });
  }
  return mergeOverlappingRanges(ranges);
}

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  const selection = view.state.selection.main;
  return selection.empty
    ? selection.from >= from && selection.from <= to
    : selection.from < to && selection.to > from;
}

function buildBlockAnchorDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const excluded = excludedRanges(view);
  const seenLines = new Set<number>();
  let count = 0;

  for (const visible of view.visibleRanges) {
    const first = view.state.doc.lineAt(visible.from).number;
    const last = view.state.doc.lineAt(Math.min(visible.to, view.state.doc.length)).number;
    for (let lineNumber = first; lineNumber <= last && count < MAX_VIEWPORT_BADGES; lineNumber++) {
      if (seenLines.has(lineNumber)) continue;
      seenLines.add(lineNumber);
      const line = view.state.doc.line(lineNumber);
      if (/^\s*#\+begin\b/i.test(line.text)) continue;
      BLOCK_ANCHOR_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (count < MAX_VIEWPORT_BADGES && (match = BLOCK_ANCHOR_RE.exec(line.text)) !== null) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        if (rangeInsideAny(from, to, excluded) || selectionTouches(view, from, to)) continue;
        decorations.push(Decoration.replace({ widget: new BlockAnchorWidget(match[1]!) }).range(from, to));
        count++;
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decorations, true);
}

class BlockAnchorPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildBlockAnchorDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    if (update.docChanged || update.viewportChanged || update.selectionSet || hasViewportDecorationRefresh(update)) {
      this.decorations = buildBlockAnchorDecorations(update.view);
    }
  }
}

export const blockAnchorExtension = ViewPlugin.fromClass(BlockAnchorPlugin, {
  decorations: (plugin) => plugin.decorations,
});
