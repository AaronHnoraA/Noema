import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { createSlideDeckController, slideRangesFromState } from "../aaronnote/slide-deck.ts";
import {
  createRevealSlide,
  createSlidePresentation,
  sourceSlideIndexFromReveal,
} from "../aaronnote/slide-presentation.ts";
import { jupyterCellsFromState } from "../src/cm6/extensions/visual/widgets/block-extras.ts";
import { tocIndexExtension } from "../src/cm6/toc-index.ts";
import type { Editor } from "../src/lib.ts";

describe("slides deck ranges", () => {
  test("uses the actual Reveal slide marker before ambiguous stack coordinates", () => {
    const sourceSlide = document.createElement("section");
    sourceSlide.dataset.aaronnoteSlideIndex = "2";
    const authoredNestedSlide = document.createElement("section");
    sourceSlide.append(authoredNestedSlide);

    expect(sourceSlideIndexFromReveal(authoredNestedSlide, [
      { h: 0, v: 0 },
      { h: 1, v: 0 },
      { h: 1, v: 0 },
    ], { h: 1, v: 0 })).toBe(2);
  });

  test("falls back to Reveal coordinates while no marked page is available", () => {
    expect(sourceSlideIndexFromReveal(null, [
      { h: 0, v: 0 },
      { h: 1, v: 0 },
      { h: 1, v: 1 },
    ], { h: 1, v: 1 })).toBe(2);
  });

  test("uses the shared presentation pipeline for headingless ordinary Markdown", () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    document.body.append(root);
    const presentation = createSlidePresentation({
      root,
      markdown: "An ordinary note without headings.",
      wholeDocumentFallback: true,
    });

    expect(root.querySelectorAll(".reveal .slides > section")).toHaveLength(1);
    expect(root.querySelector(".aaronnote-rendered-slide")?.textContent).toContain("ordinary note");
    presentation.destroy();
  });

  test("keeps ordinary Markdown content after Reveal initializes", async () => {
    const root = document.createElement("div");
    root.tabIndex = -1;
    document.body.append(root);
    const presentation = createSlidePresentation({
      root,
      markdown: "# Visible title\n\nVisible body",
      wholeDocumentFallback: true,
    });

    await vi.waitFor(() => expect(presentation.getReveal()).not.toBeNull());
    const current = presentation.getReveal()!.getCurrentSlide();
    expect(current.textContent).toContain("Visible title");
    expect(current.textContent).toContain("Visible body");
    expect(current.classList.contains("present")).toBe(true);

    presentation.update("# Updated title\n\nUpdated body");
    await vi.waitFor(() => {
      const updated = presentation.getReveal()?.getCurrentSlide();
      expect(updated?.textContent).toContain("Updated body");
      expect(updated?.classList.contains("present")).toBe(true);
    });
    presentation.destroy();
  });

  test("reuses canonical inherited Jupyter cell descriptors for slides", () => {
    const state = EditorState.create({
      doc: [
        "@@cell(python, lecture) [first]",
        "@@cell() [second]",
      ].join("\n"),
      extensions: [tocIndexExtension],
    });
    const cells = jupyterCellsFromState(state, "/notes/deck.md");

    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual(expect.objectContaining({ cellId: "first", language: "python", kernel: "python3", session: "lecture" }));
    expect(cells[1]).toEqual(expect.objectContaining({ cellId: "second", language: "python", kernel: "python3", session: "lecture" }));
  });

  test("maps H1 to horizontal pages and H2 to vertical pages", () => {
    const doc = [
      "#+begin meta",
      "kind: slides",
      "#+end meta",
      "",
      "# First",
      "intro",
      "## Detail",
      "",
      "# Second",
      "tail",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: [tocIndexExtension] });
    const slides = slideRangesFromState(state);

    expect(slides.map((slide) => ({ title: slide.title, parentTitle: slide.parentTitle, vertical: slide.vertical, from: doc.slice(slide.from, slide.from + 2), body: doc.slice(slide.from, slide.to) }))).toEqual([
      expect.objectContaining({ title: "First", parentTitle: "First", vertical: false, from: "# ", body: "# First\nintro\n" }),
      expect.objectContaining({ title: "Detail", parentTitle: "First", vertical: true, from: "##", body: "## Detail\n\n" }),
      expect.objectContaining({ title: "Second", parentTitle: "Second", vertical: false, from: "# ", body: "# Second\ntail" }),
    ]);
  });

  test("does not turn fenced heading-looking source into a slide", () => {
    const state = EditorState.create({
      doc: "# Real\n```md\n# Not a slide\n```\n# Last",
      extensions: [tocIndexExtension],
    });
    expect(slideRangesFromState(state).map((slide) => slide.title)).toEqual(["Real", "Last"]);
  });

  test("keeps TOC-omitted H2 inside its current slide", () => {
    const doc = [
      "# Parent",
      "intro",
      "## Local detail <!-- omit in toc -->",
      "same page",
      "## Vertical",
      "below",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: [tocIndexExtension] });
    const slides = slideRangesFromState(state);

    expect(slides).toHaveLength(2);
    expect(doc.slice(slides[0]!.from, slides[0]!.to)).toContain("## Local detail");
    expect(slides[1]).toEqual(expect.objectContaining({ title: "Vertical", parentTitle: "Parent", vertical: true }));
  });
});

