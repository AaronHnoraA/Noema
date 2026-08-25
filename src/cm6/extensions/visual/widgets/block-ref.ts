/**
 * Noema block-reference live-preview: `((<UUIDv7> "anchor text"))` or bare
 * `((<UUIDv7>))`. The timestamp-shaped IDs produced during the SiYuan-kernel
 * spike remain readable, but new identities follow Noema's UUIDv7 contract.
 * Renders as a link-styled chip; clicking
 * dispatches `aaronnote:open-block-ref` (bubbles, cancelable) on the widget
 * element the same way `editor-cm6.ts` dispatches `aaronnote:open-url` —
 * this module has no opinion on cross-document navigation, that is an
 * app-shell concern once a block-ID index exists.
 *
 * Deliberately does not mark refs as valid/broken (unlike roam-link-status.ts):
 * there is no known-block-ID index wired up yet for kernel-backed docs, and
 * fabricating one here would be presentational only. Add that once a real
 * lookup exists.
 */

import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeInsideAny } from "../../../math-ranges.ts";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { BLOCK_REFERENCE_ID_SOURCE, shortBlockId } from "../../../../../shared/block-identity.mjs";

const BLOCK_REF_RE = new RegExp(
  String.raw`\(\((${BLOCK_REFERENCE_ID_SOURCE})(?:\s+(["'])((?:\\.|(?!\2)[\s\S])*)\2)?\)\)`,
  "g",
);
const MAX_VIEWPORT_REFS = 2_000;

function unescapeTitle(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

class BlockRefWidget extends WidgetType {
  readonly id: string;
  readonly label: string;

  constructor(id: string, text: string | undefined) {
    super();
    this.id = id;
    this.label = text ? unescapeTitle(text) : `#${shortBlockId(id)}`;
  }

  eq(other: BlockRefWidget): boolean { return this.id === other.id && this.label === other.label; }

  toDOM(): HTMLElement {
    const link = document.createElement("span");
    link.className = "cm-block-ref";
    link.textContent = this.label;
    link.title = this.id;
    link.setAttribute("role", "link");
    link.setAttribute("aria-label", `Open block ${this.id}`);
    link.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      link.dispatchEvent(new CustomEvent("aaronnote:open-block-ref", {
        bubbles: true,
        cancelable: true,
        detail: { id: this.id, text: this.label },
      }));
    });
    return link;
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

function buildBlockRefDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const excluded = excludedRanges(view);
  const seenLines = new Set<number>();
  let count = 0;

  for (const visible of view.visibleRanges) {
    const first = view.state.doc.lineAt(visible.from).number;
    const last = view.state.doc.lineAt(Math.min(visible.to, view.state.doc.length)).number;
    for (let lineNumber = first; lineNumber <= last && count < MAX_VIEWPORT_REFS; lineNumber++) {
      if (seenLines.has(lineNumber)) continue;
      seenLines.add(lineNumber);
      const line = view.state.doc.line(lineNumber);
      BLOCK_REF_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (count < MAX_VIEWPORT_REFS && (match = BLOCK_REF_RE.exec(line.text)) !== null) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        if (rangeInsideAny(from, to, excluded) || selectionTouches(view, from, to)) continue;
        decorations.push(Decoration.replace({
          widget: new BlockRefWidget(match[1]!, match[3]),
        }).range(from, to));
        count++;
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decorations, true);
}

class BlockRefPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildBlockRefDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    if (update.docChanged || update.viewportChanged || update.selectionSet || hasViewportDecorationRefresh(update)) {
      this.decorations = buildBlockRefDecorations(update.view);
    }
  }
}

export const blockRefExtension = ViewPlugin.fromClass(BlockRefPlugin, {
  decorations: (plugin) => plugin.decorations,
});
