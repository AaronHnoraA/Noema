import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  buildAttributeView,
  configure,
} from "../server/lib/index.mjs";
import {
  configureMarkdownFileProvider,
  configurePlanningProvider,
} from "../server/lib/state.mjs";

const count = Math.max(1, Number(process.argv[2]) || 500);
const rounds = Math.max(3, Number(process.argv[3]) || 10);
const workspace = await mkdtemp(join(tmpdir(), "noema-node-planning-benchmark-"));
const notes = join(workspace, "notes");

try {
  await mkdir(notes, { recursive: true });
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const suffix = index.toString(16).padStart(12, "0");
    const source = [
      "---",
      `id: note-${String(index).padStart(3, "0")}`,
      `title: Note ${String(index).padStart(3, "0")}`,
      "tags: planning benchmark",
      "project: Noema",
      "---",
      `# Note ${index}`,
      "",
      `@@todo(doing) [Task ${index}] {id=task-${index}, ddl=tomorrow}`,
      "",
      `Claim ${index} {#0198fc34-7b32-7a11-8cb4-${suffix} status=draft owner=Node}`,
      "",
    ].join("\n");
    await writeFile(join(notes, `note-${String(index).padStart(3, "0")}.md`), source, "utf8");
  }));
  configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });
  configureMarkdownFileProvider(null);
  configurePlanningProvider(null);

  const measure = async () => {
    const started = performance.now();
    const result = await buildAttributeView({ source: "columns: text, status, owner" });
    return { elapsedMs: performance.now() - started, rows: result.rows.length };
  };
  const cold = await measure();
  const samples = [];
  let rows = cold.rows;
  for (let index = 0; index < rounds; index++) {
    const sample = await measure();
    samples.push(sample.elapsedMs);
    rows = sample.rows;
  }
  samples.sort((left, right) => left - right);
  const percentile = (fraction) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
  process.stdout.write(`${JSON.stringify({
    implementation: "legacy-node-walk-stat-read-parse",
    documents: count,
    rows,
    coldMs: cold.elapsedMs,
    warmMinMs: samples[0],
    warmMedianMs: percentile(0.5),
    warmP95Ms: percentile(0.95),
    rounds,
  }, null, 2)}\n`);
} finally {
  configureMarkdownFileProvider(null);
  configurePlanningProvider(null);
  await rm(workspace, { recursive: true, force: true });
}
