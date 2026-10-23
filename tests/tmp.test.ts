import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noemaTmpRoot, configureTmpRoot, runtimeMkdtemp } from "../server/lib/tmp.mjs";

describe("Noema runtime temporary root", () => {
  const originalRoot = noemaTmpRoot();
  afterEach(() => configureTmpRoot(originalRoot));

  it("passes a real workdir to agents when Emacs is reached through a symlink", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "noema-tmp-root-"));
    try {
      const realConfig = join(fixture, "config", "emacs");
      await mkdir(realConfig, { recursive: true });
      const emacsLink = join(fixture, ".emacs.d");
      await symlink(realConfig, emacsLink);
      const canonicalConfig = await realpath(realConfig);
      const root = configureTmpRoot(join(emacsLink, "var", "noema", "tmp"));
      expect(root).toBe(join(canonicalConfig, "var", "noema", "tmp"));

      const workdir = await runtimeMkdtemp("latex-export", "note.md");
      expect(workdir.startsWith(join(canonicalConfig, "var", "noema", "tmp", "latex-export"))).toBe(true);
      expect(workdir).toBe(await realpath(workdir));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
