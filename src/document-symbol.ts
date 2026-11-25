import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";

export const SYMBOL_CONTROL_SELECTOR = ".noema-document-symbol button, .noema-symbol-output";

export function renderDocumentSymbol(md: MarkdownIt, body: string, attrs: AttrMap, interactive: boolean): string {
  const name = attrs.name?.trim();
  const fallback = body.trim() ? md.render(body) : "";
  if (!name) return fallback;
  const escapedName = md.utils.escapeHtml(name);
  if (!interactive) return `<p><code>${escapedName}</code></p>${fallback}`;
  return `<div class="noema-document-symbol noema-source-excerpt" data-emacs-symbol="${escapedName}" data-symbol-awaiting>`
    + `<div class="noema-excerpt-heading noema-symbol-heading"><code class="noema-symbol-name">${escapedName}</code>`
    + '<span class="noema-symbol-kind"></span>'
    + '<div class="noema-excerpt-actions"><button type="button" data-symbol-help>Help</button>'
    + '<button type="button" data-symbol-definition>Definition</button></div></div>'
    + '<div class="noema-excerpt-status" role="status">Looking up symbol…</div>'
    + `<div class="noema-symbol-output"></div><div class="noema-excerpt-fallback">${fallback}</div></div>`;
}
