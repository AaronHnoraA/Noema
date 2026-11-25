import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";

export const documentExcerptKinds = new Set(["include", "code-ref"]);
export const DOCUMENT_EXCERPT_CONTROL_SELECTOR = ".noema-source-excerpt button, .noema-excerpt-code";

export function documentExcerptHasPath(kind: string, title: string): boolean {
  return documentExcerptKinds.has(kind) && Boolean(splitDocumentWidgetTitle(kind, title).attrs.src?.trim());
}

export function renderDocumentExcerpt(md: MarkdownIt, body: string, attrs: AttrMap, interactive: boolean): string | null {
  const path = attrs.src?.trim();
  if (!path) return null;
  const escape = md.utils.escapeHtml;
  const fallback = body.trim() ? md.render(body) : "";
  if (!interactive) return fallback || `<p class="noema-excerpt-reference"><code>${escape(path)}</code></p>`;

  const data = ["src", "lines", "region", "section", "symbol", "context", "lang"]
    .filter((key) => attrs[key]?.trim()).map((key) => ` data-excerpt-${key}="${escape(attrs[key]!.trim())}"`).join("");
  return `<div class="noema-source-excerpt"${data}>`
    + `<div class="noema-excerpt-heading"><code class="noema-excerpt-path">${escape(path)}</code><span class="noema-excerpt-lines"></span>`
    + '<div class="noema-excerpt-actions"><button type="button" data-excerpt-refresh title="Refresh source">Refresh</button>'
    + '<button type="button" data-excerpt-copy disabled>Copy</button><button type="button" data-excerpt-open disabled>Open file</button></div></div>'
    + '<div class="noema-excerpt-status" role="status">Loading source…</div>'
    + `<div class="noema-excerpt-fallback">${fallback}</div><div class="noema-excerpt-output"></div></div>`;
}
