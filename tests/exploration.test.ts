// @vitest-environment node
// Contract: docs/noema/design/math-exploration.md E1-E14.  Emacs sessions,
// the duplicate check and Lean are stand-ins; the rules are the engine's own.
import { afterEach, beforeEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exploration, explorationView, fold, render, supervisor } from "../server/lib/exploration.mjs";
import { bodyOf, main, parseFlags } from "../scripts/exploration.mjs";

const MINUTE = 60_000;
let root: string;
let now: number;
let sessions: Map<string, any>;
let sent: any[];
let calls: any[];
let duplicate: (input: any) => Promise<any>;
let judge: (input: any) => Promise<any>;
let refuseSend: Set<string>;
let serial: number;

const COORDINATOR = { buffer: "*coordinator*", nativeSessionId: "native-c" };

/** A stand-in for `noema:api:emacs:agent`. */
async function call(channel: string, [body]: any[]) {
  expect(channel).toBe("noema:api:emacs:agent");
  calls.push(body);
  switch (body.action) {
    case "status":
      if (body.buffer !== COORDINATOR.buffer) throw new Error("Session identity no longer matches");
      return { ok: true, session: { buffer: body.buffer, agent: "codex" } };
    case "spawn": {
      const id = `r${(serial += 1)}`;
      const buffer = `*${body.name}*`;
      sessions.set(id, { buffer, nativeSessionId: `native-${body.name}`, terminal: false, prompt: body.prompt });
      return { ok: true, requestId: id, session: { buffer } };
    }
    case "send": {
      if (refuseSend.has(body.buffer)) throw new Error("Session is not ready");
      sent.push(body);
      const id = `r${(serial += 1)}`;
      sessions.set(id, { buffer: body.buffer, nativeSessionId: body.nativeSessionId, terminal: false });
      return { ok: true, requestId: id };
    }
    case "result": {
      const session = sessions.get(body.requestId);
      if (!session) throw new Error("Unknown task receipt");
      return { ok: true, buffer: session.buffer, nativeSessionId: session.nativeSessionId, terminal: session.terminal };
    }
    case "stop": return { ok: true };
    default: throw new Error(`unexpected ${body.action}`);
  }
}

const deps = () => ({ call, duplicate: (input: any) => duplicate(input), judge: (input: any) => judge(input), now: () => now });
const op = (body: any) => exploration({ root, ...body }, deps());
const startOne = (body: any = {}) => op({ op: "start", title: "Sum of squares", problem: "Which n are sums of two squares?", coordinator: COORDINATOR, members: 2, minutes: 60, ...body });
const journal = (dir: string) => readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const finish = (requestPrefix?: string) => { for (const session of sessions.values()) if (!requestPrefix || session.buffer.includes(requestPrefix)) session.terminal = true; };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "exploration-")));
  writeFileSync(join(root, "noema.toml"), 'schema = 1\n\n[project]\nid = "test-project"\n');
  now = Date.UTC(2026, 10, 16, 9, 0);
  sessions = new Map(); sent = []; calls = []; serial = 0; refuseSend = new Set();
  duplicate = async () => ({ duplicateOf: null, reason: "different" });
  judge = async () => ({ accepted: true, axioms: ["propext"] });
});
afterEach(() => { for (const dir of [...supervisor.timers.keys()]) supervisor.disarm(dir); rmSync(root, { recursive: true, force: true }); });

