import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { scanInlineCommands } from "../shared/command-syntax.mjs";
import { latexMarkChoiceNames, latexMarkSnippetDefinitions } from "../shared/latex-marks.mjs";
// @ts-ignore Node ESM module outside the TS app graph.
import { latexPromptMarker, preprocessNoemaForPandoc, stripLatexPromptMarkers } from "../server/lib/latex-export-pandoc.mjs";
// @ts-ignore Node ESM module outside the TS app graph.
import { latexMacrosPackage } from "../server/lib/latex-export.mjs";
// @ts-ignore Node ESM module outside the TS app graph.
import { proseFidelityWarnings } from "../server/lib/latex-export-codex.mjs";

describe("@@latexmk(prompt) [instruction]", () => {
  test("the scanner reads the instruction in brackets; other marks stay marker-only", () => {
    const [prompt, mark] = scanInlineCommands("A @@latexmk(prompt) [set the table landscape] B @@latexmk(newline) C", "latexmk");
    expect(prompt).toMatchObject({ switchValue: "prompt", context: "set the table landscape" });
    expect(mark).toMatchObject({ switchValue: "newline", context: "" });
  });

  test("it is offered in completion with a bracket to fill", () => {
    expect(latexMarkChoiceNames()).toContain("prompt");
    expect(latexMarkSnippetDefinitions().find((snippet) => snippet.key === "prompt")?.body)
      .toBe("@@latexmk(prompt) [${1:instruction}]$0");
  });

  test("the Pandoc pass leaves a marker that typesets nothing", () => {
    const out = preprocessNoemaForPandoc("Text @@latexmk(prompt) [use \\small for this {table} at 90%] here.\n").markdown;
    expect(out).toContain("\\noemaprompt{use \\small for this \\{table\\} at 90\\%}");
    expect(out).not.toContain("@@latexmk");
    expect(latexMacrosPackage()).toContain("\\providecommand{\\noemaprompt}[1]{}");
  });

  test("an empty instruction is an error the author sees", () => {
    expect(() => preprocessNoemaForPandoc("@@latexmk(prompt) []\n")).toThrow(/needs an instruction/);
  });

  test("the host strips every marker the Agent left, escaped braces included", () => {
    const body = `Before ${latexPromptMarker("make it {bold} 50%")} after.\n${latexPromptMarker("global: two columns")}\nEnd.`;
    expect(stripLatexPromptMarkers(body)).toBe("Before after.\n\nEnd.");
  });

  test("an instruction's words are not counted as source prose", () => {
    const source = "A paragraph of words. @@latexmk(prompt) [rewrite everything in landscape format please]";
    expect(proseFidelityWarnings(source, "A paragraph of words.")).toEqual([]);
  });
});

describe("@@latexmk(prompt) in the editor", () => {
  test("renders as a chip carrying the instruction, and opens its source on entry", async () => {
    const { createEditor } = await import("../src/editor-api.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "A table follows. @@latexmk(prompt) [set the next table landscape]\n\nend\n" });
    try {
      editor.setMarkdownSelection(editor.getMarkdown().length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const chip = host.querySelector<HTMLElement>(".inline-latex-prompt-widget");
      expect(chip?.querySelector(".inline-latex-prompt-text")?.textContent).toBe("set the next table landscape");
      expect(chip?.title).toContain("never typeset");
      expect(host.textContent).not.toContain("@@latexmk");
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
