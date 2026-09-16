/** Read-only prototype: existing Markdown parser + native WorkNode.agenda.
 * Reads explicitly supplied files only. Never writes a source document.
 */
import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extractTodos } from "../../server/lib/runtime.mjs";
import { canonicalTodoArgs, normalizeDateValue } from "../../shared/planning-values.mjs";
import { validateResearchNotebook } from "../../server/lib/research-notebook.mjs";

function item(kind, file, id, title, status, attrs, extra = {}) {
  const canon = canonicalTodoArgs(attrs);
  return {
    uid: createHash("sha256").update(JSON.stringify([kind, file, id])).digest("hex"),
    kind, file, id, title, status,
    scheduled: normalizeDateValue(canon.sche || "") || "",
    deadline: normalizeDateValue(canon.ddl || "") || "",
    priority: /^[A-F]$/.test(canon.prio || "") ? canon.prio : "D",
    repeat: canon.repeat || "", effort: canon.effort || "",
    project: canon.project || basename(file), ...extra,
  };
}

export function markdownItems(source, file) {
  // This is the real Noema extraction entry point, including its summary mask.
  return extractTodos(source, { file, path: file, title: basename(file), tags: [] }, 0)
    .map(todo => item("markdown-task", file, todo.id, todo.text, todo.status, todo.canon, {
      line: todo.line, index: todo.index, source: todo.source,
      stable: todo.id.startsWith("#"),
    }));
}

export function workItems(document, file) {
  const validation = validateResearchNotebook(document);
  if (validation.errors.length) throw new Error(JSON.stringify(validation.errors));
  const meta = document.metadata.noema_research;
  const states = { open: "todo", active: "doing", waiting: "blocked", done: "done", dropped: "cancelled" };
  // This isolated prototype reads Agenda metadata but never mutates it.
  // Production source adapters and the native UI live under server/ and lisp/.
  return meta.work_nodes.filter(node => node.agenda && typeof node.agenda === "object")
    .map(node => item("work-node", file, node.id, node.title,
      states[node.state || "open"], node.agenda, {
        stable: true, notebookId: meta.notebook_id,
        cells: document.cells.filter(cell => cell.metadata?.noema_research?.work_node_id === node.id).map(cell => cell.id),
        depends: meta.dependencies.filter(edge => edge.type === "depends" && edge.to === node.id).map(edge => edge.from),
        lineage: meta.dependencies.filter(edge => edge.type === "lineage" && edge.to === node.id).map(edge => edge.from),
      }));
}

export async function snapshot(paths) {
  const items = [];
  for (const path of paths) {
    const file = resolve(path);
    const source = await readFile(file, "utf8");
    items.push(...(file.endsWith(".noema") ? workItems(JSON.parse(source), file) : markdownItems(source, file)));
  }
  return { schema: "noema.agenda-poc/1", items };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await snapshot(process.argv.slice(2))) + "\n");
}
