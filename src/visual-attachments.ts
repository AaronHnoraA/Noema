export type VisualAttachmentKind = "drawio" | "html";

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

export function visualAttachmentKind(src: string, type = ""): VisualAttachmentKind | null {
  const lowerType = String(type || "").toLowerCase();
  const path = withoutUrlSuffix(src);
  if (!path && !lowerType) return null;
  if (src && !safeVisualSourceP(src)) return null;
  if (imageAttachmentP(path, lowerType)) return null;
  if (DRAWIO_EXT_RE.test(path) || lowerType.includes("jgraph") || lowerType.includes("drawio")) return "drawio";
  if (HTML_EXT_RE.test(path) || lowerType === "text/html" || lowerType.startsWith("text/html;")) return "html";
  return null;
}

export function visualAttachmentEmbeddableP(kind: VisualAttachmentKind, resolvedSrc: string): boolean {
  void kind;
  void resolvedSrc;
  return true;
}

export function visualMarkdownAttachmentP(name: string, type = ""): boolean {
  return imageAttachmentP(name, type) || visualAttachmentKind(name, type) !== null;
}

export function visualAttachmentTitle(kind: VisualAttachmentKind, alt = ""): string {
  const prefix = kind === "drawio" ? "draw.io diagram" : "HTML document";
  const label = String(alt || "").trim();
  return label ? `${prefix}: ${label}` : prefix;
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

function visualAttachmentLocalFrameSrc(kind: VisualAttachmentKind, resolvedSrc: string): string {
  const url = new URL(`aaronnote-asset://visual-frame/${kind}`);
  url.searchParams.set("src", resolvedSrc);
  return url.toString();
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

function frameBaseStyle(): string {
  return [
    "html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff;color:#1f2937;",
    "font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    "body{position:relative}",
    "iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff}",
    ".status{position:absolute;inset:0;z-index:2;box-sizing:border-box;display:grid;place-items:center;padding:18px;text-align:center;color:#6b7280;background:#fff}",
    ".status.error{color:#9f1239;background:#fff7f7}",
    ".status a{color:#1d4ed8}",
  ].join("");
}

function scriptString(value: string): string {
  return JSON.stringify(String(value ?? ""))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function drawioSrcdoc(src: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${frameBaseStyle()}</style></head>
<body>
<div id="status" class="status">Loading draw.io diagram...</div>
<iframe id="drawio-frame" title="draw.io diagram" allow="fullscreen; clipboard-read; clipboard-write" src="https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=min&libraries=1&noSaveBtn=1&noExitBtn=1"></iframe>
<script>
(function () {
  var source = ${scriptString(src)};
  var statusEl = document.getElementById("status");
  var frame = document.getElementById("drawio-frame");
  var xml = "";
  function status(message, failed) {
    statusEl.hidden = false;
    statusEl.className = failed ? "status error" : "status";
    statusEl.textContent = message;
    if (failed) {
      statusEl.appendChild(document.createElement("br"));
      var link = document.createElement("a");
      link.href = source;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open file";
      statusEl.appendChild(link);
    }
  }
  function sendLoad() {
    if (!xml || !frame.contentWindow) return;
    frame.contentWindow.postMessage(JSON.stringify({
      action: "load",
      autosave: 0,
      modified: 0,
      title: "draw.io diagram",
      xml: xml
    }), "*");
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    try {
      if (typeof data === "string" && data.charAt(0) === "{") data = JSON.parse(data);
    } catch (err) {}
    if (data === "ready" || data && data.event === "init") sendLoad();
    if (data && data.event === "load") statusEl.hidden = true;
  });
  fetch(source).then(function (response) {
    if (!response.ok) throw new Error(response.status + " " + response.statusText);
    return response.text();
  }).then(function (text) {
    xml = text;
    sendLoad();
  }).catch(function (err) {
    status("Could not load draw.io file: " + (err && err.message ? err.message : err), true);
  });
}());
</script>
</body>
</html>`;
}

export function visualAttachmentFrame(kind: VisualAttachmentKind, resolvedSrc: string): VisualAttachmentFrame {
  if (kind === "html") return { kind, mode: "src", src: resolvedSrc };
  const media = aaronnoteMediaSource(resolvedSrc);
  if (media) {
    const frameSrc = visualAttachmentLocalFrameSrc(kind, media.mediaUrl);
    return {
      kind,
      mode: "src",
      src: media.proxyUrl ? proxiedAaronnoteAssetUrl(media.proxyUrl, frameSrc) : frameSrc,
    };
  }
  return { kind, mode: "srcdoc", srcdoc: drawioSrcdoc(resolvedSrc) };
}
