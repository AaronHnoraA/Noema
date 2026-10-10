import { describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { managedFormulaStyle, wrapManagedFormulaStyle } from "../aaronnote/formula-style.ts";

const R = String.raw;

describe("managed formula style", () => {
  it("reads the shell it writes", () => {
    const style = { color: "red", background: "yellow", variant: "mathbf", size: "large" };
    const wrapped = wrapManagedFormulaStyle("a+b", style);
    expect(wrapped).toBe(R`\textcolor{red}{\colorbox{yellow}{{\large \mathbf{a+b}}}}`);
    expect(managedFormulaStyle(wrapped)).toEqual({ body: "a+b", ...style });
    expect(wrapManagedFormulaStyle("a+b", { color: "", background: "", variant: "", size: "" })).toBe("a+b");
  });

  it("leaves a formula that only looks wrapped alone", () => {
    // Starts and ends with a brace, but they belong to different groups.
    const source = R`{\large a} + {b}`;
    expect(managedFormulaStyle(source)).toEqual({
      body: source, color: "", background: "", variant: "", size: "",
    });
    expect(managedFormulaStyle(R`\mathbf{a} + \mathbf{b}`).body).toBe(R`\mathbf{a} + \mathbf{b}`);
    expect(managedFormulaStyle(R`\textcolor{red}{a} + b`).color).toBe("");
  });

  it("changes one property without disturbing the body", () => {
    const current = managedFormulaStyle(R`\textcolor{red}{\frac{a}{b}}`);
    expect(wrapManagedFormulaStyle(current.body, { ...current, color: "blue" }))
      .toBe(R`\textcolor{blue}{\frac{a}{b}}`);
    expect(managedFormulaStyle(R`{\normalsize x}`)).toMatchObject({ body: "x", size: "" });
    expect(managedFormulaStyle(R`{\large \{x\}}`)).toMatchObject({ body: R`\{x\}`, size: "large" });
  });
});
