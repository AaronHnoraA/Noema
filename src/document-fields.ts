import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import { layoutFromAttrs, type AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";
import { safeHref } from "./url-safety.ts";

export const documentFieldKinds = new Set(["field", "form"]);

export function documentFieldDelimiter(state: StateCore): void {
  const separator = (state.env as { fieldSeparator?: string }).fieldSeparator;
  if (separator === undefined) return;
  for (const inline of state.tokens) {
    const children = inline.children;
    if (!children) continue;
    for (let index = 0; index < children.length; index++) {
      const token = children[index]!;
      // Escapes and entities become text after this rule. Their colons belong
      // to the name or value, like colons inside a link or inline code.
      if (token.type !== "text" || token.level !== 0) continue;
      const delimiter = separator || token.content.match(/[:：]/)?.[0];
      if (!delimiter) continue;
      const at = token.content.indexOf(delimiter);
      if (at < 0) continue;
      const tail = new state.Token("text", "", 0);
      tail.content = token.content.slice(at + delimiter.length).trimStart();
      token.content = token.content.slice(0, at).trimEnd();
      children.splice(index + 1, 0, new state.Token("noema_field_delimiter", "", 0), tail);
      break;
    }
  }
}

export function documentFieldHasDetails(kind: string, title: string): boolean {
  return kind === "field" && Boolean(splitDocumentWidgetTitle(kind, title).attrs.name?.trim());
}

function renderType(md: MarkdownIt, label: string, href: string | undefined): string {
  if (!href || !safeHref(href)) return md.utils.escapeHtml(label);
  const open = new Token("link_open", "a", 1);
  open.attrSet("href", md.normalizeLink(href));
  const text = new Token("text", "", 0);
  text.content = label;
  return md.renderer.renderInline([open, text, new Token("link_close", "a", -1)], md.options, {});
}

function parameterField(md: MarkdownIt, body: string, attrs: AttrMap, width: string | undefined): string {
  const escape = md.utils.escapeHtml;
  const entry = (name: string, value: string) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
  const type = attrs.type ? entry("Type", renderType(md, attrs.type, attrs["type-link"])) : "";
  const fallback = attrs.default !== undefined ? entry("Default", `<code class="noema-field-default">${escape(attrs.default || '""')}</code>`) : "";
  const since = attrs.since ? entry("Since", escape(attrs.since)) : "";
  const signature = type + fallback + since;
  const values = [
    ["Options", attrs.enum], ["Unit", attrs.unit], ["Format", attrs.format], ["Constraint", attrs.constraint],
  ].filter(([, value]) => value).map(([label, value]) => entry(label!, escape(value!))).join("");
  const marked = (kind: string, label: string, description?: string) => `<span data-field-state="${kind}">`
    + `<span class="noema-field-state-label">${label}</span>`
    + (description ? ` <span class="noema-field-state-description">${escape(description)}</span>` : "") + "</span>";
  const required = /^(?:true|yes|1|required)$/i.test(attrs.required || "") ? marked("required", "Required") : "";
  const state = (kind: string, label: string) => attrs[kind] && !/^false$/i.test(attrs[kind])
    ? marked(kind, label, /^true$/i.test(attrs[kind]) ? undefined : attrs[kind]) : "";
  return `<section class="noema-parameter-field"${width ? ` style="--document-fields-width:${width}"` : ""}>`
    + `<div class="noema-field-header"><code class="noema-field-name">${escape(attrs.name!)}</code>`
    + required + state("deprecated", "Deprecated") + state("experimental", "Experimental") + "</div>"
    + (signature ? `<dl class="noema-field-signature">${signature}</dl>` : "")
    + (body.trim() ? `<div class="noema-field-body">${md.render(body)}</div>` : "")
    + (values ? `<dl class="noema-field-values">${values}</dl>` : "") + "</section>";
}

function fieldList(md: MarkdownIt, body: string, attrs: AttrMap): Array<readonly [string, string]> | null {
  const environment = { fieldSeparator: attrs.separator || "" };
  const tokens = md.parse(body, environment);
  if (tokens[0]?.type !== "bullet_list_open" || tokens.at(-1)?.type !== "bullet_list_close") return null;
  const rows: Array<readonly [string, string]> = [];
  for (let index = 1; index < tokens.length - 1; index += 5) {
    const item = tokens[index + 2];
    if (tokens[index]?.type !== "list_item_open" || tokens[index + 1]?.type !== "paragraph_open" || item?.type !== "inline"
      || tokens[index + 3]?.type !== "paragraph_close" || tokens[index + 4]?.type !== "list_item_close") return null;
    const children = item.children ?? [];
    const split = children.findIndex((token) => token.type === "noema_field_delimiter");
    if (split < 0) return null;
    const render = (tokens: Token[]) => md.renderer.renderInline(tokens, md.options, environment).trim();
    const term = render(children.slice(0, split));
    const value = render(children.slice(split + 1));
    if (!term || !value) return null;
    rows.push([term, value]);
  }
  return rows.length ? rows : null;
}

export function renderDocumentFields(md: MarkdownIt, kind: string, body: string, attrs: AttrMap): string | null {
  const width = layoutFromAttrs({ width: attrs.width }).width;
  if (kind === "field" && attrs.name?.trim()) return parameterField(md, body, attrs, width);
  const rows = fieldList(md, body, attrs);
  if (!rows) return null;
  const label = layoutFromAttrs({ width: attrs["label-width"] }).width;
  const dimensions = [width && `--document-fields-width:${width}`, label && `--document-fields-label:${label}`].filter(Boolean).join(";");
  return `<dl class="noema-document-fields" data-field-layout="${kind}"${dimensions ? ` style="${dimensions}"` : ""}>`
    + rows.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join("") + "</dl>";
}
