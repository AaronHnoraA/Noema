import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segment, shingles } from "../server/lib/headroom-segment.mjs";
import { cutToBudget, excerptRanges } from "../server/lib/research-context-excerpt.mjs";
import { requestTerms } from "../server/lib/research-memory.mjs";
import { createResearchRuntimeService } from "../server/lib/research-runtime.mjs";
import {
  createResearchCell,
  createResearchNotebook,
  setResearchRelation,
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

describe("shingles", () => {
  test("gives three-word windows, and every window of a shorter passage", () => {
    expect([...shingles(["a", "b", "c", "d"])]).toEqual(["a\u0001b\u0001c", "b\u0001c\u0001d"]);
    expect([...shingles(["a", "b"])]).toEqual(["a", "b", "a\u0001b"]);
    expect(shingles([]).size).toBe(0);
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
    // Without the research tools nothing promises a way to read the rest.
    expect(text).not.toContain("full text:");
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

describe("cutToBudget", () => {
  const section = (title: string, body: string) => `## ${title}\n\n${body}`;
  const document = "# Runtime survey\n\n" + filler("intro", 40)
    + section("Scheduling", filler("schedule", 60))
    + section("Leases", "The lease expiry sweep releases a stale lease after ninety seconds without a heartbeat.\n\n"
      + "```js\nconst sweep = () => {\n\n  release(stale);\n};\n```\n\n" + filler("lease", 60))
    + section("Storage", filler("storage", 60))
    + section("Verdict", filler("verdict", 20) + "VERDICT_END");
  const bytes = Buffer.from(document);
  const options = {
    note: "cut", terms: requestTerms("Explain how the lease expiry sweep handles a stale heartbeat."),
    fullText: 'research_cell {action: "read", notebookId: "nb", cellId: "c"}',
  };
  const markers = (text: string) => [...text.matchAll(/\n\n\[Noema: ([^\n]*)\]\n/g)].map((match) => match[1]);

  test("names what each gap skips, where the text resumes and how to read the rest", () => {
    const cut = cutToBudget(bytes, 8192, options);
    const text = cut.bytes.toString();
    expect(cut.bytes.byteLength).toBeLessThanOrEqual(8192);
    expect(cut.bytes.byteLength).toBeGreaterThan(8192 - 256);
    expect(cut.reason).toBe("cut; beginning and end retained, with the passages matching the request");
    const [first, ...later] = markers(text);
    expect(first).toMatch(/^cut; \d+ bytes omitted; continues under: Runtime survey; full text: research_cell \{action: "read", notebookId: "nb", cellId: "c"\}$/);
    expect(later.at(-1)).toMatch(/^\d+ bytes omitted; skipped sections: Storage; continues under: Runtime survey > Storage$/);
    expect(later.every((line) => !line.includes("full text:"))).toBe(true);
    expect(text.startsWith("# Runtime survey")).toBe(true);
    expect(text.endsWith("VERDICT_END")).toBe(true);
  });

  test("keeps a code block whole even across its blank lines", () => {
    const text = cutToBudget(bytes, 8192, options).bytes.toString();
    expect(text).toContain("```js\nconst sweep = () => {\n\n  release(stale);\n};\n```");
    expect((text.match(/^```/gm) || []).length % 2).toBe(0);
  });

  test("moves a cut out of a code block rather than leaving it open", () => {
    const code = "Preface.\n\n```\n" + "let value = compute();\n".repeat(60) + "```\n\n" + filler("after", 200) + "END";
    const text = cutToBudget(Buffer.from(code), 4096, { note: "cut", keepEnd: true }).bytes.toString();
    expect((text.match(/^```/gm) || []).length % 2).toBe(0);
    expect(text.endsWith("END")).toBe(true);
  });

  test("does not keep a passage that repeats the beginning or the end", () => {
    const claim = "The lease expiry sweep releases a stale lease after ninety seconds without a heartbeat.\n\n";
    const repeated = Buffer.from("START\n\n" + claim + filler("early", 150) + claim + filler("late", 150) + "END");
    const cut = cutToBudget(repeated, 8192, options);
    expect(cut.reason).toBe("cut; beginning and end retained");
    expect(cut.bytes.toString().match(/ninety seconds/g)).toHaveLength(1);
  });

  test("keeps the bytes between two passages when a marker would cost more", () => {
    const close = Buffer.from("START\n\n" + filler("early", 150)
      + "The lease expiry sweep is described here.\n\nShort aside.\n\nA stale heartbeat releases the lease.\n\n"
      + filler("late", 150) + "END");
    const text = cutToBudget(close, 8192, options).bytes.toString();
    expect(text).toContain("described here.\n\nShort aside.\n\nA stale heartbeat");
  });

  test("a leading excerpt lists the sections after it; a small one only says how to read on", () => {
    const head = cutToBudget(bytes, 6000, { ...options, keepEnd: false });
    expect(head.reason).toBe("cut");
    expect(markers(head.bytes.toString())).toEqual([expect.stringMatching(/^cut; skipped sections: .*Verdict.*; full text: research_cell/)]);
    const small = cutToBudget(bytes, 1024, options);
    expect(small.bytes.byteLength).toBeLessThanOrEqual(1024);
    expect(markers(small.bytes.toString())).toEqual(['cut; middle omitted; full text: research_cell {action: "read", notebookId: "nb", cellId: "c"}']);
  });
});

test("with the research tools attached, cut and omitted context say how to read the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "noema-excerpt-"));
  try {
    await writeFile(join(root, "noema.toml"), "schema = 1\n[project]\nid = \"0199\"\n");
    let notebook = createResearchNotebook({ title: "Merge", defaultAgent: "codex" });
    const origin = createResearchCell(notebook, { kind: "question", title: "Origin", source: "Why?" });
    notebook = origin.notebook;
    const left = createResearchCell(notebook, { kind: "work", title: "Left", source: "Try left.", lineageParent: origin.workNode.id });
    notebook = left.notebook;
    const right = createResearchCell(notebook, { kind: "work", title: "Right", source: "Try right.", lineageParent: origin.workNode.id });
    notebook = right.notebook;
    for (const node of [left.workNode.id, right.workNode.id]) {
      notebook = upsertResearchRunOutput(notebook, {
        workId: node, runId: `run_${node}`, agent: "codex", status: "completed", content: "x".repeat(30_000),
      }).notebook;
    }
    const merge = createResearchCell(notebook, {
      kind: "work", title: "Merge", source: "@@ctx(file:brief.md)\n\nMerge both routes.", lineageParent: left.workNode.id,
    });
    notebook = setResearchRelation(merge.notebook, merge.workNode.id, "lineage", [left.workNode.id, right.workNode.id]).notebook;
    const file = join(root, "merge.noema");
    await writeResearchNotebookFile(file, notebook, { create: true });
    const provider = { runs: vi.fn(async () => []), prepareRun: vi.fn(async ({ run }) => ({ id: "run_merge", ...run })) };
    const service = createResearchRuntimeService({
      getProvider: () => provider as any, getRuntimeDescriptor: () => ({ mcpUrl: "http://127.0.0.1:1/mcp" }),
    });
    const size = (item: any) => Buffer.from(item.contentBase64, "base64").byteLength;
    const text = (item: any) => Buffer.from(item.contentBase64, "base64").toString();
    const notebookId = (notebook.metadata as any).noema_research.notebook_id;

    await writeFile(join(root, "brief.md"), "b".repeat(50_000));
    const cut = await service.prepareRun({ file, cellId: merge.cell.id, cwd: root });
    const leftItem = cut.contextItems.find((item: any) => item.ref === `result:${left.workNode.id}`);
    expect(text(leftItem)).toContain(`full text: research_cell {action: "read", notebookId: "${notebookId}", cellId: "${left.cell.id}"}`);
    expect(leftItem.fullText).toBeUndefined();

    await writeFile(join(root, "brief.md"), "b".repeat(63_000));
    const tight = await service.prepareRun({ file, cellId: merge.cell.id, cwd: root });
    const note = tight.contextItems.find((item: any) => item.ref === "context-omitted");
    expect(tight.spec.context_omitted.length).toBeGreaterThan(0);
    for (const entry of tight.spec.context_omitted.filter((item: any) => item.full_text)) {
      expect(text(note)).toContain(`- ${entry.ref} (${entry.bytes} bytes): ${entry.full_text}`);
    }
    expect(text(note)).toContain(`research_cell {action: "read", notebookId: "${notebookId}"`);
    expect(tight.spec.context.find((item: any) => item.ref === "context-omitted")).toMatchObject({ automatic: true, truncated: false });
    expect(tight.contextItems.reduce((sum: number, item: any) => sum + size(item), 0)).toBeLessThanOrEqual(64 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a matching heading brings the text it introduces", () => {
  const body = "START\n\n" + filler("early", 150) + "## Lease expiry sweep\n\nStale holders are released after ninety seconds.\n\n"
    + filler("late", 150) + "END";
  const text = cutToBudget(Buffer.from(body), 8192, {
    note: "cut", terms: requestTerms("Explain the lease expiry sweep."),
  }).bytes.toString();
  expect(text).toContain("## Lease expiry sweep\n\nStale holders are released after ninety seconds.");
});
