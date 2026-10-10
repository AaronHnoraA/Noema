/**
 * "Document Properties" must edit the note's one metadata block. Whether the
 * note has one is decided from the document: the panel for it is only in the
 * DOM while the block is on screen in preview mode.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];

function open(doc: string, position = 0): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: doc });
  editor.setSelection(position, position);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

const META = "#+begin meta\nid: 0190f3a2-7c1e-7000-8000-0123456789ab\ntitle: Page\n#+end meta\n\n";

describe("edit-properties", () => {
  it("does not add a second block to a note shown as source", () => {
    const doc = `${META}Body\n`;
    const ed = open(doc, doc.length);
    ed.toggleSource();
    expect(ed.isSourceMode()).toBe(true);
    expect(ed.runCommand("edit-properties")).toBe(true);
    expect(ed.getMarkdown()).toBe(doc);
    // The cursor is taken into the existing block instead.
    expect(ed.getMarkdownSelection().from).toBe("#+begin meta\n".length);
  });

  it("does not add a second block when the block is far above the cursor", () => {
    const body = Array.from({ length: 400 }, (_, index) => `Paragraph ${index}.\n`).join("\n");
    const doc = `${META}${body}`;
    const ed = open(doc, doc.length);
    expect(ed.runCommand("edit-properties")).toBe(true);
    expect(ed.getMarkdown()).toBe(doc);
    expect(ed.getMarkdown().match(/#\+begin meta/g)).toHaveLength(1);
  });

  it("finds a block that follows a blank line", () => {
    const doc = `\n${META}Body\n`;
    const ed = open(doc, doc.length);
    ed.toggleSource();
    ed.runCommand("edit-properties");
    expect(ed.getMarkdown()).toBe(doc);
  });

  it("creates the block for a note that has none", () => {
    const ed = open("Body\n", 2);
    expect(ed.runCommand("edit-properties")).toBe(true);
    expect(ed.getMarkdown()).toBe("#+begin meta\nproperty: \n#+end meta\n\nBody\n");
  });

  it("creates the block after YAML front matter", () => {
    const ed = open("---\ntitle: Page\n---\n\nBody\n", 0);
    ed.runCommand("edit-properties");
    expect(ed.getMarkdown()).toBe("---\ntitle: Page\n---\n\n#+begin meta\nproperty: \n#+end meta\n\nBody\n");
  });
});