test("E1 start writes the Markdown, starts the members and teaches the judge", async () => {
  const started = await startOne();
  expect(started.members).toEqual(["m1", "m2"]);
  expect(started.instructions).toContain("verdict --root");
  const problem = readFileSync(started.problem, "utf8");
  expect(problem).toMatch(/^#\+begin meta\ntitle: Sum of squares/);
  expect(problem).toContain("Which n are sums of two squares?");
  expect(problem).toContain("[m1](m1.md)");
  expect(readFileSync(join(started.dir, "m2.md"), "utf8")).toContain("## Direction\n\nNot registered yet.");
  const spawns = calls.filter((body) => body.action === "spawn");
  expect(spawns.map((body) => body.name)).toEqual([`explore-${started.id}-m1`, `explore-${started.id}-m2`]);
  expect(spawns[0]).toMatchObject({ root, agent: "codex" });
  expect(spawns[0].prompt).toContain("You are member m1");
  expect(spawns[0].prompt).toContain(join(started.dir, "m1.md"));
  expect(spawns[0].prompt).not.toMatch(/\{[a-z_]+\}/);
  expect(journal(started.dir).map((event) => event.kind)).toEqual(["start", "task", "task"]);
  await expect(startOne({ coordinator: { buffer: "*gone*", nativeSessionId: "x" } })).rejects.toThrow(/identity/);
  await expect(startOne({ problem: undefined })).rejects.toThrow(/problem/);
  await expect(startOne({ members: 9 })).rejects.toThrow(/members is 1..8/);
});

test("E3 E6 a member registers before anything and holds one direction", async () => {
  const { id, dir } = await startOne();
  await expect(op({ op: "post", id, member: "m1", kind: "lemma", text: "x" })).rejects.toThrow(/register/);
  await expect(op({ op: "submit", id, member: "m1", report: "done" })).rejects.toThrow(/register/);
  const first = await op({ op: "register", id, member: "m1", text: "Gaussian integers: factor n over Z[i]." });
  expect(first).toMatchObject({ registered: true, direction: "d1" });
  const notebook = readFileSync(join(dir, "m1.md"), "utf8");
  expect(notebook).toContain("## Direction\n\nd1: Gaussian integers: factor n over Z[i].\n\n## State");
  await expect(op({ op: "register", id, member: "m1", text: "Another" })).rejects.toThrow(/You hold d1/);
  await expect(op({ op: "abandon", id, member: "m1", reason: "" })).rejects.toThrow(/reason is required/);
  expect(await op({ op: "abandon", id, member: "m1", reason: "Needs unique factorisation I could not use." })).toMatchObject({ abandoned: "d1" });
  expect(await op({ op: "post", id, member: "m1", kind: "lemma", text: "x" }).catch((error: any) => error.message)).toMatch(/register/);
});

test("E5 a duplicate is refused and an uncompared direction is never admitted", async () => {
  const { id } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Gaussian integers." });
  duplicate = async ({ directions }) => ({ duplicateOf: directions[0].id, reason: "same factorisation idea" });
  expect(await op({ op: "register", id, member: "m2", text: "Factor in Z[i] instead." }))
    .toMatchObject({ registered: false, duplicateOf: "d1", reason: "same factorisation idea" });
  duplicate = async () => { throw new Error("model down"); };
  await expect(op({ op: "register", id, member: "m2", text: "Quadratic forms." })).rejects.toThrow(/never admitted uncompared/);
  duplicate = async () => ({ duplicateOf: "d9", reason: "?" });
  await expect(op({ op: "register", id, member: "m2", text: "Quadratic forms." })).rejects.toThrow(/does not exist/);
});

test("E7 E8 a report is never cut, and is taken only when the judge was told", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  await expect(op({ op: "submit", id, member: "m1", report: "x".repeat(1501) })).rejects.toThrow(/at most 1500.*nothing is cut/);
  writeFileSync(join(dir, "m1", "proof.md"), "proof");
  await expect(op({ op: "submit", id, member: "m1", report: "Done", files: ["../../noema.toml"] })).rejects.toThrow(/outside/);
  refuseSend.add(COORDINATOR.buffer);
  await expect(op({ op: "submit", id, member: "m1", report: "Done", files: ["m1/proof.md"] })).rejects.toThrow(/cannot be told now/);
  expect(journal(dir).some((event) => event.kind === "submit")).toBe(false);
  refuseSend.clear();
  expect(await op({ op: "submit", id, member: "m1", report: "Done", files: ["m1/proof.md"] })).toMatchObject({ submitted: true, direction: "d1" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject(COORDINATOR);
  expect(sent[0].prompt).toMatch(/^\[From exploration .*member m1, not the person\]/);
  expect(sent[0].prompt).toContain(join(dir, "m1", "proof.md"));
  await expect(op({ op: "submit", id, member: "m1", report: "Again" })).rejects.toThrow(/waits for the judge/);
});

test("E9 with a Lean statement, Lean decides a proof before the judge hears of it", async () => {
  const frozen = join(root, "lean", "Frozen.lean");
  mkdirSync(join(root, "lean"), { recursive: true });
  writeFileSync(join(root, "lakefile.toml"), 'name = "t"\n');
  writeFileSync(frozen, "import Mathlib\n\ntheorem two (n : ℕ) : n + n = 2 * n := by\n  sorry\n");
  const { id, dir } = await startOne({ lean: frozen });
  expect(readFileSync(join(dir, "problem.md"), "utf8")).toContain("Lean decides whether a proof proves `two`");
  await op({ op: "register", id, member: "m1", text: "omega." });
  writeFileSync(join(dir, "m1", "Proof.lean"), "proof");
  await expect(op({ op: "submit", id, member: "m1", report: "Done" })).rejects.toThrow(/pass your proof file/);
  judge = async () => ({ accepted: false, rejection: "elaboration", detail: "unknown tactic" });
  expect(await op({ op: "submit", id, member: "m1", report: "Done", proof: "m1/Proof.lean" })).toMatchObject({ submitted: false, lean: { rejection: "elaboration" } });
  expect(sent).toHaveLength(0);
  judge = async (input) => { expect(input).toMatchObject({ op: "verify", statement: realpathSync(frozen) }); return { accepted: true, axioms: [] }; };
  expect(await op({ op: "submit", id, member: "m1", report: "Done", proof: "m1/Proof.lean" })).toMatchObject({ submitted: true });
  expect(sent[0].prompt).toContain("Lean accepted");
  writeFileSync(join(root, "lean", "Bad.lean"), "theorem t : True := by\n  trivial\n");
  await expect(startOne({ lean: join(root, "lean", "Bad.lean") })).rejects.toThrow(/sorry/);
});

test("E9 two rejections end a direction; an accept with finish ends it solved", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  await op({ op: "register", id, member: "m2", text: "Quadratic reciprocity." });
  await op({ op: "submit", id, member: "m1", report: "Try 1" });
  await expect(op({ op: "verdict", id, member: "m1", accept: false })).rejects.toThrow(/reason is required/);
  expect(await op({ op: "verdict", id, member: "m1", accept: false, reason: "Step 3 assumes n squarefree." })).toMatchObject({ state: "open" });
  expect(sent.at(-1).buffer).toBe(`*explore-${id}-m1*`);
  expect(sent.at(-1).prompt).toContain("Step 3 assumes n squarefree.");
  expect(sent.at(-1).prompt).toContain("a second rejection ends the direction");
  await op({ op: "submit", id, member: "m1", report: "Try 2" });
  expect(await op({ op: "verdict", id, member: "m1", accept: false, reason: "Still assumes it." })).toMatchObject({ state: "dead" });
  expect(sent.at(-1).prompt).toContain("second rejection");
  expect(await op({ op: "register", id, member: "m1", text: "Minkowski's theorem on lattices." })).toMatchObject({ direction: "d3" });
  await op({ op: "submit", id, member: "m2", report: "Proof via reciprocity" });
  expect(await op({ op: "verdict", id, member: "m2", accept: true, finish: true, by: "person" })).toMatchObject({ state: "succeeded", exploration: "ended", outcome: "solved" });
  const summary = readFileSync(join(dir, "summary.md"), "utf8");
  expect(summary).toContain("Outcome: **solved**");
  expect(summary.indexOf("d2 · succeeded")).toBeLessThan(summary.indexOf("d1 · dead"));
  expect(summary).toContain("accepted by person");
  expect(calls.some((body) => body.action === "stop")).toBe(true);
  await expect(op({ op: "register", id, member: "m1", text: "late" })).rejects.toThrow(/ended/);
});

test("E10 members that end their runs leave the exploration exhausted; the deadline ends it", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  // Each member is woken until its nudges are spent (E15); then it is idle.
  for (let round = 0; round < 4; round += 1) { finish(); await op({ op: "status", id }); }
  finish();
  const status = await op({ op: "status", id });
  expect(status).toMatchObject({ state: "ended", outcome: "exhausted" });
  expect(status.directions[0]).toMatchObject({ stalled: true });
  expect(sent.at(-1).prompt).toContain("It ended exhausted");
  expect(existsSync(join(dir, "summary.md"))).toBe(true);

  const second = await startOne({ title: "Second" });
  now += 61 * MINUTE;
  expect(await op({ op: "status", id: second.id })).toMatchObject({ state: "ended", outcome: "expired" });
  expect(calls.filter((body) => body.action === "stop").length).toBe(2);
});

