/** Footnote hover previews (MarkText footnote tool) and diagram quick inserts (MarkText "/" menu). */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { Text } from "@codemirror/state";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { footnoteDefinitionPreview } from "../../src/cm6/extensions/visual/widgets/footnotes.ts";

const editors: Editor[] = [];
afterEach(() => { for (const e of editors.splice(0)) e.destroy(); document.body.replaceChildren(); });

describe("footnote preview", () => {
  it("reads the definition and its indented continuation", () => {
    const doc = Text.of(["See[^a] and[^b].", "", "[^a]: First line", "    continues here.", "Not part.", "[^b]:"]);
    expect(footnoteDefinitionPreview(doc, "a")).toBe("First line continues here.");
    expect(footnoteDefinitionPreview(doc, "b")).toBe("");
    expect(footnoteDefinitionPreview(doc, "c")).toBeNull();
    expect(footnoteDefinitionPreview(Text.of(["[^x]: " + "y".repeat(500)]), "x")!.length).toBe(400);
  });

  it("puts the note in the reference's tooltip on hover", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: "Claim[^1] and[^2].\n\n[^1]: The source." });
    editors.push(editor);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const buttons = host.querySelectorAll<HTMLButtonElement>(".cm-footnote-reference button");
    expect(buttons).toHaveLength(2);
    buttons[0]!.dispatchEvent(new MouseEvent("mouseenter"));
    buttons[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(buttons[0]!.title).toBe("The source.\n— click to jump");
    expect(buttons[1]!.title).toBe("Footnote 2 has no definition");
    expect(buttons[1]!.classList.contains("cm-footnote-undefined")).toBe(true);
  });
});

describe("diagram quick insert", () => {
  it("offers a Mermaid block from /mer and puts the caret inside it", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: "" });
    editors.push(editor);
    const item = editor.getQuickInsertItems("mer").find((entry) => entry.id === "mermaid-diagram");
    expect(item).toBeDefined();
    expect(editor.runQuickInsert(item!)).toBe(true);
    expect(editor.getMarkdown()).toBe("```mermaid\n\n```");
    expect(editor.getMarkdownSelection().from).toBe("```mermaid\n".length);
  });
});
