import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configure, scanRoamNotes } from "../server/lib/index.mjs";

const roots: string[] = [];

function note(id: string, title: string): string {
  return `#+begin meta\nid: ${id}\ntitle: ${title}\ntags: test\n#+end meta\n\n# ${title}\n`;
}

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "noema-layout-scan-"));
  roots.push(root);
  await mkdir(join(root, "public", "QC"), { recursive: true });
  await mkdir(join(root, "private", "Research"), { recursive: true });
  await mkdir(join(root, ".lake", "packages", "mathlib"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "public", "QC", "state.md"), note("public-state", "State"));
  await writeFile(join(root, "private", "Research", "log.md"), note("private-log", "Log"));
  await writeFile(join(root, ".lake", "packages", "mathlib", "README.md"), note("lake-readme", "Lake"));
  await writeFile(join(root, "node_modules", "pkg", "README.md"), note("pkg-readme", "Pkg"));
  return root;
}

async function scanIds(root: string, workspaceLayout: "wiki" | "legacy"): Promise<string[]> {
  configure({ root, workspaceLayout });
  const notes = await scanRoamNotes();
  return notes.map((entry) => entry.id).filter(Boolean).sort() as string[];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace layout decides whether public/ holds notes", () => {
  test("wiki layout indexes public/ alongside private/", async () => {
    expect(await scanIds(await vault(), "wiki")).toEqual(["private-log", "public-state"]);
  });

  test("legacy layout treats public/ as generated output", async () => {
    expect(await scanIds(await vault(), "legacy")).toEqual(["private-log"]);
  });

  test("build and dependency trees stay excluded in both layouts", async () => {
    const root = await vault();
    for (const layout of ["wiki", "legacy"] as const) {
      const ids = await scanIds(root, layout);
      expect(ids).not.toContain("lake-readme");
      expect(ids).not.toContain("pkg-readme");
    }
  });
});
