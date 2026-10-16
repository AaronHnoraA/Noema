import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { ChangeSet, Text } from "@codemirror/state";

import {
  filterClassMacros,
  macroArity,
  noteMacroBlockEdit,
  noteMacroSpec,
  parseNoteLocalMacros,
  serializeMacroDefinitions,
} from "../shared/note-macros.mjs";
import {
  loadMacroSourceFiles,
  loadUserKatexMacros,
  normalizeUserKatexMacros,
  saveUserKatexMacros,
} from "../server/lib/user-katex-macros.mjs";
import { createNoteMacroRuntime } from "../aaronnote/note-macros-runtime.ts";
import { macroInsertTemplate, macroPaletteItems, validateMacroDraft } from "../aaronnote/live-tex-macro-panel.ts";

const NOTE = [
  "#+begin meta",
  "title: Search to decision",
  "macros-from: ../assignment.cls, notation.sty",
  "#+begin summary",
  "macros-from: inside-summary.cls",
  "#+end summary",
  "#+begin macros",
  "\\newcommand{\\Mon}{\\operatorname{Mon}}",
  "\\newcommand{\\pce}[1]{\\mathsf{PCE}(#1)}",
  "#+end macros",
  "#+end meta",
  "",
  "# Body",
  "#+begin macros",
  "\\newcommand{\\Body}{x}",
  "#+end macros",
].join("\n");

describe("note macro syntax", () => {
  test("reads macros-from and the block from the meta head only", () => {
    const spec = noteMacroSpec(NOTE)!;
    expect(spec.from).toEqual(["../assignment.cls", "notation.sty"]);
    expect(spec.text).toContain("\\Mon");
    expect(spec.text).not.toContain("\\Body");
    expect(parseNoteLocalMacros(NOTE).macros).toEqual({
      "\\Mon": "\\operatorname{Mon}",
      "\\pce": "\\mathsf{PCE}(#1)",
    });
  });

  test("a note without meta, or with meta below the preamble, has no layers", () => {
    expect(noteMacroSpec("# Title\n\n#+begin macros\n\\newcommand{\\x}{y}\n#+end macros\n")).toBeNull();
    expect(noteMacroSpec(`${"text\n".repeat(20)}#+begin meta\n#+end meta\n`)).toBeNull();
  });

  test("the block edit replaces, inserts, creates and removes", () => {
    const replaced = noteMacroBlockEdit(NOTE, { "\\Mon": "\\mathrm{Mon}" })!;
    const after = NOTE.slice(0, replaced.from) + replaced.insert + NOTE.slice(replaced.to);
    expect(parseNoteLocalMacros(after).macros).toEqual({ "\\Mon": "\\mathrm{Mon}" });

    const bare = "#+begin meta\ntitle: x\n#+end meta\n\nbody";
    const inserted = noteMacroBlockEdit(bare, { "\\a": "#1+#2" })!;
    const withBlock = bare.slice(0, inserted.from) + inserted.insert + bare.slice(inserted.to);
    expect(withBlock).toContain("#+begin macros\n\\newcommand{\\a}[2]{#1+#2}\n#+end macros\n#+end meta");

    const plain = "# Note\n";
    const created = noteMacroBlockEdit(plain, { "\\a": "b" })!;
    expect(created.insert + plain).toMatch(/^#\+begin meta\n#\+begin macros\n\\newcommand\{\\a\}\{b\}\n#\+end macros\n#\+end meta\n\n# Note/);

    const removed = noteMacroBlockEdit(withBlock, {})!;
    expect(withBlock.slice(0, removed.from) + withBlock.slice(removed.to)).toBe(bare);
    expect(noteMacroBlockEdit(after, { "\\Mon": "\\mathrm{Mon}" })).toBeNull();
  });

  test("class files keep notation and drop internals", () => {
    expect(filterClassMacros({ "\\R": "\\mathbb{R}", "\\@title": "x", "\\foo": "\\@bar", "\\,": "x" }))
      .toEqual({ "\\R": "\\mathbb{R}" });
  });

  test("arity and serialization round-trip through the shared parser", () => {
    expect(macroArity("#1 and #3")).toBe(3);
    const text = serializeMacroDefinitions({ "\\ip": "\\langle #1,#2\\rangle", "\\R": "\\mathbb{R}" });
    expect(text).toBe("\\newcommand{\\ip}[2]{\\langle #1,#2\\rangle}\n\\newcommand{\\R}{\\mathbb{R}}");
  });
});

describe("user macro file", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ""; });

  test("saves to the Noema config directory and reads back", async () => {
    dir = await mkdtemp(join(tmpdir(), "noema-macros-"));
    const options = { configDir: dir };
    expect((await loadUserKatexMacros(options)).macros).toEqual({});
    const saved = await saveUserKatexMacros({ "\\Mon": "\\operatorname{Mon}", "\\abs": "\\lvert #1\\rvert" }, options);
    expect(saved.macros).toEqual({ "\\Mon": "\\operatorname{Mon}", "\\abs": "\\lvert #1\\rvert" });
    const text = await readFile(join(dir, "katex-macros.tex"), "utf8");
    expect(text).toContain("\\newcommand{\\abs}[1]{\\lvert #1\\rvert}");
  });

  test("rejects names, newlines and unbalanced bodies", () => {
    expect(() => normalizeUserKatexMacros({ "abs": "x" })).toThrow(/Invalid macro name/);
    expect(() => normalizeUserKatexMacros({ "\\a": "x\ny" })).toThrow(/one line/);
    expect(() => normalizeUserKatexMacros({ "\\a": "{x" })).toThrow(/Unbalanced/);
    expect(validateMacroDraft("\\a", "}{")).toBe("花括号不配对");
  });

  test("macros-from accepts only TeX sources and reports read failures per file", async () => {
    const result = await loadMacroSourceFiles(["a.cls", "b.md", "missing.sty"], async (name) => {
      if (name === "a.cls") return "\\newcommand{\\F}{\\mathbb{F}}\\def\\@x{y}";
      throw new Error("ENOENT");
    });
    expect(result.macros).toEqual({ "\\F": "\\mathbb{F}" });
    expect(result.errors.map((error) => error.file)).toEqual(["b.md", "missing.sty"]);
  });
});

