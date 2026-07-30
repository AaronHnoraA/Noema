export function markdownLinkDestination(raw: string): string {
  let value = String(raw || "").trim();
  value = value
    .replace(/\s+"(?:\\.|[^"\\])*"\s*$/, "")
    .replace(/\s+'(?:\\.|[^'\\])*'\s*$/, "")
    .replace(/\s+\((?:\\.|[^)\\])*\)\s*$/, "")
    .trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }
  return value;
}
