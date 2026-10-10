/**
 * A stable link names its page by ID. Without a label the reader would see the
 * ID, so the editor shows the page's current title instead, as a view over the
 * source: the text keeps the ID and shows it when the selection touches it.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { setWikiPageTitles, stableWikiTargetId } from "../../src/cm6/roam-link-status.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];
const ID = "0190f3a2-7c1e-7000-8000-0123456789ab";

function open(doc: string, position = 0): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: doc });
  editor.setSelection(position, position);
  editors.push(editor);
  return editor;
}

function titles(editor: Editor, entries: Record<string, string> | null): void {
  editor.view.dispatch({
    effects: setWikiPageTitles.of(entries ? new Map(Object.entries(entries)) : null),
  });
}

const shown = (editor: Editor): string[] => (
  [...editor.view.dom.querySelectorAll<HTMLElement>(".cm-roam-link-title")].map((el) => el.textContent ?? "")
);
const broken = (editor: Editor): string[] => (
  [...editor.view.dom.querySelectorAll<HTMLElement>(".cm-roam-link-broken")].map((el) => el.textContent ?? "")
);

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

describe("stable link targets", () => {
  it("reads the page ID out of a stable target", () => {
    expect(stableWikiTargetId(`roam://${ID}`)).toBe(ID);
    expect(stableWikiTargetId(`roam://${ID.toUpperCase()}#Block%201`)).toBe(ID);
    expect(stableWikiTargetId(`roam://id/${ID}`)).toBe(ID);
    expect(stableWikiTargetId("Page title")).toBe("");
    expect(stableWikiTargetId("roam://wiki/Page")).toBe("");
  });
});

describe("label-less stable links", () => {
  const doc = `Intro\n\nSee [[roam://${ID}]] and [[roam://${ID}#Lemma%202]].\n\nEnd`;

  it("shows the page's current title and follows a rename", () => {
    const ed = open(doc);
    expect(shown(ed)).toEqual([]);
    titles(ed, { [ID]: "Fixed points" });
    expect(shown(ed)).toEqual(["Fixed points", "Fixed points › Lemma 2"]);
    // The page is renamed: the same source now reads under the new title.
    titles(ed, { [ID]: "Fixed-point theorems" });
    expect(shown(ed)).toEqual(["Fixed-point theorems", "Fixed-point theorems › Lemma 2"]);
    expect(ed.getMarkdown()).toBe(doc);
  });

  it("shows the ID again while the selection touches the link", () => {
    const ed = open(doc);
    titles(ed, { [ID]: "Fixed points" });
    const inside = doc.indexOf("roam://") + 4;
    ed.setSelection(inside, inside);
    expect(shown(ed)).toEqual(["Fixed points › Lemma 2"]);
    ed.setSelection(0, 0);
    expect(shown(ed)).toHaveLength(2);
  });

  it("leaves a link that carries its own label as written", () => {
    const ed = open(`See [[roam://${ID}|my wording]].`, 0);
    titles(ed, { [ID]: "Fixed points" });
    expect(shown(ed)).toEqual([]);
    expect(broken(ed)).toEqual([]);
  });
});

describe("stable links to pages that do not exist", () => {
  it("marks an unknown ID, with or without a label", () => {
    const ed = open(`End\n\nGone [[roam://11111111-2222-7333-8444-555555555555|old name]] and [[roam://${ID}|kept]].`, 0);
    titles(ed, { [ID]: "Fixed points" });
    expect(broken(ed)).toEqual(["old name"]);
  });

  it("judges nothing before the index is loaded, and never a title link", () => {
    const ed = open(`End\n\n[[roam://${ID}]] [[Some title]] [[Topic:Page]]`, 0);
    expect(broken(ed)).toEqual([]);
    titles(ed, {});
    expect(broken(ed)).toEqual([`roam://${ID}`]);
    titles(ed, null);
    expect(broken(ed)).toEqual([]);
    expect(shown(ed)).toEqual([]);
  });

  it("does not touch links inside code", () => {
    const ed = open(`End\n\n\`[[roam://${ID}]]\`\n\n\`\`\`\n[[roam://${ID}]]\n\`\`\`\n`, 0);
    titles(ed, { [ID]: "Fixed points" });
    expect(shown(ed)).toEqual([]);
  });
});
