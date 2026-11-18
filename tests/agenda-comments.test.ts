import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Node source module
import { commentPatchDone, commentStatusEdit, commentTitle, commentTodos } from "../server/lib/agenda-comments.mjs";
// @ts-ignore Node source module
import { createAgendaIndex } from "../server/lib/agenda-index.mjs";
// @ts-ignore Node source module
import { agendaMarkdownDocument, buildAgendaFromPlanning, configure, extractPlanningItems } from "../server/lib/runtime.mjs";

const note = { file: "/n/a.md", path: "a.md", key: "/n/a.md", id: "", title: "a.md", project: "", tags: [] };
const source = "# A\n\nThe bound @@comment [Prove [it] {ddl: 2026-11-20; prio: A}] {id: k3x9qa} holds.\n"
  + "Done @@comment(done) [old] {id: ab12cd}\nLegacy @@comment [use clearer def]\n";

describe("C77 side comments are Agenda tasks (C79)", () => {
  test("C77 open side comments are todos with the DSL attributes they end with", () => {
    const todos = commentTodos(source, { extract: extractPlanningItems, note });
    expect(todos.map((todo: any) => todo.id)).toEqual(["#k3x9qa", "#@2"]);
    expect(todos[0]).toMatchObject({ commentId: "k3x9qa", sourceKind: "comment", text: "Prove (it)", status: "todo",
      line: 3, quote: "The bound" });
    expect(todos[0].canon).toMatchObject({ ddl: "2026-11-20", prio: "A" });
    expect(todos[0].inlineTags).toContain("comment");
    expect(commentTitle("Fix {prio: B}")).toEqual({ title: "Fix", attrs: "{prio: B}" });
  });

  test("C77 done writes @@comment(done); an id-less comment is given an id", () => {
    const [named, legacy] = commentTodos(source, { extract: extractPlanningItems, note });
    expect(commentStatusEdit(source, named, true)).toEqual({
      oldText: "@@comment [Prove [it] {ddl: 2026-11-20; prio: A}] {id: k3x9qa}",
      newText: "@@comment(done) [Prove [it] {ddl: 2026-11-20; prio: A}] {id: k3x9qa}" });
    expect(commentStatusEdit(source, legacy, true).newText).toMatch(/^@@comment\(done\) \[use clearer def\] \{id: [a-z0-9]{6}\}$/);
    expect(() => commentStatusEdit("nothing", named, true)).toThrow(/changed/);
    expect(commentPatchDone({ op: "complete" })).toBe(true);
    expect(commentPatchDone({ status: "todo" })).toBe(false);
    expect(() => commentPatchDone({ ddl: "2026-11-20" })).toThrow(/comment/);
  });

  test("C77 the index lists a note's open comments and follows its text", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-agenda-comments-"));
    configure({ root, workspaceRoot: root, stateRoot: join(root, ".state"), tmpRoot: join(root, ".tmp") });
    await writeFile(join(root, "a.md"), source);
    const service = createAgendaIndex({
      knowledgeRoot: root, watch: null, now: () => new Date(2026, 10, 18, 12).getTime(),
      parseDocument: async (doc: any) => {
        const planning = await agendaMarkdownDocument(doc);
        planning.todos.push(...commentTodos(doc.content, { extract: extractPlanningItems, note: { ...note, file: doc.file } }));
        return planning;
      },
      evaluate: (planning: any, body: any, options: any) => buildAgendaFromPlanning(planning, body, { ...options, requireKernel: false }),
    });
    try {
      const first = await service.query({ includePlanning: true });
      expect(first.todos.filter((item: any) => item.sourceKind === "comment").map((item: any) => item.text)).toEqual(["Prove (it)", "use clearer def"]);
      await writeFile(join(root, "a.md"), source.replace("@@comment [Prove", "@@comment(done) [Prove"));
      service.invalidate([join(root, "a.md")]);
      const second = await service.query({ includePlanning: true });
      expect(second.todos.filter((item: any) => item.sourceKind === "comment").map((item: any) => item.text)).toEqual(["use clearer def"]);
    } finally { service.close(); await rm(root, { recursive: true, force: true }); }
  });
});
