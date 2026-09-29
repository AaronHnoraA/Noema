import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installUpstreamSkill,
  readSkillLock,
  skillUpstreamStatus,
  updateUpstreamSkill,
  upstreamURL,
} from "../server/lib/noema-skill-upstream.mjs";

type Tree = { upstream: string; options: { globalConfigPath: string; environment: Record<string, string> } ; skills: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

async function commitSkill(upstream: string, body: string): Promise<string> {
  await mkdir(join(upstream, "skills", "qiskit"), { recursive: true });
  await writeFile(join(upstream, "skills", "qiskit", "SKILL.md"), `---\nname: qiskit\ndescription: Quantum circuits\n---\n\n${body}\n`);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", body);
  return git(upstream, "rev-parse", "HEAD");
}

async function withUpstream(run: (tree: Tree) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "noema-upstream-"));
  const upstream = join(parent, "upstream");
  try {
    await mkdir(upstream);
    git(upstream, "init", "-q", "-b", "main");
    await writeFile(join(upstream, "LICENSE"), "MIT\n");
    const globalConfigPath = join(parent, "etc", "noema", "capabilities.json");
    await run({ upstream, options: { globalConfigPath, environment: {} }, skills: join(parent, "etc", "noema", "skills") });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

describe("Skill upstream version control", () => {
  test("owner/repo is GitHub shorthand; other locations pass through", () => {
    expect(upstreamURL("K-Dense-AI/claude-scientific-skills")).toBe("https://github.com/K-Dense-AI/claude-scientific-skills.git");
    expect(upstreamURL("ssh://host/Noema/Public-README.git")).toBe("ssh://host/Noema/Public-README.git");
    expect(() => upstreamURL("--upload-pack=x")).toThrow();
  });

  test("install locks a commit, check sees upstream movement, update records history and rollback pins", async () => withUpstream(async ({ upstream, options, skills }) => {
    const v1 = await commitSkill(upstream, "Version one.");
    const installed = await installUpstreamSkill({ ...options, repository: upstream, path: "skills/qiskit", license: "MIT" });
    expect(installed.id).toBe("qiskit");
    expect(await readFile(join(skills, "qiskit", "SKILL.md"), "utf8")).toContain("Version one.");
    // A subdirectory Skill carries the repository licence with it.
    expect(await readFile(join(skills, "qiskit", "LICENSE"), "utf8")).toBe("MIT\n");
    const { lock } = await readSkillLock(options);
    expect(lock.skills).toEqual([expect.objectContaining({ id: "qiskit", commit: v1, ref: "HEAD", path: "skills/qiskit",
      skill_sha256: expect.any(String), tree_sha256: expect.any(String) })]);
    await expect(installUpstreamSkill({ ...options, repository: upstream, path: "skills/qiskit" })).rejects.toThrow(/already locked/);

    expect((await skillUpstreamStatus({ ...options, check: true })).skills[0]).toMatchObject({ local: "clean", latest: v1, updateAvailable: false });
    const v2 = await commitSkill(upstream, "Version two.");
    expect((await skillUpstreamStatus({ ...options, check: true })).skills[0]).toMatchObject({ latest: v2, updateAvailable: true });

    const preview = await updateUpstreamSkill({ ...options, id: "qiskit", dryRun: true });
    expect(preview).toMatchObject({ updated: false, state: "available", from: v1, to: v2, files: { changed: ["SKILL.md"] } });
    expect(preview.diff).toContain("+Version two.");
    expect(await readFile(join(skills, "qiskit", "SKILL.md"), "utf8")).toContain("Version one.");

    expect(await updateUpstreamSkill({ ...options, id: "qiskit" })).toMatchObject({ updated: true, to: v2 });
    expect(await readFile(join(skills, "qiskit", "SKILL.md"), "utf8")).toContain("Version two.");
    let entry = (await readSkillLock(options)).lock.skills[0];
    expect(entry).toMatchObject({ commit: v2, history: [{ commit: v1 }] });
    expect(await updateUpstreamSkill({ ...options, id: "qiskit" })).toMatchObject({ updated: false, state: "current" });

    expect(await updateUpstreamSkill({ ...options, id: "qiskit", commit: v1 })).toMatchObject({ updated: true, to: v1 });
    expect(await readFile(join(skills, "qiskit", "SKILL.md"), "utf8")).toContain("Version one.");
    entry = (await readSkillLock(options)).lock.skills[0];
    expect(entry.history?.map((item: any) => item.commit)).toEqual([v1, v2]);
  }));

  test("local edits are detected and never discarded without force", async () => withUpstream(async ({ upstream, options, skills }) => {
    await commitSkill(upstream, "Version one.");
    await installUpstreamSkill({ ...options, repository: upstream, path: "skills/qiskit" });
    await writeFile(join(skills, "qiskit", "notes.md"), "mine\n");
    expect((await skillUpstreamStatus(options)).skills[0].local).toBe("modified");
    await commitSkill(upstream, "Version two.");
    await expect(updateUpstreamSkill({ ...options, id: "qiskit" })).rejects.toThrow(/edited locally.*project patch/);
    expect(await readFile(join(skills, "qiskit", "notes.md"), "utf8")).toBe("mine\n");
    const forced = await updateUpstreamSkill({ ...options, id: "qiskit", force: true });
    expect(forced).toMatchObject({ updated: true, files: { removed: ["notes.md"] } });
    expect((await readSkillLock(options)).lock.skills[0].history?.[0]).toMatchObject({ discarded_local_edit: true });
    expect((await skillUpstreamStatus(options)).skills[0].local).toBe("clean");
  }));

  test("refuses symlinks, a missing SKILL.md and an occupied directory", async () => withUpstream(async ({ upstream, options, skills }) => {
    await commitSkill(upstream, "Version one.");
    await expect(installUpstreamSkill({ ...options, repository: upstream, path: "nowhere" })).rejects.toThrow();
    await expect(installUpstreamSkill({ ...options, repository: upstream, path: "../x" })).rejects.toThrow(/Invalid upstream Skill path/);
    await mkdir(join(skills, "qiskit"), { recursive: true });
    await expect(installUpstreamSkill({ ...options, repository: upstream, path: "skills/qiskit" })).rejects.toThrow(/not overwritten/);
    await rm(join(skills, "qiskit"), { recursive: true });
    await symlink("/etc/hosts", join(upstream, "skills", "qiskit", "hosts"));
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "link");
    await expect(installUpstreamSkill({ ...options, repository: upstream, path: "skills/qiskit" })).rejects.toThrow(/symlink/);
    expect((await readSkillLock(options)).lock.skills).toEqual([]);
  }));
});
