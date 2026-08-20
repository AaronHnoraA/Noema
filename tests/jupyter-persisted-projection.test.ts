import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPersistedScriptCell } from "../server/lib/jupyter-cell.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted Jupyter Cell projection", () => {
  test("reads code and saved output without exposing a live kernel runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-jupyter-projection-"));
    roots.push(root);
    const store = join(root, ".cell");
    const note = join(root, "note.md");
    await mkdir(store);
    await writeFile(note, "# Note\n", "utf8");
    await writeFile(join(store, "note.python.default.ipynb"), JSON.stringify({
      cells: [{
        cell_type: "code",
        id: "cell-a",
        source: "answer = 42",
        execution_count: 1,
        outputs: [{ output_type: "execute_result", execution_count: 1, data: { "text/plain": "42" }, metadata: {} }],
        metadata: { noema: {
          ok: true,
          status: "ok",
          kernelRuntime: { id: "private-runtime", generation: 3 },
          widgetRuntime: { id: "private-runtime", generation: 3 },
          live: true,
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

    const result = await readPersistedScriptCell({
      file: note,
      cellId: "cell-a",
      kernel: "python3",
      session: "default",
      language: "python",
    });

    expect(result.code).toBe("answer = 42");
    expect(result.output?.outputs?.[0]?.data?.["text/plain"]).toBe("42");
    expect(result.output?.live).toBe(false);
    expect(result.output).not.toHaveProperty("kernelRuntime");
    expect(result.output).not.toHaveProperty("widgetRuntime");
    expect(result).not.toHaveProperty("file");
  });
});
