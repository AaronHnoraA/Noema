import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initWikiRepository, createWikiPage, buildWikiIndex, wikiDatabaseFile } from "../../server/lib/wiki-workspace.mjs";
const root = await mkdtemp(join(tmpdir(), "wiki-db-fixture-"));
await initWikiRepository(root, "private", "math");
await initWikiRepository(root, "public", "notes");
const group = await createWikiPage(root, "wiki", { title: "Group", repositoryId: "private/math", filename: "group.md" });
const ring = await createWikiPage(root, "wiki", { title: "Ring", repositoryId: "private/math", filename: "ring.md" });
const pub = await createWikiPage(root, "wiki", { title: "群论笔记", repositoryId: "public/notes", filename: "qun.md" });
await writeFile(group.file, (await readFile(group.file, "utf8")) + "\nSee [[Ring]] and [[Field]]. {#grp-def}\n\n![fig](images/missing.png)\n");
await writeFile(ring.file, (await readFile(ring.file, "utf8")) + "\n#+begin theorem Unit {#thm-unit}\nBody\n#+end theorem\n\n[[Group#grp-def]] [[roam://" + group.id + "]] [[notes:群论笔记]]\n");
await writeFile(pub.file, (await readFile(pub.file, "utf8")) + "\n群的定义与性质。[[Group]]\n");
const index = await buildWikiIndex(root, { layout: "wiki", mode: "full" });
const db = new DatabaseSync(wikiDatabaseFile(root), { readOnly: true });
const tables = {};
for (const t of ["repositories", "files", "pages", "blocks", "aliases", "tags", "links", "dependencies", "diagnostics", "page_bigrams"]) {
  tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
}
tables.pages_fts = db.prepare("SELECT page_key, title, aliases, tags, path, body FROM pages_fts").all();
tables.user_version = db.prepare("PRAGMA user_version").get().user_version;
db.close();
const strip = (v) => JSON.parse(JSON.stringify(v).split(root).join("$ROOT"));
const pick = {
  repositories: index.repositories, files: index.files, diagnostics: index.diagnostics, generation: index.generation,
  // The body Node indexed for search, which the builder reads from the file.
  notes: index.notes.map((n) => ({ ...n, searchText: tables.pages_fts.find((row) => row.page_key === (n.pageKey || n.key))?.body ?? "" })),
};
await writeFile(new URL("../../shared/wiki-db-fixtures.json", import.meta.url), JSON.stringify(strip({ version: 1, index: pick, tables }), null, 1) + "\n");
console.log(Object.keys(index.notes[0]).join(","));
console.log(Object.keys(index.repositories[0]).join(","));
console.log(Object.keys(index.files[0]).join(","));
for (const [t, rows] of Object.entries(tables)) console.log(t, Array.isArray(rows) ? rows.length : rows);
