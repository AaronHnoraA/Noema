import type { Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { rangeInsideAny } from "../../math-ranges.ts";
import { literalRangesOnLine } from "./constructs/literal-ranges.ts";
import { constructViewPlugin } from "./constructs/view-plugin.ts";
import { renderedDocumentReferences } from "./document-references.ts";

const patterns = new WeakMap<Readonly<Record<string, string>>, RegExp>();
const literalNodes = new Set(["URL", "HTMLBlock", "HTMLTag", "Comment", "CommentBlock"]);

function abbreviationPattern(labels: Readonly<Record<string, string>>): RegExp | undefined {
  const cached = patterns.get(labels);
  if (cached) return cached;
  const alternatives = Object.keys(labels)
    .map((key) => key.slice(1))
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alternatives.length) return undefined;
  const edge = "[\\p{P}\\p{Z}\\r\\n$+<=>^`|~]";
  const pattern = new RegExp(`(^|${edge})(${alternatives.join("|")})(?=${edge}|$)`, "gu");
  patterns.set(labels, pattern);
  return pattern;
}

export const abbreviationExtension = constructViewPlugin({
  build(view) {
    const labels = view.state.field(renderedDocumentReferences, false)?.abbreviations;
    const pattern = labels && abbreviationPattern(labels);
    if (!pattern) return Decoration.none;
    const { doc } = view.state;
    const decorations: Range<Decoration>[] = [];
    let previousLine = 0;
    for (const { from, to } of view.visibleRanges) {
      for (let number = Math.max(previousLine + 1, doc.lineAt(from).number); number <= doc.lineAt(to).number; number++) {
        previousLine = number;
        const line = doc.line(number);
        if (/^[ \t]*(?:\*\[|#\+)/.test(line.text)) continue;
        pattern.lastIndex = 0;
        let literal: ReturnType<typeof literalRangesOnLine> | undefined;
        for (let match = pattern.exec(line.text); match; match = pattern.exec(line.text)) {
          const text = match[2]!;
          const start = line.from + match.index + match[1]!.length;
          const end = start + text.length;
          literal ??= literalRangesOnLine(view.state, line);
          if (rangeInsideAny(start, end, literal)) continue;
          let node = syntaxTree(view.state).resolveInner(start, 1);
          while (node.parent && !literalNodes.has(node.name)) node = node.parent;
          if (literalNodes.has(node.name)) continue;
          decorations.push(Decoration.mark({
            tagName: "abbr", class: "noema-abbreviation", attributes: { title: labels![`:${text}`] ?? text },
          }).range(start, end));
        }
      }
    }
    return Decoration.set(decorations, true);
  },
});
