import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { documentViewSourceKey } from "./document-view.ts";

export const RUN_CONTROL_SELECTOR = ".noema-document-run button, .noema-run-output, .noema-run-command";
const shellLanguages = new Set(["sh", "shell", "bash", "zsh"]);

export function renderDocumentRun(md: MarkdownIt, title: string, body: string, attrs: AttrMap, interactive: boolean): string {
  const explicit = attrs.cmd?.trim() || "";
  const cwd = attrs.cwd?.trim() || "";
  const escape = md.utils.escapeHtml;
  const commandBlock = (command: string) => `<pre class="noema-run-command"><code>${escape(command)}</code></pre>`;
  const workingDirectory = cwd ? `<span class="noema-run-directory">Directory <code>${escape(cwd)}</code></span>` : "";
  if (!interactive) return (explicit ? commandBlock(explicit) : "") + workingDirectory + md.render(body);
  const env = {};
  const tokens = md.parse(body, env);
  const fences = explicit ? [] : tokens.filter((token) => token.type === "fence" && token.level === 0
    && shellLanguages.has(token.info.trim().split(/\s+/u, 1)[0]!.toLowerCase()));
  const fence = fences.length === 1 ? fences[0] : undefined;
  const command = explicit || fence?.content.replace(/\n$/, "") || "";
  const render = (content: typeof tokens) => md.renderer.render(content, md.options, env);
  if (!command.trim()) return render(tokens);
  const renderedCommand = commandBlock(command);
  const tokenIndex = fence ? tokens.indexOf(fence) : -1;
  const content = tokenIndex < 0 ? renderedCommand + render(tokens)
    : render(tokens.slice(0, tokenIndex)) + renderedCommand + render(tokens.slice(tokenIndex + 1));
  const identity = documentViewSourceKey("run", title, body);
  return `<div class="noema-document-run noema-source-excerpt" data-run-command="${escape(command)}" data-run-cwd="${escape(cwd || ".")}"`
    + ` data-view-kind="run" data-view-source="${identity}">`
    + `<div class="noema-run-source">${workingDirectory}${content}</div>`
    + '<div class="noema-excerpt-heading"><span class="noema-run-status" role="status"></span><div class="noema-excerpt-actions">'
    + '<button type="button" data-run-start>Run…</button><button type="button" data-run-stop data-run-inactive>Stop</button>'
    + '<button type="button" data-run-open data-run-inactive>Open output</button></div></div>'
    + '<pre class="noema-run-output noema-excerpt-code" tabindex="0" aria-label="Command output" data-run-inactive><code></code></pre></div>';
}
