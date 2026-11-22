/**
 * Architecture guard: a pointer lands where the layout is painted.
 *
 * "The caret does not land where I click" kept returning because clicks were
 * mapped by CodeMirror's posAtCoords, which picks the line from a height
 * estimate that lags behind images, TikZ, diagrams and display math measured
 * after they were drawn. A fix for one surface (floated figures) left the rest.
 * Now every click, drag, hover and context-menu lookup goes through
 * src/cm6/pointer-position.ts (the facade's positionAtPoint), which trusts the
 * browser's own hit test on real text and falls back to CodeMirror only for
 * widgets and gaps. This test keeps a second mapping from coming back.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { ChangeSet } from "@codemirror/state";

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
function code(path: string): string {
  return readFileSync(join(ROOT, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Places that may still ask CodeMirror directly, each with its reason. */
const OWNERS: Record<string, string> = {
  "src/cm6/pointer-position.ts": "the mapping itself, and its fallback",
  "src/cm6/viewport-stability.ts": "a scroll anchor for a press, never a caret",
  "src/cm6/screen-rows.ts": "Vim's row geometry (j/k column), kept as it was on purpose",
  "pages/vim-lite.ts": "Vim's H/M/L row lookup, kept as it was on purpose",
};

describe("pointer positions have one owner", () => {
  test("no other code maps a pointer with posAtCoords or a native hit test", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("src"), ...sourceFiles("pages")]) {
      if (OWNERS[file]) continue;
      const text = code(file);
      if (/\bposAtCoords\s*\(|caretRangeFromPoint|caretPositionFromPoint/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("the editor installs the pointer selection style", () => {
    expect(code("src/cm6/editor-cm6.ts")).toMatch(/\bpointerSelectionStyle\b/);
  });
});

describe("clicks, double clicks and drags", () => {
  async function press(detail: number, at: number, to = at, shiftKey = false) {
    const { createEditor } = await import("../src/editor-api.ts");
    const { EditorView } = await import("@codemirror/view");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "alpha beta gamma\nsecond line here\n" });
    const view = editor.view;
    const original = Object.getOwnPropertyDescriptor(view, "posAtCoords");
    // jsdom has no layout: x stands for a document position.
    Object.defineProperty(view, "posAtCoords", { configurable: true, value: (p: { x: number }) => p.x });
    try {
      const line = host.querySelector(".cm-line")!;
      const down = new MouseEvent("mousedown", { bubbles: true, button: 0, detail, clientX: at, clientY: 1, shiftKey });
      Object.defineProperty(down, "target", { value: line });
      const styles = view.state.facet(EditorView.mouseSelectionStyle);
      const style = styles.map((make) => make(view, down)).find(Boolean);
      expect(style).toBeTruthy();
      const move = new MouseEvent("mousemove", { clientX: to, clientY: 1 });
      const selection = style!.get(to === at ? down : move, shiftKey, false);
      return { anchor: selection.main.anchor, head: selection.main.head };
    } finally {
      if (original) Object.defineProperty(view, "posAtCoords", original);
      else delete (view as { posAtCoords?: unknown }).posAtCoords;
      editor.destroy();
      host.remove();
    }
  }

  test("a click puts the caret at the mapped position", async () => {
    expect(await press(1, 8)).toEqual({ anchor: 8, head: 8 });
  });

  test("a double click selects the word", async () => {
    const { anchor, head } = await press(2, 8);
    expect([Math.min(anchor, head), Math.max(anchor, head)]).toEqual([6, 10]);
  });

  test("a triple click selects the line", async () => {
    const { anchor, head } = await press(3, 3);
    expect([Math.min(anchor, head), Math.max(anchor, head)]).toEqual([0, 17]);
  });

  test("a drag selects from press to pointer", async () => {
    expect(await press(1, 2, 12)).toEqual({ anchor: 2, head: 12 });
    expect(await press(1, 12, 2)).toEqual({ anchor: 12, head: 2 });
  });

  test("the press position follows edits during a drag", () => {
    expect(ChangeSet.of([{ from: 0, insert: "xx" }], 5).mapPos(3)).toBe(5);
  });
});
