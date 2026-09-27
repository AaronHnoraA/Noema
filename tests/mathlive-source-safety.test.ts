import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  MAX_MATHLIVE_ENVIRONMENT_DEPTH,
  MAX_MATHLIVE_GROUP_DEPTH,
  MAX_MATHLIVE_SOURCE_LENGTH,
  MathLiveSourceSafetyError,
  inspectMathLiveSourceSafety,
} from "../src/cm6/extensions/visual/widgets/mathlive-source-safety.ts";
import { mountVisualTexInlineEditor } from "../src/cm6/extensions/visual/widgets/visualtex-inline.ts";

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
});
