import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { renderSVG } from "uqr";
import type { AttrMap } from "../shared/layout-attrs.mjs";
import { splitDocumentWidgetTitle } from "../shared/document-widget-title.mjs";

// Version 40 at level L fits at most 7,089 digits. Avoid allocating an
// encoder buffer at all for input beyond even that most compact case.
const maxPayloadLength = 7_089;

export function documentQrHasText(kind: string, rawTitle: string): boolean {
  return kind === "qrcode" && Boolean(splitDocumentWidgetTitle(kind, rawTitle).attrs.text?.trim());
}

export function documentQrFence(md: MarkdownIt, body: string): Token | undefined {
  const tokens: Token[] = [];
  md.block.parse(body, md, {}, tokens);
  const fence = tokens[0];
  if (tokens.length !== 1 || fence?.type !== "fence" || !fence.map || !["", "text"].includes(fence.info.trim())) return;
  const lines = body.split("\n");
  if (lines.slice(0, fence.map[0]).some((line) => line.trim())
      || lines.slice(fence.map[1]).some((line) => line.trim())) return;
  return fence;
}

export function renderDocumentQrcode(md: MarkdownIt, body: string, attrs: AttrMap): string | null {
  let payload = attrs.text || "";
  let description = "";
  if (payload.trim()) {
    description = body.trim() ? md.render(body) : "";
  } else {
    const fence = documentQrFence(md, body);
    if (!fence) return null;
    payload = fence.content.replace(/\n$/u, "");
    if (!payload.trim()) return null;
  }

  let symbol = "";
  let message = "Text is too long for a QR code.";
  if (payload.length <= maxPayloadLength) {
    let size = 0;
    try {
      const svg = renderSVG(payload, { border: 4, pixelSize: 1, boostEcc: true, onEncoded: (code) => { size = code.size; } });
      const dimension = Math.max(144, size * 3);
      symbol = svg.replace("<svg ", `<svg class="noema-qr-symbol" width="${dimension}" height="${dimension}" aria-hidden="true" shape-rendering="crispEdges" `);
    } catch (error) {
      if (!(error instanceof RangeError)) message = "This text could not be encoded as a QR code.";
    }
  }
  return `<figure class="noema-document-qr"${symbol ? "" : ' data-qr-unavailable="true"'}>${symbol}`
    + `<figcaption>${description}${symbol ? "" : `<div class="noema-qr-message">${message}</div>`}`
    + `<div class="noema-qr-value">${md.utils.escapeHtml(payload)}</div></figcaption></figure>`;
}
