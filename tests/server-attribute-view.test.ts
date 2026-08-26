import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Shared ESM contract lives outside the TS app graph.
import {
  ATTRIBUTE_VIEW_CALC_OPERATORS,
  ATTRIBUTE_VIEW_FIELD_TYPES,
  ATTRIBUTE_VIEW_FILTER_OPERATORS,
  evaluateAttributeView,
} from "../shared/attribute-view.mjs";
// @ts-ignore Server facade modules live outside the TS app graph.
import { buildAttributeView, configure, configurePlanningProvider, patchAttributeViewCell, readNote, syncRoamDb } from "../server/lib/index.mjs";

const roots: string[] = [];

afterEach(async () => {
  configurePlanningProvider(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable attribute views", () => {
  test("source-owns the complete typed operator and calculation vocabulary", () => {
    expect(ATTRIBUTE_VIEW_FIELD_TYPES).toHaveLength(17);
    expect(ATTRIBUTE_VIEW_FILTER_OPERATORS).toHaveLength(17);
    expect(ATTRIBUTE_VIEW_CALC_OPERATORS).toHaveLength(22);
    expect(new Set(ATTRIBUTE_VIEW_FIELD_TYPES).size).toBe(17);
    expect(new Set(ATTRIBUTE_VIEW_FILTER_OPERATORS).size).toBe(17);
    expect(new Set(ATTRIBUTE_VIEW_CALC_OPERATORS).size).toBe(22);
  });

  test("matches the shared Go parser and evaluator fixtures", async () => {
    const fixtures = JSON.parse(await readFile(join(process.cwd(), "shared", "attribute-view-fixtures.json"), "utf8"));
    for (const fixture of fixtures) expect(evaluateAttributeView(fixture.request), fixture.name).toEqual(fixture.expected);
  });

  test("applies typed filters, nested groups, relative dates and all calculation families", () => {
    const result = evaluateAttributeView({
      title: "Typed work",
      nowMs: Date.parse("2026-08-26T12:00:00Z"),
      source: [
        "source: todo",
        "columns: text, effort, ddl, tags, done",
        "type: effort number",
        "type: ddl date",
        "type: tags mSelect",
        "type: done checkbox",
        "filter: effort between 2..8",
        "filter: ddl <= +7d",
        "filter: tags contains-any research|writing",
        "filter-any: status = todo; status = doing",
        "calc: effort sum",
        "calc: effort average",
        "calc: effort median",
        "calc: effort range",
        "calc: ddl earliest",
        "calc: ddl latest",
        "calc: done checked",
        "calc: done percent-checked",
        "calc: tags unique-values",
        "calc: effort template {{count}} rows / {{sum}} points",
      ].join("\n"),
      items: [
        { id: "a", kind: "todo", status: "todo", text: "Draft", canon: { effort: "2", ddl: "2026-08-26", tags: "research|draft", done: "true" } },
        { id: "b", kind: "todo", status: "doing", text: "Revise", canon: { effort: "8", ddl: "2026-09-02", tags: "writing", done: "false" } },
        { id: "c", kind: "todo", status: "done", text: "Archive", canon: { effort: "4", ddl: "2026-08-28", tags: "research", done: "true" } },
        { id: "d", kind: "todo", status: "todo", text: "Too large", canon: { effort: "9", ddl: "2026-08-27", tags: "research", done: "false" } },
      ],
    });
    expect(result.rows.map((row: { id: string }) => row.id)).toEqual(["a", "b"]);
    expect(result.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "effort", type: "number" }),
      expect.objectContaining({ key: "tags", type: "mselect" }),
    ]));
    expect(result.calculations).toEqual([
      expect.objectContaining({ operator: "sum", value: 10 }),
      expect.objectContaining({ operator: "average", value: 5 }),
      expect.objectContaining({ operator: "median", value: 5 }),
      expect.objectContaining({ operator: "range", value: 6 }),
      expect.objectContaining({ operator: "earliest", value: "2026-08-26" }),
      expect.objectContaining({ operator: "latest", value: "2026-09-02" }),
      expect.objectContaining({ operator: "checked", value: 1 }),
      expect.objectContaining({ operator: "percent-checked", value: 0.5 }),
      expect.objectContaining({ operator: "unique-values", value: ["research|draft", "writing"] }),
      expect.objectContaining({ operator: "template", value: "2 rows / 10 points" }),
    ]);
  });

  test("treats multi-select equality as case-insensitive set equality", () => {
    const result = evaluateAttributeView({
      source: "source: todo\ncolumns: text, tags\ntype: tags mselect\nfilter: tags = draft|research",
      items: [
        { id: "same", kind: "todo", text: "Same set", canon: { tags: "Research|draft|research" } },
        { id: "different", kind: "todo", text: "Different set", canon: { tags: "research" } },
      ],
    });
    expect(result.rows.map((row: { id: string }) => row.id)).toEqual(["same"]);
  });

  test("Node/Emacs fallback scans planning items without an AV sidecar", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-attribute-view-"));
    roots.push(workspace);
    const notes = join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, "paper.md"), [
      "# Paper", "",
      "@@project(active) [Paper] {project=paper}",
      "@@todo(doing) [Draft] {id=a, project=paper, prio=A}",
      "@@todo(done) [Archive] {id=b, project=paper, prio=B}",
      "",
    ].join("\n"), "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });
    await syncRoamDb(null, { mode: "full" });
    const result = await buildAttributeView({
      title: "Open paper work",
      source: "source: todo\ncolumns: text, status, project, prio\nfilter: status != done",
    });
    expect(result).toMatchObject({
      type: "attribute-view",
      evaluationSource: "node-attribute-view",
      title: "Open paper work",
      total: 1,
      rows: [{ id: "#a", kind: "todo", cells: [{ value: "Draft" }, { value: "doing" }, { value: "paper" }, { value: "A" }] }],
    });
    const row = result.rows[0];
    const paperFile = join(notes, "paper.md");
    await writeFile(paperFile, `External edit shifts every source offset.\n${await readFile(paperFile, "utf8")}`, "utf8");
    const patched = await patchAttributeViewCell({ ...row, key: "status", value: "done" });
    expect(patched).toMatchObject({ type: "attribute-view-cell-patched", changed: true, key: "status", value: "done" });
    expect(await readFile(paperFile, "utf8")).toContain("@@todo(done) [Draft]");
  });

  test("uses the requesting file as an explicit scope across concurrent host windows", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-attribute-view-scope-"));
    roots.push(workspace);
    const notes = join(workspace, "notes");
    const external = join(workspace, "external");
    const insideFile = join(notes, "inside.md");
    const outsideFile = join(external, "outside.md");
    await Promise.all([mkdir(notes, { recursive: true }), mkdir(external, { recursive: true })]);
    await writeFile(insideFile, "# Inside\n\n@@todo [Inside task] {id=inside}\n", "utf8");
    await writeFile(outsideFile, "# Outside\n\n@@todo [Outside task] {id=outside}\n", "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });

    // This legacy standalone open intentionally moves the process-level scan
    // cursor. Explicit AV requests must remain independent of that ordering.
    await readNote(outsideFile);
    const request = { source: "source: todo\ncolumns: text, status" };
    const [inside, outside] = await Promise.all([
      buildAttributeView({ ...request, file: insideFile }),
      buildAttributeView({ ...request, file: outsideFile }),
    ]);
    expect(inside.rows).toMatchObject([{ id: "#inside", file: insideFile, cells: [{ value: "Inside task" }, { value: "todo" }] }]);
    expect(outside.rows).toMatchObject([{ id: "#outside", file: outsideFile, cells: [{ value: "Outside task" }, { value: "todo" }] }]);
  });

  test("projects UUIDv7 prose and org-env properties without a sidecar store", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-attribute-view-blocks-"));
    roots.push(workspace);
    const notes = join(workspace, "notes");
    const file = join(notes, "claims.md");
    await mkdir(notes, { recursive: true });
    await writeFile(file, [
      "# Claims", "",
      "Claim text {#0198fc34-7b32-7a11-8cb4-6c40e3b33d68 status=draft owner=\"Aaron He\"}", "",
      "#+begin theorem Spectral theorem {#0198fc34-7b32-7a11-8cb4-6c40e3b33d69 phase=proof}",
      "Body", "#+end theorem", "",
      "@@todo [Planning row must not leak] {owner=Aaron}", "",
    ].join("\n"), "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });
    const result = await buildAttributeView({
      file,
      title: "Claims",
      source: "source: block\ncolumns: text, kind, env, status, owner, phase\nsort: line asc",
    });
    expect(result).toMatchObject({
      evaluationSource: "node-attribute-view",
      source: "block",
      total: 2,
      rows: [
        { id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", kind: "prose", file, cells: [{ value: "Claim text" }, { value: "prose" }, { value: "" }, { value: "draft" }, { value: "Aaron He" }, { value: "" }] },
        { id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d69", kind: "org-env", file, cells: [{ value: "Spectral theorem" }, { value: "org-env" }, { value: "theorem" }, { value: "" }, { value: "" }, { value: "proof" }] },
      ],
    });
    const patched = await patchAttributeViewCell({ ...result.rows[0], key: "owner", value: "Noema Team" });
    expect(patched).toMatchObject({ type: "attribute-view-cell-patched", changed: true, key: "owner", value: "Noema Team" });
    expect(await readFile(file, "utf8")).toContain(`{#0198fc34-7b32-7a11-8cb4-6c40e3b33d68 status=draft owner="Noema Team"}`);
  });

  test("re-reads one Go snapshot after a property CAS conflict", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-attribute-view-property-cas-"));
    roots.push(workspace);
    const notes = join(workspace, "notes");
    const file = join(notes, "claim.md");
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Claim\n", "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });
    const versions: string[] = [];
    let reads = 0;
    configurePlanningProvider({
      owns(candidate: string) { return candidate === file; },
      async readPropertyBlock() { reads++; return { version: reads === 1 ? "v1" : "v2" }; },
      async mutatePropertyBlock(request: any) {
        versions.push(request.expectedVersion);
        if (versions.length === 1) throw Object.assign(new Error("block property document version conflict"), { statusCode: 409 });
        return { file, changed: true, version: "v3", block: { canonicalId: request.id.slice(1) } };
      },
    });
    const result = await patchAttributeViewCell({
      kind: "prose", file, id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", key: "owner", value: "Noema",
    });
    expect(result).toMatchObject({ type: "attribute-view-cell-patched", changed: true, version: "v3", key: "owner", value: "Noema" });
    expect(versions).toEqual(["v1", "v2"]);
  });

  test("fails closed when an id-less row's positional identity goes stale", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noema-attribute-view-stale-"));
    roots.push(workspace);
    const notes = join(workspace, "notes");
    const file = join(notes, "tasks.md");
    await mkdir(notes, { recursive: true });
    await writeFile(file, "# Tasks\n\n@@todo [First]\n@@todo [Second]\n", "utf8");
    configure({ root: notes, workspaceRoot: workspace, stateRoot: join(workspace, "state") });
    await syncRoamDb(null, { mode: "full" });
    const view = await buildAttributeView({ title: "Tasks", source: "columns: text, status" });
    const second = view.rows.find((row: any) => row.cells[0]?.value === "Second");
    expect(second.id).toContain(":" + second.index);
    await writeFile(file, "@@todo [Inserted]\n" + await readFile(file, "utf8"), "utf8");
    await expect(patchAttributeViewCell({ ...second, key: "status", value: "done" }))
      .rejects.toMatchObject({ statusCode: 404 });
    const after = await readFile(file, "utf8");
    expect(after).not.toContain("@@todo(done)");
  });

  test("rejects non-todo rows and read-only columns", async () => {
    await expect(patchAttributeViewCell({ kind: "project", file: "/tmp/a.md", id: "#p", key: "status", value: "done" }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(patchAttributeViewCell({ kind: "todo", file: "/tmp/a.md", id: "#a", key: "text", value: "renamed" }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(patchAttributeViewCell({ kind: "prose", file: "/tmp/a.md", id: "#0198fc34-7b32-7a11-8cb4-6c40e3b33d68", key: "text", value: "renamed" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
