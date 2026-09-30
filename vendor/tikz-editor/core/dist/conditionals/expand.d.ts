/**
 * TeX conditional expansion.
 *
 * Expands \ifnum, \ifodd, \ifx, and \ifthenelse in text after variable
 * substitution, before parsing. Operates purely on strings.
 */
/**
 * Expand all TeX conditionals in the input string.
 * Returns the string with \ifnum/\ifodd/\ifx/\ifthenelse blocks resolved.
 */
export declare function expandTexConditionals(input: string, maxPasses?: number): string;
