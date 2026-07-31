import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  formatCitationLabel,
  noteCssHrefFromMarkdown,
  parseMetaEntries,
  renderMarkdownHTML,
  renderPublishedNoteHTML,
} from "../src/render-html.ts";

describe("shared markdown HTML renderer", () => {
  test("renders Wiki links with optional labels while leaving code untouched", () => {
    const html = renderMarkdownHTML("[[Tensor]] and [[Daily Note|today]] and `[[code]]`");
    expect(html).toContain('href="roam://wiki/Tensor"');
    expect(html).toContain('data-wiki-target="Tensor"');
    expect(html).toContain(">today</a>");
    expect(html).toContain("<code>[[code]]</code>");
  });

  test("keeps Jupyter commands hidden by default and emits slide hydration slots on request", () => {
    const markdown = "Before\n\n@@cell(python, python3) [demo-cell]\n\nAfter";
    expect(renderMarkdownHTML(markdown)).not.toContain("demo-cell");

    const html = renderMarkdownHTML(markdown, {
      renderJupyterCells: true,
    });
    expect(html).toContain("aaronnote-slide-jupyter-cell");
    expect(html).toContain('data-aaronnote-cell-command="@@cell(python, python3) [demo-cell]"');
  });

  test("optionally renders authored HTML and sanitizes unsafe attributes", () => {
    const html = renderMarkdownHTML('<div class="grid" onclick="evil()"><strong>Rendered</strong><script>evil()</script></div>', { allowHtml: true });
    expect(html).toContain('<div class="grid"><strong>Rendered</strong></div>');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("script");
  });

  test("renders math and org env blocks with editor DOM", () => {
    const html = renderMarkdownHTML(String.raw`#+begin theorem Spectral
Inline \(x+1\).

\[
y^2
\]
#+end theorem`);

    expect(html).toContain("<org-env-block");
    expect(html).toContain('data-kind="theorem"');
    expect(html).toContain("aaronnote-math-inline");
    expect(html).toContain("<math");
    expect(html).toContain("<math-block");
    expect(html).toContain("math-block-rendered");
    expect(html).not.toContain("math-block-source");
    expect(html).not.toContain("<h1");
  });

  test("renders fold org env as details with markdown summary", () => {
    const html = renderMarkdownHTML([
      "#+begin fold **Details**",
      "Hidden **body**.",
      "#+end fold",
    ].join("\n"));

    expect(html).toContain('<details class="org-env-fold"');
    expect(html).toContain('<summary class="org-env-fold-summary"><strong>Details</strong></summary>');
    expect(html).toContain("<strong>body</strong>");
    expect(html).not.toContain("<org-env-block");
  });

  test("renders math errors instead of empty previews", () => {
    const html = renderMarkdownHTML(String.raw`Inline \(\notacommand\).

\[
\notacommand
\]`);

    expect(html.match(/aaronnote-math-error/g)).toHaveLength(2);
    expect(html).toContain("KaTeX parse error");
    expect(html).toContain("Undefined control sequence");
  });

  test("renders inline @@comment as a collapsed static chip", () => {
    const html = renderMarkdownHTML("Public text @@comment [private note].");

    expect(html).not.toContain("@@comment");
    const root = document.createElement("div");
    root.innerHTML = html;
    const widget = root.querySelector(".inline-comment-widget");
    expect(widget).toBeTruthy();
    expect(widget!.getAttribute("data-comment-open")).toBe("false");
    expect(widget!.querySelector(".org-env-comment-label")?.textContent).toBe("comment");
    const content = widget!.querySelector<HTMLElement>(".org-env-content");
    expect(content?.hidden).toBe(false);
    expect(content?.textContent).toBe("private note");
  });

  test("renders @@comment(true) as an always-visible COMMENT annotation", () => {
    const html = renderMarkdownHTML("Review @@comment(true) [check **this**].");
    const root = document.createElement("div");
    root.innerHTML = html;

    const widget = root.querySelector<HTMLElement>(".inline-comment-display");
    expect(html).not.toContain("@@comment");
    expect(widget?.dataset.commentOpen).toBe("true");
    expect(widget?.getAttribute("role")).toBe("note");
    expect(widget?.querySelector(".inline-comment-display-label")?.textContent).toBe("COMMENT:");
    expect(widget?.querySelector(".inline-comment-display-content strong")?.textContent).toBe("this");
    expect(widget?.querySelector(".org-env-comment-button")).toBeNull();
  });

  test("renders @@cite as stable hydratable HTML without leaking command source", () => {
    const html = renderMarkdownHTML("See @@cite(iso) [Str87; Ive09] {prefix: (; locator: p. 406; suffix: )}.");
    expect(html).not.toContain("@@cite");

    const root = document.createElement("div");
    root.innerHTML = html;
    const cite = root.querySelector<HTMLElement>("[data-cite-state]");
    expect(cite).toBeTruthy();
    expect(cite?.dataset.citeState).toBe("unresolved");
    expect(cite?.dataset.citeNamespace).toBe("iso");
    expect(cite?.dataset.citeKeys).toBe("Str87;Ive09");
    expect(cite?.dataset.citeLocator).toBe("p. 406");
    expect(cite?.getAttribute("role")).toBe("doc-biblioref");
    expect(cite?.textContent).toBe("([Str87; Ive09, p. 406])");
  });

  test("keeps escaped and code citation syntax literal", () => {
    const html = renderMarkdownHTML("Literal \\@@cite(iso) [K] and code `@@cite(iso) [K]`.");
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector("[data-cite-state]")).toBeNull();
    expect(root.textContent?.match(/@@cite\(iso\) \[K\]/g)).toHaveLength(2);
  });

  test("joins citation affixes with punctuation-aware spacing", () => {
    expect(formatCitationLabel("[1]", "see,", ",")).toBe("see, [1],");
    expect(formatCitationLabel("[1]", "(", ")")).toBe("([1])");
    expect(formatCitationLabel("[1]", "compare", "below")).toBe("compare [1] below");
  });

  test("omits todo command lines and trailing attrs from static render", () => {
    const html = renderMarkdownHTML([
      "# Bipartite Graph Tensor",
      "",
      "@@todo(doing) [Bipartite Graph Tensor] { project: iso-202603 phase: graph-tensor sche: 2026-07-08 end: 2026-07-12 prio: A effort: 8h progress: 60 context: GraphTensor ddl: 2026-07-12 }",
      "",
      "Visible text.",
    ].join("\n"));

    expect(html).toContain("Bipartite Graph Tensor");
    expect(html).toContain("Visible text.");
    expect(html).not.toContain("@@todo");
    expect(html).not.toContain("project: iso-202603");
    expect(html).not.toContain("ddl: 2026-07-12");
  });

  test("omits inline todo commands and their trailing attrs from static render", () => {
    const html = renderMarkdownHTML("Before @@todo(done) [hidden inline] {ddl: 2026-07-12} after.");

    expect(html).toContain("Before");
    expect(html).toContain("after.");
    expect(html).not.toContain("@@todo");
    expect(html).not.toContain("hidden inline");
    expect(html).not.toContain("ddl: 2026-07-12");
  });

  test("omits @@cell command lines from static render", () => {
    const html = renderMarkdownHTML([
      "@@cell(lean4, lean4) [ceil-f7whsr]",
      "",
      "Visible text.",
    ].join("\n"));

    expect(html).toContain("Visible text.");
    expect(html).not.toContain("@@cell");
    expect(html).not.toContain("ceil-f7whsr");
  });

  test("renders inline math inside an exported @@comment", () => {
    const html = renderMarkdownHTML(String.raw`Check @@comment [see \(\alpha\)].`);
    const root = document.createElement("div");
    root.innerHTML = html;
    const content = root.querySelector(".org-env-content");
    expect(content?.querySelector(".katex")).toBeTruthy();
  });

  test("renders @@scomment as a published side card", () => {
    const html = renderMarkdownHTML(String.raw`Claim @@scomment [Check **this** with \(x\).] after.`);
    expect(html).not.toContain("@@scomment");

    const root = document.createElement("div");
    root.innerHTML = html;
    const widget = root.querySelector(".inline-side-comment-widget");
    expect(widget).toBeTruthy();
    expect(widget?.getAttribute("role")).toBe("note");
    const card = widget?.querySelector(".inline-side-comment-card");
    expect(card?.querySelector("strong")?.textContent).toBe("this");
    expect(card?.querySelector(".katex")).toBeTruthy();
  });

  test("keeps markdown and math literal inside fenced and inline code", () => {
    const fenced = renderMarkdownHTML("```\ninline \\(x+1\\) and [[wiki]] and **bold**\n```");
    expect(fenced).toContain("<code");
    expect(fenced).not.toContain("aaronnote-math-inline");
    expect(fenced).not.toContain("<strong");
    expect(fenced).toContain("\\(x+1\\)");

    const inline = renderMarkdownHTML("a `\\(x+1\\)` b");
    expect(inline).not.toContain("aaronnote-math-inline");
    expect(inline).toContain("<code>\\(x+1\\)</code>");
  });

  test("keeps org-env syntax literal inside fenced markdown code", () => {
    const html = renderMarkdownHTML([
      "```md",
      "#+begin meta",
      "tags: algebra, linear-algebra, math, reading",
      "#+end meta",
      "```",
    ].join("\n"));

    expect(html).toContain("<code");
    expect(html).toContain("#+begin meta");
    expect(html).not.toContain("aaronnote-meta-cover");
  });

  test("marks roam core links for special rendering", () => {
    const html = renderMarkdownHTML("[section](roam://node-id@main-heading) and [tag](node-id#anchor)");

    expect(html).toContain('class="aaronnote-roam-link"');
    expect(html).toContain('data-roam-link="true"');
  });

  test("renders a local heading fragment containing spaces as one link", () => {
    const html = renderMarkdownHTML("1. [Step 1](#step 1):");
    expect(html).toContain('<a href="#step%201">Step 1</a>:');
    expect(html).not.toContain("(#step 1)");
  });

  test("keeps adversarial unmatched link labels linear in practice", () => {
    const source = "[".repeat(100_000) + " plain";
    const started = performance.now();
    renderMarkdownHTML(source);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("marks jupyter links with toc selectors, including spaces", () => {
    const html = renderMarkdownHTML("[toc](./attachments/tset.ipynb@4) [heading](./attachments/tset.ipynb@test file) [hash](./attachments/tset.ipynb#4)");

    expect(html.match(/data-jupyter-link="true"/g)?.length).toBe(3);
    expect(html).toContain('href="./attachments/tset.ipynb@test file"');
  });

  test("marks Zotero links for the Emacs system opener UI", () => {
    const html = renderMarkdownHTML("[paper](zotero://select/items/1_ABCD)");

    expect(html).toContain('class="aaronnote-zotero-link"');
    expect(html).toContain('data-zotero-link="true"');
    expect(html).toContain('href="zotero://select/items/1_ABCD"');
  });

  test("renders meta blocks with the preview cover", () => {
    const html = renderMarkdownHTML([
      "#+begin meta",
      "title: Meta Cover",
      "date: 2026-05-21",
      "tags: preview, internal_tag, #publish",
      "#+end meta",
    ].join("\n"));

    expect(html).toContain('<div class="cm-org-env-block org-env-block" data-kind="meta" data-label="Meta">');
    expect(html).toContain('<div class="org-env-meta aaronnote-meta-cover">');
    expect(html).toContain('<header class="aaronnote-meta-masthead">');
    expect(html).toContain('<h1 class="aaronnote-meta-title">Meta Cover</h1>');
    expect(html).toContain('<p class="aaronnote-meta-date">2026-05-21</p>');
    expect(html).toContain('<button class="aaronnote-meta-tag">#preview</button>');
    expect(html).toContain('<button class="aaronnote-meta-tag">#publish</button>');
    expect(html).toContain('class="aaronnote-meta-roam-badge"');
    expect(html).not.toContain("#internal_tag");
  });

  test("renders a summary nested in meta as a paper abstract, not an outer summary block", () => {
    const body = [
      "title: Tensor Isomorphism",
      "date: 2026-07-13",
      "tags: algebra, graph, tensor",
      "#+begin summary",
      "We present **three results**.",
      "",
      "1. First reduction.",
      "2. Second reduction.",
      "",
      "status: prose inside the abstract",
      "#+end summary",
    ].join("\n");
    const html = renderMarkdownHTML(`#+begin meta\n${body}\n#+end meta`);

    expect(html).toContain('class="aaronnote-meta-abstract"');
    expect(html).toContain('<span class="aaronnote-meta-abstract-title">Abstract</span>');
    expect(html).toContain("<strong>three results</strong>");
    expect(html).toContain("<ol>");
    expect(html).not.toContain('data-kind="summary"');
    expect(parseMetaEntries(body).map((entry) => entry.key)).toEqual(["title", "date", "tags"]);
  });

  test("marks meta covers that are not indexed by roam db", () => {
    const indexed = renderMarkdownHTML([
      "#+begin meta",
      "id: indexed-id",
      "title: Indexed",
      "#+end meta",
    ].join("\n"));
    const off = renderMarkdownHTML([
      "#+begin meta",
      "id: off-id",
      "title: Off",
      "roam: off",
      "#+end meta",
    ].join("\n"));

    expect(indexed).not.toContain("aaronnote-meta-roam-badge");
    expect(off).toContain('class="aaronnote-meta-roam-badge"');
  });

  test("renders html org env as sanitized html content", () => {
    const html = renderMarkdownHTML([
      "#+begin html",
      '<section class="raw-panel" onclick="alert(1)"><strong>Raw HTML</strong></section>',
      "<script>alert(2)</script>",
      "#+end html",
    ].join("\n"));

    expect(html).toContain('class="aaronnote-html"');
    expect(html).toContain('<section class="raw-panel"><strong>Raw HTML</strong></section>');
    expect(html).not.toContain("&lt;section");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<org-env-block");
  });

  test("renders spaced tikz org env as sandboxed TikZJax iframe fallback", () => {
    const html = renderMarkdownHTML([
      "#+ begin tikz axis 20260525-120000",
      "\\draw (0,0) -- (1,1);",
      "#+ end tikz",
    ].join("\n"));

    expect(html).toContain("aaronnote-tikz");
    expect(html).toContain('class="aaronnote-tikz-embed aaronnote-visual-embed"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain("tikzjax.js");
    expect(html).toContain("\\begin{tikzpicture}");
    expect(html).toContain("\\draw (0,0) -- (1,1);");
    expect(html).not.toContain("<org-env-block");
  });

  test("applies image layout attrs to tikz org env fallback", () => {
    const html = renderMarkdownHTML([
      "#+ begin tikz axis 20260525-120000 {size:320 align:right wrap}",
      "\\draw (0,0) -- (1,1);",
      "#+ end tikz",
    ].join("\n"));

    expect(html).toContain("aaronnote-image-align-right");
    expect(html).toContain("aaronnote-image-wrap");
    expect(html).toContain('data-aaronnote-image-wrap="true"');
    expect(html).toContain("--aaronnote-image-width: 320px");
  });

  test("does not treat lean4 begin/end syntax as an org env", () => {
    const html = renderMarkdownHTML([
      "#+begin lean4 basic",
      "import Mathlib.Tactic",
      "",
      "-- identity",
      "example : True := by",
      "  trivial",
      "#+end lean4",
    ].join("\n"));

    expect(html).not.toContain('data-kind="lean4"');
    expect(html).not.toContain('class="language-lean4"');
    expect(html).not.toContain("aaronnote-lean-code");
    expect(html).toContain("#+begin lean4 basic");
  });

  test("renders inline KaTeX in an org-env block title", () => {
    const html = renderMarkdownHTML(String.raw`#+begin theorem Spectral \(x^2\)
Body.
#+end theorem`);

    const root = document.createElement("div");
    root.innerHTML = html;
    const title = root.querySelector(".org-env-heading-title");
    expect(title).toBeTruthy();
    expect(title!.querySelector(".aaronnote-math-inline")).toBeTruthy();
    expect(title!.querySelector(".katex")).toBeTruthy();
  });

  test("renders semantic part and section headings as outline blocks", () => {
    const html = renderMarkdownHTML([
      "@@part [Foundations]",
      "",
      "@@section(sub) [Inner products]{id: inner-products}",
      "",
      "# Markdown detail",
    ].join("\n"));

    expect(html).toContain('class="aaronnote-section-heading"');
    expect(html).toContain('data-outline-level="1"');
    expect(html).toContain('data-outline-level="3"');
    expect(html).toContain('id="inner-products"');
    expect(html).toContain('class="aaronnote-section-heading-inner"');
    expect(html).toContain('<span class="aaronnote-section-title">Inner products</span>');
    expect(html).not.toContain("@@section");
  });

  test("keeps resolved Noema asset image URLs", () => {
    const html = renderMarkdownHTML("![plot](./images/plot.png)", {
      assetResolver: (src) => `aaronnote-asset://media/?file=${encodeURIComponent(src)}`,
    });

    expect(html).toContain('src="aaronnote-asset://media/?file=.%2Fimages%2Fplot.png"');
    expect(html).toContain('alt="plot"');
  });

  test("keeps parent-directory image URLs for asset resolution", () => {
    const html = renderMarkdownHTML('![plot](<../images/plot.png> "Plot")', {
      assetResolver: (src) => `aaronnote-asset://media/?file=${encodeURIComponent(src)}`,
    });

    expect(html).toContain('src="aaronnote-asset://media/?file=..%2Fimages%2Fplot.png"');
    expect(html).toContain('alt="plot"');
  });

  test("applies Noema image trailing attrs", () => {
    const html = renderMarkdownHTML("![plot](./images/plot.png){size:300%; align:right; wrap:on}");

    expect(html).toContain("aaronnote-image");
    expect(html).toContain("aaronnote-image-align-right");
    expect(html).toContain("aaronnote-image-wrap");
    expect(html).toContain('data-aaronnote-image-align="right"');
    expect(html).toContain('data-aaronnote-image-wrap="true"');
    expect(html).toContain("--aaronnote-image-width: 300%");
    expect(html).toContain("--aaronnote-image-max-width: none");
    expect(html).toContain("--aaronnote-image-max-height: none");
    expect(html).not.toContain("{size:300%");
  });

  test("accepts bare wrap layout attrs", () => {
    const imageHtml = renderMarkdownHTML("![plot](./images/plot.png){size:40% align:left wrap}");
    expect(imageHtml).toContain("aaronnote-image-wrap");
    expect(imageHtml).toContain("aaronnote-image-align-left");
    expect(imageHtml).toContain('data-aaronnote-image-wrap="true"');
    expect(imageHtml).toContain("--aaronnote-image-width: 40%");

    const diagramHtml = renderMarkdownHTML([
      "```marmind",
      "Root",
      "```",
      "{wrap}",
    ].join("\n"));
    expect(diagramHtml).toContain("aaronnote-diagram-wrap");
  });

  test("renders draw.io image syntax as a visual attachment iframe", () => {
    const html = renderMarkdownHTML("![diagram](./attachments/demo.drawio){size:640; align:left}");

    expect(html).toContain("aaronnote-visual-attachment-drawio");
    expect(html).toContain("aaronnote-visual-embed-drawio");
    expect(html).toContain("embed.diagrams.net");
    expect(html).toContain('srcdoc="');
    expect(html).toContain('data-aaronnote-visual-kind="drawio"');
    expect(html).toContain("diagram");
    expect(html).not.toContain("<img");
  });

  test("routes proxied Noema draw.io assets through the local visual frame", () => {
    const mediaUrl = "aaronnote-asset://media?file=./attachments/demo.drawio&base=/notes/demo.md";
    const proxied = `http://127.0.0.1:50815/aaronnote-asset?url=${encodeURIComponent(mediaUrl)}`;
    const html = renderMarkdownHTML("![diagram](./attachments/demo.drawio)", {
      assetResolver: () => proxied,
    });

    expect(html).toContain("aaronnote-visual-attachment-drawio");
    expect(html).toContain("aaronnote-visual-embed-drawio");
    expect(html).toContain('src="http://127.0.0.1:50815/aaronnote-asset?url=');
    expect(html).toContain(encodeURIComponent("aaronnote-asset://visual-frame/drawio"));
    expect(html).toContain(encodeURIComponent(encodeURIComponent(mediaUrl)));
    expect(html).not.toContain('srcdoc="');
    expect(html).not.toContain("Loading draw.io diagram");
  });

  test("renders html image syntax as an isolated visual attachment iframe", () => {
    const html = renderMarkdownHTML("![panel](./attachments/demo.html){size:640; align:left}");

    expect(html).toContain("aaronnote-visual-attachment-html");
    expect(html).toContain("aaronnote-visual-embed-html");
    expect(html).toContain('src="./attachments/demo.html"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(html).toContain('data-aaronnote-visual-kind="html"');
    expect(html).toContain("panel");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("allow-same-origin");
  });

  test("renders empty html links as isolated iframes", () => {
    const html = renderMarkdownHTML("[](./attachments/demo.html)");

    expect(html).toContain("aaronnote-visual-attachment-html");
    expect(html).toContain("aaronnote-visual-embed-html");
    expect(html).toContain('src="./attachments/demo.html"');
    expect(html).toContain('data-aaronnote-visual-kind="html"');
    expect(html).not.toContain("<img");
  });

  test("applies Noema table trailing attrs", () => {
    const html = renderMarkdownHTML([
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "{size:75%; align:right; wrap:on}",
    ].join("\n"));

    expect(html).toContain("<table");
    expect(html).toContain("aaronnote-table-align-right");
    expect(html).toContain("aaronnote-table-wrap");
    expect(html).toContain("--aaronnote-table-width: 75%");
    expect(html).not.toContain("{size:75%");
  });

  test("applies Noema diagram trailing attrs", () => {
    const html = renderMarkdownHTML([
      "```marmind",
      "graph LR",
      "A --- B",
      "```",
      "{size:180%; align:left; wrap:on}",
    ].join("\n"));

    expect(html).toContain("aaronnote-diagram-code");
    expect(html).toContain("aaronnote-diagram-align-left");
    expect(html).toContain("aaronnote-diagram-wrap");
    expect(html).toContain("--aaronnote-diagram-width: 180%");
    expect(html).not.toContain("{size:180%");
  });

  test("renders published notes with the Noema preview shell", () => {
    const html = renderPublishedNoteHTML("Body", {
      title: "Preview Shell",
      group: "QC",
      date: "2026-05-21",
      root: "../",
      kind: "default",
      noteThemeVersion: "test",
    });

    expect(html).toContain('<main class="aaronnote-shell published-note-page" data-note-kind="default">');
    expect(html).toContain('<section class="aaronnote-body">');
    expect(html).toContain('<section class="aaronnote-editor" id="editor">');
    expect(html).toContain('<span class="aaronnote-vim-mode">READ</span>');
    expect(html).toContain('../Noema/src/styles/typography.css?v=test');
    expect(html).toContain("<p>Body</p>");
  });

  test("published notes append meta css after built-in and kind styles", () => {
    const markdown = [
      "#+begin meta",
      "title: Styled Note",
      "css: /tmp/aaronnote/css/note override.css",
      "#+end meta",
      "",
      "Body",
    ].join("\n");
    const html = renderPublishedNoteHTML(markdown, {
      title: "Styled Note",
      root: "./",
      kind: "slides",
      kindAssetsHtml: '  <link rel="stylesheet" href="./kinds/slides/index.css" />',
    });

    expect(noteCssHrefFromMarkdown(markdown)).toBe("file:///tmp/aaronnote/css/note%20override.css");
    expect(html).toContain('data-aaronnote-note-css href="file:///tmp/aaronnote/css/note%20override.css"');
    expect(html.indexOf("./kinds/slides/index.css")).toBeLessThan(html.indexOf("data-aaronnote-note-css"));
    expect(html.indexOf("css/aaronnote-published.css")).toBeLessThan(html.indexOf("data-aaronnote-note-css"));
  });

  test("ignores relative meta css paths", () => {
    expect(noteCssHrefFromMarkdown("#+begin meta\ncss: ./local.css\n#+end meta")).toBe("");
  });

  test("published notes keep the preview-rendered body", () => {
    const markdown = [
      "#+begin meta",
      "title: Meta Title",
      "date: 2026-05-21",
      "#+end meta",
      "",
      "# Meta Title",
      "",
      "## Body Heading",
    ].join("\n");
    const previewHtml = renderMarkdownHTML(markdown);
    const html = renderPublishedNoteHTML(markdown, {
      title: "Meta Title",
      date: "2026-05-21",
      root: "./",
      kind: "default",
    });

    expect(html).toContain(previewHtml);
    expect(html).toContain('<h1 class="aaronnote-meta-title">Meta Title</h1>');
    expect(html).toContain('data-kind="meta"');
    expect(html).toContain("<h1>Meta Title</h1>");
    expect(html).toContain("<h2>Body Heading</h2>");
    expect(html).not.toContain("published-note-cover");
  });

  test("renders standard Markdown footnotes with stable reference and back links", () => {
    const html = renderMarkdownHTML([
      "A claim[^proof] and another reference[^proof].",
      "",
      "[^proof]: **Proof sketch** on one line.",
    ].join("\n"));

    expect(html.match(/aaronnote-footnote-reference/g)).toHaveLength(2);
    expect(html).toContain('href="#fn-proof"');
    expect(html).toContain('id="fn-proof"');
    expect(html).toContain("<strong>Proof sketch</strong>");
    expect(html).toContain('href="#fnref-proof-1"');
    expect(html).not.toContain("[^proof]");
  });

  test("keeps footnote-looking text literal in code and when undefined", () => {
    const html = renderMarkdownHTML("`[^code]` and undefined [^missing].");
    expect(html).toContain("[^code]");
    expect(html).toContain("[^missing]");
    expect(html).not.toContain("aaronnote-footnote-reference");
  });

  test("always exports unresolved revisions with original, advice, and reason", () => {
    const html = renderMarkdownHTML('@@revision(red) [old **claim**] {advice: "new claim"; reason: "clearer"}');
    expect(html).toContain('class="aaronnote-revision"');
    expect(html).toContain('data-revision-style="red"');
    expect(html).toContain("<strong>claim</strong>");
    expect(html).toContain("new claim");
    expect(html).toContain("clearer");
    expect(html).not.toContain("@@revision");
  });
});
