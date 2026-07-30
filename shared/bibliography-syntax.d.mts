export type BibliographySourceRange = { from: number; to: number };

/** Contexts in which `@@cite` is literal/private rather than resolvable. */
export function protectedCitationRanges(markdown: string): BibliographySourceRange[];
