/** Shared pointer contract for opening rendered and source-backed Markdown links. */

import { primaryModifierDown } from "../platform-compat.ts";

export function markdownLinkPrimaryModifier(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): boolean {
  return primaryModifierDown(event);
}

export function markdownLinkOpensNewWindow(_href: string, event: MouseEvent): boolean {
  return event.button === 1 && markdownLinkPrimaryModifier(event);
}

export function isMarkdownLinkOpenEvent(event: MouseEvent): boolean {
  if (event.shiftKey) return false;
  if (event.button !== 0 && event.button !== 1) return false;
  return markdownLinkPrimaryModifier(event);
}
