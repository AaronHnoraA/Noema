import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { removeMath, replaceMath } from "@jupyterlab/rendermime/lib/latex.js";
import { KatexTypesetter } from "../src/jupyter-output-math.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

describe("Noema Work Output math", () => {
  test("typesets saved agent Markdown after Jupyter restores its math", () => {
    const source = [
      String.raw`If $G \not\cong H$, count $|\operatorname{Aut}(G)|$.`,
      "",
      "$$",
      String.raw`|\operatorname{Aut}(G)|=\prod_i |\Gamma_{i-1}:\Gamma_i|`,
      "$$",
      "",
      "Leave `$x$` as code and $5 and $6 as prices.",
      "",
      "```text",
      "$y$",
      "```",
    ].join("\n");
    const parts = removeMath(source);
    const host = document.createElement("div");
    host.innerHTML = replaceMath(renderMarkdownHTML(parts.text), parts.math);
    new KatexTypesetter().typeset(host);
    expect(host.querySelectorAll(".cm-ceil-output-latex .katex")).toHaveLength(3);
    expect(host.querySelectorAll(".cm-ceil-output-latex[data-display=true]")).toHaveLength(1);
    expect(host.querySelector("code")?.textContent).toBe("$x$");
    expect(host.querySelector("pre code")?.textContent).toContain("$y$");
    expect(host.textContent).toContain("$5 and $6");
  });
});
