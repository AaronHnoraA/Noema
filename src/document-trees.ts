import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { documentPages, headingLabel } from "./document-tabs.ts";
import { documentViewSourceKey } from "./document-view.ts";
import { parseCodeInfo } from "./code-info.ts";

export const documentTreeKinds = new Set(["file-tree", "code-tree"]);

interface TreeNode {
  name: string;
  label: string;
  description?: string;
  literalName?: boolean;
  change?: "added" | "removed";
  children: TreeNode[];
  file?: number;
}

const enabled = (value: string | undefined): boolean => /^(?:true|yes|on|1)$/i.test(value ?? "");

function readFileList(md: MarkdownIt, tokens: Token[], first: number, environment: object): { nodes: TreeNode[]; next: number } | null {
  if (tokens[first]?.type !== "bullet_list_open") return null;
  const nodes: TreeNode[] = [];
  let index = first + 1;
  while (tokens[index]?.type === "list_item_open") {
    const inline = tokens[index + 2];
    if (tokens[index + 1]?.type !== "paragraph_open" || inline?.type !== "inline" || tokens[index + 3]?.type !== "paragraph_close") return null;
    const change = /^(\+\+|--)[ \t]+/.exec(inline.content);
    const entry = inline.content.slice(change?.[0].length ?? 0);
    const parts = /^([^\[\]`]+?)[ \t]+#[ \t]+(.+)$/.exec(entry);
    const authoredName = (parts?.[1] ?? entry).trim();
    const emphasis = /^\*\*([^*]+)\*\*$/.exec(authoredName);
    const fileName = emphasis?.[1] ?? authoredName;
    const content = change || parts || emphasis
      ? (md.parseInline(fileName, environment)[0]?.children ?? []) : (inline.children ?? []);
    // Markdown linkification recognizes some file suffixes as domain names.
    // Explicit Markdown links retain their authored destination.
    const external = /^(?:[A-Za-z][\w+.-]*:|\/\/|www\.)/i.test(fileName)
      || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fileName);
    const filenameLinkified = content.some((token) => token.markup === "linkify")
      && content.every((token) => token.type === "text" || token.markup === "linkify")
      && !external;
    const plain = filenameLinkified || (content.length === 1 && (content[0]?.type === "text" || content[0]?.type === "code_inline"));
    const title = (filenameLinkified ? fileName : headingLabel(md, { content: fileName, children: content }, environment)).trim();
    if (!title) return null;
    const rendered = filenameLinkified ? md.utils.escapeHtml(title) : md.renderer.renderInline(content, md.options, environment);
    const label = emphasis ? `<strong>${rendered}</strong>` : rendered;
    index += 4;
    const nested = readFileList(md, tokens, index, environment);
    if (nested) index = nested.next;
    if (tokens[index]?.type !== "list_item_close") return null;
    nodes.push({ name: title, label, description: parts?.[2]?.trim(), literalName: plain,
      change: change ? (change[1] === "++" ? "added" : "removed") : undefined, children: nested?.nodes ?? [] });
    index++;
  }
  return nodes.length && tokens[index]?.type === "bullet_list_close" ? { nodes, next: index + 1 } : null;
}

interface CodeFile { path: string; text: string; fence: Token }

export function documentCodeTree(md: MarkdownIt, body: string): { nodes: TreeNode[]; files: CodeFile[]; preamble: string } | null {
  const { environment, tokens, pages, first } = documentPages(md, "code-tree", body);
  if (!pages.length || pages.some((page) => page.content.length !== 1 || page.content[0]?.type !== "fence")) return null;
  const nodes: TreeNode[] = [];
  const files: CodeFile[] = [];
  const folders = new Map<string, TreeNode>();
  const paths = new Set<string>();
  for (const page of pages) {
    const path = page.label.trim().replace(/^\.\//, "");
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..") || paths.has(path)) return null;
    paths.add(path);
    const name = parts.pop()!;
    let children = nodes;
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      const key = parts.slice(0, index + 1).join("/");
      let directory = folders.get(key);
      if (!directory) {
        directory = { name, label: md.utils.escapeHtml(name), children: [] };
        folders.set(key, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({ name, label: md.utils.escapeHtml(name), children: [], file: files.length });
    files.push({ path, text: page.content[0]!.content, fence: page.content[0]! });
  }
  return { nodes, files, preamble: first ? md.renderer.render(tokens.slice(0, first), md.options, environment) : "" };
}

function renderTree(md: MarkdownIt, nodes: TreeNode[], attrs: AttrMap): string {
  const collapsible = enabled(attrs.collapsible);
  const clickable = enabled(attrs.clickable);
  const opened = attrs["open-depth"] === undefined ? Infinity : Number(attrs["open-depth"]);
  const escape = md.utils.escapeHtml;
  function list(items: TreeNode[], path: readonly string[], directoryPath: ReadonlyArray<readonly [string, number]>, inferPath: boolean): string {
    const occurrences = new Map<string, number>();
    const rows = items.map((node) => {
      const name = node.name.replace(/^\.\//, "").replace(/\/$/, "");
      const segments = name.split("/");
      const directory = node.children.length > 0 || (node.literalName && node.name.endsWith("/"));
      const local = inferPath && node.literalName === true && segments.every((segment) => segment && segment !== "." && segment !== ".." && !/[:\\]/.test(segment));
      const nextPath = [...path, ...segments];
      let label = node.label;
      if (node.file !== undefined) label = `<button type="button" data-tree-file="${node.file}">${label}</button>`;
      else if (!directory && local && clickable) label = `<a href="./${nextPath.map(encodeURIComponent).join("/")}">${label}</a>`;
      const description = node.description ? `<span class="noema-tree-description">${escape(node.description)}</span>` : "";
      const change = node.change ? ` data-tree-change="${node.change}"` : "";
      const sign = node.change ? `<span class="noema-tree-change" aria-label="${node.change}">${node.change === "added" ? "+" : "−"}</span>` : "";
      const row = `<span class="noema-tree-name" data-tree-type="${directory ? "directory" : "file"}"${change}>${sign}${label}</span>${description}`;
      if (!node.children.length) return `<li><div class="noema-tree-row">${row}</div></li>`;
      const occurrence = occurrences.get(node.name) ?? 0;
      occurrences.set(node.name, occurrence + 1);
      const branch = [...directoryPath, [node.name, occurrence] as const];
      const nested = list(node.children, nextPath, branch, local);
      return collapsible ? `<li><details data-tree-directory="${escape(JSON.stringify(branch))}"${directoryPath.length < opened ? " open" : ""}><summary>${row}</summary>${nested}</details></li>`
        : `<li><div class="noema-tree-row">${row}</div>${nested}</li>`;
    }).join("");
    return `<ul class="noema-tree-list" role="list">${rows}</ul>`;
  }
  return list(nodes, [], [], true);
}

export function renderDocumentTree(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, interactive: boolean): string | null {
  const identity = interactive ? ` data-view-kind="${kind}" data-view-source="${documentViewSourceKey(kind, title, body)}"` : "";
  const lines = /^(?:false|off|no|0)$/i.test(attrs.lines || "") ? "false" : "true";
  const icon = ["simple", "colored"].includes(attrs.icon || "") ? attrs.icon : "none";
  const appearance = ` data-tree-lines="${lines}" data-tree-icon="${icon}"`;
  if (kind === "file-tree") {
    const environment = {};
    const tokens = md.parse(body, environment);
    const list = readFileList(md, tokens, 0, environment);
    if (!list || list.next !== tokens.length) return null;
    return `<div class="noema-document-tree"${appearance}${identity}>${renderTree(md, list.nodes, attrs)}</div>`;
  }

  const source = documentCodeTree(md, body);
  if (!source) return null;
  const escape = md.utils.escapeHtml;
  if (!interactive) return `<div class="noema-document-code-tree-static">${source.preamble}`
    + source.files.map(({ path, text }) => `<section><div class="noema-code-tree-path">${escape(path)}</div><pre><code>${escape(text)}</code></pre></section>`).join("") + "</div>";
  const requested = Number(attrs.height);
  const height = Number.isInteger(requested) && requested >= 3 && requested <= 80 ? requested : 18;
  const payloads = source.files.map((file, index) => {
    const language = parseCodeInfo(file.fence.info).lang;
    return `<template data-tree-snippet="${index}" data-path="${escape(file.path)}" data-language="${escape(language)}">${escape(file.text)}</template>`;
  }).join("");
  return source.preamble + `<div class="noema-document-tree noema-document-code-tree"${appearance}${identity} style="--code-tree-height:${height}">`
    + `<div class="noema-code-tree-files">${renderTree(md, source.nodes, { ...attrs, collapsible: "true" })}</div>`
    + '<div class="noema-code-tree-preview"><div class="noema-code-tree-head"><span class="noema-code-tree-path"></span>'
    + '<button type="button" data-tree-copy>Copy</button></div><pre tabindex="0" aria-label="Code preview"><code></code></pre></div>' + payloads + "</div>";
}
