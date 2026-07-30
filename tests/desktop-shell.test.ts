import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  desktopDropDisposition,
  isMarkdownFilePath,
} from "../shared/desktop-shell.mjs";

describe("Noema desktop shell adapter", () => {
  test("recognizes Markdown documents case-insensitively", () => {
    expect(isMarkdownFilePath("/notes/one.md")).toBe(true);
    expect(isMarkdownFilePath("/notes/TWO.MARKDOWN")).toBe(true);
    expect(isMarkdownFilePath("/notes/image.png")).toBe(false);
  });

  test("opens Markdown drops in app windows by default", () => {
    expect(desktopDropDisposition(["/notes/one.md", "/notes/two.markdown"]))
      .toEqual({ type: "open", paths: ["/notes/one.md", "/notes/two.markdown"] });
  });

  test("inserts mixed drops and Option-dropped Markdown as attachments", () => {
    expect(desktopDropDisposition(["/notes/one.md", "/images/figure.png"]))
      .toEqual({ type: "insert", paths: ["/notes/one.md", "/images/figure.png"] });
    expect(desktopDropDisposition(["/notes/one.md"], true))
      .toEqual({ type: "insert", paths: ["/notes/one.md"] });
  });
});
