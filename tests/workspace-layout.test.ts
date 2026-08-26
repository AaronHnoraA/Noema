import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceLayout,
  findWorkspaceNode,
  moveWorkspaceTab,
  parseWorkspaceLayout,
  persistableWorkspaceLayout,
  resizeWorkspaceSplit,
  splitWorkspaceLeaf,
  workspaceLeaves,
  workspaceTabs,
  type WorkspaceLeaf,
  type WorkspaceTab,
} from "../src/workspace-layout.ts";

type TabState = { file: string };
const tab = (id: string, sensitive = false): WorkspaceTab<TabState> => ({ id, kind: "editor", title: id, state: { file: `${id}.md` }, sensitive });
const leaf = (id: string, tabs: WorkspaceTab<TabState>[]): WorkspaceLeaf<TabState> => ({ type: "leaf", id, tabs, activeTabId: tabs[0]!.id });

describe("recursive workspace layout model", () => {
  test("splits beside a leaf and reuses a matching parent direction", () => {
    let state = createWorkspaceLayout(leaf("a", [tab("one")]));
    state = splitWorkspaceLeaf(state, "a", leaf("b", [tab("two")]), "lr", { leafId: "b", splitId: "s1" });
    state = splitWorkspaceLeaf(state, "b", leaf("c", [tab("three")]), "lr", { leafId: "c", splitId: "unused" });
    expect(state.root).toMatchObject({ type: "split", direction: "lr" });
    expect(workspaceLeaves(state.root).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect((state.root as { sizes: number[] }).sizes.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  test("nests an opposite split and collapses empty branches after closing", () => {
    let state = createWorkspaceLayout(leaf("a", [tab("one")]));
    state = splitWorkspaceLeaf(state, "a", leaf("b", [tab("two")]), "lr", { leafId: "b", splitId: "s1" });
    state = splitWorkspaceLeaf(state, "b", leaf("c", [tab("three")]), "tb", { leafId: "c", splitId: "s2" });
    expect(findWorkspaceNode(state.root, "s2")).toMatchObject({ type: "split", direction: "tb" });
    state = closeWorkspaceTab(state, "two");
    expect(findWorkspaceNode(state.root, "s2")).toBeNull();
    expect(workspaceLeaves(state.root).map((item) => item.id)).toEqual(["a", "c"]);
  });

  test("moves and reorders tabs while preserving one active tab per surviving leaf", () => {
    let state = createWorkspaceLayout(leaf("a", [tab("one"), tab("two")]));
    state = splitWorkspaceLeaf(state, "a", leaf("b", [tab("three")]), "lr", { leafId: "b", splitId: "s1" });
    state = moveWorkspaceTab(state, "two", "b", { leafId: "unused", splitId: "unused", index: 0 });
    expect((findWorkspaceNode(state.root, "b") as WorkspaceLeaf<TabState>).tabs.map((item) => item.id)).toEqual(["two", "three"]);
    state = activateWorkspaceTab(state, "b", "three");
    expect((findWorkspaceNode(state.root, "b") as WorkspaceLeaf<TabState>).activeTabId).toBe("three");
  });

  test("splits by moving a tab and clamps divider resize to minimum panes", () => {
    let state = createWorkspaceLayout(leaf("a", [tab("one"), tab("two")]));
    state = moveWorkspaceTab(state, "two", "a", { leafId: "b", splitId: "s1", direction: "tb" });
    expect(workspaceLeaves(state.root).map((item) => item.tabs[0]!.id)).toEqual(["one", "two"]);
    state = resizeWorkspaceSplit(state, "s1", 0, 0.9, 0.15);
    expect((state.root as { sizes: number[] }).sizes[0]).toBeCloseTo(0.85);
    expect((state.root as { sizes: number[] }).sizes[1]).toBeCloseTo(0.15);
  });

  test("filters sensitive tabs and rejects corrupt or duplicate persisted state", () => {
    const fallback = createWorkspaceLayout(leaf("a", [tab("one")]));
    const state = createWorkspaceLayout(leaf("source", [tab("safe"), tab("secret", true)]));
    expect(workspaceTabs(persistableWorkspaceLayout(state).root).map((item) => item.id)).toEqual(["safe"]);
    expect(parseWorkspaceLayout('{"version":1,"root":{"type":"leaf"}}', fallback)).toBe(fallback);
    const duplicate = JSON.stringify({
      version: 1,
      activeLeafId: "a",
      root: { type: "split", id: "s", direction: "lr", sizes: [1, 1], children: [
        { type: "leaf", id: "a", activeTabId: "x", tabs: [{ id: "x", kind: "editor", title: "X", state: {} }] },
        { type: "leaf", id: "b", activeTabId: "x", tabs: [{ id: "x", kind: "editor", title: "X", state: {} }] },
      ] },
    });
    expect(parseWorkspaceLayout(duplicate, fallback)).toBe(fallback);
  });
});
