// @vitest-environment node
import { afterEach, beforeEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDING_ADVICE, PHASE_ADVICE, foldJournal, parseTask, projectGraph, renderGraph, resolveGraphRoot, serializeTask } from "../server/lib/project-graph.mjs";
import { main, parseFlags } from "../scripts/project-graph.mjs";
import { agentProjectStatus } from "../server/lib/agent-project.mjs";

let directory: string, root: string;
const op = (name: string, fields: Record<string, unknown> = {}) => projectGraph({ root, op: name, ...fields });
const task = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: `Task ${id}`, body: "- [x] works\n", ...fields });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "project-graph-")));
  root = join(directory, "project");
  mkdirSync(root);
  writeFileSync(join(root, "noema.toml"), `[project]\nid = "demo"\n`);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("reading creates nothing and reports that there is no store", async () => {
  await expect(op("status")).resolves.toEqual({ root, store: false });
  expect(existsSync(join(root, ".agent"))).toBe(false);
});

test("everything lands in the Project's .agent, which stays ignored", async () => {
  await op("plan", { tasks: [task("a")] });
  expect(readFileSync(join(root, ".agent", ".gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, ".agent", "tasks", "a.md"))).toBe(true);
  expect(existsSync(join(root, ".agent", "tasks", "journal.jsonl"))).toBe(true);
  expect(existsSync(join(root, ".agent", "tasks", ".lock"))).toBe(false);
});

test("a task file round-trips and keeps its body", () => {
  const source = { id: "a", title: "A: with colon", after: ["b", "c"], related: ["d"], agent: "codex",
    review: "required", cycles: 3, body: "Goal\n\n- [ ] done\n" };
  expect(parseTask(serializeTask(source))).toEqual(source);
  expect(parseTask("# freehand note\n")).toBeNull();
});

test("a plan is vetted whole: one bad task writes nothing", async () => {
  await expect(op("plan", { tasks: [task("a"), task("b", { after: ["missing"] })] })).rejects.toMatchObject({ statusCode: 422 });
  await expect(op("plan", { tasks: [task("a", { after: ["b"] }), task("b", { after: ["a"] })] })).rejects.toMatchObject({ statusCode: 422 });
  await expect(op("plan", { tasks: [task("../evil")] })).rejects.toMatchObject({ statusCode: 400 });
  expect(existsSync(join(root, ".agent", "tasks", "a.md"))).toBe(false);
});

test("a dry run reports without creating the store", async () => {
  const result = await op("plan", { dryRun: true, tasks: [task("a", { body: "- [ ] x\n" + "y".repeat(5000) })] });
  expect(result).toMatchObject({ dryRun: true, tasks: ["a"], warnings: [{ code: "body-over-budget", task: "a" }] });
  expect(existsSync(join(root, ".agent"))).toBe(false);
});

test("order: readiness follows dependencies and says what it waits on", async () => {
  await op("plan", { tasks: [task("a"), task("b", { after: ["a"] }), task("c", { after: ["b"] })] });
  expect((await op("next")).ready.map((item: { id: string }) => item.id)).toEqual(["a"]);
  await expect(op("claim", { id: "b", agent: "codex" })).rejects.toMatchObject({ statusCode: 409 });
  await op("claim", { id: "a", agent: "codex", session: "s1" });
  await expect(op("claim", { id: "a", agent: "claude" })).rejects.toMatchObject({ statusCode: 409 });
  await expect(op("submit", { id: "a", agent: "claude" })).rejects.toMatchObject({ statusCode: 409 });
  await op("submit", { id: "a", agent: "codex", evidence: "tests pass" });
  expect((await op("next")).ready.map((item: { id: string }) => item.id)).toEqual(["b"]);
  const rows = (await op("graph")).rows;
  expect(rows.map((row: { id: string }) => row.id)).toEqual(["a", "b", "c"]);
  expect(rows[2]).toMatchObject({ phase: "waiting", on: ["b"] });
});

test("a dropped dependency is not a satisfied one, and the graph reports the deadlock", async () => {
  await op("plan", { tasks: [task("a"), task("b", { after: ["a"] })] });
  await op("state", { id: "a", agent: "codex", state: "dropped", text: "not needed" });
  const status = await op("status");
  expect(status.counts).toMatchObject({ dropped: 1, blocked_by_dependency: 1 });
  expect(status.deadlocked).toBe(true);
  expect(status.check.warnings.map((item: { code: string }) => item.code)).toContain("deadlocked");
});

test("review sends work back with its feedback and exhausted cycles stop at a person", async () => {
  await op("plan", { tasks: [task("a", { review: "required", cycles: 2 }), task("b", { after: ["a"] })] });
  for (const cycle of [1, 2]) {
    await op("claim", { id: "a", agent: "codex", session: "s1" });
    await op("submit", { id: "a", agent: "codex", evidence: "try" });
    expect((await op("show", { id: "a" })).phase).toBe("awaiting_review");
    await op("review", { id: "a", agent: "claude", verdict: "needs_changes", text: `fix ${cycle}` });
    if (cycle === 1) {
      const [next] = (await op("next")).ready;
      expect(next).toMatchObject({ id: "a", feedback: "fix 1", lastSession: "s1" });
    }
  }
  const shown = await op("show", { id: "a" });
  expect(shown).toMatchObject({ phase: "blocked", feedback: "fix 2", cycles: 2 });
  expect((await op("graph")).rows[1].phase).toBe("waiting");
  await op("state", { id: "a", agent: "human", state: "todo", text: "one more try" });
  await op("claim", { id: "a", agent: "codex" });
  await op("submit", { id: "a", agent: "codex", evidence: "fixed" });
  await op("review", { id: "a", agent: "claude", verdict: "passed" });
  expect((await op("show", { id: "a" })).phase).toBe("done");
});

test("a retried write with its request id is not applied twice", async () => {
  await op("plan", { tasks: [task("a", { review: "required", cycles: 5 })] });
  await op("claim", { id: "a", agent: "codex", requestId: "r1" });
  await expect(op("claim", { id: "a", agent: "codex", requestId: "r1" })).resolves.toMatchObject({ replayed: true });
  await op("submit", { id: "a", agent: "codex", evidence: "x", requestId: "r2" });
  await op("review", { id: "a", agent: "claude", verdict: "needs_changes", requestId: "r3" });
  await expect(op("review", { id: "a", agent: "claude", verdict: "needs_changes", requestId: "r3" })).resolves.toMatchObject({ replayed: true });
  expect((await op("show", { id: "a" })).cycles).toBe(1);
});

test("an expired claim is reported and only taken over explicitly", async () => {
  await op("plan", { tasks: [task("a")] });
  const hours = 5 * 3_600_000;
  const journal = join(root, ".agent", "tasks", "journal.jsonl");
  appendFileSync(journal, JSON.stringify({ at: Date.now() - hours, kind: "claim", task: "a", agent: "codex" }) + "\n");
  const status = await op("status");
  expect(status.staleClaims).toEqual(["a"]);
  expect(status.check.warnings).toContainEqual(expect.objectContaining({ code: "stale-claim", task: "a", agent: "codex" }));
  await expect(op("claim", { id: "a", agent: "claude" })).rejects.toMatchObject({ statusCode: 409 });
  await expect(op("claim", { id: "a", agent: "claude", take: true })).resolves.toMatchObject({ takenFrom: "codex" });
});

test("a holder's activity renews its claim", () => {
  const start = 1000;
  const facts = foldJournal([{ at: start, kind: "claim", task: "a", agent: "codex" },
    { at: start + 50, kind: "note", task: "a", agent: "other" },
    { at: start + 90, kind: "note", task: "a", agent: "codex" }]);
  expect(facts.get("a").claim.seen).toBe(start + 90);
});

test("a torn last line is skipped, reported and cannot swallow the next event", async () => {
  await op("plan", { tasks: [task("a")] });
  const journal = join(root, ".agent", "tasks", "journal.jsonl");
  appendFileSync(journal, `{"at":1,"kind":"cla`);
  await op("claim", { id: "a", agent: "codex" });
  const status = await op("status");
  expect(status.check.warnings).toContainEqual(expect.objectContaining({ code: "torn-journal-line", count: 1 }));
  expect(status.counts.claimed).toBe(1);
});

test("a live writer's lock is waited for and never broken", async () => {
  await op("plan", { tasks: [task("a")] });
  const lock = join(root, ".agent", "tasks", ".lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }));
  await expect(op("note", { id: "a", agent: "codex", text: "blocked" })).rejects.toMatchObject({ statusCode: 423 });
  expect(existsSync(lock)).toBe(true);
}, 10_000);

test("a dead writer's lock is broken", async () => {
  await op("plan", { tasks: [task("a")] });
  const lock = join(root, ".agent", "tasks", ".lock");
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: 0 }));
  await op("note", { id: "a", agent: "codex", text: "after a crash" });
  expect(existsSync(lock)).toBe(false);
}, 10_000);

test("concurrent writers lose nothing", async () => {
  await op("plan", { tasks: [task("a")] });
  await Promise.all(Array.from({ length: 20 }, (_, index) => op("note", { id: "a", agent: "codex", text: `n${index}` })));
  expect((await op("timeline", { limit: 500 })).events.filter((event: { kind: string }) => event.kind === "note")).toHaveLength(20);
});

test("a hand edit that breaks the graph is refused by check, unsupported claims are warned", async () => {
  await op("plan", { tasks: [task("a"), task("b", { after: ["a"] })] });
  appendFileSync(join(root, ".agent", "tasks", "journal.jsonl"), JSON.stringify({ at: Date.now(), kind: "submit", task: "a", agent: "codex" }) + "\n");
  const check = await op("check");
  expect(check.ok).toBe(true);
  expect(check.warnings).toContainEqual(expect.objectContaining({ code: "done-without-evidence", task: "a" }));
  writeFileSync(join(root, ".agent", "tasks", "a.md"), serializeTask({ id: "a", title: "A", after: ["b"], related: [], body: "" }));
  writeFileSync(join(root, ".agent", "tasks", "freehand.md"), "# a note\n");
  const broken = await op("check");
  expect(broken.ok).toBe(false);
  expect(broken.errors.map((item: { code: string }) => item.code)).toEqual(["cycle", "cycle"]);
  expect(broken.freehandNotes).toBe(1);
  expect((await op("graph")).rows).toHaveLength(2);
});

test("decisions and commits join the timeline, newest first, holding only references", async () => {
  await op("plan", { tasks: [task("a")] });
  await op("note", { id: "a", agent: "codex", kind: "decision", text: "use the journal" });
  await op("note", { id: "a", agent: "codex", kind: "commit", refs: "abc123" }); // not a repository: nothing to verify against
  const { events } = await op("timeline");
  expect(events[0]).toMatchObject({ kind: "commit", refs: ["abc123"] });
  expect(events[1]).toMatchObject({ kind: "decision", text: "use the journal" });
  await expect(op("note", { kind: "gossip", agent: "x" })).rejects.toMatchObject({ statusCode: 400 });
});

test("a linked worktree uses the main checkout's .agent", async () => {
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), ".agent\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const worktree = join(directory, "attempt");
  git(root, "worktree", "add", "-q", worktree);
  await expect(resolveGraphRoot(worktree)).resolves.toBe(root);
  await projectGraph({ root: worktree, op: "plan", tasks: [task("a")] });
  expect(existsSync(join(root, ".agent", "tasks", "a.md"))).toBe(true);
  expect(existsSync(join(worktree, ".agent"))).toBe(false);
});

