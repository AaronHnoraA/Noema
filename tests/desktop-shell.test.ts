import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  desktopOpenDecision,
  desktopDropDisposition,
  desktopWindowRisk,
  isMarkdownFilePath,
  sanitizeDesktopSession,
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

  test("reuses clean Wiki windows and focuses already-open documents", () => {
    const windows = [{ id: 1, kind: "wiki", dirty: false }, { id: 2, kind: "note", file: "/n/a.md" }];
    expect(desktopOpenDecision({ source: "dialog", file: "/n/b.md", windows })).toEqual({ action: "replace", windowId: 1 });
    expect(desktopOpenDecision({ source: "os", file: "/n/a.md", windows })).toEqual({ action: "focus", windowId: 2 });
    expect(desktopOpenDecision({ source: "graph", file: "/n/c.md", windows })).toEqual({ action: "replace" });
  });

  test("explicit new and split requests never reuse a document window", () => {
    expect(desktopOpenDecision({ source: "wiki", explicit: "new" })).toEqual({ action: "new" });
    expect(desktopOpenDecision({ source: "wiki", explicit: "split-right" })).toEqual({ action: "split-right" });
    expect(desktopOpenDecision({ source: "drop" })).toEqual({ action: "new" });
  });

  test("tracks risky close state and sanitizes restorable windows", () => {
    expect(desktopWindowRisk({ dirty: true })).toBe(true);
    expect(desktopWindowRisk({ busy: false })).toBe(false);
    expect(sanitizeDesktopSession({ windows: [
      { kind: "config", route: "/config" },
      { kind: "graph", route: "/wiki?view=graph", bounds: { x: 1, y: 2, width: 100, height: 100 } },
    ] })).toEqual({ version: 1, windows: [{
      kind: "graph", file: "", route: "/wiki?view=graph",
      bounds: { x: 1, y: 2, width: 720, height: 560 }, maximized: false, fullScreen: false,
    }] });
  });
});
