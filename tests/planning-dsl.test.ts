import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Shared ESM module outside the TS app graph.
import {
  PLANNING_KINDS,
  patchPlanningNodeRaw,
  scanPlanningNodes,
} from "../shared/planning-dsl.mjs";
// @ts-ignore Shared ESM module outside the TS app graph.
import {
  formatDateValue,
  formatDuration,
  parseDateValue,
  parseDepRefs,
  parseDuration,
  parseLeadTime,
  parseRepeater,
} from "../shared/planning-values.mjs";

describe("planning DSL parser", () => {
  test("parses existing inline todo syntax as span-aware planning nodes", () => {
    const [todo] = scanPlanningNodes("@@todo(doing) [Build Gantt]{project: notes, sche: 2026-07-06}");
    expect(todo).toMatchObject({
      kind: "todo",
      status: "doing",
      title: "Build Gantt",
      attrs: { project: "notes", sche: "2026-07-06" },
      shape: "inline",
      span: { from: 0, line: 1, column: 1 },
    });
  });

  test("parses itodo as a todo-compatible planning node while preserving kind", () => {
    const [todo] = scanPlanningNodes("@@itodo(doing) [Side task]{project: notes}", { kind: "todo" });
    expect(todo).toMatchObject({
      kind: "itodo",
      status: "doing",
      title: "Side task",
      attrs: { project: "notes" },
      shape: "inline",
    });
    expect(patchPlanningNodeRaw(todo, { status: "done" }))
      .toContain("@@itodo(done) [Side task]");
  });

  test("parses block attrs for larger project/todo entries", () => {
    const [project] = scanPlanningNodes([
      "@@project(active) [Notes App] {",
      "  area: tooling",
      "  goal: \"Org-level project planning\"",
      "}",
    ].join("\n"));
    expect(project).toMatchObject({
      kind: "project",
      status: "active",
      title: "Notes App",
      attrs: { area: "tooling", goal: "Org-level project planning" },
      shape: "block",
    });
  });

  test("parses plain-title project and milestone commands", () => {
    const nodes = scanPlanningNodes([
      "@@project(active) ISO 202603 tensor paper {",
      "  area: UNSW",
      "}",
      "@@milestone Internal proof freeze {project: iso-202603, date: 2026-07-17}",
    ].join("\n"));
    expect(nodes.map((node) => [node.kind, node.title, node.shape])).toEqual([
      ["project", "ISO 202603 tensor paper", "block"],
      ["milestone", "Internal proof freeze", "inline"],
    ]);
  });

  test("parses indented block closes and does not emit a partial inline node", () => {
    const nodes = scanPlanningNodes([
      "  @@todo(doing) [Indented task] {",
      "    project: iso-202603",
      "    progress: 25",
      "  }",
    ].join("\n"));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "todo",
      title: "Indented task",
      attrs: { project: "iso-202603", progress: "25" },
      shape: "block",
      span: { line: 1, column: 3 },
    });
  });

  test("does not parse an unterminated block-like todo as an attr-less inline todo", () => {
    expect(scanPlanningNodes([
      "@@todo(doing) [Broken block] {",
      "  project: iso-202603",
    ].join("\n"))).toEqual([]);
  });

  test("patches inline attrs while preserving command source", () => {
    const [todo] = scanPlanningNodes("@@todo(doing) [Ship it]{due: 2026-07-07}");
    expect(patchPlanningNodeRaw(todo, { attrs: { progress: 50 } }))
      .toContain("progress=50");
  });

  test("patches title planning command attrs", () => {
    const [project] = scanPlanningNodes("@@project(active) ISO Paper {area: UNSW}");
    expect(patchPlanningNodeRaw(project, { attrs: { project: "iso-202603", area: null } }))
      .toBe("@@project(active) ISO Paper {project=iso-202603}");
  });

  test("no longer recognizes the retired note/property kinds", () => {
    expect(PLANNING_KINDS.has("note")).toBe(false);
    expect(PLANNING_KINDS.has("property")).toBe(false);
    expect(scanPlanningNodes("@@note [Some aside] {tags: x}")).toEqual([]);
    expect(scanPlanningNodes("@@property(active) [Some prop] {area: x}")).toEqual([]);
  });

  test("flags an invalid date value as a diagnostic without dropping the node", () => {
    const [todo] = scanPlanningNodes("@@todo [Bad date] {due: not-a-date}");
    expect(todo).toBeTruthy();
    expect(todo.diagnostics).toMatchObject([{ kind: "invalid-date", key: "due" }]);
  });

  test("flags an invalid repeater value as a diagnostic", () => {
    const [todo] = scanPlanningNodes("@@todo [Bad repeat] {due: 2026-07-07, repeat: every-day}");
    expect(todo.diagnostics).toMatchObject([{ kind: "invalid-repeater", key: "repeat" }]);
  });

  test("flags an invalid effort duration as a diagnostic", () => {
    const [todo] = scanPlanningNodes("@@todo [Bad effort] {effort: not-a-duration}");
    expect(todo.diagnostics).toMatchObject([{ kind: "invalid-duration", key: "effort" }]);
  });

  test("flags an unrecognized attr key as a diagnostic", () => {
    const [todo] = scanPlanningNodes("@@todo [Typo key] {duee: 2026-07-07}");
    expect(todo.diagnostics).toMatchObject([{ kind: "unknown-key", key: "duee" }]);
  });

  test("valid attrs produce no diagnostics", () => {
    const [todo] = scanPlanningNodes("@@todo(doing) [Fine] {due: 2026-07-07, repeat: +1w, effort: 2h, after: \"other task\"}");
    expect(todo.diagnostics).toEqual([]);
  });
});

