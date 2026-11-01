// @vitest-environment node
import { afterEach, beforeEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../server/lib/agent-journal.mjs";
import { renderAgentCatalog } from "../server/lib/agent-catalog-text.mjs";
import { piWatch } from "../server/lib/pi-watch.mjs";
import { createPiWatcher } from "../resources/pi/extensions/noema-manager/watcher.mjs";
import { projectGraph } from "../server/lib/project-graph.mjs";

const MINUTE = 60_000;
let root: string;
let elsewhere: string;
let now: number;
let sent: any[];
let refuse: string[];
let watcher: any;
let timers: any[];
let changes: Array<() => void>;

const journalFile = () => join(root, ".agent/pi/journal.jsonl");
const journal = () => readFileSync(journalFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const results = () => journal().filter((event) => event.kind === "result");
const add = (body: any) => piWatch({ root, op: "add", agent: "codex", why: "Check it", ...body }, { now });
const list = () => piWatch({ root, op: "list" }, { now });
const script = (name: string, body: string) => {
  writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(root, name), 0o755);
  return name;
};
const plan = (...ids: string[]) => projectGraph({ root, op: "plan", agent: "a",
  tasks: ids.map((id, index) => ({ id, title: id, body: "- [x] done", after: index ? [ids[index - 1]] : [] })) });

function makeWatcher() {
  return createPiWatcher({
    root,
    clock: () => now,
    deliver: {
      pi: async (body: any) => { sent.push({ via: "pi", ...body }); if (refuse.includes("pi")) throw new Error("Emacs is away"); return { ok: true }; },
      agent: async (body: any) => { sent.push({ via: "agent", ...body }); if (refuse.includes("agent")) throw new Error("gone"); return { ok: true }; },
    },
    setTimer: ((run: () => void, wait: number) => { const timer = { run, wait }; timers.push(timer); return timer; }) as any,
    clearTimer: ((timer: any) => { timers = timers.filter((item) => item !== timer); }) as any,
    watchImpl: ((_path: string, onChange: () => void) => { changes.push(onChange); return { close() { changes = changes.filter((item) => item !== onChange); }, on() {} }; }) as any,
  });
}

async function tick(advance = 0) {
  now += advance;
  for (let round = 0; round < 3; round += 1) {
    await watcher.scan();
    await watcher.drain();
    await new Promise((done) => setTimeout(done, 10));
  }
}

const until = async (done: () => boolean) => {
  for (let round = 0; round < 100 && !done(); round += 1) await tick();
  await tick();
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-watch-")));
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "pi-watch-out-")));
  execFileSync("git", ["init", "-q", root]);
  now = Date.parse("2026-11-02T00:00:00Z");
  sent = [];
  refuse = [];
  timers = [];
  changes = [];
  watcher = makeWatcher();
  await watcher.start();
});

afterEach(() => {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test("W1 facts stay in the Project's .agent, which Git does not track", async () => {
  await add({ when: { after: "20m" }, do: { prompt: "Look at CI" } });
  expect(existsSync(journalFile())).toBe(true);
  expect(execFileSync("git", ["-C", root, "status", "--short"]).toString()).toBe("");
});

test("W2 a countdown fires once and says who set it", async () => {
  const { id } = await add({ when: { after: "20m" }, do: { prompt: "Look at CI" } });
  await tick(19 * MINUTE);
  expect(sent).toEqual([]);
  await tick(MINUTE);
  await tick(60 * MINUTE);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ via: "pi", action: "send", root });
  expect(sent[0].prompt).toContain(`Watch ${id} fired`);
  expect(sent[0].prompt).toContain("Set by codex, not the person");
  expect((await list()).armed).toEqual([]);
});

test("W3 with Pi closed nothing runs, and the watches wait for it", async () => {
  await plan("t");
  await add({ id: "a", when: { after: "1m" }, do: { prompt: "x" } });
  await add({ id: "h", when: { on: { kind: "claim" } }, do: { prompt: "y" } });
  await tick();
  expect(watcher.idle()).toBe(false);
  expect((await list()).running).toBe(true);
  watcher.stop();
  expect(timers).toEqual([]);
  expect(changes).toEqual([]);
  expect((await list()).running).toBe(false);
  expect((await add({ id: "b", when: { after: "1m" }, do: { prompt: "z" } })).running).toBe(false);
  now += 60 * MINUTE;
  await projectGraph({ root, op: "claim", id: "t", agent: "a" });
  expect(sent).toEqual([]);
  watcher = makeWatcher();
  await watcher.start();
  await tick();
  expect(sent).toHaveLength(3);
});

