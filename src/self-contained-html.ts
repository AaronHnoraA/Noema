import { renderPublishedNoteHTML } from "./render-html.ts";

export type SelfContainedHtmlOptions = {
  title: string;
  group?: string;
  date?: string;
  kind?: string;
  themeId?: string;
  alternateThemeId?: string;
  assetResolver?: (src: string) => string;
  document?: Document;
  fetch?: typeof fetch;
  baseUrl?: string;
};

const EMPTY_RESOURCE = "data:application/octet-stream;base64,";
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/giu;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + size));
  }
  return btoa(binary);
}

async function responseDataUrl(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Resource request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
  return `data:${type};base64,${bytesToBase64(bytes)}`;
}

function absoluteResourceUrl(raw: string, baseUrl: string): URL | null {
  const value = raw.trim();
  if (!value || /^(?:data:|#)/iu.test(value)) return null;
  try {
    const url = new URL(value, baseUrl);
    return /^(?:https?:|blob:)$/u.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function collectDocumentStyles(source: Document = document): string {
  const parts: string[] = [];
  for (const sheet of Array.from(source.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules || []);
      if (rules.length) parts.push(rules.map((rule) => rule.cssText).join("\n"));
    } catch {
      // Cross-origin author styles cannot be read safely. They are not copied
      // as links because a self-contained export must have no runtime fetches.
    }
  }
  return parts.join("\n");
}

export async function inlineStylesheetResources(
  css: string,
  options: { baseUrl: string; fetch: typeof fetch },
): Promise<string> {
  const matches = [...String(css || "").matchAll(CSS_URL_RE)];
  const replacements = new Map<string, string>();
  await Promise.all(matches.map(async (match) => {
    const raw = match[2] || "";
    if (replacements.has(raw)) return;
    const url = absoluteResourceUrl(raw, options.baseUrl);
    if (!url) {
      replacements.set(raw, /^(?:data:|#)/iu.test(raw.trim()) ? raw : EMPTY_RESOURCE);
      return;
    }
    try {
      replacements.set(raw, await responseDataUrl(await options.fetch(url.toString(), { cache: "force-cache" })));
    } catch {
      replacements.set(raw, EMPTY_RESOURCE);
    }
  }));
  return String(css || "").replace(CSS_URL_RE, (_all, _quote: string, raw: string) => `url("${replacements.get(raw) || raw}")`);
}

async function inlineDocumentImages(html: string, baseUrl: string, fetcher: typeof fetch): Promise<string> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const images = Array.from(parsed.querySelectorAll<HTMLImageElement>("img[src]"));
  await Promise.all(images.map(async (image) => {
    const raw = image.getAttribute("src") || "";
    if (/^data:/iu.test(raw)) return;
    const url = absoluteResourceUrl(raw, baseUrl);
    if (!url) {
      image.src = EMPTY_IMAGE;
      image.dataset.noemaExportMissing = "true";
      return;
    }
    try {
      image.src = await responseDataUrl(await fetcher(url.toString(), { cache: "force-cache" }));
    } catch {
      image.src = EMPTY_IMAGE;
      image.dataset.noemaExportMissing = "true";
    }
  }));
  for (const source of Array.from(parsed.querySelectorAll<HTMLElement>("source[src], object[data]"))) {
    source.removeAttribute("src");
    source.removeAttribute("data");
    source.dataset.noemaExportMissing = "true";
  }
  return `<!DOCTYPE html>\n${parsed.documentElement.outerHTML}`;
}

export async function createSelfContainedNoteHTML(
  markdown: string,
  options: SelfContainedHtmlOptions,
): Promise<string> {
  const sourceDocument = options.document || document;
  const fetcher = options.fetch || fetch;
  const baseUrl = options.baseUrl || sourceDocument.baseURI || location.href;
  const styles = await inlineStylesheetResources(collectDocumentStyles(sourceDocument), {
    baseUrl,
    fetch: fetcher,
  });
  const html = renderPublishedNoteHTML(markdown, {
    title: options.title,
    group: options.group,
    date: options.date,
    kind: options.kind,
    root: "./",
    assetResolver: options.assetResolver,
    standalone: {
      styles,
      themeId: options.themeId,
      alternateThemeId: options.alternateThemeId,
    },
  });
  return inlineDocumentImages(html, baseUrl, fetcher);
}
