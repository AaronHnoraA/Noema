import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { workspaceGraphDrawPlan, workspaceGraphNeighborKeys, workspaceGraphNodeColor, workspaceGraphNodeMatches } from "../aaronnote/workspace-graph.ts";
import {
  createWorkspaceGraphRuntime,
  type WorkspaceForceNode,
  type WorkspaceGraphAdapter,
  type WorkspaceGraphEvents,
  type WorkspaceGraphVisualState,
} from "../aaronnote/workspace-graph-runtime.ts";
import type { GraphPayload } from "../aaronnote/types.ts";

describe("workspace graph performance boundaries", () => {
  test("caps a 50k-node index deterministically while retaining current and searched notes", () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => ({
      key: `n-${index}`,
      title: index === 49_999 ? "Needle Tensor Result" : `Note ${index}`,
      groupKey: `g-${index % 20}`,
      tags: [`tag-${index % 50}`],
    }));
    const edges = Array.from({ length: 30_000 }, (_, index) => ({
      source: `n-${index}`,
      target: `n-${(index + 1) % nodes.length}`,
      type: "ref" as const,
    }));
    const payload: GraphPayload = {
      indexVersion: 7,
      nodes,
      edges,
      meta: { noteCount: nodes.length, edgeCount: edges.length },
    };
    const plan = workspaceGraphDrawPlan(payload, "n-40", "needle tensor");
    expect(plan.nodes).toHaveLength(10_000);
    expect(plan.edges.length).toBeLessThanOrEqual(25_000);
    expect(plan.nodes.some((node) => node.key === "n-40")).toBe(true);
    expect(plan.nodes.some((node) => node.key === "n-49999")).toBe(true);
    expect(plan.truncated).toBe(true);
  });

  test("supports structured filters and exclusions", () => {
    const node = {
      key: "qc/density",
      title: "Density Operator",
      path: "quantum/density_operator.md",
      repositoryId: "Public-QC",
      namespace: "quantum",
      kind: "note" as const,
      tags: ["physics", "linear-algebra"],
    };
    expect(workspaceGraphNodeMatches(node, "repo:public-qc tag:physics", 3)).toBe(true);
    expect(workspaceGraphNodeMatches(node, "namespace:quantum -tag:biology", 3)).toBe(true);
    expect(workspaceGraphNodeMatches(node, "is:orphan", 3)).toBe(false);
    expect(workspaceGraphNodeMatches(node, "is:orphan", 0)).toBe(true);
  });

  test("builds a strict tag result subgraph and hides attachments by default", () => {
    const payload: GraphPayload = {
      indexVersion: 1,
      nodes: [
        { key: "math", title: "Math", kind: "note", tags: ["math"] },
        { key: "bio", title: "Bio", kind: "note", tags: ["bio"] },
        { key: "tag:math", title: "#math", kind: "tag" },
        { key: "image", title: "plot.png", kind: "dependency" },
      ],
      edges: [
        { source: "math", target: "tag:math", type: "tag" },
        { source: "math", target: "image", type: "dependency" },
      ],
      meta: {},
    };
    const filtered = workspaceGraphDrawPlan(payload, "", "tag:math", { filterQuery: true });
    expect(filtered.nodes.map((node) => node.key).sort()).toEqual(["math", "tag:math"]);
    expect(filtered.edges).toHaveLength(1);
    expect(workspaceGraphDrawPlan(payload, "", "", { filterQuery: true }).nodes.some((node) => node.key === "image")).toBe(false);
    expect(workspaceGraphDrawPlan(payload, "", "is:attachment", { filterQuery: true, settings: { showAttachments: true } }).nodes.map((node) => node.key)).toEqual(["image"]);
  });

  test("colors repository and namespace groups deterministically", () => {
    const node = { key: "note", repositoryId: "Public-QC", namespace: "quantum" };
    expect(workspaceGraphNodeColor(node, "repository")).toBe(workspaceGraphNodeColor(node, "repository"));
    expect(workspaceGraphNodeColor(node, "repository")).not.toBe(workspaceGraphNodeColor(node, "namespace"));
  });

  test("builds the org-roam style N-hop local scope without leaking other components", () => {
    const payload: GraphPayload = {
      indexVersion: 1,
      nodes: ["a", "b", "c", "d", "other"].map((key) => ({ key, title: key })),
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "c", target: "d" },
      ],
      meta: {},
    };
    expect([...workspaceGraphNeighborKeys(payload, ["a"], 2)].sort()).toEqual(["a", "b", "c"]);
    expect(workspaceGraphDrawPlan(payload, "", "", {
      settings: { scope: "local", localRoot: "a", neighborDepth: 2 },
    }).nodes.map((node) => node.key).sort()).toEqual(["a", "b", "c"]);
  });

  test("shares right-click local scope, hover highlight, and double-click open semantics", () => {
    const payload: GraphPayload = {
      indexVersion: 1,
      nodes: ["a", "b", "c", "other"].map((key) => ({ key, id: key, title: key, kind: "note" as const })),
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
      meta: {},
    };
    const root = document.createElement("div");
    const status = document.createElement("div");
    const detail = document.createElement("div");
    const searchInput = document.createElement("input");
    const groupInput = document.createElement("select");
    document.body.append(root, status, detail, searchInput, groupInput);
    let events: WorkspaceGraphEvents | null = null;
    let nodes: WorkspaceForceNode[] = [];
    let visual!: WorkspaceGraphVisualState;
    const activity: string[] = [];
    const settings: Array<{ scope: string; localRoot: string }> = [];
    const opened: string[] = [];
    const adapter: WorkspaceGraphAdapter = {
      setData(next) { nodes = next; },
      updateVisuals(next) { visual = next; },
      focus() {},
      center() {},
      resize() {},
      setActivity(state) { activity.push(state); },
      destroy() {},
    };
    const graph = createWorkspaceGraphRuntime({
      root,
      status,
      detail,
      searchInput,
      groupInput,
      payload,
      currentKey: "",
      openNode: (node) => opened.push(node.key),
      settings: { showOrphans: true, neighborDepth: 1 },
      onSettingsChange: (next) => settings.push({ scope: next.scope, localRoot: next.localRoot }),
    }, (_stage, _size, handlers) => {
      events = handlers;
      return adapter;
    });

    const b = nodes.find((node) => node.key === "b")!;
    events!.nodeHover(b);
    expect(visual.activeKey).toBe("b");
    expect([...visual.relatedKeys].sort()).toEqual(["a", "b", "c"]);

    events!.nodeRightClick(b, { preventDefault() {} } as MouseEvent);
    expect(settings.at(-1)).toEqual({ scope: "local", localRoot: "b" });
    expect(nodes.map((node) => node.key).sort()).toEqual(["a", "b", "c"]);

    const click = (timeStamp: number): MouseEvent => ({
      timeStamp,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    } as MouseEvent);
    events!.nodeClick(nodes.find((node) => node.key === "b")!, click(1_000));
    events!.nodeClick(nodes.find((node) => node.key === "b")!, click(1_100));
    expect(opened).toEqual(["b"]);
    graph.setActivity("quiescent");
    graph.setActivity("active");
    expect(activity).toEqual(["quiescent", "active"]);
    graph.destroy();
    root.remove();
    status.remove();
    detail.remove();
    searchInput.remove();
    groupInput.remove();
  });
});