test("W3 only one Pi watches a Project", async () => {
  expect(await makeWatcher().start()).toBe(false);
});

test("W4 every watch ends", async () => {
  await expect(add({ when: { every: "30s" }, do: { prompt: "x" } })).rejects.toThrow(/at least 1m/);
  await expect(add({ when: {}, do: { prompt: "x" } })).rejects.toThrow(/exactly one/);
  await add({ when: { every: "1m", times: 2 }, do: { prompt: "x" } });
  for (let round = 0; round < 4; round += 1) await tick(MINUTE);
  expect(sent).toHaveLength(2);
  await add({ id: "forgotten", when: { on: { kind: "submit" } }, do: { prompt: "x" } });
  expect((await list()).armed).toHaveLength(1);
  now += 8 * 24 * 60 * MINUTE;
  expect((await list()).armed).toEqual([]);
});

test("W5 a hook sees a graph event written with no host, and nothing older", async () => {
  await plan("a");
  await projectGraph({ root, op: "claim", id: "a", agent: "a" });
  await add({ when: { on: { kind: "claim" } }, do: { prompt: "old" } });
  await add({ when: { on: { kind: "submit", task: "a" } }, do: { prompt: "Review it" } });
  await tick();
  expect(sent).toEqual([]);
  expect(changes).toHaveLength(2);
  await projectGraph({ root, op: "submit", id: "a", agent: "a", evidence: "tests" });
  changes[1]();
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("submit of a");
});

test("W5 a phase fires when the task gets there", async () => {
  await plan("a", "b");
  await add({ when: { on: { phase: "ready", task: "b" } }, do: { prompt: "b can start" } });
  await tick();
  expect(sent).toEqual([]);
  await projectGraph({ root, op: "claim", id: "a", agent: "a" });
  await projectGraph({ root, op: "submit", id: "a", agent: "a", evidence: "tests" });
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("b is ready");
});

test("W6 a message nobody accepted is reported, and a session that is gone falls back to Pi", async () => {
  refuse = ["agent"];
  await add({ when: { after: "1m" }, do: { to: { buffer: "*gone*", nativeSessionId: "n" }, prompt: "Wake up" } });
  await tick(MINUTE);
  expect(sent.map((item) => item.via)).toEqual(["agent", "pi"]);
  expect(sent[1].prompt).toContain("*gone*");
  expect(results()).toMatchObject([{ ok: true }]);
  refuse = ["pi"];
  await add({ id: "lost", when: { after: "1m" }, do: { prompt: "x" } });
  await tick(MINUTE);
  await tick(60 * MINUTE);
  expect(sent).toHaveLength(3);
  expect((await list()).findings).toMatchObject([{ code: "failed", id: "lost" }]);
});

test("W7 a firing cut off by a crash is reported, never replayed", async () => {
  await add({ id: "s", when: { after: "1m" }, do: { prompt: "x" } });
  await appendEvent(journalFile(), { kind: "fire", at: now, id: "s", n: 1, reason: "x", message: true });
  watcher.stop();
  watcher = makeWatcher();
  await watcher.start();
  await tick(MINUTE);
  expect(sent).toEqual([]);
  expect((await list()).findings).toMatchObject([{ code: "unknown", id: "s" }]);
});

test("W8 a torn last line costs that line and nothing else", async () => {
  await add({ id: "a", when: { after: "1h" }, do: { prompt: "x" } });
  writeFileSync(journalFile(), `${readFileSync(journalFile(), "utf8")}{"kind":"fi`);
  await add({ id: "b", when: { after: "1h" }, do: { prompt: "y" } });
  expect((await list()).armed.map((watch: any) => watch.id)).toEqual(["a", "b"]);
});

