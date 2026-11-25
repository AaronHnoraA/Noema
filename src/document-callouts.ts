import type MarkdownIt from "markdown-it";
import { layoutFromAttrs, type AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";
import { documentViewSourceKey } from "./document-view.ts";
export { parseQuotedCallout } from "../shared/callout-syntax.mjs";

export const nativeCalloutKinds = new Set(["note", "tip", "important", "warning", "caution", "info", "danger"]);
const affirmative = (value?: string) => /^(?:true|yes|on|1)$/i.test(value || "");
const negative = (value?: string) => /^(?:false|no|off|0)$/i.test(value || "");

const surfaces = new Set(["quote", "quiet", "raised", "none"]);

export function nativeCalloutOpening(kind: string, title: string): boolean | null {
  if (!nativeCalloutKinds.has(kind)) return null;
  const { attrs } = splitDocumentWidgetTitle(kind, title);
  return affirmative(attrs.collapsible) ? !negative(attrs.open) : null;
}

export function hasNativeCalloutLayout(kind: string, title: string): boolean {
  if (!nativeCalloutKinds.has(kind)) return false;
  const { attrs } = splitDocumentWidgetTitle(kind, title);
  return affirmative(attrs.collapsible) || surfaces.has(attrs.background || "")
    || Boolean(layoutFromAttrs({ width: attrs["border-left-width"] || "" }).width);
}

export function renderNativeCallout(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, interactive: boolean): string | null {
  const fold = affirmative(attrs.collapsible);
  const background = surfaces.has(attrs.background || "") ? attrs.background : "";
  const rail = layoutFromAttrs({ width: attrs["border-left-width"] || "" }).width;
  if (!fold && !background && !rail) return null;
  const content = md.render(body);
  const appearance = (background ? ` data-background="${background}"` : "")
    + (rail ? ` style="--native-callout-rail:${rail}"` : "");
  if (!fold) return `<div class="noema-native-callout-body" data-callout="${kind}"${appearance}>${content}</div>`;

  const source = interactive
    ? ` data-view-kind="${kind}" data-view-source="${documentViewSourceKey(kind, title, body)}"` : "";
  return `<details class="noema-document-disclosure noema-native-callout-body" data-callout="${kind}"${appearance}${source}${negative(attrs.open) ? "" : " open"}>`
    + '<summary><span class="noema-native-callout-toggle-label">Contents</span></summary>'
    + (interactive ? `<div class="noema-disclosure-body"></div><template data-view-content>${content}</template>` : `<div class="noema-disclosure-body">${content}</div>`)
    + "</details>";
}
