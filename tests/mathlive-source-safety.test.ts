import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  MAX_MATHLIVE_ENVIRONMENT_DEPTH,
  MAX_MATHLIVE_GROUP_DEPTH,
  MAX_MATHLIVE_SOURCE_LENGTH,
  MathLiveSourceSafetyError,
  inspectMathLiveSourceSafety,
} from "../src/cm6/extensions/visual/widgets/mathlive-source-safety.ts";
import {
  mountVisualTexDisplayEditor,
  mountVisualTexInlineEditor,
  visualTexRowsCarryColumns,
  visualTexWritebackIssue,
} from "../src/cm6/extensions/visual/widgets/visualtex-inline.ts";

describe("MathLive source safety", () => {
  test("accepts ordinary formulas and escaped braces", () => {
    expect(inspectMathLiveSourceSafety(String.raw`\frac{a}{b}+\{x\}`)).toBeNull();
    expect(inspectMathLiveSourceSafety("\\{".repeat(MAX_MATHLIVE_GROUP_DEPTH + 10))).toBeNull();
  });

  test("reports length, group depth and environment depth", () => {
    expect(inspectMathLiveSourceSafety("x".repeat(MAX_MATHLIVE_SOURCE_LENGTH + 1))?.kind)
      .toBe("source-length");
    const groups = "{".repeat(MAX_MATHLIVE_GROUP_DEPTH + 1) + "}".repeat(MAX_MATHLIVE_GROUP_DEPTH + 1);
    expect(inspectMathLiveSourceSafety(groups)?.kind).toBe("group-depth");
    const depth = MAX_MATHLIVE_ENVIRONMENT_DEPTH + 1;
    const environments = String.raw`\begin{aligned}`.repeat(depth) + String.raw`\end{aligned}`.repeat(depth);
    expect(inspectMathLiveSourceSafety(environments)?.kind).toBe("environment-depth");
  });

  test("LiveTeX falls back to source instead of mounting MathLive", async () => {
    const host = document.createElement("span");
    document.body.append(host);
    const failures: unknown[] = [];
    const editor = mountVisualTexInlineEditor(host, {
      latex: "{".repeat(MAX_MATHLIVE_GROUP_DEPTH + 1) + "x" + "}".repeat(MAX_MATHLIVE_GROUP_DEPTH + 1),
      macros: {},
      entry: { kind: "start" },
      onInput: () => {},
      onCommit: () => {},
      onUnavailable: (error) => failures.push(error),
    });
    await editor.ready;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(MathLiveSourceSafetyError);
    expect(host.querySelector("math-field")).toBeNull();
    editor.destroy();
    host.remove();
  });

  test("names formulas MathLive would write back differently", () => {
    const R = String.raw;
    for (const source of [
      R`\frac{a}{b}`,
      R`A = \begin{pmatrix}a & b & c \\ d & e & f\end{pmatrix}`,
      R`\begin{cases}1 & x > 0 \\ 0 & \text{otherwise}\end{cases}`,
      R`\begin{aligned}a &= b & c &= d \\ &\quad + 2\end{aligned}`,
      R`\begin{align}a &= b \\ c &= d\end{align}`,
      R`\begin{array}{lcr}a & b & c\end{array}`,
      R`\begin{gather}a = b \\ c = d\end{gather}`,
      R`\text{R\&D} + \begin{matrix}1 & 2\end{matrix}`,
    ]) expect(visualTexWritebackIssue(source), source).toBeNull();

    // An environment MathLive does not know loses its \begin.
    for (const name of ["alignat", "alignedat", "flalign", "CD", "drcases", "subarray", "eqnarray", "equation"]) {
      expect(visualTexWritebackIssue(`\\begin{${name}}a & b\\end{${name}}`), name).toContain(name);
    }
    // A third cell is re-wrapped onto a new row; gather has no cells at all.
    expect(visualTexWritebackIssue(R`\begin{align}a &= b & c &= d\end{align}`)).toContain("align");
    expect(visualTexWritebackIssue(R`\begin{align*}a &= b \\ e &= f && \text{note}\end{align*}`)).toContain("align*");
    expect(visualTexWritebackIssue(R`\begin{split}a &= b & c\end{split}`)).toContain("split");
    expect(visualTexWritebackIssue(R`\begin{gathered}a & b\end{gathered}`)).toContain("gathered");
    expect(visualTexWritebackIssue(R`x = \begin{aligned}\begin{alignat}{2}a\end{alignat}\end{aligned}`))
      .toContain("alignat");
    expect(visualTexWritebackIssue("a & b")).not.toBeNull();
  });

  test("rows that carry columns are edited as one formula", () => {
    const R = String.raw;
    expect(visualTexRowsCarryColumns(R`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`)).toBe(true);
    expect(visualTexRowsCarryColumns(R`\begin{cases}1 & x > 0\end{cases}`)).toBe(true);
    expect(visualTexRowsCarryColumns(R`\begin{aligned}x &= 1 \\ &\quad + 2\end{aligned}`)).toBe(true);
    // One marker before the relation is regenerated, so the row has none.
    expect(visualTexRowsCarryColumns(R`\begin{aligned}a &= b \\ c &= d\end{aligned}`)).toBe(false);
    expect(visualTexRowsCarryColumns(R`A = \begin{pmatrix}a & b\end{pmatrix}`)).toBe(false);
    expect(visualTexRowsCarryColumns("a = b")).toBe(false);
  });

  test("an environment MathLive would rewrite stays source", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const failures: unknown[] = [];
    const editor = mountVisualTexDisplayEditor(host, {
      latex: String.raw`\begin{alignat}{2}a &= b & c &= d\end{alignat}`,
      macros: {},
      entry: { kind: "start" },
      advanced: true,
      onInput: () => {},
      onCommit: () => {},
      onUnavailable: (error) => failures.push(error),
    });
    await editor.ready;
    expect(failures).toHaveLength(1);
    expect(String((failures[0] as Error).message)).toContain("alignat");
    expect(host.querySelector("math-field")).toBeNull();
    editor.destroy();
    host.remove();
  });
});
