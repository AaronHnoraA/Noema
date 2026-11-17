/** A stable colour per collaborator, as Google Docs gives each one (C70, C72). */
export function authorColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return `hsl(${hash % 360} 62% 58%)`;
}
