import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  coalesceWikiRefreshMode,
  wikiFullRefreshProbability,
  wikiMutationFiles,
  wikiSyncIndexRefreshPlan,
} from "../server/lib/wiki-index-refresh.mjs";

describe("Wiki DB refresh planning", () => {
  test("collects every file shape returned by first-party mutations", () => {
    expect(wikiMutationFiles({
      type: "wiki-page-moved",
      file: "/notes/new.md",
      oldFile: "/notes/old.md",
      survivorFile: "/notes/a.md",
      redirectFile: "/notes/b.md",
      outputFile: "/notes/.cell/a.output.python.json",
      jsFile: "/notes/.slides/a.js",
      cssFile: "/notes/.slides/a.css",
      changedPaths: ["/notes/git.md"],
      changed: [{ file: "/notes/tagged.md" }, "/notes/rewritten.md"],
    }, ["/notes/fallback.md"])).toEqual([
      "/notes/fallback.md",
      "/notes/new.md",
      "/notes/old.md",
      "/notes/a.md",
      "/notes/b.md",
      "/notes/.cell/a.output.python.json",
      "/notes/.slides/a.js",
      "/notes/.slides/a.css",
      "/notes/git.md",
      "/notes/tagged.md",
      "/notes/rewritten.md",
    ]);
  });

  test("uses incremental refresh normally and probabilistic full self-heal", () => {
    expect(wikiSyncIndexRefreshPlan(
      { phase: "idle", changedPaths: ["/notes/a.md"] },
      { fullProbability: 0.1, random: () => 0.5 },
    )).toMatchObject({ mode: "incremental", changedFiles: ["/notes/a.md"] });
    expect(wikiSyncIndexRefreshPlan(
      { phase: "idle", changedPaths: ["/notes/a.md"] },
      { fullProbability: 0.1, random: () => 0.05 },
    )).toMatchObject({ mode: "full", changedFiles: ["/notes/a.md"] });
    expect(wikiSyncIndexRefreshPlan({ phase: "conflicted" })).toBeNull();
    expect(wikiSyncIndexRefreshPlan({ phase: "error" })).toBeNull();
  });

  test("clamps configuration and lets full refresh win coalescing", () => {
    expect(wikiFullRefreshProbability(-2)).toBe(0);
    expect(wikiFullRefreshProbability(4)).toBe(1);
    expect(coalesceWikiRefreshMode("incremental", "auto")).toBe("incremental");
    expect(coalesceWikiRefreshMode("incremental", "full")).toBe("full");
  });
});
