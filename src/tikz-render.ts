/**
 * TikZ rendering for the HTML export/publish path.
 *
 * TikZ is compiled locally (pdflatex → dvisvgm) into a cached SVG asset next to
 * the note; see `shared/tikz-source.mjs` and `renderTikzAsset` in
 * `server/lib/runtime.mjs`. An export therefore only has to *reference* the
 * asset the editor already produced — no in-page TeX engine, no CDN, and the
 * exported page keeps working offline.
 */

import {
  classifyTikzSource,
  stripTexComments,
  tikzAssetMarkdownPath,
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

export type TikzAssetOptions = {
  /** Note file the block belongs to; resolves the compiled asset's directory. */
  noteFile?: string;
  /** Rewrites the note-relative asset path into a URL the page can load. */
  assetResolver?: (src: string) => string;
  /** Intrinsic size measured at compile time, when the caller has it. */
  intrinsic?: TikzIntrinsicEm | null;
};

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
 * The rendered figure body for one `#+begin tikz` block: an `<img>` at the
 * compiled asset when the note context is known, and the TeX source otherwise
 * so nothing silently disappears from an export.
 */
export function renderTikzFigureBody(
  source: string,
  id: string,
  options: TikzAssetOptions = {},
): string {
  const tex = normalizeTikzSource(source);
  if (!tex) return "";
  if (!options.noteFile) {
    return `<pre class="aaronnote-tikz-source"><code>${escapeHtml(tex)}</code></pre>`;
  }
  const path = tikzAssetMarkdownPath(options.noteFile, id, source);
  const src = options.assetResolver?.(path) ?? path;
  const style = tikzIntrinsicStyle(options.intrinsic ?? null);
  return [
    `<img class="cm-image-render aaronnote-tikz-image" src="${escapeHtml(src)}"`,
    `alt="${escapeHtml(`TikZ ${id}`)}" loading="lazy" decoding="async"`,
    style ? `style="${escapeHtml(style)}"` : "",
    "/>",
  ].filter(Boolean).join(" ");
}
