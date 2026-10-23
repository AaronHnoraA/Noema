function isEscapedAt(text: string, from: number): boolean {
  let slashes = 0;
  for (let index = from - 1; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export function citeNamespaceCompletionPrefix(before: string): string | null {
  const match = before.match(/@@cite\(([^)\n]*)$/i);
  return match && !isEscapedAt(before, match.index ?? -1) ? match[1] ?? "" : null;
}

export function citeNamespaceRenderPrefix(prefix: string): string {
  return `@@cite(${prefix}`;
}

export type CiteKeyCompletionContext = { namespace: string; prefix: string; separator?: string };

export function citeKeyCompletionContext(before: string): CiteKeyCompletionContext | null {
  const match = before.match(/@@cite\(([^)\n]+)\)([ \t]*)\[([^\]\n]*)$/i);
  if (!match || isEscapedAt(before, match.index ?? -1)) return null;
  const keys = match[3] ?? "";
  return {
    namespace: (match[1] ?? "").trim(),
    separator: match[2] ?? "",
    prefix: keys.split(";").at(-1)?.trimStart() ?? "",
  };
}

export function citeKeyRenderPrefix(context: CiteKeyCompletionContext): string {
  return `@@cite(${context.namespace})${context.separator ?? " "}[${context.prefix}`;
}
