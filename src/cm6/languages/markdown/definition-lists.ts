import type { BlockContext, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";

const marker = /^[:~](?:[ \t]+|$)/;
const baseMarker = /^[ \t]*(?:>[ \t]*)*[:~](?:[ \t]|$)/;
const aliasStart = /^(?:#{1,6}(?:[ \t]|$)|#\+|[><]|(?:[-+*]|\d{1,9}[.)])[ \t]|\*\[|`{3,}|~{3,}|[-=_]{3,}$|\\\[|\[[^\]\n]+\]:)/m;
const accepted = new WeakMap<BlockContext, { at: number; afterBlank?: string }>();
const latestNonblank = new WeakMap<BlockContext, number>();

const looseDefinition: LeafBlockParser = {
  nextLine: () => false,
  finish(cx, leaf) {
    if (latestNonblank.get(cx) === cx.lineStart || aliasStart.test(leaf.content)) return false;
    const next = cx.peekLine();
    if (baseMarker.test(next)) accepted.set(cx, { at: cx.lineStart, afterBlank: next });
    return false;
  },
};

/** Continue parsing the definition body with the same indentation as Markdown lists. */
export const definitionListsMarkdown: MarkdownConfig = {
  defineNodes: [{
    name: "DefinitionBody",
    block: true,
    composite(cx, line, indent) {
      const required = line.baseIndent + indent;
      if (line.indent < required && line.pos < line.text.length) {
        if (marker.test(line.text.slice(line.pos))) accepted.set(cx, { at: cx.lineStart });
        return false;
      }
      line.moveBaseColumn(required);
      return true;
    },
  }],
  parseBlock: [{
    name: "DefinitionBody",
    before: "LinkReference",
    leaf: () => looseDefinition,
    endLeaf(cx, line, leaf) {
      latestNonblank.set(cx, cx.lineStart);
      if ((line.next !== 58 && line.next !== 126) || !marker.test(line.text.slice(line.pos)) || aliasStart.test(leaf.content)) return false;
      accepted.set(cx, { at: cx.lineStart });
      return true;
    },
    parse(cx, line) {
      if (line.next !== 58 && line.next !== 126) return false;
      const match = marker.exec(line.text.slice(line.pos));
      if (!match || line.indent - line.baseIndent >= 4) return false;
      const candidate = accepted.get(cx);
      if (!candidate || (candidate.at !== cx.lineStart && candidate.afterBlank !== line.text)) return false;
      accepted.delete(cx);
      cx.startComposite("DefinitionBody", line.pos, line.indent - line.baseIndent + 2);
      line.moveBase(line.pos + match[0].length);
      return null;
    },
  }],
};
