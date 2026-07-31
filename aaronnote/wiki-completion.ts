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

function rank(note: WikiNote, needle: string): number {
  const title = folded(note.title);
  const aliases = note.aliases.map(folded);
  if (!needle) return 4;
  if (title === needle) return 0;
  if (aliases.includes(needle)) return 1;
  if (title.startsWith(needle) || aliases.some((alias) => alias.startsWith(needle))) return 2;
  if (title.includes(needle) || aliases.some((alias) => alias.includes(needle))) return 3;
  const path = folded(`${note.repositoryId}/${note.repositoryPath}`);
  const qualified = folded(`${note.qualifiedTitle || qualifiedWikiTitle(note.namespace, note.title)} ${note.fullTitle || ""}`);
  return path.includes(needle) || qualified.includes(needle) ? 4 : 99;
}

export function wikiCompletionSnippets(
  notes: WikiNote[],
  context: WikiLinkCompletionContext,
  limit = 10,
): SnippetSummary[] {
  const needle = folded(context.prefix);
  const closing = context.hasClosingDelimiter ? "" : "]]";
  const matches = notes
    .map((note) => ({ note, rank: rank(note, needle) }))
    .filter((item) => item.rank < 99)
    .sort((a, b) => a.rank - b.rank
      || b.note.mtimeMs - a.note.mtimeMs
      || a.note.title.localeCompare(b.note.title))
    .slice(0, limit)
    .map(({ note }): SnippetSummary => ({
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
    }));

  const exact = needle && notes.some((note) => folded(note.title) === needle
    || note.aliases.some((alias) => folded(alias) === needle));
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
