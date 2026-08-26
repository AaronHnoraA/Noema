/**
 * The editor projects `{#id}` anchors and `((id "label"))` references into
 * badges and chips (block-anchor.ts / block-ref.ts). Export and publish share
 * render-html.ts, which used to leak both as raw source — every anchored
 * paragraph published a visible `{#0198fbac-…}`.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { renderMarkdownHTML } from "../src/render-html.ts";

const ID = "0198fbac-0780-7c99-85e6-333333333333";
const SHORT = "…333333";

describe("block anchors export as a quiet badge, not raw source", () => {
  test("a trailing anchor on a paragraph", () => {
    const html = renderMarkdownHTML(`Some paragraph. {#${ID}}`);
    expect(html).not.toContain(`{#${ID}}`);
    expect(html).toContain(`data-block-id="${ID}"`);
    expect(html).toContain(`#${SHORT}`);
    expect(html).toContain("Some paragraph.");
  });

  test("a trailing anchor on a heading", () => {
    const html = renderMarkdownHTML(`# Title {#${ID}}`);
    expect(html).not.toContain("{#");
    expect(html).toContain("<h1>Title");
    expect(html).toContain('class="cm-noema-block-id"');
  });

  test("a trailing anchor on a list item", () => {
    const html = renderMarkdownHTML(`- item {#${ID}}`);
    expect(html).not.toContain("{#");
    expect(html).toContain("<li>item");
  });

  test("the full id stays available for hydration and hover", () => {
    const html = renderMarkdownHTML(`Body {#${ID}}`);
    expect(html).toContain(`title="${ID}"`);
  });
});

describe("block references export as their anchor text", () => {
  test("a quoted label renders as the label", () => {
    const html = renderMarkdownHTML(`See ((${ID} "Spectral theorem")) here.`);
    expect(html).not.toContain("((");
    expect(html).toContain(">Spectral theorem</span>");
    expect(html).toContain(`data-block-ref="${ID}"`);
  });

  test("a bare reference degrades to the short id, like the editor chip", () => {
    const html = renderMarkdownHTML(`See ((${ID})) here.`);
    expect(html).not.toContain("((");
    expect(html).toContain(`#${SHORT}`);
    expect(html).toContain('class="cm-block-ref"');
  });

  test("an escaped quote inside the label survives", () => {
    const html = renderMarkdownHTML(`((${ID} "a \\"b\\" c"))`);
    expect(html).toContain(">a \"b\" c<");
  });

  test("the timestamp-shaped legacy id stays readable", () => {
    const html = renderMarkdownHTML(`((20260825095344-8w75nfv "legacy"))`);
    expect(html).toContain(">legacy</span>");
  });
});

describe("code and math keep block identity syntax literal", () => {
  test("inline code", () => {
    const html = renderMarkdownHTML(`\`{#${ID}}\` and \`((${ID}))\``);
    expect(html).toContain(`<code>{#${ID}}</code>`);
    expect(html).toContain(`<code>((${ID}))</code>`);
  });

  test("a fenced block", () => {
    const html = renderMarkdownHTML("```\n{#" + ID + "}\n((" + ID + "))\n```");
    expect(html).toContain(`{#${ID}}`);
    expect(html).toContain(`((${ID}))`);
    expect(html).not.toContain("cm-noema-block-id");
  });

  test("ordinary parentheses are untouched", () => {
    const html = renderMarkdownHTML("f((x)) and g((1))");
    expect(html).toContain("f((x))");
    expect(html).toContain("g((1))");
  });

  test("an org-env identity keeps its own badge and is not double-rendered", () => {
    const html = renderMarkdownHTML(`#+begin theorem Spectral {#${ID}}\nBody.\n#+end theorem`);
    expect(html).toContain('class="org-env-block-id"');
    expect(html).not.toContain("cm-noema-block-id");
  });
});

describe("wiki links carry each class once", () => {
  test("noema-internal-link is not duplicated", () => {
    const html = renderMarkdownHTML("[[Tensor]]");
    const classes = /class="([^"]*)"/u.exec(html)?.[1] ?? "";
    const names = classes.split(/\s+/u).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("noema-internal-link");
    expect(names).toContain("aaronnote-roam-link");
  });
});

describe("labels survive markdown-special characters", () => {
  test("emphasis markers inside a label stay part of the label", () => {
    const html = renderMarkdownHTML(`((${ID} "a*b*c"))`);
    expect(html).not.toContain("<em>");
    expect(html).toContain(">a*b*c</span>");
  });

  test("brackets and underscores inside a label", () => {
    expect(renderMarkdownHTML(`((${ID} "a [b] c"))`)).toContain(">a [b] c</span>");
    expect(renderMarkdownHTML(`((${ID} "a_b_c"))`)).toContain(">a_b_c</span>");
  });

  test("surrounding markdown still renders normally", () => {
    const html = renderMarkdownHTML(`*before* ((${ID} "ref")) **after**`);
    expect(html).toContain("<em>before</em>");
    expect(html).toContain("<strong>after</strong>");
    expect(html).toContain(">ref</span>");
  });

  test("several identities in one paragraph", () => {
    const html = renderMarkdownHTML(`((${ID} "one")) and ((${ID} "two")) {#${ID}}`);
    expect(html).toContain(">one</span>");
    expect(html).toContain(">two</span>");
    expect(html).toContain("cm-noema-block-id");
    expect(html).not.toContain("((");
  });

  test("an inline code span between two references stays literal", () => {
    const html = renderMarkdownHTML(`((${ID} "a")) \`((${ID}))\` ((${ID} "b"))`);
    expect(html).toContain(`<code>((${ID}))</code>`);
    expect(html).toContain(">a</span>");
    expect(html).toContain(">b</span>");
  });

  test("inline math next to an anchor stays math", () => {
    const html = renderMarkdownHTML(String.raw`\(x^2\) {#${ID}}`);
    expect(html).toContain("aaronnote-math-inline");
    expect(html).toContain("cm-noema-block-id");
  });
});
