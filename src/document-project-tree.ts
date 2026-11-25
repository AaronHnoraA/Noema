import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { documentViewSourceKey } from "./document-view.ts";

export const PROJECT_TREE_CONTROL_SELECTOR = ".noema-project-tree button, .noema-project-tree summary";

export function renderDocumentProjectTree(md: MarkdownIt, title: string, body: string, attrs: AttrMap, interactive: boolean): string {
  const path = attrs.path?.trim() || "/";
  const fallback = body.trim() ? md.render(body) : "";
  const escape = md.utils.escapeHtml;
  if (!interactive) return fallback || `<p class="noema-excerpt-reference"><code>${escape(path)}</code></p>`;
  const lines = /^(?:false|off|no|0)$/i.test(attrs.lines || "") ? "false" : "true";
  const icon = ["none", "simple", "colored"].includes(attrs.icon || "") ? attrs.icon : "simple";
  const settings = ["depth", "ignore", "open-depth"].filter((key) => attrs[key])
    .map((key) => ` data-project-${key}="${escape(attrs[key]!)}"`).join("");
  const identity = documentViewSourceKey("project-tree", title, body);
  return `<div class="noema-project-tree noema-source-excerpt" data-project-path="${escape(path)}"${settings}`
    + ` data-view-kind="project-tree" data-view-source="${identity}">`
    + `<div class="noema-excerpt-heading"><code class="noema-project-tree-path">${escape(path)}</code>`
    + '<div class="noema-excerpt-actions"><button type="button" data-project-refresh>Refresh</button></div></div>'
    + '<div class="noema-excerpt-status" role="status">Loading project tree…</div>'
    + `<div class="noema-excerpt-fallback">${fallback}</div>`
    + `<div class="noema-document-tree noema-project-tree-output" data-tree-lines="${lines}" data-tree-icon="${icon}"></div></div>`;
}
