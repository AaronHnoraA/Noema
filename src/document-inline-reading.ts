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
  icon?: string;
};

export const inlineReadingNames = new Set(["spoiler", "gloss", "annotation", "symbol", "kbd", "badge", "color", "icon", "highlight", "hidden"]);
const tones = new Set(["neutral", "note", "info", "tip", "important", "warning", "danger"]);
const literalColor = /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i;
const iconName = /^[a-z][a-z\d-]{0,39}$/i;
const icons = new Map([
  ["check", '<path d="m5 12 4 4L19 6"/>'],
  ["close", '<path d="M18 6 6 18M6 6l12 12"/>'],
  ["search", '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'],
  ["bell", '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5Zm5 3a2 2 0 0 0 4 0"/>'],
  ["bell-off", '<path d="m3 3 18 18M10 20a2 2 0 0 0 4 0M4 17h13M7 7v7l-2 3M11 4a5 5 0 0 1 6 5v3"/>'],
  ["info", '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>'],
  ["warning", '<path d="m12 4 9 16H3Zm0 5v5m0 3h.01"/>'],
  ["plus", '<path d="M5 12h14M12 5v14"/>'],
  ["arrow-right", '<path d="M4 12h15m-6-6 6 6-6 6"/>'],
  ["link", '<path d="m10 13 4-4m-7 5-1 1a3 3 0 0 0 4 4l3-3m-2-8 3-3a3 3 0 0 1 4 4l-1 1"/>'],
]);

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
    case "highlight": return { kind: name, label, body: text, tone: tones.has(args.tone) ? args.tone : "warning" };
    case "icon": return iconName.test(label) ? {
      kind: name, icon: label.toLowerCase(), label: args.label?.trim() || label.replace(/-/g, " "),
      tone: tones.has(args.tone) ? args.tone : "neutral",
    } : null;
    case "color": {
      const color = label.toLowerCase();
      if (!literalColor.test(color) && !tones.has(color)) return null;
      return { kind: name, label: args.label?.trim() || label, color };
    }
    default: return { kind: name, label };
  }
}

export function renderInlineReading(view: InlineReading, render: (markdown: string) => string, escape: (text: string) => string, expand = false): string {
  const { kind, label, body, tone, color, href, closeLabel, icon } = view;
  const value = escape(label);
  if (kind === "hidden") return "";
  if (kind === "kbd") return `<kbd class="noema-inline-key">${value}</kbd>`;
  if (kind === "badge") return `<span class="noema-inline-badge" data-tone="${tone}">${value}</span>`;
  if (kind === "highlight" && body) return `<mark class="noema-inline-highlight" data-tone="${tone}">${render(body)}</mark>`;
  if (kind === "icon" && icon) {
    const glyph = icons.get(icon);
    return glyph
      ? `<span class="noema-inline-icon" data-tone="${tone}" role="img" aria-label="${value}" title="${value}"><svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg></span>`
      : `<span class="noema-inline-icon-fallback">${value}</span>`;
  }
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
