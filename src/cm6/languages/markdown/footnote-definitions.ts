import type { MarkdownConfig } from "@lezer/markdown";

const marker = /^\[\^[^\]\n]{1,128}\]:[ \t]*/;

/**
 * A top-level footnote owns its indented prose continuation. Otherwise Lezer
 * treats the first line as a reference link and a four-space continuation as code.
 */
export const footnoteDefinitions: MarkdownConfig = {
  defineNodes: [{ name: "FootnoteDefinition", block: true }],
  parseBlock: [{
    name: "FootnoteDefinition",
    before: "LinkReference",
    endLeaf(cx, line) {
      return cx.depth === 1 && line.indent < 4 && line.next === 91 && marker.test(line.text.slice(line.pos));
    },
    parse(cx, line) {
      if (cx.depth !== 1 || line.indent >= 4 || line.next !== 91) return false;
      const match = marker.exec(line.text.slice(line.pos));
      if (!match) return false;
      const start = cx.lineStart + line.pos;
      let end = cx.lineStart + line.text.length;
      const contentStart = line.pos + match[0].length;
      const children = cx.parser.parseInline(line.text.slice(contentStart), cx.lineStart + contentStart);
      while (cx.nextLine() && line.pos < line.text.length && line.indent >= 2) {
        end = cx.lineStart + line.text.length;
        children.push(...cx.parser.parseInline(line.text.slice(line.pos), cx.lineStart + line.pos));
      }
      cx.addElement(cx.elt("FootnoteDefinition", start, end, children));
      return true;
    },
  }],
};
