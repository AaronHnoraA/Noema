/*
 * 3D adapter for the shared org-roam-ui interaction runtime.
 * Scope, search, follow, local graph and click semantics are intentionally not
 * implemented here; both dimensions consume workspace-graph-runtime.ts.
 */
import ForceGraph3D, {
  type ForceGraph3DInstance,
  type LinkObject,
  type NodeObject,
} from "3d-force-graph";
import {
  createWorkspaceGraphRuntime,
  workspaceGraphEndpointKey,
  type WorkspaceForceLink,
  type WorkspaceForceNode,
  type WorkspaceGraphAdapter,
  type WorkspaceGraphAdapterFactory,
  type WorkspaceGraphVisualState,
} from "./workspace-graph-runtime.ts";
import {
  workspaceGraphNodeColor,
  workspaceGraphNodeLabel,
  type WorkspaceGraph,
  type WorkspaceGraphOptions,
} from "./workspace-graph-model.ts";

type ThreeNode = NodeObject & WorkspaceForceNode;
type ThreeLink = LinkObject<ThreeNode> & WorkspaceForceLink;

const createWorkspaceGraph3DAdapter: WorkspaceGraphAdapterFactory = (stage, size, events) => {
  stage.classList.add("aaronnote-workspace-graph-3d");
  let visuals: WorkspaceGraphVisualState | null = null;
  const graph: ForceGraph3DInstance<ThreeNode, ThreeLink> = new ForceGraph3D<ThreeNode, ThreeLink>(stage, {
    controlType: "orbit",
  });

  const nodeColor = (node: ThreeNode): string => {
    const state = visuals!;
    if (state.activeKey && !state.relatedKeys.has(node.key)) return state.colors.muted;
    if (node.key === state.selectedKey || node.key === state.hoveredKey || node.current) return state.colors.accent;
    if (node.kind === "tag") return state.colors.tag;
    if (node.kind === "missing" || node.exists === false) return state.colors.missing;
    return workspaceGraphNodeColor(node, state.settings.colorBy);
  };

  const nodeValue = (node: ThreeNode): number => {
    const base = Math.min(8, 1.8 + Math.sqrt(Math.max(0, node.degree)) * 0.75);
    return node.key === visuals?.selectedKey || node.key === visuals?.hoveredKey || node.current ? base * 1.8 : base;
  };

  const linkColor = (link: ThreeLink): string => {
    const state = visuals!;
    const source = workspaceGraphEndpointKey(link.source as WorkspaceForceLink["source"]);
    const target = workspaceGraphEndpointKey(link.target as WorkspaceForceLink["target"]);
    if (state.activeKey && source !== state.activeKey && target !== state.activeKey) return `${state.colors.muted}18`;
    return link.type === "tag" ? state.colors.tag : link.type === "dependency" ? state.colors.accent : state.colors.ink;
  };

  const linkWidth = (link: ThreeLink): number => {
    const state = visuals!;
    const source = workspaceGraphEndpointKey(link.source as WorkspaceForceLink["source"]);
    const target = workspaceGraphEndpointKey(link.target as WorkspaceForceLink["target"]);
    return state.activeKey && (source === state.activeKey || target === state.activeKey) ? 1.8 : 0.55;
  };

  graph
    .width(size.width)
    .height(size.height)
    .showNavInfo(false)
    .nodeId("id")
    .nodeLabel((node) => workspaceGraphNodeLabel(node))
    .nodeRelSize(4)
    .nodeOpacity(0.92)
    .nodeResolution(10)
    .linkOpacity(0.28)
    .linkDirectionalArrowRelPos(0.72)
    .d3AlphaDecay(0.035)
    .d3VelocityDecay(0.32)
    .onNodeHover((node) => {
      stage.style.cursor = node ? "pointer" : "grab";
      events.nodeHover(node);
    })
    .onNodeClick((node, event) => events.nodeClick(node, event))
    .onNodeRightClick((node, event) => events.nodeRightClick(node, event))
    .onBackgroundClick(() => events.backgroundClick());

  const adapter: WorkspaceGraphAdapter = {
    setData(nodes, links) {
      graph.graphData({ nodes: nodes as ThreeNode[], links: links as ThreeLink[] });
    },
    updateVisuals(state) {
      visuals = state;
      graph
        .backgroundColor(state.colors.paper)
        .nodeColor(nodeColor)
        .nodeVal(nodeValue)
        .linkColor(linkColor)
        .linkWidth(linkWidth)
        .linkDirectionalArrowLength((link) => state.settings.showArrows && link.directed !== false ? 3.4 : 0);
    },
    focus(node) {
      const x = Number(node.x) || 0;
      const y = Number(node.y) || 0;
      const z = Number((node as ThreeNode).z) || 0;
      const length = Math.hypot(x, y, z);
      const ratio = length > 0 ? 1 + 95 / length : 1;
      graph.cameraPosition(
        length > 0 ? { x: x * ratio, y: y * ratio, z: z * ratio } : { x: 0, y: 0, z: 110 },
        { x, y, z },
        700,
      );
    },
    center() {
      graph.zoomToFit(600, 55);
    },
    resize(width, height) {
      graph.width(width).height(height);
    },
    destroy() {
      graph._destructor();
      stage.replaceChildren();
    },
  };
  return adapter;
};

export function createWorkspaceGraph3D(options: WorkspaceGraphOptions): WorkspaceGraph {
  return createWorkspaceGraphRuntime(options, createWorkspaceGraph3DAdapter);
}
