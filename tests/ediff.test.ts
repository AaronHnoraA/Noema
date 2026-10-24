import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../src/editor-api.ts";
import { ediffActionEdit, ediffSide, scanEdiffBlocks } from "../src/ediff.ts";
import { renderedConstructAt } from "../src/cm6/extensions/visual/constructs/index.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { approvedEdiffMarkdown } from "../shared/ediff-source.mjs";
// @ts-ignore Node ESM converters live outside the TypeScript app graph.
import { noemaMarkdownToLatex } from "../server/lib/latex-export.mjs";
// @ts-ignore Node ESM converters live outside the TypeScript app graph.
import { preprocessNoemaForPandoc } from "../server/lib/latex-export-pandoc.mjs";

const source = [
  "| A | B |",
  "| --- | --- |",
  "| first | 1 |",
  "#+begin ediff Review this row",
  "-| old | 2 |",
  "+| new | 2 |",
  "#+end ediff",
  "| last | 3 |",
  "",
].join("\n");

describe("in-place ediff semantics", () => {
  test("resolves old and new sides at the affected lines, including a table", () => {
    const [block] = scanEdiffBlocks(source);
    expect(block.from).toBe(source.indexOf("#+begin ediff"));
    expect(ediffSide(block, "old")).toBe("| old | 2 |\n");
    expect(ediffSide(block, "new")).toBe("| new | 2 |\n");
    expect(approvedEdiffMarkdown(source)).toContain("| first | 1 |\n| old | 2 |\n| last | 3 |");
    const html = renderMarkdownHTML(source);
    expect(html).toContain("<table");
    expect(html).toContain("old");
    expect(html).not.toContain(">new<");
    expect(noemaMarkdownToLatex(source).body).toContain("old");
    expect(preprocessNoemaForPandoc(source).markdown).toContain("| old | 2 |");
  });

  test("accepts only the chosen block and handles insertion and deletion", () => {
    const multiple = [
      "before",
      "#+begin ediff One", "-old", "+new", "#+end ediff",
      "middle",
      "#+begin ediff Insert", "+extra", "#+end ediff",
      "#+begin ediff Delete", "-remove", "#+end ediff",
      "after", "",
    ].join("\n");
    expect(approvedEdiffMarkdown(multiple)).toBe("before\nold\nmiddle\nremove\nafter\n");
    const [first] = scanEdiffBlocks(multiple);
    const edit = ediffActionEdit(multiple, first.from, "accept");
    const accepted = multiple.slice(0, edit.from) + edit.insert + multiple.slice(edit.to);
    expect(accepted).toContain("new\nmiddle\n");
    expect(accepted).toContain("#+begin ediff Insert");
    expect(approvedEdiffMarkdown(accepted)).toBe("before\nnew\nmiddle\nremove\nafter\n");
  });

  test("supports context, literal diff prefixes, and final no-newline marker", () => {
    const context = "#+begin ediff x\n same\n--bullet\n+-bullet\n#+end ediff\n";
    const [block] = scanEdiffBlocks(context);
    expect(block.error).toBeUndefined();
    expect(ediffSide(block, "old")).toBe("same\n-bullet\n");
    const eof = "#+begin ediff x\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n#+end ediff\n";
    const [last] = scanEdiffBlocks(eof);
    expect(last.error).toBeUndefined();
    expect(approvedEdiffMarkdown(eof)).toBe("old");
    expect(ediffSide(last, "new")).toBe("new");
  });

  test("preserves malformed blocks and fenced examples literally", () => {
    const malformed = "a\n#+begin ediff x\nold\n#+end ediff\nb\n";
    expect(scanEdiffBlocks(malformed)[0].error).toMatch(/Invalid diff line/);
    expect(approvedEdiffMarkdown(malformed)).toBe(malformed);
    const literal = "```text\n#+begin ediff x\n-old\n+new\n#+end ediff\n```\n";
    expect(scanEdiffBlocks(literal)).toHaveLength(0);
    expect(approvedEdiffMarkdown(literal)).toBe(literal);
  });

  test("keeps rejection and comments as source metadata without changing approved text", () => {
    const [block] = scanEdiffBlocks(source);
    const comment = ediffActionEdit(source, block.from, "comment", "Keep this label");
    const commented = source.slice(0, comment.from) + comment.insert + source.slice(comment.to);
    const reject = ediffActionEdit(commented, block.from, "reject");
    const rejected = commented.slice(0, reject.from) + reject.insert + commented.slice(reject.to);
    expect(scanEdiffBlocks(rejected)[0]).toMatchObject({ rejected: true, comments: ["Keep this label"] });
    expect(approvedEdiffMarkdown(rejected)).toBe(approvedEdiffMarkdown(source));
  });
});

