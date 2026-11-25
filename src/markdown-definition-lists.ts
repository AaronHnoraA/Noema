import type MarkdownIt from "markdown-it";
import deflist from "markdown-it-deflist";
import Token from "markdown-it/lib/token.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

const bodyMarker = /^[:~](?:[ \t]|$)/;
const otherBlockStart = /^(?:#{1,6}(?:[ \t]|$)|#\+|[><]|(?:[-+*]|\d{1,9}[.)])[ \t]|\*\[|`{3,}|~{3,}|[-=_]{3,}$|\\\[|\[[^\]\n]+\]:)/;

function lineBody(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]).trimEnd();
}

/** Let adjacent aliases share the same standard Markdown definition list. */
export function installDefinitionLists(md: MarkdownIt): void {
  const previousRules = new Set(md.block.ruler.getRules(""));
  md.use(deflist);
  const parseDefinition = md.block.ruler.getRules("").find((rule) => !previousRules.has(rule));
  if (!parseDefinition) return;
  md.block.ruler.before("deflist", "noema_definition_aliases", (state, first, end, silent) => {
    if (silent) return false;
    const indent = state.sCount[first]!;
    const terms: string[] = [];
    let line = first;
    for (; line < end && terms.length < 32; line++) {
      const text = lineBody(state, line);
      if (!text || bodyMarker.test(text)) break;
      if (state.sCount[line] !== indent || otherBlockStart.test(text)) return false;
      terms.push(text);
    }
    if (terms.length < 2 || line >= end) return false;
    const definition = state.isEmpty(line) ? line + 1 : line;
    if (definition >= end || !bodyMarker.test(lineBody(state, definition))) return false;
    const start = state.tokens.length;
    if (!parseDefinition(state, line - 1, end, false)) return false;
    const list = state.tokens[start]!;
    if (list.map) list.map[0] = first;
    const aliases: Token[] = [];
    for (let index = 0; index < terms.length - 1; index++) {
      const open = new Token("dt_open", "dt", 1);
      open.block = true;
      open.level = list.level + 1;
      open.map = [first + index, first + index + 1];
      const inline = new Token("inline", "", 0);
      inline.content = terms[index]!;
      inline.children = [];
      inline.level = list.level + 2;
      inline.map = open.map;
      const close = new Token("dt_close", "dt", -1);
      close.block = true;
      close.level = open.level;
      aliases.push(open, inline, close);
    }
    state.tokens.splice(start + 1, 0, ...aliases);
    return true;
  });
}
