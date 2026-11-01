// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { createPiWatcher, foldWatches, piWatch } from "../server/lib/pi-watch.mjs";
import { projectGraph } from "../server/lib/project-graph.mjs";

const MINUTE = 60_000;
let root: string;
let state: string;
let now: number;
let sent: any[];
let refuse: string[];
let watcher: any;
let timers: any[];
let changes: Array<() => void>;

const journal = () => readFileSync(join(root, ".agent/pi/journal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const kinds = (kind: string) => journal().filter((event) => event.kind === kind);
const add = (body: any) => piWatch({ root, op: "add", agent: "codex", why: "Check it", ...body }, { watcher, now });
const list = () => piWatch({ root, op: "list" }, { now }) as Promise<any>;
const script = (name: string, body: string) => {
  const file = join(root, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return name;
};

function makeWatcher() {
  return createPiWatcher({
    rootsFile: join(state, "roots.json"),
    clock: () => now,
    deliver: {
      pi: async (body: any) => { sent.push({ via: "pi", ...body }); if (refuse.includes("pi")) throw new Error("Emacs is away"); return { ok: true }; },
      agent: async (body: any) => { sent.push({ via: "agent", ...body }); if (refuse.includes("agent")) throw new Error("Session identity no longer matches"); return { ok: true }; },
    },
    setTimer: ((run: () => void) => { const timer = { run, unref() {} }; timers.push(timer); return timer; }) as any,
    clearTimer: ((timer: any) => { timers = timers.filter((item) => item !== timer); }) as any,
    watchImpl: ((_path: string, onChange: () => void) => { changes.push(onChange); return { close() { changes = changes.filter((item) => item !== onChange); }, on() {} }; }) as any,
  });
}

/** Move the clock and let the watcher do everything that is now due. */
async function tick(advance = 0) {
  now += advance;
  for (let round = 0; round < 6; round += 1) {
    await watcher.register(root);
    await watcher.drain();
    await new Promise((done) => setTimeout(done, 15));
  }
}

const settle = async (test: () => boolean) => {
  for (let round = 0; round < 200 && !test(); round += 1) { await tick(); }
  await tick();
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-watch-")));
  state = mkdtempSync(join(tmpdir(), "pi-watch-state-"));
  execFileSync("git", ["init", "-q", root]);
  now = Date.parse("2026-11-02T00:00:00Z");
  sent = [];
  refuse = [];
  timers = [];
  changes = [];
  watcher = makeWatcher();
});

afterEach(async () => {
  await watcher.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("W1 facts stay in the Project's .agent, which Git does not track", async () => {
  await add({ when: { after: "20m" }, do: { prompt: "Look at CI" } });
  expect(existsSync(join(root, ".agent/pi/journal.jsonl"))).toBe(true);
  expect(execFileSync("git", ["-C", root, "status", "--short"]).toString()).toBe("");
});

test("W2 a countdown fires once, carrying who set it and that it is not the person", async () => {
  const { id } = await add({ when: { after: "20m" }, do: { prompt: "Look at CI" } }) as any;
  await tick(19 * MINUTE);
  expect(sent).toEqual([]);
  await tick(MINUTE);
  await tick(60 * MINUTE);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ via: "pi", action: "send", root });
  expect(sent[0].prompt).toContain(`Watch ${id} fired`);
  expect(sent[0].prompt).toContain("Set by codex, not the person");
  expect(sent[0].prompt).toContain("Look at CI");
  expect((await list()).armed).toEqual([]);
});

test("W3 a time missed while the host was away fires once, late, on the next start", async () => {
  await add({ when: { every: "10m", until: new Date(now + 600 * MINUTE).toISOString() }, do: { prompt: "Check" } });
  await watcher.stop();
  now += 95 * MINUTE;
  watcher = makeWatcher();
  await watcher.start();
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("late");
  await tick(MINUTE);
  expect(sent).toHaveLength(1);
});

test("W4 every watch ends, and a repeat needs no one to stop it", async () => {
  await expect(add({ when: { every: "30s" }, do: { prompt: "x" } })).rejects.toThrow(/at least 1m/);
  await expect(add({ when: { after: "1h", until: new Date(now + 40 * 24 * 60 * MINUTE).toISOString() }, do: { prompt: "x" } })).rejects.toThrow(/30 days/);
  await add({ when: { every: "1m", times: 2 }, do: { prompt: "x" } });
  await tick(MINUTE);
  await tick(MINUTE);
  await tick(MINUTE);
  expect(sent).toHaveLength(2);
  const { events } = { events: journal() };
  expect(foldWatches(events, now).watches.values().next().value.state).toBe("done");
  await add({ id: "forgotten", when: { on: { kind: "submit" } }, do: { prompt: "x" } });
  expect((await list()).armed).toHaveLength(1);
  now += 8 * 24 * 60 * MINUTE;
  expect((await list()).armed).toEqual([]);
});

test("W5 a hook fires on a graph event an Agent wrote without the host", async () => {
  await projectGraph({ root, op: "plan", agent: "a", tasks: [{ id: "a", title: "A", body: "- [x] done" }] });
  await add({ when: { on: { kind: "submit", task: "a" } }, do: { prompt: "Review it" } });
  await projectGraph({ root, op: "claim", id: "a", agent: "a" });
  await tick();
  expect(sent).toEqual([]);
  expect(changes).toHaveLength(1);
  await projectGraph({ root, op: "submit", id: "a", agent: "a", evidence: "tests" });
  changes[0]();
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("submit of a");
  await tick();
  expect(sent).toHaveLength(1);
});

test("W5 a hook sees nothing from before it was added, and catches up after a restart", async () => {
  await projectGraph({ root, op: "plan", agent: "a", tasks: [{ id: "a", title: "A", body: "- [x] done" }, { id: "b", title: "B", body: "- [x] done", after: ["a"] }] });
  await projectGraph({ root, op: "claim", id: "a", agent: "a" });
  await add({ when: { on: { kind: "claim" } }, do: { prompt: "A claim" } });
  await tick();
  expect(sent).toEqual([]);
  await watcher.stop();
  await projectGraph({ root, op: "claim", id: "a", agent: "b", take: true }).catch(() => {});
  await projectGraph({ root, op: "release", id: "a", agent: "a" }).catch(() => {});
  await projectGraph({ root, op: "claim", id: "a", agent: "b" });
  watcher = makeWatcher();
  await watcher.start();
  await tick();
  expect(sent).toHaveLength(1);
});

test("W5 a phase is a condition: it fires when the task gets there", async () => {
  await projectGraph({ root, op: "plan", agent: "a", tasks: [{ id: "a", title: "A", body: "- [x] done" }, { id: "b", title: "B", body: "- [x] done", after: ["a"] }] });
  await expect(add({ when: { on: { phase: "ready", task: "b" }, times: 2 }, do: { prompt: "x" } })).rejects.toThrow(/fires once/);
  await add({ when: { on: { phase: "ready", task: "b" } }, do: { prompt: "b can start" } });
  await tick();
  expect(sent).toEqual([]);
  await projectGraph({ root, op: "claim", id: "a", agent: "a" });
  await projectGraph({ root, op: "submit", id: "a", agent: "a", evidence: "tests" });
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].prompt).toContain("b is ready");
});

