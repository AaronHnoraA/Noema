// The ways an agent can address a change (C74), resolved against the text it
// will change.  Every form ends as {from, to, oldText, newText} on that text:
//
//   {oldText, newText}               OLD must occur exactly once (add context)
//   {from, to, oldText, newText}     positions; stale ones fall back to OLD
//   {lines: [A, B], newText}         1-based inclusive lines (oldText optional guard)
//   {after | before: TEXT, newText}  next to the one line containing TEXT
//   {append: TEXT}                   at the end
//
// An edit that names its text rather than its offsets lands on the latest
// version even when the person typed meanwhile, which is what lets an agent
// work without waiting.

const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };

/** Past these a change is the person's to look at in the agent's session. */
export const LARGE_CHANGE = { lines: 300, fraction: 0.7, minLines: 60 };

function occurrences(source, text) {
  const found = [];
  if (!text) return found;
  for (let at = source.indexOf(text); at >= 0 && found.length < 3; at = source.indexOf(text, at + 1)) found.push(at);
  return found;
}

function unique(source, text, what) {
  const found = occurrences(source, text);
  if (!found.length) bad(`${what} is not in the current text; read it again`);
  if (found.length > 1) bad(`${what} occurs more than once; include more surrounding text`);
  return found[0];
}

function lineStart(source, line) {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = source.indexOf("\n", at);
    if (next < 0) bad(`Line ${line} is outside the text`);
    at = next + 1;
  }
  return at;
}

const lineEndAfter = (source, at) => { const end = source.indexOf("\n", at); return end < 0 ? source.length : end + 1; };
const withNewline = (text) => (text.endsWith("\n") ? text : `${text}\n`);

/** Resolve EDITS on SOURCE; POSITION turns {line,column} or an offset into an offset. */
export function resolveEdits(source, edits, position) {
  if (!Array.isArray(edits) || !edits.length) bad("edits must be a non-empty array");
  return edits.map((edit) => {
    if (!edit || typeof edit !== "object") bad("Each edit is an object");
    if (edit.append !== undefined) {
      if (typeof edit.append !== "string") bad("append must be text");
      const insert = (source && !source.endsWith("\n") ? "\n" : "") + edit.append;
      return { from: source.length, to: source.length, oldText: "", newText: insert };
    }
    if (typeof edit.newText !== "string") bad("newText must be a string");
    if (edit.after !== undefined || edit.before !== undefined) {
      const marker = String(edit.after ?? edit.before);
      const at = unique(source, marker, "The after/before text");
      const start = source.lastIndexOf("\n", at - 1) + 1;
      const offset = edit.after !== undefined ? lineEndAfter(source, at) : start;
      const prefix = edit.after !== undefined && offset === source.length && !source.endsWith("\n") ? "\n" : "";
      return { from: offset, to: offset, oldText: "", newText: prefix + withNewline(edit.newText) };
    }
    if (Array.isArray(edit.lines)) {
      const [a, b] = edit.lines;
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) bad("lines is [first, last], 1-based");
      const from = lineStart(source, a);
      const to = lineEndAfter(source, lineStart(source, b));
      const oldText = source.slice(from, to);
      if (typeof edit.oldText === "string" && edit.oldText !== oldText && edit.oldText !== oldText.replace(/\n$/, ""))
        bad("oldText differs from those lines; read them again");
      const newText = edit.newText === "" || edit.newText.endsWith("\n") || to === source.length && !oldText.endsWith("\n")
        ? edit.newText : `${edit.newText}\n`;
      return { from, to, oldText, newText };
    }
    if (typeof edit.oldText !== "string") bad("Each edit needs oldText (or lines, after, before or append)");
    if (edit.from !== undefined && edit.to !== undefined) {
      const from = position(source, edit.from), to = position(source, edit.to);
      if (to >= from && source.slice(from, to) === edit.oldText) return { from, to, oldText: edit.oldText, newText: edit.newText };
      // Stale positions: the person typed meanwhile.  The text still says where.
    }
    if (!edit.oldText) bad("An empty oldText needs positions, lines, after, before or append");
    const from = unique(source, edit.oldText, "oldText");
    return { from, to: from + edit.oldText.length, oldText: edit.oldText, newText: edit.newText };
  });
}

/** Whether turning BEFORE into AFTER changes more than an agent should do unasked. */
export function largeChange(before, after, changedLines) {
  const total = Math.max(before.split("\n").length, after.split("\n").length);
  return changedLines > LARGE_CHANGE.lines
    || total >= LARGE_CHANGE.minLines && changedLines / total > LARGE_CHANGE.fraction;
}
