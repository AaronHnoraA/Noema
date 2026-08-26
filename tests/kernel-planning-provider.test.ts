import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The adapter is a Node ESM module outside the TS app graph.
import { createKernelPlanningProvider } from "../server/lib/kernel-planning-provider.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop kernel planning provider", () => {
  test("loads one joined workspace projection and rejects mismatched note paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-workspace-projection-"));
    roots.push(root);
    const file = join(root, "nested", "project.md");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(file, "# Project\n", "utf8");
    const requests: Array<{ url: string; body: any }> = [];
    let invalid = false;
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806", box: { id: "box-a", root },
      fetchImpl: async (input: string, init: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ code: 0, data: {
          source: "kernel-workspace-projection", indexVersion: 7,
          documents: [{
            path: "/nested/project.md",
            note: { id: "project-id", title: "Project", path: invalid ? "other.md" : "nested/project.md", file: "/untrusted" },
            nodes: [{ kind: "todo", title: "Ship" }], blocks: [], duplicateDefinitionIds: [], version: "v1", mtimeMs: 42,
          }],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    expect(await provider.workspaceProjection({ includeProperties: true })).toEqual({
      source: "kernel-workspace-projection", indexVersion: 7,
      documents: [{
        file, path: "/nested/project.md",
        note: { id: "project-id", title: "Project", path: "nested/project.md", link: "nested/project.md", file, standalone: false },
        nodes: [{ kind: "todo", title: "Ship" }], blocks: [], duplicateDefinitionIds: [], version: "v1", mtimeMs: 42,
      }],
    });
    expect(requests).toEqual([{ url: "http://127.0.0.1:6806/api/noema/markdown/workspaceProjection", body: { notebook: "box-a", includeProperties: true } }]);
    invalid = true;
    await expect(provider.workspaceProjection()).rejects.toMatchObject({ statusCode: 502 });
  });

  test("sends a bounded portable attribute-view projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-attribute-view-"));
    roots.push(root);
    let url = "";
    let request: any = null;
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (input: string, init: RequestInit) => {
        url = String(input);
        request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ code: 0, data: { title: "Work", source: "todo", columns: [], rows: [], total: 0, truncated: false, diagnostics: [] } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      },
    });
    const result = await provider.evaluateAttributeView({
      title: "Work", source: "columns: text, status",
      items: [{ id: "#a", kind: "todo", status: "todo", text: "Draft", file: join(root, "a.md"), noteTitle: "A", line: 2, canon: { prio: "A" }, args: { custom: 7 }, ignored: "host-only" }],
    });
    expect(url).toBe("http://127.0.0.1:6806/api/noema/attribute-view/evaluate");
    expect(request).toEqual({
      title: "Work", source: "columns: text, status",
      items: [{ id: "#a", kind: "todo", status: "todo", text: "Draft", title: "Draft", file: join(root, "a.md"), noteTitle: "A", index: 0, line: 2, canon: { prio: "A" }, args: { custom: "7" } }],
    });
    expect(result).toMatchObject({ title: "Work", source: "todo" });
  });

  test("projects official query-embed results back to portable Markdown files", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-embed-query-"));
    roots.push(root);
    const target = join(root, "target.md");
    await writeFile(target, "# Target\n", "utf8");
    let url = "";
    let request: any = null;
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (input: string, init: RequestInit) => {
        url = String(input);
        request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ code: 0, data: { blocks: [{
          block: {
            id: "projection-a", rootID: "root-a", path: "/target.md", hPath: "Noema/target",
            markdown: "Portable result", type: "NodeParagraph", subType: "", ial: { "custom-noema-id": "uuid-a" },
          },
          blockPaths: [{ id: "root-a", name: "Noema/target", type: "NodeDocument", subType: "" }],
        }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(await provider.searchEmbed({
      statement: "SELECT * FROM blocks WHERE type = 'p'",
      embedBlockID: "20000101000000-embed00",
      headingMode: 2,
      breadcrumb: false,
      excludeIDs: ["20000101000000-embed00"],
    })).toEqual({ blocks: [{
      id: "projection-a", canonicalId: "uuid-a", rootId: "root-a", file: target,
      path: "/target.md", hPath: "Noema/target", markdown: "Portable result",
      type: "NodeParagraph", subType: "",
      breadcrumb: [{ id: "root-a", name: "Noema/target", type: "NodeDocument", subType: "" }],
    }] });
    expect(url).toBe("http://127.0.0.1:6806/api/search/searchEmbedBlock");
    expect(request).toEqual({
      embedBlockID: "20000101000000-embed00", stmt: "SELECT * FROM blocks WHERE type = 'p'",
      notebook: "box-a", excludeIDs: ["20000101000000-embed00"], headingMode: 2, breadcrumb: false,
    });
  });

  test("sends a bounded agenda projection to the Go evaluator", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-agenda-evaluate-"));
    roots.push(root);
    let url = "";
    let request: any = null;
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (input: string, init: RequestInit) => {
        url = String(input);
        request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ code: 0, data: {
          todos: [{ id: "#a", deps: [], effectiveStatus: "todo", blockedBy: [], urgency: 1000 }],
          lints: [],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const result = await provider.evaluateAgenda([{
      id: "#a", status: "todo", text: "A", file: join(root, "a.md"), noteTitle: "A",
      index: 4, line: 2, canon: { prio: "D" }, ignored: "host-only",
    }], 1787623200000, {
      projects: [{ id: "#p", status: "active", title: "P", file: join(root, "a.md"), index: 0, line: 1, source: "@@project P {}", canon: { project: "p" } }],
      milestones: [],
      includeGantt: true,
    });
    expect(url).toBe("http://127.0.0.1:6806/api/noema/agenda/evaluate");
    expect(request).toEqual({
      todayMs: 1787623200000,
      includeGantt: true,
      includePlanning: false,
      includeView: true,
      from: "",
      days: 7,
      clocks: [],
      projects: [{ id: "#p", status: "active", title: "P", text: "P", file: join(root, "a.md"), index: 0, line: 1, source: "@@project P {}", canon: { project: "p" }, args: {} }],
      milestones: [],
      todos: [{ id: "#a", status: "todo", text: "A", file: join(root, "a.md"), noteTitle: "A", index: 4, line: 2, source: "", canon: { prio: "D" } }],
    });
    expect(result.todos[0]).toMatchObject({ urgency: 1000 });
  });

  test("reads one document and maps its kernel path back to an absolute file", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-planning-"));
    roots.push(root);
    const a = join(root, "a.md");
    await writeFile(a, "# A\n", "utf8");
    const requests: Record<string, unknown>[] = [];
    const node = {
      kind: "todo", status: "doing", title: "from kernel", attrs: {}, attrsRaw: "", shape: "inline",
      span: { from: 0, to: 27, line: 1, column: 1 }, raw: "@@todo(doing) [from kernel]", diagnostics: [],
    };
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806/",
      box: { id: "box-a", root },
      fetchImpl: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push(body);
        const documents = [{ path: body.path, nodes: [node] }];
        return new Response(JSON.stringify({ code: 0, data: { documents } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(await provider.read(a)).toMatchObject({ file: a, path: "/a.md", nodes: [{ title: "from kernel" }] });
    expect(requests).toEqual([{ notebook: "box-a", path: "/a.md" }]);
  });

  test("sends versioned atomic mutations and exposes kernel conflicts as 409", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-planning-mutate-"));
    roots.push(root);
    const file = join(root, "a.md");
    await writeFile(file, "@@todo [A]\n", "utf8");
    let request: Record<string, unknown> = {};
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806",
      box: { id: "box-a", root },
      fetchImpl: async (_url: string, init: RequestInit) => {
        request = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ code: 0, data: {
          path: "/a.md", changed: true, from: 0, to: 16,
          source: "@@todo [A]", nextSource: "@@todo(done) [A]", version: "v2", mtimeMs: 2,
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(await provider.mutate({
      file, expectedVersion: "v1",
      selector: { kind: "todo", index: 0, source: "@@todo [A]" },
      mutation: { type: "replace", source: "@@todo(done) [A]" },
    })).toMatchObject({ changed: true, version: "v2" });
    expect(request).toEqual({
      notebook: "box-a", path: "/a.md", expectedVersion: "v1",
      selector: { kind: "todo", index: 0, source: "@@todo [A]" },
      mutation: { type: "replace", source: "@@todo(done) [A]" },
    });

    const conflicting = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806", box: { id: "box-a", root },
      fetchImpl: async () => new Response(JSON.stringify({
        code: -1, msg: "planning document version conflict: expected v1, found v2",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    await expect(conflicting.mutate({ file, mutation: { type: "replace", source: "x" } }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test("reads and CAS-patches one portable property block", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-kernel-property-mutate-"));
    roots.push(root);
    const file = join(root, "a.md");
    await writeFile(file, "Claim\n", "utf8");
    const requests: Array<{ url: string; body: any }> = [];
    const provider = createKernelPlanningProvider({
      baseUrl: "http://127.0.0.1:6806", box: { id: "box-a", root },
      fetchImpl: async (input: string, init: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        requests.push({ url, body });
        const data = url.endsWith("/listPropertyBlocks")
          ? { documents: [{ path: "/a.md", blocks: [], duplicateDefinitionIds: [], version: "v1", mtimeMs: 1 }] }
          : { path: "/a.md", changed: true, version: "v2", block: { canonicalId: "id" } };
        return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    expect(await provider.readPropertyBlock(file)).toMatchObject({ file, path: "/a.md", version: "v1" });
    expect(await provider.mutatePropertyBlock({ file, id: "#uuid", key: "owner", value: "Aaron He", expectedVersion: "v1" }))
      .toMatchObject({ changed: true, version: "v2" });
    expect(requests).toEqual([
      { url: "http://127.0.0.1:6806/api/noema/markdown/listPropertyBlocks", body: { notebook: "box-a", path: "/a.md" } },
      { url: "http://127.0.0.1:6806/api/noema/markdown/mutatePropertyBlock", body: { notebook: "box-a", path: "/a.md", expectedVersion: "v1", id: "#uuid", key: "owner", value: "Aaron He" } },
    ]);
  });
});
