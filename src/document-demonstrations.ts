import type MarkdownIt from "markdown-it";
import { layoutFromAttrs, type AttrMap } from "../shared/layout-attrs.mjs";
import { documentViewSourceKey } from "./document-view.ts";

export const documentDemonstrationKinds = new Set(["demo", "window"]);

export function renderDocumentDemonstration(md: MarkdownIt, kind: string, title: string, body: string, attrs: AttrMap, interactive: boolean, plainSources?: Map<string, string[]>): string {
  const source = kind === "demo" && interactive ? documentViewSourceKey(kind, title, body) : "";
  const original = plainSources?.get(source)?.pop() ?? body;
  const markup = md.render(body);
  const enabled = (value?: string) => /^(?:true|yes|on|1)$/i.test(value || "");
  if (kind === "window") {
    const length = (value = "") => /^\d+(?:\.\d+)?lh$/.test(value) ? value : layoutFromAttrs({ width: value }).width;
    const height = length(attrs.height);
    const gap = length(attrs.gap);
    const styles = [height && `--document-window-height:${height}`, gap && `--document-window-gap:${gap}`].filter(Boolean).join(";");
    return `<div class="noema-document-window" data-window-padding="${!enabled(attrs["no-padding"])}"${styles ? ` style="${styles}"` : ""}>`
      + `<div class="noema-window-body"${height ? ' tabindex="0" role="region" aria-label="Window content"' : ""}>${markup}</div></div>`;
  }
  const preview = `<div class="noema-demo-preview">${markup}</div>`;
  if (!interactive) return `<div class="noema-document-demo">${preview}</div>`;
  const sourceOpen = enabled(attrs.open);
  return `<div class="noema-document-demo" data-view-kind="demo" data-view-source="${source}" data-demo-open="${sourceOpen}">${preview}`
    + '<div class="noema-demo-footer"><button type="button" data-demo-toggle>Source</button>'
    + '<button type="button" data-demo-copy>Copy source</button></div><div class="noema-demo-source"></div>'
    + `<template data-demo-fallback>${md.utils.escapeHtml(original ? original + "\n" : "")}</template></div>`;
}
