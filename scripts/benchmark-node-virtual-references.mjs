#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  clearVirtualReferencesCache,
  virtualReferencesPayload,
} from "../server/lib/virtual-references.mjs";

const documentCount = Math.max(2, Number(process.argv[2]) || 500);
const coldRounds = Math.max(1, Number(process.argv[3]) || 5);
const warmRounds = Math.max(1, Number(process.argv[4]) || 20);
const root = await mkdtemp(join(tmpdir(), "noema-node-virtual-reference-benchmark-"));

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function timed(run) {
  const started = performance.now();
  const result = await run();
  return { elapsedMs: performance.now() - started, result };
}

try {
  const notes = await Promise.all(Array.from({ length: documentCount }, async (_, index) => {
    const id = `note-${String(index).padStart(3, "0")}`;
    const title = `Reference ${String(index).padStart(3, "0")}`;
    const file = join(root, `${id}.md`);
    const body = index === 0
      ? "The target owns itself."
      : "ordinary prose around Reference 000 and Alias 000. ".repeat(32);
    await writeFile(file, `---\nid: ${id}\ntitle: ${title}\naliases: (\"Alias ${String(index).padStart(3, "0")}\")\n---\n# ${title}\n\n${body}\n`, "utf8");
    return {
      id,
      key: id,
      title,
      aliases: [`Alias ${String(index).padStart(3, "0")}`],
      refs: [],
      file,
      path: `${id}.md`,
    };
  }));
  const index = { generation: "benchmark", notes };
  const cold = [];
  let mentionSources = 0;
  for (let round = 0; round < coldRounds; round++) {
    clearVirtualReferencesCache();
    const sample = await timed(() => virtualReferencesPayload(index, { targetId: "note-000" }));
    cold.push(sample.elapsedMs);
    mentionSources = sample.result.mentions.length;
  }
  const warm = [];
  for (let round = 0; round < warmRounds; round++) {
    const sample = await timed(() => virtualReferencesPayload(index, { targetId: "note-000" }));
    warm.push(sample.elapsedMs);
  }
  console.log(JSON.stringify({
    engine: "historical-node-virtual-reference-workspace-scan",
    documentCount,
    coldRounds,
    warmRounds,
    mentionSources,
    coldMs: cold,
    coldMedianMs: percentile(cold, 0.5),
    warmMinMs: Math.min(...warm),
    warmMedianMs: percentile(warm, 0.5),
    warmP95Ms: percentile(warm, 0.95),
  }, null, 2));
} finally {
  clearVirtualReferencesCache();
  await rm(root, { recursive: true, force: true });
}
