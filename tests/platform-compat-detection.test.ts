/**
 * Platform detection decides which modifier is "primary", so getting it wrong
 * silently swaps Cmd and Ctrl across the whole renderer.
 *
 * The trap is that `"darwin".includes("win")` is true. A Windows check that
 * runs before the Apple check claims every platform string that spells out the
 * Darwin kernel name — and `navigator.platform` does exactly that under the
 * Emacs xwidget host and in the test environment, where it reads
 * "X11; Darwin arm64". That made macOS detect as win32 and Cmd+click stop
 * opening Markdown links.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { detectNoemaPlatform, isMacPlatform, onlyControlDown, onlyMetaDown, primaryModifierDown } from "../src/platform-compat.ts";
import { markdownLinkPrimaryModifier } from "../src/cm6/markdown-link-events.ts";

const CMD = { metaKey: true, ctrlKey: false };
const CTRL = { metaKey: false, ctrlKey: true };
const BOTH = { metaKey: true, ctrlKey: true };
const NONE = { metaKey: false, ctrlKey: false };

describe("a platform string naming the Darwin kernel is Apple, not Windows", () => {
  test("the exact string this environment reports", () => {
    expect(detectNoemaPlatform("X11; Darwin arm64")).toBe("darwin");
  });

  test("other Darwin spellings", () => {
    expect(detectNoemaPlatform("darwin")).toBe("darwin");
    expect(detectNoemaPlatform("Darwin")).toBe("darwin");
    expect(detectNoemaPlatform("Darwin x86_64")).toBe("darwin");
  });

  test("the ordinary Apple strings still work", () => {
    expect(detectNoemaPlatform("MacIntel")).toBe("darwin");
    expect(detectNoemaPlatform("macOS")).toBe("darwin");
    expect(detectNoemaPlatform("iPhone")).toBe("darwin");
  });

  test("real Windows is still Windows", () => {
    expect(detectNoemaPlatform("Win32")).toBe("win32");
    expect(detectNoemaPlatform("Windows NT 10.0")).toBe("win32");
    expect(detectNoemaPlatform("win32")).toBe("win32");
  });

  test("Linux and X11 are still Linux", () => {
    expect(detectNoemaPlatform("Linux x86_64")).toBe("linux");
    expect(detectNoemaPlatform("X11")).toBe("linux");
    expect(detectNoemaPlatform("linux")).toBe("linux");
  });

  test("an unrecognised explicit hint falls back to the environment, not to unknown", () => {
    // The explicit argument is a hint, not an override: callers that cannot
    // name the platform pass "" and must still get the real one.
    expect(detectNoemaPlatform("Nintendo 64")).toBe(detectNoemaPlatform(""));
    expect(detectNoemaPlatform("")).toBe("darwin");
  });
});

describe("the primary modifier follows from that", () => {
  test("Cmd is primary on Apple, Ctrl is not", () => {
    expect(primaryModifierDown(CMD, "X11; Darwin arm64")).toBe(true);
    expect(primaryModifierDown(CTRL, "X11; Darwin arm64")).toBe(false);
    expect(primaryModifierDown(CMD, "MacIntel")).toBe(true);
  });

  test("Ctrl is primary on Windows and Linux", () => {
    expect(primaryModifierDown(CTRL, "Win32")).toBe(true);
    expect(primaryModifierDown(CMD, "Win32")).toBe(false);
    expect(primaryModifierDown(CTRL, "Linux x86_64")).toBe(true);
  });

  test("holding both is never the primary modifier", () => {
    expect(primaryModifierDown(BOTH, "MacIntel")).toBe(false);
    expect(primaryModifierDown(BOTH, "Win32")).toBe(false);
    expect(primaryModifierDown(NONE, "MacIntel")).toBe(false);
  });

  test("isMacPlatform agrees", () => {
    expect(isMacPlatform("X11; Darwin arm64")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
  });

  test("the raw modifier helpers stay platform-independent", () => {
    expect(onlyMetaDown(CMD)).toBe(true);
    expect(onlyMetaDown(BOTH)).toBe(false);
    expect(onlyControlDown(CTRL)).toBe(true);
    expect(onlyControlDown(BOTH)).toBe(false);
  });
});

describe("Cmd+click opens a Markdown link in this environment", () => {
  test("markdownLinkPrimaryModifier accepts Cmd", () => {
    expect(markdownLinkPrimaryModifier(CMD)).toBe(true);
  });

  test("and rejects a bare click or both modifiers", () => {
    expect(markdownLinkPrimaryModifier(NONE)).toBe(false);
    expect(markdownLinkPrimaryModifier(BOTH)).toBe(false);
  });
});
