import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { createTreeView, type NoemaTreeNode } from "../src/tree-view.ts";

type Value = { path: string };
const nodes: NoemaTreeNode<Value>[] = [{
  id: "root", label: "Root", value: { path: "" }, expanded: true, children: [
    { id: "a", label: "A", value: { path: "a" }, children: [
      { id: "b", label: "B", detail: "leaf", value: { path: "a/b" } },
    ] },
    { id: "c", label: "C", disabled: true, value: { path: "c" } },
  ],
}];

afterEach(() => document.body.replaceChildren());

describe("source-owned tree view", () => {
  test("renders an accessible hierarchy and preserves collapse state", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const toggled = vi.fn();
    const tree = createTreeView(root, { nodes, ariaLabel: "Folders", onToggle: toggled });
    expect(root.getAttribute("role")).toBe("tree");
    expect(root.querySelector('[data-noema-tree-id="root"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector('[data-noema-tree-id="b"]')).toBeNull();
    expect(tree.toggle("a", true)).toBe(true);
    expect(root.querySelector('[data-noema-tree-id="b"]')?.getAttribute("aria-level")).toBe("3");
    expect(toggled).toHaveBeenCalledWith(nodes[0]!.children![0], true);
  });

  test("supports roving focus, arrow navigation, modifiers, and Enter activation", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const activate = vi.fn();
    const tree = createTreeView(root, { nodes, onActivate: activate });
    expect(tree.focus("root")).toBe(true);
    root.querySelector<HTMLElement>('[data-noema-tree-id="root"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-noema-tree-id")).toBe("a");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(activate.mock.calls[0]?.[0]).toMatchObject({ node: nodes[0]!.children![0], ctrlKey: true });
  });
});
