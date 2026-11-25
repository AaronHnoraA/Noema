import type MarkdownIt from "markdown-it";
import { splitDocumentWidgetAttrs } from "../shared/document-widget-title.mjs";
import { documentPages } from "./document-tabs.ts";
import { documentViewSourceKey } from "./document-view.ts";

export const CHAT_TEXT_SELECTOR = ".noema-chat-body pre";
const enabled = (value?: string) => /^(?:true|yes|on|1)$/i.test(value || "");

export function renderDocumentChat(md: MarkdownIt, title: string, body: string, interactive: boolean, plainSources?: Map<string, string[]>): string | null {
  const key = interactive ? documentViewSourceKey("chat", title, body) : "";
  const original = plainSources?.get(key)?.pop() ?? body;
  const { environment, tokens, pages, first } = documentPages(md, "chat", body);
  if (first === undefined || !pages.length) return null;
  const preamble = first ? md.renderer.render(tokens.slice(0, first), md.options, environment) : "";
  const rendered = pages.map((page) => {
    const { title: label, attrs } = splitDocumentWidgetAttrs(page.heading ?? page.label, ["self", "timestamp"]);
    const name = label ? md.renderInline(label, environment) : "";
    if (enabled(attrs.timestamp) && page.content.length === 0) {
      return `<li class="noema-chat-time">${name}</li>`;
    }
    const content = md.renderer.render(page.content, md.options, environment);
    return `<li class="noema-chat-message" data-chat-side="${enabled(attrs.self) ? "self" : "other"}">`
      + (name ? `<div class="noema-chat-author">${name}</div>` : "") + `<div class="noema-chat-body">${content}</div></li>`;
  }).join("");
  const identity = interactive ? ` data-view-kind="chat" data-view-source="${key}"` : "";
  const clipboard = interactive ? '<div class="noema-chat-footer"><button type="button" data-document-source-copy>Copy conversation</button></div>'
    + `<template data-document-source-body>${md.utils.escapeHtml(original ? original + "\n" : "")}</template>` : "";
  return `<div class="noema-document-chat"${identity}>`
    + preamble
    + `<ol class="noema-chat-messages" role="list">${rendered}</ol>` + clipboard + "</div>";
}
