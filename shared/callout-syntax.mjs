const labels = new Map([["faq", "FAQ"], ["todo", "To do"]]);

export function parseQuotedCallout(line) {
  const match = /^\[!([\w-]+)\]([+-])?(?:[ \t]+(.*))?$/.exec(line.trimEnd());
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const custom = match[3]?.trim() || "";
  return { kind, fold: match[2] || "", title: custom || labels.get(kind) || kind[0].toUpperCase() + kind.slice(1) };
}
