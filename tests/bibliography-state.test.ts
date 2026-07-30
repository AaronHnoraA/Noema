import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  alignBibliographyCitationRanges,
  bibliographyChangesRequireResolution,
  bibliographyResolutionState,
  mapBibliographyRangesThroughChanges,
  mapBibliographyRangesThroughTextChange,
  mapBibliographyWatchRangesThroughChanges,
} from "../aaronnote/bibliography-state.ts";

describe("bibliography editor state", () => {
  test("ordinary typing does not invalidate citation resolution", () => {
    const before = "Intro\n\nSee @@cite(iso) [Str87] {locator: p. 406}.";
    const after = "Longer intro\n\nSee @@cite(iso) [Str87] {locator: p. 406}.";
    const first = bibliographyResolutionState(before);
    const second = bibliographyResolutionState(after);

    expect(second.key).toBe(first.key);
    expect(second.commands[0]!.from).toBeGreaterThan(first.commands[0]!.from);
  });

  test("ordinary prose edits only map ranges and request no rescan", () => {
    const markdown = "Intro\n\nSee @@cite(iso) [Str87] {locator: p. 406}.";
    const state = bibliographyResolutionState(markdown);
    const model = { citations: state.commands.map(({ from, to }) => ({ from, to })) };
    const commands = state.commands.map((command) => ({ ...command }));
    const watchRanges = state.watchRanges.map((range) => ({ ...range }));
    const changes = [{
      from: 5,
      to: 5,
      insertedLength: 7,
      insertedText: " longer",
      deletedText: "",
    }];

    expect(bibliographyChangesRequireResolution(changes, watchRanges)).toBe(false);
    mapBibliographyRangesThroughChanges(model, commands, changes);
    mapBibliographyWatchRangesThroughChanges(watchRanges, changes);

    const expected = bibliographyResolutionState("Intro longer\n\nSee @@cite(iso) [Str87] {locator: p. 406}.");
    expect(model.citations).toEqual(expected.commands.map(({ from, to }) => ({ from, to })));
    expect(commands).toEqual(expected.commands);
    expect(watchRanges).toEqual(expected.watchRanges);
  });

  test("citation, metadata, and Markdown-structure edits request a rescan", () => {
    const markdown = "#+begin meta\nbib: ./refs\n#+end meta\n\nText @@cite(iso) [A].";
    const state = bibliographyResolutionState(markdown);
    const citation = state.commands[0]!;
    const metadata = state.watchRanges[0]!;

    expect(bibliographyChangesRequireResolution([{
      from: citation.from + 2,
      to: citation.from + 2,
      insertedLength: 1,
      insertedText: "x",
      deletedText: "",
    }], state.watchRanges)).toBe(true);
    expect(bibliographyChangesRequireResolution([{
      from: metadata.from + 2,
      to: metadata.from + 2,
      insertedLength: 1,
      insertedText: "x",
      deletedText: "",
    }], state.watchRanges)).toBe(true);
    expect(bibliographyChangesRequireResolution([{
      from: 40,
      to: 40,
      insertedLength: 1,
      insertedText: "@",
      deletedText: "",
    }], state.watchRanges)).toBe(true);
  });

  test("citation or bibliography metadata edits invalidate resolution", () => {
    const base = "#+begin meta\nbib: ./refs\n#+end meta\n\n@@cite(iso) [A]";
    expect(bibliographyResolutionState(base.replace("[A]", "[B]")).key)
      .not.toBe(bibliographyResolutionState(base).key);
    expect(bibliographyResolutionState(base.replace("./refs", "./other")).key)
      .not.toBe(bibliographyResolutionState(base).key);
  });

  test("unrelated metadata does not invalidate bibliography resolution", () => {
    const before = "---\ntitle: First\nbib: ./refs\n---\n\n@@cite(iso) [A]";
    const after = before.replace("First", "Second");
    expect(bibliographyResolutionState(after).key).toBe(bibliographyResolutionState(before).key);
  });

  test("uses the same protected citation contexts as the server", () => {
    const visible = bibliographyResolutionState("Text @@cite(ns) [A]");
    const code = bibliographyResolutionState("Text `@@cite(ns) [A]`");
    const destination = bibliographyResolutionState("[label](url/@@cite(ns) [A])");
    const abstract = bibliographyResolutionState([
      "#+begin meta",
      "title: @@cite(ns) [Hidden]",
      "#+begin summary",
      "Visible @@cite(ns) [Abstract]",
      "#+end summary",
      "#+end meta",
    ].join("\n"));

    expect(visible.commands).toHaveLength(1);
    expect(code.commands).toHaveLength(0);
    expect(code.hasCitationSyntax).toBe(false);
    expect(destination.commands).toHaveLength(0);
    expect(destination.hasCitationSyntax).toBe(false);
    expect(abstract.commands).toHaveLength(1);
    expect(abstract.commands[0]?.source).toBe("@@cite(ns) [Abstract]");
    expect(code.key).not.toBe(visible.key);
  });

  test("keeps a resolved label range stable while text is inserted before it", () => {
    const before = "See @@cite(iso) [Str87].";
    const after = "Please see @@cite(iso) [Str87].";
    const scanned = bibliographyResolutionState(before).commands;
    const model = { citations: [{ from: scanned[0]!.from, to: scanned[0]!.to }] };

    expect(mapBibliographyRangesThroughTextChange(model, scanned, before, after)).toBe(true);
    const next = bibliographyResolutionState(after).commands;
    expect(model.citations[0]).toEqual({ from: next[0]!.from, to: next[0]!.to });
    expect(scanned[0]).toMatchObject({ from: next[0]!.from, to: next[0]!.to });
  });

  test("realigns multiple cached ranges after a coarse multi-edit mapping", () => {
    const before = "a @@cite(r) [A] b @@cite(r) [B]";
    const after = "aa @@cite(r) [A] bb @@cite(r) [B]";
    const previous = bibliographyResolutionState(before).commands;
    const model = { citations: previous.map(({ from, to }) => ({ from, to })) };
    const mapped = previous.map((command) => ({ ...command }));
    mapBibliographyRangesThroughTextChange(model, mapped, before, after);
    const next = bibliographyResolutionState(after).commands;

    expect(alignBibliographyCitationRanges(model, mapped, next)).toBe(true);
    expect(model.citations).toEqual(next.map(({ from, to }) => ({ from, to })));
  });

  test("maps simultaneous editor changes without reading or diffing the document", () => {
    const before = "x @@cite(r) [A] y @@cite(r) [B]";
    const previous = bibliographyResolutionState(before).commands;
    const secondFrom = previous[1]!.from;
    const after = `AA${before.slice(0, secondFrom)}BB${before.slice(secondFrom)}`;
    const model = { citations: previous.map(({ from, to }) => ({ from, to })) };
    const mapped = previous.map((command) => ({ ...command }));

    mapBibliographyRangesThroughChanges(model, mapped, [
      { from: 0, to: 0, insertedLength: 2 },
      { from: secondFrom, to: secondFrom, insertedLength: 2 },
    ]);

    const expected = bibliographyResolutionState(after).commands;
    expect(model.citations).toEqual(expected.map(({ from, to }) => ({ from, to })));
    expect(mapped).toEqual(expected);
  });
});
