import type { GraphEdge, GraphNode, GraphPayload } from "./types.ts";
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
};

export type WorkspaceGraph = { destroy: () => void };

export type WorkspaceGraphSettings = {
  showTags: boolean;
  showMissing: boolean;
  showAttachments: boolean;
  showOrphans: boolean;
  showArrows: boolean;
  showContext: boolean;
  colorBy: "repository" | "namespace" | "group";
};

type DrawNode = GraphNode & { x: number; y: number; degree: number; current: boolean; matched: boolean; context: boolean };
type DrawEdge = GraphEdge & { sourceNode: DrawNode; targetNode: DrawNode };

const MAX_DRAW_NODES = 10_000;
const MAX_DRAW_EDGES = 25_000;
const SEARCH_LIMIT = 50;
const DPR_LIMIT = 2;
const DEFAULT_SETTINGS: WorkspaceGraphSettings = {
  showTags: true,
  showMissing: false,
  showAttachments: false,
  showOrphans: true,
  showArrows: false,
  showContext: false,
  colorBy: "repository",
};

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function label(node: GraphNode): string {
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

function clusterLayout(nodes: DrawNode[], width: number, height: number): void {
  const groups = new Map<string, DrawNode[]>();
  for (const node of nodes) {
    const key = node.groupKey || node.groupLabel || "Root";
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const orbit = Math.max(80, Math.min(width, height) * 0.32);
  ordered.forEach(([groupKey, group], groupIndex) => {
    const angle = ordered.length === 1 ? 0 : groupIndex / ordered.length * Math.PI * 2;
    const cx = width / 2 + Math.cos(angle) * (ordered.length === 1 ? 0 : orbit);
    const cy = height / 2 + Math.sin(angle) * (ordered.length === 1 ? 0 : orbit);
    group.sort((a, b) => a.key.localeCompare(b.key));
    group.forEach((node, index) => {
      const seed = hash(`${groupKey}\0${node.key}`);
      const theta = index * 2.399963229728653 + seed % 360 / 57.2958;
      const radius = 8 + Math.sqrt(index) * 7;
      node.x = cx + Math.cos(theta) * radius;
      node.y = cy + Math.sin(theta) * radius;
    });
  });
}

export function workspaceGraphDrawPlan(
  payload: GraphPayload,
  currentKey: string,
  query: string,
  options: { maxNodes?: number; settings?: Partial<WorkspaceGraphSettings>; filterQuery?: boolean } = {},
): { nodes: DrawNode[]; edges: DrawEdge[]; truncated: boolean } {
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };
  const maxNodes = Math.max(1, Math.min(MAX_DRAW_NODES, options.maxNodes ?? MAX_DRAW_NODES));
  const degrees = new Map<string, number>();
  for (const edge of payload.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const needle = query.trim().toLowerCase();
  const eligible = payload.nodes.filter((node) => {
    const kind = node.kind || "note";
    const degree = degrees.get(node.key) ?? 0;
    if (!settings.showTags && kind === "tag") return false;
    if (!settings.showMissing && (kind === "missing" || node.exists === false)) return false;
    if (!settings.showAttachments && kind === "dependency") return false;
    if (!settings.showOrphans && degree === 0 && node.key !== currentKey) return false;
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
  const ranked = eligible.filter((node) => options.filterQuery !== true || !needle || visibleKeys.has(node.key)).map((node) => ({
    node,
    tier: node.key === currentKey ? 0
      : needle && matchedKeys.has(node.key) ? 1
        : 2,
    degree: degrees.get(node.key) ?? 0,
  })).sort((a, b) => a.tier - b.tier || b.degree - a.degree || Number(b.node.mtimeMs || 0) - Number(a.node.mtimeMs || 0) || a.node.key.localeCompare(b.node.key));
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
    if (edges.length >= MAX_DRAW_EDGES) break;
  }
  return { nodes: chosen, edges, truncated: ranked.length > chosen.length || payload.edges.length > edges.length };
}

function safeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try { return canvas.getContext("2d"); } catch { return null; }
}

export function createWorkspaceGraph(options: WorkspaceGraphOptions): WorkspaceGraph {
  let destroyed = false;
  let frame = 0;
  let worker: Worker | null = null;
  let selected: DrawNode | null = null;
  let hovered: DrawNode | null = null;
  let transform = { x: 0, y: 0, k: 1 };
  let pointer: { id: number; x: number; y: number; node: DrawNode | null; moved: boolean } | null = null;
  let spatial = new Map<string, DrawNode[]>();
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };
  let resizeObserver: ResizeObserver | null = null;

  const canvas = document.createElement("canvas");
  canvas.className = "aaronnote-workspace-graph-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Workspace knowledge graph");
  const searchResults = document.createElement("div");
  searchResults.className = "aaronnote-graph-search-results";
  searchResults.setAttribute("role", "listbox");
  searchResults.hidden = true;
  const accessible = document.createElement("div");
  accessible.className = "aaronnote-graph-accessible-nodes";
  accessible.setAttribute("aria-label", "Visible graph nodes");
  options.root.replaceChildren(canvas, searchResults, accessible);

  const rect = options.root.getBoundingClientRect();
  let width = Math.max(320, Math.round(rect.width || options.root.clientWidth || 520));
  let height = Math.max(260, Math.round(rect.height || options.root.clientHeight || 360));
  let dpr = Math.min(DPR_LIMIT, Math.max(1, window.devicePixelRatio || 1));
  function sizeCanvas(): void {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  sizeCanvas();
  const ctx = safeContext(canvas);

  const query = options.searchInput.value;
  const graph = workspaceGraphDrawPlan(options.payload, options.currentKey, query, {
    maxNodes: options.maxNodes ?? (options.mode === "preview" ? 500 : MAX_DRAW_NODES),
    settings,
    filterQuery: true,
  });
  let nodes = graph.nodes;
  let edges = graph.edges;
  clusterLayout(nodes, width, height);

  function rebuildSpatial(): void {
    const next = new Map<string, DrawNode[]>();
    for (const node of nodes) {
      const key = `${Math.floor(node.x / 32)}:${Math.floor(node.y / 32)}`;
      const bucket = next.get(key) ?? [];
      bucket.push(node);
      next.set(key, bucket);
    }
    spatial = next;
  }
  rebuildSpatial();

  const groups = [...new Map(options.payload.nodes.map((node) => [node.groupKey || node.groupLabel || "Root", node.groupLabel || node.groupKey || "Root"])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const priorGroup = options.groupInput.value;
  options.groupInput.replaceChildren(new Option("All groups", ""), ...groups.map(([key, value]) => new Option(value, key)));
  options.groupInput.value = groups.some(([key]) => key === priorGroup) ? priorGroup : "";

  function applyGroupFilter(): void {
    const group = options.groupInput.value;
    const next = workspaceGraphDrawPlan(options.payload, options.currentKey, options.searchInput.value, {
      maxNodes: options.maxNodes ?? (options.mode === "preview" ? 500 : MAX_DRAW_NODES),
      settings,
      filterQuery: true,
    });
    nodes = group ? next.nodes.filter((node) => (node.groupKey || node.groupLabel || "Root") === group) : next.nodes;
    const byKey = new Set(nodes.map((node) => node.key));
    edges = next.edges.filter((edge) => byKey.has(edge.source) && byKey.has(edge.target));
    clusterLayout(nodes, width, height);
    rebuildSpatial();
    selected = selected && byKey.has(selected.key) ? nodes.find((node) => node.key === selected!.key) ?? null : null;
    updateStatus(next.truncated);
    renderAccessibleNodes();
    startSimulation();
    requestDraw();
  }

  function updateStatus(truncated = graph.truncated): void {
    const indexed = options.payload.nodes.length;
    options.status.textContent = `${nodes.length} / ${indexed} nodes · ${edges.length} links${truncated ? " · capped" : ""}`;
  }

  function neighbors(node: DrawNode | null): Set<string> {
    const set = new Set<string>();
    if (!node) return set;
    set.add(node.key);
    for (const edge of edges) {
      if (edge.source === node.key) set.add(edge.target);
      if (edge.target === node.key) set.add(edge.source);
    }
    return set;
  }

  function draw(): void {
    frame = 0;
    if (destroyed || !ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    const active = neighbors(selected);
    const style = getComputedStyle(options.root);
    const ink = style.getPropertyValue("--aaron-ink").trim() || "#24201c";
    const muted = style.getPropertyValue("--aaron-muted").trim() || "#71809d";
    const accent = style.getPropertyValue("--aaron-accent").trim() || "#9b3827";
    const tagColor = style.getPropertyValue("--aaron-green-soft").trim() || "#8fbc8f";
    for (const edge of edges) {
      const related = !selected || active.has(edge.source) && active.has(edge.target);
      ctx.globalAlpha = related ? 0.36 : 0.055;
      ctx.strokeStyle = edge.type === "tag" ? tagColor : edge.type === "dependency" ? accent : muted;
      ctx.lineWidth = related ? 0.8 : 0.45;
      ctx.beginPath();
      ctx.moveTo(edge.sourceNode.x, edge.sourceNode.y);
      ctx.lineTo(edge.targetNode.x, edge.targetNode.y);
      ctx.stroke();
      if (settings.showArrows && edge.directed !== false && related) {
        const angle = Math.atan2(edge.targetNode.y - edge.sourceNode.y, edge.targetNode.x - edge.sourceNode.x);
        const tx = edge.targetNode.x - Math.cos(angle) * 6;
        const ty = edge.targetNode.y - Math.sin(angle) * 6;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(angle - 0.55) * 5, ty - Math.sin(angle - 0.55) * 5);
        ctx.lineTo(tx - Math.cos(angle + 0.55) * 5, ty - Math.sin(angle + 0.55) * 5);
        ctx.closePath();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
    }
    const labelCells = new Set<string>();
    const reserveLabel = (node: DrawNode, text: string): boolean => {
      const screenX = transform.x + (node.x + 7) * transform.k;
      const screenY = transform.y + (node.y - 8) * transform.k;
      const widthCells = Math.max(1, Math.ceil(text.length * 6.2 / 72));
      const cellX = Math.floor(screenX / 72);
      const cellY = Math.floor(screenY / 20);
      const keys = Array.from({ length: widthCells }, (_, index) => `${cellX + index}:${cellY}`);
      const forced = node.current || node === selected || node === hovered;
      if (!forced && keys.some((key) => labelCells.has(key))) return false;
      keys.forEach((key) => labelCells.add(key));
      return true;
    };
    const drawNodes = [...nodes].sort((a, b) => Number(a.context) - Number(b.context) || Number(b.current) - Number(a.current) || b.degree - a.degree);
    for (const node of drawNodes) {
      const related = !selected || active.has(node.key);
      ctx.globalAlpha = related ? node.context ? 0.34 : 1 : 0.1;
      ctx.fillStyle = node.current ? accent
        : node === selected ? tagColor
          : node.kind === "tag" ? tagColor
            : node.kind === "missing" ? "#b06b63" : workspaceGraphNodeColor(node, settings.colorBy) || muted;
      ctx.beginPath();
      const radius = node.current ? 6 : node === selected ? 5.5 : Math.min(6, 2.7 + Math.sqrt(Math.max(0, node.degree)) * 0.62);
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();
      const showLabel = node.current || node === selected || node === hovered || node.matched && (
        transform.k >= 2 || transform.k >= 1.25 && node.degree >= 2 || nodes.length <= 80 && transform.k >= 1.05
      );
      const nodeLabel = label(node).slice(0, 42);
      if (showLabel && reserveLabel(node, nodeLabel)) {
        ctx.fillStyle = ink;
        ctx.font = `${Math.max(9, 11 / transform.k)}px system-ui`;
        ctx.fillText(nodeLabel, node.x + 7, node.y + 4);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function requestDraw(): void {
    if (!frame && !destroyed) frame = window.requestAnimationFrame(draw);
  }

  function graphPoint(event: PointerEvent | MouseEvent | WheelEvent): { x: number; y: number } {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - transform.x) / transform.k,
      y: (event.clientY - bounds.top - transform.y) / transform.k,
    };
  }

  function hitNode(event: PointerEvent | MouseEvent): DrawNode | null {
    const point = graphPoint(event);
    const radius = 10 / transform.k;
    let best: DrawNode | null = null;
    let bestDistance = radius * radius;
    const cellX = Math.floor(point.x / 32);
    const cellY = Math.floor(point.y / 32);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const node of spatial.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
          const distance = (node.x - point.x) ** 2 + (node.y - point.y) ** 2;
          if (distance <= bestDistance) { best = node; bestDistance = distance; }
        }
      }
    }
    return best;
  }

  function showDetail(node: DrawNode | null): void {
    selected = node;
    options.detail.replaceChildren();
    options.detail.hidden = !node;
    if (!node) { requestDraw(); return; }
    const inbound = edges.filter((edge) => edge.target === node.key).length;
    const outbound = edges.filter((edge) => edge.source === node.key).length;
    const title = document.createElement("strong");
    title.textContent = label(node);
    const stats = document.createElement("span");
    stats.textContent = `${inbound} inbound · ${outbound} outbound`;
    const tags = document.createElement("span");
    tags.textContent = (node.tags ?? []).map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
    options.detail.append(title, stats, tags);
    requestDraw();
  }

  function renderSearch(): void {
    const needle = options.searchInput.value.trim();
    searchResults.replaceChildren();
    if (!needle) { searchResults.hidden = true; return; }
    const degree = new Map<string, number>();
    for (const edge of options.payload.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const matches = options.payload.nodes
      .filter((node) => workspaceGraphNodeMatches(node, needle, degree.get(node.key) ?? 0))
      .slice(0, SEARCH_LIMIT);
    for (const node of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.textContent = `${label(node)}${node.path ? ` · ${node.path}` : ""}`;
      button.addEventListener("click", () => {
        const visible = nodes.find((candidate) => candidate.key === node.key);
        if (visible) {
          transform.x = width / 2 - visible.x * transform.k;
          transform.y = height / 2 - visible.y * transform.k;
          showDetail(visible);
        }
        searchResults.hidden = true;
      });
      searchResults.append(button);
    }
    searchResults.hidden = matches.length === 0;
  }

  function renderAccessibleNodes(): void {
    accessible.replaceChildren();
    for (const node of nodes.slice(0, 250)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label(node);
      button.addEventListener("click", () => showDetail(node));
      button.addEventListener("dblclick", () => options.openNode(node));
      accessible.append(button);
    }
  }

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const before = graphPoint(event);
    const next = Math.max(0.3, Math.min(4, transform.k * Math.exp(-event.deltaY * 0.0015)));
    const bounds = canvas.getBoundingClientRect();
    transform.k = next;
    transform.x = event.clientX - bounds.left - before.x * next;
    transform.y = event.clientY - bounds.top - before.y * next;
    requestDraw();
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, node: hitNode(event), moved: false };
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer) { hovered = hitNode(event); requestDraw(); return; }
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true;
    if (pointer.node) {
      const point = graphPoint(event);
      pointer.node.x = point.x;
      pointer.node.y = point.y;
    } else {
      transform.x += dx;
      transform.y += dy;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    requestDraw();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!pointer) return;
    canvas.releasePointerCapture?.(pointer.id);
    if (!pointer.moved) showDetail(pointer.node ?? hitNode(event));
    else if (pointer.node) { rebuildSpatial(); startSimulation(); }
    pointer = null;
  });
  canvas.addEventListener("dblclick", (event) => {
    const node = hitNode(event);
    if (node) options.openNode(node, { newWindow: event.metaKey || event.altKey });
  });

  const onSearch = (): void => { renderSearch(); applyGroupFilter(); };
  const onGroup = (): void => applyGroupFilter();
  options.searchInput.addEventListener("input", onSearch);
  options.groupInput.addEventListener("change", onGroup);

  function startSimulation(): void {
    worker?.terminate();
    worker = null;
    if (nodes.length > 1_500 || typeof Worker === "undefined") return;
    try {
      const instance = new Worker(new URL("./workspace-graph-layout.worker.ts", import.meta.url), { type: "module" });
      worker = instance;
      const timer = window.setTimeout(() => {
        instance.terminate();
        if (worker === instance) worker = null;
      }, 2_000);
      instance.addEventListener("message", (event: MessageEvent<{ done?: boolean; positions?: Array<{ key: string; x: number; y: number }> }>) => {
        if (worker !== instance) return;
        const positions = new Map((event.data.positions ?? []).map((position) => [position.key, position]));
        for (const node of nodes) {
          const position = positions.get(node.key);
          if (position) { node.x = position.x; node.y = position.y; }
        }
        rebuildSpatial();
        if (event.data.done) {
          window.clearTimeout(timer);
          instance.terminate();
          worker = null;
        }
        requestDraw();
      });
      instance.postMessage({
        width,
        height,
        nodes: nodes.map((node) => ({ key: node.key, x: node.x, y: node.y, current: node.current })),
        edges: edges.map((edge) => ({ source: edge.source, target: edge.target })),
        maxTicks: 240,
      });
    } catch { worker?.terminate(); worker = null; }
  }
  startSimulation();

  updateStatus();
  renderAccessibleNodes();
  requestDraw();

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      const next = options.root.getBoundingClientRect();
      const nextWidth = Math.max(320, Math.round(next.width || options.root.clientWidth || width));
      const nextHeight = Math.max(260, Math.round(next.height || options.root.clientHeight || height));
      if (nextWidth === width && nextHeight === height) return;
      const sx = nextWidth / width;
      const sy = nextHeight / height;
      width = nextWidth;
      height = nextHeight;
      dpr = Math.min(DPR_LIMIT, Math.max(1, window.devicePixelRatio || 1));
      for (const node of nodes) { node.x *= sx; node.y *= sy; }
      transform.x *= sx;
      transform.y *= sy;
      sizeCanvas();
      rebuildSpatial();
      startSimulation();
      requestDraw();
    });
    resizeObserver.observe(options.root);
  }

  return {
    destroy() {
      destroyed = true;
      if (frame) window.cancelAnimationFrame(frame);
      worker?.terminate();
      worker = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      options.searchInput.removeEventListener("input", onSearch);
      options.groupInput.removeEventListener("change", onGroup);
      options.detail.replaceChildren();
      options.detail.hidden = true;
      options.root.replaceChildren();
    },
  };
}
