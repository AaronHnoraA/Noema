import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
// The package's Node export is intentionally SSR-only; exercise the browser
// constructor used by LiveTeX rather than that conditional export.
// @ts-expect-error MathLive does not publish declarations for this direct bundle path.
import { MathfieldElement } from "../node_modules/mathlive/mathlive.mjs";
import {
  advanceVisualTexNavigation,
  applyVisualTexCompletionTemplate,
  createNoemaMathfield,
  initializeNoemaMathfield,
  insertVisualTexNaturalSpace,
  insertVisualTexInlineRow,
  normalizeVisualTexMathLiveOutput,
  requestVisualTexSnippetBoundaryHandoff,
  revealVisualTexCaretHorizontally,
  selectAllVisualTexMathfield,
  visualTexCompletionPrefix,
  visualTexMathfieldLatex,
  visualTexMathBottomLeftInsets,
  visualTexMathfieldTypedText,
} from "../src/cm6/extensions/visual/widgets/visualtex-inline.ts";
import { mathLiveSnippetTemplate } from "../aaronnote/snippets.ts";

describe("LiveTeX custom macro writeback", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("fills a Noema macro snippet without persisting its stale placeholder arguments", () => {
    const field = new MathfieldElement();
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    initializeNoemaMathfield(field, "", {
      "\\ket": String.raw`\left|#1\right\rangle`,
    });

    expect(field.insert(String.raw`\ket{#?}\,asd`, {
      format: "latex",
      insertionMode: "replaceAll",
      selectionMode: "placeholder",
      feedback: false,
    })).toBe(true);
    expect(field.insert("sad", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);

    const saved = visualTexMathfieldLatex(field);
    const cachedMacroInvocation = field.getValue("latex-without-placeholders");
    expect(saved).not.toBe(cachedMacroInvocation);
    expect(cachedMacroInvocation).not.toContain("sad");
    expect(saved).not.toContain("#?");
    expect(saved).not.toContain("placeholder");
    expect(saved).toContain("sad");
    expect(saved).toContain("asd");
  });

  test("constructs LiveTeX with every MathLive-native snippet path disabled", async () => {
    const field = createNoemaMathfield(MathfieldElement);
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    await Promise.resolve();

    expect(field.inlineShortcuts).toEqual({});
    expect(field.popoverPolicy).toBe("off");
    expect(field.environmentPopoverPolicy).toBe("off");
    expect(field.onInlineShortcut(field, "bra")).toBe("");
  });

  test("prevents MathLive selection commands from scrolling the page host", () => {
    const field = createNoemaMathfield(MathfieldElement);
    patchHappyDomMathfieldHostSelector(field);
    let pageScrolls = 0;
    Object.defineProperty(field, "scrollIntoView", {
      configurable: true,
      value: () => { pageScrolls += 1; },
    });
    document.body.append(field);
    initializeNoemaMathfield(field, "abcdef", {});
    field.position = 0;

    expect(field.executeCommand("moveToMathfieldEnd")).toBe(true);
    expect(pageScrolls).toBe(0);
  });

  test("reveals the caret only by scrolling the formula horizontally", () => {
    const visual = document.createElement("div");
    visual.dataset.cmVisualMath = "active";
    const field = document.createElement("div");
    const viewport = document.createElement("div");
    const caret = document.createElement("span");
    viewport.append(caret);
    field.append(viewport);
    visual.append(field);
    document.body.append(visual);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
    });
    viewport.scrollLeft = 0;
    viewport.scrollTop = 37;
    viewport.getBoundingClientRect = () => ({
      left: 10, right: 110, top: 20, bottom: 60, width: 100, height: 40,
      x: 10, y: 20, toJSON: () => ({}),
    });
    caret.getBoundingClientRect = () => ({
      left: 145, right: 147, top: 30, bottom: 50, width: 2, height: 20,
      x: 145, y: 30, toJSON: () => ({}),
    });
    const scrollIntoView = Object.assign(() => {
      throw new Error("page-level scrollIntoView must not run");
    }, { called: false });
    Object.defineProperty(caret, "scrollIntoView", { configurable: true, value: scrollIntoView });

    revealVisualTexCaretHorizontally(
      field as unknown as InstanceType<typeof MathfieldElement>,
      caret,
    );

    expect(viewport.scrollLeft).toBeGreaterThan(0);
    expect(viewport.scrollTop).toBe(37);
  });

  test("parses all declared arguments before rendering a Noema macro", () => {
    const field = new MathfieldElement();
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    initializeNoemaMathfield(field, String.raw`\ketbra{a}{b}`, {
      "\\ketbra": String.raw`\left|#1\right\rangle\!\left\langle#2\right|`,
    });

    expect(field.getValue("latex")).toBe(String.raw`\ketbra{a}{b}`);
    expect(field.getValue("latex-expanded")).toContain("a");
    expect(field.getValue("latex-expanded")).toContain("b");
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\ketbra{a}{b}`);
  });

  test("writes an edited bra snippet back as the Noema macro, not its expansion", () => {
    const field = new MathfieldElement();
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    initializeNoemaMathfield(field, "qbra", {
      "\\bra": String.raw`\left\langle#1\right|`,
    });
    const template = mathLiveSnippetTemplate({
      key: "qbra",
      mode: "tex-mode",
      body: "\\bra{${1:\\psi}}$0",
    }, "bra-compact-test");
    expect(applyVisualTexCompletionTemplate(field, "qbra", template, 4)).toBe(true);
    field.insert("v", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });

    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\bra{v}`);
    expect(visualTexMathfieldLatex(field)).not.toContain(String.raw`\left`);
  });

  test("does not reuse cached arguments after editing an existing macro body", () => {
    const field = new MathfieldElement();
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    const source = String.raw`\ket{sad}\,asd`;
    const macros = { "\\ket": String.raw`\left|#1\right\rangle` };
    initializeNoemaMathfield(field, source, macros);
    const lastOffset = field.lastOffset;

    let edited = false;
    for (let position = 0; position <= lastOffset && !edited; position++) {
      initializeNoemaMathfield(field, source, macros);
      field.position = position;
      field.insert("i", {
        format: "latex",
        insertionMode: "replaceSelection",
        selectionMode: "after",
        feedback: false,
      });
      if (!field.getValue("latex-expanded").includes("said")) continue;

      const cachedMacroInvocation = field.getValue("latex-without-placeholders");
      const saved = visualTexMathfieldLatex(field);
      expect(cachedMacroInvocation).toBe(source);
      expect(saved).not.toBe(cachedMacroInvocation);
      expect(saved).toContain("said");
      edited = true;
    }

    expect(edited).toBe(true);
  });

  test("does not roll back an edited macro when a later snippet removes its prompts", () => {
    const field = new MathfieldElement();
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    const source = String.raw`\ket{sad}+frac`;
    const macros = { "\\ket": String.raw`\left|#1\right\rangle` };
    initializeNoemaMathfield(field, source, macros);

    let edited = false;
    for (let position = 0; position <= field.lastOffset && !edited; position++) {
      initializeNoemaMathfield(field, source, macros);
      field.position = position;
      field.insert("i", {
        format: "latex",
        insertionMode: "replaceSelection",
        selectionMode: "after",
        feedback: false,
      });
      edited = field.getValue("latex-expanded").includes("said");
    }
    expect(edited).toBe(true);
    // The mounted editor snapshots every input before company is used.
    expect(visualTexMathfieldLatex(field)).toContain("said");
    field.position = field.lastOffset;

    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "macro-then-frac-test");
    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(advanceVisualTexNavigation(field, false)).toBe("final");

    const saved = visualTexMathfieldLatex(field);
    expect(saved).toContain("said");
    expect(saved).toContain(String.raw`\frac{a}{b}`);
    expect(saved).not.toContain(String.raw`\ket{sad}`);
    expect(field.getPrompts()).toEqual([]);
  });

  test("keeps a default snippet field editable without mounting a prompt atom", () => {
    const field = createMathfield("mathcal");
    const template = mathLiveSnippetTemplate({
      key: "mathcal",
      mode: "tex-mode",
      body: "\\mathcal{${1:F}}$0",
    }, "mathcal-test");

    expect(applyVisualTexCompletionTemplate(field, "mathcal", template, "mathcal".length)).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(selectedMathfieldLatex(field)).toContain("F");
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\mathcal{F}`);

    field.insert("V", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\mathcal{V}`);
  });

  test("turns a bare LiveTeX tabstop into selected content without mounting placeholder UI", () => {
    const field = createMathfield("sqrt");
    const template = mathLiveSnippetTemplate({
      key: "sqrt",
      mode: "tex-mode",
      body: "\\sqrt{$1}$0",
    }, "empty-sqrt-test");

    expect(applyVisualTexCompletionTemplate(field, "sqrt", template, 4)).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(selectedMathfieldLatex(field)).toMatch(/□|\\square/);
    expect(visualTexMathfieldLatex(field)).toContain(String.raw`\sqrt`);

    field.insert("x", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\sqrt{x}`);
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
  });

  test("uses branch-aware square navigation only when logical snippet anchors are absent", () => {
    const field = createMathfield(String.raw`\frac{□+□}{□}+□`);
    field.position = 0;

    for (let index = 0; index < 4; index++) {
      expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
      expect(selectedMathfieldLatex(field)).toMatch(/□|\\square/);
    }
    expect(advanceVisualTexNavigation(field, false)).toBe("edge");

    field.position = field.lastOffset;
    for (let index = 0; index < 4; index++) {
      expect(advanceVisualTexNavigation(field, true)).toBe("placeholder");
      expect(selectedMathfieldLatex(field)).toMatch(/□|\\square/);
    }
  });

  test("keeps repeated snippet fields mirrored", () => {
    const field = createMathfield("styled");
    const template = mathLiveSnippetTemplate({
      key: "styled",
      mode: "tex-mode",
      body: "\\mathcal{${1:F}}+\\mathsf{${1:F}}$0",
    }, "mirror-test");
    expect(applyVisualTexCompletionTemplate(field, "styled", template, 6)).toBe(true);

    field.insert("V", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\mathcal{V}+\mathsf{V}`);
  });

  test("treats mirrored fields as one edit across completion undo and redo", () => {
    const field = createMathfield("styled");
    const template = mathLiveSnippetTemplate({
      key: "styled",
      mode: "tex-mode",
      body: "\\mathcal{${1:F}}+\\mathsf{${1:F}}$0",
    }, "mirror-undo-test");
    expect(applyVisualTexCompletionTemplate(field, "styled", template, 6)).toBe(true);
    field.insert("V", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\mathcal{V}+\mathsf{V}`);
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    const observedDrafts: string[] = [];
    field.addEventListener("input", () => {
      observedDrafts.push(visualTexMathfieldLatex(field));
    });

    expect(field.executeCommand("undo")).toBe(true);
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\mathcal{F}+\mathsf{F}`);
    expect(observedDrafts.at(-1)).toBe(String.raw`\mathcal{F}+\mathsf{F}`);
    expect(field.executeCommand("redo")).toBe(true);
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\mathcal{V}+\mathsf{V}`);
    expect(observedDrafts.at(-1)).toBe(String.raw`\mathcal{V}+\mathsf{V}`);
  });

  test("navigates snippet fields, then the invisible $0 stop, then clamps at the end", () => {
    const field = createMathfield("frac");
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "frac-test");
    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    expectNoSnippetScaffolding(field);

    const first = [...field.selection.ranges[0]!];
    expect(advanceVisualTexNavigation(field, true)).toBe("snippet-boundary");
    expect(field.selection.ranges[0]).toEqual(first);
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain("b");
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(field.position).toBe(field.lastOffset);
    expect(field.getPrompts()).toEqual([]);
    expect(advanceVisualTexNavigation(field, false)).toBe("boundary");
  });

  test("finishes a nested child before returning to the parent Cmd-bracket order", () => {
    const field = createMathfield("frac");
    const fraction = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "nested-frac-test");
    const radical = mathLiveSnippetTemplate({
      key: "sqrt",
      mode: "tex-mode",
      body: "\\sqrt{${1:x}}$0",
    }, "nested-sqrt-test");

    expect(applyVisualTexCompletionTemplate(field, "frac", fraction, 4)).toBe(true);
    expect(field.insert("sqrt", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);
    expect(applyVisualTexCompletionTemplate(field, "sqrt", radical, 4)).toBe(true);
    expectNoSnippetScaffolding(field);

    expect(field.insert("z", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain("b");
    expect(advanceVisualTexNavigation(field, true)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain(String.raw`\sqrt{z}`);
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");

    expect(field.insert("q", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\frac{\sqrt{z}}{q}`);
    expectNoSnippetScaffolding(field);
  });

  test("navigates nested fields in one snippet and skips children replaced with their parent", () => {
    const field = createMathfield("nested");
    const template = mathLiveSnippetTemplate({
      key: "nested",
      mode: "tex-mode",
      body: "${1:\\frac{${2:a}}{${3:b}}}$0",
    }, "nested-fields-test");

    expect(applyVisualTexCompletionTemplate(field, "nested", template, 6)).toBe(true);
    expect(selectedMathfieldLatex(field)).toContain(String.raw`\frac{a}{b}`);
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain("a");
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain("b");
    expect(advanceVisualTexNavigation(field, true)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain("a");
    expect(advanceVisualTexNavigation(field, true)).toBe("placeholder");
    expect(selectedMathfieldLatex(field)).toContain(String.raw`\frac{a}{b}`);

    expect(field.insert("x", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(visualTexMathfieldLatex(field)).toBe("x");
    expectNoSnippetScaffolding(field);
  });

  test("keeps deep heterogeneous snippet layout free of placeholder atoms", () => {
    const field = createMathfield("layout");
    const template = mathLiveSnippetTemplate({
      key: "layout",
      mode: "tex-mode",
      body: "\\frac{\\sqrt{${1:x}^{${2:n}}}}{\\begin{matrix}${3:a}&${4:b}\\\\${5:c}&${6:d}\\end{matrix}}+\\text{${7:t}}$0",
    }, "heterogeneous-layout-test");

    expect(applyVisualTexCompletionTemplate(field, "layout", template, 6)).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(field.shadowRoot?.querySelector(".ML__prompt-atom")).toBeNull();
    expect(visualTexMathfieldLatex(field)).toContain(String.raw`\frac{\sqrt{x^{n}}}`);
    expect(visualTexMathfieldLatex(field)).toContain(String.raw`\begin{matrix}`);
    expect(visualTexMathfieldLatex(field)).toContain(String.raw`\text{t}`);
  });

  test("supports deeply nested snippets without retaining layout-bearing UI nodes", () => {
    const field = createMathfield("seed");
    for (let depth = 0; depth < 8; depth++) {
      const trigger = depth === 0 ? "seed" : "sqrt";
      if (depth > 0) {
        expect(field.insert(trigger, {
          format: "latex",
          insertionMode: "replaceSelection",
          selectionMode: "after",
          feedback: false,
        })).toBe(true);
      }
      const template = mathLiveSnippetTemplate({
        key: trigger,
        mode: "tex-mode",
        body: "\\sqrt{${1:x}}$0",
      }, `deep-sqrt-${depth}`);
      expect(applyVisualTexCompletionTemplate(field, trigger, template, trigger.length)).toBe(true);
      expectNoSnippetScaffolding(field);
    }

    expect(field.insert("z", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);
    for (let depth = 0; depth < 8; depth++) {
      expect(advanceVisualTexNavigation(field, false)).toBe("final");
    }
    expect(visualTexMathfieldLatex(field)).toBe(
      `${String.raw`\sqrt{`.repeat(8)}z${"}".repeat(8)}`,
    );
    expectNoSnippetScaffolding(field);
  });

  test("retires logical tabstops when the caret leaves a snippet before Cmd-]", () => {
    const field = createMathfield("frac");
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "abandoned-frac-test");
    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    expectNoSnippetScaffolding(field);

    field.executeCommand("moveToMathfieldEnd");
    expect(field.position).toBe(field.lastOffset);
    expect(advanceVisualTexNavigation(field, false)).toBe("boundary");
    expectNoSnippetScaffolding(field);
    expect(visualTexMathfieldLatex(field)).toBe("\\frac{a}{b}");
  });

  test("select all leaves snippet mode before selecting the formula", () => {
    const field = createMathfield("frac");
    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "select-all-frac-test");
    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    expectNoSnippetScaffolding(field);

    selectAllVisualTexMathfield(field);

    expect(field.getPrompts()).toEqual([]);
    expect(field.selection.ranges[0]).toEqual([0, field.lastOffset]);
    expect(visualTexMathfieldLatex(field)).toBe("\\frac{a}{b}");
  });

  test("undo after snippet completion never resurrects editor scaffolding", () => {
    const field = createMathfield("frac");
    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "undo-frac-test");
    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    field.insert("x", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    field.insert("y", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(visualTexMathfieldLatex(field)).toBe("\\frac{x}{y}");

    expect(field.executeCommand("undo")).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(visualTexMathfieldLatex(field)).toBe("\\frac{x}{b}");

    expect(field.executeCommand("redo")).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(visualTexMathfieldLatex(field)).toBe("\\frac{x}{y}");

    expect(field.executeCommand("undo")).toBe(true);
    expect(field.insert("z", {
      format: "latex",
      insertionMode: "insertAfter",
      selectionMode: "after",
      feedback: false,
    })).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("\\frac{x}{bz}");
  });

  test("keeps the real Noema text snippet editable with an invisible $0", () => {
    const field = createMathfield("text");
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    const template = mathLiveSnippetTemplate({
      key: "text",
      mode: "tex-mode",
      body: "\\text{${1:a}}$0",
    }, "text-test");

    expect(applyVisualTexCompletionTemplate(field, "text", template, 4)).toBe(true);
    expectNoSnippetScaffolding(field);
    field.insert("addsdd", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{addsdd}`);

    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expectNoSnippetScaffolding(field);
    expect(field.position).toBe(field.lastOffset);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{addsdd}`);
  });

  test("hands a root boundary to an outer snippet only when it explicitly accepts", () => {
    const owner = document.createElement("div");
    const host = document.createElement("div");
    owner.append(host);
    document.body.append(owner);
    let direction = "";
    const accept = (event: Event): void => {
      direction = (event as CustomEvent<{ direction: string }>).detail.direction;
      event.preventDefault();
    };
    owner.addEventListener("aaronnote:math-snippet-boundary", accept);
    expect(requestVisualTexSnippetBoundaryHandoff(host, false)).toBe(true);
    expect(direction).toBe("forward");

    owner.removeEventListener("aaronnote:math-snippet-boundary", accept);
    expect(requestVisualTexSnippetBoundaryHandoff(host, true)).toBe(false);
  });

  test("undoes and redoes a completed text snippet without restoring editor atoms", () => {
    const field = createMathfield("text");
    const template = mathLiveSnippetTemplate({
      key: "text",
      mode: "tex-mode",
      body: "\\text{${1:a}}$0",
    }, "text-undo-test");
    expect(applyVisualTexCompletionTemplate(field, "text", template, 4)).toBe(true);
    field.insert("abc", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("final");

    expect(field.executeCommand("undo")).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{a}`);

    expect(field.executeCommand("redo")).toBe(true);
    expectNoSnippetScaffolding(field);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{abc}`);
  });

  test("keeps mixed text/math tabstop navigation out of the content undo history", () => {
    const field = createMathfield("mixed");
    const template = mathLiveSnippetTemplate({
      key: "mixed",
      mode: "tex-mode",
      body: "\\text{${1:a}}+\\frac{${2:b}}{c}$0",
    }, "mixed-mode-undo-test");
    expect(applyVisualTexCompletionTemplate(field, "mixed", template, 5)).toBe(true);
    field.insert("x", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    field.insert("y", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{x}+\frac{y}{c}`);

    expect(field.executeCommand("undo")).toBe(true);
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{x}+\frac{b}{c}`);
    expect(field.executeCommand("redo")).toBe(true);
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\text{x}+\frac{y}{c}`);
  });

  test("does not turn structural Space or Cmd-bracket movement into undoable content", () => {
    const fraction = createMathfield(String.raw`x\frac{ab}{cd}z`);
    fraction.position = 2;
    fraction.resetUndo();
    expect(insertVisualTexNaturalSpace(fraction)).toBe("navigate");
    expect(fraction.canUndo()).toBe(false);

    const text = createMathfield(String.raw`\text{ab}+z`);
    const textPosition = Array.from({ length: text.lastOffset + 1 }, (_, position) => position)
      .find((position) => {
        text.position = position;
        return text.mode === "text" && position > 0;
      });
    expect(textPosition).toBeTypeOf("number");
    text.position = textPosition!;
    text.resetUndo();
    expect(advanceVisualTexNavigation(text, false)).toMatch(/^(?:parent|edge)$/);
    expect(text.canUndo()).toBe(false);
  });

  test("lands an invisible $0 after the snippet instead of skipping over following math", () => {
    const field = createMathfield("frac+z");
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    const triggerPosition = Array.from({ length: field.lastOffset + 1 }, (_, position) => position)
      .find((position) => field.getValue(0, position, "latex-without-placeholders") === "frac");
    expect(triggerPosition).toBeTypeOf("number");
    field.position = triggerPosition!;

    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "frac-suffix-test");
    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(field.position).toBeLessThan(field.lastOffset);
    expect(field.getPrompts()).toEqual([]);
    expect(field.getValue(field.position, field.lastOffset, "latex-without-placeholders"))
      .toContain("+z");
    expect(advanceVisualTexNavigation(field, false)).toBe("edge");
    expect(field.position).toBe(field.lastOffset);
    expect(advanceVisualTexNavigation(field, false)).toBe("boundary");
  });

  test("round-trips a two-argument braket snippet as valid KaTeX input", () => {
    const field = new MathfieldElement();
    patchHappyDomMathfieldHostSelector(field);
    document.body.append(field);
    initializeNoemaMathfield(field, "qbr", {
      "\\braket": String.raw`\left\langle#1\middle|#2\right\rangle`,
    });
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    const template = mathLiveSnippetTemplate({
      key: "qbr",
      mode: "tex-mode",
      body: "\\braket{${1:\\phi}}{${2:\\psi}}$0",
    }, "braket-test");
    expect(applyVisualTexCompletionTemplate(field, "qbr", template, 3)).toBe(true);
    visualTexMathfieldLatex(field);

    field.insert("a", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    visualTexMathfieldLatex(field);
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    field.insert("b", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(field.getPrompts()).toEqual([]);

    const saved = visualTexMathfieldLatex(field);
    expect(saved).toBe(String.raw`\braket{a}{b}`);
    expect(saved).not.toContain(String.raw`\left`);
    expect(saved).not.toContain(String.raw`\middle`);
    expect(saved).not.toContain(String.raw`\middle{`);
    expect(saved).not.toContain("placeholder");
  });

  test("leaves text parents structurally and repairs MathLive middle delimiters", () => {
    const field = createMathfield(String.raw`\text{thin}x`);
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    const textPosition = Array.from({ length: field.lastOffset + 1 }, (_, position) => position)
      .find((position) => {
        field.position = position;
        return field.mode === "text" && position > 0;
      });
    expect(textPosition).toBeTypeOf("number");
    field.position = textPosition!;

    expect(advanceVisualTexNavigation(field, false)).toBe("parent");
    expect(field.position).toBeLessThan(field.lastOffset);
    expect(advanceVisualTexNavigation(field, false)).toBe("edge");
    expect(advanceVisualTexNavigation(field, false)).toBe("boundary");
    expect(normalizeVisualTexMathLiveOutput(
      String.raw`\left\langle a\middle{|}b\right\rangle`,
    )).toBe(String.raw`\left\langle a\middle|b\right\rangle`);
  });

  test("leaves a trailing text parent before clamping at the formula root", () => {
    const field = createMathfield(String.raw`\text{thin}`);
    field.addEventListener("move-out", (event: Event) => event.preventDefault());
    expect(field.position).toBe(field.lastOffset);
    expect(field.mode).toBe("text");

    expect(advanceVisualTexNavigation(field, false)).toBe("parent");
    expect(field.position).toBe(field.lastOffset);
    expect(field.mode).toBe("math");
    expect(advanceVisualTexNavigation(field, false)).toBe("boundary");
  });

  test("special-cases operator and natural-text parents as one navigation family", () => {
    for (const latex of [
      String.raw`\text{plain}`,
      String.raw`\textrm{plain}`,
      String.raw`\textsf{sans}`,
      String.raw`\texttt{mono}`,
      String.raw`\textbf{bold}`,
      String.raw`\textmd{medium}`,
      String.raw`\textit{italic}`,
      String.raw`\textup{up}`,
      String.raw`\textnormal{normal}`,
      String.raw`\mbox{box}`,
    ]) {
      const field = createMathfield(`${latex}+z`);
      field.addEventListener("move-out", (event: Event) => event.preventDefault());
      const textPosition = Array.from({ length: field.lastOffset + 1 }, (_, position) => position)
        .find((position) => {
          field.position = position;
          return field.mode === "text" && position > 0;
        });
      expect(textPosition, latex).toBeTypeOf("number");
      field.position = textPosition!;
      expect(advanceVisualTexNavigation(field, false), latex).toBe("parent");
      expect(field.mode, latex).toBe("math");
      expect(field.position, latex).toBeLessThan(field.lastOffset);
      const exited = visualTexMathfieldLatex(field);
      expect(field.insert("q", {
        format: "latex",
        insertionMode: "insertAfter",
        selectionMode: "after",
        feedback: false,
      }), latex).toBe(true);
      expect(visualTexMathfieldLatex(field), latex).toBe(exited.replace(/\+z$/, "q+z"));
    }

    for (const latex of [
      String.raw`\operatorname{rank}`,
      String.raw`\operatorname*{argmax}`,
      String.raw`\hbox{box}`,
    ]) {
      const field = createMathfield(`${latex}+z`);
      field.addEventListener("move-out", (event: Event) => event.preventDefault());
      const operatorPosition = Array.from({ length: field.lastOffset + 1 }, (_, position) => position)
        .find((position) => (field.getElementInfo(position)?.depth ?? 0) > 0);
      expect(operatorPosition, latex).toBeTypeOf("number");
      field.position = operatorPosition!;
      expect(advanceVisualTexNavigation(field, false), latex).toBe("parent");
      expect(field.position, latex).toBeLessThan(field.lastOffset);
      expect(field.getElementInfo(field.position)?.depth ?? 0, latex).toBe(0);
      const exited = visualTexMathfieldLatex(field);
      expect(field.insert("q", {
        format: "latex",
        insertionMode: "insertAfter",
        selectionMode: "after",
        feedback: false,
      }), latex).toBe(true);
      expect(visualTexMathfieldLatex(field), latex).toBe(exited.replace(/\+z$/, "q+z"));
    }

    for (const latex of [String.raw`\text{plain}`, String.raw`\operatorname{rank}`]) {
      const field = createMathfield(`${latex}+z`);
      field.addEventListener("move-out", (event: Event) => event.preventDefault());
      const nestedPosition = Array.from({ length: field.lastOffset + 1 }, (_, position) => position)
        .reverse()
        .find((position) => {
          if (position <= 0) return false;
          field.position = position;
          return (field.getElementInfo(position)?.depth ?? 0) > 0 || field.mode === "text";
        });
      expect(nestedPosition, latex).toBeTypeOf("number");
      field.position = nestedPosition!;
      expect(advanceVisualTexNavigation(field, true), latex).toBe("parent");
      expect(field.position, latex).toBe(0);
      expect(field.mode, latex).toBe("math");
    }
  });

  test("never lets forward Cmd-] navigation wrap toward the formula start", () => {
    const field = createMathfield(
      String.raw`add_1+aaaaaaaaa+\sum_{add}^{add}+\sum_{s}^{ad}`,
    );
    field.addEventListener("move-out", (event: Event) => event.preventDefault());

    for (let origin = 0; origin < field.lastOffset; origin++) {
      field.position = origin;
      advanceVisualTexNavigation(field, false);
      expect(field.position, `origin ${origin}`).toBeGreaterThanOrEqual(origin);
    }
  });

  test("keeps Cmd-bracket directional across fractions, scripts, roots, and text", () => {
    const formulas = [
      "x\\frac{ab}{cd}z",
      "x_{ab}^{cd}+z",
      "\\sqrt{\\frac{x_1}{y^2}}+z",
      "\\text{alpha beta}+z",
      "\\begin{matrix}a&b\\\\c&d\\end{matrix}+z",
    ];
    for (const latex of formulas) {
      const field = createMathfield(latex);
      field.addEventListener("move-out", (event: Event) => event.preventDefault());
      for (let origin = 0; origin <= field.lastOffset; origin++) {
        field.position = origin;
        advanceVisualTexNavigation(field, false);
        expect(field.position, "forward " + latex + " at " + origin).toBeGreaterThanOrEqual(origin);
        field.position = origin;
        advanceVisualTexNavigation(field, true);
        expect(field.position, "backward " + latex + " at " + origin).toBeLessThanOrEqual(origin);
      }
      field.remove();
    }
  });

  test("keeps $0 invisible and preserves a lexical boundary after an operator snippet", () => {
    const field = createMathfield("asdasotimes");
    const template = mathLiveSnippetTemplate({
      key: "otimes",
      mode: "tex-mode",
      body: "\\otimes$0",
    }, "final-stop-test");

    expect(template).toEqual({
      latex: "\\otimes",
      needsFinalSourceBoundary: true,
      tabstops: [],
    });
    expect(applyVisualTexCompletionTemplate(field, "asdasotimes", template, 6)).toBe(true);
    expect(field.getPrompts()).toEqual([]);
    expect(field.position).toBe(field.lastOffset);
    expect(visualTexMathfieldLatex(field)).toBe("asdas\\otimes ");

    for (const text of ["s", "a", "d"]) {
      expect(field.executeCommand(["typedText", text, {
        focus: true,
        feedback: false,
        simulateKeystroke: true,
      }])).toBe(true);
    }
    expect(visualTexMathfieldLatex(field)).toBe("asdas\\otimes sad");
    expect(visualTexMathfieldLatex(field)).not.toContain("\\otimessad");

    expect(field.executeCommand("undo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("asdas\\otimes ");
  });

  test("keeps the terminal control-word boundary after prompt cleanup", () => {
    const field = createMathfield("styledop");
    const template = mathLiveSnippetTemplate({
      key: "styledop",
      mode: "tex-mode",
      body: "\\mathcal{$1}+\\otimes$0",
    }, "styled-operator-test");
    expect(template.needsFinalSourceBoundary).toBe(true);
    expect(applyVisualTexCompletionTemplate(field, "styledop", template, 8)).toBe(true);
    field.insert("A", {
      format: "latex",
      insertionMode: "replaceSelection",
      selectionMode: "after",
      feedback: false,
    });
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(field.getPrompts()).toEqual([]);
    expect(field.getValue("latex").match(/\\noemaMathSpaceBoundary/g)).toHaveLength(1);
    expect(visualTexMathfieldLatex(field)).toBe("\\mathcal{A}+\\otimes ");

    expect(field.executeCommand(["typedText", "x", {
      focus: true,
      feedback: false,
      simulateKeystroke: true,
    }])).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("\\mathcal{A}+\\otimes x");
  });

  test("adds a lexical separator when a control word is followed by a prompt value", () => {
    const field = createMathfield("cmd");
    const template = mathLiveSnippetTemplate({
      key: "cmd",
      mode: "tex-mode",
      body: "\\pi${1:x}$0",
    }, "control-prompt-boundary");

    expect(template.needsFinalSourceBoundary).toBeUndefined();
    expect(applyVisualTexCompletionTemplate(field, "cmd", template, 3)).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\pi x`);
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\pi x`);
  });

  test("collapses duplicate source-boundary atoms without consuming row breaks", () => {
    const marker = "\\noemaMathSpaceBoundary ";
    expect(normalizeVisualTexMathLiveOutput("a" + marker + marker + "b")).toBe("a b");
    expect(normalizeVisualTexMathLiveOutput("a" + marker + "\nb")).toBe("a \nb");
  });

  test("applies a snippet after a source-only Space boundary", () => {
    const field = createMathfield("x");
    expect(insertVisualTexNaturalSpace(field)).toBe("boundary");
    expect(field.insert("frac", {
      format: "latex",
      insertionMode: "insertAfter",
      selectionMode: "after",
      focus: false,
      feedback: false,
    })).toBe(true);
    const template = mathLiveSnippetTemplate({
      key: "frac",
      mode: "tex-mode",
      body: "\\frac{${1:a}}{${2:b}}$0",
    }, "space-boundary-frac");

    expect(applyVisualTexCompletionTemplate(field, "frac", template, 4)).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`x \frac{a}{b}`);
    expect(visualTexMathfieldLatex(field)).not.toContain("noemaMathSpaceBoundary");
    expect(advanceVisualTexNavigation(field, false)).toBe("placeholder");
    expect(advanceVisualTexNavigation(field, false)).toBe("final");
    expect(field.getPrompts()).toEqual([]);
    expect(field.getValue("latex").match(/\\noemaMathSpaceBoundary/g)).toHaveLength(1);
    expect(visualTexMathfieldLatex(field)).toBe("x \\frac{a}{b}");
  });

  test("types real spaces in text and uses math Space for structural movement", () => {
    const field = createMathfield(String.raw`\text{thin}`);
    field.position = 1;
    expect(field.mode).toBe("text");
    expect(insertVisualTexNaturalSpace(field)).toBe("space");

    expect(visualTexMathfieldLatex(field)).toContain(" ");
    expect(visualTexMathfieldLatex(field)).not.toContain(String.raw`\,`);

    const fraction = createMathfield(String.raw`x\frac{ab}{cd}z`);
    fraction.position = 2;
    const before = visualTexMathfieldLatex(fraction);
    expect(insertVisualTexNaturalSpace(fraction)).toBe("navigate");
    expect(fraction.position).toBeGreaterThan(2);
    expect(fraction.position).toBeLessThan(fraction.lastOffset);
    expect(visualTexMathfieldLatex(fraction)).toBe(before);
    expect(visualTexMathfieldLatex(fraction)).not.toContain(String.raw`\ `);
    expect(visualTexMathfieldLatex(fraction)).not.toContain(String.raw`\,`);

    const scripted = createMathfield(String.raw`x_{ab}^{cd}+z`);
    scripted.position = 2;
    expect(insertVisualTexNaturalSpace(scripted)).toBe("navigate");
    expect(scripted.position).toBeGreaterThan(2);
    expect(scripted.position).toBeLessThan(scripted.lastOffset);
    expect(visualTexMathfieldLatex(scripted)).not.toContain(String.raw`\,`);

    const root = createMathfield("xy");
    expect(insertVisualTexNaturalSpace(root)).toBe("boundary");
    expect(visualTexMathfieldLatex(root)).toBe("xy ");
    expect(visualTexMathfieldLatex(root)).not.toContain("noemaMathSpaceBoundary");
    expect(insertVisualTexNaturalSpace(root)).toBe("boundary");
    expect(visualTexMathfieldLatex(root)).toBe("xy ");

    expect(root.insert("frac", {
      format: "latex",
      insertionMode: "insertAfter",
      selectionMode: "after",
      focus: false,
      feedback: false,
    })).toBe(true);
    expect(visualTexMathfieldLatex(root)).toBe("xy frac");
    expect(visualTexCompletionPrefix(visualTexMathfieldLatex(root))).toBe("frac");

    const removableBoundary = createMathfield("xy");
    expect(insertVisualTexNaturalSpace(removableBoundary)).toBe("boundary");
    expect(removableBoundary.executeCommand("deleteBackward")).toBe(true);
    expect(visualTexMathfieldLatex(removableBoundary)).toBe("xy");
    expect(insertVisualTexNaturalSpace(removableBoundary)).toBe("boundary");
    expect(visualTexMathfieldLatex(removableBoundary)).toBe("xy ");

    const historyBoundary = createMathfield("xy");
    expect(historyBoundary.canUndo()).toBe(false);
    expect(insertVisualTexNaturalSpace(historyBoundary)).toBe("boundary");
    expect(historyBoundary.canUndo()).toBe(true);
    expect(historyBoundary.executeCommand("undo")).toBe(true);
    expect(visualTexMathfieldLatex(historyBoundary)).toBe("xy");
    expect(historyBoundary.executeCommand("redo")).toBe(true);
    expect(visualTexMathfieldLatex(historyBoundary)).toBe("xy ");
  });

  test("promotes an ordinary display equation when Enter adds a row", () => {
    const field = createMathfield("a=b");
    const saved = insertVisualTexInlineRow(field);

    expect(saved).toContain(String.raw`\begin{aligned}`);
    expect(saved).toContain(String.raw`\\`);
    expect(saved).toContain(String.raw`\end{aligned}`);
    expect(field.canUndo()).toBe(true);
    expect(field.executeCommand("undo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("a=b");
    expect(field.executeCommand("redo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe(saved);
  });

  test("adds and undoes a row inside an existing display layout", () => {
    const field = createMathfield(String.raw`\begin{aligned}a&=b\end{aligned}`);
    const before = visualTexMathfieldLatex(field);
    const saved = insertVisualTexInlineRow(field);

    expect(saved).not.toBe(before);
    expect(saved).toContain(String.raw`\\`);
    expect(field.executeCommand("undo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe(before);
    expect(field.executeCommand("redo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe(saved);
  });

  test("keeps recording after an undo request at the initial history boundary", () => {
    const field = createMathfield("x");

    expect(field.canUndo()).toBe(false);
    field.executeCommand("undo");
    expect(visualTexMathfieldLatex(field)).toBe("x");
    expect(field.executeCommand(["typedText", "y", {
      focus: true,
      feedback: false,
      simulateKeystroke: true,
    }])).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("xy");
    expect(field.executeCommand("undo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("x");
  });

  test("Space finishes a backslash command without leaving a command box or thin space", () => {
    const field = createMathfield("");
    expect(field.executeCommand(["typedText", "\\", {
      focus: true,
      feedback: false,
      simulateKeystroke: true,
    }])).toBe(true);
    expect(field.executeCommand(["typedText", "alpha", {
      focus: true,
      feedback: false,
      simulateKeystroke: true,
    }])).toBe(true);
    expect(field.mode).toBe("latex");

    expect(insertVisualTexNaturalSpace(field)).toBe("command");
    expect(field.mode).toBe("math");
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\alpha`);
    expect(visualTexMathfieldLatex(field)).not.toContain(String.raw`\,`);

    expect(field.executeCommand(["typedText", "a", {
      focus: true,
      feedback: false,
      simulateKeystroke: true,
    }])).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe(String.raw`\alpha a`);
    expect(visualTexMathfieldLatex(field)).not.toContain(String.raw`\alphaa`);
  });

  test("accepts a pi snippet while MathLive is still editing the backslash command", () => {
    const field = createMathfield("");
    for (const text of ["\\", "p", "i"]) {
      expect(field.executeCommand(["typedText", text, {
        focus: true,
        feedback: false,
        simulateKeystroke: true,
      }])).toBe(true);
    }
    expect(field.mode).toBe("latex");
    const template = mathLiveSnippetTemplate({
      key: "pi",
      mode: "tex-mode",
      body: "\\pi$0",
    }, "pi-command-test");

    expect(applyVisualTexCompletionTemplate(field, "\\pi", template, 3)).toBe(true);
    expect(field.mode).toBe("math");
    expect(field.getPrompts()).toEqual([]);
    expect(visualTexMathfieldLatex(field)).toBe("\\pi ");

    expect(field.executeCommand("undo")).toBe(true);
    expect(field.getValue("latex")).not.toContain("noemaMathSpaceBoundary");
    expect(visualTexMathfieldLatex(field)).toBe("\\pi");
    expect(field.executeCommand("redo")).toBe(true);
    expect(visualTexMathfieldLatex(field)).toBe("\\pi ");
  });

  test("accepts a backslash-command snippet inside nested radicals", () => {
    const field = createMathfield("\\sqrt{\\sqrt{x}}+z");
    const innerEnd = Array.from({ length: field.lastOffset }, (_, index) => index + 1)
      .find((position) => field.getValue(position - 1, position, "latex-expanded") === "x");
    expect(innerEnd).toBeTypeOf("number");
    field.position = innerEnd!;
    for (const text of ["\\", "p", "i"]) {
      expect(field.executeCommand(["typedText", text, {
        focus: true,
        feedback: false,
        simulateKeystroke: true,
      }])).toBe(true);
    }
    const template = mathLiveSnippetTemplate({
      key: "pi",
      mode: "tex-mode",
      body: "\\pi$0",
    }, "nested-pi-command-test");

    expect(applyVisualTexCompletionTemplate(field, "\\pi", template, 3)).toBe(true);
    const saved = visualTexMathfieldLatex(field);
    expect(saved).toContain("x\\pi ");
    expect(saved).toContain("+z");
    expect(saved).not.toContain("\\pipi");
  });

  test("keeps the natural separator between an unknown command and following letters", () => {
    const field = createMathfield("");
    for (const text of ["\\", "asdas"]) {
      expect(field.executeCommand(["typedText", text, {
        focus: true,
        feedback: false,
        simulateKeystroke: true,
      }])).toBe(true);
    }
    expect(field.mode).toBe("latex");
    expect(insertVisualTexNaturalSpace(field)).toBe("command");
    expect(field.mode).toBe("math");
    expect(field.executeCommand(["typedText", "a", {
      focus: true,
      feedback: false,
      simulateKeystroke: true,
    }])).toBe(true);

    const saved = visualTexMathfieldLatex(field);
    expect(saved).toContain(String.raw`\asdas a`);
    expect(saved).not.toContain(String.raw`\asdasa`);
    expect(saved).not.toContain(String.raw`\,`);
    expect(field.getPrompts()).toEqual([]);
  });
});

describe("LiveTeX host key normalization", () => {
  test("always treats the physical Backslash key as TeX command input", () => {
    expect(visualTexMathfieldTypedText({ key: "Backslash", code: "Backslash" })).toBe("\\");
    expect(visualTexMathfieldTypedText({ key: "\\" })).toBe("\\");
    expect(visualTexMathfieldTypedText({ key: "Backslash", text: "\\" })).toBe("\\");
    expect(visualTexMathfieldTypedText({ key: "|", code: "Backslash", shiftKey: true })).toBe("|");
  });
});

describe("LiveTeX inline geometry", () => {
  test("moves the whole MathLive box without making ordinary KaTeX lines taller", () => {
    expect(visualTexMathBottomLeftInsets(
      { top: 100, bottom: 120 },
      { top: 100, bottom: 120 },
    )).toEqual({ top: 0, bottom: 0 });

    const insets = visualTexMathBottomLeftInsets(
      { top: 149, bottom: 330 },
      { top: 62, bottom: 330 },
    );
    expect(insets).toEqual({ top: 87, bottom: 0 });

    // Padding the shell shifts the field and every descendant together, so their
    // relative overflow remains unchanged and the measurement is stable.
    expect(visualTexMathBottomLeftInsets(
      { top: 238, bottom: 419 },
      { top: 151, bottom: 419 },
    )).toEqual(insets);

    // Descendant bounds are not allowed to move the lower origin. Even a bad
    // descendant bound below MathLive's natural TeX depth grows upward rather
    // than shifting the field and every already-rendered frame.
    expect(visualTexMathBottomLeftInsets(
      { top: 238, bottom: 419 },
      { top: 151, bottom: 460 },
    )).toEqual(insets);
  });
});

function createMathfield(latex: string): InstanceType<typeof MathfieldElement> {
  const field = new MathfieldElement();
  patchHappyDomMathfieldHostSelector(field);
  document.body.append(field);
  initializeNoemaMathfield(field, latex, {});
  field.position = field.lastOffset;
  return field;
}

function selectedMathfieldLatex(field: InstanceType<typeof MathfieldElement>): string {
  const [from, to] = field.selection.ranges[0] ?? [field.position, field.position];
  return field.getValue(Math.min(from, to), Math.max(from, to), "latex-expanded");
}

function expectNoSnippetScaffolding(field: InstanceType<typeof MathfieldElement>): void {
  const latex = field.getValue("latex");
  expect(field.getPrompts()).toEqual([]);
  expect(latex).not.toContain("placeholder");
  expect(latex).not.toContain("noemaMathSnippet");
}

function patchHappyDomMathfieldHostSelector(field: InstanceType<typeof MathfieldElement>): void {
  MathfieldElement.soundsDirectory = null;
  if (!("AudioContext" in globalThis)) {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class {
        state = "running";
        destination = {};
        resume(): Promise<void> { return Promise.resolve(); }
        decodeAudioData(): Promise<never> { return Promise.reject(new Error("audio disabled in tests")); }
        createBufferSource(): never { throw new Error("audio disabled in tests"); }
        createGain(): never { throw new Error("audio disabled in tests"); }
      },
    });
  }
  if (!document.fonts?.ready) {
    const fonts = new Set<unknown>() as Set<unknown> & { ready: Promise<void> };
    fonts.ready = Promise.resolve();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
  }
  if (!("FontFace" in globalThis)) {
    Object.defineProperty(globalThis, "FontFace", {
      configurable: true,
      value: class {
        family: string;
        constructor(family: string) { this.family = family; }
        load(): Promise<this> { return Promise.resolve(this); }
      },
    });
  }
  const shadow = field.shadowRoot;
  if (!shadow) return;
  const querySelector = shadow.querySelector.bind(shadow);
  shadow.querySelector = ((selector: string) => (
    selector === ":host > span" ? querySelector("span") : querySelector(selector)
  )) as typeof shadow.querySelector;
}
