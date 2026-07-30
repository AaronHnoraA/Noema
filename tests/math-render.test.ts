import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  formatMathRenderError,
  MATH_RENDER_ERROR_MAX_LENGTH,
  renderMathHTML,
  renderMathLazy,
} from "../src/math-render.ts";
import { getKatexMacrosVersion } from "../src/katex-macros.ts";

describe("math render source handling", () => {
  test("synchronous render path loads KaTeX CSS", () => {
    document
      .querySelectorAll("link[data-aaronnote-katex-css]")
      .forEach((link) => link.remove());

    const rendered = renderMathHTML("\\langle v,w \\rangle", {
      displayMode: true,
      output: "html",
      strict: false,
    });

    expect(rendered.error).toBeUndefined();
    const css = document.querySelector<HTMLLinkElement>("link[data-aaronnote-katex-css]");
    expect(css).toBeTruthy();
    expect(css!.rel).toBe("stylesheet");

    css!.remove();
    renderMathHTML("\\langle v,w \\rangle", {
      displayMode: true,
      output: "html",
      strict: false,
    });
    expect(document.querySelector("link[data-aaronnote-katex-css]")).toBeTruthy();
  });

  test("renders from the exact TeX source without command-name repairs", () => {
    const el = document.createElement("span");
    const tex = "dathrm{GA} e_p athrm{GI}";
    renderMathLazy(tex, el, { displayMode: false, throwOnError: false }, () => {});
    expect(el.getAttribute("data-math-render-key")).toBe(`${getKatexMacrosVersion()}\ninline\nmathml\n${tex}`);
  });

  test("keeps output modes separate in the render cache", () => {
    const tex = String.raw`\begin{align}& x \\ =& y\end{align}`;
    const mathml = renderMathHTML(tex, {
      displayMode: true,
      output: "mathml",
      strict: false,
    });
    const html = renderMathHTML(tex, {
      displayMode: true,
      output: "htmlAndMathml",
      strict: false,
    });

    expect(mathml.error).toBeUndefined();
    expect(html.error).toBeUndefined();
    expect(mathml.html).not.toContain("katex-display");
    expect(html.html).toContain("katex-display");
  });

  test("uses KaTeX as the primary renderer for TeX commands", () => {
    const rendered = renderMathHTML("G[i] \\cong G[j].\\quad \\varphi(i)=j.", {
      displayMode: true,
      output: "html",
      strict: false,
    });

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain("katex");
    expect(rendered.html).toContain("≅");
    expect(rendered.html).toContain("φ");
    expect(rendered.html).not.toContain("ongG");
    expect(rendered.html).not.toContain("ăr");
  });

  test("returns bounded render errors", () => {
    const rendered = renderMathHTML(`\\notacommand{${"x".repeat(1000)}}`, {
      displayMode: false,
      output: "html",
      strict: false,
    });

    expect(rendered.html).toBe("");
    expect(rendered.error).toBeTruthy();
    expect(rendered.error!.length).toBeLessThanOrEqual(MATH_RENDER_ERROR_MAX_LENGTH);
    expect(rendered.error).toContain("KaTeX parse error");
  });

  test("formats long math render errors with a hard limit", () => {
    const error = formatMathRenderError(new Error("x".repeat(MATH_RENDER_ERROR_MAX_LENGTH + 100)));

    expect(error).toHaveLength(MATH_RENDER_ERROR_MAX_LENGTH);
    expect(error.endsWith("...")).toBe(true);
  });
});
