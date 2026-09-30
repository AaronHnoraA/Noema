/** TikZ source and the HTML hydration target shared by preview and export. */

import {
  classifyTikzSource,
  stripTexComments,
  type TikzIntrinsicEm,
} from "../shared/tikz-source.mjs";

export {
  classifyTikzSource,
  tikzAssetFileName,
  tikzAssetMarkdownPath,
  tikzBasePt,
  tikzIntrinsicEm,
  tikzPictureSource,
  tikzSourceHash,
  tikzStandaloneDocument,
  tikzSvgIntrinsicSize,
  TIKZ_DEFAULT_BASE_PT,
} from "../shared/tikz-source.mjs";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @deprecated Use `stripTexComments`; kept as the historical export name. */
export function stripTikzComments(source: string): string {
  return stripTexComments(source);
}

/**
 * The source as TeX the way TikZ consumers expect it: a document or picture is
 * left alone, loose picture commands gain a `tikzpicture` wrapper.
 */
export function normalizeTikzSource(source: string): string {
  const { kind, body } = classifyTikzSource(source);
  if (kind === "empty") return "";
  if (kind === "commands") return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
  return body;
}

/**
 * Inline style pinning the figure to its LaTeX-native size.
 *
 * The compiled SVG's size is expressed in `em` of the surrounding prose, so a
 * picture keeps the same proportion to body text that it had in the PDF instead
 * of being scaled to an arbitrary pixel box. `max-width` still yields to the
 * measure on narrow screens.
 */
export function tikzIntrinsicStyle(intrinsic: TikzIntrinsicEm | null | undefined): string {
  const width = Number(intrinsic?.widthEm);
  if (!Number.isFinite(width) || width <= 0) return "";
  const height = Number(intrinsic?.heightEm);
  const ratio = Number.isFinite(height) && height > 0 ? `; aspect-ratio: ${width} / ${height}` : "";
  return `--aaronnote-tikz-natural-width: ${width}em${ratio}`;
}

/**
 * Synchronous Markdown rendering emits a hydration target. The browser's
 * custom element renders it on connection; static export replaces it with
 * inline SVG before writing HTML.
 */
export function renderTikzFigureBody(source: string, id: string): string {
  const tex = normalizeTikzSource(source);
  if (!tex) return "";
  return `<noema-tikz data-source="${escapeHtml(source)}" aria-label="${escapeHtml(`TikZ ${id}`)}"><pre class="aaronnote-tikz-source"><code>${escapeHtml(tex)}</code></pre></noema-tikz>`;
}
