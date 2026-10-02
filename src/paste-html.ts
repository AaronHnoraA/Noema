import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { convertOfficeLists } from "./office-list.ts";

const MAX_HTML_TO_MARKDOWN_CHARS = 900_000;

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
  hr: "---",
});

turndown.use(gfm);

const orderedListNumbers = new WeakMap<Element, WeakMap<Element, number>>();

function orderedListNumber(parent: Element, item: Element): number {
  let numbers = orderedListNumbers.get(parent);
  if (!numbers) {
    numbers = new WeakMap<Element, number>();
    const items = Array.from(parent.children).filter((child) => child.tagName === "LI");
    const reversed = parent.hasAttribute("reversed");
    const start = parent.getAttribute("start");
    let ordinal = start !== null && /^-?\d+$/u.test(start) ? Number(start) : reversed ? items.length : 1;
    for (const child of items) {
      const value = child.getAttribute("value");
      if (value !== null && /^-?\d+$/u.test(value)) ordinal = Number(value);
      numbers.set(child, ordinal);
      ordinal += reversed ? -1 : 1;
    }
    orderedListNumbers.set(parent, numbers);
  }
  return numbers.get(item) ?? 1;
}

// One space after the marker and nested content indented to the marker's
// width (`- ` → 2, `10. ` → 4), as Marker's turndown rule writes lists;
// turndown's default `-   item` padded every item with three spaces.
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = "- ";
    if (parent?.nodeName === "OL") {
      prefix = `${orderedListNumber(parent, node as Element)}. `;
    }
    const body = content
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n")
      .replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${body}${node.nextSibling && !/\n$/.test(body) ? "\n" : ""}`;
  },
});

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

function escapeUnescapedPipes(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length) {
      out += char + text[index + 1];
      index++;
    } else {
      out += char === "|" ? "\\|" : char;
    }
  }
  return out;
}

// A GFM table row is one source line. turndown-plugin-gfm emits a cell's
// converted children verbatim, so a paragraph or line break inside a cell, or
// a literal pipe, split the row. Fold block breaks to `<br>` and escape pipes,
// as MarkText's paste normalization does. Registered after `gfm`, so it wins.
turndown.addRule("tableCellSingleLine", {
  filter: ["th", "td"],
  replacement: (content, node) => {
    const parent = node.parentNode;
    const index = parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0;
    const cell = escapeUnescapedPipes(content.trim().replace(/[ \t]*\n+[ \t]*/g, "<br>"));
    return `${index === 0 ? "| " : " "}${cell} |`;
  },
});

turndown.addRule("tableCellLineBreak", {
  filter: (node) => node.nodeName === "BR" && Boolean((node as Element).closest?.("td, th")),
  replacement: () => "<br>",
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

/**
 * Give every pasted table the shape a GFM table needs, before conversion.
 *
 * Spreadsheets (Excel, Numbers, Google Sheets) and many web pages put no `<th>`
 * row in a table, and turndown-plugin-gfm keeps such a table as raw HTML. As in
 * MarkText's `normalizePastedHTML`, the first row is promoted to the header and
 * `colspan` cells are expanded so every row has the same number of columns.
 */
export function normalizePastedTables(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll("table"))) {
    for (const row of Array.from(table.rows)) {
      for (const cell of Array.from(row.cells)) {
        const span = Math.max(1, Math.min(64, Math.trunc(cell.colSpan || 1)));
        if (span <= 1) continue;
        cell.removeAttribute("colspan");
        const fillers = Array.from({ length: span - 1 }, () => document.createElement(cell.tagName.toLowerCase()));
        cell.after(...fillers);
      }
    }
    const first = table.rows[0];
    if (!first) continue;
    if (Array.from(first.cells).some((cell) => cell.tagName !== "TH")) {
      for (const cell of Array.from(first.cells)) {
        if (cell.tagName === "TH") continue;
        const header = document.createElement("th");
        for (const attribute of Array.from(cell.attributes)) header.setAttribute(attribute.name, attribute.value);
        header.append(...Array.from(cell.childNodes));
        cell.replaceWith(header);
      }
    }
    // turndown-plugin-gfm only treats the first row as a header when it is the
    // first child of the table or of the first <tbody>/<thead>.
    const section = first.parentElement;
    if (section && section !== table && section.tagName === "TBODY" && section.firstElementChild !== first) {
      section.prepend(first);
    }
    // Every row must have as many cells as the header for the delimiter row.
    const width = Math.max(...Array.from(table.rows).map((row) => row.cells.length));
    for (const row of Array.from(table.rows)) {
      while (row.cells.length < width) row.append(document.createElement(row === first ? "th" : "td"));
    }
  }
}

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

function styleWeightBold(style: string): boolean {
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(style)?.[1]?.toLowerCase();
  if (!weight) return false;
  return weight === "bold" || weight === "bolder" || (/^\d+$/.test(weight) && Number(weight) >= 600);
}

function hasFormatAncestor(element: Element, names: readonly string[]): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (names.includes(parent.tagName)) return true;
  }
  return false;
}

function removeRedundantDescendants(element: Element, selector: string): void {
  for (const child of Array.from(element.querySelectorAll(selector))) {
    child.replaceWith(...Array.from(child.childNodes));
  }
}

/**
 * Inline structure that HTML sources express in ways turndown misreads.
 *
 * - Google Docs wraps the whole clipboard in `<b style="font-weight:normal">`
 *   and marks real bold/italic on `<span style>`: the wrapper became stray
 *   `**` around every paragraph while the actual formatting was lost. Word and
 *   many web editors also style spans instead of using tags.
 * - A link whose text is its own address is a bare URL (MarkText unlinks it);
 *   `[u](u)` only doubles it, and GFM autolinks a bare URL anyway.
 * - An empty link — a heading's `#` permalink anchor — produced `[](#x)`.
 */
