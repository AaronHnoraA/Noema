import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createAgendaNavigator, resolveAgendaTarget } from "../pages/agenda-navigation.ts";

describe("Agenda navigation in the live Markdown pane", () => {
  const content = "😀\n@@todo [New]{id: task}";
  const snapshot = { contentRevision: "live", todos: [{ id: "#task", index: 3, source: "@@todo [New]{id: task}" }] };

  test("uses stable identity and UTF-16 positions after the source changes", () => {
    expect(resolveAgendaTarget(content, snapshot, { id: "#task", index: 99, source: "old" }))
      .toEqual({ from: 3, to: content.length });
  });

  test("does not guess between repeated anonymous tasks or duplicate ids", () => {
    const source = "@@todo [Same]";
    const text = source + "\n" + source;
    const tasks = [{ index: 0, source }, { index: source.length + 1, source }];
    expect(() => resolveAgendaTarget(text, { contentRevision: "new", todos: tasks },
      { source, index: 0, sourceRef: { revision: "old" } })).toThrow("Ambiguous");
    expect(resolveAgendaTarget(text, { contentRevision: "new", todos: tasks },
      { source, index: 0, sourceRef: { revision: "new" } })).toEqual({ from: 0, to: source.length });
    expect(() => resolveAgendaTarget(text, { todos: tasks.map((task) => ({ ...task, id: "#duplicate" })) },
      { id: "#duplicate" })).toThrow("Ambiguous");
  });

  test("a matching code example is not a task without a live parser result", () => {
    expect(() => resolveAgendaTarget("```md\n@@todo [Example]\n```", { todos: [] },
      { source: "@@todo [Example]", line: 2 })).toThrow("no longer");
    expect(() => resolveAgendaTarget(content, { todos: [{ ...snapshot.todos[0], index: 1 }] },
      { id: "#task" })).toThrow("position");
  });

  test("comment tasks return to their anchored text", () => {
    const text = "The {==bound==}{>>#c-1111<<}.";
    expect(resolveAgendaTarget(text, {}, { sourceKind: "comment", id: "#c-1111" }))
      .toEqual({ from: 7, to: 12 });
    expect(() => resolveAgendaTarget("The bound.", {}, { sourceKind: "comment", id: "#c-1111" })).toThrow("no longer");
    const example = "```md\n{==example==}{>>#c-1111<<}\n```\n";
    expect(() => resolveAgendaTarget(example, {}, { sourceKind: "comment", id: "#c-1111" })).toThrow("no longer");
    expect(resolveAgendaTarget(example + text, {}, { sourceKind: "comment", id: "#c-1111" }))
      .toEqual({ from: example.length + 7, to: example.length + 12 });
  });

  test("journal reference tasks without markup require a unique exact live quote", () => {
    const record = { sourceKind: "comment-reference", id: "#c-7777", quote: "A unique theorem" };
    const text = "😀\nA unique theorem\n";
    expect(resolveAgendaTarget(text, {}, record)).toEqual({ from: 3, to: 19 });
    expect(() => resolveAgendaTarget(text + text, {}, record)).toThrow("Ambiguous");
    expect(() => resolveAgendaTarget("Changed theorem", {}, record)).toThrow("no longer");
    expect(() => resolveAgendaTarget(text, {}, { ...record, quote: "" })).toThrow("no longer");
    // A page comment whose marker was removed remains an error.
    expect(() => resolveAgendaTarget(text, {}, { ...record, sourceKind: "comment" })).toThrow("no longer");
    const marked = text + "{==Revised theorem==}{>>#c-7777<<}";
    expect(resolveAgendaTarget(marked, {}, record)).toEqual({ from: text.length + 3, to: text.length + 18 });
    const code = "```lean\nexact  h\n```";
    expect(resolveAgendaTarget(code, {}, { ...record, quote: "exact  h" })).toEqual({ from: 8, to: 16 });
    expect(() => resolveAgendaTarget(code, {}, { ...record, quote: "exact h" })).toThrow("no longer");
  });

  test("late snapshots cannot move the cursor after an edit, click, file switch or newer visit", async () => {
    let text = content, file = "/n.md", selection: unknown = {}, revealCount = 0, active = true;
    const pending: Array<(value: typeof snapshot) => void> = [];
    const navigate = createAgendaNavigator({
      file: () => file, content: () => text, selection: () => selection,
      active: () => active,
      inspect: () => new Promise((resolve) => pending.push(resolve)),
      reveal: () => { revealCount++; },
    });
    const record = { file: "/n.md", id: "#task" };
    const edited = navigate(record); text += "!"; pending.shift()!(snapshot);
    expect(await edited).toBe(false);
    text = content;
    const clicked = navigate(record); selection = {}; pending.shift()!(snapshot);
    expect(await clicked).toBe(false);
    const hidden = navigate(record); active = false; pending.shift()!(snapshot);
    expect(await hidden).toBe(false);
    active = true;
    const switched = navigate(record); file = "/other.md"; pending.shift()!(snapshot);
    expect(await switched).toBe(false);
    file = "/n.md";
    const old = navigate(record), latest = navigate(record);
    pending.shift()!(snapshot); expect(await old).toBe(false);
    pending.shift()!(snapshot); expect(await latest).toBe(true);
    expect(revealCount).toBe(1);
    await expect(navigate({ file: "/wrong.md", id: "#task" })).rejects.toThrow("different note");
  });

  test("a pause/resume cycle permanently cancels the in-flight visit", async () => {
    let complete!: (value: typeof snapshot) => void, moved = false;
    const navigate = createAgendaNavigator({ file: () => "/n.md", content: () => content, selection: () => null,
      inspect: () => new Promise((resolve) => { complete = resolve; }), reveal: () => { moved = true; } });
    const pending = navigate({ file: "/n.md", id: "#task" });
    navigate.cancel();
    complete(snapshot);
    expect(await pending).toBe(false);
    expect(moved).toBe(false);
  });

  test("requests received by an inactive page cannot revive when it resumes", async () => {
    let active = false, inspected = false, moved = false;
    const navigate = createAgendaNavigator({ file: () => "/n.md", content: () => content, selection: () => null,
      active: () => active, inspect: async () => { inspected = true; return snapshot; },
      reveal: () => { moved = true; } });
    const pending = navigate({ file: "/n.md", id: "#task" });
    active = true;
    expect(await pending).toBe(false);
    expect(inspected).toBe(false);
    expect(moved).toBe(false);
  });

  test("compares complete document identities while accepting known local aliases", async () => {
    let file = "/other/project/tasks.md", inspected = 0;
    const navigate = createAgendaNavigator({ file: () => file, content: () => content, selection: () => null,
      inspect: async () => { inspected++; return snapshot; }, reveal: () => {} });
    await expect(navigate({ file: "/project/tasks.md", id: "#task" })).rejects.toThrow("different note");
    file = "/private/tmp/tasks.md";
    expect(await navigate({ file: "/fs:local:/tmp/tasks.md", id: "#task" })).toBe(true);
    file = "/fs:alice:/project/tasks.md";
    await expect(navigate({ file: "/fs:bob:/project/tasks.md", id: "#task" })).rejects.toThrow("different note");
    expect(inspected).toBe(1);
  });
});
