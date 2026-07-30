import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { configure } from "../server/lib/state.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import * as serverIndex from "../server/lib/index.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { saveNote } from "../server/lib/save.mjs";
// @ts-ignore The server is a Node ESM module outside the TS app graph.
import { updateCurrentNoteMeta } from "../server/lib/runtime.mjs";

const {
  graphPayload,
  notesIndexPayload,
  pathSuggestionsForFile,
  readNoteCodeRegion,
  refsFromContent,
  rewriteMarkdownPathReferences,
  roamDbRefsFromContent,
  roamTagOverlapReport,
  scanNotes,
  tagIndexPayload,
} = serverIndex as any;

async function setupRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(root, { recursive: true });
  configure({
    root,
    workspaceRoot: root,
    pluginRoot: join(root, "plugin"),
  });
  return root;
}

describe("server note refs", () => {
  test("extracts markdown note refs whose paths contain balanced parentheses", () => {
    expect(
      refsFromContent("[eq:1](roam/project/UNSW/ISO(202603)/meeting.md#eq-eq%3A1)"),
    ).toContain("roam/project/UNSW/ISO(202603)/meeting.md");
  });

  test("extracts encoded markdown note refs and decodes path syntax", () => {
    expect(
      refsFromContent("[eq:1](roam/project/UNSW/ISO%28202603%29/meeting.md#eq-eq%3A1)"),
    ).toContain("roam/project/UNSW/ISO(202603)/meeting.md");
  });

  test("extracts Typst refs from markdown links", () => {
    expect(
      refsFromContent("[def](project/UNSW/ISO%28202603%29/definition.typ#eq-main)"),
    ).toContain("project/UNSW/ISO(202603)/definition.typ");
  });

  test("extracts roam idlinks from markdown links and bare hrefs", () => {
    expect(refsFromContent("[density](roam://20260520T120000-density-operator#eq-eq%3A1)"))
      .toContain("20260520T120000-density-operator");
    expect(refsFromContent("[#anchor](roam://20260520T120000-density-operator#tag-anchor)"))
      .toContain("20260520T120000-density-operator");
    expect(refsFromContent("See roam://20260520T120000-density-operator."))
      .toContain("20260520T120000-density-operator");
  });

  test("keeps plain markdown file links out of roam db refs", () => {
    const refs = roamDbRefsFromContent([
      "[path](project/note.md#section)",
      "[roam](roam://node-id#section)",
      "[wiki](unrelated-node#anchor)",
    ].join("\n"));
    expect(refs).not.toContain("project/note.md");
    expect(refs).not.toContain("project/note.md#section");
    expect(refs).toEqual(expect.arrayContaining(["node-id", "unrelated-node"]));
  });

  test("keeps links inside meta summary out of graph indexes", () => {
    const content = [
      "#+begin meta",
      "title: Cover",
      "#+begin summary",
      "[hidden](roam://hidden-note)",
      "#+end summary",
      "#+end meta",
      "[visible](roam://visible-note)",
    ].join("\n");

    expect(refsFromContent(content)).toEqual(["visible-note"]);
    expect(roamDbRefsFromContent(content)).toEqual(["visible-note"]);
  });

  test("extracts roam core tag and DOM link targets", () => {
    const refs = refsFromContent([
      "[tag](20260520T120000-density-operator#section-anchor)",
      "[dom](20260520T120000-density-operator@main-title)",
      "[nested-dom](20260520T120000-density-operator@chapter@main-title)",
      "[current](./#local-anchor)",
      "[path-dom](roam/project/note.md@main-title)",
      "[path-nested-dom](roam/project/note.md@chapter@main-title)",
      "[roam-dom](roam://20260520T120000-density-operator@main-title)",
      "[roam-nested-dom](roam://20260520T120000-density-operator@chapter@main-title)",
    ].join("\n"));

    expect(refs).toContain("20260520T120000-density-operator");
    expect(refs).toContain("roam/project/note.md");
    expect(refs).not.toContain("20260520T120000-density-operator@chapter");
    expect(refs).not.toContain("roam/project/note.md@chapter");
    expect(refs).not.toContain("./");
  });

  test("treats double-bracket text as plain prose, not a note ref", () => {
    expect(refsFromContent("See [[ Density Operator ]] and [[Alias A]].")).toEqual([]);
  });

  test("suggests paths from relative, parent, and roam-root prefixes without hidden entries", async () => {
    const root = await setupRoot("aaronnote-paths-");
    try {
      await mkdir(join(root, "project", "sub"), { recursive: true });
      await mkdir(join(root, "Proofs"), { recursive: true });
      await mkdir(join(root, ".hidden"), { recursive: true });
      await writeFile(join(root, "project", "note.md"), "# Note\n", "utf8");
      await writeFile(join(root, "project", "other.md"), "# Other\n", "utf8");
      await writeFile(join(root, "Proofs", "Sample.lean"), "-- lean\n", "utf8");
      await writeFile(join(root, ".hidden", "inside.lean"), "-- hidden\n", "utf8");
      await writeFile(join(root, ".secret.lean"), "-- hidden file\n", "utf8");

      expect(await pathSuggestionsForFile(join(root, "project", "note.md"), "./")).toEqual([
        "./sub/",
        "./note.md",
        "./other.md",
      ]);
      expect(await pathSuggestionsForFile(join(root, "project", "note.md"), "../")).toEqual(
        expect.arrayContaining(["../Proofs/", "../project/"]),
      );
      expect(await pathSuggestionsForFile(join(root, "project", "note.md"), "/")).toEqual(
        expect.arrayContaining(["/Proofs/", "/project/"]),
      );
      expect(await pathSuggestionsForFile(join(root, "project", "note.md"), "/")).not.toContain("/.hidden/");
      expect(await pathSuggestionsForFile(join(root, "project", "note.md"), "/")).not.toContain("/.secret.lean");
      expect(await pathSuggestionsForFile(join(root, "project", "note.md"), "/.hidden/")).toEqual(["/.hidden/inside.lean"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("suggests standalone slash paths from detected project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-standalone-paths-"));
    try {
      const notes = join(root, "roam");
      const project = join(root, "assignment");
      await mkdir(notes, { recursive: true });
      await mkdir(join(project, "docs", "spec"), { recursive: true });
      await mkdir(join(project, "attachments"), { recursive: true });
      await writeFile(join(project, "pom.xml"), "<project />\n", "utf8");
      await writeFile(join(project, "attachments", "linear_route.png"), "PNG\n", "utf8");
      const note = join(project, "docs", "spec", "task.md");
      await writeFile(note, "# Task\n", "utf8");
      configure({ root: notes, workspaceRoot: root, pluginRoot: join(root, "plugin") });

      expect(await pathSuggestionsForFile(note, "/")).toEqual(
        expect.arrayContaining(["/attachments/", "/docs/", "/pom.xml"]),
      );
      expect(await pathSuggestionsForFile(note, "/")).not.toContain("/roam/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads note-code lean regions by roam-root path", async () => {
    const root = await setupRoot("aaronnote-note-code-");
    try {
      await mkdir(join(root, "project"), { recursive: true });
      await mkdir(join(root, "Proofs"), { recursive: true });
      const note = join(root, "project", "note.md");
      const lean = join(root, "Proofs", "Sample.lean");
      await writeFile(note, "@@note-code(/Proofs/Sample.lean)[main]\n", "utf8");
      await writeFile(lean, [
        "-- @aaronnote main",
        "theorem sample : True := by",
        "  trivial",
        "-- @aaronnote second",
        "def x := 1",
        "",
      ].join("\n"), "utf8");

      const msg = await readNoteCodeRegion({
        notePath: note,
        path: "/Proofs/Sample.lean",
        id: "main",
      });

      expect(msg.ok).toBe(true);
      expect(msg.file).toBe(lean);
      expect(msg.language).toBe("lean4");
      expect(msg.body).toContain("theorem sample");
      expect(msg.body).not.toContain("def x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads note-code regions by content-root slash path", async () => {
    const root = await setupRoot("aaronnote-note-code-root-path-");
    try {
      await mkdir(join(root, "project", "UNSW", "lab"), { recursive: true });
      const note = join(root, "project", "UNSW", "GraphTensor.md");
      const source = join(root, "project", "UNSW", "lab", "demo.py");
      await writeFile(note, "@@note-code(/project/UNSW/lab/demo.py)[main]\n", "utf8");
      await writeFile(source, [
        "# @aaronnote main",
        "x = 1",
        "# @aaronnote second",
        "x = 2",
        "",
      ].join("\n"), "utf8");

      const msg = await readNoteCodeRegion({
        notePath: note,
        path: "/project/UNSW/lab/demo.py",
        id: "main",
      });

      expect(msg.ok).toBe(true);
      expect(msg.file).toBe(source);
      expect(msg.language).toBe("python");
      expect(msg.body).toContain("x = 1");
      expect(msg.body).not.toContain("x = 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps legacy bare note-code project paths working when local path is missing", async () => {
    const root = await setupRoot("aaronnote-note-code-legacy-path-");
    try {
      await mkdir(join(root, "project", "UNSW", "lab"), { recursive: true });
      const note = join(root, "project", "UNSW", "GraphTensor.md");
      const source = join(root, "project", "UNSW", "lab", "demo.py");
      await writeFile(note, "@@note-code(project/UNSW/lab/demo.py)[main]\n", "utf8");
      await writeFile(source, [
        "# @aaronnote main",
        "x = 1",
        "",
      ].join("\n"), "utf8");

      const msg = await readNoteCodeRegion({
        notePath: note,
        path: "project/UNSW/lab/demo.py",
        id: "main",
      });

      expect(msg.ok).toBe(true);
      expect(msg.file).toBe(source);
      expect(msg.body).toContain("x = 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serves a compact graph payload", async () => {
    const root = await setupRoot("aaronnote-graph-");
    try {
      await writeFile(join(root, "target.md"), [
        "---",
        "id: target-id",
        "aliases:",
        "  - Alias A",
        "tags:",
        "  - graph",
        "---",
        "# Target",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(root, "source.md"), [
        "---",
        "id: source-id",
        "---",
        "# Source",
        "",
        "See [Alias A](roam://target-id).",
        "",
      ].join("\n"), "utf8");

      const payload = graphPayload(await scanNotes());
      expect(payload.type).toBe("graph");
      expect(payload.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "target-id", title: "Target", aliases: ["Alias A"], tags: ["graph"] }),
        expect.objectContaining({ key: "source-id", title: "Source" }),
      ]));
      expect(payload.edges).toEqual([
        { source: "source-id", target: "target-id" },
      ]);
      expect(payload.nodes[0]).not.toHaveProperty("summary");
      expect(payload.meta).toMatchObject({ noteCount: 2, edgeCount: 1, tagCount: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serves a tag inverted index", async () => {
    const root = await setupRoot("aaronnote-tags-");
    try {
      await writeFile(join(root, "a.md"), [
        "---",
        "id: a-id",
        "tags:",
        "  - graph",
        "---",
        "# A",
        "",
        "Body @@tag[inline-ref]",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(root, "b.md"), [
        "---",
        "id: b-id",
        "tags:",
        "  - graph",
        "---",
        "# B",
        "",
      ].join("\n"), "utf8");

      const payload = tagIndexPayload(await scanNotes());
      expect(payload.type).toBe("tags");
      expect(payload.tags).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "graph",
          count: 2,
          metaCount: 2,
          inlineCount: 0,
          notes: expect.arrayContaining([
            expect.objectContaining({ key: "a-id", title: "A" }),
            expect.objectContaining({ key: "b-id", title: "B" }),
          ]),
        }),
        expect.objectContaining({
          name: "inline-ref",
          count: 1,
          metaCount: 0,
          inlineCount: 1,
          notes: [expect.objectContaining({ key: "a-id", title: "A" })],
        }),
      ]));
      expect(payload.meta).toMatchObject({ tagCount: 2, noteCount: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("roam: off notes and meta blocks without ids stay out of roam graph and tag index", async () => {
    const root = await setupRoot("aaronnote-roam-off-");
    try {
      await writeFile(join(root, "visible.md"), [
        "---",
        "id: visible-id",
        "tags:",
        "  - graph",
        "---",
        "# Visible",
        "",
        "See [Hidden](roam://hidden-id).",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(root, "hidden.md"), [
        "#+begin meta",
        "id: hidden-id",
        "title: Hidden",
        "roam: off",
        "tags: graph",
        "#+end meta",
        "# Hidden",
        "",
      ].join("\n"), "utf8");
      await writeFile(join(root, "metadata-only.md"), [
        "#+begin meta",
        "title: Metadata Only",
        "tags: graph",
        "#+end meta",
        "# Metadata Only",
        "",
      ].join("\n"), "utf8");

      const notes = await scanNotes();
      expect(notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "hidden-id", roam: false, tags: expect.arrayContaining(["graph"]) }),
        expect.objectContaining({ path: "metadata-only.md", roam: false, tags: expect.arrayContaining(["graph"]) }),
      ]));
      expect(graphPayload(notes).nodes).toEqual([
        expect.objectContaining({ key: "visible-id" }),
      ]);
      expect(tagIndexPayload(notes).tags).toEqual([
        expect.objectContaining({ name: "graph", count: 1 }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("meta update writes and preserves file-level project", async () => {
    const root = await setupRoot("aaronnote-meta-project-");
    try {
      const file = join(root, "paper.md");
      await writeFile(file, [
        "#+begin meta",
        "id: paper",
        "title: Paper",
        "tags: old",
        "#+end meta",
        "",
        "# Paper",
        "",
      ].join("\n"), "utf8");

      await updateCurrentNoteMeta({
        file,
        content: await readFile(file, "utf8"),
        title: "Paper",
        project: "iso-202603",
        tags: ["old"],
        kind: "default",
      }, "add");
      expect(await readFile(file, "utf8")).toContain("project: iso-202603");

      await updateCurrentNoteMeta({
        file,
        content: await readFile(file, "utf8"),
        tags: ["new"],
      }, "tag");
      const content = await readFile(file, "utf8");
      expect(content).toContain("project: iso-202603");
      expect(content).toContain("tags: new, old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("indexes hierarchical DOM targets for note link completion without rescanning on demand", async () => {
    const root = await setupRoot("aaronnote-dom-targets-");
    try {
      await writeFile(join(root, "paper.md"), [
        "#+begin meta",
        "id: paper-id",
        "title: Paper",
        "#+end meta",
        "",
        "# Background",
        "",
        "## Tensor Graphs",
        "",
        "### Plan",
        "",
      ].join("\n"), "utf8");

      const payload = await notesIndexPayload();
      const paper = payload.notes.find((note: { id?: string }) => note.id === "paper-id");
      expect(paper?.domTargets).toEqual(expect.arrayContaining([
        expect.objectContaining({ slug: "background", path: ["background"] }),
        expect.objectContaining({ slug: "tensor-graphs", path: ["background", "tensor-graphs"] }),
        expect.objectContaining({ slug: "plan", path: ["background", "tensor-graphs", "plan"] }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports case duplicate and overlapping roam tags", async () => {
    const root = await setupRoot("aaronnote-tag-tools-");
    try {
      await writeFile(join(root, "a.md"), [
        "---",
        "id: a-id",
        "tags:",
        "  - qc",
        "  - math",
        "---",
        "# A",
      ].join("\n"), "utf8");
      await writeFile(join(root, "b.md"), [
        "---",
        "id: b-id",
        "tags:",
        "  - QC",
        "  - math",
        "---",
        "# B",
      ].join("\n"), "utf8");

      const report = await roamTagOverlapReport() as { duplicateCase?: Array<{ variants?: string[] }>; overlaps?: Array<{ a?: string; b?: string }> };
      expect(report.duplicateCase?.[0]?.variants).toEqual(expect.arrayContaining(["QC", "qc"]));
      expect(report.overlaps?.some((item) => new Set([item.a, item.b]).size === 2
        && new Set([item.a, item.b]).has("qc")
        && new Set([item.a, item.b]).has("math"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("previews markdown path reference rewrites without touching roam links", async () => {
    const root = await setupRoot("aaronnote-path-rewrite-");
    try {
      await mkdir(join(root, "folder"), { recursive: true });
      await writeFile(join(root, "source.md"), [
        "---",
        "id: source-id",
        "---",
        "# Source",
        "",
        "[path](folder/old.md#section)",
        "[roam](roam://old-id#section)",
      ].join("\n"), "utf8");
      await writeFile(join(root, "folder", "old.md"), [
        "---",
        "id: old-id",
        "---",
        "# Old",
      ].join("\n"), "utf8");

      const result = await rewriteMarkdownPathReferences({
        oldPath: "folder/old.md",
        newPath: "folder/new.md",
        dryRun: true,
      }) as { changedCount?: number; referenceCount?: number };
      expect(result.changedCount).toBe(1);
      expect(result.referenceCount).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
