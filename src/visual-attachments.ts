export type VisualAttachmentKind = "html";

export type VisualAttachmentFrame =
  | { kind: VisualAttachmentKind; mode: "src"; src: string }
  | { kind: VisualAttachmentKind; mode: "srcdoc"; srcdoc: string };

export const VISUAL_ATTACHMENT_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";
export const HTML_ATTACHMENT_IFRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-downloads";
export const VISUAL_ATTACHMENT_IFRAME_ALLOW =
  "fullscreen; clipboard-read; clipboard-write";

const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const DRAWIO_EXT_RE = /\.(?:drawio|dio)(?:\.xml)?$/i;
const HTML_EXT_RE = /\.html?$/i;

function comparableAssetPath(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://aaronnote.local/");
    return url.searchParams.get("file") || url.pathname || raw;
  } catch {
    return raw;
  }
}

function withoutUrlSuffix(value: string): string {
  return comparableAssetPath(value).split(/[?#]/, 1)[0] || "";
}

function safeVisualSourceP(src: string): boolean {
  const raw = String(src || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw, "https://aaronnote.local/");
    return !["javascript:", "data:", "vbscript:"].includes(url.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function imageAttachmentP(name: string, type = ""): boolean {
  if (String(type || "").toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(withoutUrlSuffix(name));
}

/**
 * A `.drawio` file referenced with image syntax. It renders as a picture, not
 * as an editor: the host exports the file to SVG once and Noema shows that SVG
 * the way GitHub shows a committed `.drawio.svg`. Editing happens in the real
 * draw.io application, as in org-drawio.
 */
export function drawioAttachmentP(src: string, type = ""): boolean {
  const lowerType = String(type || "").toLowerCase();
  const path = withoutUrlSuffix(src);
  if (!path && !lowerType) return false;
  if (src && !safeVisualSourceP(src)) return false;
  if (imageAttachmentP(path, lowerType)) return false;
  return DRAWIO_EXT_RE.test(path) || lowerType.includes("jgraph") || lowerType.includes("drawio");
}

export function visualAttachmentKind(src: string, type = ""): VisualAttachmentKind | null {
  const lowerType = String(type || "").toLowerCase();
  const path = withoutUrlSuffix(src);
  if (!path && !lowerType) return null;
  if (src && !safeVisualSourceP(src)) return null;
  if (imageAttachmentP(path, lowerType)) return null;
  if (HTML_EXT_RE.test(path) || lowerType === "text/html" || lowerType.startsWith("text/html;")) return "html";
  return null;
}

export function visualAttachmentEmbeddableP(kind: VisualAttachmentKind, resolvedSrc: string): boolean {
  void kind;
  void resolvedSrc;
  return true;
}

export function visualMarkdownAttachmentP(name: string, type = ""): boolean {
  return imageAttachmentP(name, type)
    || drawioAttachmentP(name, type)
    || visualAttachmentKind(name, type) !== null;
}

export function visualAttachmentTitle(kind: VisualAttachmentKind, alt = ""): string {
  void kind;
  const label = String(alt || "").trim();
  return label ? `HTML document: ${label}` : "HTML document";
}

export function drawioAttachmentTitle(alt = ""): string {
  const label = String(alt || "").trim();
  return label ? `draw.io diagram: ${label}` : "draw.io diagram";
}

export function visualAttachmentSandbox(kind: VisualAttachmentKind): string {
  return kind === "html" ? HTML_ATTACHMENT_IFRAME_SANDBOX : VISUAL_ATTACHMENT_IFRAME_SANDBOX;
}

function aaronnoteMediaUrlP(src: string): boolean {
  try {
    const url = new URL(String(src || ""));
    return url.protocol === "aaronnote-asset:" && url.hostname === "media";
  } catch {
    return false;
  }
}

function aaronnoteAssetProxyUrlP(url: URL): boolean {
  return /(?:^|\/)aaronnote-asset$/.test(url.pathname) && Boolean(url.searchParams.get("url"));
}

function aaronnoteMediaSource(src: string): { mediaUrl: string; proxyUrl: string } | null {
  const raw = String(src || "").trim();
  if (!raw) return null;
  if (aaronnoteMediaUrlP(raw)) return { mediaUrl: raw, proxyUrl: "" };

  try {
    const url = new URL(raw, "https://aaronnote.local");
    if (!aaronnoteAssetProxyUrlP(url)) return null;
    const proxied = url.searchParams.get("url") || "";
    if (!aaronnoteMediaUrlP(proxied)) return null;
    return { mediaUrl: proxied, proxyUrl: raw };
  } catch {
    return null;
  }
}

function proxiedAaronnoteAssetUrl(proxyUrl: string, assetUrl: string): string {
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(proxyUrl);
  const url = new URL(proxyUrl, "https://aaronnote.local");
  url.search = "";
  url.hash = "";
  url.searchParams.set("url", assetUrl);
  if (absolute) return url.toString();
  return `${url.pathname}${url.search}`;
}

/**
 * `![Fig](diagram.drawio#page=2)` picks a page, the way org-drawio's
 * `#+drawio: diagram.drawio :page 1` does. The page marker is ours, so it is
 * split off before the path reaches the asset resolver.
 */
export function splitDrawioSource(src: string): { path: string; page: number } {
  const raw = String(src || "").trim();
  const match = raw.match(/[?#]page=(\d+)\s*$/i);
  if (!match) return { path: raw, page: 0 };
  return { path: raw.slice(0, match.index).trim(), page: Math.max(0, Number(match[1]) - 1) };
}

/**
 * The URL that serves a `.drawio` file as SVG. Only a Noema asset can be
 * exported, because exporting runs on the host that owns the file; anything
 * else (an `http:` diagram, say) has no exporter and falls back to a card.
 */
export function drawioImageSrc(resolvedSrc: string, page = 0): string | null {
  const media = aaronnoteMediaSource(resolvedSrc);
  if (!media) return null;
  const url = new URL("aaronnote-asset://drawio-svg/");
  url.searchParams.set("src", media.mediaUrl);
  if (page > 0) url.searchParams.set("page", String(page));
  const exportUrl = url.toString();
  return media.proxyUrl ? proxiedAaronnoteAssetUrl(media.proxyUrl, exportUrl) : exportUrl;
}

export function visualAttachmentFrame(kind: VisualAttachmentKind, resolvedSrc: string): VisualAttachmentFrame {
  return { kind, mode: "src", src: resolvedSrc };
}

export type MediaPlayerKind = "video" | "audio";

/**
 * `![caption](clip.mp4)` and `![](talk.mp3)` play inline, as files.md and
 * Marker render media written with image syntax. The extension of the path
 * (before any query or fragment) decides; everything else stays an image.
 */
export function mediaPlayerKind(src: string): MediaPlayerKind | null {
  const path = String(src || "").split(/[?#]/u, 1)[0] ?? "";
  if (/\.(?:mp4|m4v|webm|mov|ogv)$/iu.test(path)) return "video";
  if (/\.(?:mp3|m4a|aac|oga|ogg|opus|wav|weba|flac)$/iu.test(path)) return "audio";
  return null;
}
