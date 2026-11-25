import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { documentViewSourceKey } from "./document-view.ts";
import { documentDataAccents } from "./document-data-table.ts";

export const documentTabKinds = new Set(["tabs", "code-tabs", "tab-panel", "swiper"]);

interface Page {
  label: string;
  heading?: string;
  content: Token[];
  line: number;
}

export function headingLabel(md: MarkdownIt, token: Pick<Token, "content" | "children">, environment: object): string {
  const children = (token.children ?? []).map((child) => {
    if (child.type !== "code_inline" && child.type !== "math_inline") return child;
    const text = new Token("text", "", 0);
    text.content = child.content;
    return text;
  });
  return md.renderer.renderInlineAsText(children, md.options, environment).trim() || token.content.trim();
}

export function documentPages(md: MarkdownIt, kind: string, body: string) {
  const environment = {};
  const tokens = md.parse(body, environment);
  const headings = tokens.flatMap((token, index) => token.type === "heading_open" && token.level === 0 ? [index] : []);
  const first = headings[0];
  const sameLevel = first === undefined ? [] : headings.filter((index) => tokens[index]!.tag === tokens[first]!.tag);
  const pages: Page[] = sameLevel.map((index, page) => {
    const content = tokens.slice(index + 3, sameLevel[page + 1]);
    return {
      label: headingLabel(md, tokens[index + 1]!, environment) || `Page ${page + 1}`,
      heading: tokens[index + 1]!.content,
      content,
      line: content[0]?.map?.[0] ?? tokens[index]!.map![0],
    };
  });
  if (!pages.length && kind === "code-tabs" && tokens.length > 1 && tokens.every((token) => token.type === "fence")) {
    pages.push(...tokens.map((token, index) => ({
      label: token.info.trim().split(/\s+/, 1)[0] || `Code ${index + 1}`,
      content: [token],
      line: token.map![0],
    })));
  }
  return { environment, tokens, pages, first };
}

export function documentPageOffsets(md: MarkdownIt, kind: string, body: string, pages: readonly Page[], source?: string): number[] {
  const original = source?.replace(/\n$/u, "");
  if (original === undefined) return [];
  const sourcePages = original === body ? pages : documentPages(md, kind, original).pages;
  if (sourcePages.length !== pages.length) return [];
  const starts = [0];
  for (let offset = original.indexOf("\n"); offset >= 0; offset = original.indexOf("\n", offset + 1)) starts.push(offset + 1);
  return sourcePages.map((page) => starts[page.line]!);
}

export function renderDocumentTabs(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, interactive: boolean, source?: string): string | null {
  const { environment, tokens, pages, first } = documentPages(md, kind, body);
  if (pages.length < 2) return null;
  if (!interactive) return `<div class="noema-document-tabs-static">${md.renderer.render(tokens, md.options, environment)}</div>`;
  const offsets = documentPageOffsets(md, kind, body, pages, source);
  const preamble = first ? md.renderer.render(tokens.slice(0, first), md.options, environment) : "";
  return renderDocumentTabGroup(md, kind, title, body, attrs, pages.map(({ label, content, line }, index) => ({
    label,
    html: md.renderer.render(content, md.options, environment),
    offset: offsets[index],
    line,
  })), preamble);
}

interface RenderedDocumentTab {
  label: string;
  html: string;
  offset?: number;
  line?: number;
}

export function renderDocumentTabGroup(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, pages: readonly RenderedDocumentTab[], preamble = ""): string {
  const requested = Number(attrs.selected);
  const selected = Number.isInteger(requested) && requested > 0 && requested <= pages.length ? requested - 1 : 0;
  const accent = documentDataAccents.has(attrs.accent || "") ? attrs.accent : "neutral";
  const controls = pages.map(({ label }, index) => {
    const text = md.utils.escapeHtml(label);
    const key = kind === "npm-to" ? ` data-tab-key="${text}"` : "";
    return `<button type="button" class="noema-tab-button" data-tab-index="${index}"${key} title="${text}">${text}</button>`;
  }).join("");
  const previous = kind === "swiper" ? '<button type="button" class="noema-tab-move" data-move="-1">‹</button>' : "";
  const next = kind === "swiper" ? '<button type="button" class="noema-tab-move" data-move="1">›</button>' : "";
  const templates = pages.map(({ html, offset, line }, index) => {
    return `<template data-view-content="${index}"${offset !== undefined ? ` data-tab-offset="${offset}"` : ""}${line !== undefined ? ` data-tab-line="${line}"` : ""}>`
      + `${html}</template>`;
  }).join("");
  return `<div class="noema-document-tabs" data-tab-kind="${kind}" data-view-kind="${kind}" data-view-source="${documentViewSourceKey(kind, title, body)}" data-tab-selected="${selected}" data-accent="${accent}">`
    + preamble
    + `<div class="noema-tab-navigation">${previous}<div class="noema-tab-strip" role="tablist">${controls}</div>${next}</div>`
    + `<div class="noema-tab-body"></div>${templates}</div>`;
}
