/**
 * Architecture guard for rendered constructs.
 *
 * Every rendered construct goes through `src/cm6/extensions/visual/constructs/`
 * (see `docs/architecture/rendered-constructs.md`). These tests fail when new
 * code bypasses that layer, so the editor keeps one answer to "when does this
 * show its source" and "what is drawn here" as it grows. There are no
 * exceptions: every widget drawn over source is a construct. When a rule
 * fires, fix the code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorView, type DecorationSet } from "@codemirror/view";

import { createEditor } from "../src/editor-api.ts";
import { renderedConstructAt, type RenderedConstruct } from "../src/cm6/extensions/visual/constructs/index.ts";

const ROOT = process.cwd();
const CONSTRUCTS_DIR = "src/cm6/extensions/visual/constructs/";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const srcFiles = sourceFiles("src");

/** Modules that draw a widget over source text. */
const renderingModules = srcFiles.filter((path) => /Decoration\.replace\(\s*\{[^}]*\bwidget\b/s.test(read(path)));

describe("rendered constructs: static rules", () => {
  test("every module that draws over source decides reveal through the constructs layer", () => {
    const offenders = renderingModules
      .filter((path) => !path.startsWith(CONSTRUCTS_DIR))
      .filter((path) => !/from\s+"[^"]*constructs\/index\.ts"/.test(read(path)));
    expect(offenders, "import the reveal policy from constructs/ instead of comparing the selection by hand").toEqual([]);
  });

  test("every module that draws over source tells the construct registry what it draws", () => {
    // Vim, the caret and selection learn what is drawn only from the registry:
    // `inlineConstruct`, `constructSources.of(...)`, or `drawnConstructSource`.
    const offenders = renderingModules
      .filter((path) => !path.startsWith(CONSTRUCTS_DIR))
      .filter((path) => !/inlineConstruct\(|constructSources\.of\(/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  test("no rendering module compares the selection to a range by hand", () => {
    // `sel.empty && sel.from ...` and its relatives are how every widget used
    // to grow its own reveal rule. Use `selectionOpensSource` or a policy.
    const handWritten = /\b\w+\.empty\s*(?:&&|\?)[^;\n]*\.(?:from|to|head)\b/;
    const offenders = renderingModules
      .filter((path) => !path.startsWith(CONSTRUCTS_DIR))
      .flatMap((path) => read(path).split("\n")
        .map((line, index) => ({ path, line: index + 1, text: line.trim() }))
        .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*") && handWritten.test(text)))
      .map(({ path, line, text }) => `${path}:${line}: ${text}`);
    expect(offenders).toEqual([]);
  });

  test("the Vim mode reaches constructs only as editor state", () => {
    // Widgets read `renderedConstructsPinned(state)`; the DOM attribute is for
    // themes and the host, and goes stale between transactions.
    const readers = srcFiles.filter((path) => /dataset\.vimMode|data-vim-mode/.test(read(path)));
    expect(readers).toEqual([]);
    const vim = read("aaronnote/vim-lite.ts");
    const outside = vim.replace(/function publishMode[\s\S]*?\n}\n/, "");
    expect(outside.includes("dataset.vimMode"), "set the mode through publishMode").toBe(false);
  });

  test("embedded editing surfaces are marked and recognized through one module", () => {
    // A surface that edits text outside CM6 (for example, MathLive) calls
    // `markEmbeddedSurface`; checks use the exported selectors.
    const spelled = srcFiles.concat(sourceFiles("aaronnote"))
      .filter((path) => path !== "src/cm6/embedded-surface.ts")
      .filter((path) => /data-aaronnote-vim|aaronnoteVim/.test(read(path)));
    expect(spelled).toEqual([]);
  });

  test("table cells and their formulas use the document editor", () => {
    const preview = read("src/cm6/live-preview.ts");
    expect(preview).toMatch(/function tableSourceGridDecos\(/);
    expect(preview).toMatch(/focusDocumentTableCell\(view, current/);
    expect(preview).toMatch(/focusDocumentTableFormula\(view, current/);
    expect(preview).toMatch(/openRenderedFormulaSource\(view,/);
    const click = read("src/cm6/rendered-formula-click.ts");
    expect(click).toMatch(/revealFormulaSource\(view, formula\.from/);
    expect(preview).not.toMatch(/mountVisualTexInlineEditor\(/);
    expect(preview).not.toMatch(/markEmbeddedSurface\(table\);/);
    expect(preview.includes('dataset.aaronnoteVim = "native"'), "spell the surface through markEmbeddedSurface").toBe(false);
  });

  test("a construct writes to the document through dispatchConstructEdit", () => {
    // A checkbox, a language field, Accept, a layout menu, a table tool: one
    // action, one undo step, labelled `construct` — never merged with typing
    // or with the previous action, never mistaken for a typing burst. Owner:
    // the formula editing session groups its own history (math.ts).
    const owners = new Set(["src/cm6/extensions/visual/widgets/math.ts"]);
    const offenders: string[] = [];
    const constructModules = new Set([
      ...renderingModules,
      ...srcFiles.filter((path) => path.startsWith("src/cm6/extensions/visual/widgets/")),
      "src/cm6/figure-layout-menu.ts",
    ]);
    for (const path of constructModules) {
      if (owners.has(path)) continue;
      const text = read(path);
      const call = /(\w+(?:\.\w+)*)\.dispatch\(\s*(?:\w+\.state\.update\()?\{/g;
      let match: RegExpExecArray | null;
      while ((match = call.exec(text))) {
        const open = text.indexOf("{", match.index + match[0].length - 1);
        let depth = 0;
        let close = open;
        for (; close < text.length; close++) {
          if (text[close] === "{") depth++;
          else if (text[close] === "}" && --depth === 0) break;
        }
        if (/\bchanges\s*[:,}]/.test(text.slice(open, close))) {
          offenders.push(`${path}:${text.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("Markdown inside a widget is rendered by the one shared renderer", () => {
    // Table cells, todo chips, side comments, org bodies and embeds all render
    // through src/render-html.ts (`renderMarkdownHTML` / `renderInlineMarkdownHTML`),
    // so the same Markdown looks the same wherever a widget shows it.
    const offenders = srcFiles
      .filter((path) => path.startsWith("src/cm6/"))
      .filter((path) => /from\s+"markdown-it"|new MarkdownIt\(|<\\\/p>\\n\?\$/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  test("vertical motion has one row model, shared by Vim and the editor caret", () => {
    // ArrowUp/ArrowDown and Vim's j/k step over the same visual rows
    // (src/cm6/screen-rows.ts); CodeMirror's own moveVertically is not used.
    const callers = srcFiles.concat(sourceFiles("aaronnote"))
      .filter((path) => path !== "src/cm6/screen-rows.ts")
      .filter((path) => /\.moveVertically\(/.test(read(path)));
    expect(callers).toEqual([]);
  });

  test("construct families redraw what a transaction changed through one patcher", () => {
    // Opened-construct keys, merging ranges and drop-and-rebuild live in
    // constructs/decoration-patch.ts (rebuildForRevealChange, rebuildDecorations,
    // replaceDecorations); a family supplies only how to build a range.
    const offenders = srcFiles
      .filter((path) => path !== `${CONSTRUCTS_DIR}decoration-patch.ts`)
      .filter((path) => /filter:\s*\(\)\s*=>\s*false/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  test("what counts as literal (code, math) has one answer", () => {
    // Rendering modules ask constructs/literal-ranges.ts (literalRangesIn,
    // mathRangesIn, literalRangesOnLine) instead of scanning formulas and code
    // themselves, so a `[[link]]` or `@@command` inside any formula — including
    // one spanning lines — is literal for every family. math.ts owns formulas;
    // block-extras places only block constructs and caches block literals.
    const owners = new Set([
      "src/cm6/extensions/visual/widgets/math.ts",
      "src/cm6/extensions/visual/widgets/block-extras.ts",
    ]);
    const offenders = renderingModules
      .filter((path) => !path.startsWith(CONSTRUCTS_DIR) && !owners.has(path))
      .filter((path) => /scanInlineMathRanges\(|blockMathRangesOverlapping\(|scanCodeRanges\(/.test(read(path)));
    expect(offenders).toEqual([]);
  });

  test("viewport families share one update lifecycle", () => {
    // When to rebuild — composition, typing bursts, pointer drags, refreshes,
    // reveal keys, the persistent cache — is constructs/view-plugin.ts.
    // The modules that define those primitives, and three owners whose
    // lifecycle does more than the shared one, are the only other users.
    const owners: Record<string, string> = {
      "src/cm6/extensions/visual/typing-burst.ts": "defines typing bursts",
      "src/cm6/extensions/visual/visual-mode.ts": "defines the persistent cache",
      "src/cm6/live-preview.ts": "incremental viewport scan with a per-line CJK cache",
      "src/cm6/extensions/visual/widgets/math.ts": "the formula editing session",
      "src/cm6/extensions/visual/widgets/block-extras.ts": "org-env rail measurement, not a decoration family",
      "src/cm6/extensions/visual/optimal-linebreak.ts": "paragraph layout measurement, not a decoration family",
    };
    const users = srcFiles
      .filter((path) => path !== `${CONSTRUCTS_DIR}view-plugin.ts` && !(path in owners))
      .filter((path) => /isCoalescedVisualTyping\(|restorePersistentVisualPluginState|rememberPersistentVisualPluginState/.test(read(path)));
    expect(users).toEqual([]);
  });

  test("Vim learns what is drawn from the construct registry, not by scanning", () => {
    for (const path of ["aaronnote/vim-lite.ts", "src/cm6/screen-rows.ts"]) {
      const text = read(path);
      expect(text.includes("EditorView.decorations"), `${path} reads decorations`).toBe(false);
      expect(/scanInlineMathRanges|getBlockMathRanges|@lezer\/markdown/.test(text), `${path} rescans Markdown`).toBe(false);
    }
    expect(srcFiles.concat(["aaronnote/vim-lite.ts"]).filter((path) => read(path).includes("vimAtomic"))).toEqual([]);
  });
});

/** Every widget replacement drawn in VIEW, as `from:to` with the widget's class. */
function drawnReplacements(view: EditorView): Map<string, string> {
  const drawn = new Map<string, string>();
  for (const source of view.state.facet(EditorView.decorations)) {
    const set: DecorationSet = typeof source === "function" ? source(view) : source;
    set.between(0, view.state.doc.length, (from, to, value) => {
      const widget = (value.spec as { widget?: { constructor: { name: string } } }).widget;
      if (from < to && widget) {
        drawn.set(`${from}:${to}`, widget.constructor.name);
      }
    });
  }
  return drawn;
}

/** A note exercising every construct family. */
const SAMPLE_NOTE = [
  "A footnote[^1] and a block ref ((019a0000-0000-7000-8000-000000000000)) here {#019a0000-0000-7000-8000-0000000000aa}",
  "",
  "Inline math \\(x^2 + y\\) and an image ![alt](pic.png) in text.",
  "",
  "- [ ] a task",
  "- [x] a done task",
  "",
  "\\[",
  "E = mc^2",
  "\\]",
  "",
  "| a | b |",
  "|---|---|",
  "| \\(z\\) | 2 |",
  "",
  "[^1]: The note.",
  "",
  "@@lean4 [lemma-tag]",
  "",
  "#+begin theorem Main",
  "Statement with :smile: and a todo @@todo [check this].",
  "#+end theorem",
  "",
  "[toc]",
  "",
  "---",
  "",
  "<div class=\"note\">raw html</div>",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
  "",
  "Tail line.",
].join("\n");

describe("rendered constructs: what is drawn and what the registry reports agree", () => {
  const md = SAMPLE_NOTE;

  test("every construct the registry reports is drawn over exactly its range", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: md });
    try {
      const view = editor.view as unknown as EditorView;
      view.dispatch({ selection: { anchor: md.length } });
      const reported = new Map<string, RenderedConstruct>();
      for (let pos = 0; pos < md.length; pos++) {
        const construct = renderedConstructAt(view, pos);
        if (construct) reported.set(`${construct.from}:${construct.to}`, construct);
      }
      const kinds = new Set([...reported.values()].map((construct) => construct.kind));
      for (const kind of [
        "footnote", "block-ref", "block-anchor", "math", "image", "task-marker", "table", "lean-placeholder",
        "block-extra", "inline-command", "html-block", "inline-markup", "diagram",
      ]) {
        expect(kinds, `the sample note exercises ${kind}`).toContain(kind);
      }
      const drawn = drawnReplacements(view);
      const undrawn = [...reported.entries()]
        .filter(([key]) => !drawn.has(key))
        .map(([key, construct]) => `${construct.kind} ${key} ${JSON.stringify(md.slice(construct.from, construct.to))}`);
      expect(undrawn, "the registry reports a construct no widget draws").toEqual([]);
      // And the other way: nothing is drawn over source that the registry,
      // and so Vim and the caret, do not know about.
      const coveredBy = (from: number, to: number) => [...reported.values()]
        .some((construct) => construct.from <= from && to <= construct.to);
      const unreported = [...drawn.entries()]
        .filter(([key]) => { const [from, to] = key.split(":").map(Number); return !coveredBy(from!, to!); })
        .map(([key, widget]) => `${widget} ${key} ${JSON.stringify(md.slice(...key.split(":").map(Number) as [number, number]))}`);
      expect(unreported, "a widget is drawn over source the registry does not report").toEqual([]);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});

describe("the caret is never hidden", () => {
  // Whatever moves the caret — arrows in Insert mode, Vim motions in Normal
  // mode — it never rests strictly inside a construct that is still drawn:
  // either the construct opens for it, or the caret lands on its edge.
  // Judged by what is on screen — the widgets drawn over source — not by the
  // registry's opinion, so drift between the two cannot hide a caret.
  const hiddenAt = (view: EditorView): string | null => {
    const head = view.state.selection.main.head;
    for (const [key, widget] of drawnReplacements(view)) {
      const [from, to] = key.split(":").map(Number) as [number, number];
      if (head > from && head < to) return `${widget} ${key} at ${head}`;
    }
    return null;
  };

  test("arrow keys in Insert mode", async () => {
    const { runEditorMovement } = await import("../src/cm6/input-commands.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: SAMPLE_NOTE });
    const view = editor.view as unknown as EditorView;
    const hidden = new Set<string>();
    const stuck: number[] = [];
    try {
      const sweep = (key: "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp", until: (head: number) => boolean) => {
        for (let step = 0; step < SAMPLE_NOTE.length + 10 && !until(view.state.selection.main.head); step++) {
          const before = view.state.selection.main.head;
          runEditorMovement(view, key);
          const at = hiddenAt(view);
          if (at) hidden.add(`${key} ${at}`);
          if (view.state.selection.main.head === before && (key === "ArrowRight" || key === "ArrowLeft")) stuck.push(before);
          if (view.state.selection.main.head === before) break;
        }
      };
      view.dispatch({ selection: { anchor: 0 } });
      sweep("ArrowRight", (head) => head >= view.state.doc.length);
      sweep("ArrowLeft", (head) => head === 0);
      sweep("ArrowDown", (head) => head >= view.state.doc.length);
      sweep("ArrowUp", (head) => head === 0);
      expect([...hidden]).toEqual([]);
      expect(stuck.filter((head) => head > 0 && head < view.state.doc.length)).toEqual([]);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("Vim motions in Normal mode", async () => {
    const { createVimLite } = await import("../aaronnote/vim-lite.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: SAMPLE_NOTE });
    const vim = createVimLite(editor, host);
    const view = editor.view as unknown as EditorView;
    const hidden = new Set<string>();
    try {
      vim.setMode("normal");
      editor.setSelection(0, 0);
      vim.syncSelectionFromEditor();
      for (const [key, times] of [["l", 400], ["h", 400], ["w", 120], ["b", 120], ["e", 120], ["j", 40], ["k", 40]] as const) {
        for (let step = 0; step < times; step++) {
          vim.handleKey({ key });
          const at = hiddenAt(view);
          if (at) hidden.add(`${key} ${at}`);
        }
      }
      expect([...hidden]).toEqual([]);
    } finally {
      vim.destroy();
      editor.destroy();
      host.remove();
    }
  });
});

describe("deleting beside an object takes it whole", () => {
  // Backspace after an object (Delete before one) selects the whole object;
  // the next press removes it. Deleting one character of its source broke the
  // object into text, often while it was still drawn. Judged for every widget
  // drawn over source: either the press selects exactly the object, or the
  // widget is structure, edited as text.
  test("Backspace and Delete in Insert mode", async () => {
    const { runEditorDelete } = await import("../src/cm6/input-commands.ts");
    const { objectAtEdge } = await import("../src/cm6/extensions/visual/constructs/index.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: SAMPLE_NOTE });
    const view = editor.view as unknown as EditorView;
    const broken: string[] = [];
    try {
      view.dispatch({ selection: { anchor: SAMPLE_NOTE.length } });
      const objects = [...drawnReplacements(view).entries()].filter(([key]) => {
        const [from, to] = key.split(":").map(Number) as [number, number];
        return objectAtEdge(view, to, "before")?.from === from;
      });
      expect(objects.length, "the sample note draws objects").toBeGreaterThan(8);
      for (const [key, widget] of objects) {
        const [from, to] = key.split(":").map(Number) as [number, number];
        for (const [at, direction] of [[to, "backward"], [from, "forward"]] as const) {
          view.dispatch({ selection: { anchor: at } });
          runEditorDelete(view, direction);
          const { from: selFrom, to: selTo } = view.state.selection.main;
          if (view.state.doc.toString() !== SAMPLE_NOTE || selFrom !== from || selTo !== to) {
            broken.push(`${widget} ${key} ${direction}`);
          }
          runEditorDelete(view, direction);
          const removed = SAMPLE_NOTE.slice(0, from) + SAMPLE_NOTE.slice(to);
          if (view.state.doc.toString() !== removed) broken.push(`${widget} ${key} ${direction}: second press`);
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: SAMPLE_NOTE } });
        }
      }
      expect(broken).toEqual([]);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
