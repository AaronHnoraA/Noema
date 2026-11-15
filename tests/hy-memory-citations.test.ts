// @vitest-environment node
// The read side of the memory citation loop (docs/noema/design/hy-memory.md M5):
// the bridge counts a Project's ledger and drops what is recalled often but never cited.
import { expect, test } from "@voidzero-dev/vite-plus-test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(process.cwd(), "scripts/noema-hy-memory.py");
const run = (code: string) => JSON.parse(execFileSync("python3", ["-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(script)})
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
${code}`], { encoding: "utf8" }));

test("M5 cited memories come first; stale ones are dropped; size stays bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "citations-"));
  mkdirSync(join(root, ".agent/memory"), { recursive: true });
  const events = [...Array(6)].map(() => ({ kind: "recall", ids: ["a", "b", "c"] })).concat([{ kind: "cite", ids: ["c"] }]);
  writeFileSync(join(root, ".agent/memory/citations.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n{torn");
  const result = run(`
counts = bridge.citation_counts(${JSON.stringify(root)})
items = [{"id": i, "content": i.upper() * 10} for i in "abcdef"]
print(json.dumps({"counts": counts, "items": bridge.apply_citations(items, counts),
                  "empty": bridge.citation_counts("/nonexistent"),
                  "big": len(bridge.apply_citations([{"id": str(n), "content": "x" * 1400} for n in range(5)], {}))}))`);
  expect(result.counts).toEqual({ a: [6, 0], b: [6, 0], c: [6, 1] });
  expect(result.items.map((item: any) => [item.id, item.cited])).toEqual([["c", 1], ["d", 0], ["e", 0], ["f", 0]]);
  expect(result.empty).toEqual({});
  expect(result.big).toBe(2);
});
