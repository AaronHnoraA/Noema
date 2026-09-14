import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("research deep-link surfaces", () => {
  test("resolves notebook ids through the research authority before focusing a cell", () => {
    const jupyter = read("aaronnote/jupyter-main.ts");
    const runtime = read("server/lib/research-runtime.mjs");
    expect(jupyter).toContain("api.research.resolveCell({ notebookId, cellId })");
    expect(jupyter).toContain("openDocument({ scriptFile, sourceFile: scriptFile, cellId })");
    expect(runtime).toContain("provider().resolveCell({ root, notebookId, cellId })");
    expect(runtime).toContain("The indexed research cell is no longer present");
  });

  test("keeps artifact transport headless and ships no browser research console", () => {
    const root = process.cwd();
    const runtime = read("server/lib/research-runtime.mjs");
    const host = read("web-host.mjs");
    const vite = read("vite.aaronnote.config.ts");
    expect(runtime).toContain("async readArtifact(body = {})");
    expect(existsSync(join(root, "aaronnote/artifact.html"))).toBe(false);
    expect(existsSync(join(root, "aaronnote/research.html"))).toBe(false);
    expect(host).not.toContain('url.pathname === "/research"');
    expect(vite).not.toMatch(/(?:artifact|research)\.html/);
    expect(host).not.toMatch(/(?:reviewProposal|respondInput|decidePermission): function/);
    expect(host).not.toMatch(/(?:createTask|createJob|createDelegation): function/);
  });
});
