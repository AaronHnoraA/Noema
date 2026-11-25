import type MarkdownIt from "markdown-it";
import { highlightCode, type CodeHighlightRange } from "./code-highlight.ts";
import { codeHighlightSource, codeRowClasses, codeRows, codeWhitespaceMarks, codeWordMarks } from "./code-annotation.ts";
import type { CodeInfo } from "./code-info.ts";

function renderCodeText(text: string, layers: CodeHighlightRange[][], escape: (text: string) => string): string {
  const stops = new Set([0, text.length]);
  for (const ranges of layers) for (const { from, to } of ranges) {
    stops.add(from);
    stops.add(to);
  }
  const boundaries = [...stops].sort((a, b) => a - b);
  const cursors = layers.map(() => 0);
  let html = "";
  for (let index = 1; index < boundaries.length; index++) {
    const from = boundaries[index - 1]!;
    const to = boundaries[index]!;
    const classes: string[] = [];
    layers.forEach((ranges, layer) => {
      let cursor = cursors[layer]!;
      while (ranges[cursor] && ranges[cursor]!.to <= from) cursor++;
      cursors[layer] = cursor;
      const mark = ranges[cursor];
      if (mark && mark.from <= from) classes.push(mark.className);
    });
    const part = escape(text.slice(from, to));
    html += classes.length ? `<span class="${classes.join(" ")}">${part}</span>` : part;
  }
  return html;
}

export function renderAnnotatedCode(md: MarkdownIt, info: CodeInfo, source: string, expand: boolean): string {
  const escape = md.utils.escapeHtml;
  const rows = codeRows(source);
  const syntax = highlightCode(info.lang, codeHighlightSource(source, rows));
  const highlighted = new Set(info.highlight);
  let cursor = 0;
  const content = rows.map((row, index) => {
    const end = row.from + row.text.length;
    const tokens: CodeHighlightRange[] = [];
    while (syntax[cursor] && syntax[cursor]!.to <= row.from) cursor++;
    for (let offset = cursor; offset < syntax.length; offset++) {
      const token = syntax[offset]!;
      if (token.from >= end) break;
      tokens.push({ from: Math.max(0, token.from - row.from), to: Math.min(end, token.to) - row.from, className: token.className });
    }
    const classes = codeRowClasses(row, highlighted.has(index + 1));
    const number = info.numbers !== null ? ` data-code-number="${info.numbers + index}"` : "";
    const text = renderCodeText(row.text, [tokens, codeWordMarks(row.text, [...info.words, ...row.words]), codeWhitespaceMarks(row.text, info)], escape);
    return `<span class="noema-code-row${classes ? ` ${classes}` : ""}"${number}>${text}${row.newline ? "\n" : ""}</span>`;
  });
  const language = info.lang ? ` class="language-${escape(info.lang)}"` : "";
  const pre = (body: string[]) => `<pre><code${language}>${body.join("")}</code></pre>`;
  const remain = expand || info.collapsedLines === null ? 0 : Math.max(0, rows.length - info.collapsedLines);
  const name = info.title || info.lang;
  const caption = name ? `<figcaption class="noema-code-title">${escape(name)}</figcaption>` : "";
  const numbers = info.numbers === null ? "" : ` style="--code-number-width:${String(info.numbers + rows.length - 1).length}ch"`;
  const main = pre(remain ? content.slice(0, -remain) : content);
  const tail = remain ? `<details class="noema-code-tail"><summary>Show ${remain} more ${remain === 1 ? "line" : "lines"}</summary>${pre(content.slice(-remain))}</details>` : "";
  return `<figure class="noema-code noema-code-annotated"${numbers}>${caption}${main}${tail}</figure>\n`;
}
