import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { normalizeTikzSource, stripTikzComments } from "../src/tikz-render.ts";

describe("TikZ render helpers", () => {
  test("wraps bare TikZ commands in a tikzpicture", () => {
    expect(normalizeTikzSource("\\draw (0,0) -- (1,1);"))
      .toBe("\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}");
  });

  test("keeps explicit tikzpicture and document sources unchanged", () => {
    const picture = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}";
    const document = "\\documentclass{standalone}\n\\begin{document}\nbody\n\\end{document}";

    expect(normalizeTikzSource(picture)).toBe(picture);
    expect(normalizeTikzSource(document)).toBe(document);
  });

  test("strips TeX comments before handing source to TikZJax", () => {
    expect(stripTikzComments("  % 坐标点定义\n\\draw (0,0) -- (1,1); % line"))
      .toBe("\n\\draw (0,0) -- (1,1);");
    expect(stripTikzComments("\\node {100\\%};")).toBe("\\node {100\\%};");
  });
});
