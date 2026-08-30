import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The converter is a Node ESM module outside the TS app graph.
import { aaronnoteMarkdownToLatex, applyLatexTemplate, escapeLatexText, escapeLatexTitle, latexMacrosPackage, latexSideCommentPreamble, writeLatexExport } from "../server/lib/latex-export.mjs";
// @ts-ignore Node ESM module outside the TS app graph.
import { academicLatexPostprocess, aaronnoteMarkdownToLatexPandoc, extractAaronnoteMetadata, preprocessAaronnoteForPandoc } from "../server/lib/latex-export-pandoc.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure, configureLatexProvider, exportLatex, latexExportAgentStatus, latexExportDefaults, listLatexTemplates, setLatexExportAgent } from "../server/lib/index.mjs";

const roots: string[] = [];

afterEach(async () => {
  configureLatexProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupRoot() {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-latex-"));
  const notes = join(root, "roam");
  const templates = join(root, "templates");
  await mkdir(notes, { recursive: true });
  await mkdir(join(templates, "latex"), { recursive: true });
  await writeFile(join(templates, "latex", "noema-article.tex"), [
    "\\documentclass{article}",
    "\\usepackage{amsmath,amsthm}",
    "\\usepackage{aaronnote-macros}",
    "\\newtheorem{theorem}{Theorem}",
    "\\title{ {{title}} }",
    "\\date{ {{date}} }",
    "\\begin{document}",
    "\\maketitle",
    "{{body}}",
    "\\end{document}",
    "",
  ].join("\n"), "utf8");
  roots.push(root);
  configure({
    root: notes,
    workspaceRoot: root,
    pluginRoot: join(root, "plugin"),
    latexTemplatesRoot: templates,
    // Keep unit tests deterministic and offline: never shell out to codex.
    latexExportEngine: "mechanical",
  });
  return { root, notes };
}

describe("LaTeX export", () => {
  test("uses Pandoc for broad native Markdown and academic list structure", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "Setext heading",
      "==============",
      "",
      "---",
      "",
      "(a) First case",
      "(b) Second case",
      "",
      "| Term | Value |",
      "|---|---|",
      "| rank | 2 |",
      "",
      "Definition",
      ": Meaning",
      "",
      "Text with ~~obsolete~~ wording and a footnote.[^1]",
      "",
      "[^1]: Evidence.",
      "",
      "中文第一行",
      "继续第二行",
    ].join("\n"));

    expect(result.body).toContain("\\section{Setext heading}");
    expect(result.body).toContain("\\rule{0.5\\linewidth}{0.5pt}");
    expect(result.body).toContain("\\def\\labelenumi{(\\alph{enumi})}");
    expect(result.body).toContain("\\begin{longtable}");
    expect(result.body).toContain("\\begin{description}");
    expect(result.body).toContain("\\st{obsolete}");
    expect(result.body).toContain("\\footnote{Evidence.}");
    expect(result.body).toContain("中文第一行继续第二行");
  });

  test("balances Noema privacy, semantic blocks, math, and visible anchors", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "#+begin meta", "title: Projector", "#+end meta", "",
      "@@project(active) [Private plan] {", "  area: study", "}", "",
      "#+begin theorem Case \\(x>0\\)",
      "Visible \\(x_1\\) text @@tag[key].",
      "#+end theorem",
      "",
      "~~~text", "@@latexmk(newpage)", "~~~",
    ].join("\n"));
    expect(result.meta.title).toBe("Projector");
    expect(result.body).toContain("\\begin{theorem}[Case \\(x>0\\)]");
    expect(result.body).toContain("Visible \\(x_1\\) text");
    expect(result.body).toContain("\\hypertarget{key}{}");
    expect(result.body).toContain("@@latexmk(newpage)");
    expect(result.body).not.toContain("Private plan");
  });

  test("exports a todo title as an annotation but never its attributes", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "Visible before @@todo [secret] {",
      "  credentials: {",
      "    password: hunter2",
      "  }",
      "}",
      "",
      "Visible after.",
    ].join("\n"));
    expect(result.body).toContain("Visible before");
    expect(result.body).toContain("Visible after.");
    // The title is a review annotation and now reaches the margin. The planning
    // attribute block behind it stays private.
    expect(result.body).toContain("\\aarontodo{secret}");
    expect(result.body).not.toContain("password");
    expect(result.body).not.toContain("hunter2");
  });

  test("honors CommonMark fence character and minimum closing length", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "````text",
      "literal",
      "```",
      "still literal",
      "````",
    ].join("\n"));
    expect(result.body).toContain("\\begin{verbatim}");
    expect(result.body).toContain("```");
    expect(result.body).toContain("still literal");
  });

  test("protects Noema literals inside blockquote fences and balanced link destinations", async () => {
    const quoted = await aaronnoteMarkdownToLatexPandoc([
      "> ```text",
      "> @@todo [literal command]",
      "> @@latexmk(typo)",
      "> ````",
    ].join("\n"));
    expect(quoted.body).toContain("@@todo [literal command]");
    expect(quoted.body).toContain("@@latexmk(typo)");
    const linked = preprocessAaronnoteForPandoc("[x](https://example.com/(a)/@@latexmk(typo))");
    expect(linked.markdown).toContain("@@latexmk(typo)");
    const otherContainers = preprocessAaronnoteForPandoc([
      ">     @@latexmk(typo)",
      "> $$",
      "> @@latexmk(typo)",
      "> $$",
      "",
      "[ref]: https://example.com/@@latexmk(typo)",
    ].join("\n"));
    expect(otherContainers.markdown.match(/@@latexmk\(typo\)/g)).toHaveLength(3);
    const implicitClose = await aaronnoteMarkdownToLatexPandoc([
      "> ```text",
      "> code",
      "outside",
    ].join("\n"));
    expect(implicitClose.body).toContain("\\begin{verbatim}");
    expect(implicitClose.body).toContain("outside");
  });

  test("hides private commands in visible link labels and image alt text", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "[Visible @@comment [secret] label](https://example.com)",
      "",
      "![Visible @@todo [hidden] alt](image.png)",
    ].join("\n"));
    expect(result.body).toContain("Visible");
    expect(result.body).toContain("label");
    expect(result.body).toContain("alt");
    expect(result.body).not.toContain("@@comment");
    expect(result.body).not.toContain("@@todo");
    expect(result.body).not.toContain("secret");
    expect(result.body).not.toContain("hidden");
  });

  test("maps semantic outline commands at Noema's canonical levels", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "@@part [Foundations]",
      "@@section [Linear algebra]",
      "@@section(sec) [Operators]",
      "@@section(sub) [Projectors]",
      "@@section(subsub) [Kernels]",
      "@@section(subsubsub) [Details]",
      "# Markdown child",
    ].join("\n\n"));
    expect(result.body).toContain("\\section{Foundations}");
    expect(result.body).toContain("\\subsection{Linear algebra}");
    expect(result.body).toContain("\\subsection{Operators}");
    expect(result.body).toContain("\\subsubsection{Projectors}");
    expect(result.body).toContain("\\paragraph{Kernels}");
    expect(result.body).toContain("\\subparagraph{Details}");
    expect(result.body).toContain("\\subparagraph{Markdown child}");
    expect(result.body).not.toContain("\\section{Markdown child}");
  });

  test("does not let hidden semantic commands affect public Markdown headings", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "#+begin lean4",
      "@@section [private]",
      "#+end lean4",
      "",
      "@@project(active) [private] {",
      "  note: @@section [also private]",
      "}",
      "",
      "# Public heading",
    ].join("\n"));
    expect(result.body).toContain("\\section{Public heading}");
    expect(result.body).not.toContain("\\subparagraph{Public heading}");
    expect(result.body).not.toContain("private");
  });

  test("reads and consumes standard Markdown title/date front matter", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc([
      "---",
      "title: \"Exact Projector Note\"",
      "date: 2026-07-12",
      "---",
      "",
      "Body.",
    ].join("\n"));
    expect(result.meta).toMatchObject({ title: "Exact Projector Note", date: "2026-07-12" });
    expect(result.body).toContain("Body.");
    expect(result.body).not.toContain("Exact Projector Note");
  });

  test("formats callout titles without inventing visible punctuation or labels", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc("> [!NOTE] Exact title\n> Body.");
    expect(result.body).toContain("\\textbf{Exact title}");
    expect(result.body).not.toContain("NOTE ---");
    expect(result.body).not.toContain("Exact title.");
  });

  test("validates typed LaTeX marks instead of silently swallowing mistakes", () => {
    expect(() => preprocessAaronnoteForPandoc("Text @@latexmk(typo) here."))
      .toThrow(/Unknown @@latexmk mark/);
    expect(() => preprocessAaronnoteForPandoc("@@latexmk(newline) tail"))
      .toThrow(/between visible inline content/);
    expect(() => preprocessAaronnoteForPandoc("prefix @@latexmk(newpage) tail"))
      .toThrow(/alone on its line/);
    expect(() => preprocessAaronnoteForPandoc("left @@latexmk(newline) @@latexmk(newline) right"))
      .toThrow(/between visible inline content/);
    expect(() => preprocessAaronnoteForPandoc("tail @@latexmk(newline)"))
      .toThrow(/between visible inline content/);
    expect(() => preprocessAaronnoteForPandoc("First soft line\n@@latexmk(noindent) continuation"))
      .toThrow(/start of a paragraph/);
    expect(preprocessAaronnoteForPandoc("`@@latexmk(typo)`").markdown).toContain("@@latexmk(typo)");
    expect(preprocessAaronnoteForPandoc("    @@latexmk(typo)").markdown).toContain("@@latexmk(typo)");
  });

  test("emits a non-stretching LaTeX row break for the newline mark", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc(
      "First clause @@latexmk(newline) second clause.",
    );
    expect(result.body).toContain("First clause \\\\ second clause.");
    expect(result.body).not.toContain("\\linebreak");
    const trailing = await aaronnoteMarkdownToLatexPandoc([
      "Question text. @@latexmk(newline)",
      "(a) First part. @@latexmk(newline)",
      "(b) Second part.",
    ].join("\n"));
    expect(trailing.body.match(/\\\\/g)?.length).toBe(2);
  });

  test("preserves canonical inline math even when it has boundary spaces", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc(
      "where \\( \\mathrm{id} \\in \\mathcal{L}(V)\\) is the identity",
    );
    expect(result.body).toContain("\\( \\mathrm{id} \\in \\mathcal{L}(V)\\)");
    expect(result.body).not.toContain("\\$");
  });

  test("keeps unresolved citations visible and reports a warning", async () => {
    const result = await aaronnoteMarkdownToLatexPandoc("See @@cite [Str87].");
    expect(result.body).toContain("\\textnormal{[Str87]}");
    expect(result.warnings).toContain("Unresolved Noema citation kept visibly: Str87");
  });

  test("converts Noema theorem and proof blocks", () => {
    const result = aaronnoteMarkdownToLatex([
      "#+begin meta",
      "title: Graph Tensor",
      "#+end meta",
      "",
      "# Main",
      "",
      "#+begin theorem Edge",
      "\\[",
      "\\lambda_\\otimes(B_G)=\\lambda(G)",
      "\\]",
      "#+end theorem",
      "",
      "#+begin proof =>",
      "If \\(d < \\lambda(G)\\), contradiction.",
      "#+end proof",
      "",
    ].join("\n"));

    expect(result.meta.title).toBe("Graph Tensor");
    expect(result.body).toContain("\\section{Main}");
    expect(result.body).toContain("\\begin{theorem}[Edge]");
    expect(result.body).toContain("\\lambda_\\otimes(B_G)=\\lambda(G)");
    expect(result.body).toContain("\\begin{proof}[Proof (\\(\\Rightarrow\\))]");
    expect(result.body).toContain("If \\(d < \\lambda(G)\\), contradiction.");
  });

  test("converts inline Markdown to valid LaTeX commands", () => {
    const result = aaronnoteMarkdownToLatex(
      "Text **bold_x**, *emphasis*, `a_b`, [paper](https://example.com/a_b), and \\(x_1\\).",
    );

    expect(result.body).toContain("\\textbf{bold\\_x}");
    expect(result.body).toContain("\\emph{emphasis}");
    expect(result.body).toContain("\\texttt{a\\_b}");
    expect(result.body).toContain("\\href{https://example.com/a_b}{paper}");
    expect(result.body).toContain("\\(x_1\\)");
    expect(result.body).not.toContain("\\\\textbf");
    expect(result.body).not.toContain("[paper](");
  });

  test("maps explicit and Markdown line breaks without conflating paragraphs", () => {
    const result = aaronnoteMarkdownToLatex([
      "First line",
      "continues here @@latexmk(newline) next visual line.",
      "",
      "A new paragraph.",
    ].join("\n"));

    expect(result.body).toBe("First line continues here\\\\\nnext visual line.\n\nA new paragraph.\n");
    expect(result.body).not.toContain("@@latexmk");
  });

  test("folds prose lines with CJK-aware spacing and Markdown hard breaks", () => {
    const result = aaronnoteMarkdownToLatex([
      "中文第一行",
      "继续第二行",
      "English first line",
      "continues normally",
      "hard break  ",
      "after break",
    ].join("\n"));

    expect(result.body).toContain("中文第一行继续第二行 English first line continues normally hard break\\\\\nafter break");
  });

  test("preserves nested unordered and ordered list hierarchy", () => {
    const result = aaronnoteMarkdownToLatex([
      "- Parent",
      "    1. First child",
      "    2. Second child",
      "- Tail",
    ].join("\n"));
    expect(result.body).toContain([
      "\\begin{itemize}",
      "\\item Parent",
      "\\begin{enumerate}",
      "\\item First child",
      "\\item Second child",
      "\\end{enumerate}",
      "\\item Tail",
      "\\end{itemize}",
    ].join("\n"));
  });

  test("preserves inline math in document titles, headings, and block labels", () => {
    const result = aaronnoteMarkdownToLatex([
      "# \\(\\lambda\\) and \\(\\kappa\\)",
      "",
      "#+begin theorem Case \\(d < \\lambda(G)\\)",
      "Body.",
      "#+end theorem",
      "",
    ].join("\n"));
    const latex = applyLatexTemplate("\\title{ {{title}} }\n{{body}}", {
      title: escapeLatexTitle("\\(\\lambda\\) and \\(\\kappa\\)"),
      body: result.body,
    });

    expect(result.body).toContain("\\section{\\(\\lambda\\) and \\(\\kappa\\)}");
    expect(result.body).toContain("\\begin{theorem}[Case \\(d < \\lambda(G)\\)]");
    expect(latex).toContain("\\title{ \\(\\lambda\\) and \\(\\kappa\\) }");
    expect(latex).not.toContain("\\textbackslash");
  });

  test("keeps the Proof label visible when a proof has a direction or title", () => {
    const result = aaronnoteMarkdownToLatex([
      "#+begin proof <=",
      "Left direction.",
      "#+end proof",
      "",
      "#+begin proof Easy direction",
      "Right direction.",
      "#+end proof",
    ].join("\n"));
    expect(result.body).toContain("\\begin{proof}[Proof (\\(\\Leftarrow\\))]");
    expect(result.body).toContain("\\begin{proof}[Proof (Easy direction)]");
  });

  test("rejects structurally incomplete source instead of emitting broken LaTeX", () => {
    expect(() => aaronnoteMarkdownToLatex("\\[\nx + y\n")).toThrow(/Unclosed display math.*line 1/);
    expect(() => aaronnoteMarkdownToLatex("```ts\nconst x = 1;\n")).toThrow(/Unclosed Markdown code fence.*line 1/);
    expect(() => aaronnoteMarkdownToLatex("#+begin theorem\nBody\n#+end proof\n")).toThrow(/Mismatched Noema block/);
  });

  test("writes atomically and never writes LaTeX into a non-tex extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-latex-write-"));
    roots.push(root);
    const file = await writeLatexExport(join(root, "paper.pdf"), "\\documentclass{article}\n");
    expect(file).toBe(join(root, "paper.pdf.tex"));
    expect(await readFile(file, "utf8")).toContain("\\documentclass");
    await expect(writeLatexExport("", "body")).rejects.toThrow(/Missing output path/);
  });

  test("fails fast on misspelled template placeholders", () => {
    expect(() => applyLatexTemplate("\\begin{document}{{boddy}}\\end{document}", { body: "Body" }))
      .toThrow(/Unknown LaTeX template placeholder.*boddy/);
  });

  test("builds global KaTeX macros as a standalone shared package", () => {
    const macros = latexMacrosPackage({
      "\\rank": "\\operatorname{rank}",
      "\\ip": "\\left\\langle#1,#2\\right\\rangle",
    });

    expect(macros).toContain("\\ProvidesPackage{aaronnote-macros}");
    expect(macros).toContain("\\providecommand{\\rank}{}");
    expect(macros).toContain("\\renewcommand{\\rank}{\\operatorname{rank}}");
    expect(macros).toContain("\\providecommand{\\ip}[2]{}");
    expect(macros).toContain("\\providecommand{\\sidecomment}");
    expect(macros).toContain("\\providecommand{\\aaroncomment}");
    expect(macros).toContain("COMMENT:");
  });

  test("exports Noema todo titles as annotations and omits their planning attributes", () => {
    const result = aaronnoteMarkdownToLatex([
      "# Main",
      "",
      "@@todo(doing) [draft private reminder] {ddl: 2026-07-03}",
      "@@itodo(doing) [draft internal reminder] {project: iso-202603 ddl: 2026-07-12}",
      "@@todo bare private reminder",
      "",
      "Visible text. @@todo(done) [hidden inline reminder] More text.",
      "",
    ].join("\n"));

    expect(result.body).toContain("Visible text.");
    expect(result.body).toContain("More text.");
    // The title is the review annotation; the planning attribute block is not.
    expect(result.body).toContain("\\aarontodo{draft private reminder}");
    expect(result.body).toContain("\\aarontodo{draft internal reminder}");
    expect(result.body).toContain("\\aarontodo{bare private reminder}");
    expect(result.body).toContain("\\aarontodo{hidden inline reminder}");
    expect(result.body).not.toContain("iso-202603");
    expect(result.body).not.toContain("2026-07-12");
    expect(result.body).not.toContain("2026-07-03");
    expect(result.body).not.toContain("ddl");
  });

  test("omits @@cell commands and Lean4 source blocks from exported body", () => {
    const result = aaronnoteMarkdownToLatex([
      "# Main",
      "",
      "@@cell(lean4, lean4) [ceil-f7whsr]",
      "",
      "#+begin lean4 basic",
      "import Mathlib",
      "example : True := by",
      "  trivial",
      "#+end lean4",
      "",
      "Visible theorem text.",
    ].join("\n"));

    expect(result.body).toContain("\\section{Main}");
    expect(result.body).toContain("Visible theorem text.");
    expect(result.body).not.toContain("@@cell");
    expect(result.body).not.toContain("ceil-f7whsr");
    expect(result.body).not.toContain("Mathlib");
    expect(result.body).not.toContain("trivial");
    expect(result.body).not.toContain("lean4");
  });

  test("exports inline @@comment annotations without leaking command syntax", () => {
    const result = aaronnoteMarkdownToLatex([
      "# Main",
      "",
      "@@comment [a private annotation line]",
      "@@comment(false) [also private]",
      "",
      "Visible text. @@comment [hidden aside] More text.",
      "",
    ].join("\n"));

    expect(result.body).toContain("Visible text.");
    expect(result.body).toContain("More text.");
    expect(result.body).not.toContain("a private annotation line");
    expect(result.body).not.toContain("also private");
    expect(result.body).toContain(String.raw`\aaroncomment{hidden aside}`);
    expect(result.body).not.toContain("@@comment");
  });

  test("exports @@comment(true) as a prominent COMMENT annotation", () => {
    const source = String.raw`Visible @@comment(true) [Check **non-degenerate** \(u,v,w\).] text.`;
    const mechanical = aaronnoteMarkdownToLatex(source);
    const prepared = preprocessAaronnoteForPandoc(source);

    expect(mechanical.body).toContain(String.raw`\aaroncomment{Check \textbf{non-degenerate} \(u,v,w\).}`);
    expect(prepared.markdown).toContain(String.raw`\aaroncomment{Check \textbf{non-degenerate} \(u,v,w\).}`);
    expect(mechanical.body).toContain("Visible");
    expect(mechanical.body).toContain("text.");
  });

  test("keeps unresolved revisions visible in mechanical and Pandoc exports", () => {
    const source = '@@revision(green) [old **claim**] {advice: "new claim"; reason: "clearer"}';
    const mechanical = aaronnoteMarkdownToLatex(source);
    const prepared = preprocessAaronnoteForPandoc(source);
    // `green` is the legacy spelling of the `ok` review kind.
    expect(mechanical.body).toContain(String.raw`\aaronrevision[ok]{old \textbf{claim}}{new claim}{clearer}`);
    expect(prepared.markdown).toContain(String.raw`\aaronrevision[ok]{old \textbf{claim}}{new claim}{clearer}`);
    expect(latexMacrosPackage({})).toContain("\\providecommand{\\aaronrevision}[4][suggest]");
  });

  test("converts @@scomment and reports the required LaTeX feature", () => {
    const result = aaronnoteMarkdownToLatex([
      "# Main",
      "",
      String.raw`Visible @@scomment [Check **non-degenerate** \(u,v,w\).] text.`,
      "",
    ].join("\n"));

    expect(result.body).toContain(String.raw`\sidecomment{Check \textbf{non-degenerate} \(u,v,w\).}`);
    expect(result.body).toContain("Visible");
    expect(result.body).toContain("text.");
    expect(result.features).toEqual({ usesSideComment: true });
  });

  test("keeps side-comment support in the stable shared package", () => {
    const enabled = latexSideCommentPreamble(true);
    expect(enabled).toContain("todonotes");
    expect(enabled).toContain("\\providecommand{\\sidecomment}");
    expect(enabled).toContain("fancyline");
    expect(latexSideCommentPreamble(false)).toBe("");

    const plain = aaronnoteMarkdownToLatex("Plain body.");
    expect(plain.features).toEqual({ usesSideComment: false });
    expect(latexMacrosPackage({})).toContain("todonotes");
  });

  test("writes export and remembers the last path per note", async () => {
    const { notes } = await setupRoot();
    const note = join(notes, "a.md");
    const out = join(notes, "out", "a.tex");
    await writeFile(note, "#+begin meta\ntitle: A\n#+end meta\n\n# A\n\nBody with \\(x\\). @@scomment [Review \\(x\\).]\n", "utf8");

    const exported = await exportLatex({ file: note, outputPath: out }) as { ok?: boolean; file?: string; pdfFile?: string };
    expect(exported.ok).toBe(true);
    expect(exported.file).toBe(out);
    expect(exported.pdfFile).toBe(join(notes, "out", "a.pdf"));
    expect((await readFile(exported.pdfFile!, "utf8")).slice(0, 4)).toBe("%PDF");
    // Title precedence: explicit meta title ("A") wins over the filename ("a").
    const tex = await readFile(out, "utf8");
    expect(tex).toContain("\\title{ A }");
    expect(tex).not.toContain("\\providecommand{\\sidecomment}");
    expect(tex).toContain("\\usepackage{aaronnote-macros}");
    expect(await readFile(join(notes, "out", "aaronnote-macros.sty"), "utf8")).toContain("\\providecommand{\\sidecomment}");
    expect(tex).toContain("\\sidecomment{Review \\(x\\).}");

    const defaults = await latexExportDefaults({ file: note }) as { outputPath?: string };
    expect(defaults.outputPath).toBe(out);
  });

  test("routes production preparation, metadata, postprocess, and template planning through the configured kernel provider", async () => {
    const { notes } = await setupRoot();
    const note = join(notes, "kernel-transform.md");
    const out = join(notes, "kernel-transform.tex");
    await writeFile(note, "#+begin meta\ntitle: Kernel transform\n#+end meta\n\n# Heading\n\nBody.\n", "utf8");
    const provider = {
      prepare: vi.fn(async (markdown: string, options: Record<string, unknown>) => preprocessAaronnoteForPandoc(markdown, options)),
      metadata: vi.fn(async (markdown: string) => extractAaronnoteMetadata(markdown)),
      postprocess: vi.fn(async (latex: string) => academicLatexPostprocess(latex)),
      planTemplate: vi.fn(async (template: string) => ({ template })),
      renderTemplate: vi.fn((plan: { template: string }, vars: Record<string, string>) => applyLatexTemplate(plan.template, vars)),
    };
    configureLatexProvider(provider);
    const exported = await exportLatex({ file: note, outputPath: out }) as { ok?: boolean; transformSource?: string };
    expect(exported.ok).toBe(true);
    expect(exported.transformSource).toBe("kernel-latex");
    expect(provider.prepare).toHaveBeenCalledOnce();
    expect(provider.metadata).toHaveBeenCalledOnce();
    expect(provider.postprocess).toHaveBeenCalledOnce();
    expect(provider.planTemplate).toHaveBeenCalledOnce();
    expect(provider.renderTemplate).toHaveBeenCalled();
    expect(await readFile(out, "utf8")).toContain("Kernel transform");
  });

  test("lists templates and parses their headers", async () => {
    const { root } = await setupRoot();
    const latexDir = join(root, "templates", "latex");
    await writeFile(join(latexDir, "noema-assignment.tex"), [
      '% aaronnote-template: {"name":"Assignment","engine":"xelatex","vars":[{"id":"coursecode","label":"Course code","default":"COMP"}]}',
      "\\documentclass{article}",
      "\\newcommand{\\coursecodevalue}{ {{coursecode}} }",
      "\\begin{document}{{body}}\\end{document}",
      "",
    ].join("\n"), "utf8");

    const result = await listLatexTemplates() as { templates?: Array<Record<string, unknown>> };
    const templates = result.templates || [];
    const article = templates.find((t) => t.key === "noema-article");
    const assignment = templates.find((t) => t.key === "noema-assignment");
    expect(templates[0]?.key).toBe("noema-article"); // default sorts first
    expect(article?.engine).toBe("pdflatex"); // header-less falls back to pdflatex
    expect(assignment?.name).toBe("Assignment");
    expect(assignment?.engine).toBe("xelatex");
    expect((assignment?.vars as Array<Record<string, unknown>>)[0]?.id).toBe("coursecode");
  });

  test("selects a template by path and fills declared vars", async () => {
    const { root, notes } = await setupRoot();
    const templatePath = join(root, "templates", "latex", "noema-assignment.tex");
    await writeFile(templatePath, [
      '% aaronnote-template: {"name":"Assignment","engine":"pdflatex","vars":[{"id":"coursecode","label":"Course code","default":"COMP"}]}',
      "\\documentclass{article}",
      "\\newcommand{\\course}{ {{coursecode}} }",
      "\\begin{document}",
      "{{body}}",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");
    const note = join(notes, "assg.md");
    await writeFile(note, "# Q1\n\nBody text.\n", "utf8");
    const out = join(notes, "assg.tex");

    const exported = await exportLatex({
      file: note,
      outputPath: out,
      templatePath,
      vars: { coursecode: "COMP&3453" },
    }) as { ok?: boolean; template?: string; engine?: string; title?: string };
    expect(exported.ok).toBe(true);
    expect(exported.template).toBe(templatePath);
    expect(exported.engine).toBe("pandoc");
    expect(exported.title).toBe("Assignment"); // internal slug "assg" is not presentation-ready
    const tex = await readFile(out, "utf8");
    expect(tex).toContain("\\newcommand{\\course}{ COMP\\&3453 }");
    expect(tex).toContain("Body text.");

    // The chosen template + vars are remembered for the next export of this note.
    const defaults = await latexExportDefaults({ file: note }) as { template?: string; vars?: Record<string, string> };
    expect(defaults.template).toBe(templatePath);
    expect(defaults.vars?.coursecode).toBe("COMP&3453");
  });

  test("rejects invalid embedded template schemas instead of silently defaulting", async () => {
    const { root, notes } = await setupRoot();
    const templatePath = join(root, "templates", "latex", "invalid.tex");
    await writeFile(templatePath, [
      '% aaronnote-template: {"name":"Invalid","engine":"word","vars":[]}',
      "\\documentclass{article}", "\\begin{document}", "{{body}}", "\\end{document}", "",
    ].join("\n"), "utf8");
    const note = join(notes, "invalid.md");
    await writeFile(note, "Body.\n", "utf8");
    await expect(exportLatex({ file: note, outputPath: join(notes, "invalid.tex"), templatePath }))
      .rejects.toThrow(/Invalid LaTeX template header.*unsupported engine/);
  });

  test("syncs declared template support files only when missing or outdated", async () => {
    const { root, notes } = await setupRoot();
    const templateDir = join(root, "templates", "latex");
    const templatePath = join(templateDir, "shared.tex");
    const classPath = join(templateDir, "shared.cls");
    await writeFile(classPath, "\\NeedsTeXFormat{LaTeX2e}\n\\ProvidesClass{shared}\n\\LoadClass{article}\n", "utf8");
    await writeFile(templatePath, [
      '% aaronnote-template: {"name":"Shared","engine":"pdflatex","sharedFiles":["shared.cls"]}',
      "\\documentclass{shared}",
      "\\begin{document}",
      "{{body}}",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");
    const note = join(notes, "shared.md");
    const out = join(notes, "export", "shared.tex");
    await writeFile(note, "Body.\n", "utf8");

    const first = await exportLatex({ file: note, outputPath: out, templatePath }) as { sharedFiles?: Array<{ updated: boolean }> };
    expect(first.sharedFiles?.[0]?.updated).toBe(true);
    expect(await readFile(join(notes, "export", "shared.cls"), "utf8")).toContain("ProvidesClass{shared}");
    const second = await exportLatex({ file: note, outputPath: out, templatePath }) as { sharedFiles?: Array<{ updated: boolean }> };
    expect(second.sharedFiles?.[0]?.updated).toBe(false);
  });

  test("does not force document title markup into templates without a title placeholder", async () => {
    const { root, notes } = await setupRoot();
    const templatePath = join(root, "templates", "latex", "body-only.tex");
    await writeFile(templatePath, [
      '% aaronnote-template: {"name":"Body only","engine":"pdflatex"}',
      "\\documentclass{article}",
      "\\begin{document}",
      "{{body}}",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");
    const note = join(notes, "body-only.md");
    await writeFile(note, "# Generic\n\nActual body.\n", "utf8");
    const out = join(notes, "body-only.tex");

    await exportLatex({ file: note, outputPath: out, templatePath });
    const tex = await readFile(out, "utf8");
    expect(tex).toContain("Actual body.");
    expect(tex).not.toContain("\\title{");
    expect(tex).not.toContain("\\maketitle");
  });

  test("switches and persists the LaTeX export agent backend at runtime", async () => {
    const { root } = await setupRoot();
    let status = await setLatexExportAgent({ agent: "opencode" }) as { agent?: string; engine?: string };
    expect(status.agent).toBe("opencode");
    expect(status.engine).toBe("codex");

    configure({
      root: join(root, "roam"),
      workspaceRoot: root,
      latexTemplatesRoot: join(root, "templates"),
      latexExportEngine: "mechanical",
      latexExportAgent: "codex",
    });
    status = await latexExportAgentStatus() as { agent?: string; engine?: string };
    expect(status.agent).toBe("opencode");
    expect(status.engine).toBe("codex");
  });

  test("merges agent-maintained conversion rules into the Pandoc draft", async () => {
    const { root, notes } = await setupRoot();
    const agentDir = join(root, "agents", "latex-export");
    await mkdir(join(agentDir, "mechanical"), { recursive: true });
    await writeFile(join(agentDir, "mechanical", "rules.json"),
      JSON.stringify({ envMap: { claim: "theorem" } }), "utf8");
    configure({
      root: notes,
      workspaceRoot: root,
      latexTemplatesRoot: join(root, "templates"),
      latexExportEngine: "mechanical",
      latexAgentDir: agentDir,
    });
    const note = join(notes, "claim.md");
    await writeFile(note, "#+begin claim Key\nBody.\n#+end claim\n", "utf8");
    const out = join(notes, "claim.tex");
    await exportLatex({ file: note, outputPath: out });
    const tex = await readFile(out, "utf8");
    expect(tex).toContain("\\begin{theorem}[Key]");
  });

  test("does not silently bypass the configured agent when a requested polish cannot run", async () => {
    const { root, notes } = await setupRoot();
    configure({
      root: notes,
      workspaceRoot: root,
      latexTemplatesRoot: join(root, "templates"),
      latexExportEngine: "codex",
      latexCodexBin: "/nonexistent/codex-binary",
    });
    const note = join(notes, "c.md");
    await writeFile(note, "# C\n\nBody.\n", "utf8");
    const out = join(notes, "c.tex");
    await expect(exportLatex({ file: note, outputPath: out, polish: true }))
      .rejects.toThrow(/configured latex polish agent is unavailable/i);
    await expect(readFile(out, "utf8")).rejects.toThrow();
  });

  test("blocks partial and malformed citations before writing export files", async () => {
    const { notes } = await setupRoot();
    const note = join(notes, "citations.md");
    const bib = join(notes, "refs.bib");
    await writeFile(bib, "@book{A, author={Author, A}, title={Alpha}, year={2026}}", "utf8");
    await writeFile(note, [
      "#+begin meta", "bib: ./refs.bib", "#+end meta", "",
      "See @@cite(refs) [A; Missing].",
    ].join("\n"), "utf8");
    const partialOut = join(notes, "partial.tex");

    await expect(exportLatex({ file: note, outputPath: partialOut }))
      .rejects.toThrow(/unknown BibTeX key: Missing/i);
    await expect(readFile(partialOut, "utf8")).rejects.toThrow();

    await writeFile(note, [
      "#+begin meta", "bib: ./refs.bib", "#+end meta", "",
      "See @@cite(refs) [A] {locator: p. 2",
    ].join("\n"), "utf8");
    const malformedOut = join(notes, "malformed.tex");
    await expect(exportLatex({ file: note, outputPath: malformedOut }))
      .rejects.toThrow(/unclosed command arguments/i);
    await expect(readFile(malformedOut, "utf8")).rejects.toThrow();
  });

  test("runs the configured agent when a polish pass is explicitly requested", async () => {
    const { root, notes } = await setupRoot();
    const agent = join(root, "fake-opencode.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"full audit complete\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"layout already appropriate\"}]}' > review.json",
      "exit 0",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    configure({
      root: notes,
      workspaceRoot: root,
      latexTemplatesRoot: join(root, "templates"),
      latexExportEngine: "codex",
      latexExportAgent: "opencode",
      latexOpencodeBin: agent,
    });
    const note = join(notes, "assisted.md");
    const out = join(notes, "assisted.tex");
    await writeFile(note, "Verified body.\n", "utf8");

    const result = await exportLatex({ file: note, outputPath: out, polish: true }) as {
      engine?: string;
      agent?: { backend?: string; attempts?: number; applied?: number; kept?: number; elapsedMs?: number };
    };

    expect(result.engine).toBe("opencode");
    expect(result.agent).toMatchObject({ backend: "opencode", attempts: 1, applied: 0, kept: 2 });
    expect(result.agent?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(await readFile(out, "utf8")).toContain("Verified body.");
  });

  test("honors annotations:none from the whole note when exporting one scope", async () => {
    const { notes } = await setupRoot();
    const note = join(notes, "scoped-annotations.md");
    const documentContent = [
      "#+begin meta",
      "annotations: none",
      "#+end meta",
      "",
      "## Section",
      "",
      "Body @@todo [private reminder] tail.",
      "",
    ].join("\n");
    await writeFile(note, documentContent, "utf8");
    const out = join(notes, "scoped-annotations.tex");

    // The exported scope starts below the metadata block, so the switch can only
    // work if it is resolved from the whole document.
    const scope = "Body @@todo [private reminder] tail.\n";
    await exportLatex({ file: note, content: scope, documentContent, outputPath: out, scope: "heading" });

    const tex = await readFile(out, "utf8");
    expect(tex).toContain("Body");
    expect(tex).not.toContain("aarontodo");
    expect(tex).not.toContain("private reminder");
  });

  test("skips the agent entirely when the polish pass is turned off", async () => {
    const { root, notes } = await setupRoot();
    const agent = join(root, "must-not-run.sh");
    await writeFile(agent, ["#!/bin/sh", "echo 'agent should not have run' >&2", "exit 1"].join("\n"), "utf8");
    await chmod(agent, 0o755);
    configure({
      root: notes,
      workspaceRoot: root,
      latexTemplatesRoot: join(root, "templates"),
      latexExportEngine: "codex",
      latexExportAgent: "opencode",
      latexOpencodeBin: agent,
    });
    const note = join(notes, "unpolished.md");
    const out = join(notes, "unpolished.tex");
    await writeFile(note, "Verified body.\n", "utf8");

    const result = await exportLatex({ file: note, outputPath: out, polish: false }) as {
      engine?: string;
      warnings?: string[];
    };

    expect(result.engine).toBe("pandoc");
    expect((result.warnings || []).join("\n")).not.toMatch(/agent should not have run/);
    expect(await readFile(out, "utf8")).toContain("Verified body.");
  });

  test("commits the verified Pandoc draft when the agent fails its gates", async () => {
    const { root, notes } = await setupRoot();
    const agent = join(root, "failing-opencode.sh");
    await writeFile(agent, ["#!/bin/sh", "echo 'model unavailable' >&2", "exit 1"].join("\n"), "utf8");
    await chmod(agent, 0o755);
    configure({
      root: notes,
      workspaceRoot: root,
      latexTemplatesRoot: join(root, "templates"),
      latexExportEngine: "codex",
      latexExportAgent: "opencode",
      latexOpencodeBin: agent,
    });
    const note = join(notes, "agent-failed.md");
    const out = join(notes, "agent-failed.tex");
    await writeFile(note, "Verified body.\n", "utf8");

    // The mechanical draft already compiled. Losing the whole export because a
    // free-form polish attempt failed would throw away a usable result.
    const result = await exportLatex({ file: note, outputPath: out, polish: true }) as {
      engine?: string;
      warnings?: string[];
      agent?: { used?: boolean };
    };

    expect(result.engine).toBe("pandoc");
    expect(result.agent?.used).toBe(false);
    expect((result.warnings || []).join("\n")).toMatch(/opencode/i);
    expect(await readFile(out, "utf8")).toContain("Verified body.");
  });

  test("prefers the source name over generated content summaries", async () => {
    const { notes } = await setupRoot();
    const note = join(notes, "cheat-sheet.md");
    await writeFile(note, "# Linear Algebra Notes\n\nBody.\n", "utf8");
    const out = join(notes, "h.tex");
    const exported = await exportLatex({ file: note, outputPath: out }) as { ok?: boolean; title?: string };
    expect(exported.title).toBe("cheat sheet");
    expect(await readFile(out, "utf8")).toContain("\\title{ cheat sheet }");
  });

  test("validates body cardinality for headerless templates", async () => {
    const { root, notes } = await setupRoot();
    const note = join(notes, "body-cardinality.md");
    await writeFile(note, "Public body.\n", "utf8");
    const latexDir = join(root, "templates", "latex");
    const missing = join(latexDir, "missing-body.tex");
    const duplicate = join(latexDir, "duplicate-body.tex");
    await writeFile(missing, "\\documentclass{article}\n\\begin{document}\nNothing.\n\\end{document}\n", "utf8");
    await writeFile(duplicate, "\\documentclass{article}\n\\begin{document}\n{{body}}\n{{body}}\n\\end{document}\n", "utf8");

    await expect(exportLatex({ file: note, outputPath: join(notes, "missing.tex"), templatePath: missing }))
      .rejects.toThrow(/body.*exactly once/i);
    await expect(exportLatex({ file: note, outputPath: join(notes, "duplicate.tex"), templatePath: duplicate }))
      .rejects.toThrow(/body.*exactly once/i);
  });

  test("uses live full-document metadata for a scoped body export", async () => {
    const { notes } = await setupRoot();
    const note = join(notes, "scoped.md");
    const documentContent = [
      "#+begin meta",
      "title: Authoritative Live Title",
      "date: 2026-07-01",
      "#+end meta",
      "",
      "# Included",
      "Scoped body.",
    ].join("\n");
    // Persist deliberately stale metadata: the live editor content must win.
    await writeFile(note, documentContent.replace("Authoritative Live Title", "Stale Disk Title"), "utf8");
    const out = join(notes, "scoped.tex");

    const result = await exportLatex({
      file: note,
      content: "# Included\nScoped body.\n",
      documentContent,
      outputPath: out,
    }) as { title?: string };

    expect(result.title).toBe("Authoritative Live Title");
    const tex = await readFile(out, "utf8");
    expect(tex).toContain("\\title{ Authoritative Live Title }");
    expect(tex).toContain("\\date{ 2026-07-01 }");
    expect(tex).toContain("Scoped body.");
    expect(tex).not.toContain("Stale Disk Title");
  });

  test("fails when an explicitly selected template cannot be read", async () => {
    const { root, notes } = await setupRoot();
    const note = join(notes, "missing-template.md");
    await writeFile(note, "Public body.\n", "utf8");
    const missing = join(root, "templates", "latex", "does-not-exist.tex");
    await expect(exportLatex({ file: note, outputPath: join(notes, "out.tex"), templatePath: missing }))
      .rejects.toThrow(/selected latex template could not be read/i);
  });

  test("keeps the previous tex and PDF when staged compilation fails", async () => {
    const { root, notes } = await setupRoot();
    const note = join(notes, "transaction.md");
    const outDir = join(notes, "verified");
    const out = join(outDir, "transaction.tex");
    const pdf = join(outDir, "transaction.pdf");
    const templatePath = join(root, "templates", "latex", "broken.tex");
    await mkdir(outDir, { recursive: true });
    await writeFile(note, "New public body.\n", "utf8");
    await writeFile(out, "OLD VERIFIED TEX\n", "utf8");
    await writeFile(pdf, "OLD VERIFIED PDF\n", "utf8");
    await writeFile(templatePath, [
      "\\documentclass{article}",
      "\\begin{document}",
      "{{body}}",
      "\\DefinitelyUndefinedAaronnoteCommand",
      "\\end{document}",
      "",
    ].join("\n"), "utf8");

    await expect(exportLatex({ file: note, outputPath: out, templatePath }))
      .rejects.toThrow(/PDF compilation failed|undefined control/i);
    expect(await readFile(out, "utf8")).toBe("OLD VERIFIED TEX\n");
    expect(await readFile(pdf, "utf8")).toBe("OLD VERIFIED PDF\n");
  });
});

describe("LaTeX export regressions", () => {
  test("keeps every link on a line whose label carries a private command", () => {
    const result = preprocessAaronnoteForPandoc(
      "See [a @@todo one](http://x.com) and [b](http://y.com) end.",
    );
    // A greedy label match used to span both links and delete the first
    // destination, the prose between them, and the second link outright.
    expect(result.markdown).toBe("See [a ](http://x.com) and [b](http://y.com) end.");
  });

  test("scopes label stripping to the outer link when a label contains a link", () => {
    const result = preprocessAaronnoteForPandoc(
      "Nested [see [1](http://inner) more @@todo x](http://outer) tail.",
    );
    expect(result.markdown).toBe("Nested [see [1](http://inner) more ](http://outer) tail.");
  });

  test("escapes a literal backslash as \\textbackslash{} without re-escaping its braces", () => {
    expect(escapeLatexText("path C:\\dir")).toBe("path C:\\textbackslash{}dir");
    expect(escapeLatexTitle("A \\ B")).toBe("A \\textbackslash{} B");
    expect(escapeLatexText("a_b {c} 100% #1 ^ ~"))
      .toBe("a\\_b \\{c\\} 100\\% \\#1 \\textasciicircum{} \\textasciitilde{}");
  });

  test("rejects instead of crashing the host when pandoc exits before draining stdin", async () => {
    // Writing into the closed pipe emits EPIPE on child.stdin. With no listener
    // there, the unhandled `error` event is an uncaught exception that takes the
    // whole web host down rather than failing this one export.
    await expect(aaronnoteMarkdownToLatexPandoc("x".repeat(2 * 1024 * 1024), {
      pandocBin: "/usr/bin/false",
    })).rejects.toThrow(/Pandoc Markdown/);
  });
});
