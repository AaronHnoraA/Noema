import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { parseResearchDirectives } from "../server/lib/research-directives.mjs";
import { createResearchCell, createResearchNotebook, setResearchRelation, researchWorkNodeForCell } from "../server/lib/research-notebook.mjs";
import {
  deriveSessionRoute,
  parseSessionDirective,
  sessionNameSlug,
  validateSessionName,
} from "../server/lib/research-session-routing.mjs";

function chain() {
  let notebook = createResearchNotebook({ title: "Routing" });
  const a = createResearchCell(notebook, { kind: "work", title: "Baseline model", source: "Fit it." });
  notebook = a.notebook;
  const q = createResearchCell(notebook, { kind: "question", title: "Why so weak", source: "?", lineageParent: a.workNode.id });
  notebook = q.notebook;
  const b = createResearchCell(notebook, { kind: "work", title: "Add features", source: "Try.", lineageParent: q.workNode.id });
  notebook = b.notebook;
  const c = createResearchCell(notebook, { kind: "work", title: "Ablate", source: "Try.", lineageParent: q.workNode.id });
  notebook = c.notebook;
  return { notebook, a: a.workNode.id, q: q.workNode.id, b: b.workNode.id, c: c.workNode.id };
}

const named = (name: string, extra: Record<string, unknown> = {}) => ({
  name, agent: "codex", sessionId: `ses_${name}`, aliases: [], state: "active", ...extra,
});

describe("D-031 session directive grammar", () => {
  test("accepts keywords, names, parent:child and :child", () => {
    expect(parseSessionDirective("")).toEqual({ kind: "none" });
    expect(parseSessionDirective("fresh")).toEqual({ kind: "keyword", keyword: "fresh" });
    expect(parseSessionDirective("主线")).toEqual({ kind: "name", name: "主线" });
    expect(parseSessionDirective("baseline:ablation")).toEqual({ kind: "fork", parent: "baseline", child: "ablation" });
    expect(parseSessionDirective(":ablation")).toEqual({ kind: "fork", parent: "", child: "ablation" });
    expect(parseSessionDirective("pi:helper")).toEqual({ kind: "fork", parent: "pi", child: "helper" });
    expect(() => parseSessionDirective("a:b:c")).toThrow(/one parent:child/);
    expect(() => parseSessionDirective("pi")).toThrow(/coordinator/);
    expect(() => parseSessionDirective("has space")).toThrow(/invalid session name/);
    expect(() => validateSessionName("continue")).toThrow(/reserved/);
  });

  test("the directive parser validates @@session through the same grammar", () => {
    expect(parseResearchDirectives("@@session(baseline:ablation)\n\nGo.").session).toBe("baseline:ablation");
    expect(() => parseResearchDirectives("@@session(bad name)\n\nGo.")).toThrow(/@@session\(bad name\)/);
  });

  test("visible Agenda is parsed for the UI and removed from the Agent prompt", () => {
    const parsed = parseResearchDirectives([
      "@@agent(codex)",
      "@@todo [Plan the proof] {",
      "  sche: 2026-09-16 10:30",
      "  prio: A",
      "}",
      "@@clock [Plan the proof] {id=focus_1, from=\"2026-09-16 09:00\", to=\"2026-09-16 10:00\"}",
      "",
      "Write the proof.",
      "@@todo [this later text is data]",
    ].join("\n"));
    expect(parsed.agenda).toMatchObject({ sche: "2026-09-16 10:30", prio: "A",
      clocks: [{ id: "focus_1", from: "2026-09-16 09:00", to: "2026-09-16 10:00" }] });
    expect(parsed.prompt).toBe("Write the proof.\n@@todo [this later text is data]");
  });

  test("slugs are readable, never reserved, and fall back to work", () => {
    expect(sessionNameSlug("  Hello World! 实验 ")).toBe("hello-world-实验");
    expect(sessionNameSlug("fresh")).toBe("work");
    expect(sessionNameSlug("!!!")).toBe("work");
  });

  test("keyword lookalikes are refused instead of silently naming a session", () => {
    expect(() => parseSessionDirective("refresh")).toThrow(/not an @@session keyword; did you mean @@session\(fresh\)/);
    expect(() => parseSessionDirective("Fresh")).toThrow(/did you mean @@session\(fresh\)/);
    expect(() => parseSessionDirective("resume")).toThrow(/@@session\(continue\)/);
    expect(() => parseSessionDirective("refresh:child")).toThrow(/@@session\(fresh\)/);
    expect(parseSessionDirective("refresh-notes")).toEqual({ kind: "name", name: "refresh-notes" });
    expect(() => parseResearchDirectives("@@session(refresh)\n\nGo.")).toThrow(/@@session\(refresh\).*fresh/);
    expect(sessionNameSlug("Refresh")).toBe("work");
  });
});

