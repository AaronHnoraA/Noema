/*
 * 2D renderer built on the same force-graph stack used by org-roam-ui.
 * Shared behavior lives in workspace-graph-runtime.ts; this file only adapts
 * the 2D canvas renderer and label drawing.
 */
import ForceGraph, {
  type ForceGraphInstance,
  type LinkObject,
  type NodeObject,
} from "force-graph";
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

export * from "./workspace-graph-model.ts";

type TwoNode = NodeObject & WorkspaceForceNode;
type TwoLink = LinkObject & WorkspaceForceLink;

function nodeRadius(node: WorkspaceForceNode): number {
  return Math.min(8, 2.2 + Math.sqrt(Math.max(0, node.degree)) * 0.78);
}

const createWorkspaceGraph2DAdapter: WorkspaceGraphAdapterFactory = (stage, size, events) => {
  stage.classList.add("aaronnote-workspace-graph-2d");
  let visuals: WorkspaceGraphVisualState | null = null;
  const graph: ForceGraphInstance = ForceGraph()(stage);

  const nodeColor = (raw: NodeObject): string => {
    const node = raw as TwoNode;
    const state = visuals!;
    if (state.activeKey && !state.relatedKeys.has(node.key)) return state.colors.muted;
    if (node.key === state.selectedKey || node.key === state.hoveredKey || node.current) return state.colors.accent;
    if (node.kind === "tag") return state.colors.tag;
    if (node.kind === "missing" || node.exists === false) return state.colors.missing;
    return workspaceGraphNodeColor(node, state.settings.colorBy);
  };

  const nodeValue = (raw: NodeObject): number => {
    const node = raw as TwoNode;
    const active = node.key === visuals?.selectedKey || node.key === visuals?.hoveredKey || node.current;
    const radius = nodeRadius(node) * (active ? 1.45 : 1);
    return radius * radius;
  };

  const linkColor = (raw: LinkObject): string => {
    const link = raw as TwoLink;
    const state = visuals!;
    const source = workspaceGraphEndpointKey(link.source as WorkspaceForceLink["source"]);
    const target = workspaceGraphEndpointKey(link.target as WorkspaceForceLink["target"]);
    if (state.activeKey && source !== state.activeKey && target !== state.activeKey) return `${state.colors.muted}18`;
    return link.type === "tag" ? state.colors.tag : link.type === "dependency" ? state.colors.accent : state.colors.muted;
  };

  const linkWidth = (raw: LinkObject): number => {
    const link = raw as TwoLink;
    const state = visuals!;
    const source = workspaceGraphEndpointKey(link.source as WorkspaceForceLink["source"]);
    const target = workspaceGraphEndpointKey(link.target as WorkspaceForceLink["target"]);
    return state.activeKey && (source === state.activeKey || target === state.activeKey) ? 1.8 : 0.7;
  };

  const drawLabel = (raw: NodeObject, context: CanvasRenderingContext2D, globalScale: number): void => {
    const node = raw as TwoNode;
    const state = visuals;
    if (!state || node.x == null || node.y == null) return;
    const active = node.current || node.key === state.selectedKey || node.key === state.hoveredKey;
    const visible = active || globalScale >= 2 || (globalScale >= 1.25 && node.degree >= 2) || (state.nodeCount <= 80 && globalScale >= 1.05);
    if (!visible) return;
    const label = workspaceGraphNodeLabel(node).slice(0, 48);
    const fontSize = Math.max(3.5, 11 / globalScale);
    const radius = Math.sqrt(nodeValue(node));
    context.font = `${fontSize}px system-ui`;
    context.textAlign = "center";
    context.textBaseline = "top";
    const width = context.measureText(label).width + fontSize * 0.8;
    const x = Number(node.x) - width / 2;
    const y = Number(node.y) + radius + fontSize * 0.45;
    context.fillStyle = `${state.colors.paper}dc`;
    context.fillRect(x, y, width, fontSize * 1.35);
    context.fillStyle = state.activeKey && !state.relatedKeys.has(node.key) ? state.colors.muted : state.colors.ink;
    context.fillText(label, Number(node.x), y + fontSize * 0.16);
  };

  graph
    .width(size.width)
    .height(size.height)
    .nodeId("id")
    .nodeLabel((node) => workspaceGraphNodeLabel(node as TwoNode))
    .nodeRelSize(1)
    .nodeCanvasObject(drawLabel)
    .nodeCanvasObjectMode(() => "after")
    .linkDirectionalArrowRelPos(0.72)
    .d3AlphaDecay(0.035)
    .d3VelocityDecay(0.32)
    .minZoom(0.25)
    .maxZoom(8)
    .onNodeHover((node) => events.nodeHover(node as TwoNode | null))
    .onNodeClick((node, event) => events.nodeClick(node as TwoNode, event))
    .onNodeRightClick((node, event) => events.nodeRightClick(node as TwoNode, event))
    .onBackgroundClick(() => events.backgroundClick());

  const adapter: WorkspaceGraphAdapter = {
    setData(nodes, links) {
      graph.graphData({ nodes: nodes as TwoNode[], links: links as TwoLink[] });
    },
    updateVisuals(state) {
      visuals = state;
      graph
        .backgroundColor(state.colors.paper)
        .nodeColor(nodeColor)
        .nodeVal(nodeValue)
        .linkColor(linkColor)
        .linkWidth(linkWidth)
        .linkDirectionalArrowLength((link) => state.settings.showArrows && (link as TwoLink).directed !== false ? 5 : 0);
    },
    focus(node) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
      graph.centerAt(node.x, node.y, 650).zoom(Math.max(2.2, graph.zoom()), 650);
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

export function createWorkspaceGraph(options: WorkspaceGraphOptions): WorkspaceGraph {
  return createWorkspaceGraphRuntime(options, createWorkspaceGraph2DAdapter);
}
