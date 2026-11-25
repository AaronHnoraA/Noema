import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";

export const documentRepositoryKinds = new Set(["git-log", "git-diff"]);
export const REPOSITORY_CONTROL_SELECTOR = ".noema-document-repository button, .noema-repo-patch";

export function renderDocumentRepository(md: MarkdownIt, kind: string, body: string, attrs: AttrMap, interactive: boolean): string {
  const path = attrs.path?.trim() || "";
  const range = attrs.range?.trim() || "";
  const fallback = body.trim() ? md.render(body) : "";
  const escape = md.utils.escapeHtml;
  if (!interactive) return fallback || (path ? `<p class="noema-excerpt-reference"><code>${escape(path)}</code></p>` : "");
  const options = ["path", "vcs", "limit", "range"].filter((key) => attrs[key]?.trim())
    .map((key) => ` data-repo-${key}="${escape(attrs[key]!.trim())}"`).join("");
  return `<div class="noema-document-repository noema-source-excerpt" data-repo-kind="${kind}"${options}>`
    + `<div class="noema-excerpt-heading"><span class="noema-repo-label">Repository</span>${path ? `<code>${escape(path)}</code>` : ""}`
    + (range ? `<code class="noema-repo-range">${escape(range)}</code>` : "")
    + '<div class="noema-excerpt-actions"><button type="button" data-repo-refresh>Refresh</button>'
    + (kind === "git-diff" ? '<button type="button" data-repo-copy disabled>Copy patch</button>' : "") + '</div></div>'
    + '<div class="noema-excerpt-status" role="status">Loading repository…</div>'
    + `<div class="noema-excerpt-fallback">${fallback}</div><div class="noema-repo-output"></div></div>`;
}
