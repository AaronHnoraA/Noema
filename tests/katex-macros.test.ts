import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { parseLatexMacros } from "../shared/katex-macros.mjs";
import {
  getKatexMacros,
  getKatexMacrosVersion,
  setKatexMacros,
} from "../src/katex-macros.ts";
import { renderMathHTML } from "../src/math-render.ts";

afterEach(() => {
  // Reset the global environment so tests stay independent.
  setKatexMacros({});
});

describe("parseLatexMacros", () => {
  test("parses \\newcommand with and without args and braces", () => {
    const { macros, errors } = parseLatexMacros([
      {
        name: "a.tex",
        text: [
          "\\newcommand{\\R}{\\mathbb{R}}",
          "\\newcommand{\\abs}[1]{\\left|#1\\right|}",
          "\\newcommand\\Z{\\mathbb{Z}}",
        ].join("\n"),
      },
    ]);
    expect(errors).toEqual([]);
    expect(macros["\\R"]).toBe("\\mathbb{R}");
    expect(macros["\\abs"]).toBe("\\left|#1\\right|");
    expect(macros["\\Z"]).toBe("\\mathbb{Z}");
  });

  test("converts \\DeclareMathOperator to \\operatorname", () => {
    const { macros } = parseLatexMacros([
      { name: "a.tex", text: "\\DeclareMathOperator{\\rank}{rank}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}" },
    ]);
    expect(macros["\\rank"]).toBe("\\operatorname{rank}");
    expect(macros["\\argmax"]).toBe("\\operatorname*{arg\\,max}");
  });

  test("handles \\renewcommand, \\def, nested braces and comments", () => {
    const { macros } = parseLatexMacros([
      {
        name: "a.tex",
        text: [
          "% a comment with { unbalanced brace",
          "\\renewcommand{\\vec}[1]{\\mathbf{#1}}",
          "\\def\\foo{\\alpha{\\beta}}",
          "\\newcommand{\\ketbra}[2]{\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|} % trailing",
        ].join("\n"),
      },
    ]);
    expect(macros["\\vec"]).toBe("\\mathbf{#1}");
    expect(macros["\\foo"]).toBe("\\alpha{\\beta}");
    expect(macros["\\ketbra"]).toBe("\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|");
  });

  test("records errors instead of throwing on malformed input", () => {
    const { macros, errors } = parseLatexMacros([
      { name: "bad.tex", text: "\\newcommand{\\bad}{\\unbalanced" },
    ]);
    expect(macros["\\bad"]).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.file).toBe("bad.tex");
  });
});

describe("global macro environment", () => {
  test("setKatexMacros makes macros available and renders them", () => {
    setKatexMacros({ "\\R": "\\mathbb{R}", "\\NP": "\\textrm{NP}" });
    expect(getKatexMacros()["\\R"]).toBe("\\mathbb{R}");

    const rendered = renderMathHTML("\\R \\quad \\NP", { displayMode: false, output: "html", strict: false });
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain("mathbb");
  });

  test("macro version (and thus cache key) changes when macros change", () => {
    setKatexMacros({});
    const empty = getKatexMacrosVersion();
    setKatexMacros({ "\\R": "\\mathbb{R}" });
    const withR = getKatexMacrosVersion();
    setKatexMacros({ "\\R": "\\mathbb{Q}" });
    const changed = getKatexMacrosVersion();

    expect(empty).toBe("0");
    expect(withR).not.toBe(empty);
    expect(changed).not.toBe(withR);
  });

  test("a redefined macro is not served from a stale cache", () => {
    setKatexMacros({ "\\X": "\\alpha" });
    const first = renderMathHTML("\\X", { displayMode: false, output: "html", strict: false });
    setKatexMacros({ "\\X": "\\beta" });
    const second = renderMathHTML("\\X", { displayMode: false, output: "html", strict: false });
    expect(first.html).not.toBe(second.html);
  });
});
