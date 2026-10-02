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
  return normalizeMarkdown(turndown.turndown(template.innerHTML));
}