describe("slides deck controller", () => {
  let storedTheme: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    storedTheme = null;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => key === "aaronnote.slides.theme" ? storedTheme : null,
        setItem: (key: string, value: string) => {
          if (key === "aaronnote.slides.theme") storedTheme = value;
        },
      },
    });
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setupController(selectionFrom = 9) {
    const state = EditorState.create({
      doc: "# First\nbody text\n# Second\ntail",
      extensions: [tocIndexExtension],
    });
    let selection = { from: selectionFrom, to: selectionFrom };
    const setMarkdownSelection = vi.fn((from: number, to = from) => {
      selection = { from, to };
    });
    const editor = {
      view: { state },
      getMarkdownSelection: () => selection,
      setMarkdownSelection,
      getMarkdownLength: () => state.doc.length,
      getMarkdown: () => state.doc.toString(),
      markdownBetween: (from: number, to: number) => state.doc.sliceString(from, to),
      revealCursor: vi.fn(),
      focus: vi.fn(),
    } as unknown as Editor;
    const root = document.createElement("main");
    const host = document.createElement("section");
    root.appendChild(host);
    document.body.appendChild(root);
    const controller = createSlideDeckController({
      root,
      host,
      editor,
      getCurrentFile: () => "/notes/deck.md",
    });
    return { controller, editor, root, host, setMarkdownSelection, selection: () => selection };
  }

  test("keeps editor selection independent from presentation navigation", () => {
    const setup = setupController();
    setup.controller.sync("slides");
    setup.controller.toggleView();
    setup.controller.sync("slides");

    expect(setup.controller.isRevealView()).toBe(false);
    expect(setup.setMarkdownSelection).not.toHaveBeenCalled();
    expect(setup.selection()).toEqual({ from: 9, to: 9 });
    expect(setup.editor.revealCursor).not.toHaveBeenCalled();
    expect(setup.editor.focus).toHaveBeenCalledTimes(1);
    setup.controller.destroy();
  });

  test("toggles and remembers the presentation palette without rebuilding the editor", () => {
    const setup = setupController();
    setup.controller.sync("slides");
    const viewer = setup.root.querySelector<HTMLElement>(".aaronnote-reveal-view")!;

    expect(setup.controller.getTheme()).toBe("dark");
    expect(viewer.dataset.theme).toBe("dark");
    expect(setup.root.querySelector(".aaronnote-deck-chrome")).toBeNull();
    expect(setup.controller.toggleTheme()).toBe("light");
    expect(viewer.dataset.theme).toBe("light");
    expect(setup.root.dataset.slidesTheme).toBe("light");
    expect(window.localStorage.getItem("aaronnote.slides.theme")).toBe("light");
    expect(setup.setMarkdownSelection).not.toHaveBeenCalled();
    setup.controller.destroy();

    const restored = setupController();
    expect(restored.controller.getTheme()).toBe("light");
    restored.controller.destroy();
  });

  test("renders the H1 and fenced code with shared syntax highlighting", () => {
    const markdown = "# Code\n\n```python\ndef answer():\n    return 42\n```";
    const section = createRevealSlide(markdown, 0);
    const code = section.querySelector("code")!;

    expect(section.querySelector("h1")?.textContent).toBe("Code");
    expect(code.textContent).toContain("def answer");
    expect(code.querySelector(".code-token-keyword")).not.toBeNull();
  });

  test("keeps Noema identity and styling on authored Reveal sections", () => {
    const section = createRevealSlide([
      "# Native",
      "@@slides(reveal) []",
      '<section class="authored" data-background-color="#fff" data-aaronnote-slide-index="99">Hello</section>',
    ].join("\n"), 3);

    expect(section.classList.contains("aaronnote-raw-reveal-slide")).toBe(true);
    expect(section.classList.contains("authored")).toBe(true);
    expect(section.dataset.aaronnoteSlideIndex).toBe("3");
    expect(section.dataset.backgroundColor).toBe("#fff");
    expect(section.querySelector(":scope > h1")?.textContent).toBe("Native");
  });
});