test("W5 a session fact is kept only when a watch asks for it", async () => {
  await add({ id: "t", when: { after: "1h" }, do: { prompt: "x" } });
  expect(await piWatch({ root, op: "event", name: "turn-end", buffer: "*a*" }, { now })).toMatchObject({ kept: false });
  await add({ id: "h", when: { on: { kind: "turn-end", buffer: "*a*" } }, do: { to: { buffer: "*b*", nativeSessionId: "n" }, prompt: "Your turn" } });
  expect(await piWatch({ root, op: "event", name: "turn-end", buffer: "*z*" }, { now })).toMatchObject({ kept: false });
  expect(await piWatch({ root, op: "event", name: "turn-end", buffer: "*a*" }, { now })).toMatchObject({ kept: true });
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ via: "agent", buffer: "*b*", nativeSessionId: "n" });
});

test("W6 a message nobody accepted is retried, then reported, and never lost silently", async () => {
  refuse = ["pi"];
  await add({ when: { after: "1m" }, do: { prompt: "x" } });
  await tick(MINUTE);
  expect(sent).toHaveLength(1);
  await tick(MINUTE);
  expect(sent).toHaveLength(2);
  await tick(5 * MINUTE);
  await tick(15 * MINUTE);
  expect(sent).toHaveLength(4);
  await tick(60 * MINUTE);
  expect(sent).toHaveLength(4);
  expect((await list()).findings).toMatchObject([{ code: "failed" }]);
});

