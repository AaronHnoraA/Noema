/*
 * Shared 2D/3D interaction runtime adapted from org-roam-ui pages/index.tsx at
 * 2894dcbf56d2eca8d3cae2b1ae183f51724b5db6 (GPL-3.0).
 * Rendering is delegated to force-graph adapters; scope, search, follow,
 * highlight, local-graph and open behavior live here exactly once.
 */
import type { GraphEdge } from "./types.ts";
import {
  normalizedWorkspaceGraphSettings,
  workspaceGraphDrawPlan,
  workspaceGraphNodeMatches,
  workspaceGraphNodeLabel,
  type DrawNode,
  type WorkspaceGraph,
  type WorkspaceGraphOptions,
  type WorkspaceGraphSettings,
} from "./workspace-graph-model.ts";
import { markdownLinkPrimaryModifier } from "../src/cm6/markdown-link-events.ts";

export type WorkspaceForceNode = DrawNode & { id: string };

export type WorkspaceForceLink = {
  source: string | WorkspaceForceNode;
  target: string | WorkspaceForceNode;
  type?: GraphEdge["type"];
  directed?: boolean;
};

export type WorkspaceGraphColors = {
  paper: string;
  ink: string;
  muted: string;
  accent: string;
  tag: string;
  missing: string;
};

export type WorkspaceGraphVisualState = {
  settings: WorkspaceGraphSettings;
  selectedKey: string;
  hoveredKey: string;
  activeKey: string;
  relatedKeys: Set<string>;
  nodeCount: number;
  colors: WorkspaceGraphColors;
};

export type WorkspaceGraphEvents = {
  nodeHover: (node: WorkspaceForceNode | null) => void;
  nodeClick: (node: WorkspaceForceNode, event: MouseEvent) => void;
  nodeRightClick: (node: WorkspaceForceNode, event: MouseEvent) => void;
  backgroundClick: () => void;
};

export type WorkspaceGraphAdapter = {
  setData: (nodes: WorkspaceForceNode[], links: WorkspaceForceLink[]) => void;
  updateVisuals: (state: WorkspaceGraphVisualState) => void;
  focus: (node: WorkspaceForceNode) => void;
  center: () => void;
  resize: (width: number, height: number) => void;
  destroy: () => void;
};

export type WorkspaceGraphAdapterFactory = (
  stage: HTMLElement,
  size: { width: number; height: number },
  events: WorkspaceGraphEvents,
) => WorkspaceGraphAdapter;

const SEARCH_LIMIT = 50;

export function workspaceGraphEndpointKey(endpoint: string | WorkspaceForceNode | undefined): string {
  return typeof endpoint === "object" && endpoint ? endpoint.key : String(endpoint ?? "");
}

function graphColors(root: HTMLElement): WorkspaceGraphColors {
  const style = getComputedStyle(root);
  return {
    paper: style.getPropertyValue("--aaron-paper").trim() || "#111622",
    ink: style.getPropertyValue("--aaron-ink").trim() || "#e4e9f4",
    muted: style.getPropertyValue("--aaron-muted").trim() || "#71809d",
    accent: style.getPropertyValue("--aaron-accent").trim() || "#ff7d9f",
    tag: style.getPropertyValue("--aaron-green-soft").trim() || "#73c9a8",
    missing: "#b06b63",
  };
}

