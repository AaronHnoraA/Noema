import type { GraphEdge, GraphNode, GraphPayload } from "./types.ts";
import type { RendererActivityState } from "../src/renderer-activity.ts";
import { knowledgeEntityMatches, parseKnowledgeQuery } from "../shared/knowledge-query.mjs";

export type WorkspaceGraphOptions = {
  root: HTMLElement;
  status: HTMLElement;
  detail: HTMLElement;
  searchInput: HTMLInputElement;
  groupInput: HTMLSelectElement;
  payload: GraphPayload;
  currentKey: string;
  openNode: (node: GraphNode, options?: { newWindow?: boolean }) => void;
  mode?: "panel" | "preview" | "full";
  maxNodes?: number;
  settings?: Partial<WorkspaceGraphSettings>;
  onSettingsChange?: (settings: WorkspaceGraphSettings) => void;
};

export type WorkspaceGraph = {
  destroy: () => void;
  center: () => void;
  setActivity: (state: RendererActivityState) => void;
};

export type WorkspaceGraphSettings = {
  showTags: boolean;
  showMissing: boolean;
  showAttachments: boolean;
  showOrphans: boolean;
  showArrows: boolean;
  showContext: boolean;
  colorBy: "repository" | "namespace" | "group";
  scope: "global" | "local";
  neighborDepth: number;
  follow: boolean;
  localRoot: string;
};

export type DrawNode = GraphNode & {
  x: number;
  y: number;
  degree: number;
  current: boolean;
  matched: boolean;
  context: boolean;
};

export type DrawEdge = GraphEdge & { sourceNode: DrawNode; targetNode: DrawNode };

export const MAX_WORKSPACE_GRAPH_NODES = 10_000;
export const MAX_WORKSPACE_GRAPH_EDGES = 25_000;

export const DEFAULT_WORKSPACE_GRAPH_SETTINGS: WorkspaceGraphSettings = {
  showTags: true,
  showMissing: false,
  showAttachments: false,
  showOrphans: true,
  showArrows: false,
  showContext: false,
  colorBy: "repository",
  scope: "global",
  neighborDepth: 1,
  follow: true,
  localRoot: "",
};

export function normalizedWorkspaceGraphSettings(
  value: Partial<WorkspaceGraphSettings> = {},
): WorkspaceGraphSettings {
  const colorBy = ["repository", "namespace", "group"].includes(String(value.colorBy))
    ? value.colorBy as WorkspaceGraphSettings["colorBy"]
    : DEFAULT_WORKSPACE_GRAPH_SETTINGS.colorBy;
  return {
    ...DEFAULT_WORKSPACE_GRAPH_SETTINGS,
    ...value,
    colorBy,
    scope: value.scope === "local" ? "local" : "global",
    neighborDepth: Math.max(1, Math.min(3, Math.floor(Number(value.neighborDepth) || 1))),
    localRoot: String(value.localRoot || ""),
  };
}

/**
 * Adapted from org-roam-ui's util/findNthNeighbour.ts (GPL-3.0), reviewed at
 * upstream commit 2894dcbf56d2eca8d3cae2b1ae183f51724b5db6.
 */
export function workspaceGraphNeighborKeys(
  payload: GraphPayload,
  roots: readonly string[],
  depth: number,
  excludedKeys: readonly string[] = [],
): Set<string> {
  const excluded = new Set(excludedKeys);
  const completed = new Set(roots.filter((key) => key && !excluded.has(key)));
  let queue = [...completed];
  const linksByNode = new Map<string, GraphEdge[]>();
  for (const edge of payload.edges) {
    if (excluded.has(edge.source) || excluded.has(edge.target)) continue;
    for (const key of [edge.source, edge.target]) {
      const links = linksByNode.get(key) ?? [];
      links.push(edge);
      linksByNode.set(key, links);
    }
  }
  for (let hop = 0; hop < Math.max(0, Math.floor(depth)); hop += 1) {
    const next = new Set<string>();
    for (const key of queue) {
      for (const edge of linksByNode.get(key) ?? []) {
        const neighbor = edge.source === key ? edge.target : edge.source;
        if (!excluded.has(neighbor) && !completed.has(neighbor)) next.add(neighbor);
      }
    }
    if (next.size === 0) break;
    for (const key of next) completed.add(key);
    queue = [...next];
  }
  return completed;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return result >>> 0;
}

export function workspaceGraphNodeLabel(node: GraphNode): string {
  return node.title || node.id || node.path || node.key;
}

