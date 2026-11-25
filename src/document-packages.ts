import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";
import { parseCodeInfo } from "./code-info.ts";
import { renderDocumentTabGroup } from "./document-tabs.ts";
import { packageManagerScripts, packageManagers, type PackageManager } from "./package-commands.ts";

export const documentPackageKinds = new Set(["npm-badge", "npm-to"]);
export const PACKAGE_CODE_SELECTOR = ".noema-package-panel pre";

export function documentBadgeHasName(kind: string, title: string): boolean {
  return kind === "npm-badge" && Boolean(splitDocumentWidgetTitle(kind, title).attrs.name?.trim());
}

export function packageCommandFence(md: MarkdownIt, body: string) {
  const tokens = md.parse(body, {});
  const fence = tokens[0];
  if (tokens.length !== 1 || fence?.type !== "fence") return null;
  const language = parseCodeInfo(fence.info).lang.toLowerCase() || "sh";
  return ["sh", "bash", "shell", "zsh", "shellscript"].includes(language) ? fence : null;
}

export function renderDocumentPackage(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, interactive: boolean): string | null {
  const escape = md.utils.escapeHtml;
  if (kind === "npm-badge") {
    if (!attrs.name?.trim()) return null;
    const version = attrs.version?.trim();
    const release = version ? `<span class="noema-package-version">${escape(/^v/i.test(version) ? version : "v" + version)}</span>` : "";
    const downloads = attrs.downloads ? `<span class="noema-package-downloads"><span aria-hidden="true">↓ </span>${escape(attrs.downloads)}</span>` : "";
    return `<div class="noema-package-badge"><span class="noema-package-name">${escape(attrs.name)}</span>${release}${downloads}</div>`
      + (body.trim() ? md.render(body) : "");
  }

  const fence = packageCommandFence(md, body);
  if (!fence) return null;
  const requested = (attrs.tabs || "").toLowerCase().split(/[ ,]+/).filter((name): name is PackageManager => packageManagers.some((manager) => manager === name));
  const managers = requested.length ? [...new Set(requested)] : packageManagers;
  const commands = packageManagerScripts(fence.content, managers);
  const pages = managers.map((manager, index) => {
    const command = commands[index]!;
    const code = `<pre><code>${escape(command)}</code></pre>`;
    const original = manager !== "npm" && command === fence.content ? '<span class="noema-package-original">Original command</span>' : "";
    const footer = interactive ? '<div class="noema-package-actions">' + original + '<button type="button" data-copy-package-command>Copy command</button></div>' : "";
    return { label: manager, html: `<div class="noema-package-panel" data-manager="${manager}">${code}${footer}</div>` };
  });
  if (!interactive) return '<div class="noema-package-script">' + pages.map(({ label, html }) =>
    `<section><div class="noema-package-manager">${escape(label)}</div>${html}</section>`).join("") + "</div>";
  const panels = pages.length > 1 ? renderDocumentTabGroup(md, kind, title, body, attrs, pages) : pages[0]!.html;
  return `<div class="noema-package-script">${panels}</div>`;
}
