import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Shared/server ESM modules are outside the TypeScript app graph.
import { parseCommandArgs, scanInlineCommands } from "../shared/command-syntax.mjs";
// @ts-ignore Shared/server ESM modules are outside the TypeScript app graph.
import { citeLatex } from "../server/lib/latex-export.mjs";

describe("citation core", () => {
  test("parses compact and uppercase cite syntax with escaping parity", () => {
    expect(scanInlineCommands("@@CITE(iso)[Key]", "cite")).toMatchObject([{
      name: "cite",
      switchValue: "iso",
      context: "Key",
    }]);
    expect(scanInlineCommands(String.raw`\@@cite(iso)[Key]`, "cite")).toEqual([]);
    expect(scanInlineCommands(String.raw`\\@@cite(iso)[Key]`, "cite")).toHaveLength(1);
    // Other bracket commands retain their established whitespace contract.
    expect(scanInlineCommands("@@todo[not a command]", "todo")).toEqual([]);
  });

  test("renders an atomic citation group from shared args without dropping modifiers", () => {
    const command = scanInlineCommands(
      "@@CITE(iso)[A; B] {prefix=see; locator: p. 2; suffix: !}",
      "cite",
    )[0]!;
    const citationKeyMap = {
      ["iso\0A"]: "iso:A",
      ["iso\0B"]: "iso:B",
    };

    expect(citeLatex(command, { citationKeyMap }))
      .toBe("see \\cite[p. 2]{iso:A,iso:B}!");
    expect(citeLatex(command, { citationKeyMap: { ["iso\0A"]: "iso:A" } }))
      .toBe("");
  });

  test("de-duplicates repeated keys and rejects empty group items", () => {
    const duplicate = scanInlineCommands("@@cite(iso) [A; A]", "cite")[0]!;
    const empty = scanInlineCommands("@@cite(iso) [A; ; B]", "cite")[0]!;
    const map = new Map([
      ["iso\0A", "iso:A"],
      ["iso\0B", "iso:B"],
    ]);

    expect(citeLatex(duplicate, { citationKeyMap: map })).toBe("\\cite{iso:A}");
    expect(citeLatex(empty, { citationKeyMap: map })).toBe("");
  });

  test("joins punctuation-like prefix and suffix without invented spaces", () => {
    const command = scanInlineCommands(
      "@@cite(iso) [A] {prefix: (; suffix: )}",
      "cite",
    )[0]!;

    expect(citeLatex(command, { citationKeyMap: { ["iso\0A"]: "iso:A" } }))
      .toBe("(\\cite{iso:A})");
  });

  test("preserves commas inside citation locators and affixes", () => {
    const command = scanInlineCommands(
      "@@cite(iso) [A] {prefix: see, e.g.; locator: pp. 2, 4; suffix: for details}",
      "cite",
    )[0]!;

    expect(citeLatex(command, { citationKeyMap: { ["iso\0A"]: "iso:A" } }))
      .toBe("see, e.g. \\cite[pp. 2, 4]{iso:A} for details");
  });

  test("parses quoted delimiters, escaped quotes, and nested argument braces", () => {
    expect(parseCommandArgs(String.raw`{prefix: "see; e.g., discussion"; locator: "pp. 2, 4"; suffix: "after \"quote\""}`))
      .toEqual({
        prefix: "see; e.g., discussion",
        locator: "pp. 2, 4",
        suffix: 'after "quote"',
      });
    const command = scanInlineCommands("@@cite(iso)[A] {prefix: {see also}; locator: p. 2}", "cite")[0]!;
    expect(command.argsRaw).toBe("{prefix: {see also}; locator: p. 2}");
    expect(command.args).toMatchObject({ prefix: "{see also}", locator: "p. 2" });
  });

  test("reports an unclosed citation argument block", () => {
    const command = scanInlineCommands("@@cite(iso)[A] {locator: p. 2", "cite")[0]!;
    expect(command.argsError).toBe("unclosed command arguments");
    expect(command.fullTo).toBe("@@cite(iso)[A]".length);
  });
});
