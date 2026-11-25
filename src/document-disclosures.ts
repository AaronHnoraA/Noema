import type MarkdownIt from "markdown-it";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { documentPageOffsets, documentPages, headingLabel } from "./document-tabs.ts";
import { documentViewSourceKey } from "./document-view.ts";

export const documentDisclosureKinds = new Set(["details", "accordion"]);

const enabled = (value: string | undefined): boolean => /^(?:true|yes|on|1)$/i.test(value ?? "");

function disclosure(body: string, label: string, open: boolean, interactive: boolean, attributes: string): string {
  return `<details${attributes}${open ? " open" : ""}><summary>${label}</summary>`
    + (interactive ? `<div class="noema-disclosure-body"></div><template data-view-content>${body}</template>`
      : `<div class="noema-disclosure-body">${body}</div>`)
    + "</details>";
}

export function renderDocumentDisclosure(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, interactive: boolean, blockId: string, original?: string): string | null {
  const source = interactive ? ` data-view-kind="${kind}" data-view-source="${documentViewSourceKey(kind, title, body)}"` : "";
  const escape = md.utils.escapeHtml;
  if (kind === "details") {
    const environment = {};
    const head = md.parseInline(title, environment)[0];
    const label = (head ? headingLabel(md, head, environment) : "") || "Details";
    const identity = blockId ? ` data-block-id="${escape(blockId)}"` : "";
    return disclosure(md.render(body), escape(label), enabled(attrs.open), interactive,
      ` class="noema-document-disclosure" data-kind="details" data-title="${escape(title)}"${source}${identity}`);
  }

  const { environment, tokens, pages, first } = documentPages(md, kind, body);
  if (!pages.length) return null;
  const expand = enabled(attrs.expand);
  const multiple = expand || enabled(attrs.multiple);
  const indexes = new Set((attrs.open || "").split(/[ ,]+/).map((index) => Number(index) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < pages.length));
  const preamble = first ? md.renderer.render(tokens.slice(0, first), md.options, environment) : "";
  const single = !multiple ? ' data-accordion-single="true"' : "";
  const firstOpen = indexes.values().next().value;
  const offsets = interactive ? documentPageOffsets(md, kind, body, pages, original) : [];
  const items = pages.map(({ label, content }, index) => {
    const open = expand || (indexes.has(index) && (multiple || index === firstOpen));
    const offset = offsets[index] !== undefined ? ` data-view-offset="${offsets[index]}"` : "";
    return disclosure(md.renderer.render(content, md.options, environment), escape(label), open, interactive,
      ` class="noema-document-disclosure" data-disclosure-item${offset}`);
  }).join("");
  return `<div class="noema-document-accordion"${source}${single}>${preamble}${items}</div>`;
}
