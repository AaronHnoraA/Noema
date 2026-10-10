import type { WikiNote } from "./api-client.ts";
import type { SnippetSummary } from "./types.ts";
import { qualifiedWikiTitle, stableWikiTarget } from "../shared/wiki-link.mjs";

export type WikiLinkCompletionContext = {
  prefix: string;
  hasClosingDelimiter: boolean;
};

/**
 * Find the Wiki target containing the cursor. This deliberately supports both
 * `[[partial|` and the common "type the pair first" form `[[partial|]]`.
 */
export function wikiLinkCompletionContext(before: string, after = ""): WikiLinkCompletionContext | null {
  const line = String(before || "").slice(String(before || "").lastIndexOf("\n") + 1);
  const open = line.lastIndexOf("[[");
  if (open < 0 || line.lastIndexOf("]]" ) > open) return null;
  const prefix = line.slice(open + 2);
  if (prefix.includes("[[") || prefix.includes("|") || /[\r\n]/.test(prefix)) return null;
  return { prefix, hasClosingDelimiter: String(after || "").startsWith("]]" ) };
}

function folded(value: string): string {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

type FoldedNote = { title: string; aliases: string[]; path: string; qualified: string };

// Completion ranks every page on every keystroke. Folding a title is the
// expensive part of that, and a page's names do not change while its index
// entry lives, so each entry is folded once.
const foldedNotes = new WeakMap<WikiNote, FoldedNote>();

function foldedNote(note: WikiNote): FoldedNote {
  let value = foldedNotes.get(note);
  if (!value) {
    value = {
      title: folded(note.title),
      aliases: note.aliases.map(folded),
      path: folded(`${note.repositoryId}/${note.repositoryPath}`),
      qualified: folded(`${note.qualifiedTitle || qualifiedWikiTitle(note.namespace, note.title)} ${note.fullTitle || ""}`),
    };
    foldedNotes.set(note, value);
  }
  return value;
}

function rank(note: WikiNote, needle: string): number {
  if (!needle) return 4;
  const { title, aliases, path, qualified } = foldedNote(note);
  if (title === needle) return 0;
  if (aliases.includes(needle)) return 1;
  if (title.startsWith(needle) || aliases.some((alias) => alias.startsWith(needle))) return 2;
  if (title.includes(needle) || aliases.some((alias) => alias.includes(needle))) return 3;
  return path.includes(needle) || qualified.includes(needle) ? 4 : 99;
}

type WikiBlock = NonNullable<WikiNote["blocks"]>[number];

function blockRank(note: WikiNote, block: WikiBlock, needle: string): number {
  if (!needle) return 6;
  const label = folded(block.label || block.id);
  const id = folded(block.id);
  if (label === needle || id === needle) return 0;
  if (label.startsWith(needle) || id.startsWith(needle)) return 2;
  if (label.includes(needle) || id.includes(needle)) return 3;
  const { title, qualified } = foldedNote(note);
  return title.includes(needle) || qualified.includes(needle) ? 5 : 99;
}

function pageSnippet(note: WikiNote, closing: string): SnippetSummary {
  return {
    id: `wiki:${note.repositoryId}:${note.id}`,
    key: note.qualifiedTitle || qualifiedWikiTitle(note.namespace, note.title) || note.title,
    name: note.title,
    description: `${note.namespace || note.repository} · ${note.repositoryId} · ${note.repositoryPath}`,
    mode: "markdown-mode",
    group: "Wiki pages",
    kind: note.kind || "page",
    body: `${note.identityStatus === "provisional" ? note.title : `${stableWikiTarget(note.id)}|${note.title}`}${closing}`,
    source: `${note.fullTitle || note.qualifiedTitle || note.title} · ${note.repositoryPath}`,
    provider: "wiki",
    browserCompatible: true,
  };
}

function blockSnippet(note: WikiNote, block: WikiBlock, label: string, closing: string): SnippetSummary {
  return {
    id: `wiki-block:${note.repositoryId}:${note.id}:${block.id}`,
    key: label,
    name: label,
    description: `${block.envKind || block.kind} · ${note.title} · ${note.repositoryPath}`,
    mode: "markdown-mode",
    group: "Wiki blocks",
    kind: block.envKind || block.kind || "block",
    body: `${stableWikiTarget(note.id, block.id)}|${label}${closing}`,
    source: `${note.fullTitle || note.qualifiedTitle || note.title} · #${block.id}`,
    provider: "wiki",
    browserCompatible: true,
  };
}

export function wikiCompletionSnippets(
  notes: WikiNote[],
  context: WikiLinkCompletionContext,
  limit = 10,
): SnippetSummary[] {
  const needle = folded(context.prefix);
  const closing = context.hasClosingDelimiter ? "" : "]]";
  // With nothing typed every page outranks every block, so blocks can only
  // appear when there are fewer pages than rows; skip ranking them otherwise.
  const rankBlocks = Boolean(needle) || notes.length < limit;
  const candidates: Array<{ note: WikiNote; block?: WikiBlock; rank: number; name: string }> = [];
  for (const note of notes) {
    const pageRank = rank(note, needle);
    if (pageRank < 99) candidates.push({ note, rank: pageRank, name: note.title });
    if (!rankBlocks || note.identityStatus === "provisional") continue;
    for (const block of note.blocks || []) {
      const rankOfBlock = blockRank(note, block, needle);
      if (rankOfBlock < 99) {
        candidates.push({ note, block, rank: rankOfBlock, name: String(block.label || block.id).trim() });
      }
    }
  }
  // Only the rows that will be shown are turned into snippets.
  const matches = candidates
    .sort((a, b) => a.rank - b.rank
      || Number(Boolean(a.block)) - Number(Boolean(b.block))
      || b.note.mtimeMs - a.note.mtimeMs
      || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((item) => item.block
      ? blockSnippet(item.note, item.block, item.name, closing)
      : pageSnippet(item.note, closing));

  const exact = needle && notes.some((note) => {
    const names = foldedNote(note);
    return names.title === needle || names.aliases.includes(needle);
  });
  const title = context.prefix.trim();
  if (title && !exact) {
    matches.push({
      id: `wiki-create:${title}`,
      key: title,
      name: `Create “${title}”`,
      description: "Choose repository and physical folder",
      mode: "markdown-mode",
      group: "Wiki",
      kind: "page",
      body: `${title}${closing}`,
      source: title,
      provider: "wiki-create",
      browserCompatible: true,
    });
  }
  return matches.slice(0, limit + 1);
}