export function createWorkspaceGraphRuntime(
  options: WorkspaceGraphOptions,
  createAdapter: WorkspaceGraphAdapterFactory,
): WorkspaceGraph {
  const settings = normalizedWorkspaceGraphSettings(options.settings);
  let destroyed = false;
  let selectedKey = "";
  let hoveredKey = "";
  let visibleNodes: WorkspaceForceNode[] = [];
  let visibleLinks: WorkspaceForceLink[] = [];
  let clickTimer = 0;
  let fitTimer = 0;
  let lastClickAt = 0;

  const stage = document.createElement("div");
  stage.className = "aaronnote-workspace-force-graph";
  stage.setAttribute("role", "img");
  stage.setAttribute("aria-label", "Workspace knowledge graph");
  const searchResults = document.createElement("div");
  searchResults.className = "aaronnote-graph-search-results";
  searchResults.setAttribute("role", "listbox");
  searchResults.hidden = true;
  const accessible = document.createElement("div");
  accessible.className = "aaronnote-graph-accessible-nodes";
  accessible.setAttribute("aria-label", "Visible graph nodes");
  options.root.replaceChildren(stage, searchResults, accessible);

  const bounds = options.root.getBoundingClientRect();
  let width = Math.max(320, Math.round(bounds.width || options.root.clientWidth || 720));
  let height = Math.max(options.mode === "preview" ? 260 : 360, Math.round(bounds.height || options.root.clientHeight || 560));
  const colors = graphColors(options.root);

  function relatedKeys(key: string): Set<string> {
    const related = new Set<string>(key ? [key] : []);
    if (!key) return related;
    for (const link of visibleLinks) {
      const source = workspaceGraphEndpointKey(link.source);
      const target = workspaceGraphEndpointKey(link.target);
      if (source === key) related.add(target);
      if (target === key) related.add(source);
    }
    return related;
  }

  let adapter: WorkspaceGraphAdapter;

  function refreshVisuals(): void {
    if (!adapter || destroyed) return;
    const activeKey = hoveredKey || selectedKey;
    adapter.updateVisuals({
      settings: { ...settings },
      selectedKey,
      hoveredKey,
      activeKey,
      relatedKeys: relatedKeys(activeKey),
      nodeCount: visibleNodes.length,
      colors,
    });
  }

  function persistSettings(patch: Partial<WorkspaceGraphSettings>): void {
    Object.assign(settings, normalizedWorkspaceGraphSettings({ ...settings, ...patch }));
    options.onSettingsChange?.({ ...settings });
  }

  function selectedNode(): WorkspaceForceNode | null {
    return visibleNodes.find((node) => node.key === selectedKey) ?? null;
  }

  function showDetail(node: WorkspaceForceNode | null, focus = settings.follow): void {
    selectedKey = node?.key || "";
    options.detail.replaceChildren();
    options.detail.hidden = !node;
    if (!node) {
      refreshVisuals();
      return;
    }
    const inbound = visibleLinks.filter((link) => workspaceGraphEndpointKey(link.target) === node.key).length;
    const outbound = visibleLinks.filter((link) => workspaceGraphEndpointKey(link.source) === node.key).length;
    const title = document.createElement("strong");
    title.textContent = workspaceGraphNodeLabel(node);
    const stats = document.createElement("span");
    stats.textContent = `${inbound} inbound · ${outbound} outbound`;
    const tags = document.createElement("span");
    tags.textContent = (node.tags ?? []).map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
    const actions = document.createElement("span");
    actions.className = "aaronnote-graph-detail-actions";
    const local = document.createElement("button");
    local.type = "button";
    local.textContent = "Local graph";
    local.addEventListener("click", () => enterLocalGraph(node));
    actions.append(local);
    if (node.kind === "note" && node.exists !== false) {
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open note";
      open.addEventListener("click", () => options.openNode(node));
      actions.prepend(open);
    }
    options.detail.append(title, stats, tags, actions);
    if (focus) adapter.focus(node);
    refreshVisuals();
  }

  function renderAccessibleNodes(): void {
    accessible.replaceChildren();
    for (const node of visibleNodes.slice(0, 250)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = workspaceGraphNodeLabel(node);
      button.addEventListener("click", () => showDetail(node));
      button.addEventListener("dblclick", () => options.openNode(node));
      accessible.append(button);
    }
  }

  function updateStatus(truncated: boolean): void {
    const scope = settings.scope === "local"
      ? settings.localRoot ? ` · local ${settings.neighborDepth}-hop` : " · local · select a node"
      : " · global";
    options.status.textContent = `${visibleNodes.length} / ${options.payload.nodes.length} nodes · ${visibleLinks.length} links${scope}${truncated ? " · capped" : ""}`;
  }

  function scheduleFit(): void {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      if (!destroyed) adapter.center();
    }, 90);
  }

  function rebuild(fit = false): void {
    if (destroyed) return;
    const next = workspaceGraphDrawPlan(options.payload, options.currentKey, options.searchInput.value, {
      maxNodes: options.maxNodes,
      settings,
      filterQuery: true,
    });
    const group = options.groupInput.value;
    const drawNodes = group
      ? next.nodes.filter((node) => (node.groupKey || node.groupLabel || "Root") === group)
      : next.nodes;
    const visibleKeys = new Set(drawNodes.map((node) => node.key));
    visibleNodes = drawNodes.map((node) => ({ ...node, id: node.key }));
    visibleLinks = next.edges
      .filter((edge) => visibleKeys.has(edge.source) && visibleKeys.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type, directed: edge.directed }));
    adapter.setData(visibleNodes, visibleLinks);
    if (!visibleKeys.has(selectedKey)) selectedKey = "";
    if (!visibleKeys.has(hoveredKey)) hoveredKey = "";
    updateStatus(next.truncated);
    renderAccessibleNodes();
    refreshVisuals();
    if (fit) scheduleFit();
  }

  function enterLocalGraph(node: WorkspaceForceNode): void {
    persistSettings({ scope: "local", localRoot: node.key });
    selectedKey = node.key;
    rebuild(true);
    window.setTimeout(() => {
      const visible = selectedNode();
      if (!destroyed && visible) showDetail(visible, settings.follow);
    }, 110);
  }

  function renderSearch(): void {
    const needle = options.searchInput.value.trim();
    searchResults.replaceChildren();
    if (!needle) {
      searchResults.hidden = true;
      return;
    }
    const degree = new Map<string, number>();
    for (const edge of options.payload.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const matches = options.payload.nodes
      .filter((node) => workspaceGraphNodeMatches(node, needle, degree.get(node.key) ?? 0))
      .slice(0, SEARCH_LIMIT);
    for (const node of matches) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.setAttribute("role", "option");
      choice.textContent = `${workspaceGraphNodeLabel(node)}${node.path ? ` · ${node.path}` : ""}`;
      choice.addEventListener("click", () => {
        if (settings.scope === "local") persistSettings({ localRoot: node.key });
        selectedKey = node.key;
        rebuild(true);
        window.setTimeout(() => {
          const visible = selectedNode();
          if (!destroyed && visible) showDetail(visible, true);
        }, 110);
        searchResults.hidden = true;
      });
      searchResults.append(choice);
    }
    searchResults.hidden = matches.length === 0;
  }

  const events: WorkspaceGraphEvents = {
    nodeHover(node) {
      hoveredKey = node?.key || "";
      stage.style.cursor = node ? "pointer" : "grab";
      refreshVisuals();
    },
    nodeClick(node, event) {
      const now = event.timeStamp || performance.now();
      if (now - lastClickAt < 240) {
        window.clearTimeout(clickTimer);
        lastClickAt = 0;
        options.openNode(node, { newWindow: markdownLinkPrimaryModifier(event) || event.altKey });
        return;
      }
      lastClickAt = now;
      clickTimer = window.setTimeout(() => {
        if (!destroyed) showDetail(node);
      }, 240);
    },
    nodeRightClick(node, event) {
      event.preventDefault();
      enterLocalGraph(node);
    },
    backgroundClick() {
      showDetail(null, false);
    },
  };

  adapter = createAdapter(stage, { width, height }, events);

  const groups = [...new Map(options.payload.nodes.map((node) => [
    node.groupKey || node.groupLabel || "Root",
    node.groupLabel || node.groupKey || "Root",
  ])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const previousGroup = options.groupInput.value;
  const groupOptions = [["", "All groups"], ...groups].map(([key, value]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = value;
    return option;
  });
  options.groupInput.replaceChildren(...groupOptions);
  options.groupInput.value = groups.some(([key]) => key === previousGroup) ? previousGroup : "";

  const onSearch = (): void => {
    renderSearch();
    rebuild(true);
  };
  const onGroup = (): void => rebuild(true);
  options.searchInput.addEventListener("input", onSearch);
  options.groupInput.addEventListener("change", onGroup);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      const next = options.root.getBoundingClientRect();
      const nextWidth = Math.max(320, Math.round(next.width || options.root.clientWidth || width));
      const nextHeight = Math.max(options.mode === "preview" ? 260 : 360, Math.round(next.height || options.root.clientHeight || height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      adapter.resize(width, height);
    });
    resizeObserver.observe(options.root);
  }

  rebuild(true);
  return {
    center: () => adapter.center(),
    destroy() {
      destroyed = true;
      window.clearTimeout(clickTimer);
      window.clearTimeout(fitTimer);
      resizeObserver?.disconnect();
      resizeObserver = null;
      options.searchInput.removeEventListener("input", onSearch);
      options.groupInput.removeEventListener("change", onGroup);
      adapter.destroy();
      options.detail.replaceChildren();
      options.detail.hidden = true;
      options.root.replaceChildren();
    },
  };
}
