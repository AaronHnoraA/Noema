import type { MarkdownHeading } from "./cm6/toc-index.ts";

/**
 * GitHub-compatible heading slug.
 *
 * Matches github-slugger behavior: lowercase, remove Unicode punctuation/symbols
 * except hyphens and underscores (this covers CJK punctuation like ，。：！？),
 * replace spaces with hyphens, preserve CJK letters/digits.
 *
 * Note: diverges from slugOutlineAnchor in semantic-outline.ts which is used
 * for semantic (@@part/@@section) heading anchors — don't unify them.
 */
export function githubSlug(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (ch) => (ch === "-" || ch === "_" ? ch : ""))
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "section";
}

export type HeadingWithSlug = {
  heading: MarkdownHeading;
  slug: string;
};

/** Assign GitHub-compatible slugs to headings in document order; duplicates get -1, -2 … suffixes. */
export function assignHeadingSlugs(headings: readonly MarkdownHeading[]): HeadingWithSlug[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const base = heading.slug ?? githubSlug(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    return { heading, slug };
  });
}

/**
 * Find the heading matching a `#hash` href.
 * Tries assigned GitHub slugs first, then semantic heading.slug, then
 * case-insensitive text match — back-compat with existing notes.
 */
export function resolveAnchorHeading(
  headings: readonly MarkdownHeading[],
  hash: string,
): MarkdownHeading | null {
  const decoded = decodeURIComponent(hash).replace(/^#/, "").toLowerCase().trim();
  if (!decoded) return null;

  const withSlugs = assignHeadingSlugs(headings);
  const bySlug = withSlugs.find((h) => h.slug === decoded);
  if (bySlug) return bySlug.heading;

  const bySemantic = headings.find((h) => h.slug?.toLowerCase() === decoded);
  if (bySemantic) return bySemantic;

  const byText = headings.find((h) => h.text.toLowerCase() === decoded);
  return byText ?? null;
}
