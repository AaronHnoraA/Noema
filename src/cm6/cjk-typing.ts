import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const HAN = /\p{Script=Han}/u;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/u;
const TO_FULL: Record<string, string> = { ",": "，", ".": "。", "!": "！", "?": "？", ";": "；", ":": "：" };
const TO_HALF = Object.fromEntries(Object.entries(TO_FULL).map(([half, full]) => [full, half]));
const PROTECTED = /^(?:FencedCode|CodeBlock|InlineCode|InlineMath|BlockMath|Link|Image|Autolink|URL|Table|HTMLBlock|HTMLTag)$/u;

/** A constant-size edit at a CJK boundary. Lezer is consulted only after the
 * two neighboring characters establish that a transform is possible. */
export function cjkTyping(): Extension {
  return EditorView.inputHandler.of((view, from, to, insert) => {
    if (view.state.readOnly || view.composing || view.compositionStarted ||
        from !== to || insert.length !== 1 || view.state.selection.ranges.length !== 1) return false;
    if (!LATIN_OR_DIGIT.test(insert) && !HAN.test(insert) && !TO_FULL[insert] && !TO_HALF[insert]) return false;
    const doc = view.state.doc;
    const left = from > 0 ? doc.sliceString(from - 1, from) : "";
    const right = from < doc.length ? doc.sliceString(from, from + 1) : "";
    const leftHan = HAN.test(left);
    const rightHan = HAN.test(right);
    let text = insert;
    let cursor = 1;
    if (leftHan && TO_FULL[insert]) text = TO_FULL[insert]!;
    else if (LATIN_OR_DIGIT.test(left) && TO_HALF[insert]) text = TO_HALF[insert]!;
    else if (LATIN_OR_DIGIT.test(insert) || HAN.test(insert)) {
      const insertedHan = HAN.test(insert);
      const before = insertedHan ? LATIN_OR_DIGIT.test(left) : leftHan;
      const after = insertedHan ? LATIN_OR_DIGIT.test(right) : rightHan;
      if (before || after) {
        text = `${before ? " " : ""}${insert}${after ? " " : ""}`;
        cursor = (before ? 1 : 0) + 1;
      }
    }
    if (text === insert || !syntaxTreeAvailable(view.state, from)) return false;
    for (let node: import("@lezer/common").SyntaxNode | null = syntaxTree(view.state).resolveInner(from, -1); node; node = node.parent) {
      if (PROTECTED.test(node.name)) return false;
    }
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + cursor },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  });
}
