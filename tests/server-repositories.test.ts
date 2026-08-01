import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  serverRepositoryContentSignature,
  syncServerRepositories,
  syncServerRepository,
} from "../server/lib/server-repositories.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function seedRemote(root: string, name: string, branch: "main" | "master") {
  const remote = join(root, `${name}.git`);
  const work = join(root, `${name}-source`);
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", branch, work]);
  await writeFile(join(work, "README.md"), `# ${name}\n`);
  await execFileAsync("git", ["-C", work, "add", "README.md"]);
  await execFileAsync("git", ["-C", work, "-c", "user.name=Noema Test", "-c", "user.email=noema@example.test", "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", work, "remote", "add", "origin", remote]);
  await execFileAsync("git", ["-C", work, "push", "-u", "origin", branch]);
  await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  return { remote, work };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Server repository mirrors", () => {
  test("reports unchanged content without rebuilding when repository heads stay stable", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-server-stable-"));
    roots.push(root);
    const { remote } = await seedRemote(root, "notes", "main");
    const config = {
      repositoriesRoot: join(root, "repos"),
      stateRoot: join(root, "state"),
      repositories: [{ id: "public/notes", name: "notes", partition: "public", branch: "auto", url: remote }],
    } as const;

    const first = await syncServerRepositories(config);
    const second = await syncServerRepositories(config, { previousState: first });

    expect(first.contentChanged).toBe(true);
    expect(second.contentChanged).toBe(false);
    expect(serverRepositoryContentSignature(config, second, first))
      .toBe(serverRepositoryContentSignature(config, first));
  });

  for (const branch of ["main", "master"] as const) {
    test(`detects remote ${branch} and restores an exact checkout`, async () => {
      const root = await mkdtemp(join(tmpdir(), `noema-server-${branch}-`));
      roots.push(root);
      const { remote, work } = await seedRemote(root, "notes", branch);
      const config = { repositoriesRoot: join(root, "repos"), stateRoot: join(root, "state") };
      const repository = { id: "public/notes", name: "notes", partition: "public", branch: "auto", url: remote } as const;

      const first = await syncServerRepository(config, repository);
      expect(first.branch).toBe(branch);
      const checkout = first.path;
      await writeFile(join(checkout, "README.md"), "local edit\n");
      await writeFile(join(checkout, "untracked.txt"), "remove me\n");
      await writeFile(join(work, "README.md"), `# ${branch} updated\n`);
      await execFileAsync("git", ["-C", work, "add", "README.md"]);
      await execFileAsync("git", ["-C", work, "-c", "user.name=Noema Test", "-c", "user.email=noema@example.test", "commit", "-m", "update"]);
      await execFileAsync("git", ["-C", work, "push", "origin", branch]);

      const second = await syncServerRepository(config, repository);
      expect(second.branch).toBe(branch);
      expect(await readFile(join(checkout, "README.md"), "utf8")).toBe(`# ${branch} updated\n`);
      await expect(readFile(join(checkout, "untracked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  test("prefers main when the remote HEAD points at a nonstandard branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-server-nonstandard-head-"));
    roots.push(root);
    const { remote, work } = await seedRemote(root, "notes", "main");
    await execFileAsync("git", ["-C", work, "switch", "-c", "temporary-work"]);
    await execFileAsync("git", ["-C", work, "push", "origin", "temporary-work"]);
    await execFileAsync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/temporary-work"]);
    const config = { repositoriesRoot: join(root, "repos"), stateRoot: join(root, "state") };
    const repository = { id: "public/notes", name: "notes", partition: "public", branch: "auto", url: remote } as const;

    const result = await syncServerRepository(config, repository);

    expect(result.branch).toBe("main");
  });
});