describe("note macro runtime", () => {
  function runtime() {
    const installs: Record<string, string>[] = [];
    const rerender = vi.fn();
    const loadNote = vi.fn(async (): Promise<{
      project: Record<string, string>;
      files: string[];
      errors: { file: string; message: string }[];
    }> => ({ project: { "\\P": "\\mathsf{P}" }, files: ["../assignment.cls"], errors: [] }));
    const api = createNoteMacroRuntime({
      loadGlobal: async () => ({ shared: { "\\R": "\\mathbb{R}", "\\Mon": "shared" }, user: { macros: { "\\U": "u" } } }),
      saveUser: async (macros) => ({ shared: { "\\R": "\\mathbb{R}" }, user: { macros } }),
      loadNote,
      install: (macros) => installs.push(macros),
      rerender,
    });
    return { api, installs, rerender, loadNote };
  }

  test("installs every layer before the note paints, local winning", async () => {
    const { api, installs, rerender } = runtime();
    await api.loadGlobal();
    await api.prepare("/notes/a.md", NOTE);
    expect(installs.at(-1)).toMatchObject({ "\\R": "\\mathbb{R}", "\\U": "u", "\\P": "\\mathsf{P}", "\\Mon": "\\operatorname{Mon}" });
    expect(rerender).not.toHaveBeenCalled();
  });

  test("adopting the prepared note neither refetches nor re-renders", async () => {
    const { api, installs, rerender, loadNote } = runtime();
    await api.loadGlobal();
    await api.prepare("/notes/a.md", NOTE);
    const count = installs.length;
    api.adopt("/notes/a.md", NOTE);
    expect(loadNote).toHaveBeenCalledTimes(1);
    expect(installs).toHaveLength(count);
    expect(rerender).not.toHaveBeenCalled();
  });

  test("a failed project refresh retains the last usable definitions", async () => {
    const { api, installs, rerender, loadNote } = runtime();
    await api.loadGlobal();
    await api.prepare("/notes/a.md", NOTE);
    const installed = installs.length;
    loadNote.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await api.reloadProject();
    expect(api.layers().project).toEqual({ "\\P": "\\mathsf{P}" });
    expect(api.layers().errors.at(-1)?.message).toBe("temporarily unavailable");
    expect(installs).toHaveLength(installed);
    expect(rerender).not.toHaveBeenCalled();
  });

  test("an incomplete project refresh retains the last complete definitions", async () => {
    const { api, installs, rerender, loadNote } = runtime();
    await api.loadGlobal();
    await api.prepare("/notes/a.md", NOTE);
    const installed = installs.length;
    loadNote.mockResolvedValueOnce({ project: {}, files: [], errors: [{ file: "notation.sty", message: "missing" }] });
    await api.reloadProject();
    expect(api.layers().project).toEqual({ "\\P": "\\mathsf{P}" });
    expect(api.layers().errors.at(-1)?.message).toBe("missing");
    expect(installs).toHaveLength(installed);
    expect(rerender).not.toHaveBeenCalled();
  });

  test("edits outside the meta block cost nothing; a macro edit re-renders once", async () => {
    vi.useFakeTimers();
    try {
      const { api, rerender, loadNote } = runtime();
      await api.loadGlobal();
      await api.prepare("/notes/a.md", NOTE);
      let doc = Text.of(NOTE.split("\n"));
      const bodyAt = NOTE.indexOf("# Body") + 6;
      for (const text of [" t", "e", "x", "t"]) {
        const bodyEdit = ChangeSet.of({ from: bodyAt, insert: text }, doc.length);
        doc = bodyEdit.apply(doc);
        api.noteEdited(bodyEdit, doc);
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(loadNote).toHaveBeenCalledTimes(1);
      expect(rerender).not.toHaveBeenCalled();

      const at = doc.toString().indexOf("\\operatorname{Mon}");
      const macroEdit = ChangeSet.of({ from: at, to: at + "\\operatorname".length, insert: "\\mathrm" }, doc.length);
      doc = macroEdit.apply(doc);
      api.noteEdited(macroEdit, doc);
      api.noteEdited(ChangeSet.empty(doc.length), doc);
      await vi.advanceTimersByTimeAsync(1000);
      expect(rerender).toHaveBeenCalledTimes(1);
      expect(api.layers().local["\\Mon"]).toBe("\\mathrm{Mon}");
    } finally {
      vi.useRealTimers();
    }
  });

  test("palette items expose every layer with argument placeholders", async () => {
    const { api } = runtime();
    await api.loadGlobal();
    await api.prepare("/notes/a.md", NOTE);
    const items = macroPaletteItems(api.layers());
    expect(items.find((item) => item.label === "\\pce")?.latex).toBe("\\pce{\\placeholder{}}");
    expect(items.find((item) => item.label === "\\Mon")?.name).toBe("宏 · 本笔记");
    expect(macroInsertTemplate("\\ip", "#1,#2")).toBe("\\ip{\\placeholder{}}{\\placeholder{}}");
  });
});
