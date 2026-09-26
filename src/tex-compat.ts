import { rewriteCompatEnvironments } from "../shared/tex-compat.mjs";

export function normalizeVisualTexLatex(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[\u2028\u2029]/gu, "\n");
}

/**
 * KaTeX does not implement every amsmath environment (`multline`, ...). Render
 * each one as the closest supported equivalent while leaving the note's
 * standard TeX source untouched for MathLive and LaTeX export.
 *
 * The substitution table lives in `shared/tex-compat-rules.json` because the
 * Emacs RaTeX preview applies the same rewrites; a second copy here is how the
 * preview and the published note would start disagreeing.
 */
export function katexCompatibleLatex(source: string): string {
  return rewriteCompatEnvironments(normalizeVisualTexLatex(source));
}
