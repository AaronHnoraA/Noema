import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findResearchProjectRoot,
  isResearchProjectRootSync,
  parseProjectManifest,
  readProjectLayout,
} from "../server/lib/research-project.mjs";
import { createResearchRuntimeService } from "../server/lib/research-runtime.mjs";
import { findResearchRepositoryRoot } from "../server/lib/research-notebook.mjs";

async function withTree<T>(run: (base: string) => Promise<T>): Promise<T> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "noema-project-")));
  try {
    return await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

describe("D-038 Noema Project model", () => {
  test("a manifest declares a Repository, a Project, or both", () => {
    expect(parseProjectManifest('schema = 1\nrepository_id = "r1"\n')).toEqual({
      repositoryId: "r1", hasProjectTable: false, projectId: "", workspace: "",
    });
    expect(parseProjectManifest('schema = 1\nrepository_id = "r1"\nnamespace = "Math"\n\n[project]\nid = "p1"\nworkspace = \'~/code/lce\'\n')).toEqual({
      repositoryId: "r1", hasProjectTable: true, projectId: "p1", workspace: "~/code/lce",
    });
    // Keys of another table never leak into the Project.
    expect(parseProjectManifest('[other]\nid = "x"\n[project]\nworkspace = "a \\"b\\""\n')).toMatchObject({
      projectId: "", workspace: 'a "b"',
    });
  });

  test("a Wiki repository vault is not a Project; its nested Project is", async () => withTree(async (vault) => {
    await writeFile(join(vault, "noema.toml"), 'schema = 1\nrepository_id = "vault"\n');
    const project = join(vault, "project", "UNSW", "LCE(202610)");
    await mkdir(join(project, "workflow"), { recursive: true });
    await writeFile(join(project, "noema.toml"), 'schema = 1\n[project]\nid = "lce"\n');
    const other = join(vault, "project", "UNSW", "ISO(202603)");
    await mkdir(other, { recursive: true });

    expect(isResearchProjectRootSync(vault)).toBe(false);
    expect(await findResearchProjectRoot(join(project, "workflow", "start.noema"))).toBe(project);
    await expect(findResearchProjectRoot(other)).rejects.toMatchObject({ code: "ERR_RESEARCH_ROOT", statusCode: 404 });
    // The research index follows the same rule; outside a Project it stays
    // with the document.
    expect(await findResearchRepositoryRoot(join(project, "workflow", "start.noema"))).toBe(project);
    expect(await findResearchRepositoryRoot(join(other, "a.noema"))).toBeNull();
  }));

  test("a pre-D-038 manifest with Run state stays a Project and keeps its id", async () => withTree(async (root) => {
    await writeFile(join(root, "noema.toml"), 'schema = 1\nrepository_id = "legacy-id"\n');
    expect(isResearchProjectRootSync(root)).toBe(false);
    await mkdir(join(root, ".agent"));
    await writeFile(join(root, ".agent", "state.sqlite"), "");
    expect(isResearchProjectRootSync(root)).toBe(true);
    expect(await readProjectLayout(root)).toEqual({ root, id: "legacy-id", workspace: root, declaredWorkspace: "" });
  }));

  test("logical /fs: and TRAMP names are refused with a projection error", async () => {
    await expect(findResearchProjectRoot("/fs:local:/Users/x/project")).rejects.toMatchObject({ code: "ERR_RESEARCH_ROOT", statusCode: 422 });
    await expect(findResearchProjectRoot("/ssh:host:/srv/project")).rejects.toMatchObject({ code: "ERR_RESEARCH_ROOT", statusCode: 422 });
  });

  test("a declared workspace resolves relative to the Project and must exist", async () => withTree(async (base) => {
    const root = join(base, "notes", "lce");
    await mkdir(root, { recursive: true });
    await mkdir(join(base, "code", "lce"), { recursive: true });
    await writeFile(join(root, "noema.toml"), '[project]\nid = "p"\nworkspace = "../../code/lce"\n');
    expect((await readProjectLayout(root)).workspace).toBe(join(base, "code", "lce"));
    await writeFile(join(root, "noema.toml"), '[project]\nid = "p"\nworkspace = "../../missing"\n');
    await expect(readProjectLayout(root)).rejects.toMatchObject({ code: "ERR_RESEARCH_WORKSPACE" });
  }));

  test("a Run executes in the workspace and may read it, but nothing beyond", async () => withTree(async (base) => {
    const root = join(base, "vault", "lce");
    const workspace = join(base, "code", "lce");
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(base, "secret.txt"), "outside\n");
    await writeFile(join(root, "noema.toml"), '[project]\nid = "p-lce"\nworkspace = "../../code/lce"\n');
    await writeFile(join(root, "notes.md"), "Project note.\n");
    await writeFile(join(workspace, "src", "main.py"), "print(1)\n");
    const file = join(root, "prompts", "task.prompt");
    await writeFile(file, "@agent(codex)\n@session(fresh)\n@workstream(ws_lce)\n\nWork on the code.");
    const provider = {
      sessions: vi.fn(async () => []),
      runs: vi.fn(async () => []),
      prepareRun: vi.fn(async ({ run }) => ({ id: "run_lce", ...run })),
    };
    const service = createResearchRuntimeService({ getProvider: () => provider as any });

    const prepared = await service.prepareRun({
      promptFile: file, cwd: root, context: ["file:notes.md", "workspace:src/main.py"],
    });
    expect(prepared.root).toBe(root);
    expect(prepared.spec).toMatchObject({ project_id: "p-lce", execution_target: workspace, cwd: workspace });
    expect(prepared.contextItems.map((item: any) => [item.ref, item.resolvedUri])).toEqual([
      ["file:notes.md", "noema://file/notes.md"],
      ["workspace:src/main.py", "noema://file/../../code/lce/src/main.py"],
    ]);
    await expect(service.prepareRun({ promptFile: file, cwd: root, context: ["file:../../secret.txt"] }))
      .rejects.toMatchObject({ code: "ERR_RESEARCH_CONTEXT" });
    // `cwd' only locates the Project; an explicit target inside it still wins.
    const explicit = await service.prepareRun({ promptFile: file, cwd: root, executionTarget: join(root, "prompts") });
    expect(explicit.spec.execution_target).toBe(join(root, "prompts"));
  }));
});