describe("planning value grammar", () => {
  test("parseDateValue supports today/tomorrow/relative/ISO/CJK forms", () => {
    expect(parseDateValue("today")).toMatchObject({ hasTime: false });
    expect(parseDateValue("2026-07-07")).toMatchObject({ hasTime: false });
    expect(parseDateValue("2026-07-07 09:30")).toMatchObject({ hasTime: true });
    expect(parseDateValue("not-a-date")).toBeNull();
  });

  test("parseDateValue treats ISO timezone timestamps as local planning wall time", () => {
    const utc = parseDateValue("2026-07-07T23:30:00Z");
    const offset = parseDateValue("2026-07-07T23:30:00+02:00");
    expect(utc && formatDateValue(utc.time, utc.hasTime)).toBe("2026-07-07 23:30");
    expect(offset && formatDateValue(offset.time, offset.hasTime)).toBe("2026-07-07 23:30");
  });

  test("parseRepeater grammar and applyRepeater semantics are re-exported unchanged", () => {
    expect(parseRepeater("+1w")).toEqual({ mode: "+", n: 1, unit: "w" });
    expect(parseRepeater("garbage")).toBeNull();
  });

  test("parseLeadTime supports day/week/month units and falls back to 14", () => {
    expect(parseLeadTime("3d")).toBe(3);
    expect(parseLeadTime("2w")).toBe(14);
    expect(parseLeadTime("")).toBe(14);
  });

  test("parseDepRefs splits on & and recognizes [[Title]]::text", () => {
    expect(parseDepRefs("first & [[Note]]::second")).toEqual([
      { id: null, noteTitle: null, text: "first", raw: "first" },
      { id: null, noteTitle: "Note", text: "second", raw: "[[Note]]::second" },
    ]);
  });

  test("parseDepRefs recognizes a stable #id ref", () => {
    expect(parseDepRefs("#abc123")).toEqual([
      { id: "abc123", noteTitle: null, text: "", raw: "#abc123" },
    ]);
    expect(parseDepRefs("#abc123 & other task")).toEqual([
      { id: "abc123", noteTitle: null, text: "", raw: "#abc123" },
      { id: null, noteTitle: null, text: "other task", raw: "other task" },
    ]);
  });

  test("parseDuration reads h/m/d/H:MM forms; d is an 8-hour workday", () => {
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("1d")).toBe(480);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("nonsense")).toBeNull();
  });

  test("formatDuration is the inverse of parseDuration for H:MM display", () => {
    expect(formatDuration(90)).toBe("1:30");
    expect(formatDuration(480)).toBe("8:00");
  });
});