describe("inline ediff card", () => {
  function mount(content: string) {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: content });
    return { host, view: editor.view as unknown as EditorView, done: () => { editor.destroy(); host.remove(); } };
  }

  test("renders at the original lines and accepts locally", () => {
    const { host, view, done } = mount(source);
    try {
      const card = host.querySelector<HTMLElement>(".noema-ediff");
      expect(card).not.toBeNull();
      expect(card?.querySelector(".noema-ediff-deletion")?.textContent).toContain("old");
      expect(card?.querySelector(".noema-ediff-addition")?.textContent).toContain("new");
      expect(card?.classList.contains("noema-ediff-compact")).toBe(true);
      expect(card?.classList.contains("noema-ediff-expanded")).toBe(false);
      card?.querySelector<HTMLButtonElement>(".noema-ediff-details-toggle")?.click();
      expect(card?.classList.contains("noema-ediff-expanded")).toBe(true);
      const at = source.indexOf("#+begin ediff") + 3;
      expect(renderedConstructAt(view, at)?.kind).toBe("block-extra");
      [...card!.querySelectorAll("button")].find((item) => item.textContent === "Accept")!.click();
      expect(view.state.doc.toString()).toContain("| first | 1 |\n| new | 2 |\n| last | 3 |");
    } finally { done(); }
  });

  test("previews both sides of a multiline edit and accepts the full span", () => {
    const content = [
      "Intro",
      "#+begin ediff Rewrite",
      " context before",
      "-old one", "-old two", "-old three",
      "+new one", "+new two", "+new three",
      " context after",
      "#+end ediff",
      "Outro", "",
    ].join("\n");
    const { host, view, done } = mount(content);
    try {
      const card = host.querySelector<HTMLElement>(".noema-ediff")!;
      expect(card.querySelectorAll(".noema-ediff-deletion:not(.noema-ediff-extra)")).toHaveLength(1);
      expect(card.querySelectorAll(".noema-ediff-addition:not(.noema-ediff-extra)")).toHaveLength(1);
      expect(card.querySelectorAll(".noema-ediff-extra")).toHaveLength(6);
      expect(card.querySelector(".noema-ediff-heading small")?.textContent).toContain("−3 +3");
      expect(card.querySelector(".noema-ediff-details-toggle")?.textContent).toBe("Details (4 more)");
      card.querySelector<HTMLButtonElement>(".noema-ediff-details-toggle")!.click();
      expect(card.classList.contains("noema-ediff-expanded")).toBe(true);
      [...card.querySelectorAll("button")].find((item) => item.textContent === "Accept")!.click();
      expect(view.state.doc.toString()).toBe(
        "Intro\ncontext before\nnew one\nnew two\nnew three\ncontext after\nOutro\n",
      );
    } finally { done(); }
  });

  test("shows all four changed lines in the two-row demo", () => {
    const content = [
      "#+begin ediff Two rows",
      "-old first", "-old second",
      "+new first", "+new second",
      "#+end ediff", "",
    ].join("\n");
    const { host, done } = mount(content);
    try {
      const card = host.querySelector<HTMLElement>(".noema-ediff")!;
      expect(card.querySelectorAll(".noema-ediff-deletion:not(.noema-ediff-extra)")).toHaveLength(2);
      expect(card.querySelectorAll(".noema-ediff-addition:not(.noema-ediff-extra)")).toHaveLength(2);
      expect(card.querySelector(".noema-ediff-heading small")?.textContent).toContain("−2 +2");
      expect(card.querySelector(".noema-ediff-details-toggle")?.textContent).toBe("Details");
    } finally { done(); }
  });

  test("rejects and stores a comment for the agent", () => {
    const { host, view, done } = mount(source);
    try {
      const card = host.querySelector<HTMLElement>(".noema-ediff")!;
      [...card.querySelectorAll("button")].find((item) => item.textContent === "Comment")!.click();
      const input = host.querySelector<HTMLTextAreaElement>(".noema-ediff-comment-form textarea")!;
      input.value = "Please keep the original wording";
      [...card.querySelectorAll("button")].find((item) => item.textContent === "Add comment")!.click();
      expect(view.state.doc.toString()).toContain('@@ediff-comment "Please keep the original wording"');
      const updated = host.querySelector<HTMLElement>(".noema-ediff")!;
      [...updated.querySelectorAll("button")].find((item) => item.textContent === "Reject")!.click();
      expect(view.state.doc.toString()).toContain("@@ediff-status rejected");
      expect(approvedEdiffMarkdown(view.state.doc.toString())).toContain("| old | 2 |");
    } finally { done(); }
  });
});
