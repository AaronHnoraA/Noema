import { scanWikiLinks, stableWikiTarget } from "../shared/wiki-link.mjs";

export type WikiCreationSource = { from: number; raw: string };

function stableTargetForSource(pageId: string, originalTarget: string): string {
  const fragment = originalTarget.includes("#") ? originalTarget.split("#").slice(1).join("#") : "";
  let decoded = fragment;
  try { decoded = decodeURIComponent(fragment); } catch {}
  return stableWikiTarget(pageId, decoded);
}

export function wikiCreationSource(markdown: string, title: string, cursor: number): WikiCreationSource | null {
  const candidates = scanWikiLinks(markdown)
    .filter((link) => link.target === title)
    .map((link) => ({ from: link.from, to: link.to, raw: markdown.slice(link.from, link.to) }));
  for (const match of markdown.matchAll(/\[[^\]\n]+\]\(roam:\/\/wiki\/[^)\n]+\)/g)) {
    const from = match.index;
    const raw = match[0];
    const target = raw.match(/\]\(roam:\/\/wiki\/([^)]+)\)$/)?.[1] || "";
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch {}
    if (decoded === title) candidates.push({ from, to: from + raw.length, raw });
  }
  const atCursor = candidates.find((candidate) => cursor >= candidate.from && cursor <= candidate.to + 2);
  const chosen = atCursor || (candidates.length === 1 ? candidates[0] : null);
  return chosen ? { from: chosen.from, raw: chosen.raw } : null;
}

export function createdWikiLinkChange(
  markdown: string,
  source: WikiCreationSource,
  pageId: string,
): { from: number; to: number; insert: string } | null {
  const { from, raw } = source;
  if (!Number.isSafeInteger(from) || from < 0 || !raw || !/^[0-9a-f-]{36}$/i.test(pageId)
    || markdown.slice(from, from + raw.length) !== raw) return null;
  let insert = "";
  if (raw.startsWith("[[") && raw.endsWith("]]")) {
    const parsed = scanWikiLinks(raw)[0];
    if (parsed) insert = `[[${stableTargetForSource(pageId, parsed.target)}|${parsed.label}]]`;
  } else if (/^\[[^\]\n]+\]\(roam:\/\/wiki\/[^)\n]+\)$/.test(raw)) {
    const encodedTarget = raw.match(/\]\(roam:\/\/wiki\/([^)\n]+)\)$/)?.[1] || "";
    let target = encodedTarget;
    try { target = decodeURIComponent(encodedTarget); } catch {}
    insert = raw.replace(/\]\(roam:\/\/wiki\/[^)\n]+\)$/, `](${stableTargetForSource(pageId, target)})`);
  }
  return insert ? { from, to: from + raw.length, insert } : null;
}
