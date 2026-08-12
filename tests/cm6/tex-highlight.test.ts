import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { scanTexSource, texTokenClass, type TexToken } from "../../src/cm6/tex-highlight.ts";

function kindsOf(source: string): Array<[string, string]> {
  return scanTexSource(source).map((token) => [source.slice(token.from, token.to), token.kind]);
}

function bracketsOf(source: string): Array<[string, number]> {
  return scanTexSource(source)
    .filter((token) => token.kind === "bracket")
    .map((token) => [source.slice(token.from, token.to), token.depth ?? -1]);
}

describe("TeX highlight scanner", () => {
  test("classifies commands, scripts, numbers and braces", () => {
    expect(kindsOf(String.raw`\frac{a}{12}^2`)).toEqual([
      [String.raw`\frac`, "command"],
      ["{", "bracket"],
      ["}", "bracket"],
      ["{", "bracket"],
      ["12", "number"],
      ["}", "bracket"],
      ["^", "script"],
      ["2", "number"],
    ]);
  });

  test("treats \\left and \\right as delimiters, not ordinary commands", () => {
    const kinds = kindsOf(String.raw`\left(\frac{a+b}{c}\right)^2`);
    expect(kinds).toContainEqual([String.raw`\left`, "delimiter"]);
    expect(kinds).toContainEqual([String.raw`\right`, "delimiter"]);
    expect(kinds).toContainEqual([String.raw`\frac`, "command"]);
  });

  test("reads a text argument as prose rather than math", () => {
    const kinds = kindsOf(String.raw`x+\text{ if a=1 }+y`);
    expect(kinds).toContainEqual([String.raw`\text`, "command"]);
    expect(kinds).toContainEqual([" if a=1 ", "text"]);
    // The `1` inside the prose must not come back as a math number token.
    expect(kinds.filter(([, kind]) => kind === "number")).toEqual([]);
  });

  test("names the environment in \\begin and \\end", () => {
    const kinds = kindsOf(String.raw`\begin{aligned}a&=b\end{aligned}`);
    expect(kinds).toContainEqual([String.raw`\begin`, "command"]);
    expect(kinds).toContainEqual(["aligned", "environment"]);
    expect(kinds).toContainEqual(["&", "align"]);
  });

  test("stops a comment at the line end and never at an escaped percent", () => {
    const source = "a % note\nb \\% not a comment";
    const comments = scanTexSource(source)
      .filter((token) => token.kind === "comment")
      .map((token) => source.slice(token.from, token.to));
    expect(comments).toEqual(["% note"]);
  });

  test("reads a row separator as alignment, not as an escaped backslash", () => {
    expect(kindsOf("a\\\\b")).toEqual([["\\\\", "align"]]);
  });

  test("gives both halves of a pair the same depth, increasing inward", () => {
    expect(bracketsOf("{{{}}}")).toEqual([
      ["{", 0], ["{", 1], ["{", 2], ["}", 2], ["}", 1], ["}", 0],
    ]);
  });

  test("shares one depth stack across brace, paren and command brackets", () => {
    expect(bracketsOf(String.raw`{(\{\})}`)).toEqual([
      ["{", 0],
      ["(", 1],
      [String.raw`\{`, 2],
      [String.raw`\}`, 2],
      [")", 1],
      ["}", 0],
    ]);
  });

  test("cycles colours so deep nesting stays readable", () => {
    const depth = 8;
    const openers = bracketsOf(`${"{".repeat(depth)}a${"}".repeat(depth)}`)
      .slice(0, depth)
      .map(([, value]) => value);
    expect(openers).toEqual([0, 1, 2, 3, 4, 5, 0, 1]);
  });

  test("flags unmatched brackets on both sides", () => {
    expect(bracketsOf("{a")).toEqual([["{", -1]]);
    expect(bracketsOf("a}")).toEqual([["}", -1]]);
    expect(bracketsOf("{a(b}")).toEqual([["{", 0], ["(", -1], ["}", 0]]);
  });

  test("keeps repeated wrong closers linear with a deep opener stack", () => {
    const depth = 20_000;
    const source = "(".repeat(depth) + "]".repeat(depth);
    const started = performance.now();
    const brackets = scanTexSource(source).filter((token) => token.kind === "bracket");
    expect(brackets).toHaveLength(depth * 2);
    expect(brackets.every((token) => token.depth === -1)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("offsets every token by baseOffset", () => {
    const tokens = scanTexSource(String.raw`\alpha`, 100);
    expect(tokens[0]).toMatchObject({ from: 100, to: 106, kind: "command" });
  });

  test("maps tokens to stable CSS classes", () => {
    const bracket = (depth: number): TexToken => ({ from: 0, to: 1, kind: "bracket", depth });
    expect(texTokenClass(bracket(2))).toBe("cm-tex-bracket cm-tex-bracket-2");
    expect(texTokenClass(bracket(-1))).toBe("cm-tex-bracket cm-tex-bracket-unmatched");
    expect(texTokenClass({ from: 0, to: 1, kind: "command" })).toBe("cm-tex-command");
  });
});
