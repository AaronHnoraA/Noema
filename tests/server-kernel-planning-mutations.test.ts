import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Server/shared ESM modules live outside the TS app graph.
import { configure, configurePlanningProvider } from "../server/lib/state.mjs";
// @ts-ignore Server/shared ESM modules live outside the TS app graph.
import { clockIn, clockOut, completeTodo, createTodo, getTodos, patchAttributeViewCell } from "../server/lib/index.mjs";
// @ts-ignore Shared ESM module outside the TS app graph.
import { scanPlanningNodes } from "../shared/planning-dsl.mjs";
// @ts-ignore Shared ESM module outside the TS app graph.
import { applyPlanningSemanticMutation } from "../shared/planning-semantic.mjs";

const roots: string[] = [];

afterEach(async () => {
  configurePlanningProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

describe("desktop kernel planning mutations", () => {
  test("creates a new inbox document through versioned kernel append", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-kernel-create-todo-"));
    const notes = join(workspace, "notes");
    const file = join(notes, "inbox.md");
    roots.push(workspace);
    await mkdir(notes, { recursive: true });
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });

    const calls: any[] = [];
    const snapshot = async () => {
      const source = await readFile(file, "utf8").catch(() => "");
      const info = await stat(file).catch(() => null);
      return { file, nodes: scanPlanningNodes(source), version: digest(source), mtimeMs: info?.mtimeMs || 0 };
    };
    configurePlanningProvider({
      owns(candidate: string) { return candidate === file; },
      read: snapshot,
      async readMany(files: string[]) { return Promise.all(files.map(() => snapshot())); },
      async mutate({ mutation, expectedVersion }: any) {
        const current = await readFile(file, "utf8").catch(() => "");
        if (digest(current) !== expectedVersion) throw Object.assign(new Error("planning document version conflict"), { statusCode: 409 });
        if (mutation.type !== "append-todo") throw new Error(`unexpected mutation ${mutation.type}`);
        const createdSource = "@@todo [created through Go] {id=go0001, ddl=2026-09-01, prio=A}";
        const initial = current || [
          "#+begin meta",
          "id: 019d2a10-bfa1-7e1b-8c21-a1f9c4f31f10",
          "title: Inbox",
          "date: 2026-08-25",
          "kind: default",
          "tags: ",
          "refs: ",
          "#+end meta",
          "",
          "# Inbox",
          "",
        ].join("\n");
        const base = initial.replace(/\s*$/, "");
        const prefix = base ? "\n\n" : "";
        const from = base.length + prefix.length;
        const next = `${base}${prefix}${createdSource}\n`;
        await writeFile(file, next, "utf8");
        const node = scanPlanningNodes(next).find((candidate: any) => candidate.span.from === from);
        const info = await stat(file);
        calls.push({ mutation, expectedVersion });
        return {
          changed: next !== current, from, to: from + createdSource.length,
          source: "", nextSource: createdSource, node,
          version: digest(next), mtimeMs: info.mtimeMs,
        };
      },
    });

    const created = await createTodo({ file, text: "created through Go", ddl: "2026-09-01", prio: "A" });
    expect(created).toMatchObject({ ok: true, createdFile: true, changed: true, file });
    expect(created.todo).toMatchObject({ text: "created through Go", canon: { ddl: "2026-09-01", prio: "A" } });
    expect(created.todo.id).toMatch(/^#[a-z0-9]{6}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].mutation).toEqual({
      type: "append-todo",
      create: { title: "created through Go", status: "todo", attrs: { ddl: "2026-09-01", prio: "A" } },
    });
    expect(calls[0].mutation.source).toBeUndefined();
    expect(calls[0].mutation.initialContent).toBeUndefined();
    expect(calls[0].expectedVersion).toBe(digest(""));
    expect(await readFile(file, "utf8")).toContain("@@todo [created through Go]");
  });

  test("routes todo patch, id mint, clock-in, and clock-out through versioned kernel mutations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-kernel-mutations-"));
    const notes = join(workspace, "notes");
    const file = join(notes, "a.md");
    roots.push(workspace);
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# A\n\n@@todo [ship kernel writes] {due: tomorrow}\n", "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });

    const calls: Array<{ selector: Record<string, unknown>; mutation: Record<string, unknown>; expectedVersion: string }> = [];
    const snapshot = async () => {
      const source = await readFile(file, "utf8");
      return { file, nodes: scanPlanningNodes(source), version: digest(source), mtimeMs: (await stat(file)).mtimeMs };
    };
    configurePlanningProvider({
      owns(candidate: string) { return candidate === file; },
      read: snapshot,
      async readMany(files: string[]) { return Promise.all(files.map(() => snapshot())); },
      async mutate({ selector, mutation, expectedVersion }: any) {
        const source = await readFile(file, "utf8");
        if (digest(source) !== expectedVersion) throw Object.assign(new Error("planning document version conflict"), { statusCode: 409 });
        const nodes = scanPlanningNodes(source);
        const kindMatches = (node: any) => selector.kind === "todo"
          ? node.kind === "todo" || node.kind === "itodo"
          : node.kind === selector.kind;
        const stableId = String(selector.id || "").replace(/^#/, "");
        const node = nodes.find((candidate: any) => kindMatches(candidate) && candidate.span.from === selector.index && candidate.raw === selector.source)
          || nodes.find((candidate: any) => kindMatches(candidate) && stableId && candidate.attrs?.id === stableId)
          || nodes.find((candidate: any) => kindMatches(candidate) && selector.title && candidate.title === selector.title);
        if (!node) throw Object.assign(new Error("planning source was not found"), { statusCode: 404 });
        let next = source;
        let from = node.span.from;
        const semantic = ["patch-todo", "patch-node", "insert-clock"].includes(mutation.type)
          ? applyPlanningSemanticMutation(node.raw, mutation)
          : String(mutation.source || "");
        let inserted = semantic;
        const effectiveType = mutation.type === "insert-clock" ? "insert-after"
          : mutation.type === "patch-todo" || mutation.type === "patch-node" ? "replace"
            : mutation.type;
        if (effectiveType === "replace") {
          next = source.slice(0, node.span.from) + inserted + source.slice(node.span.to);
        } else {
          const newline = source.indexOf("\n", node.span.to);
          from = newline < 0 ? source.length : newline + 1;
          if (newline < 0 && source && !source.endsWith("\n")) inserted = "\n" + inserted;
          if (!inserted.endsWith("\n")) inserted += "\n";
          next = source.slice(0, from) + inserted + source.slice(from);
        }
        await writeFile(file, next, "utf8");
        calls.push({ selector, mutation, expectedVersion });
        return {
          changed: next !== source, from,
          to: from + inserted.length,
          source: effectiveType === "replace" ? node.raw : "",
          nextSource: inserted, version: digest(next), mtimeMs: (await stat(file)).mtimeMs,
        };
      },
    });

    const todo = (await getTodos("")).todos[0];
    await patchAttributeViewCell({ kind: "todo", file, id: todo.id, index: todo.index, key: "status", value: "doing" });
    expect(await readFile(file, "utf8")).toContain("@@todo(doing) [ship kernel writes]");
    expect(await readFile(file, "utf8")).not.toContain("id=/");

    const patched = (await getTodos("")).todos[0];
    const started = await clockIn({ file, index: patched.index, source: patched.source, text: patched.text });
    expect(started.todoId).toMatch(/^#[a-z0-9]{6}$/);
    expect(await readFile(file, "utf8")).toMatch(/@@todo\(doing\).+id=[a-z0-9]{6}/);
    expect(await readFile(file, "utf8")).toContain("@@clock [ship kernel writes]");

    await clockOut({ file });
    expect(await readFile(file, "utf8")).toMatch(/@@clock \[ship kernel writes\].+to=/);
    const beforeComplete = (await getTodos("")).todos[0];
    await completeTodo({ file, id: beforeComplete.id, index: beforeComplete.index, source: beforeComplete.source, text: beforeComplete.text });
    expect(await readFile(file, "utf8")).toMatch(/@@todo\(done\) \[ship kernel writes\]/);
    expect(calls.map((call) => call.mutation.type)).toEqual(["patch-todo", "patch-todo", "insert-clock", "patch-node", "patch-todo"]);
    expect(calls.filter((call) => call.mutation.type === "patch-todo").every((call) => call.mutation.source === undefined)).toBe(true);
    expect(calls.every((call) => call.expectedVersion.length === 64)).toBe(true);
  });
});
