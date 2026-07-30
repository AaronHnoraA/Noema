import { describe, it, expect } from "@voidzero-dev/vite-plus-test";
import { inlineTodoBodyHTML } from "../src/cm6/extensions/visual/widgets/inline-commands.ts";

describe("inlineTodoBodyHTML", () => {
  it("renders inline math inside a @@todo body", () => {
    const html = inlineTodoBodyHTML("solve \\(x^2\\) now");
    expect(html).toContain("katex");
    expect(html).toContain("solve");
    expect(html).toContain("now");
    // Inline context: no surrounding paragraph wrapper.
    expect(html.startsWith("<p>")).toBe(false);
  });

  it("renders plain text with no paragraph wrapper", () => {
    expect(inlineTodoBodyHTML("buy milk")).toBe("buy milk");
  });

  it("escapes HTML-significant characters", () => {
    expect(inlineTodoBodyHTML("a & b < c")).toContain("&amp;");
  });
});