test("a plain Git repository works; anything else is refused", async () => {
  const plain = join(directory, "plain");
  mkdirSync(join(plain, "src"), { recursive: true });
  git(plain, "init", "-q");
  await expect(resolveGraphRoot(join(plain, "src"))).resolves.toBe(plain);
  const none = join(directory, "none");
  mkdirSync(none);
  await expect(resolveGraphRoot(none)).rejects.toMatchObject({ statusCode: 404 });
  await expect(resolveGraphRoot("relative")).rejects.toMatchObject({ statusCode: 400 });
});

test("a terminal rendering draws the tree", async () => {
  await op("plan", { tasks: [task("a"), task("b", { after: ["a"] }), task("c", { after: ["a", "b"] })] });
  expect(renderGraph(await op("graph"))).toBe(
    "○ a  Task a  [ready]\n├─ · b  Task b  [waiting · on a]\n└─ · c  Task c  [waiting · on a, b · also after b]\n");
});

test("the script needs no host and reads flags and stdin", async () => {
  expect(parseFlags(["--id", "a", "--take", "-"])).toEqual({ fields: { id: "a", take: true }, stdin: true });
  await main(["plan", "--root", root, "-"], async () => JSON.stringify({ tasks: [task("a")] }));
  const { text } = await main(["graph", "--root", root, "--text"]);
  expect(text).toContain("○ a  Task a");
  const output = execFileSync("node", [join(process.cwd(), "scripts/project-graph.mjs"), "next", "--root", root], { encoding: "utf8" });
  expect(JSON.parse(output).ready[0].id).toBe("a");
});

