import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MAX_HTML_TO_MARKDOWN_CHARS = 900_000;

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
  hr: "---",
});

turndown.use(gfm);

turndown.addRule("strikethrough", {
  filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
  replacement: (content) => content ? `~~${content}~~` : "",
});

turndown.addRule("mark", {
  filter: ["mark"],
  replacement: (content) => content ? `==${content}==` : "",
});

turndown.addRule("subscript", {
  filter: ["sub"],
  replacement: (content) => content ? `~${content}~` : "",
});

turndown.addRule("superscript", {
  filter: ["sup"],
  replacement: (content) => content ? `^${content}^` : "",
});

turndown.addRule("aaronnoteInlineMath", {
  filter: (node) => node instanceof HTMLElement
    && node.classList.contains("aaronnote-math-inline")
    && Boolean(node.getAttribute("data-tex")),
  replacement: (_content, node) => {
    const tex = node instanceof HTMLElement ? node.getAttribute("data-tex") || "" : "";
    return tex ? `\\(${tex}\\)` : "";
  },
});

turndown.addRule("aaronnoteDisplayMath", {
  filter: (node) => node instanceof HTMLElement
    && node.tagName === "MATH-BLOCK"
    && (node.hasAttribute("data-aaronnote-math-block") || node.classList.contains("math-block-rendered")),
  replacement: (_content, node) => {
    if (!(node instanceof HTMLElement)) return "";
    const render = node.querySelector<HTMLElement>(".math-block-render");
    const tex = node.getAttribute("data-tex") || render?.getAttribute("data-tex") || "";
    return tex ? `\n\n\\[\n${tex.trim()}\n\\]\n\n` : "";
  },
});

function normalizeMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextFromHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return normalizeMarkdown(template.content.textContent ?? "");
}

export function htmlToMarkdown(html: string): string {
  const raw = String(html || "");
  if (raw.length > MAX_HTML_TO_MARKDOWN_CHARS) return plainTextFromHtml(raw);
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|zotero|roam):|[^:]*?(?:[/?#]|$))/i,
    ADD_TAGS: ["math-block"],
    ADD_ATTR: ["data-aaronnote-math-block", "data-display", "data-delimiter", "data-math-render-key", "data-tex"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
  });
  return normalizeMarkdown(turndown.turndown(clean));
}
