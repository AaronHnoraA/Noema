import type { InlineCommand } from "./command-syntax.ts";
import { safeHref } from "./url-safety.ts";

type InlineReading = {
  kind: string;
  label: string;
  body?: string;
  tone?: string;
  color?: string;
  href?: string;
  closeLabel?: string;
};

export const inlineReadingNames = new Set(["spoiler", "gloss", "annotation", "symbol", "kbd", "badge", "color", "hidden"]);
const tones = new Set(["neutral", "note", "info", "tip", "important", "warning", "danger"]);
const literalColor = /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i;

export function readInlineReading(command: InlineCommand): InlineReading | null {
  const { name, context, args, argsError } = command;
  if (!inlineReadingNames.has(name) || context.includes("\n")) return null;
  if (name === "hidden") return { kind: name, label: "" };
  if (argsError) return null;
  const text = context.trim();
  if (!text) return null;
  const label = text.replace(/\\([\[\]\\])/g, "$1");
  const detail = args.text?.trim();
  switch (name) {
    case "spoiler": return { kind: name, label: args.label?.trim() || "Reveal", closeLabel: args.hide?.trim() || "Hide", body: text };
    case "gloss":
    case "annotation": return detail ? { kind: name, label, body: detail } : null;
    case "symbol": {
      const href = args.href?.trim();
      return { kind: name, label, body: detail, href: href && safeHref(href) ? href : undefined };
    }
    case "badge": return { kind: name, label, tone: tones.has(args.tone) ? args.tone : "neutral" };
    case "color": {
      const color = label.toLowerCase();
      if (!literalColor.test(color) && !tones.has(color)) return null;
      return { kind: name, label: args.label?.trim() || label, color };
    }
    default: return { kind: name, label };
  }
}

export function renderInlineReading(view: InlineReading, render: (markdown: string) => string, escape: (text: string) => string, expand = false): string {
  const { kind, label, body, tone, color, href, closeLabel } = view;
  const value = escape(label);
  if (kind === "hidden") return "";
  if (kind === "kbd") return `<kbd class="noema-inline-key">${value}</kbd>`;
  if (kind === "badge") return `<span class="noema-inline-badge" data-tone="${tone}">${value}</span>`;
  if (kind === "color" && color) {
    const paint = literalColor.test(color) ? `style="--inline-swatch:${color}"` : `data-tone="${color}"`;
    return `<span class="noema-inline-color" ${paint} title="${escape(color)}"><span class="noema-inline-swatch" aria-hidden="true"></span>${value}</span>`;
  }
  const labelHtml = kind === "symbol" ? `<code>${value}</code>` : value;
  const link = href ? `<a class="noema-inline-symbol-reference" href="${escape(href)}">${labelHtml}</a>` : labelHtml;
  const start = `<span class="noema-inline-reading noema-inline-${kind}">`;
  if (!body) return `${start}${link}</span>`;
  const content = `${kind === "symbol" && href ? `${link} ` : ""}${render(body)}`;
  const detail = `<span class="noema-inline-detail">${content}</span>`;
  if (expand) return `${start}${kind === "spoiler" ? "" : `${labelHtml} `}${detail}</span>`;
  if (kind !== "spoiler") {
    return `${start}<button type="button" class="noema-inline-trigger noema-inline-popover-button" aria-expanded="false" data-inline-popover-trigger>${labelHtml}</button>`
      + `<span class="noema-inline-detail noema-inline-popover" popover="auto" role="note">${content}</span></span>`;
  }
  return `${start}<label class="noema-inline-control"><input class="noema-inline-toggle" type="checkbox" aria-label="${value}">`
    + `<span class="noema-inline-trigger"><span class="noema-inline-reveal-label">${labelHtml}</span>`
    + `<span class="noema-inline-hide-label">${escape(closeLabel || "Hide")}</span></span></label>${detail}</span>`;
}