test("the script keeps --text as a record's text outside graph", async () => {
  await op("plan", { tasks: [task("a")] });
  await main(["note", "--root", root, "--id", "a", "--agent", "codex", "--kind", "decision", "--text", "why"]);
  expect((await op("timeline")).events[0]).toMatchObject({ kind: "decision", text: "why" });
});

test("project status carries the graph summary and stays null without one", async () => {
  const call = async () => ({ cache: null });
  await expect(agentProjectStatus({ root }, { call })).resolves.toMatchObject({ graph: null });
  await op("plan", { tasks: [task("a")] });
  expect((await agentProjectStatus({ root }, { call })).graph).toMatchObject({ tasks: 1, ready: ["a"] });
  await expect(agentProjectStatus({ root: directory }, { call })).resolves.toMatchObject({ project: null, graph: null });
});

test("contract: a plan needs acceptance, and a refusal says what is missing", async () => {
  await expect(op("plan", { tasks: [task("a", { body: "vague" })] })).rejects.toThrow(/acceptance criteria: a/);
});

test("contract: submit needs evidence and checked acceptance, with an honest way out", async () => {
  await op("plan", { tasks: [task("a", { body: "- [x] one\n- [ ] two\n" })] });
  await expect(op("submit", { id: "a", agent: "codex", evidence: "  " })).rejects.toThrow(/evidence is required/);
  await expect(op("submit", { id: "a", agent: "codex", evidence: "ran" })).rejects.toThrow(/unchecked.*two/);
  await op("submit", { id: "a", agent: "codex", evidence: "ran", partial: true });
  const { warnings } = await op("check");
  expect(warnings).toContainEqual(expect.objectContaining({ code: "submitted-with-open-acceptance", items: ["two"] }));
});

