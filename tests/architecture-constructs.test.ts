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
    // A surface that edits text outside CM6 (a table cell input, a MathLive
    // field) calls `markEmbeddedSurface`; checks use the exported selectors.
    const spelled = srcFiles.concat(sourceFiles("aaronnote"))
      .filter((path) => path !== "src/cm6/embedded-surface.ts")
      .filter((path) => /data-aaronnote-vim|aaronnoteVim/.test(read(path)));
    expect(spelled).toEqual([]);
  });

  test("table cells are edited as document text, not by an editor of their own", () => {
    // A cell editor of its own is a second caret, key map, completion and
    // undo; tables open their source for the main editor instead.
    const preview = read("src/cm6/live-preview.ts");
    expect(/createElement\(["']input["']\)|mountVisualTexInlineEditor/.test(preview)).toBe(false);
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

  test("Vim learns what is drawn from the construct registry, not by scanning", () => {
    for (const path of ["aaronnote/vim-lite.ts", "aaronnote/vim-rows.ts"]) {
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

describe("rendered constructs: what is drawn and what the registry reports agree", () => {
  const md = [
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
