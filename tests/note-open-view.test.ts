import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("note open view", () => {
  test("ordinary opens ignore remembered Source mode while explicit navigation may restore it", () => {
    const source = readFileSync(join(process.cwd(), "aaronnote/main.ts"), "utf8");
    const applyStart = source.indexOf("function applyOpenedNote(");
    const applyEnd = source.indexOf("async function openFile(", applyStart);
    const applyOpenedNote = source.slice(applyStart, applyEnd);
    const restoreStart = source.indexOf("function restoreCursorPosition(");
    const restoreEnd = source.indexOf("async function restoreNavigationBack(", restoreStart);
    const restoreCursorPosition = source.slice(restoreStart, restoreEnd);

    expect(applyOpenedNote).toContain(": opened.mode;");
    expect(applyOpenedNote).not.toContain("remembered?.mode || opened.mode");
    expect(restoreCursorPosition).toContain("location.mode === \"source\"");
  });
});