test("contract: nobody reviews their own work without saying so", async () => {
  await op("plan", { tasks: [task("a", { review: "required" })] });
  await op("submit", { id: "a", agent: "codex", evidence: "ran" });
  await expect(op("review", { id: "a", agent: "codex", verdict: "passed" })).rejects.toThrow(/another Agent/);
  await op("review", { id: "a", agent: "codex", verdict: "passed", self: true });
  expect((await op("check")).warnings).toContainEqual(expect.objectContaining({ code: "self-reviewed" }));
});

test("contract: a commit note must name a commit Git knows", async () => {
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), ".agent\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  await op("plan", { tasks: [task("a")] });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await op("note", { id: "a", agent: "codex", kind: "commit", refs: sha });
  await expect(op("note", { id: "a", agent: "codex", kind: "commit", refs: "deadbeef" })).rejects.toMatchObject({ statusCode: 422 });
  await expect(op("note", { id: "a", agent: "codex", kind: "commit" })).rejects.toMatchObject({ statusCode: 400 });
});

test("audit: stale references, oversize bodies and unreviewed hubs are found by the machine", async () => {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "real.ts"), "");
  await op("plan", { tasks: [
    task("hub", { body: "- [ ] x\n`src/real.ts:1-2` `src/gone.ts` `~/home/x` `a b`\n" }),
    task("a", { after: ["hub"] }), task("b", { after: ["hub"] }), task("c", { after: ["hub"] }),
  ] });
  const { warnings } = await op("check");
  expect(warnings).toContainEqual(expect.objectContaining({ code: "missing-reference", task: "hub", path: "src/gone.ts" }));
  expect(warnings.filter((item: { code: string }) => item.code === "missing-reference")).toHaveLength(1);
  expect(warnings).toContainEqual(expect.objectContaining({ code: "high-fanout-without-review", task: "hub", dependents: 3 }));
});

test("every finding and phase carries its own advice", async () => {
  await op("plan", { tasks: [task("a")] });
  appendFileSync(join(root, ".agent", "tasks", "journal.jsonl"), JSON.stringify({ at: 1, kind: "note", task: "ghost" }) + "\n");
  const { warnings } = await op("check");
  expect(warnings.every((item: { fix?: string }) => item.fix)).toBe(true);
  const source = readFileSync(join(process.cwd(), "server/lib/project-graph.mjs"), "utf8");
  for (const [, code] of source.matchAll(/code: "([a-z-]+)"/g)) expect(FINDING_ADVICE).toHaveProperty([code]);
  expect((await op("show", { id: "a" })).advice).toBe(PHASE_ADVICE.ready);
});

test("maintain removes only old temporaries", async () => {
  await op("plan", { tasks: [task("a")] });
  const stale = join(root, ".agent", "tasks", "a.md.old.tmp"), fresh = join(root, ".agent", "tasks", "a.md.new.tmp");
  writeFileSync(stale, ""); writeFileSync(fresh, "");
  utimesSync(stale, new Date(0), new Date(0));
  expect((await op("check")).warnings).toContainEqual(expect.objectContaining({ code: "leftover-temp", count: 2 }));
  await expect(op("maintain")).resolves.toMatchObject({ removed: 1 });
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(join(root, ".agent", "tasks", "a.md"))).toBe(true);
  await expect(projectGraph({ root: join(directory, "project"), op: "maintain" })).resolves.toMatchObject({ removed: 0 });
});

test("the script's check is a gate", async () => {
  await op("plan", { tasks: [task("a")] });
  writeFileSync(join(root, ".agent", "tasks", "a.md"), serializeTask({ id: "a", title: "A", after: ["gone"], related: [], body: "" }));
  expect(() => execFileSync("node", [join(process.cwd(), "scripts/project-graph.mjs"), "check", "--root", root], { stdio: "pipe" })).toThrow();
});

test("the Skills stay small: rules belong in this code", () => {
  const budget: Record<string, number> = { "noema-project-graph": 1000, "noema-project-plan": 800, "noema-project-run": 600, "noema-project-review": 400 };
  for (const [skill, limit] of Object.entries(budget))
    expect([skill, readFileSync(join(process.cwd(), "resources/skills", skill, "SKILL.md"), "utf8").length <= limit]).toEqual([skill, true]);
});
