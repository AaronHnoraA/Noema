import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { createWorkspaceLayout } from "../src/workspace-layout.ts";
import { createWorkspaceLayoutView } from "../src/workspace-layout-view.ts";

const baseState = () => createWorkspaceLayout({
  type: "leaf" as const,
  id: "leaf-a",
  activeTabId: "tab-a",
  tabs: [
    { id: "tab-a", kind: "editor", title: "A", state: { file: "a.md" } },
    { id: "tab-b", kind: "editor", title: "B", state: { file: "b.md" } },
  ],
});

afterEach(() => document.body.replaceChildren());

describe("workspace layout DOM controller", () => {
  test("hydrates tabs lazily once, retains mounted panels, and supports tab keyboard navigation", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const mounted: string[] = [];
    const view = createWorkspaceLayoutView(root, {
      state: baseState(),
      mountTab: ({ tab, host }) => { mounted.push(tab.id); host.textContent = tab.state.file; },
    });
    expect(mounted).toEqual(["tab-a"]);
    const a = root.querySelector<HTMLElement>('[data-noema-workspace-activate="tab-a"]')!;
    a.focus();
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(mounted).toEqual(["tab-a", "tab-b"]);
    expect(root.querySelector<HTMLElement>('[data-noema-workspace-tab-panel="tab-a"]')?.hidden).toBe(true);
    expect(view.getState().root).toMatchObject({ activeTabId: "tab-b" });
    view.activate("leaf-a", "tab-a");
    expect(mounted).toEqual(["tab-a", "tab-b"]);
  });

  test("splits through the UI, persists state, and disposes a closed mount", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const storage = new Map<string, string>();
    const disposed = vi.fn();
    let id = 0;
    const view = createWorkspaceLayoutView(root, {
      state: baseState(),
      storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
      storageKey: "layout",
      idFactory: (kind) => `${kind}-${++id}`,
      cloneTab: (tab, tabId) => ({ ...tab, id: tabId, title: `${tab.title} split` }),
      mountTab: ({ host }) => { host.textContent = "mounted"; return disposed; },
    });
    root.querySelector<HTMLButtonElement>('[data-noema-workspace-split="lr"]')!.click();
    expect(root.querySelectorAll(".noema-workspace-leaf")).toHaveLength(2);
    expect(JSON.parse(storage.get("layout")!).root.type).toBe("split");
    const layoutRoot = view.getState().root;
    const splitTab = layoutRoot.type === "split" ? layoutRoot.children[1] : null;
    expect(splitTab?.type).toBe("leaf");
    expect(view.close(splitTab!.type === "leaf" ? splitTab!.activeTabId : "")).toBe(true);
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
