/**
 * Architecture guard: the editor's viewport has one owner.
 *
 * "Clicking an image / a table / a formula scrolls the page", "a click after
 * scrolling throws me back" kept coming back because many paths could move the
 * viewport — a widget focusing an input, a handler focusing the editor while
 * its caret was still where the reader left it, a write to scrollTop. Each fix
 * covered one path. Now the viewport belongs to `src/cm6/viewport-stability.ts`
 * (see docs/architecture/scroll-ownership.md); these rules keep other code from
 * moving it behind the owner's back. The behaviour itself is checked in a real
 * WebKit by scripts/check-scroll-invariance.mjs, for every construct family.
 *
 * Named owners below are the only exceptions, each with its reason. When a rule
 * fires, route the code through the owner instead of adding an owner.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

const ROOT = process.cwd();
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
/** Source without comments, so a rule is about code, not prose explaining it. */
const code = (path: string) => readFileSync(join(ROOT, path), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const editorFiles = sourceFiles("src/cm6");

describe("the viewport has one owner", () => {
  test("every focus of the editor content goes through the owner", () => {
    // WebKit reveals the editor's old DOM caret when its content is focused,
    // even with preventScroll. installFocusOwner routes view.focus(),
    // contentDOM.focus() and the host's pointer fallback through the owner.
    expect(code("src/cm6/editor-cm6.ts")).toMatch(/\n\s*installFocusOwner\(view\);/);
    expect(code("src/cm6/viewport-stability.ts")).toMatch(/export function installFocusOwner\(/);
  });

  test("an element inside the editor is focused without scrolling", () => {
    // A table cell input, a code language field, a property editor: focusing
    // one scrolls it fully into view unless told not to. (`view.focus()` is
    // the editor itself and goes through the owner.)
    const offenders = editorFiles.flatMap((path) => code(path).split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /(?:^|[^\w.])(?!\w*[vV]iew\b)[\w$]+\??\.focus\(\)/.test(line))
      .map(({ line, index }) => `${path}:${index + 1}: ${line.trim()}`));
    expect(offenders, "pass { preventScroll: true }").toEqual([]);
  });

  test("only the owner writes the scroll position", () => {
    const owners: Record<string, string> = {
      "src/cm6/viewport-stability.ts": "the owner",
      "src/cm6/block-move.ts": "dragging a block to the edge scrolls with the pointer: the reader's movement",
      "src/cm6/extensions/visual/widgets/visualtex-inline.ts": "a formula field's own horizontal strip follows its caret, inside the field, never the page",
    };
    const offenders = editorFiles
      .filter((path) => !(path in owners))
      .filter((path) => /\.scrollTop\s*[-+]?=(?!=)|\.scrollLeft\s*[-+]?=(?!=)|\.scrollTo\(|\.scrollBy\(/.test(code(path)));
    expect(offenders, "move the viewport through viewport-stability.ts or a transaction's scrollIntoView").toEqual([]);
  });

  test("only navigation the reader asked for scrolls an element into view", () => {
    const owners: Record<string, string> = {
      "src/cm6/editor-cm6.ts": "jumping to a heading from the outline",
      "src/cm6/extensions/visual/widgets/block-extras.ts": "jumping to a heading from a [toc] entry",
    };
    const offenders = editorFiles
      .filter((path) => !(path in owners))
      .filter((path) => /(?<!EditorView)\.scrollIntoView\(/.test(code(path)));
    expect(offenders, "reveal through a transaction's scrollIntoView so the owner can tell a jump from a reveal").toEqual([]);
  });
});
