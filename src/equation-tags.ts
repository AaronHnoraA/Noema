import type { EditorState } from "@codemirror/state";

export type EquationTagHit = {
  tag: string;
  from: number;
  to: number;
  blockPos: number;
};

function latexTagHitsInText(tex: string, base: number, blockPos: number): EquationTagHit[] {
  const hits: EquationTagHit[] = [];
  const pattern = /\\tag\s*\{\s*([^{}\n]+?)\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tex))) {
    const raw = match[1] ?? "";
    const tag = raw.trim();
    if (!tag) continue;
    const matched = match[0] ?? "";
    const groupStartInMatch = matched.indexOf(raw);
    if (groupStartInMatch < 0) continue;
    const leading = raw.length - raw.trimStart().length;
    const from = base + match.index + groupStartInMatch + leading;
    hits.push({ tag, from, to: from + tag.length, blockPos });
  }
  return hits;
}

function collectDisplayMathTags(markdown: string): EquationTagHit[] {
  const hits: EquationTagHit[] = [];
  let offset = 0;
  let blockStart: number | null = null;
  let bodyStart = 0;
  let body = "";

  const lines = markdown.match(/[^\n]*(?:\n|$)/g) ?? [];
  for (const line of lines) {
    if (!line) continue;
    const lineStart = offset;
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    const isOpen = /^[ \t]*\\\[[ \t]*$/.test(text);
    const isClose = /^[ \t]*\\\][ \t]*$/.test(text);
    if (blockStart == null && isOpen) {
      blockStart = lineStart;
      bodyStart = lineStart + line.length;
      body = "";
    } else if (blockStart != null && isClose) {
      hits.push(...latexTagHitsInText(body.replace(/\n$/, ""), bodyStart, blockStart));
      blockStart = null;
      body = "";
    } else if (blockStart != null) {
      body += line;
    }
    offset += line.length;
  }

  return hits;
}

export function getEquationTagHits(state: EditorState): EquationTagHit[] {
  return collectDisplayMathTags(state.doc.toString());
}

export function equationTagsFromText(tex: string): string[] {
  return latexTagHitsInText(tex, 0, 0).map((hit) => hit.tag);
}