test("E10 a waiting report keeps it running until it is judged", async () => {
  const { id } = await startOne({ members: 1 });
  await op({ op: "register", id, member: "m1", text: "Descent." });
  await op({ op: "submit", id, member: "m1", report: "Done" });
  finish();
  expect(await op({ op: "status", id })).toMatchObject({ state: "running", waiting: ["d1"] });
  expect(await op({ op: "verdict", id, member: "m1", accept: true })).toMatchObject({ exploration: "ended", outcome: "solved" });
});

test("E11 vanished members interrupt it; resume restarts them from their notebooks", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  sessions.clear();
  expect(await op({ op: "status", id })).toMatchObject({ state: "interrupted" });
  expect(sent.at(-1).prompt).toContain("interrupted");
  await expect(op({ op: "register", id, member: "m2", text: "x" })).rejects.toThrow(/interrupted/);
  calls = [];
  expect(await op({ op: "resume", id })).toMatchObject({ resumed: true, members: ["m1", "m2"] });
  const prompts = calls.filter((body) => body.action === "spawn").map((body) => body.prompt);
  expect(prompts[0]).toContain("You hold direction d1: Descent.");
  expect(prompts[0]).toContain("## State");
  expect(prompts[1]).toContain("You hold no direction");
  expect((await op({ op: "status", id })).state).toBe("running");
  sessions.clear();
  await op({ op: "status", id });
  now += 70 * MINUTE;
  await expect(op({ op: "resume", id })).rejects.toThrow(/give minutes/);
  expect(await op({ op: "resume", id, minutes: 30 })).toMatchObject({ resumed: true });
  expect(journal(dir).filter((event) => event.kind === "resume")).toHaveLength(2);
});