test("W6 a session that is gone falls back to Pi", async () => {
  refuse = ["agent"];
  await add({ when: { after: "1m" }, do: { to: { buffer: "*gone*", nativeSessionId: "n" }, prompt: "Wake up" } });
  await tick(MINUTE);
  expect(sent.map((item) => item.via)).toEqual(["agent", "pi"]);
  expect(sent[1].prompt).toContain("*gone*");
  expect(kinds("result")).toMatchObject([{ ok: true }]);
});

test("W7 a firing cut off by a crash is reported, never replayed", async () => {
  await add({ id: "s", when: { after: "1m" }, do: { prompt: "x" } });
  const { appendEvent } = await import("../server/lib/agent-journal.mjs");
  await appendEvent(join(root, ".agent/pi/journal.jsonl"), { kind: "fire", at: now, id: "s", n: 1, reason: "x", message: true });
  await tick(MINUTE);
  await tick(MINUTE);
  expect(sent).toEqual([]);
  expect((await list()).findings).toMatchObject([{ code: "unknown", id: "s" }]);
});

test("W8 a torn last line costs that line and nothing else", async () => {
  await add({ id: "a", when: { after: "1h" }, do: { prompt: "x" } });
  writeFileSync(join(root, ".agent/pi/journal.jsonl"), `${readFileSync(join(root, ".agent/pi/journal.jsonl"), "utf8")}{"kind":"fi`);
  await add({ id: "b", when: { after: "1h" }, do: { prompt: "y" } });
  expect((await list()).armed.map((watch: any) => watch.id)).toEqual(["a", "b"]);
});

test("W8 a retried add is one watch", async () => {
  const first = await add({ requestId: "r", when: { after: "1h" }, do: { prompt: "x" } }) as any;
  const second = await add({ requestId: "r", when: { after: "1h" }, do: { prompt: "x" } }) as any;
  expect(second).toMatchObject({ id: first.id, replayed: true });
  expect(kinds("watch")).toHaveLength(1);
});

test("W9 messages have a daily budget, and scripts do not spend it", async () => {
  for (let index = 0; index < 48; index += 1)
    await piWatch({ root, op: "add", agent: "a", why: "x", id: `m${index}`, when: { after: "0s" }, do: { prompt: "x" } }, { now });
  await add({ id: "over", when: { after: "0s" }, do: { prompt: "x" } });
  await settle(() => sent.length >= 48);
  await tick(MINUTE);
  expect(sent).toHaveLength(48);
  expect((await list()).findings.map((item: any) => item.code)).toContain("budget");
  await add({ id: "quiet", when: { after: "0s" }, do: { script: script("ok.sh", "exit 0") } });
  await settle(() => kinds("result").some((event) => event.id === "quiet"));
  expect(kinds("result").find((event) => event.id === "quiet")).toMatchObject({ ok: true });
  await tick(24 * 60 * MINUTE);
  expect(sent.length).toBeGreaterThan(48);
});

test("W10 a person can stop everything, and pausing keeps what is armed", async () => {
  await add({ id: "a", when: { after: "1m" }, do: { prompt: "x" } });
  await piWatch({ root, op: "pause" }, { watcher, now });
  await tick(5 * MINUTE);
  expect(sent).toEqual([]);
  expect(watcher.idle()).toBe(true);
  await piWatch({ root, op: "resume" }, { watcher, now });
  await tick();
  expect(sent).toHaveLength(1);
  await add({ id: "b", when: { after: "1m" }, do: { prompt: "y" } });
  await piWatch({ root, op: "cancel", id: "b" }, { watcher, now });
  await tick(5 * MINUTE);
  expect(sent).toHaveLength(1);
});

