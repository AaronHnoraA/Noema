// @vitest-environment node
// Contract: docs/noema/design/math-exploration.md L1-L8.  Cases translated
// from Open Math Harness's rules.rs and verify.rs tests; the real-Lean run is
// opt-in (NOEMA_LEAN_JUDGE_LIVE=1, a Lake project with Mathlib in NOEMA_LEAN_LAKE).
import { expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForbiddenToken, extractStatement, forbiddenToken, frozenObjection, harnessReport, judge, leanCode,
  leanJudge, parseAxioms, preambleCopy, protocolObjection, theoremName,
} from "../server/lib/lean-judge.mjs";

const FROZEN = "import Mathlib\n\ntheorem demo (n : Nat) : n + 0 = n :=\nsorry\n";
const objection = (frozen: string, candidate: string) => {
  try { preambleCopy(frozen, candidate); return null; } catch (error: any) { return error.message; }
};

test("L2 a comment is not code and a statement is read on code", () => {
  const statement = extractStatement(FROZEN)!;
  expect(statement).toBe("theorem demo (n : Nat) : n + 0 = n :=");
  expect(theoremName(FROZEN)).toBe("demo");
  const partial = `import Mathlib\n\n${statement} by\n  have h : True := trivial\n  sorry\n`;
  expect(protocolObjection(statement, partial)).toBeNull();
  expect(protocolObjection(statement, partial.replace("(n : Nat)", "(n : Nat )"))).toContain("byte for byte");
  expect(protocolObjection(statement, partial.replace("trivial", "by native_decide"))).toContain("native_decide");
  expect(protocolObjection(statement, `axiom cheat : False\n${partial}`)).toContain("axiom");
  expect(protocolObjection(statement, `-- native_decide, in a comment\n${partial}`)).toBeNull();
  expect(leanCode("a -- b\nc /- d /- e -/ f -/ g")).toBe("a     \nc                   g");
});

test("L2 what runs code at elaboration is forbidden, imports aside", () => {
  expect(checkForbiddenToken("import Mathlib.Tactic\ntheorem t : True := trivial")).toBeNull();
  expect(checkForbiddenToken("#eval IO.println 1")).toBe("#eval");
  expect(checkForbiddenToken("open Lean in\ntheorem t : True := trivial")).toBe("Lean");
  expect(checkForbiddenToken("macro \"x\" : term => `(1)")).toBe("macro");
  expect(checkForbiddenToken("set_option pp.all true")).toBe("set_option pp");
  expect(checkForbiddenToken("set_option debug.skipKernelTC true")).toBe("set_option debug");
  expect(checkForbiddenToken("def f := s!\"x\"")).toContain("unambiguously");
  expect(forbiddenToken("theorem t : True := by sorry")).toBe("sorry");
  expect(forbiddenToken("theorem t : True := trivial -- sorry")).toBeNull();
});

test("L3 a string literal in the preamble is kept character for character", () => {
  const frozen = "import Mathlib\n\ndef s : String := \"a\n\nb  \"\n\ntheorem demo : s.length = 3 :=\nsorry\n";
  const proof = (preamble: string) => `${preamble}\n\ntheorem demo : s.length = 3 :=\n by decide\n`;
  for (const [preamble, kept] of [
    ["import Mathlib\n\ndef s : String := \"a\n\nb  \"", true],
    ["-- a comment\nimport Mathlib\ndef s : String := \"a\n\nb  \"   ", true],
    ["import Mathlib\n\ndef s : String := \"a\nb  \"", false],
    ["import Mathlib\n\ndef s : String := \"a\n\nb\"", false],
  ] as const) expect(objection(frozen, proof(preamble)) === null).toBe(kept);
});

test("L1 a frozen file is refused when no proof could pass", () => {
  const moved = "import Mathlib\n\n/-\ntheorem kmp is about the answer below.\n-/\ndef answer : ℕ := 5\n\ntheorem kmp : answer = 6 := by\n  sorry\n";
  expect(extractStatement(moved)).toBe("theorem kmp : answer = 6 :=");
  expect(frozenObjection(moved)).toBeNull();
  expect(frozenObjection("import Mathlib\n\nabbrev answer : ℕ := sorry\n\ntheorem kmp : answer = 6 := by\n  sorry\n")).toContain("before the proof");
  expect(frozenObjection("import Mathlib\n\ntheorem kmp : answer = 6 := by\n  sorry\n/- a note")).toContain("-/");
  expect(frozenObjection("import Mathlib\n\ntheorem kmp : 1 + 1 = 2 := by\n  norm_num\n  sorry\n")).toContain("alone");
  expect(frozenObjection("import Mathlib\nopen Nat in\ntheorem kmp : 1 + 1 = 2 := by\n  sorry\n")).toContain("`in`");
  // A commented-out copy cannot smuggle a second definition past the preamble rule.
  const forged = "import Mathlib\n\ndef answer : ℕ := 6\n\n/- /-\ntheorem kmp is about the answer below.\n-/\ndef answer : ℕ := 5\n\ntheorem kmp : answer = 6 :=\n-/\n\ntheorem kmp : answer = 6 := by\n  rfl\n";
  expect(objection(moved, forged)).toContain("def answer : ℕ := 5");
});