test("W9 messages have a daily budget, and a held watch does not spin", async () => {
  for (let index = 0; index < 49; index += 1)
    await piWatch({ root, op: "add", agent: "a", why: "x", id: `m${index}`, when: { after: "0s" }, do: { prompt: "x" } }, { now });
  await until(() => sent.length >= 48);
  expect(sent).toHaveLength(48);
  expect((await list()).findings.map((item: any) => item.code)).toContain("budget");
  expect(timers.at(-1).wait).toBe(5 * MINUTE);
  await add({ id: "quiet", when: { after: "0s" }, do: { script: script("ok.sh", "exit 0") } });
  await until(() => results().some((event) => event.id === "quiet"));
  await tick(24 * 60 * MINUTE + 1);
  expect(sent.length).toBeGreaterThan(48);
});

test("W10 a person can cancel a watch", async () => {
  await add({ id: "a", when: { after: "1m" }, do: { prompt: "x" } });
  await piWatch({ root, op: "cancel", id: "a" }, { now });
  await tick(5 * MINUTE);
  expect(sent).toEqual([]);
  await expect(piWatch({ root, op: "cancel", id: "a" }, { now })).rejects.toThrow(/No armed watch/);
});

test("W11 a script runs with no shell, a clean environment and a bounded record", async () => {
  process.env.NOEMA_FAKE_TOKEN = "secret";
  script("show.sh", 'echo "args:$1 root:$NOEMA_PROJECT_ROOT token:$NOEMA_FAKE_TOKEN"');
  await add({ id: "s", when: { after: "0s" }, do: { script: "show.sh", args: ["a b; touch hacked"], report: "pi" } });
  await until(() => journal().some((event) => event.kind === "result"));
  delete process.env.NOEMA_FAKE_TOKEN;
  expect(results()[0]).toMatchObject({ ok: true, exit: 0, tail: `args:a b; touch hacked root:${root} token:` });
  expect(existsSync(join(root, "hacked"))).toBe(false);
  expect(sent[0].prompt).toContain("show.sh succeeded");
});

test("W11 a script must be an executable file of this Project", async () => {
  const outside = join(elsewhere, "out.sh");
  writeFileSync(outside, "#!/bin/sh\n");
  chmodSync(outside, 0o755);
  symlinkSync(outside, join(root, "link.sh"));
  writeFileSync(join(root, "plain.sh"), "x");
  const run = (name: string) => add({ when: { after: "1m" }, do: { script: name } });
  await expect(run(outside)).rejects.toThrow(/file of this Project/);
  await expect(run("link.sh")).rejects.toThrow(/file of this Project/);
  await expect(run("plain.sh")).rejects.toThrow(/Not an executable/);
  await expect(run("none.sh")).rejects.toThrow(/No such script/);
});

test("W12 with nothing armed the watcher holds nothing", async () => {
  expect(watcher.idle()).toBe(true);
  expect(changes).toHaveLength(1);
  await add({ when: { after: "1m" }, do: { prompt: "x" } });
  await tick();
  expect(watcher.idle()).toBe(false);
  expect(changes).toHaveLength(1);
  await tick(MINUTE);
  await tick();
  expect(watcher.idle()).toBe(true);
});

test("W12 a long journal stays cheap to read", async () => {
  const fact = (index: number) => JSON.stringify({ kind: "fire", at: now, id: "a", n: index, reason: "x", message: false });
  await add({ id: "a", when: { every: "1m", times: 1_000_000 }, do: { script: script("ok.sh", "exit 0") } });
  writeFileSync(journalFile(), `${readFileSync(journalFile(), "utf8")}${Array.from({ length: 50_000 }, (_, index) => fact(index + 1)).join("\n")}\n`);
  const started = performance.now();
  await list();
  expect(performance.now() - started).toBeLessThan(500);
});

test("the catalog Pi carries each turn says only what choosing a Skill needs", () => {
  const catalog = { scope: "global", root: null, diagnostics: [],
    packs: [{ id: "ops", members: ["a"], preamble: "Use it." }],
    skills: [{ id: "a", description: "Does A", source: "/very/long/path/a/SKILL.md" }, { id: "b", description: "Does B", source: "/very/long/path/b/SKILL.md" }] };
  const text = renderAgentCatalog(catalog);
  expect(text).toContain("## ops\nUse it.\n- a: Does A");
  expect(text).toContain("- b: Does B");
  expect(text).not.toContain("/very/long/path");
  expect(renderAgentCatalog({ skills: [{ id: "c", description: "Partial answer" }] })).toContain("- c: Partial answer");
});
