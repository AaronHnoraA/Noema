/**
 * Emphasis next to CJK punctuation renders in the editor and in HTML, and the
 * widening never changes how CommonMark input parses.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { createMarkdownLanguageExtension } from "../src/cm6/languages/markdown/index.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";
import { cjkFriendlyFlanking, emphasisFlanking } from "../src/cjk-emphasis.ts";

function nodes(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [createMarkdownLanguageExtension()] });
  const tree = ensureSyntaxTree(state, doc.length, 5000)!;
  const names: string[] = [];
  tree.iterate({
    enter(node) {
      if (/^(Emphasis|StrongEmphasis|Strikethrough)$/.test(node.name)) names.push(`${node.name}:${doc.slice(node.from, node.to)}`);
    },
  });
  return names;
}

describe("CJK emphasis", () => {
  test.each([
    ["**（注）**说明", "StrongEmphasis:**（注）**", "<strong>（注）</strong>说明"],
    ["前面**加粗。**后面", "StrongEmphasis:**加粗。**", "前面<strong>加粗。</strong>后面"],
    ["中文**“加粗”**中文", "StrongEmphasis:**“加粗”**", "中文<strong>“加粗”</strong>中文"],
    ["中文*「斜体」*中文", "Emphasis:*「斜体」*", "中文<em>「斜体」</em>中文"],
    ["中文~~「删除」~~中文", "Strikethrough:~~「删除」~~", "中文<s>「删除」</s>中文"],
    ["日本語**「強調」**です", "StrongEmphasis:**「強調」**", "日本語<strong>「強調」</strong>です"],
    ["한국어**(강조)**입니다", "StrongEmphasis:**(강조)**", "한국어<strong>(강조)</strong>입니다"],
  ])("%s", (source, node, html) => {
    expect(nodes(source)).toEqual([node]);
    expect(renderMarkdownHTML(source)).toContain(html);
  });

  test("CommonMark input is unchanged", () => {
    for (const source of ["a**\"b\"**c", "foo*bar*", "snake_case_name", "**bold** text", "a**中文**", "_x_y", "~~gone~~"]) {
      const before = renderMarkdownHTML(source);
      expect(nodes(source).length).toBe((before.match(/<(strong|em|s)>/g) ?? []).length);
    }
    expect(renderMarkdownHTML("snake_case_name")).not.toContain("<em>");
    expect(renderMarkdownHTML("a**\"b\"**c")).not.toContain("<strong>");
    expect(renderMarkdownHTML("a**中文**")).toContain("<strong>中文</strong>");
  });

  test("the widened rule only adds openers and closers", () => {
    const samples = ["", " ", "a", "中", "。", "“", "(", "*", "1"];
    for (const before of samples) {
      for (const after of samples) {
        for (const marker of ["*", "_", "~"] as const) {
          const standard = emphasisFlanking(before, after, marker, false);
          const friendly = cjkFriendlyFlanking(before, after, marker);
          expect(friendly.open || !standard.open).toBe(true);
          expect(friendly.close || !standard.close).toBe(true);
        }
      }
    }
  });
});
