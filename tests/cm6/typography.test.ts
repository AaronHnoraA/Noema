import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { toggleAaronnoteMarkdownSource } from "../../src/cm6/editor-cm6.ts";
import {
  VISUAL_TYPOGRAPHY_INLINE_GUTTER,
  visualTypographyGutterPx,
} from "../../src/cm6/extensions/visual/typography.ts";

function mount(initialContent: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return {
    editor,
    cleanup() {
      editor.destroy();
      host.remove();
    },
  };
}

function blankLines(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".cm-line.cm-prose-blank-line"));
}

function blankLayoutClasses(): string[] {
  return blankLines().map((line) => [...line.classList]
    .filter((name) => name.startsWith("cm-prose-blank-"))
    .join(" "));
}

function pressEnter(editor: ReturnType<typeof createEditor>): void {
  editor.view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

describe("Visual typography kernel", () => {
  test("locks the adaptive 4%-8% gutter around a 95ch target measure", () => {
    expect(VISUAL_TYPOGRAPHY_INLINE_GUTTER).toBe(
      "clamp(max(var(--aaron-prose-gutter-floor), calc(var(--content-width) * 0.04)), calc((var(--content-width) - 95ch) / 2), calc(var(--content-width) * 0.08))",
    );

    // 95ch is 760px when 1ch is 8px. These cases exercise the floor,
    // percentage floor, exact 95ch centering, and percentage ceiling.
    expect(visualTypographyGutterPx(600, 8)).toBe(32);
    expect(visualTypographyGutterPx(810, 8)).toBeCloseTo(32.4);
    expect(visualTypographyGutterPx(860, 8)).toBe(50);
    expect(860 - 2 * visualTypographyGutterPx(860, 8)).toBe(760);
    expect(visualTypographyGutterPx(1_000, 8)).toBe(80);
  });

  test("is installed as a Visual-only core extension", () => {
    const { editor, cleanup } = mount("Alpha\n\nBeta");
    expect(editor.view.dom.classList.contains("aaronnote-visual-typography")).toBe(true);
    expect(editor.view.dom.getAttribute("style")).toContain("--content-width: 100%");

    expect(toggleAaronnoteMarkdownSource(editor.view)).toBe(true);
    expect(editor.view.dom.classList.contains("aaronnote-visual-typography")).toBe(false);
    expect(blankLines()).toHaveLength(0);
    cleanup();
  });

  test("does not read layout width for ordinary document transactions", () => {
    const { editor, cleanup } = mount("Alpha");
    let reads = 0;
    Object.defineProperty(editor.view.contentDOM, "offsetWidth", {
      configurable: true,
      get() {
        reads += 1;
        return 960;
      },
    });

    editor.view.dispatch({ changes: { from: 5, insert: "!" } });
    expect(reads).toBe(0);
    cleanup();
  });

  test("marks repeated source blanks for softer paragraph spacing", () => {
    const { cleanup } = mount("Alpha\n\n\nBeta");
    const lines = blankLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.className).toBe("cm-line cm-prose-blank-line");
    expect(lines[1]!.classList.contains("cm-prose-blank-line-continued")).toBe(true);
    cleanup();
  });

  test("keeps authored blank lines beside semantic blocks", () => {
    const { cleanup } = mount("Alpha\n\n\n# Heading");
    const lines = blankLines();
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.classList.contains("cm-prose-blank-line"))).toBe(true);
    cleanup();
  });

  test("moving the caret does not change blank-line decorations", () => {
    const { editor, cleanup } = mount("Alpha\n\n\nBeta");
    const before = blankLayoutClasses();
    editor.setMarkdownSelection(6);
    expect(blankLayoutClasses()).toEqual(before);
    expect(blankLines().some((line) => /cm-prose-blank-(?:active|collapsed|absorbed)/.test(line.className))).toBe(false);
    editor.setMarkdownSelection(0);
    expect(blankLayoutClasses()).toEqual(before);
    cleanup();
  });

  test("retains long authored blank runs", () => {
    const authoredBlankLines = 40;
    const { editor, cleanup } = mount(`Alpha${"\n".repeat(authoredBlankLines + 1)}Beta`);
    const activeLine = 24;
    editor.setMarkdownSelection(editor.view.state.doc.line(activeLine).from);

    const lines = blankLines();
    expect(editor.getMarkdown()).toBe(`Alpha${"\n".repeat(authoredBlankLines + 1)}Beta`);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.classList.contains("cm-prose-blank-line"))).toBe(true);
    cleanup();
  });

  test("real Enter adds one visible blank line each time", () => {
    const { editor, cleanup } = mount("Alpha\nBeta");
    editor.setMarkdownSelection(5);

    pressEnter(editor);
    expect(editor.getMarkdown()).toBe("Alpha\n\nBeta");
    expect(editor.getMarkdownSelection().from).toBe(6);
    expect(blankLines()).toHaveLength(1);
    expect(blankLines()[0]!.classList.contains("cm-prose-blank-line")).toBe(true);

    pressEnter(editor);
    expect(editor.getMarkdown()).toBe("Alpha\n\n\nBeta");
    expect(editor.getMarkdownSelection().from).toBe(7);
    const lines = blankLines();
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.classList.contains("cm-prose-blank-line"))).toBe(true);
    cleanup();
  });

  test("Enter beside a heading keeps its blank line", () => {
    const { editor, cleanup } = mount("Alpha\n# Heading");
    editor.setMarkdownSelection(5);
    pressEnter(editor);

    const lines = blankLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.classList.contains("cm-prose-blank-line")).toBe(true);
    cleanup();
  });

  test("typing into a blank line updates its height class immediately", () => {
    const { editor, cleanup } = mount("\nExample\n\nAfter");
    editor.setMarkdownSelection(0);
    editor.view.dispatch(editor.view.state.update(
      editor.view.state.replaceSelection("s"),
      { userEvent: "input.type", scrollIntoView: true },
    ));

    expect(editor.getMarkdown()).toBe("s\nExample\n\nAfter");
    const lines = [...editor.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
    expect(lines[0]!.classList.contains("cm-prose-blank-line")).toBe(false);
    expect(lines[2]!.classList.contains("cm-prose-blank-line")).toBe(true);
    expect(lines[2]!.classList.contains("cm-prose-blank-line-continued")).toBe(false);
    cleanup();
  });
});
