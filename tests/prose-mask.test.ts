import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { collectBrowserSpellWords, maskAaronnoteProse } from "../shared/prose-mask.mjs";

function visible(masked: string): string {
  return masked.replace(/[^\S\n]+/g, " ");
}

describe("Noema prose mask", () => {
  test("spell-checks revision prose while masking the command shell", () => {
    const source = '@@revision(red) [recieve old] {advice: "recieve new"; reason: "recieve reason"}';
    const masked = maskAaronnoteProse(source);
    expect(masked).not.toContain("@@revision");
    expect(masked).not.toContain("advice:");
    expect(masked).toContain("recieve old");
    expect(masked).toContain("recieve new");
    expect(masked).toContain("recieve reason");
  });
  test("keeps ordinary prose and todo text while masking command syntax", () => {
    const md = "This recieve stays.\n@@todo(doing) [Fix teh word]{ddl: 2026-05-20}\n@@lean4 [proof-main]\n";
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(masked).toContain("This recieve stays.");
    expect(masked).toContain("Fix teh word");
    expect(masked).not.toContain("@@todo");
    expect(masked).not.toContain("doing");
    expect(masked).not.toContain("ddl");
    expect(masked).not.toContain("proof-main");
  });

  test("keeps prose and comment text while masking @@comment syntax", () => {
    const md = "This stays visible.\n@@comment [Fix teh annotation]{k: v}\n";
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(masked).toContain("This stays visible.");
    expect(masked).toContain("Fix teh annotation");
    expect(masked).not.toContain("@@comment");
    expect(masked).not.toContain("k: v");
  });

  test("spell-checks @@scomment prose while masking its command shell", () => {
    const md = "@@scomment [Clarify the recieve condition.]\n";
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(masked).toContain("Clarify the recieve condition.");
    expect(masked).not.toContain("@@scomment");
  });

  test("masks math and fenced code bodies", () => {
    const md = [
      "Check this prose.",
      "$teh + x$",
      "$$",
      "recieve",
      "$$",
      "```ts",
      "const teh = 1;",
      "```",
      "",
    ].join("\n");
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(visible(masked)).toContain("Check this prose.");
    expect(masked).not.toContain("$teh");
    expect(masked).not.toContain("recieve");
    expect(masked).not.toContain("const");
  });

  test("masks LaTeX math and environments while keeping surrounding prose", () => {
    const md = [
      "Keep teh prose before \\(recieve + \\mathrm{GI}\\) and after.",
      "\\[recieve + \\begin{aligned} x &= y \\end{aligned}\\]",
      "\\begin{equation} another recieve \\end{equation}",
    ].join("\n");
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(masked).toContain("Keep teh prose before");
    expect(masked).toContain("and after.");
    expect(masked).not.toContain("recieve");
    expect(masked).not.toContain("aligned");
    expect(masked).not.toContain("equation");
  });

  test("keeps link labels but masks destinations and images", () => {
    const md = "Read [this recieve paper](zotero://select/items/bad-teh) and ![bad alt](img/teh.png).";
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(masked).toContain("this recieve paper");
    expect(masked).not.toContain("zotero");
    expect(masked).not.toContain("bad alt");
    expect(masked).not.toContain("teh.png");
  });

  test("masks front matter, directives, references, and HTML comments", () => {
    const md = [
      "---",
      "title: recieve metadata",
      "---",
      "#+title: another recieve",
      "[paper]: ../../recieve.pdf",
      "<!-- hidden recieve -->",
      "Visible teh prose.",
    ].join("\n");
    const masked = maskAaronnoteProse(md);
    expect(masked.length).toBe(md.length);
    expect(masked).toContain("Visible teh prose.");
    expect(masked).not.toContain("metadata");
    expect(masked).not.toContain("another recieve");
    expect(masked).not.toContain("hidden recieve");
  });

  test("keeps prose org env bodies but masks delimiters", () => {
    const md = "#+begin theorem Spectral\nThe recieve typo is visible.\n#+end theorem\n";
    const masked = maskAaronnoteProse(md);
    expect(masked).toContain("The recieve typo is visible.");
    expect(masked).not.toContain("#+begin");
    expect(masked).not.toContain("Spectral");
    expect(masked).not.toContain("#+end");
  });

  test("browser word collection skips accepted technical words", () => {
    const masked = maskAaronnoteProse("Noema uses CodeMirror. The recieve typo remains.");
    const words = collectBrowserSpellWords(masked).map((entry) => entry.word);
    expect(words).toContain("recieve");
    expect(words).not.toContain("Noema");
    expect(words).not.toContain("CodeMirror");
  });
});
