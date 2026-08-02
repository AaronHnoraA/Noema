export function normalizeVisualTexLatex(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[\u2028\u2029]/gu, "\n");
}

/**
 * KaTeX does not implement amsmath's `multline` environment. Render it as the
 * closest supported unnumbered multi-row environment while leaving the note's
 * standard TeX source untouched for MathLive and LaTeX export.
 */
export function katexCompatibleLatex(source: string): string {
  return normalizeVisualTexLatex(source)
    .replace(/\\begin\{multline\*?\}/g, "\\begin{gathered}")
    .replace(/\\end\{multline\*?\}/g, "\\end{gathered}");
}
