const SAFE_PROTOCOLS = new Set(["http", "https", "mailto", "tel", "file", "zotero", "roam"]);
const MARGINNOTE_PROTOCOL = /^marginnote(?:\d+)?(?:app)?$/i;

export function hrefProtocol(href: string): string | null {
  return href.trim().match(/^([A-Za-z][\w+.-]*):/)?.[1]?.toLowerCase() ?? null;
}

export function safeHref(href: string): boolean {
  const raw = String(href || "").trim();
  if (!raw) return true;
  if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return true;
  const protocol = hrefProtocol(raw);
  if (!protocol) return true;
  return SAFE_PROTOCOLS.has(protocol) || MARGINNOTE_PROTOCOL.test(protocol);
}

export function domHref(href: string): string | null {
  const raw = String(href || "").trim();
  return safeHref(raw) ? raw : null;
}
