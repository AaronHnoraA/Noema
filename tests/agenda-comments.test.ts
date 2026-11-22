import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Node source module
import { commentAnchorLines, commentPatchAction, commentTitle, commentTodos } from "../server/lib/agenda-comments.mjs";
// @ts-ignore Node source module
import { createAgendaIndex } from "../server/lib/agenda-index.mjs";
// @ts-ignore Node source module
import { agendaMarkdownDocument, buildAgendaFromPlanning, configure, extractPlanningItems } from "../server/lib/runtime.mjs";
// @ts-ignore Node source module
import { listThreads } from "../server/lib/note-comments.mjs";

const note = { file: "/n/a.md", path: "a.md", key: "/n/a.md", id: "", title: "a.md", project: "", tags: [] };
const thread = (id: string, text: string, extra: any = {}) => ({
  id, note: "a.md", quote: "the bound", status: "open", createdAt: "2026-11-17T08:00:00.000Z",
  messages: [{ mid: "m0", author: { name: "You", kind: "person" }, text, at: "2026-11-17T08:00:00.000Z" }], ...extra,
});

describe("C77 comments are Agenda tasks", () => {
  test("C77 an open thread is a todo with the DSL attributes it ends with", () => {
    const [todo, ...rest] = commentTodos("/n/a.md", [
      thread("c-aaaa1", "Prove [the] bound {ddl: 2026-11-20, prio: A}\nmore"),
      thread("c-bbbb2", "done already", { status: "resolved" }),
    ], { extract: extractPlanningItems, note, lines: { "c-aaaa1": 7 } });
    expect(rest).toEqual([]);
    expect(todo).toMatchObject({ id: "#c-aaaa1", commentId: "c-aaaa1", sourceKind: "comment", text: "Prove (the) bound",
      status: "todo", line: 7, quote: "the bound" });
    expect(todo.canon).toMatchObject({ ddl: "2026-11-20", prio: "A" });
    expect(todo.inlineTags).toContain("comment");
  });

  test("C77 titles and anchor lines", () => {
    expect(commentTitle("Fix it")).toEqual({ title: "Fix it", attrs: "" });
    expect(commentTitle("Fix {prio: B}")).toEqual({ title: "Fix", attrs: "{prio: B}" });
    expect(commentAnchorLines("a\nb {==x==}{>>#c-1234<<}\n\n{==y==}{>>#c-5678<<}")).toEqual({ "c-1234": 2, "c-5678": 4 });
  });

  test("C81 an archived task and an agent's question stay out of the agenda", () => {
    const todos = commentTodos("/n/a.md", [
      thread("c-aaaa1", "A task"),
      thread("c-bbbb2", "Archived", { archived: true }),
      thread("c-cccc3", "A question for the author", { author: { name: "Agent", kind: "agent" } }),
    ], { extract: extractPlanningItems, note });
    expect(todos.map((item: any) => item.commentId)).toEqual(["c-aaaa1"]);
  });

  test("C77 done resolves, todo reopens, other patches are refused", () => {
    expect(commentPatchAction({ status: "done" })).toBe("resolve");
    expect(commentPatchAction({ op: "complete" })).toBe("resolve");
    expect(commentPatchAction({ status: "todo" })).toBe("reopen");
    expect(() => commentPatchAction({ ddl: "2026-11-20" })).toThrow(/comment/);
  });

  test("C77 the index lists a note's comments and forgets them once resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-agenda-comments-"));
    configure({ root, workspaceRoot: root, stateRoot: join(root, ".state"), tmpRoot: join(root, ".tmp") });
    const journal = join(root, ".noema-comments.jsonl");
    const line = (event: any) => JSON.stringify({ v: 1, at: "2026-11-17T08:00:00.000Z", ...event }) + "\n";
    await writeFile(join(root, "a.md"), "# A\n\nThe {==bound==}{>>#c-aaaa1<<} here.\n");
    await writeFile(journal, line({ op: "thread", id: "c-aaaa1", note: "a.md", quote: "bound", author: { name: "You" }, text: "Prove it {prio: A}" }));
    const service = createAgendaIndex({
      knowledgeRoot: root, watch: null, now: () => new Date(2026, 10, 18, 12).getTime(),
      parseDocument: async (doc: any) => ({ ...(await agendaMarkdownDocument(doc)), commentLines: commentAnchorLines(doc.content), commentNote: { ...note, file: doc.file } }),
      evaluate: (planning: any, body: any, options: any) => buildAgendaFromPlanning(planning, body, { ...options, requireKernel: false }),
      comments: async (file: string, planning: any) => commentTodos(file, await listThreads(file), { extract: extractPlanningItems, note: planning.commentNote, lines: planning.commentLines }),
    });
    try {
      const first = await service.query({ includePlanning: true });
      const todo = first.todos.find((item: any) => item.sourceKind === "comment");
      expect(todo).toMatchObject({ text: "Prove it", line: 3 });
      expect(todo.sourceRef.revision).toBe(todo.sourceRevision);
      await writeFile(journal, line({ op: "thread", id: "c-aaaa1", note: "a.md", quote: "bound", author: { name: "You" }, text: "Prove it {prio: A}" })
        + line({ op: "resolve", id: "c-aaaa1", at: "2026-11-17T09:00:00.000Z" }));
      service.invalidate([join(root, "a.md")]);
      const second = await service.query({ includePlanning: true });
      expect(second.todos.filter((item: any) => item.sourceKind === "comment")).toEqual([]);
    } finally { service.close(); await rm(root, { recursive: true, force: true }); }
  });
});
