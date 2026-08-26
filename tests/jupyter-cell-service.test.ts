import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJupyterCellService, durationFromEnv, jupyterWidgetCommOpenP } from "../server/lib/jupyter-cell.mjs";

// These exercise only the filesystem + short-circuit paths of the cell service
// (notebook write/read and non-kernel branches). They
// never reach a Jupyter server, so they run anywhere. Kernel execution, stream
// merge/truncate and dead-kernel retry are covered by manual e2e (they need a
// live websocket).

async function withService(run: (ctx: {
  service: ReturnType<typeof createJupyterCellService>;
  note: string;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "aaronnote-jcell-"));
  const service = createJupyterCellService({ runtimeRoot: root, noteRoot: root, workspaceRoot: root });
  const note = join(root, "note.md");
  await writeFile(note, "# note\n", "utf8");
  try {
    await run({ service, note });
  } finally {
    await service.shutdown().catch(() => {});
  }
}

describe("jupyter cell service (no kernel)", () => {
  test("session selection publishes the authoritative document snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-jcell-session-event-"));
    const published: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const service = createJupyterCellService({
      runtimeRoot: root,
      noteRoot: root,
      workspaceRoot: root,
      publish(event: string, payload: Record<string, unknown>) {
        published.push({ event, payload });
      },
    });
    const note = join(root, "note.md");
    await writeFile(note, "# note\n", "utf8");
    try {
      const opened = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "cell-a", id: "cell-a", code: "answer = 42" }],
      });
      const snapshot = await service.sessionSelect({ scriptFile: opened.file, kind: "none" });
      expect(snapshot).toMatchObject({
        kernelStatus: "no-kernel",
        document: { scriptFile: opened.file, kernel: "", kernelSpecName: "" },
      });
      expect(published).toContainEqual({
        event: "jupyter-session",
        payload: snapshot,
      });
      published.length = 0;
      await service.scriptAction({
        scriptFile: opened.file,
        cellId: "cell-a",
        action: "insertBelow",
      });
      expect(published).toEqual([
        expect.objectContaining({
          event: "jupyter-session",
          payload: expect.objectContaining({
            document: expect.objectContaining({ scriptFile: opened.file }),
          }),
        }),
      ]);
    } finally {
      await service.shutdown().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deleting a cell the notebook no longer knows about succeeds", async () => {
    // An unlabeled @@cell's id is derived from the marker's document offset,
    // so editing anything above it renames the cell while the notebook still
    // holds the previous id. A 404 here used to abort the caller before it
    // removed the Markdown marker, so "Delete Cell Block" appeared to do
    // nothing. Deleting something already absent is the requested state.
    await withService(async ({ service, note }) => {
      const opened = await service.openScript({
        file: note,
        cellId: "ceil-oldhash",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "ceil-oldhash", id: "ceil-oldhash", code: "a = 1" }],
      });
      const result = await service.documentMutate({
        scriptFile: opened.file,
        cellId: "ceil-newhash",
        op: "delete",
      });
      expect(result).toMatchObject({ ok: true, action: "delete", alreadyAbsent: true });

      // The cell that does exist is still deletable, and other actions still
      // reject an unknown id rather than silently succeeding.
      await expect(service.documentMutate({
        scriptFile: opened.file,
        cellId: "ceil-newhash",
        op: "insertBelow",
      })).rejects.toThrow(/Unknown Jupyter cell/);
      const deleted = await service.documentMutate({
        scriptFile: opened.file,
        cellId: "ceil-oldhash",
        op: "delete",
      });
      expect(deleted).toMatchObject({ ok: true, action: "delete" });
      expect(deleted).not.toHaveProperty("alreadyAbsent");
    });
  });

  test("creates a fresh packaged-state runtime directory before registry use", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-jcell-runtime-root-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "noema-jcell-state-root-"));
    const service = createJupyterCellService({
      runtimeRoot: root,
      stateRoot,
      noteRoot: root,
      workspaceRoot: root,
    });
    try {
      await service.listTasks();
      expect((await stat(join(stateRoot, "jupyter", "runtime"))).isDirectory()).toBe(true);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });

  test("desktop state ignores historical source kernelspecs and resolves the bundled launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-jcell-app-root-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "noema-jcell-app-state-"));
    const stale = join(root, "jupyter", ".jupyter", "data", "kernels", "python3");
    const bundled = join(root, "jupyter", "kernel-templates", "python3");
    await mkdir(stale, { recursive: true });
    await mkdir(bundled, { recursive: true });
    await writeFile(join(stale, "kernel.json"), JSON.stringify({
      argv: ["/Users/example/.emacs.d/lisp/roam/Noema/jupyter/bin/python-jupyter-kernel", "-f", "{connection_file}"],
      display_name: "Historical Emacs Python",
      language: "python",
    }));
    await writeFile(join(bundled, "kernel.json"), JSON.stringify({
      argv: ["@AARONNOTE_JUPYTER_ROOT@/bin/python-jupyter-kernel", "-f", "{connection_file}"],
      display_name: "Noema Python",
      language: "python",
      env: { JUPYTER_RUNTIME_DIR: "@AARONNOTE_JUPYTER_STATE_ROOT@/runtime" },
    }));
    const note = join(root, "note.md");
    await writeFile(note, "# note\n", "utf8");
    const service = createJupyterCellService({
      runtimeRoot: root,
      stateRoot,
      noteRoot: root,
      workspaceRoot: root,
    });
    try {
      const opened = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        open: false,
        cells: [{ cellId: "cell-a", id: "cell-a", code: "answer = 42" }],
      });
      expect(opened.kernelSpec).toMatchObject({
        name: "python3",
        resourceDir: bundled,
        spec: {
          display_name: "Noema Python",
          argv: [join(root, "jupyter", "bin", "python-jupyter-kernel"), "-f", "{connection_file}"],
          env: { JUPYTER_RUNTIME_DIR: join(stateRoot, "jupyter", "runtime") },
        },
      });
      expect(JSON.stringify(opened.kernelSpec)).not.toContain(".emacs.d");
    } finally {
      await service.shutdown().catch(() => {});
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("openScript delegates opening to the configured host", async () => {
    const opened: Array<{ file: string; line: number; col: number }> = [];
    let kernelspecCalls = 0;
    const root = await mkdtemp(join(tmpdir(), "aaronnote-jcell-open-"));
    const note = join(root, "note.md");
    await writeFile(note, "# note\n", "utf8");
    const service = createJupyterCellService({
      runtimeRoot: root,
      noteRoot: root,
      workspaceRoot: root,
      kernelHost: {
        async listKernelSpecs() {
          kernelspecCalls += 1;
          return [{
            name: "python3",
            spec: { argv: ["/runtime/python", "-m", "ipykernel_launcher", "-f", "{connection_file}"] },
            resourceDir: "/runtime/kernels/python3",
          }];
        },
      },
      openFile(payload: { file: string; line: number; col: number }) {
        opened.push(payload);
      },
    });
    try {
      const catalog = await service.kernels({ file: note });
      expect(catalog.choices).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "start", name: "python3", group: "Kernel Specs" }),
        expect.objectContaining({ kind: "start", name: "lean4", group: "Kernel Specs" }),
      ]));
      expect(catalog.selections).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "none", value: "", label: "No Kernel" }),
        expect.objectContaining({ kind: "start", value: "python3" }),
      ]));
      const result = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        cells: [{ cellId: "cell-a", id: "cell-a", code: "answer = 42" }],
      });
      expect(opened).toHaveLength(1);
      expect(kernelspecCalls).toBe(1);
      expect(opened[0]).toMatchObject({ file: result.file, line: result.line, col: 0 });
      expect(opened[0]).toMatchObject({
        sourceFile: note,
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        kernelSpec: { name: "python3", resourceDir: "/runtime/kernels/python3" },
      });
    } finally {
      await service.shutdown().catch(() => {});
    }
  });

  test("remote logical notes keep sidecars on the target file provider", async () => {
    const store = new Map<string, string>();
    const fileHost = {
      async readFile(file: string) {
        if (!store.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return store.get(file)!;
      },
      async writeFile(file: string, data: unknown) {
        store.set(file, String(data));
      },
      async mkdir() {},
      async rename(from: string, to: string) {
        const value = store.get(from);
        if (value == null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        store.set(to, value);
        store.delete(from);
      },
      async rm(file: string) {
        store.delete(file);
      },
      async stat(file: string) {
        if (!store.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { size: store.get(file)!.length, mtimeMs: 1 };
      },
    };
    const service = createJupyterCellService({
      runtimeRoot: tmpdir(),
      noteRoot: tmpdir(),
      workspaceRoot: tmpdir(),
      fileHost,
    });
    const note = "fs://lab/work/notes/remote.md";
    try {
      const opened = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "cell-a", id: "cell-a", code: "answer = 42" }],
      });
      expect(opened.file).toBe("/fs:lab:/work/notes/.cell/remote.python.default.ipynb");
      expect(store.get(opened.file)).toContain("answer = 42");
      const read = await service.readScriptCell({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
      });
      expect(read.code).toBe("answer = 42");
      expect(Array.from(store.keys()).every((file) => file.startsWith("/fs:lab:"))).toBe(true);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });

  test("durationFromEnv uses defaults only when unset or invalid", () => {
    const name = "AARONNOTE_TEST_DURATION_FROM_ENV";
    const previous = process.env[name];
    try {
      delete process.env[name];
      expect(durationFromEnv(name, 123)).toBe(123);
      process.env[name] = "";
      expect(durationFromEnv(name, 123)).toBe(123);
      process.env[name] = "0";
      expect(durationFromEnv(name, 123)).toBe(0);
      process.env[name] = "bad";
      expect(durationFromEnv(name, 123)).toBe(123);
    } finally {
      if (previous == null) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  test("recognizes widget comm_open messages from model state", () => {
    expect(jupyterWidgetCommOpenP({
      comm_id: "widget-1",
      data: {
        state: {
          _model_name: "VBoxModel",
          _model_module: "@jupyter-widgets/controls",
          _view_name: "VBoxView",
        },
      },
    })).toBe(true);
    expect(jupyterWidgetCommOpenP({
      comm_id: "other-1",
      target_name: "custom.comm",
      data: { state: { value: 1 } },
    })).toBe(false);
  });

  test("openScript writes an ipynb that readScriptCell round-trips", async () => {
    await withService(async ({ service, note }) => {
      await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "cell-a", id: "cell-a", code: "print('hi')" }],
      });
      const read = await service.readScriptCell({
        file: note, cellId: "cell-a", kernel: "python3", session: "default", language: "python",
      });
      expect(read.ok).toBe(true);
      expect(read.exists).toBe(true);
      expect(read.code).toBe("print('hi')");
      expect(read.output).toBe(null);
      const notebook = JSON.parse(await readFile(read.file, "utf8"));
      expect(notebook).toMatchObject({ nbformat: 4, nbformat_minor: 5 });
      expect(notebook.cells[0]).toMatchObject({
        cell_type: "code",
        id: "cell-a",
        source: "print('hi')",
        execution_count: null,
        outputs: [],
      });
      expect(notebook.metadata.noema).toMatchObject({
        source_file: note,
        session: "default",
        language: "python",
        storage: "ipynb",
      });
    });
  });

  test("Noema owns document snapshots, mutations, and manager state", async () => {
    await withService(async ({ service, note }) => {
      const opened = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        open: false,
        cells: [
          { cellId: "cell-a", code: "a = 1" },
          { cellId: "cell-b", code: "b = 2" },
        ],
      });
      const snapshot = await service.documentSnapshot({ scriptFile: opened.file });
      expect(snapshot.server).toBeUndefined();
      expect(snapshot.document).toMatchObject({
        scriptFile: opened.file,
        sourceFile: note,
        kernelSpecName: "python3",
      });
      expect(snapshot.cells.map((cell: { id: string }) => cell.id)).toEqual(["cell-a", "cell-b"]);
      expect(snapshot.kernelStatus).toBe("not-started");

      await service.scriptAction({
        scriptFile: opened.file,
        cellId: "cell-a",
        action: "moveDown",
      });
      const moved = await service.documentSnapshot({ scriptFile: opened.file });
      expect(moved.cells.map((cell: { id: string }) => cell.id)).toEqual(["cell-b", "cell-a"]);

      const split = await service.scriptAction({
        scriptFile: opened.file,
        cellId: "cell-a",
        action: "split",
        offset: 1,
      });
      const afterSplit = await service.documentSnapshot({ scriptFile: opened.file });
      expect(afterSplit.cells.map((cell: { id: string }) => cell.id)).toEqual([
        "cell-b", "cell-a", split.activeCellId,
      ]);
      await service.scriptAction({
        scriptFile: opened.file,
        cellId: split.activeCellId,
        action: "mergeAbove",
      });
      const afterMerge = await service.documentSnapshot({ scriptFile: opened.file });
      expect(afterMerge.cells.map((cell: { id: string }) => cell.id)).toEqual(["cell-b", "cell-a"]);

      const manager = await service.managerSnapshot();
      expect(manager.server).toMatchObject({ status: "ready", owned: true, owner: "noema" });
      expect(manager.sessions).toHaveLength(1);
      expect(manager.kernels).toEqual([]);
    });
  });

  test("manages an ordinary ipynb without Noema note metadata", async () => {
    await withService(async ({ service, note }) => {
      const notebook = join(dirname(note), "standalone.ipynb");
      await writeFile(notebook, `${JSON.stringify({
        cells: [{
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: "value = 1\n",
        }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 4,
      }, null, 2)}\n`, "utf8");

      const snapshot = await service.documentSnapshot({ scriptFile: notebook });
      expect(snapshot.document).toMatchObject({
        scriptFile: notebook,
        sourceFile: notebook,
        kernelSpecName: "python3",
      });
      expect(snapshot.cells).toHaveLength(1);
      expect(snapshot.cells[0]).toMatchObject({ id: "cell-1", code: "value = 1\n" });
      await service.scriptAction({
        scriptFile: notebook,
        cellId: "cell-1",
        action: "insertBelow",
      });
      const changed = await service.documentSnapshot({ scriptFile: notebook });
      expect(changed.cells).toHaveLength(2);

      const markdown = await service.scriptAction({
        scriptFile: notebook,
        cellId: "cell-1",
        action: "insertBelow",
        cellType: "markdown",
      });
      const persisted = JSON.parse(await readFile(notebook, "utf8"));
      const markdownCell = persisted.cells.find(
        (cell: { id: string }) => cell.id === markdown.activeCellId,
      );
      expect(persisted.cells[0]).not.toHaveProperty("id");
      expect(persisted.nbformat_minor).toBe(4);
      expect(persisted.metadata.language_info.name).toBe("python");
      expect(persisted.metadata.kernelspec.language).toBe("python");
      expect(markdown.activeCellId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(markdown.activeCellId).not.toBe("cell-1");
      expect(markdownCell).toMatchObject({
        cell_type: "markdown",
        id: markdown.activeCellId,
        metadata: {},
        source: "",
      });
      expect(markdownCell).not.toHaveProperty("execution_count");
      expect(markdownCell).not.toHaveProperty("outputs");
    });
  });

  test("openScript preserves existing notebook cells omitted by a partial context", async () => {
    await withService(async ({ service, note }) => {
      await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [
          { cellId: "cell-a", id: "cell-a", code: "x = 1" },
          { cellId: "cell-b", id: "cell-b", code: "print(x)" },
        ],
      });
      await service.openScript({
        file: note,
        cellId: "cell-c",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "cell-c", id: "cell-c", code: "" }],
      });
      const readA = await service.readScriptCell({
        file: note, cellId: "cell-a", kernel: "python3", session: "default", language: "python",
      });
      const readB = await service.readScriptCell({
        file: note, cellId: "cell-b", kernel: "python3", session: "default", language: "python",
      });
      const readC = await service.readScriptCell({
        file: note, cellId: "cell-c", kernel: "python3", session: "default", language: "python",
      });
      expect(readA.code).toBe("x = 1");
      expect(readB.code).toBe("print(x)");
      expect(readC.code).toBe("");
    });
  });

  test("deleteScriptCell removes notebook cells and deletes the notebook when empty", async () => {
    await withService(async ({ service, note }) => {
      const scriptFile = join(dirname(note), ".cell", "note.python.default.ipynb");
      const outputFile = scriptFile;
      await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [
          { cellId: "cell-a", id: "cell-a", code: "x = 1" },
          { cellId: "cell-b", id: "cell-b", code: "print(x)" },
        ],
      });
      await service.saveScriptCellOutputUi({
        file: note, cellId: "cell-a", kernel: "python3", session: "default", language: "python", outputFolded: true,
      });
      await service.saveScriptCellOutputUi({
        file: note, cellId: "cell-b", kernel: "python3", session: "default", language: "python", outputExpanded: true,
      });

      const first = await service.deleteScriptCell({
        file: note, cellId: "cell-a", kernel: "python3", session: "default", language: "python",
      });
      expect(first.removedScript).toBe(false);
      const notebookAfterFirst = JSON.parse(await readFile(scriptFile, "utf8"));
      expect(notebookAfterFirst.cells.map((cell: { id: string }) => cell.id)).toEqual(["cell-b"]);
      expect(notebookAfterFirst.cells[0].metadata.noema.ui.outputExpanded).toBe(true);

      const second = await service.deleteScriptCell({
        file: note, cellId: "cell-b", kernel: "python3", session: "default", language: "python",
      });
      expect(second.removedScript).toBe(true);
      await expect(readFile(scriptFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(outputFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("openScript orders notebook cells by the incoming document context", async () => {
    await withService(async ({ service, note }) => {
      await service.openScript({
        file: note,
        cellId: "cell-c",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [
          { cellId: "cell-a", id: "cell-a", code: "a = 1" },
          { cellId: "cell-c", id: "cell-c", code: "c = a + 1" },
        ],
      });
      await service.openScript({
        file: note,
        cellId: "cell-b",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [
          { cellId: "cell-a", id: "cell-a", code: "" },
          { cellId: "cell-b", id: "cell-b", code: "" },
          { cellId: "cell-c", id: "cell-c", code: "" },
        ],
      });
      const scriptPath = join(note, "..", ".cell", "note.python.default.ipynb");
      const notebook = JSON.parse(await readFile(scriptPath, "utf8"));
      expect(notebook.cells.map((cell: { id: string }) => cell.id)).toEqual(["cell-a", "cell-b", "cell-c"]);
      expect(notebook.cells[0].source).toBe("a = 1");
      expect(notebook.cells[2].source).toBe("c = a + 1");
    });
  });

  test("openScript preserves the notebook-selected kernel for a language/session", async () => {
    await withService(async ({ service, note }) => {
      const sageOpen = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "sagemath-10.9",
        session: "default",
        language: "sage",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "cell-a", id: "cell-a", code: "x = 1" }],
      });
      const normalizedOpen = await service.openScript({
        file: note,
        cellId: "cell-a",
        kernel: "python3",
        session: "default",
        language: "python",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "cell-a", id: "cell-a", code: "x = 2" }],
      });
      const scriptPath = join(note, "..", ".cell", "note.python.default.ipynb");
      const pythonRead = await service.readScriptCell({
        file: note, cellId: "cell-a", kernel: "python3", session: "default", language: "python",
      });
      const sageRead = await service.readScriptCell({
        file: note, cellId: "cell-a", kernel: "sagemath-10.9", session: "default", language: "python",
      });
      const script = await readFile(scriptPath, "utf8");
      const notebook = JSON.parse(script);
      expect(sageOpen.kernel).toBe("sagemath-10.9");
      expect(normalizedOpen.kernel).toBe("sagemath-10.9");
      expect(pythonRead.file).toBe(scriptPath);
      expect(sageRead.file).toBe(scriptPath);
      expect(pythonRead.kernel).toBe("sagemath-10.9");
      expect(sageRead.kernel).toBe("sagemath-10.9");
      expect(pythonRead.code).toBe("x = 2");
      expect(sageRead.code).toBe("x = 2");
      expect(notebook.cells[0].source).toBe("x = 2");
      expect(notebook.metadata.kernelspec.name).toBe("sagemath-10.9");
      expect(notebook.metadata.language_info.name).toBe("python");
    });
  });

  test("migrates a legacy Sage-named notebook to its Python language name", async () => {
    await withService(async ({ service, note }) => {
      const legacyPath = join(note, "..", ".cell", "note.sage.default.ipynb");
      const canonicalPath = join(note, "..", ".cell", "note.python.default.ipynb");
      await service.openScript({
        file: note,
        cellId: "legacy-cell",
        kernel: "sagemath",
        session: "default",
        language: "sage",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "legacy-cell", code: "old_value = 1" }],
      });
      // Recreate the pre-migration name to exercise a real existing notebook.
      const legacyNotebook = JSON.parse(await readFile(canonicalPath, "utf8"));
      legacyNotebook.cells[0].metadata.noema = {
        kernel: "sagemath",
        session: "default",
        language: "sage",
      };
      await writeFile(legacyPath, `${JSON.stringify(legacyNotebook, null, 2)}\n`, "utf8");
      await rm(canonicalPath);

      const opened = await service.openScript({
        file: note,
        cellId: "new-cell",
        kernel: "sagemath",
        session: "default",
        language: "sage",
        storage: "ipynb",
        open: false,
        cells: [{ cellId: "new-cell", code: "new_value = 2" }],
      });
      expect(opened.file).toBe(canonicalPath);
      expect(opened.migratedFrom).toBe(legacyPath);
      await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
      const notebook = JSON.parse(await readFile(canonicalPath, "utf8"));
      expect(notebook.metadata.kernelspec.name).toBe("sagemath");
      expect(notebook.metadata.language_info.name).toBe("python");
      expect(notebook.cells.find(
        (cell: { id: string }) => cell.id === "legacy-cell",
      ).metadata.noema.language).toBe("python");
      expect(notebook.cells.map((cell: { id: string }) => cell.id)).toEqual([
        "new-cell", "legacy-cell",
      ]);
    });
  });

  test("executeScriptCell uses the requested kernel for a shared language/session context", async () => {
    await withService(async ({ service, note }) => {
      const result = await service.executeScriptCell({
        file: note,
        cellId: "cell-b",
        kernel: "sagemath-10.9",
        session: "default",
        language: "python",
        runMode: "selected",
        selectedCellIds: ["cell-a", "cell-b"],
        cells: [
          { cellId: "cell-a", id: "cell-a", kernel: "python3", session: "default", language: "python", code: "" },
          { cellId: "cell-b", id: "cell-b", kernel: "python3", session: "default", language: "python", code: "" },
        ],
      });
      const notebookPath = join(note, "..", ".cell", "note.python.default.ipynb");
      const notebook = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(result.results.map((item: { kernel?: string }) => item.kernel)).toEqual(["sagemath-10.9", "sagemath-10.9"]);
      expect(notebook.cells[0].metadata.noema.kernel).toBe("sagemath-10.9");
      expect(notebook.cells[1].metadata.noema.kernel).toBe("sagemath-10.9");
    });
  });

  test("a corrupt notebook is reported instead of discarding its source", async () => {
    await withService(async ({ service, note }) => {
      await service.openScript({
        file: note, cellId: "cell-b", kernel: "python3", session: "default", language: "python",
        storage: "ipynb", open: false, cells: [{ cellId: "cell-b", id: "cell-b", code: "x = 1" }],
      });
      const notebookPath = join(note, "..", ".cell", "note.python.default.ipynb");
      await writeFile(notebookPath, "{ this is not json", "utf8");
      await expect(service.readScriptCell({
        file: note, cellId: "cell-b", kernel: "python3", session: "default", language: "python",
      })).rejects.toBeInstanceOf(SyntaxError);
    });
  });

  test("output clearing writes a valid notebook atomically", async () => {
    await withService(async ({ service, note }) => {
      await service.clearAllOutputs({ file: note, kernel: "python3", session: "default", language: "python" });
      const notebookPath = join(note, "..", ".cell", "note.python.default.ipynb");
      const parsed = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(parsed.nbformat).toBe(4);
      expect(parsed.nbformat_minor).toBeGreaterThanOrEqual(5);
      expect(parsed.cells).toEqual([]);
    });
  });

  test("readScriptCell marks persisted output stale when no matching live kernel exists", async () => {
    await withService(async ({ service, note }) => {
      await service.openScript({
        file: note, cellId: "cell-live", kernel: "python3", session: "default", language: "python",
        storage: "ipynb", open: false, cells: [{ cellId: "cell-live", id: "cell-live", code: "x = 1" }],
      });
      const notebookPath = join(note, "..", ".cell", "note.python.default.ipynb");
      await writeFile(notebookPath, JSON.stringify({
        cells: [{
          cell_type: "code",
          id: "cell-live",
          source: "x = 1",
          execution_count: 3,
          outputs: [],
          metadata: { noema: {
            ok: true,
            status: "ok",
            kernelRuntime: { id: "old-kernel", name: "python3", generation: 1 },
          } },
        }],
        metadata: {
          kernelspec: { display_name: "python3", language: "python", name: "python3" },
          language_info: { name: "python" },
          noema: { source_file: note, session: "default", language: "python", storage: "ipynb" },
        },
        nbformat: 4,
        nbformat_minor: 5,
      }), "utf8");
      const read = await service.readScriptCell({
        file: note, cellId: "cell-live", kernel: "python3", session: "default", language: "python",
      });
      expect(read.output.live).toBe(false);
      expect(read.output.widgetRuntime).toBeUndefined();
    });
  });

  test("lean cells short-circuit without a kernel", async () => {
    await withService(async ({ service, note }) => {
      const result = await service.execute({
        file: note, cellId: "l1", kernel: "lean4", language: "lean4", code: "#check 1",
      });
      expect(result.ok).toBe(true);
      expect(result.runtime).toBe("lean4");
      expect(result.outputs).toEqual([]);
    });
  });

  test("empty code short-circuits without a kernel", async () => {
    await withService(async ({ service, note }) => {
      const result = await service.execute({ file: note, cellId: "e1", kernel: "python3", code: "   \n  " });
      expect(result.ok).toBe(true);
      expect(result.status).toBe("ok");
      expect(result.outputs).toEqual([]);
    });
  });

  test("variables is unsupported for non-python kernels", async () => {
    await withService(async ({ service, note }) => {
      const result = await service.variables({ file: note, kernel: "bash", session: "default" });
      expect(result.ok).toBe(true);
      expect(result.supported).toBe(false);
      expect(result.variables).toEqual([]);
    });
  });

  test("kernelStatus reports not-started before any run", async () => {
    await withService(async ({ service, note }) => {
      const result = await service.kernelStatus({ file: note, kernel: "python3", session: "default" });
      expect(result.status).toBe("not-started");
      expect(result.id).toBe("");
    });
  });

  test("resolveConnectionInfoById returns undefined for unknown kernels", async () => {
    await withService(async ({ service }) => {
      expect(await service.resolveConnectionInfoById("missing")).toBeUndefined();
      expect(await service.readNbextensionAsset("../../etc/passwd")).toBeUndefined();
      expect(await service.touchKernelById("missing")).toBe(false);
    });
  });
});