export function normalizePastedInlines(root: ParentNode): void {
  for (const wrapper of Array.from(root.querySelectorAll("b, strong"))) {
    const style = wrapper.getAttribute("style") ?? "";
    if (/font-weight\s*:\s*(normal|[1-5]00)\b/i.test(style)) wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  for (const span of Array.from(root.querySelectorAll("span[style]"))) {
    const style = span.getAttribute("style") ?? "";
    const tags: string[] = [];
    if (styleWeightBold(style) && !hasFormatAncestor(span, ["B", "STRONG"])) tags.push("strong");
    if (/font-style\s*:\s*italic/i.test(style) && !hasFormatAncestor(span, ["I", "EM"])) tags.push("em");
    if (/text-decoration[^;]*line-through/i.test(style) && !hasFormatAncestor(span, ["S", "STRIKE", "DEL"])) tags.push("del");
    if (tags.length === 0 || !span.textContent?.trim()) continue;
    // A style covers the whole span, so semantic tags of the same kind inside
    // it add no information. Leaving both produced `****bold****` and `**italic**`.
    for (const tag of tags) {
      removeRedundantDescendants(span, tag === "strong" ? "b, strong" : tag === "em" ? "i, em" : "s, strike, del");
    }
    let inner: Node[] = Array.from(span.childNodes);
    for (const tag of tags) {
      const element = document.createElement(tag);
      element.append(...inner);
      inner = [element];
    }
    span.replaceWith(...inner);
  }
  for (const link of Array.from(root.querySelectorAll("a"))) {
    const text = link.textContent?.trim() ?? "";
    const href = link.getAttribute("href") ?? "";
    if (!text && !link.querySelector("img")) {
      link.remove();
      continue;
    }
    if (href && text && (text === href || text === href.replace(/\/$/, "")) && /^(?:https?|mailto):/i.test(href)) {
      link.replaceWith(document.createTextNode(text));
    }
  }
}

export function htmlToMarkdown(html: string): string {
  const raw = String(html || "");
  if (raw.length > MAX_HTML_TO_MARKDOWN_CHARS) return plainTextFromHtml(raw);
  // Word and PowerPoint encode list structure in proprietary mso-* styles.
  // Recover semantic lists while that metadata is still present, then apply
  // the normal sanitizer and HTML-to-Markdown boundary.
  const officeHtml = convertOfficeLists(raw).html;
  const clean = DOMPurify.sanitize(officeHtml, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|zotero|roam):|[^:]*?(?:[/?#]|$))/i,
    ADD_TAGS: ["math-block"],
    ADD_ATTR: ["data-aaronnote-math-block", "data-display", "data-delimiter", "data-math-render-key", "data-tex"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  normalizePastedTables(template.content);
  normalizePastedInlines(template.content);
  return normalizeMarkdown(turndown.turndown(template.innerHTML));
}
