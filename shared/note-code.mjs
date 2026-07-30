export function parseNoteCodeLine(line) {
  const text = String(line ?? "");
  const leading = text.match(/^[ \t]*/)?.[0] ?? "";
  const commandFrom = leading.length;
  const prefix = "@@note-code(";
  if (!text.startsWith(prefix, commandFrom)) return null;
  const tail = /\)[ \t]*\[([^\]\n]+)\][ \t]*$/.exec(text);
  if (!tail || tail.index < commandFrom + prefix.length) return null;
  const path = text.slice(commandFrom + prefix.length, tail.index).trim();
  const id = String(tail[1] ?? "").trim();
  if (!path || !id) return null;
  return { commandFrom, commandTo: text.trimEnd().length, path, id };
}
