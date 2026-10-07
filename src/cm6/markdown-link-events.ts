/** Shared pointer contract for opening rendered and source-backed Markdown links. */

import { primaryModifierDown } from "../platform-compat.ts";

export function markdownLinkPrimaryModifier(event: Pick<MouseEvent, "metaKey" | "ctrlKey">): boolean {
  return primaryModifierDown(event);
}

export function markdownLinkOpensNewWindow(_href: string, event: MouseEvent): boolean {
  return event.button === 1 || (event.shiftKey && markdownLinkPrimaryModifier(event));
}

export function isMarkdownLinkOpenEvent(event: MouseEvent): boolean {
  if (event.button !== 0 && event.button !== 1) return false;
  return event.button === 1 || markdownLinkPrimaryModifier(event);
}
