import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { workspaceGraphDrawPlan } from "../aaronnote/workspace-graph.ts";
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
});
