import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  clampCommandIndex,
  commandMatches,
  commandSearchText,
  filterCommands,
  type AaronnoteCommand,
} from "../aaronnote/command-palette.ts";

function command(partial: Partial<AaronnoteCommand> & Pick<AaronnoteCommand, "id" | "title">): AaronnoteCommand {
  return {
    group: "Editor",
    run: () => {},
    ...partial,
  };
}

describe("command palette core", () => {
  test("search text includes id, title, group, and keywords", () => {
    const text = commandSearchText(command({
      id: "toggle-source",
      title: "Switch to source",
      group: "Editor",
      keywords: ["markdown", "raw"],
    }));

    expect(text).toContain("toggle-source");
    expect(text).toContain("switch to source");
    expect(text).toContain("editor");
    expect(text).toContain("markdown");
  });

  test("matches multi-token queries across command fields", () => {
    const item = command({
      id: "plugin:copilot:trigger",
      title: "Trigger completion",
      group: "Copilot",
      keywords: ["ai"],
    });

    expect(commandMatches(item, "copilot trigger")).toBe(true);
    expect(commandMatches(item, "completion ai")).toBe(true);
    expect(commandMatches(item, "agenda")).toBe(false);
  });

  test("filters disabled commands and respects limit", () => {
    const commands = [
      command({ id: "save", title: "Save note" }),
      command({ id: "hidden", title: "Hidden", enabled: () => false }),
      command({ id: "source", title: "Switch to source" }),
    ];

    expect(filterCommands(commands, "", 2).map((item) => item.id)).toEqual(["save", "source"]);
    expect(filterCommands(commands, "hidden").map((item) => item.id)).toEqual([]);
  });

  test("clamps active index for empty and filtered command lists", () => {
    expect(clampCommandIndex(3, 0)).toBe(0);
    expect(clampCommandIndex(-1, 4)).toBe(0);
    expect(clampCommandIndex(9, 4)).toBe(3);
    expect(clampCommandIndex(2, 4)).toBe(2);
  });
});
