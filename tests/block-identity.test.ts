import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  isBlockReferenceId,
  orgEnvSupportsBlockIdentity,
  parseBlockAnchor,
  parseBlockProperties,
  parseOrgEnvIdentityTitle,
  shortBlockId,
} from "../shared/block-identity.mjs";

// The one parser of block anchors and references (syntax.md "Block identity
// and properties").  These pin what it accepts today.
const UUID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

describe("block anchors", () => {
  test("an anchor carries an id and key=value properties", () => {
    expect(parseBlockAnchor(`{#${UUID} status=open owner="Ada Lovelace"}`)).toEqual({
      blockId: UUID,
      attrs: { status: "open", owner: "Ada Lovelace" },
    });
  });

  test("an anchor id may be a label, not only a UUID", () => {
    expect(parseBlockAnchor("{#fig:setup}").blockId).toBe("fig:setup");
    expect(parseBlockAnchor("{#ab}").blockId).toBe("");
    expect(parseBlockAnchor("{# spaced}").blockId).toBe("");
  });

  test("properties drop id, lower-case keys and unquote values", () => {
    expect(parseBlockProperties(`Id=x Kind='a b' note="say \\"hi\\"" bare=1`)).toEqual({
      kind: "a b",
      note: 'say "hi"',
      bare: "1",
    });
  });
});

describe("block references", () => {
  test("only UUIDv7 and the legacy SiYuan form are referenceable", () => {
    expect(isBlockReferenceId(UUID)).toBe(true);
    expect(isBlockReferenceId("20240101120000-abcdefg")).toBe(true);
    expect(isBlockReferenceId("fig:setup")).toBe(false);
    // Version nibble must be 7.
    expect(isBlockReferenceId("0192f3a4-5b6c-4d8e-9f01-23456789abcd")).toBe(false);
  });

  test("short ids keep the tail", () => {
    expect(shortBlockId(UUID)).toBe("…89abcd");
    expect(shortBlockId("abc", 6)).toBe("abc");
  });
});

describe("org-environment titles", () => {
  test("a trailing anchor is split from the title", () => {
    expect(parseOrgEnvIdentityTitle("theorem", `Main result {#${UUID} kind=lemma}`)).toEqual({
      title: "Main result",
      blockId: UUID,
      attrs: { kind: "lemma" },
    });
  });

  test("non-semantic environments keep their title whole", () => {
    expect(orgEnvSupportsBlockIdentity("tikz")).toBe(false);
    expect(orgEnvSupportsBlockIdentity("av")).toBe(true);
    expect(parseOrgEnvIdentityTitle("tikz", `fig {#${UUID}}`)).toEqual({
      title: `fig {#${UUID}}`, blockId: "", attrs: {},
    });
  });

  test("an anchor alone is an empty title", () => {
    expect(parseOrgEnvIdentityTitle("note", `{#${UUID}}`).title).toBe("");
  });
});