test("L5 only the report after the marker is read", () => {
  const marker = "noema-report-x";
  const good = `junk\n${marker}\n'demo' depends on axioms: [propext]\ndemo : ∀ (n : Nat), n + 0 = n\n`;
  expect(harnessReport(good, marker, "demo")).toEqual({ axiomLine: "'demo' depends on axioms: [propext]", type: "demo : ∀ (n : Nat), n + 0 = n" });
  expect(harnessReport(`${marker}\n${good}`, marker, "demo")).toBeNull();
  expect(harnessReport(`${marker}\nanything else\n`, marker, "demo")).toBeNull();
  expect(parseAxioms("'demo' depends on axioms: [propext, sorryAx]")).toEqual({ sorry: true, axioms: ["propext", "sorryAx"] });
});

/** A Lean stand-in that answers by the probe's text. */
const fakeLean = (type: (probe: string) => string, axioms = "does not depend on any axioms", extra = "") =>
  async (probe: string) => {
    const marker = /#print "(noema-report-[0-9a-f]+)"/.exec(probe)?.[1];
    return { output: `${extra}${marker}\n'demo' ${axioms}\n${type(probe)}\n` };
  };
const PROOF = "import Mathlib\n\ntheorem demo (n : Nat) : n + 0 = n :=\nby simp\n";

test("L4 verify accepts only the pristine type with trusted axioms", async () => {
  const type = () => "demo : ∀ (n : Nat), n + 0 = n";
  expect(await judge({ op: "verify", frozen: FROZEN, candidate: PROOF, run: fakeLean(type) })).toMatchObject({ accepted: true });
  const shadowed = (probe: string) => probe.includes("by simp") ? "demo : ∀ (n : MyNat), n + 0 = n" : type();
  expect(await judge({ op: "verify", frozen: FROZEN, candidate: PROOF.replace("\n", "\n\n"), run: fakeLean(shadowed) }))
    .toMatchObject({ accepted: false, rejection: "type_mismatch" });
  expect(await judge({ op: "verify", frozen: FROZEN, candidate: PROOF, run: fakeLean(type, "depends on axioms: [Classical.choice, myAxiom]") }))
    .toMatchObject({ accepted: false, rejection: "non_standard_axioms", detail: "myAxiom" });
  expect(await judge({ op: "verify", frozen: FROZEN, candidate: PROOF, run: async () => ({ noVerdict: "timed out" }) }))
    .toMatchObject({ accepted: null, status: "no_verdict" });
  expect(await judge({ op: "verify", frozen: FROZEN, candidate: PROOF, run: async (p: string) => (p.includes("by simp") ? { refused: "x.lean:4:3: error(lean.x): no", output: "x.lean:4:3: error(lean.x): no" } : fakeLean(type)(p)) }))
    .toMatchObject({ accepted: false, rejection: "elaboration" });
});

test("L6 check grades a partial proof from Lean's diagnostics", async () => {
  const run = async () => ({ file: "/t/Candidate.lean", output: "/t/Candidate.lean:4:0: warning: declaration uses 'sorry'\n" });
  expect(await judge({ op: "check", frozen: FROZEN, candidate: PROOF.replace("by simp", "by sorry"), run }))
    .toMatchObject({ status: "sorries", sorries: 1 });
  const failing = async () => ({ file: "/t/Candidate.lean", refused: "", output: "/t/Candidate.lean:4:3: error(lean.unknownIdentifier): Unknown identifier `x`\n  more\n" });
  expect(await judge({ op: "check", frozen: FROZEN, candidate: PROOF, run: failing }))
    .toMatchObject({ status: "errors", errors: [{ line: 4, col: 3, message: "Unknown identifier `x`\n  more" }] });
});

test("L7 files in: the statement comes from the person's file, never the request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-"));
  writeFileSync(join(dir, "Frozen.lean"), FROZEN);
  writeFileSync(join(dir, "Proof.lean"), PROOF);
  expect(await leanJudge({ op: "statement", statement: join(dir, "Frozen.lean") })).toMatchObject({ ok: true, theorem: "demo" });
  await expect(leanJudge({ op: "verify", statement: join(dir, "Frozen.lean"), candidate: join(dir, "Proof.lean") })).rejects.toThrow(/Lake/);
  const verdict = await leanJudge({ op: "verify", statement: join(dir, "Frozen.lean"), candidate: join(dir, "Proof.lean"), lake: dir },
    { run: fakeLean(() => "demo : ∀ (n : Nat), n + 0 = n") });
  expect(verdict).toMatchObject({ accepted: true, lake: dir });
});

test.skipIf(!process.env.NOEMA_LEAN_JUDGE_LIVE)("L8 real Lean decides (opt-in)", async () => {
  const lake = process.env.NOEMA_LEAN_LAKE!;
  const dir = mkdtempSync(join(tmpdir(), "judge-live-"));
  writeFileSync(join(dir, "Frozen.lean"), FROZEN);
  writeFileSync(join(dir, "Proof.lean"), PROOF);
  writeFileSync(join(dir, "Wrong.lean"), PROOF.replace("by simp", "by rfl\n  done"));
  expect(await leanJudge({ op: "verify", statement: join(dir, "Frozen.lean"), candidate: join(dir, "Proof.lean"), lake })).toMatchObject({ accepted: true });
  expect(await leanJudge({ op: "verify", statement: join(dir, "Frozen.lean"), candidate: join(dir, "Wrong.lean"), lake })).toMatchObject({ accepted: false });
}, 600_000);