const GRAPH_PALETTE = ["#9b3827", "#6c5a8c", "#39736d", "#9a6a24", "#3f668f", "#86604e", "#65733f", "#8b4868"];

function colorGroup(node: GraphNode, colorBy: WorkspaceGraphSettings["colorBy"]): string {
  if (colorBy === "namespace") return node.namespace || node.repositoryId || node.groupKey || "Root";
  if (colorBy === "group") return node.groupKey || node.groupLabel || "Root";
  return node.repositoryId || node.groupKey || node.groupLabel || "Root";
}

export function workspaceGraphNodeColor(node: GraphNode, colorBy: WorkspaceGraphSettings["colorBy"]): string {
  return GRAPH_PALETTE[hash(colorGroup(node, colorBy)) % GRAPH_PALETTE.length] || GRAPH_PALETTE[0];
}

export function workspaceGraphNodeMatches(node: GraphNode, query: string, degree = 0): boolean {
  return knowledgeEntityMatches(node as unknown as Record<string, unknown>, parseKnowledgeQuery(query), { degree });
}

export function workspaceGraphDrawPlan(
  payload: GraphPayload,
  currentKey: string,
  query: string,
  options: { maxNodes?: number; settings?: Partial<WorkspaceGraphSettings>; filterQuery?: boolean } = {},
): { nodes: DrawNode[]; edges: DrawEdge[]; truncated: boolean } {
  const settings = normalizedWorkspaceGraphSettings(options.settings);
  const maxNodes = Math.max(1, Math.min(MAX_WORKSPACE_GRAPH_NODES, options.maxNodes ?? MAX_WORKSPACE_GRAPH_NODES));
  const degrees = new Map<string, number>();
  for (const edge of payload.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const needle = query.trim().toLowerCase();
  const localRoot = settings.follow && currentKey ? currentKey : settings.localRoot || currentKey;
  const localKeys = settings.scope === "local" && localRoot
    ? workspaceGraphNeighborKeys(payload, [localRoot], settings.neighborDepth)
    : null;
  const eligible = payload.nodes.filter((node) => {
    const kind = node.kind || "note";
    const degree = degrees.get(node.key) ?? 0;
    if (!settings.showTags && kind === "tag") return false;
    if (!settings.showMissing && (kind === "missing" || node.exists === false)) return false;
    if (!settings.showAttachments && kind === "dependency") return false;
    if (!settings.showOrphans && degree === 0 && node.key !== currentKey) return false;
    if (localKeys && !localKeys.has(node.key)) return false;
    return true;
  });
  const matchedKeys = new Set(eligible
    .filter((node) => !needle || workspaceGraphNodeMatches(node, query, degrees.get(node.key) ?? 0))
    .map((node) => node.key));
  const visibleKeys = new Set(matchedKeys);
  if (needle && options.filterQuery === true && settings.showContext) {
    for (const edge of payload.edges) {
      if (matchedKeys.has(edge.source)) visibleKeys.add(edge.target);
      if (matchedKeys.has(edge.target)) visibleKeys.add(edge.source);
    }
  }
  const ranked = eligible
    .filter((node) => options.filterQuery !== true || !needle || visibleKeys.has(node.key))
    .map((node) => ({
      node,
      tier: node.key === currentKey ? 0 : needle && matchedKeys.has(node.key) ? 1 : 2,
      degree: degrees.get(node.key) ?? 0,
    }))
    .sort((a, b) => a.tier - b.tier
      || b.degree - a.degree
      || Number(b.node.mtimeMs || 0) - Number(a.node.mtimeMs || 0)
      || a.node.key.localeCompare(b.node.key));
  const chosen = ranked.slice(0, maxNodes).map(({ node }) => ({
    ...node,
    x: 0,
    y: 0,
    degree: degrees.get(node.key) ?? 0,
    current: node.key === currentKey,
    matched: !needle || matchedKeys.has(node.key),
    context: Boolean(needle && !matchedKeys.has(node.key)),
  }));
  const byKey = new Map(chosen.map((node) => [node.key, node]));
  const edges: DrawEdge[] = [];
  for (const edge of payload.edges) {
    const sourceNode = byKey.get(edge.source);
    const targetNode = byKey.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    edges.push({ ...edge, sourceNode, targetNode });
    if (edges.length >= MAX_WORKSPACE_GRAPH_EDGES) break;
  }
  return {
    nodes: chosen,
    edges,
    truncated: ranked.length > chosen.length || payload.edges.length > edges.length,
  };
}