test("E12 the board folds from the journal alone", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  await op({ op: "post", id, member: "m1", kind: "counterexample", text: "n = 3 is not a sum of two squares." });
  await expect(op({ op: "post", id, member: "m1", kind: "rumour", text: "x" })).rejects.toThrow(/kind is one of/);
  const board = await op({ op: "board", id, member: "m1" });
  expect(board.markdown).toContain("## d1 · m1 · open");
  expect(board.markdown).toContain("- [counterexample] n = 3 is not a sum of two squares.");
  expect(board.you).toMatchObject({ state: "holding", direction: "d1" });
  const folded = fold(journal(dir), now);
  expect(folded.directions[0].findings).toHaveLength(1);
  expect((await op({ op: "list" })).explorations.map((row: any) => row.id)).toEqual([id]);
});

test("E15 a member whose run ends with time left is woken, a bounded number of times", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  finish();
  expect((await op({ op: "status", id })).state).toBe("running");
  const nudges = () => journal(dir).filter((event) => event.kind === "nudge");
  expect(nudges().map((event) => [event.member, event.reason])).toEqual([["m1", "continue"], ["m2", "register"]]);
  expect(sent.find((body) => body.buffer === `*explore-${id}-m1*`).prompt).toContain("You still hold direction d1");
  expect(sent.find((body) => body.buffer === `*explore-${id}-m2*`).prompt).toContain("You hold no direction");
  // m2 was asked once to register and did not: it is idle; m1 keeps being woken up to the bound.
  finish(); await op({ op: "status", id });
  expect(nudges().filter((event) => event.member === "m2")).toHaveLength(1);
  expect(journal(dir).some((event) => event.kind === "idle" && event.member === "m2")).toBe(true);
  finish(); await op({ op: "status", id }); finish(); await op({ op: "status", id });
  expect(nudges().filter((event) => event.member === "m1")).toHaveLength(3);
  // Too little time left: no wake, the member is idle.
  const late = await startOne({ title: "Late" });
  await op({ op: "register", id: late.id, member: "m1", text: "x" });
  now += 58 * MINUTE;
  finish();
  await op({ op: "status", id: late.id });
  expect(journal(late.dir).some((event) => event.kind === "nudge")).toBe(false);
});

test("E16 reads need no host: the command line folds the journal itself", async () => {
  const { id, dir } = await startOne();
  await op({ op: "register", id, member: "m1", text: "Descent." });
  const view = await explorationView({ root, op: "board", id, member: "m1" }, now);
  expect(view.you).toMatchObject({ state: "holding", direction: "d1" });
  expect(view.markdown).toContain("## d1 · m1 · open");
  expect((await explorationView({ root, op: "list" }, now)).explorations.map((row: any) => row.id)).toEqual([id]);
  await expect(explorationView({ root, op: "register", id })).rejects.toThrow(/Not a read/);
  const calls: any[] = [];
  const noHost = async (...args: any[]) => { calls.push(args); throw new Error("blocked"); };
  const printed = await main(["board", "--root", root, "--id", id, "--text"], noHost);
  expect(printed.text).toContain("## d1 · m1 · open");
  expect(calls).toHaveLength(0);
  // A path relative to the Project root names the same file as one relative to the exploration.
  writeFileSync(join(dir, "m1", "proof.md"), "proof");
  expect(await op({ op: "submit", id, member: "m1", report: "Done", files: [`explorations/${id}/m1/proof.md`] })).toMatchObject({ submitted: true });
  expect(bodyOf("submit", parseFlags(["--proof", "m1/P.lean", "--files", "a.md,b.py"]), "/w").body).toMatchObject({ proof: "/w/m1/P.lean", files: ["/w/a.md", "/w/b.py"] });
});

test("E14 the command line maps flags to the API body", () => {
  expect(parseFlags(["--member", "m1", "--text", "An idea"])).toEqual({ member: "m1", text: "An idea" });
  expect(parseFlags(["--member", "m1", "--text"])).toEqual({ member: "m1", markdown: true });
  const { body } = bodyOf("verdict", parseFlags(["--id", "x", "--member", "m2", "--reject", "--reason", "gap"]), "/p");
  expect(body).toEqual({ op: "verdict", root: "/p", id: "x", member: "m2", accept: false, reason: "gap" });
  expect(bodyOf("start", parseFlags(["--buffer", "b", "--session", "s", "--members", "3"]), "/p").body)
    .toMatchObject({ coordinator: { buffer: "b", nativeSessionId: "s" }, members: 3 });
  expect(render("a {x} b", { x: 1 })).toBe("a 1 b");
  expect(() => render("{missing}", {})).toThrow(/missing/);
});
