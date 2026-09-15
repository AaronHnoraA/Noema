import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { markdownItems, workItems } from "./snapshot.mjs";

const file = "/example.md";
const fixture = JSON.parse(await readFile(new URL("example.noema", import.meta.url), "utf8"));

test("uses the existing Markdown DSL for todos inside org-env and preserves identity", () => {
  const text = '#+begin theorem Claim\n@@itodo(doing) [Prove it] {id: abc123, due: 2026-09-17, scheduled: 2026-09-15}\n#+end theorem\n';
  const [before] = markdownItems(text, file);
  const [after] = markdownItems("An inserted paragraph\n" + text, file);
  assert.equal(before.id, "#abc123");
  assert.equal(before.status, "doing");
  assert.equal(before.deadline, "2026-09-17");
  assert.equal(before.scheduled, "2026-09-15");
  assert.equal(before.uid, after.uid);
  assert.equal(after.line, before.line + 1);
});

test("keeps positional tasks visibly non-durable and isolates equal IDs across files", () => {
  assert.equal(markdownItems("@@todo [Unanchored]", file)[0].stable, false);
  const source = "@@todo [Task] {id: abc123}";
  assert.notEqual(markdownItems(source, file)[0].uid, markdownItems(source, "/other.md")[0].uid);
});

test("projects WorkNodes once even when multiple cells bind the node", () => {
  const document = structuredClone(fixture);
  const cell = structuredClone(document.cells.find(cell => cell.id === "cell_proof"));
  cell.id = "cell_proof_second";
  document.cells.push(cell);
  const before = JSON.stringify(document);
  const rows = workItems(document, "/research.noema");
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.id === "wn_proof").length, 1);
  assert.equal(rows.find(row => row.id === "wn_proof").cells.length, 2);
  assert.equal(JSON.stringify(document), before);
});

test("lineage does not silently become an execution/task dependency", () => {
  const rows = workItems(fixture, "/research.noema");
  assert.deepEqual(rows.find(row => row.id === "wn_alternative").depends, []);
  assert.deepEqual(rows.find(row => row.id === "wn_alternative").lineage, ["wn_question"]);
  assert.deepEqual(rows.find(row => row.id === "wn_review").depends, ["wn_proof"]);
});

test("AI output containing planning syntax cannot add agenda items", () => {
  const document = structuredClone(fixture);
  document.cells.find(cell => cell.id === "cell_proof").outputs = [{
    output_type: "display_data", metadata: {},
    data: { "text/markdown": "@@todo [Invented task] {sche: 2026-09-15}" },
  }];
  const rows = workItems(document, "/research.noema");
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => !row.title.includes("Invented")));
});

test("invalid research structure is rejected before projection", () => {
  const document = structuredClone(fixture);
  document.metadata.kernelspec = { name: "python3" };
  assert.throws(() => workItems(document, "/research.noema"), /kernel-metadata/);
});