describe("D-031 DAG-derived session routes", () => {
  test("unspecified agents inherit current lineage directives before document defaults or stale sessions", () => {
    const { notebook, a, b } = chain();
    notebook.cells[0].source = "@@agent(opencode)\nRead.";
    const options = { notebook, workNodeId: b, defaultAgent: "codex",
      runs: [{ workNodeId: a, sessionId: "ses_parent" }, { workNodeId: b, sessionId: "ses_old" }],
      names: [named("parent", { agent: "opencode", lastRun: { workNodeId: a } }), named("old")],
    };
    expect(deriveSessionRoute(options)).toMatchObject({ agent: "opencode", action: "continue", name: "parent" });
    expect(deriveSessionRoute({ ...options, agent: "codex" })).toMatchObject({ agent: "codex", action: "fork" });
    notebook.cells[0].source = "@@agent(claude-code)\nRead.";
    expect(deriveSessionRoute(options).agent).toBe("claude-code");
  });

  test("merge agent conflicts need explicit choice and depends never inherits agents", () => {
    let { notebook, a, b, c } = chain();
    notebook.cells[0].source = "@@agent(opencode)\nRead.";
    notebook.cells.find((cell) => researchWorkNodeForCell(notebook, cell)?.id === b)!.source = "@@agent(codex)\nTry.";
    notebook = setResearchRelation(notebook, c, "lineage", [a, b]).notebook;
    expect(() => deriveSessionRoute({ notebook, workNodeId: c })).toThrow(/different agents/);
    expect(deriveSessionRoute({ notebook, workNodeId: c, agent: "codex" }).agent).toBe("codex");
    // A document default agent is an explicit choice and settles the merge.
    notebook.metadata.noema_research.default_agent = "claude";
    expect(deriveSessionRoute({ notebook, workNodeId: c }).agent).toBe("claude");
    delete notebook.metadata.noema_research.default_agent;
    notebook = setResearchRelation(notebook, c, "lineage", []).notebook;
    notebook = setResearchRelation(notebook, c, "depends", [a]).notebook;
    expect(deriveSessionRoute({ notebook, workNodeId: c }).agent).toBe("codex");
  });

  test("a root work starts a named session from its title, unique in the project", () => {
    const { notebook, a } = chain();
    expect(deriveSessionRoute({ notebook, workNodeId: a, agent: "codex" }))
      .toMatchObject({ action: "create", name: "baseline-model", rule: "root", origin: "derived" });
    expect(deriveSessionRoute({ notebook, workNodeId: a, agent: "codex", names: [named("baseline-model")] }))
      .toMatchObject({ action: "create", name: "baseline-model-2" });
  });

  test("re-running work that alone owns its session restarts that name from the document", () => {
    const { notebook, a } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: a, agent: "codex",
      runs: [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }],
      names: [named("baseline", { lastRun: { workNodeId: a } })],
    });
    expect(route).toMatchObject({ action: "rebind", name: "baseline", parentName: "", rule: "rerun", fromWorkNodeId: "" });
  });

  test("re-running work that shares its parent's session branches from upstream", () => {
    const { notebook, a, b } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: b, agent: "codex",
      runs: [
        { workNodeId: b, sessionId: "ses_baseline", sessionName: "baseline" },
        { workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" },
      ],
      names: [named("baseline", { lastRun: { workNodeId: b } })],
    });
    expect(route).toMatchObject({
      action: "fork", name: "baseline/add-features", parentName: "baseline", forkMode: "reconstructed",
      rule: "rerun-branch", fromWorkNodeId: a, autoContext: ["lineage"],
    });
  });

  test("a re-run of a block that is still running queues on its session", () => {
    const { notebook, a } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: a, agent: "codex",
      runs: [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }],
      names: [named("baseline", { lastRun: { workNodeId: a }, openRun: true })],
    });
    expect(route).toMatchObject({ action: "continue", name: "baseline", rule: "rerun-queued" });
  });

  test("a new conversation sees upstream blocks that never ran", () => {
    let notebook = createResearchNotebook({ title: "Context" });
    const question = createResearchCell(notebook, { kind: "question", title: "Maintain the docs", source: "Keep them current." });
    notebook = question.notebook;
    const work = createResearchCell(notebook, { kind: "work", title: "Read the background", source: "Read every file.",
      lineageParent: question.workNode.id });
    notebook = work.notebook;
    expect(deriveSessionRoute({ notebook, workNodeId: work.workNode.id, agent: "opencode" }))
      .toMatchObject({ action: "create", rule: "lineage-new", autoContext: ["lineage"] });
    expect(deriveSessionRoute({ notebook, workNodeId: question.workNode.id, agent: "opencode" }))
      .toMatchObject({ action: "create", rule: "root", autoContext: [] });
  });

  test("a straight lineage chain continues through non-running question nodes", () => {
    const { notebook, a, b } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: b, agent: "codex",
      runs: [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }],
      names: [named("baseline", { lastRun: { workNodeId: a } })],
    });
    expect(route).toMatchObject({ action: "continue", name: "baseline", rule: "lineage-continue", fromWorkNodeId: a });
  });

  test("current straight lineage heals an older per-cell session assignment", () => {
    const { notebook, a, b } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: b, agent: "codex",
      runs: [
        { workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" },
        { workNodeId: b, sessionId: "ses_old_child", sessionName: "old-child" },
      ],
      names: [
        named("baseline", { lastRun: { workNodeId: a } }),
        named("old-child", { sessionId: "ses_old_child", lastRun: { workNodeId: b } }),
      ],
    });
    expect(route).toMatchObject({
      action: "continue", name: "baseline", rule: "lineage-continue", fromWorkNodeId: a,
    });

    const queued = deriveSessionRoute({
      notebook, workNodeId: b, agent: "codex",
      runs: [
        { workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" },
        { workNodeId: b, sessionId: "ses_old_child", sessionName: "old-child" },
      ],
      names: [
        named("baseline", { lastRun: { workNodeId: a }, openRun: true }),
        named("old-child", { sessionId: "ses_old_child", lastRun: { workNodeId: b } }),
      ],
    });
    expect(queued).toMatchObject({ action: "continue", name: "baseline", rule: "lineage-continue" });
  });

  test("a conversation that left the lineage is not sticky after the parent moved on", () => {
    const { notebook, a, b, c } = chain();
    // b once ran under a since-removed @@session(side); c later continued baseline.
    const runs = [
      { workNodeId: c, sessionId: "ses_baseline", sessionName: "baseline" },
      { workNodeId: b, sessionId: "ses_side", sessionName: "side" },
      { workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" },
    ];
    const names = [named("baseline", { lastRun: { workNodeId: c } }), named("side", { lastRun: { workNodeId: b } })];
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names })).toMatchObject({
      action: "fork", name: "baseline/add-features", parentName: "baseline", rule: "lineage-branch", autoContext: ["lineage"],
    });
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names, directive: parseSessionDirective("continue") }))
      .toMatchObject({ action: "continue", name: "baseline", rule: "directive-continue", fromWorkNodeId: a });

    // Once branched, the fork descends from the lineage conversation and keeps
    // its name; a re-run restarts it from the upstream block.
    const branchedRuns = [{ workNodeId: b, sessionId: "ses_branch", sessionName: "baseline/add-features" }, ...runs];
    const branchedNames = [...names, named("baseline/add-features", { parentName: "baseline", lastRun: { workNodeId: b } })];
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs: branchedRuns, names: branchedNames }))
      .toMatchObject({ action: "rebind", name: "baseline/add-features", parentName: "baseline", rule: "rerun", fromWorkNodeId: a });
  });

  test("a sibling branch gets a reconstructed child with lineage context", () => {
    const { notebook, a, b, c } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: c, agent: "codex",
      runs: [
        { workNodeId: b, sessionId: "ses_baseline", sessionName: "baseline" },
        { workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" },
      ],
      names: [named("baseline", { lastRun: { workNodeId: b } })],
    });
    expect(route).toMatchObject({
      action: "fork", name: "baseline/ablate", parentName: "baseline", forkMode: "reconstructed",
      rule: "lineage-branch", autoContext: ["lineage"],
    });
  });

  test("merging lineage parents starts a new session and depends never carries conversation", () => {
    let { notebook, a, b, c } = chain();
    notebook = setResearchRelation(notebook, c, "lineage", [a, b]).notebook;
    notebook = setResearchRelation(notebook, b, "depends", [a]).notebook;
    const runs = [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }];
    const names = [named("baseline", { lastRun: { workNodeId: a } })];
    expect(deriveSessionRoute({ notebook, workNodeId: c, agent: "codex", runs, names }))
      .toMatchObject({ action: "create", name: "ablate", rule: "lineage-merge", autoContext: ["lineage"] });
  });

  test("changing agent hands a conversation over instead of reusing it", () => {
    const { notebook, a } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: a, agent: "claude",
      runs: [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }],
      names: [named("baseline", { lastRun: { workNodeId: a } })],
    });
    expect(route).toMatchObject({ action: "fork", name: "baseline@claude", parentName: "baseline", rule: "own-agent-change" });
  });

  test("explicit directives outrank Pi, which outranks derivation", () => {
    const { notebook, a, b } = chain();
    const runs = [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }];
    const names = [named("baseline", { lastRun: { workNodeId: a } }), named("helper")];
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names, requestedName: "helper" }))
      .toMatchObject({ action: "continue", name: "helper", origin: "pi" });
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names, requestedName: "helper",
      directive: parseSessionDirective("fresh") })).toMatchObject({ action: "create", name: "add-features", origin: "user" });
    expect(() => deriveSessionRoute({ notebook, workNodeId: b, agent: "claude", runs, names,
      directive: parseSessionDirective("baseline") })).toThrow(/belongs to agent codex/);
  });

  test("parent:child forks once, then continues the child; :child needs an inherited parent", () => {
    const { notebook, a, b } = chain();
    const runs = [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }];
    const names = [named("baseline", { lastRun: { workNodeId: a } })];
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names,
      directive: parseSessionDirective("baseline:ablation") }))
      .toMatchObject({ action: "fork", name: "ablation", parentName: "baseline", forkMode: "native", allowNative: true });
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names: [...names, named("ablation")],
      directive: parseSessionDirective("baseline:ablation") })).toMatchObject({ action: "continue", name: "ablation" });
    expect(deriveSessionRoute({ notebook, workNodeId: b, agent: "codex", runs, names,
      directive: parseSessionDirective(":ablation") })).toMatchObject({ action: "fork", parentName: "baseline" });
    expect(() => deriveSessionRoute({ notebook, workNodeId: a, agent: "codex",
      directive: parseSessionDirective(":ablation") })).toThrow(/no inherited session/);
  });

  test("aliases resolve renamed sessions and archived names are refused", () => {
    const { notebook, a } = chain();
    const names = [named("main", { aliases: ["baseline"] }), named("old", { state: "archived" })];
    expect(deriveSessionRoute({ notebook, workNodeId: a, agent: "codex", names, directive: parseSessionDirective("baseline") }))
      .toMatchObject({ action: "continue", name: "main" });
    expect(() => deriveSessionRoute({ notebook, workNodeId: a, agent: "codex", names, directive: parseSessionDirective("old") }))
      .toThrow(/archived/);
  });
});
