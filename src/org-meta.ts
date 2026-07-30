/**
 * Pure syntax helpers for Noema's `#+begin meta` body.
 *
 * Keeping this module DOM-free lets the CM6 widget, HTML export, indexing, and
 * tests share one interpretation of metadata.  In particular, an embedded
 * `summary` block belongs to the cover document, not to the key/value parser.
 */

import {
  ORG_META_PREAMBLE_LINE_LIMIT,
  orgMetaSummaryRangeFromLines,
} from "../shared/meta-summary.mjs";
import type { LineDocument, MetaSummarySourceRange } from "../shared/meta-summary.mjs";

export { ORG_META_PREAMBLE_LINE_LIMIT, orgMetaSummaryRangeFromLines };
export type { LineDocument, MetaSummarySourceRange };

export interface MetaEntry {
  key: string;
  value: string;
}

/** A line-backed property. Offsets are relative to the meta block body. */
export interface EditableMetaEntry extends MetaEntry {
  lineFrom: number;
  lineTo: number;
  fullTo: number;
  keyFrom: number;
  keyTo: number;
  valueFrom: number;
  valueTo: number;
}

export interface MetaSummary {
  title: string;
  body: string;
  /** Offsets relative to the meta block body. */
  bodyFrom: number;
  bodyTo: number;
}

export interface OrgMetaDocument {
  entries: MetaEntry[];
  summary: MetaSummary | null;
}

interface SourceLine {
  from: number;
  to: number;
  fullTo: number;
  text: string;
}

const META_SUMMARY_OPEN_RE = /^[ \t]*#\+\s*begin\s+summary(?:[ \t]+([^\r\n]*?))?[ \t]*$/i;
const META_SUMMARY_CLOSE_RE = /^[ \t]*#\+\s*end\s+summary[ \t]*$/i;

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline < 0 ? source.length : newline;
    lines.push({
      from,
      to,
      fullTo: newline < 0 ? to : to + 1,
      text: source.slice(from, to).replace(/\r$/, ""),
    });
    if (newline < 0) break;
    from = newline + 1;
  }
  return lines;
}

function rawMetaEntries(body: string): MetaEntry[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ key: match[1]!, value: match[2] ?? "" }));
}

function summarySourceRange(body: string): { from: number; to: number } | null {
  const lines = sourceLines(body);
  for (let openIndex = 0; openIndex < lines.length; openIndex++) {
    if (!META_SUMMARY_OPEN_RE.test(lines[openIndex]!.text)) continue;
    let depth = 1;
    for (let closeIndex = openIndex + 1; closeIndex < lines.length; closeIndex++) {
      if (META_SUMMARY_OPEN_RE.test(lines[closeIndex]!.text)) depth += 1;
      else if (META_SUMMARY_CLOSE_RE.test(lines[closeIndex]!.text)) depth -= 1;
      if (depth === 0) {
        return { from: lines[openIndex]!.from, to: lines[closeIndex]!.fullTo };
      }
    }
    return { from: lines[openIndex]!.from, to: body.length };
  }
  return null;
}

/**
 * Parse editable top-level `key: value` lines without serialising the block.
 * Summary prose and unknown lines are deliberately excluded, so UI edits can
 * patch exact source ranges and preserve every byte outside the chosen field.
 */
export function editableMetaEntries(body: string): EditableMetaEntry[] {
  const source = String(body || "");
  const summaryRange = summarySourceRange(source);
  const entries: EditableMetaEntry[] = [];
  for (const line of sourceLines(source)) {
    if (summaryRange && line.from >= summaryRange.from && line.from < summaryRange.to) continue;
    const prefix = /^(\s*)([A-Za-z0-9_-]+)(\s*:\s*)/.exec(line.text);
    if (!prefix) continue;
    const key = prefix[2] ?? "";
    const keyFrom = line.from + (prefix[1]?.length ?? 0);
    const keyTo = keyFrom + key.length;
    const valueFrom = line.from + prefix[0].length;
    let valueTo = line.to;
    while (valueTo > valueFrom && /[ \t]/.test(source[valueTo - 1] ?? "")) valueTo -= 1;
    entries.push({
      key,
      value: source.slice(valueFrom, valueTo),
      lineFrom: line.from,
      lineTo: line.to,
      fullTo: line.fullTo,
      keyFrom,
      keyTo,
      valueFrom,
      valueTo,
    });
  }
  return entries;
}

export function orgMetaSummarySourceRange(body: string): { from: number; to: number } | null {
  return summarySourceRange(String(body || ""));
}

/** Parse metadata fields and the first complete, top-level summary block. */
export function parseOrgMetaDocument(body: string): OrgMetaDocument {
  const source = String(body || "");
  const lines = sourceLines(source);
  for (let openIndex = 0; openIndex < lines.length; openIndex++) {
    const open = META_SUMMARY_OPEN_RE.exec(lines[openIndex]!.text);
    if (!open) continue;

    let depth = 1;
    for (let closeIndex = openIndex + 1; closeIndex < lines.length; closeIndex++) {
      const line = lines[closeIndex]!;
      if (META_SUMMARY_OPEN_RE.test(line.text)) depth++;
      else if (META_SUMMARY_CLOSE_RE.test(line.text)) depth--;
      if (depth !== 0) continue;

      const openLine = lines[openIndex]!;
      const summaryBody = source
        .slice(openLine.fullTo, line.from)
        .replace(/\r?\n$/, "");
      const metadataBody = source.slice(0, openLine.from) + source.slice(line.fullTo);
      return {
        entries: rawMetaEntries(metadataBody),
        summary: {
          title: (open[1] ?? "").trim(),
          body: summaryBody,
          bodyFrom: openLine.fullTo,
          bodyTo: line.from,
        },
      };
    }

    // An incomplete nested block is source, not metadata.  Ignore its tail so
    // prose such as `case: value` cannot accidentally become a cover field.
    return {
      entries: rawMetaEntries(source.slice(0, lines[openIndex]!.from)),
      summary: null,
    };
  }

  return { entries: rawMetaEntries(source), summary: null };
}

export function parseMetaEntries(body: string): MetaEntry[] {
  return parseOrgMetaDocument(body).entries;
}

export function metaEntryMap(entries: readonly MetaEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.key.toLowerCase(), entry.value]));
}

export function metaTags(value: string): string[] {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

export function showMetaTag(tag: string): boolean {
  return !/[\\/_]/.test(tag);
}

export function unquoteMetaScalar(value: string): string {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function metaRoamIndexed(entries: readonly MetaEntry[]): boolean {
  const byKey = metaEntryMap(entries);
  const id = unquoteMetaScalar(byKey.get("id") || "").trim();
  const roam = unquoteMetaScalar(byKey.get("roam") || "").trim().toLowerCase();
  return id.length > 0 && roam !== "off";
}
