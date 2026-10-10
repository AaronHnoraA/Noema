import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segment } from "../server/lib/headroom-segment.mjs";
import { excerptRanges } from "../server/lib/research-context-excerpt.mjs";
import { requestTerms } from "../server/lib/research-memory.mjs";
import { createResearchRuntimeService } from "../server/lib/research-runtime.mjs";
import {
  createResearchCell,
  createResearchNotebook,
  upsertResearchRunOutput,
  writeResearchNotebookFile,
} from "../server/lib/research-notebook.mjs";

const filler = (label: string, count: number) => Array.from({ length: count },
  (_, index) => `${label} paragraph ${index} discusses routine bookkeeping without anything notable.\n\n`).join("");

describe("segment", () => {
  test("partitions losslessly at blank lines and keeps indented continuations", () => {
    const text = "first record\n  continued\n\nsecond record\n\n" + "dense\n".repeat(20) + "界".repeat(2000) + "\ntail";
    const parts = segment(text);
    expect(parts.join("")).toBe(text);
    expect(parts[0]).toBe("first record\n  continued\n\n");
    expect(parts[1]).toBe("second record\n\n");
    // A dense block is windowed; one over-long line stays whole.
    expect(parts[2].split("\n")).toHaveLength(9);
    expect(parts).toContain("界".repeat(2000) + "\n");
    expect(segment("")).toEqual([]);
    expect(segment("one line")).toEqual(["one line"]);
  });
});

describe("excerptRanges", () => {
  const passage = "The lease expiry sweep releases a stale lease after ninety seconds without a heartbeat.\n\n";
  const text = "OPENING\n\n" + filler("early", 150) + passage + filler("late", 150) + "CONCLUSION";
  const bytes = Buffer.from(text);
  const terms = requestTerms("Explain how the lease expiry sweep handles a stale heartbeat.");
  const read = (ranges: Array<[number, number]>) => ranges.map(([start, end]) => bytes.subarray(start, end).toString());

  test("keeps the beginning, the end and the passage the request names", () => {
    const ranges = excerptRanges(bytes, 8000, terms, 40)!;
    const kept = read(ranges);
    expect(kept[0].startsWith("OPENING")).toBe(true);
    expect(kept.at(-1)!.endsWith("CONCLUSION")).toBe(true);
    expect(kept.some((part) => part.includes("ninety seconds"))).toBe(true);
    const total = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    expect(total + 40 * (ranges.length - 2)).toBeLessThanOrEqual(8000);
    for (let index = 1; index < ranges.length; index++) expect(ranges[index][0]).toBeGreaterThan(ranges[index - 1][1]);
  });

  test("declines when nothing in between matches, the budget is small or the text is one record", () => {
    expect(excerptRanges(bytes, 8000, requestTerms("Summarize unrelated quantum tensors."), 40)).toBeNull();
    expect(excerptRanges(bytes, 2000, terms, 40)).toBeNull();
    expect(excerptRanges(Buffer.from("L".repeat(30_000)), 8000, terms, 40)).toBeNull();
    expect(excerptRanges(bytes, 8000, ["lease"], 40)).toBeNull();
  });

  test("does not keep a passage for function words or the document's common words", () => {
    expect(requestTerms("When and where does it say which paragraph?")).toEqual(["say", "paragraph"]);
    // "paragraph" and "routine" are in every passage; "interrupted" is in none.
    expect(excerptRanges(bytes, 8000, requestTerms("Which paragraph discusses routine work when interrupted?"), 40)).toBeNull();
  });

  test("cuts Chinese text on character boundaries", () => {
    const chinese = "开头\n\n" + "这一段记录日常事务没有特别之处。\n\n".repeat(400)
      + "租约过期清扫在九十秒没有心跳后释放陈旧租约。\n\n" + "那一段同样记录日常事务。\n\n".repeat(400) + "结论";
    const source = Buffer.from(chinese);
    const ranges = excerptRanges(source, 6000, requestTerms("解释租约过期清扫如何处理心跳"), 40)!;
    const kept = ranges.map(([start, end]) => source.subarray(start, end).toString());
    expect(kept.join("")).not.toContain("�");
    expect(kept.some((part) => part.includes("九十秒"))).toBe(true);
    expect(kept.at(-1)!.endsWith("结论")).toBe(true);
  });
});

test("a cut parent output keeps the passage the work block asks about", async () => {
  const root = await mkdtemp(join(tmpdir(), "noema-excerpt-"));
  try {
    await writeFile(join(root, "noema.toml"), "schema = 1\n[project]\nid = \"0199\"\n");
    let notebook = createResearchNotebook({ title: "Excerpt", defaultAgent: "codex" });
    const parent = createResearchCell(notebook, { kind: "work", title: "Survey", source: "Survey the runtime." });
    notebook = parent.notebook;
    const output = "SURVEY_START\n\n" + filler("early", 300)
      + "The lease expiry sweep releases a stale lease after ninety seconds without a heartbeat.\n\n"
      + filler("late", 300) + "SURVEY_END";
    notebook = upsertResearchRunOutput(notebook, {
      workId: parent.workNode.id, runId: "run_parent", agent: "codex", status: "completed", content: output,
    }).notebook;
    const child = createResearchCell(notebook, {
      kind: "work", title: "Lease", lineageParent: parent.workNode.id,
      source: "@@session(fresh)\n@@ctx(file:brief.md)\n\nExplain how the lease expiry sweep handles a stale heartbeat.",
    });
    const file = join(root, "excerpt.noema");
    await writeResearchNotebookFile(file, child.notebook, { create: true });
    await writeFile(join(root, "brief.md"), "b".repeat(52_000));
    const provider = { runs: vi.fn(async () => []), prepareRun: vi.fn(async ({ run }) => ({ id: "run_child", ...run })) };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });
    const prepared = await service.prepareRun({ file, cellId: child.cell.id, cwd: root });
    const ref = `result:${parent.workNode.id}`;
    const text = Buffer.from(prepared.contextItems.find((item: any) => item.ref === ref).contentBase64, "base64").toString();
    expect(text).toMatch(/^SURVEY_START[\s\S]*bytes omitted\]\n[\s\S]*ninety seconds[\s\S]*bytes omitted\]\n[\s\S]*SURVEY_END$/);
    expect(prepared.spec.context.find((item: any) => item.ref === ref)).toMatchObject({
      truncated: true, source_bytes: Buffer.byteLength(output),
      truncation_reason: expect.stringContaining("passages matching the request"),
    });
    expect(prepared.contextItems.reduce((sum: number, item: any) =>
      sum + Buffer.from(item.contentBase64, "base64").byteLength, 0)).toBeLessThanOrEqual(64 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
