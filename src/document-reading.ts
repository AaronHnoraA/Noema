import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";
import { splitColumnPanes } from "./columns-layout.ts";

export const documentReadingKinds = new Set(["log", "keymap", "statusbar", "breadcrumb", "pros-cons"]);

export function documentStatusHasDetails(kind: string, rawTitle: string): boolean {
  if (kind !== "statusbar") return false;
  const { attrs } = splitDocumentWidgetTitle(kind, rawTitle);
  return Boolean(attrs.mode || attrs.keys || attrs.note);
}

const flatListTokens = new Set(["list_item_open", "list_item_close", "paragraph_open", "paragraph_close", "inline"]);

function flatList(md: MarkdownIt, body: string) {
  const environment = {};
  const tokens = md.parse(body, environment);
  if (tokens[0]?.type !== "bullet_list_open") return null;
  const items: Token[] = [];
  let item: Token | null = null;
  for (const token of tokens.slice(1, -1)) {
    if (!flatListTokens.has(token.type) || token.level === 0) return null;
    if (token.type === "inline") {
      if (item) return null;
      item = token;
    }
    if (token.type === "list_item_close") {
      if (!item) return null;
      items.push(item);
      item = null;
    }
  }
  if (!items.length) return null;
  return { items, environment };
}

const severity = new Map([
  ["trace", "quiet"], ["debug", "quiet"], ["info", "info"], ["notice", "info"],
  ["warn", "warning"], ["warning", "warning"], ["error", "danger"], ["fatal", "danger"],
  ["ok", "success"], ["success", "success"],
]);

function logView(md: MarkdownIt, items: Token[], environment: object): string {
  const rows = items.map((item) => {
    const parts = /^(?:((?:\d{4}-\d{2}-\d{2}[ T])?\d{2}:\d{2}(?::\d{2})?)[ \t]+)?(\[[A-Za-z]+\]|[A-Za-z]+)[ \t]+([\s\S]+)$/.exec(item.content);
    const level = parts?.[2]?.replace(/^\[|\]$/g, "");
    const role = level && severity.get(level.toLowerCase());
    if (!parts || !role) {
      return `<li class="noema-log-plain">${md.renderer.renderInline(item.children ?? [], md.options, environment)}</li>`;
    }
    const time = parts[1] ? md.utils.escapeHtml(parts[1]) : "";
    return `<li>${time ? `<time>${time}</time> ` : ""}<span class="noema-log-level" data-log-level="${role}">${level}</span> `
      + `<span class="noema-log-message">${md.renderInline(parts[3]!, environment)}</span></li>`;
  });
  return `<ul class="noema-document-log" role="list">${rows.join("")}</ul>`;
}

function shortcutSeparators(source: string, candidates: string): number[] {
  const positions: number[] = [];
  let code = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (!code && character === "\\") {
      index++;
    } else if (character === "`") {
      let length = 1;
      while (source[index + length] === "`") length++;
      if (!code) code = length;
      else if (code === length) code = 0;
      index += length - 1;
    } else if (!code && source[index - 1] !== "-" && candidates.includes(character)) {
      positions.push(index);
    }
  }
  return positions;
}

function shortcutPair(source: string): [string, string] {
  for (const separator of shortcutSeparators(source, ":：")) {
    const key = source.slice(0, separator).trim();
    const label = source.slice(separator + 1).trim();
    if (key && label) return [key, label];
  }
  return [source.trim(), ""];
}

function configuredShortcuts(source = ""): [string, string][] {
  let start = 0;
  const pairs = [];
  for (const end of [...shortcutSeparators(source, ",，"), source.length]) {
    pairs.push(shortcutPair(source.slice(start, end)));
    start = end + 1;
  }
  return pairs;
}

function keycaps(md: MarkdownIt, chord: string): string {
  const groups = chord.replace(/^(`+)([\s\S]*)\1$/, "$2").replace(/\\([,:，：])/g, "$1").split(/\s+\/\s+/);
  return groups.map((group) => group.split(/\s+/).filter(Boolean)
    .map((key) => `<kbd>${md.utils.escapeHtml(key)}</kbd>`).join(" "))
    .join(' <span class="noema-keymap-separator">/</span> ');
}

function statusbarView(md: MarkdownIt, keys: [string, string][], attrs: AttrMap, environment: object): string {
  const mode = attrs.mode ? `<span class="noema-statusbar-mode">${md.utils.escapeHtml(attrs.mode)}</span>` : "";
  const note = attrs.note ? `<span class="noema-statusbar-note">${md.renderInline(attrs.note, environment)}</span>` : "";
  const shortcuts = keys.filter(([key]) => key).map(([key, label]) =>
    `<span class="noema-statusbar-key">${keycaps(md, key)}${label ? ` ${md.renderInline(label, environment)}` : ""}</span>`);
  return mode || note || shortcuts.length
    ? `<div class="noema-document-statusbar">${mode}${shortcuts.length ? ` <span class="noema-statusbar-keys">${shortcuts.join(" ")}</span>` : ""} ${note}</div>` : "";
}

export function renderDocumentReading(md: MarkdownIt, kind: string, body: string, attrs: AttrMap): string | null {
  if (kind === "pros-cons") {
    const panes = splitColumnPanes(body, { allowIndentedMarkers: false });
    if (panes.length !== 2 || panes.some((pane) => !pane.body.trim())) return null;
    const environment: { references?: Record<string, unknown> } = {};
    if (/^ {0,3}\[[^\]\n]+\]:/m.test(body)) md.block.parse(body, md, environment, []);
    return `<div class="noema-document-comparison">${["pros", "cons"].map((role, index) => {
      const label = attrs[role] || (role === "pros" ? "Pros" : "Cons");
      return `<section data-comparison="${role}"><div class="noema-comparison-heading">${md.renderInline(label)}</div>`
        + `<div class="noema-comparison-body">${md.render(panes[index]!.body, { references: environment.references })}</div></section>`;
    }).join("")}</div>`;
  }
  const list = body.trim() ? flatList(md, body) : null;
  if (kind === "statusbar") {
    const keys = [...configuredShortcuts(attrs.keys), ...(list?.items.map((item) => shortcutPair(item.content)) ?? [])];
    return statusbarView(md, keys, attrs, list?.environment ?? {}) + (!list && body.trim() ? md.render(body) : "");
  }
  if (!list) return null;
  const { items, environment } = list;
  if (kind === "log") return logView(md, items, environment);
  if (kind === "breadcrumb") {
    const separator = md.utils.escapeHtml(attrs.separator || "›");
    const crumbs = items.map((item, index) => `<li${index === items.length - 1 ? ' aria-current="page"' : ""}>`
      + (index ? `<span class="noema-breadcrumb-separator" aria-hidden="true">${separator}</span>` : "")
      + md.renderer.renderInline(item.children ?? [], md.options, environment) + "</li>");
    return `<nav class="noema-document-breadcrumb" aria-label="Breadcrumb"><ol role="list">${crumbs.join("")}</ol></nav>`;
  }
  const keys = items.map((item) => shortcutPair(item.content));
  const columns = ["1", "2", "3"].includes(attrs.columns || "") ? attrs.columns : "2";
  return `<div class="noema-document-keymap-layout"><dl class="noema-document-keymap" data-keymap-columns="${columns}">`
    + keys.map(([key, description]) => `<div><dt>${keycaps(md, key)}</dt><dd>${md.renderInline(description, environment)}</dd></div>`).join("")
    + "</dl></div>";
}
