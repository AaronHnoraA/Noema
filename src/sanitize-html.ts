import DOMPurify from "dompurify";

function neutralizeForbiddenEmbedAttrs(source: string): string {
  return source.replace(/<(iframe|object|embed)\b[^>]*>/gi, (tag) =>
    tag.replace(/\s(?:srcdoc|src|data)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""));
}

// Shared policy for user-authored HTML rendered in the live editor.
// Mirrors the uri allowlist used by paste-html.ts; forbids active/embedding tags.
export function sanitizeEmbeddedHtml(source: string): string {
  return String(DOMPurify.sanitize(neutralizeForbiddenEmbedAttrs(String(source || "")), {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file|zotero|roam|marginnote(?:\d+)?(?:app)?):|[^:]*?(?:[/?#]|$))/i,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
  }));
}
