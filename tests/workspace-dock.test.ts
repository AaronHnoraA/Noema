// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  createWorkspaceDockController,
  parseWorkspaceDockState,
  serializeWorkspaceDockState,
} from "../src/workspace-dock.ts";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.body.className = "";
  document.body.removeAttribute("style");
});

describe("workspace dock state", () => {
  test("bounds restored JSON and rejects malformed panel identities", () => {
    expect(parseWorkspaceDockState("not json")).toEqual({ version: 1, panels: [] });
    expect(parseWorkspaceDockState(JSON.stringify({
      version: 1,
      panels: [
        { id: "knowledge", position: "right", pinned: false, size: 99999, order: -3 },
        { id: "knowledge", position: "left", pinned: true, size: 200, order: 2 },
        { id: "bad id", position: "bottom", size: 200 },
        { id: "agenda", position: "middle", size: 200 },
      ],
    }))).toEqual({
      version: 1,
      panels: [{ id: "knowledge", position: "right", pinned: false, size: 4096, order: 0 }],
    });
  });

  test("round-trips only the persistent panel model", () => {
    const state = {
      version: 1 as const,
      panels: [{ id: "agenda", position: "bottom" as const, pinned: true, size: 420, order: 1 }],
    };
    expect(parseWorkspaceDockState(serializeWorkspaceDockState(state))).toEqual(state);
  });
});

describe("workspace dock controller", () => {
  test("moves, reorders, pins and resizes registered panels with persisted state", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    };
    const knowledge = document.createElement("aside");
    knowledge.innerHTML = "<header></header>";
    document.body.appendChild(knowledge);
    const controller = createWorkspaceDockController({ body: document.body, storage });
    controller.register({
      id: "knowledge",
      label: "Knowledge",
      element: () => knowledge,
      open() {},
      close() {},
      defaultPosition: "right",
      defaultSize: 360,
      minSize: 240,
      maxSize: 600,
    });
    controller.register({
      id: "agenda",
      label: "Agenda",
      element: () => null,
      open() {},
      close() {},
      defaultPosition: "bottom",
      defaultSize: 420,
    });

    expect(document.querySelectorAll(".noema-workspace-dock-rail")).toHaveLength(3);
    expect(knowledge.dataset.noemaDockPosition).toBe("right");
    expect(controller.resize("knowledge", 900)).toBe(true);
    expect(controller.setPinned("knowledge", false)).toBe(true);
    expect(controller.move("knowledge", "left")).toBe(true);
    expect(controller.state().panels.find((panel) => panel.id === "knowledge")).toMatchObject({
      position: "left",
      pinned: false,
      size: 600,
    });
    expect(parseWorkspaceDockState(saved.get("noema.workspace.docks.v1"))
      .panels.find((panel) => panel.id === "knowledge")).toMatchObject({ position: "left", pinned: false });

    controller.destroy();
    expect(document.querySelectorAll(".noema-workspace-dock-rail")).toHaveLength(0);
  });

  test("keeps one visible panel per rail and auto-closes an unpinned hover panel", async () => {
    vi.useFakeTimers();
    const first = document.createElement("aside");
    first.innerHTML = "<header></header>";
    const second = document.createElement("aside");
    second.innerHTML = "<header></header>";
    document.body.append(first, second);
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const controller = createWorkspaceDockController({ body: document.body, floatingCloseDelayMs: 20 });
    controller.register({
      id: "first",
      label: "First",
      element: () => first,
      open() {},
      close: closeFirst,
      defaultPosition: "right",
      defaultSize: 320,
    });
    controller.register({
      id: "second",
      label: "Second",
      element: () => second,
      open() {},
      close: closeSecond,
      defaultPosition: "right",
      defaultSize: 340,
    });

    await controller.show("first");
    expect(document.body.style.getPropertyValue("--noema-dock-right-size")).toBe("320px");
    await controller.show("second");
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(document.body.style.getPropertyValue("--noema-dock-right-size")).toBe("340px");

    controller.setPinned("second", false);
    expect(document.body.style.getPropertyValue("--noema-dock-right-size")).toBe("0px");
    vi.advanceTimersByTime(21);
    await Promise.resolve();
    expect(closeSecond).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-noema-dock-button="second"]')?.getAttribute("aria-expanded")).toBe("false");
  });
});
