import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { parseGitPorcelainStatus } from "../server/lib/git-status.mjs";

describe("git porcelain status", () => {
  test("reads upstream and ahead/behind out of the branch header", () => {
    const parsed = parseGitPorcelainStatus("## work/mac...origin/main [ahead 2, behind 13]");
    expect(parsed.branch).toBe("work/mac");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(13);
    expect(parsed.clean).toBe(true);
    expect(parsed.gone).toBe(false);
  });

  test("handles a branch with no upstream, a gone upstream, and a detached HEAD", () => {
    expect(parseGitPorcelainStatus("## main")).toMatchObject({ branch: "main", upstream: "", ahead: 0, behind: 0 });
    expect(parseGitPorcelainStatus("## main...origin/main [gone]")).toMatchObject({ upstream: "origin/main", gone: true });
    expect(parseGitPorcelainStatus("## HEAD (no branch)")).toMatchObject({ branch: "HEAD", detached: true });
  });

  test("marks a repository that has no commits yet", () => {
    const parsed = parseGitPorcelainStatus("## No commits yet on main");
    expect(parsed).toMatchObject({ branch: "main", initial: true, upstream: "" });
  });

  test("classifies staged, unstaged, untracked and conflicted entries", () => {
    const parsed = parseGitPorcelainStatus([
      "## main...origin/main",
      "M  staged.md",
      " M dirty.md",
      "MM both.md",
      "?? new.md",
      "UU merged.md",
      "D  gone.md",
    ].join("\n"));
    expect(parsed.clean).toBe(false);
    expect(parsed.changedFiles).toBe(6);
    expect(parsed.conflictedFiles).toBe(1);
    expect(parsed.entries.map((entry) => [entry.path, entry.staged, entry.unstaged, entry.untracked, entry.conflicted])).toEqual([
      ["staged.md", true, false, false, false],
      ["dirty.md", false, true, false, false],
      ["both.md", true, true, false, false],
      ["new.md", false, true, true, false],
      ["merged.md", false, false, false, true],
      ["gone.md", true, false, false, false],
    ]);
    expect(parsed.entries.map((entry) => entry.label)).toEqual([
      "Modified", "Modified", "Modified", "Untracked", "Both modified", "Deleted",
    ]);
  });

  test("reads renames in both the arrow form and the NUL form", () => {
    const arrow = parseGitPorcelainStatus('## main\nR  old name.md -> new name.md');
    expect(arrow.entries[0]).toMatchObject({ path: "new name.md", origPath: "old name.md", label: "Renamed" });

    const nul = parseGitPorcelainStatus("## main\0R  new.md\0old.md\0M  other.md\0", { nul: true });
    expect(nul.entries).toHaveLength(2);
    expect(nul.entries[0]).toMatchObject({ path: "new.md", origPath: "old.md" });
    expect(nul.entries[1]).toMatchObject({ path: "other.md", origPath: "" });
  });

  test("decodes C-quoted paths only in the newline form", () => {
    const quoted = parseGitPorcelainStatus('## main\n?? "\\346\\225\\260\\345\\255\\246.md"');
    expect(quoted.entries[0].path).toBe("数学.md");

    const raw = parseGitPorcelainStatus("## main\0?? 数学.md\0", { nul: true });
    expect(raw.entries[0].path).toBe("数学.md");
  });

  test("ignores ignored entries and rebuilds a readable display string", () => {
    const parsed = parseGitPorcelainStatus("## main...origin/main [ahead 1]\n!! build/\n M note.md");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.display).toBe("## main...origin/main [ahead 1]\n M note.md");
  });

  test("survives an empty or malformed payload", () => {
    expect(parseGitPorcelainStatus("")).toMatchObject({ branch: "", clean: true, changedFiles: 0 });
    expect(parseGitPorcelainStatus("nonsense")).toMatchObject({ branch: "", clean: true });
  });
});
