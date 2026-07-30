export type LatexExportHeading = {
  level: number;
  text: string;
  pos: number;
  markerFrom?: number;
  omit?: boolean;
};

export type LatexExportScope = {
  id: string;
  kind: "document" | "selection" | "heading";
  title: string;
  detail: string;
  from: number;
  to: number;
  level: number;
  headingIndex?: number;
  active?: boolean;
};

function clampOffset(value: number, length: number): number {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, length));
}

function lineStartAt(markdown: string, pos: number): number {
  const safe = clampOffset(pos, markdown.length);
  return markdown.lastIndexOf("\n", Math.max(0, safe - 1)) + 1;
}

function lineCount(markdown: string, from: number, to: number): number {
  if (to <= from) return 0;
  let count = 1;
  for (let index = from; index < to; index += 1) {
    if (markdown.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function rangeDetail(markdown: string, from: number, to: number): string {
  const lines = lineCount(markdown, from, to);
  const chars = Math.max(0, to - from);
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${chars.toLocaleString()} chars`;
}

export function latexHeadingRange(
  markdown: string,
  headings: readonly LatexExportHeading[],
  index: number,
): { from: number; to: number } {
  const heading = headings[index];
  if (!heading) return { from: 0, to: markdown.length };
  const from = heading.markerFrom ?? lineStartAt(markdown, heading.pos);
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  const to = next ? (next.markerFrom ?? lineStartAt(markdown, next.pos)) : markdown.length;
  return {
    from: clampOffset(from, markdown.length),
    to: clampOffset(to, markdown.length),
  };
}

export function buildLatexExportScopes(options: {
  markdown: string;
  headings: readonly LatexExportHeading[];
  selection?: { from: number; to: number };
  cursor?: number;
}): LatexExportScope[] {
  const markdown = String(options.markdown ?? "");
  const headings = options.headings;
  const cursor = clampOffset(options.cursor ?? options.selection?.from ?? 0, markdown.length);
  const scopes: LatexExportScope[] = [{
    id: "document",
    kind: "document",
    title: "Whole note",
    detail: `${headings.filter((heading) => !heading.omit).length} sections · ${rangeDetail(markdown, 0, markdown.length)}`,
    from: 0,
    to: markdown.length,
    level: 0,
  }];

  const selectionFrom = clampOffset(Math.min(options.selection?.from ?? 0, options.selection?.to ?? 0), markdown.length);
  const selectionTo = clampOffset(Math.max(options.selection?.from ?? 0, options.selection?.to ?? 0), markdown.length);
  if (selectionFrom < selectionTo) {
    scopes.push({
      id: "selection",
      kind: "selection",
      title: "Text selection",
      detail: rangeDetail(markdown, selectionFrom, selectionTo),
      from: selectionFrom,
      to: selectionTo,
      level: 0,
    });
  }

  const headingScopes: LatexExportScope[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (heading.omit) continue;
    const range = latexHeadingRange(markdown, headings, index);
    headingScopes.push({
      id: `heading:${index}`,
      kind: "heading",
      title: heading.text,
      detail: `H${Math.max(1, Math.min(6, heading.level))} subtree · ${rangeDetail(markdown, range.from, range.to)}`,
      from: range.from,
      to: range.to,
      level: Math.max(1, Math.min(6, heading.level)),
      headingIndex: index,
      active: range.from <= cursor && cursor < range.to,
    });
  }

  // If nested scopes contain the cursor, only the deepest one is the current
  // section. This keeps the UI marker unambiguous.
  const active = headingScopes.filter((scope) => scope.active).at(-1);
  for (const scope of headingScopes) scope.active = scope === active;
  scopes.push(...headingScopes);
  return scopes;
}

export function latexExportScopeContent(markdown: string, scope: LatexExportScope): string {
  // Scope offsets are source-authoritative. In particular, trailing spaces and
  // blank lines inside a fenced/verbatim block are data, not cosmetic padding.
  return markdown.slice(scope.from, scope.to);
}

export function toggleLatexExportScopeSelection(
  scopes: readonly LatexExportScope[],
  selectedIds: ReadonlySet<string>,
  toggledId: string,
): Set<string> {
  const toggled = scopes.find((scope) => scope.id === toggledId);
  if (!toggled) return new Set(selectedIds);
  if (toggled.kind !== "heading") return new Set([toggled.id]);

  const next = new Set([...selectedIds].filter((id) =>
    scopes.find((scope) => scope.id === id)?.kind === "heading",
  ));
  if (next.has(toggled.id)) {
    next.delete(toggled.id);
    return next;
  }

  // Parent and child scopes contain duplicate source. Keep the most recently
  // chosen one and remove every overlapping ancestor/descendant.
  for (const id of next) {
    const scope = scopes.find((candidate) => candidate.id === id);
    if (scope && scope.from < toggled.to && toggled.from < scope.to) next.delete(id);
  }
  next.add(toggled.id);
  return next;
}

export function latexExportScopesContent(
  markdown: string,
  scopes: readonly LatexExportScope[],
): string {
  const parts = [...scopes]
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((scope) => latexExportScopeContent(markdown, scope))
    .filter((content) => content.length > 0);
  return parts.reduce((joined, content) => {
    if (!joined) return content;
    if (joined.endsWith("\n\n") || content.startsWith("\n\n")) return joined + content;
    if (joined.endsWith("\n") || content.startsWith("\n")) return `${joined}\n${content}`;
    return `${joined}\n\n${content}`;
  }, "");
}
