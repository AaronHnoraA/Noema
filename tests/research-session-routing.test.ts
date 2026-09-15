import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { parseResearchDirectives } from "../server/lib/research-directives.mjs";
import { createResearchCell, createResearchNotebook, setResearchRelation } from "../server/lib/research-notebook.mjs";
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

  test("slugs are readable, never reserved, and fall back to work", () => {
    expect(sessionNameSlug("  Hello World! 实验 ")).toBe("hello-world-实验");
    expect(sessionNameSlug("fresh")).toBe("work");
    expect(sessionNameSlug("!!!")).toBe("work");
  });
});

describe("D-031 DAG-derived session routes", () => {
  test("a root work starts a named session from its title, unique in the project", () => {
    const { notebook, a } = chain();
    expect(deriveSessionRoute({ notebook, workNodeId: a, agent: "codex" }))
      .toMatchObject({ action: "create", name: "baseline-model", rule: "root", origin: "derived" });
    expect(deriveSessionRoute({ notebook, workNodeId: a, agent: "codex", names: [named("baseline-model")] }))
      .toMatchObject({ action: "create", name: "baseline-model-2" });
  });

  test("work that already ran continues its own session", () => {
    const { notebook, a } = chain();
    const route = deriveSessionRoute({
      notebook, workNodeId: a, agent: "codex",
      runs: [{ workNodeId: a, sessionId: "ses_baseline", sessionName: "baseline" }],
      names: [named("baseline", { lastRun: { workNodeId: a } })],
    });
    expect(route).toMatchObject({ action: "continue", name: "baseline", rule: "own" });
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
