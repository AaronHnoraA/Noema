import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM module outside the TS app graph.
import { academicLatexPostprocess, aaronnoteMarkdownToLatexPandoc, extractAaronnoteMetadata, preprocessAaronnoteForPandoc } from "../server/lib/latex-export-pandoc.mjs";

describe("LaTeX export mechanical fidelity", () => {
  test("preserves blank lines and trailing spaces inside code environments", async () => {
    const source = [
      "```text",
      "line with spaces   ",
      "",
      "",
      "next",
      "```",
    ].join("\n");
    const converted = await aaronnoteMarkdownToLatexPandoc(source);
    expect(converted.body).toContain([
      "\\begin{verbatim}",
      "line with spaces   ",
      "",
      "",
      "next",
      "\\end{verbatim}",
    ].join("\n"));

    const raw = [
      "Intro   ", "", "",
      "\\begin{lstlisting}", "trailing   ", "", "", "next", "\\end{lstlisting}",
      "", "", "Tail   ",
    ].join("\n");
    const polished = academicLatexPostprocess(raw);
    expect(polished).toContain("\\begin{lstlisting}\ntrailing   \n\n\nnext\n\\end{lstlisting}");
    expect(polished).toContain("Intro\n\n");
    expect(polished).toContain("\n\nTail\n");
  });

  test("preserves public suffixes after nested multiline todo attributes", async () => {
    const source = [
      "> Visible before @@todo [secret] {",
      "> nested: {",
      '> text: "quoted',
      '> } still quoted"',
      "> escaped: \\}",
      "> }",
      "> } AFTER MUST SURVIVE",
      "> Tail.",
    ].join("\n");
    const prepared = preprocessAaronnoteForPandoc(source);
    expect(prepared.markdown).toContain("Visible before");
    expect(prepared.markdown).toContain("AFTER MUST SURVIVE");
    expect(prepared.markdown).toContain("Tail.");
    // The todo title is a review annotation; its attribute block is not.
    expect(prepared.markdown).toContain("\\aarontodo{secret}");
    expect(prepared.markdown).not.toContain("still quoted");
    expect(prepared.markdown).not.toContain("nested:");

    const converted = await aaronnoteMarkdownToLatexPandoc(source);
    expect(converted.body).toContain("Visible before");
    expect(converted.body).toContain("AFTER MUST SURVIVE");
    expect(converted.body).toContain("Tail.");
  });

  test("reprocesses a public semantic command after a private closing brace", () => {
    const prepared = preprocessAaronnoteForPandoc([
      "@@todo [private] {",
      "  nested: {value}",
      "} @@section [Public]",
      "# Markdown child",
    ].join("\n"));
    expect(prepared.markdown).toContain("## Public");
    expect(prepared.markdown).toContain("\\subparagraph{Markdown child}");
    expect(prepared.markdown).toContain("\\aarontodo{private}");
    expect(prepared.markdown).not.toContain("nested:");
    expect(prepared.markdown).not.toContain("value");
  });

  test("extracts YAML and Noema metadata with preprocessing precedence", () => {
    expect(extractAaronnoteMetadata([
      "---",
      'title: "YAML title"',
      "date: 2026-07-12",
      "---",
      "",
      "#+begin meta",
      "title: Noema title",
      "bib: ./references.bib",
      "#+end meta",
      "",
      "Body.",
    ].join("\n"))).toEqual({
      title: "Noema title",
      date: "2026-07-12",
      bib: "./references.bib",
    });
  });

  test("does not execute citations inside multiline HTML comments", () => {
    const prepared = preprocessAaronnoteForPandoc([
      "Visible before.",
      "<!-- hidden starts",
      "@@cite(refs) [Hidden]",
      "--> Visible @@cite(refs) [Real].",
    ].join("\n"), {
      citationKeyMap: { ["refs\0Real"]: "refs:Real" },
    });

    expect(prepared.warnings).toEqual([]);
    expect(prepared.markdown).toContain("Visible before.");
    expect(prepared.markdown).toContain("\\cite{refs:Real}");
    expect(prepared.markdown).not.toContain("refs:Hidden");
  });

  test("fails explicitly on an unclosed HTML comment", () => {
    expect(() => preprocessAaronnoteForPandoc("Visible.\n<!-- hidden forever"))
      .toThrow(/unclosed html comment/i);
  });
});
