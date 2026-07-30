import { scanInlineCommands } from "../src/command-syntax.ts";
import { protectedCitationRanges } from "../shared/bibliography-syntax.mjs";

export type BibliographyCommandRange = {
  from: number;
  to: number;
  source: string;
};

export type BibliographyTextChange = {
  from: number;
  to: number;
  insertedLength: number;
  insertedText?: string;
  deletedText?: string;
};

export type BibliographyWatchRange = { from: number; to: number };

type CitationRange = { from: number; to: number };
type BibliographyRangeModel = { citations?: CitationRange[] };

export type BibliographyResolutionState = {
  /** Position-independent input that can actually change citation resolution. */
  key: string;
  commands: BibliographyCommandRange[];
  watchRanges: BibliographyWatchRange[];
  hasCitationSyntax: boolean;
};

function bibliographyMetadataState(markdown: string): { source: string; ranges: BibliographyWatchRange[] } {
  const yaml = markdown.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  const org = markdown.match(/^\s*#\+begin\s+meta\s*\r?\n[\s\S]*?\r?\n\s*#\+end\s+meta\s*$/im);
  const ranges: BibliographyWatchRange[] = [];
  if (yaml?.index !== undefined) ranges.push({ from: yaml.index, to: yaml.index + yaml[0].length });
  if (org?.index !== undefined) ranges.push({ from: org.index, to: org.index + org[0].length });
  const fields: Record<"bib" | "extend", string> = { bib: "", extend: "" };
  for (const block of [yaml?.[0] || "", org?.[0] || ""]) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(bib|extend)\s*:\s*(.*?)\s*$/i);
      if (!match) continue;
      const key = match[1]!.toLowerCase() as "bib" | "extend";
      const value = match[2]!.trim();
      fields[key] = key === "extend" && value.length >= 2
        && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]
        ? value.slice(1, -1)
        : value;
    }
  }
  return { source: JSON.stringify(fields), ranges };
}

