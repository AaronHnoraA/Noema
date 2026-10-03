/**
 * Diagrams for an export request.
 *
 * Mermaid needs a browser to lay text out, so the server has no renderer of its
 * own. The page that is already showing a diagram renders it and sends the SVG
 * along, and the export turns that into a figure. Labels are drawn as SVG
 * `<text>` rather than HTML, because the vector converter on the other side
 * drops a `foreignObject` and would arrive with every label missing.
 */

import { renderDiagramSVG, supportedDiagramLang } from "../src/diagram-render.ts";

export type ExportDiagram = { key: string; lang: string; svg: string };

const DIAGRAM_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_-]*)[^\n]*$/;

/** The fences an export has to turn into pictures, in document order. */
export function exportDiagramFences(markdown: string): { lang: string; source: string }[] {
  const lines = String(markdown || "").split(/\r?\n/);
  const found: { lang: string; source: string }[] = [];
  let open: { char: string; length: number; lang: string; body: string[] } | null = null;
  for (const line of lines) {
    if (open) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) {
        if (open.lang) found.push({ lang: open.lang, source: open.body.join("\n") });
        open = null;
        continue;
      }
      open.body.push(line);
      continue;
    }
    const match = line.match(DIAGRAM_FENCE_RE);
    if (!match) continue;
    const lang = String(match[2] || "").toLowerCase();
    open = { char: match[1]![0]!, length: match[1]!.length, lang: supportedDiagramLang(lang) ? lang : "", body: [] };
  }
  return found;
}

/**
 * The same identity the server computes, so a render can be matched back to the
 * fence it came from: the lowercased language and the trimmed source.
 */
export async function exportDiagramKey(lang: string, source: string): Promise<string> {
  const text = `${String(lang || "").trim().toLowerCase()}\u0000${String(source || "").trim()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Render every diagram in MARKDOWN. A diagram that fails to render is left out
 * rather than failing the export; the server reports it as a warning and falls
 * back to the fence's source.
 */
export async function collectExportDiagrams(markdown: string): Promise<ExportDiagram[]> {
  const seen = new Set<string>();
  const collected: ExportDiagram[] = [];
  for (const fence of exportDiagramFences(markdown)) {
    const key = await exportDiagramKey(fence.lang, fence.source);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const svg = await renderDiagramSVG(fence.source, fence.lang, { textLabels: true });
      if (svg) collected.push({ key, lang: fence.lang, svg });
    } catch {
      // Reported by the export, which keeps the source in the document.
    }
  }
  return collected;
}
