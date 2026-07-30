import type { GraphEdge, GraphNode, GraphPayload } from "./types.ts";

export type WorkspaceGraphOptions = {
  root: HTMLElement;
  status: HTMLElement;
  detail: HTMLElement;
  searchInput: HTMLInputElement;
  groupInput: HTMLSelectElement;
  payload: GraphPayload;
  currentKey: string;
  openNode: (node: GraphNode, options?: { newWindow?: boolean }) => void;
};

export type WorkspaceGraph = { destroy: () => void };

type DrawNode = GraphNode & { x: number; y: number; degree: number; current: boolean };
type DrawEdge = GraphEdge & { sourceNode: DrawNode; targetNode: DrawNode };

const MAX_DRAW_NODES = 10_000;
const MAX_DRAW_EDGES = 25_000;
const SEARCH_LIMIT = 50;
const DPR_LIMIT = 2;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function label(node: GraphNode): string {
  return node.title || node.id || node.path || node.key;
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

export function workspaceGraphDrawPlan(payload: GraphPayload, currentKey: string, query: string): { nodes: DrawNode[]; edges: DrawEdge[]; truncated: boolean } {
  const degrees = new Map<string, number>();
  for (const edge of payload.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const needle = query.trim().toLowerCase();
  const ranked = payload.nodes.map((node) => ({
    node,
    tier: node.key === currentKey ? 0
      : needle && [label(node), node.path, ...(node.aliases ?? []), ...(node.tags ?? [])].join(" ").toLowerCase().includes(needle) ? 1
        : 2,
    degree: degrees.get(node.key) ?? 0,
  })).sort((a, b) => a.tier - b.tier || b.degree - a.degree || a.node.key.localeCompare(b.node.key));
  const chosen = ranked.slice(0, MAX_DRAW_NODES).map(({ node }) => ({
    ...node,
    x: 0,
    y: 0,
    degree: degrees.get(node.key) ?? 0,
    current: node.key === currentKey,
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
  return { nodes: chosen, edges, truncated: payload.nodes.length > chosen.length || payload.edges.length > edges.length };
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
  const width = Math.max(320, Math.round(rect.width || options.root.clientWidth || 520));
  const height = Math.max(260, Math.round(rect.height || options.root.clientHeight || 360));
  const dpr = Math.min(DPR_LIMIT, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = safeContext(canvas);

  const query = options.searchInput.value;
  const graph = workspaceGraphDrawPlan(options.payload, options.currentKey, query);
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
    const next = workspaceGraphDrawPlan(options.payload, options.currentKey, options.searchInput.value);
    nodes = group ? next.nodes.filter((node) => (node.groupKey || node.groupLabel || "Root") === group) : next.nodes;
    const byKey = new Set(nodes.map((node) => node.key));
    edges = next.edges.filter((edge) => byKey.has(edge.source) && byKey.has(edge.target));
    clusterLayout(nodes, width, height);
    rebuildSpatial();
    selected = selected && byKey.has(selected.key) ? nodes.find((node) => node.key === selected!.key) ?? null : null;
    updateStatus(next.truncated);
    renderAccessibleNodes();
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
    for (const edge of edges) {
      const related = !selected || active.has(edge.source) && active.has(edge.target);
      ctx.globalAlpha = related ? 0.36 : 0.055;
      ctx.strokeStyle = edge.type === "tag" ? "#d4b34f" : "#71809d";
      ctx.lineWidth = related ? 0.8 : 0.45;
      ctx.beginPath();
      ctx.moveTo(edge.sourceNode.x, edge.sourceNode.y);
      ctx.lineTo(edge.targetNode.x, edge.targetNode.y);
      ctx.stroke();
    }
    for (const node of nodes) {
      const related = !selected || active.has(node.key);
      ctx.globalAlpha = related ? 1 : 0.12;
      ctx.fillStyle = node.current ? "#ff9bad" : node === selected ? "#9de7ff" : "#8e98b2";
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.current ? 5.5 : node === selected ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      if (node.current || node === selected || node === hovered || transform.k >= 1.2) {
        ctx.fillStyle = "#d9dfeb";
        ctx.font = `${Math.max(9, 11 / transform.k)}px system-ui`;
        ctx.fillText(label(node).slice(0, 36), node.x + 7, node.y + 4);
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
    const needle = options.searchInput.value.trim().toLowerCase();
    searchResults.replaceChildren();
    if (!needle) { searchResults.hidden = true; return; }
    const matches = options.payload.nodes.filter((node) =>
      [label(node), node.path, ...(node.aliases ?? []), ...(node.tags ?? [])].join(" ").toLowerCase().includes(needle)).slice(0, SEARCH_LIMIT);
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
    else if (pointer.node) rebuildSpatial();
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

  if (nodes.length <= 1_500 && typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./workspace-graph-layout.worker.ts", import.meta.url), { type: "module" });
      const timer = window.setTimeout(() => { worker?.terminate(); worker = null; }, 2_000);
      worker.addEventListener("message", (event: MessageEvent<{ positions?: Array<{ key: string; x: number; y: number }> }>) => {
        window.clearTimeout(timer);
        const positions = new Map((event.data.positions ?? []).map((position) => [position.key, position]));
        for (const node of nodes) {
          const position = positions.get(node.key);
          if (position) { node.x = position.x; node.y = position.y; }
        }
        rebuildSpatial();
        worker?.terminate();
        worker = null;
        requestDraw();
      });
      worker.postMessage({
        width,
        height,
        nodes: nodes.map((node) => ({ key: node.key, x: node.x, y: node.y, current: node.current })),
        edges: edges.map((edge) => ({ source: edge.source, target: edge.target })),
        maxTicks: 240,
      });
    } catch { worker?.terminate(); worker = null; }
  }

  updateStatus();
  renderAccessibleNodes();
  requestDraw();

  return {
    destroy() {
      destroyed = true;
      if (frame) window.cancelAnimationFrame(frame);
      worker?.terminate();
      worker = null;
      options.searchInput.removeEventListener("input", onSearch);
      options.groupInput.removeEventListener("change", onGroup);
      options.detail.replaceChildren();
      options.detail.hidden = true;
      options.root.replaceChildren();
    },
  };
}
