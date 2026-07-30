/** Shared pointer contract for opening rendered and source-backed Markdown links. */

export function markdownLinkPrimaryModifier(event: MouseEvent): boolean {
  if (event.metaKey && !event.ctrlKey) return true;
  return !/Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey;
}

export function markdownLinkOpensNewWindow(_href: string, event: MouseEvent): boolean {
  return event.button === 1 && markdownLinkPrimaryModifier(event);
}

export function isMarkdownLinkOpenEvent(event: MouseEvent): boolean {
  if (event.shiftKey) return false;
  if (event.button !== 0 && event.button !== 1) return false;
  return markdownLinkPrimaryModifier(event);
}
