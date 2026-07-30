import { markdownFromClipboard, markdownFromClipboardParts, normalizePastedSourceText } from "./clipboard.ts";

export type EditorPastePlacement =
  | { kind?: "selection" }
  | { kind: "character"; where: "before" | "after" }
  | { kind: "line"; where: "before" | "after" };

export type StoredPasteAsset = {
  ok?: boolean;
  name?: string;
  type?: string;
  isImage?: boolean;
  markdownPath?: string;
  message?: string;
};

export type EditorPasteAssetStore = {
  uploadBlobAsset?: (
    blob: Blob,
    meta: { file?: string; name?: string; type?: string },
  ) => Promise<StoredPasteAsset>;
  storeAssetFromPath?: (
    path: string,
    meta: { file?: string; name?: string; type?: string },
  ) => Promise<StoredPasteAsset>;
};

export type EditorClipboardPayload =
  | { kind: "empty" }
  | { kind: "text"; text: string; html?: string }
  | { kind: "asset"; asset: StoredPasteAsset }
  | { kind: "assets"; assets: StoredPasteAsset[] };

export type EditorPasteOptions = {
  placement?: EditorPastePlacement;
};

export type EditorPasteContext = {
  currentFile?: () => string;
  assets?: EditorPasteAssetStore;
  readSystemClipboardFallback?: () => Promise<EditorClipboardPayload | null>;
  insertMarkdown: (markdown: string, options?: EditorPasteOptions) => boolean;
};

function markdownLinkText(value: string): string {
  return String(value || "attachment")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function markdownLinkHref(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/[<>\s]/.test(raw)) return `<${raw.replace(/>/g, "%3E")}>`;
  return raw;
}

function assetToMarkdown(asset: StoredPasteAsset): string {
  const path = markdownLinkHref(asset.markdownPath || "");
  if (!path) return "";
  const name = markdownLinkText(asset.name || (asset.isImage ? "image" : "attachment"));
  return asset.isImage ? `![${name}](${path})` : `[${name}](${path})`;
}

function assetListToMarkdown(assets: StoredPasteAsset[]): string {
  return assets.map(assetToMarkdown).filter(Boolean).join("\n");
}

function clipboardFileName(type: string): string {
  const clean = String(type || "").toLowerCase();
  if (clean === "image/jpeg") return "image.jpg";
  if (clean === "image/gif") return "image.gif";
  if (clean === "image/webp") return "image.webp";
  if (clean === "image/svg+xml") return "image.svg";
  return clean.startsWith("image/") ? `image.${clean.slice("image/".length) || "png"}` : "attachment";
}

async function fileToBase64(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

async function uploadBlob(
  context: EditorPasteContext,
  blob: Blob,
  name: string,
): Promise<StoredPasteAsset | null> {
  const upload = context.assets?.uploadBlobAsset;
  if (!upload) return null;
  const type = blob.type || "application/octet-stream";
  const asset = await upload(blob, {
    file: context.currentFile?.() || "",
    name,
    type,
  });
  return asset?.markdownPath ? asset : null;
}

async function pasteStoredAssets(
  context: EditorPasteContext,
  assets: StoredPasteAsset[],
  options?: EditorPasteOptions,
): Promise<boolean> {
  const markdown = assetListToMarkdown(assets);
  return markdown ? context.insertMarkdown(markdown, options) : false;
}

async function pasteFiles(
  files: File[],
  context: EditorPasteContext,
  options?: EditorPasteOptions,
): Promise<boolean> {
  if (files.length === 0 || !context.assets?.uploadBlobAsset) return false;
  const stored: StoredPasteAsset[] = [];
  for (const file of files) {
    const asset = await uploadBlob(context, file, file.name || clipboardFileName(file.type));
    if (asset) stored.push(asset);
  }
  return pasteStoredAssets(context, stored, options);
}

function filesFromDataTransfer(data: DataTransfer): File[] {
  const files = Array.from(data.files || []);
  if (files.length > 0) return files;
  return Array.from(data.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export function pastePlainText(
  text: string,
  context: EditorPasteContext,
  options?: EditorPasteOptions,
): boolean {
  const markdown = normalizePastedSourceText(text);
  return markdown ? context.insertMarkdown(markdown, options) : false;
}

export async function pasteDataTransfer(
  data: DataTransfer,
  context: EditorPasteContext,
  options?: EditorPasteOptions,
): Promise<boolean> {
  const files = filesFromDataTransfer(data);
  if (files.length > 0 && await pasteFiles(files, context, options)) return true;
  const markdown = markdownFromClipboard(data);
  return markdown ? context.insertMarkdown(markdown, options) : false;
}

async function pasteClipboardItems(
  items: ClipboardItem[],
  context: EditorPasteContext,
  options?: EditorPasteOptions,
): Promise<boolean> {
  const stored: StoredPasteAsset[] = [];
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const asset = await uploadBlob(context, blob, clipboardFileName(imageType));
    if (asset) stored.push(asset);
  }
  if (stored.length > 0) return pasteStoredAssets(context, stored, options);

  let html = "";
  let plain = "";
  for (const item of items) {
    if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
    if (!plain && item.types.includes("text/plain")) plain = await (await item.getType("text/plain")).text();
  }
  const markdown = markdownFromClipboardParts(plain, html);
  return markdown ? context.insertMarkdown(markdown, options) : false;
}

async function pasteFallbackPayload(
  payload: EditorClipboardPayload | null,
  context: EditorPasteContext,
  options?: EditorPasteOptions,
): Promise<boolean> {
  if (!payload || payload.kind === "empty") return false;
  if (payload.kind === "text") {
    const markdown = markdownFromClipboardParts(payload.text, payload.html || "");
    return markdown ? context.insertMarkdown(markdown, options) : false;
  }
  if (payload.kind === "asset") return pasteStoredAssets(context, [payload.asset], options);
  return pasteStoredAssets(context, payload.assets, options);
}

export async function pasteFromClipboard(
  context: EditorPasteContext,
  options?: EditorPasteOptions,
): Promise<boolean> {
  if (typeof window !== "undefined" && window.location.protocol === "about:") {
    return false;
  }
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  try {
    if (nav?.clipboard?.read) {
      const items = await nav.clipboard.read();
      if (await pasteClipboardItems(items, context, options)) return true;
    }
  } catch {
    // xwidget/WebKit often denies active Clipboard API reads; use host fallback.
  }

  try {
    if (nav?.clipboard?.readText) {
      const text = await nav.clipboard.readText();
      if (text && pastePlainText(text, context, options)) return true;
    }
  } catch {
    // Fall through to the injected local host fallback.
  }

  try {
    return await pasteFallbackPayload(await context.readSystemClipboardFallback?.() ?? null, context, options);
  } catch {
    return false;
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return fileToBase64(blob);
}