function escapedAt(source: string, from: number): boolean {
  let slashes = 0;
  for (let index = from - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/**
 * Return only the source that affects bibliography resolution. Ordinary prose
 * and the absolute positions of unchanged citations are intentionally absent,
 * so typing elsewhere in a note cannot trigger another server/BibTeX pass.
 */
export function bibliographyResolutionState(markdown: string): BibliographyResolutionState {
  const source = String(markdown || "");
  const metadata = bibliographyMetadataState(source);
  const protectedRanges = protectedCitationRanges(source) as BibliographyWatchRange[];
  const protectedAt = (from: number): boolean => protectedRanges.some((range) => from >= range.from && from < range.to);
  const commands = scanInlineCommands(source, "cite")
    .filter((command) => !protectedAt(command.fullFrom))
    .map((command) => ({
    from: command.fullFrom,
    to: command.fullTo,
    source: source.slice(command.fullFrom, command.fullTo),
    }));
  const completeStarts = new Set(commands.map((command) => command.from));
  const malformed = [...source.matchAll(/@@cite\b[^\r\n]*/gi)]
    .filter((match) => !escapedAt(source, match.index) && !protectedAt(match.index) && !completeStarts.has(match.index))
    .map((match) => ({
      from: match.index,
      to: match.index + match[0].length,
      source: match[0],
    }));
  return {
    key: JSON.stringify([
      metadata.source,
      ...commands.map((command) => command.source),
      ...(malformed.length > 0 ? ["malformed", ...malformed.map((range) => range.source)] : []),
    ]),
    commands,
    watchRanges: [
      ...metadata.ranges,
      ...commands.map(({ from, to }) => ({ from, to })),
      ...malformed.map(({ from, to }) => ({ from, to })),
    ],
    hasCitationSyntax: commands.length > 0 || malformed.length > 0,
  };
}

const BIBLIOGRAPHY_STRUCTURE_RE = /[@#`$\\[\](){}<>~\-]/;

function changeOverlapsRange(change: BibliographyTextChange, range: BibliographyWatchRange): boolean {
  if (change.from === change.to) return change.from > range.from && change.from < range.to;
  return change.from < range.to && change.to > range.from;
}

/**
 * Decide whether an editor transaction can change bibliography semantics.
 * Plain prose outside watched citation/meta ranges is deliberately false.
 */
export function bibliographyChangesRequireResolution(
  changes: readonly BibliographyTextChange[],
  watchRanges: readonly BibliographyWatchRange[],
): boolean {
  return changes.some((change) => {
    if (watchRanges.some((range) => changeOverlapsRange(change, range))) return true;
    return BIBLIOGRAPHY_STRUCTURE_RE.test(change.insertedText || "")
      || BIBLIOGRAPHY_STRUCTURE_RE.test(change.deletedText || "");
  });
}

function contiguousChange(previous: string, next: string): { from: number; oldTo: number; newTo: number } | null {
  if (previous === next) return null;
  const shorter = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shorter && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  let suffix = 0;
  while (
    suffix < previous.length - from
    && suffix < next.length - from
    && previous.charCodeAt(previous.length - suffix - 1) === next.charCodeAt(next.length - suffix - 1)
  ) suffix += 1;
  return { from, oldTo: previous.length - suffix, newTo: next.length - suffix };
}

function mapRange(range: CitationRange, change: { from: number; oldTo: number; newTo: number }): boolean {
  const { from, oldTo, newTo } = change;
  const delta = newTo - oldTo;
  const before = { from: range.from, to: range.to };

  if (range.to <= from) return false;
  if (range.from >= oldTo) {
    range.from += delta;
    range.to += delta;
  } else {
    // The edit touches the range. This approximation keeps the model and its
    // scanned command paired while the cursor exposes raw source; the trailing
    // resolution pass will either align it exactly or replace the model.
    range.from = range.from < from ? range.from : from;
    range.to = range.to > oldTo ? range.to + delta : newTo;
  }
  return range.from !== before.from || range.to !== before.to;
}

/** Map cached citation positions through the latest editor text change. */
export function mapBibliographyRangesThroughTextChange(
  model: BibliographyRangeModel,
  commands: BibliographyCommandRange[],
  previous: string,
  next: string,
): boolean {
  const change = contiguousChange(previous, next);
  if (!change) return false;
  return mapBibliographyRangesThroughChanges(model, commands, [{
    from: change.from,
    to: change.oldTo,
    insertedLength: change.newTo - change.from,
  }]);
}

/** Map cached ranges through CodeMirror's compact transaction changes. */
export function mapBibliographyRangesThroughChanges(
  model: BibliographyRangeModel,
  commands: BibliographyCommandRange[],
  changes: readonly BibliographyTextChange[],
): boolean {
  let changed = false;
  let offset = 0;
  for (const change of changes) {
    const from = change.from + offset;
    const oldTo = change.to + offset;
    const newTo = from + change.insertedLength;
    const mapped = { from, oldTo, newTo };
    for (const citation of model.citations || []) changed = mapRange(citation, mapped) || changed;
    for (const command of commands) changed = mapRange(command, mapped) || changed;
    offset += change.insertedLength - (change.to - change.from);
  }
  return changed;
}

/** Map metadata/malformed-citation watch ranges through editor changes. */
export function mapBibliographyWatchRangesThroughChanges(
  ranges: BibliographyWatchRange[],
  changes: readonly BibliographyTextChange[],
): void {
  let offset = 0;
  for (const change of changes) {
    const from = change.from + offset;
    const oldTo = change.to + offset;
    const newTo = from + change.insertedLength;
    const mapped = { from, oldTo, newTo };
    for (const range of ranges) mapRange(range, mapped);
    offset += change.insertedLength - (change.to - change.from);
  }
}

/**
 * Align server citation ranges with a freshly scanned document whose
 * position-independent resolution key is unchanged. The server may omit cite
 * syntax in protected/private contexts, hence the range lookup instead of a
 * naive citation-array index.
 */
export function alignBibliographyCitationRanges(
  model: BibliographyRangeModel,
  previousCommands: readonly BibliographyCommandRange[],
  nextCommands: readonly BibliographyCommandRange[],
): boolean {
  if (previousCommands.length !== nextCommands.length) return false;
  const commandIndex = new Map(previousCommands.map((command, index) => [`${command.from}:${command.to}`, index]));
  let changed = false;
  for (const citation of model.citations || []) {
    const index = commandIndex.get(`${citation.from}:${citation.to}`);
    if (index === undefined) continue;
    const next = nextCommands[index];
    if (!next || next.source !== previousCommands[index]?.source) continue;
    if (citation.from !== next.from || citation.to !== next.to) changed = true;
    citation.from = next.from;
    citation.to = next.to;
  }
  return changed;
}
