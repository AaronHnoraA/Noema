// Suggestions for files that cannot hold an inline review block (C66).
//
// A Markdown proposal lives in its note as an `ediff` block.  Any other text
// file keeps its pending suggestions beside its Project, one JSON record per
// suggestion under `.agent/collab/suggestions/`, so the file itself is never
// written until the person accepts.  Emacs reads and resolves these records.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findResearchProjectRootOrNull } from "./research-project.mjs";

export const SUGGESTION_DIR = join(".agent", "collab", "suggestions");

const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };

/** Return the 1-based line/0-based UTF-16 column of OFFSET in SOURCE. */
export function lineColumn(source, offset) {
  const before = source.slice(0, offset);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) };
}

/** Record EDITS of FILE as pending suggestions; RESOLVE turns a position into an offset. */
export async function proposeSuggestions({ file, edits, author, resolve }) {
  if (!Array.isArray(edits) || !edits.length) bad("edits must be a non-empty array");
  const root = await findResearchProjectRootOrNull(file);
  if (!root) bad("A suggestion for a file that is not Markdown needs a Noema Project above it (noema.toml with [project])");
  if (relative(root, file).startsWith("..")) bad("The file is outside its Project");
  const source = await readFile(file, "utf8");
  const records = edits.map((edit) => {
    const from = resolve(source, edit.from);
    const to = resolve(source, edit.to);
    if (from === undefined || to === undefined || to < from) bad("Each edit needs an ordered from/to range");
    if (typeof edit.oldText !== "string" || source.slice(from, to) !== edit.oldText)
      bad("oldText differs from the saved source; read it again");
    if (typeof edit.newText !== "string" || edit.newText === edit.oldText) bad("A suggestion must change the text");
    const title = String(edit.title || "Suggested edit").trim();
    if (/[\r\n]/.test(title)) bad("Suggestion title must be one line");
    return {
      id: randomUUID(), file, title, from: lineColumn(source, from), to: lineColumn(source, to),
      oldText: edit.oldText, newText: edit.newText, status: "pending", comments: [],
      ...(author ? { author } : {}), createdAt: new Date().toISOString(),
    };
  });
  const dir = join(root, SUGGESTION_DIR);
  await mkdir(dir, { recursive: true });
  for (const record of records) {
    const target = join(dir, `${record.id}.json`);
    await writeFile(`${target}.tmp`, JSON.stringify(record, null, 2) + "\n");
    await rename(`${target}.tmp`, target);
  }
  return records;
}