test("W11 a script runs with no shell, a clean environment and a bounded log", async () => {
  process.env.NOEMA_FAKE_TOKEN = "secret";
  script("show.sh", 'echo "args:$1 root:$NOEMA_PROJECT_ROOT token:$NOEMA_FAKE_TOKEN"');
  await add({ id: "s", when: { after: "0s" }, do: { script: "show.sh", args: ["a b; touch hacked"], report: "pi" } });
  await settle(() => kinds("result").length > 0 && sent.length > 0);
  delete process.env.NOEMA_FAKE_TOKEN;
  const result = kinds("result")[0];
  expect(result).toMatchObject({ ok: true, exit: 0 });
  expect(result.tail).toBe(`args:a b; touch hacked root:${root} token:`);
  expect(existsSync(join(root, "hacked"))).toBe(false);
  expect((await piWatch({ root, op: "log", id: "s" }, { now }) as any).text).toContain("args:a b");
  expect(sent[0].prompt).toContain("show.sh succeeded");
});

test("W11 a script must be an executable file of this Project", async () => {
  const outside = join(state, "out.sh");
  writeFileSync(outside, "#!/bin/sh\n");
  chmodSync(outside, 0o755);
  symlinkSync(outside, join(root, "link.sh"));
  writeFileSync(join(root, "plain.sh"), "x");
  await expect(add({ when: { after: "1m" }, do: { script: outside } })).rejects.toThrow(/file of this Project/);
  await expect(add({ when: { after: "1m" }, do: { script: "link.sh" } })).rejects.toThrow(/file of this Project/);
  await expect(add({ when: { after: "1m" }, do: { script: "plain.sh" } })).rejects.toThrow(/Not an executable/);
  await expect(add({ when: { after: "1m" }, do: { script: "none.sh" } })).rejects.toThrow(/No such script/);
  await expect(add({ when: { after: "1m" }, do: { script: script("s.sh", ""), args: "x" } })).rejects.toThrow(/array of strings/);
});

test("W11 a script's end is itself a fact a hook can follow", async () => {
  await add({ id: "build", when: { after: "0s" }, do: { script: script("bad.sh", "echo broken; exit 3") } });
  await add({ id: "fix", when: { on: { kind: "script-failed", watch: "build" } }, do: { prompt: "The build broke" } });
  await settle(() => sent.length > 0);
  expect(kinds("result")[0]).toMatchObject({ ok: false, exit: 3, tail: "broken" });
  expect(sent[0].prompt).toContain("script-failed");
});

test("W12 with nothing armed the watcher holds nothing", async () => {
  await watcher.start();
  expect(watcher.idle()).toBe(true);
  mkdirSync(join(root, ".agent"), { recursive: true });
  await add({ id: "a", when: { after: "1m" }, do: { prompt: "x" } });
  await tick();
  expect(watcher.idle()).toBe(false);
  expect(changes).toEqual([]);
  await tick(MINUTE);
  await tick(MINUTE);
  expect(watcher.idle()).toBe(true);
});

test("W12 a watch held by the pause or the budget does not spin", async () => {
  await add({ id: "a", when: { after: "0s" }, do: { prompt: "x" } });
  await piWatch({ root, op: "pause" }, { watcher, now });
  const before = timers.length;
  await tick();
  expect(timers.length).toBeLessThanOrEqual(before);
});

test("the catalog Pi carries each turn says only what choosing a Skill needs", async () => {
  const { renderAgentCatalog } = await import("../server/lib/agent-catalog-text.mjs");
  const catalog = { scope: "global", root: null, diagnostics: [],
    packs: [{ id: "ops", members: ["a"], preamble: "Use it." }],
    skills: [{ id: "a", description: "Does A", source: "/very/long/path/a/SKILL.md" }, { id: "b", description: "Does B", source: "/very/long/path/b/SKILL.md" }] };
  const text = renderAgentCatalog(catalog);
  expect(text).toContain("## ops\nUse it.\n- a: Does A");
  expect(text).toContain("- b: Does B");
  expect(text).not.toContain("/very/long/path");
  expect(renderAgentCatalog({ ...catalog, diagnostics: [{ id: "a", severity: "warning", code: "x" }] })).toContain("Diagnostics");
});
