import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  closestByAttribute,
  closestByClassName,
  closestByTag,
  outermostByAttribute,
  outermostByClassName,
} from "../src/dom-ancestry.ts";
import { formatHotKey, matchHotKey, parseHotKey } from "../src/hotkey.ts";
import { detectNoemaPlatform, primaryModifierDown } from "../src/platform-compat.ts";
import { createTransientSurfaceRegistry } from "../src/transient-surfaces.ts";

describe("neutral DOM ancestry helpers", () => {
  test("accept text nodes, respects boundaries, and returns inner or outer matches", () => {
    const root = document.createElement("section");
    root.className = "match";
    root.dataset.kind = "one two";
    root.innerHTML = '<div class="match" data-kind="two"><button><span>text</span></button></div>';
    document.body.append(root);
    const text = root.querySelector("span")!.firstChild!;
    expect(closestByClassName(text, "match", root)).toBe(root.querySelector("div"));
    expect(outermostByClassName(text, "match")).toBe(root);
    expect(closestByTag(text, "button")).toBe(root.querySelector("button"));
    expect(closestByAttribute(text, "data-kind", "two")).toBe(root.querySelector("div"));
    expect(outermostByAttribute(text, "data-kind", "two")).toBe(root);
    root.remove();
  });
});

describe("neutral hotkey and platform seam", () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: "k", code: "KeyK", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides,
  }) as KeyboardEvent;

  test("parses symbol and Electron-style chords and matches primary per platform", () => {
    expect(parseHotKey("⌥⇧⌘K")).toMatchObject({ key: "k", alt: true, shift: true, meta: true });
    expect(matchHotKey("CmdOrCtrl+Shift+K", event({ metaKey: true, shiftKey: true }), { platform: "darwin" })).toBe(true);
    expect(matchHotKey("Primary+Shift+K", event({ ctrlKey: true, shiftKey: true }), { platform: "linux" })).toBe(true);
    expect(matchHotKey("Primary+Shift+K", event({ ctrlKey: true, shiftKey: true, altKey: true }), { platform: "linux" })).toBe(false);
  });

  test("renders platform tips and exposes primary-modifier policy", () => {
    expect(formatHotKey("Primary+Shift+K", "darwin")).toBe("⇧⌘K");
    expect(formatHotKey("Primary+Shift+K", "win32")).toBe("Ctrl+Shift+K");
    expect(detectNoemaPlatform("MacIntel")).toBe("darwin");
    expect(primaryModifierDown(event({ metaKey: true }), "darwin")).toBe(true);
    expect(primaryModifierDown(event({ ctrlKey: true }), "linux")).toBe(true);
  });
});

describe("transient surface registry", () => {
  test("closes visible surfaces by name or topmost priority without touching hidden entries", () => {
    const registry = createTransientSurfaceRegistry();
    const state = { hint: true, menu: true, hidden: false };
    const calls: string[] = [];
    registry.register({ id: "hint", priority: 10, visible: () => state.hint, close: (reason) => { state.hint = false; calls.push(`hint:${reason}`); } });
    registry.register({ id: "menu", priority: 20, visible: () => state.menu, close: (reason) => { state.menu = false; calls.push(`menu:${reason}`); } });
    registry.register({ id: "hidden", priority: 30, visible: () => state.hidden, close: () => calls.push("hidden") });

    expect(registry.visible()).toEqual(["menu", "hint"]);
    expect(registry.closeTop("escape")).toBe("menu");
    expect(registry.close(["hidden", "hint"], "document-change")).toEqual(["hint"]);
    expect(calls).toEqual(["menu:escape", "hint:document-change"]);
  });
});
