import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { workspaceGraphDrawPlan, workspaceGraphNodeColor, workspaceGraphNodeMatches } from "../aaronnote/workspace-graph.ts";
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
});
