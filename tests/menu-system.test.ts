import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  computeMenuPosition,
  createMenuController,
  normalizeMenuItems,
  updateMenuItemGroupClasses,
} from "../src/menu-system.ts";

describe("menu model and positioning", () => {
  test("normalizes ignored/indexed items and empty separator groups", () => {
    expect(normalizeMenuItems([
      { label: "leading", separator: true },
      { id: "a", label: "A" },
      { label: "middle", separator: true },
      { label: "duplicate", separator: true },
      { id: "c", label: "C" },
      { id: "ignored", label: "ignored", ignore: true },
      { id: "b", label: "B", index: 0 },
      { label: "trailing", separator: true },
    ]).map((item) => item.id || item.label)).toEqual(["b", "leading", "a", "middle", "c"]);
  });

  test("flips above, clamps to the viewport, and respects a 54px titlebar", () => {
    expect(computeMenuPosition({ width: 180, height: 140 }, { left: 490, top: 380 }, {
      width: 500, height: 400, topBoundary: 54, margin: 6,
    })).toEqual({ left: 314, top: 240 });
    expect(computeMenuPosition({ width: 180, height: 360 }, { left: -20, top: 10 }, {
      width: 500, height: 400, topBoundary: 54, margin: 6,
    })).toEqual({ left: 6, top: 54 });
  });
});

describe("menu controller", () => {
  test("renders accessible actions, auto-groups them, and invokes a command", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    Object.defineProperty(root, "getBoundingClientRect", { value: () => ({ width: 200, height: 120, top: 0, left: 0, right: 200, bottom: 120 }) });
    const run = vi.fn();
    const menu = createMenuController(root);
    menu.open([
      { id: "first", label: "First", accelerator: "⌘F", run },
      { label: "group", separator: true },
      { id: "checked", label: "Checked", checked: true, run },
      { id: "disabled", label: "Disabled", disabled: true, run },
    ], { left: 10, top: 10 });

    const first = root.querySelector<HTMLButtonElement>("[data-menu-id='first']")!;
    expect(first.getAttribute("role")).toBe("menuitem");
    expect(first.querySelector("small")?.textContent).toBe("⌘F");
    expect(root.querySelector("[data-menu-id='checked']")?.getAttribute("aria-checked")).toBe("true");
    updateMenuItemGroupClasses(root);
    expect(first.classList.contains("noema-menu-group-first")).toBe(true);
    first.click();
    expect(run).toHaveBeenCalledOnce();
    expect(menu.visible).toBe(false);
    root.remove();
  });

  test("navigates rows and lazily resolves a submenu without stale replacement", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    Object.defineProperty(root, "getBoundingClientRect", { value: () => ({ width: 200, height: 120, top: 0, left: 0, right: 200, bottom: 120 }) });
    const menu = createMenuController(root);
    menu.open([
      { id: "a", label: "A" },
      { id: "sub", label: "Sub", loadSubmenu: async () => [{ id: "child", label: "Child" }] },
      { id: "disabled", label: "Disabled", disabled: true },
    ], { left: 10, top: 10 });
    menu.focusFirst();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const sub = root.querySelector<HTMLButtonElement>("[data-menu-id='sub']")!;
    expect(document.activeElement).toBe(sub);
    sub.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    const child = document.querySelector<HTMLElement>(".noema-menu-submenu [data-menu-id='child']");
    expect(child).not.toBeNull();
    expect(document.activeElement).toBe(child);
    menu.close();
    expect(document.querySelector(".noema-menu-submenu")).toBeNull();
    root.remove();
  });
});
