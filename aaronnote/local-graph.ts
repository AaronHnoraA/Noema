import type { GraphNode, GraphPayload, NoteSummary } from "./types.ts";
import type { WorkspaceGraph } from "./workspace-graph.ts";
import { parseSimpleFrontmatter, simpleFrontmatterStrings } from "../src/simple-frontmatter.ts";
import { CoalescedTimer } from "../src/coalesced-timer.ts";

type OpenNoteOptions = { newWindow?: boolean };

type LocalGraphPanelOptions = {
  root: HTMLElement;
  toggleButton: HTMLButtonElement;
  depthInput: HTMLInputElement;
  depthLabel: HTMLElement;
  refsInput: HTMLInputElement;
  backlinksInput: HTMLInputElement;
  tagsInput: HTMLInputElement;
  canvas: HTMLElement;
  status: HTMLElement;
  searchInput?: HTMLInputElement;
  groupInput?: HTMLSelectElement;
  detail?: HTMLElement;
  modeButtons?: HTMLButtonElement[];
  getWorkspaceGraph?: () => Promise<GraphPayload>;
  getIndexVersion?: () => number;
  getNotes: () => NoteSummary[];
  getCurrentNote: () => NoteSummary | undefined;
  getMarkdown: () => string;
  resolveNoteRef: (ref: string) => NoteSummary | undefined;
  openNote: (note: NoteSummary, options?: OpenNoteOptions) => void;
  openTag: (tag: string) => void;
};

export type LocalGraphPanel = {
  toggle: () => void;
  collapse: () => void;
  update: (force?: boolean) => void;
  invalidate: () => void;
};

type LocalNode = {
  id: string;
  label: string;
  type: "current" | "note" | "tag";
  depth: number;
  note?: NoteSummary;
  tag?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
};

type LocalLink = {
  id: string;
  source: string;
  target: string;
  type: "ref" | "backlink" | "tag";
};

const MAX_LOCAL_GRAPH_NODES = 72;
const MAX_LOCAL_GRAPH_LINKS = 160;
const LOCAL_GRAPH_MIN_ZOOM = 0.45;
const LOCAL_GRAPH_MAX_ZOOM = 2.8;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function noteKey(note: NoteSummary | undefined): string {
  return note?.key || note?.id || note?.path || note?.file || note?.title || "";
}

function displayTitle(note: NoteSummary): string {
  return note.title || note.id || note.path || note.file || "Untitled";
}

function normalizeLookup(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^roam:\/\//i, "")
    .replace(/^#/, "")
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(item);
  }
  return out;
}

function cleanTags(tags: readonly unknown[]): string[] {
  return unique(tags
    .map((tag) => String(tag || "").trim().replace(/^#/, ""))
    .filter(Boolean), (tag) => tag.toLowerCase());
}

function roamTags(note: NoteSummary | undefined): string[] {
  return cleanTags(note?.tags ?? []);
}

function parseMetaListValue(value: string): string[] {
  const trimmed = String(value || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("(")) {
    return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => String(match[1] || "").replace(/\\"/g, "\"").replace(/\\\\/g, "\\"))
      .filter(Boolean);
  }
  return trimmed.split(/[, ]+/).map((item) => item.trim()).filter(Boolean);
}

function tagsFromMetaLines(raw: string): string[] | null {
  const tags: string[] = [];
  let sawTags = false;
  let currentList = "";
  for (const rawLine of String(raw || "").split(/\r?\n/)) {
    const item = rawLine.match(/^\s*-\s*(.+?)\s*$/);
    if (item && currentList === "tags") {
      tags.push(item[1] || "");
      continue;
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) {
      if (currentList === "tags") break;
      continue;
    }
    const key = String(pair[1] || "").toLowerCase();
    const value = String(pair[2] || "").trim();
    currentList = value ? "" : key;
    if (key !== "tags") continue;
    sawTags = true;
    tags.push(...parseMetaListValue(value));
  }
  return sawTags ? cleanTags(tags) : null;
}

function markdownRoamTags(markdown: string): string[] | null {
  const text = String(markdown || "");
  const metaBlock = text.match(/^\s*#\+begin\s+meta\s*\r?\n([\s\S]*?)\r?\n\s*#\+end\s+meta\s*$/im);
  if (metaBlock) return tagsFromMetaLines(metaBlock[1] || "");
  const frontMatter = parseSimpleFrontmatter(text);
  return frontMatter ? cleanTags(simpleFrontmatterStrings(frontMatter, "tags")) : null;
}

function currentRoamTags(note: NoteSummary | undefined, markdown: string): string[] {
  const tags = markdownRoamTags(markdown);
  return tags ?? roamTags(note);
}

function tagKey(tag: string): string {
  return String(tag || "").trim().replace(/^#/, "").toLowerCase();
}

function tagNodeId(tag: string): string {
  return `tag:${tagKey(tag)}`;
}

function markdownRefs(markdown: string): string[] {
  const refs: string[] = [];
  const text = String(markdown || "");
  const wiki = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wiki.exec(text)) !== null) {
    const ref = String(match[1] || "").split("|", 1)[0]!.split("#", 1)[0]!.trim();
    if (ref) refs.push(ref);
  }
  const roam = /roam:\/\/([^\s)\]'"<>]+)/gi;
  while ((match = roam.exec(text)) !== null) {
    const ref = safeDecode(String(match[1] || "").split(/[?#@]/, 1)[0] || "").trim();
    if (ref) refs.push(ref);
  }
  const markdownLink = /\[[^\]\n]*\]\(([^)\s]+(?:\.md|\.markdown|\.typ)(?:#[^)]+)?)\)/gi;
  while ((match = markdownLink.exec(text)) !== null) {
    const ref = String(match[1] || "").split("#", 1)[0]!.trim();
    if (ref) refs.push(ref);
  }
  return unique(refs, normalizeLookup);
}

function labelFit(label: string, max = 22): string {
  const text = String(label || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(4, max - 1))}…`;
}

function seededPosition(index: number, depth: number, width: number, height: number): { x: number; y: number } {
  if (depth === 0) return { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) * (depth === 1 ? 0.27 : 0.41);
  const angle = index * 2.399963229728653 + depth * 0.7;
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

function nodeIdentifiers(note: NoteSummary): string[] {
  return [
    note.key,
    note.id,
    note.title,
    note.file,
    note.path,
    ...(note.aliases ?? []),
  ].map((value) => String(value || "")).filter(Boolean);
}

function resolveRef(ref: string, notesByLookup: Map<string, NoteSummary>, resolveNoteRef: (ref: string) => NoteSummary | undefined): NoteSummary | undefined {
  return resolveNoteRef(ref) || notesByLookup.get(normalizeLookup(ref));
}

function buildLookup(notes: NoteSummary[]): Map<string, NoteSummary> {
  const lookup = new Map<string, NoteSummary>();
  for (const note of notes) {
    for (const id of nodeIdentifiers(note)) {
      const key = normalizeLookup(id);
      if (key && !lookup.has(key)) lookup.set(key, note);
    }
  }
  return lookup;
}

export function createLocalGraphPanel(options: LocalGraphPanelOptions): LocalGraphPanel {
  let renderKey = "";
  const resizeTimer = new CoalescedTimer(40);
  let expandedOnce = false;
  let mode: "local" | "workspace" = "local";
  let workspaceGraph: WorkspaceGraph | null = null;
  let workspacePayload: GraphPayload | null = null;
  let workspaceRequest = 0;
  const searchInput = options.searchInput ?? document.createElement("input");
  const groupInput = options.groupInput ?? document.createElement("select");
  const detail = options.detail ?? document.createElement("div");

  function isCollapsed(): boolean {
    return options.root.classList.contains("is-collapsed");
  }

  function settings(): { depth: number; refs: boolean; backlinks: boolean; tags: boolean } {
    const depth = Math.max(1, Math.min(2, Number(options.depthInput.value) || 1));
    return {
      depth,
      refs: options.refsInput.checked,
      backlinks: options.backlinksInput.checked,
      tags: options.tagsInput.checked,
    };
  }

  function clearGraph(): void {
    resizeTimer.cancel();
    workspaceRequest += 1;
    workspaceGraph?.destroy();
    workspaceGraph = null;
    options.canvas.replaceChildren();
  }

  function currentKey(): string {
    return noteKey(options.getCurrentNote());
  }

  function withCurrentOverlay(payload: GraphPayload): GraphPayload {
    const current = options.getCurrentNote();
    const key = noteKey(current);
    if (!current || !key) return payload;
    const nodes = payload.nodes.map((node) => node.key === key
      ? { ...node, tags: currentRoamTags(current, options.getMarkdown()) }
      : { ...node });
    const edges = payload.edges.map((edge) => ({ ...edge, type: edge.type ?? "ref" as const }));
    const seen = new Set(edges.map((edge) => `${edge.source}\0${edge.target}\0${edge.type || "ref"}`));
    for (const ref of markdownRefs(options.getMarkdown())) {
      const target = options.resolveNoteRef(ref);
      const targetKey = noteKey(target);
      const edgeKey = `${key}\0${targetKey}\0ref`;
      if (!targetKey || targetKey === key || seen.has(edgeKey)) continue;
      edges.push({ source: key, target: targetKey, type: "ref" });
      seen.add(edgeKey);
    }
    return { ...payload, nodes, edges };
  }

  async function renderWorkspaceGraph(): Promise<void> {
    const request = ++workspaceRequest;
    workspaceGraph?.destroy();
    workspaceGraph = null;
    options.canvas.replaceChildren();
    options.status.textContent = "Loading workspace graph…";
    if (!options.getWorkspaceGraph) {
      options.status.textContent = "Workspace graph API unavailable";
      return;
    }
    try {
      const expectedVersion = options.getIndexVersion?.() ?? 0;
      if (!workspacePayload || (expectedVersion > 0 && workspacePayload.indexVersion !== expectedVersion)) {
        workspacePayload = await options.getWorkspaceGraph();
      }
      if (request !== workspaceRequest || isCollapsed() || mode !== "workspace") return;
      const module = await import("./workspace-graph.ts");
      if (request !== workspaceRequest || isCollapsed() || mode !== "workspace") return;
      workspaceGraph = module.createWorkspaceGraph({
        root: options.canvas,
        status: options.status,
        detail,
        searchInput,
        groupInput,
        payload: withCurrentOverlay(workspacePayload),
        currentKey: currentKey(),
        openNode: (node: GraphNode, openOptions) => {
          const note = options.getNotes().find((candidate) => noteKey(candidate) === node.key)
            ?? options.resolveNoteRef(node.key);
          if (note) options.openNote(note, openOptions);
        },
      });
    } catch (error) {
      if (request !== workspaceRequest) return;
      options.status.textContent = error instanceof Error ? error.message : "Workspace graph failed";
    }
  }

  function noteSignature(note: NoteSummary | undefined): string {
    if (!note) return "";
    return [
      noteKey(note),
      displayTitle(note),
      (note.refs ?? []).join(","),
      (note.backlinks ?? []).join(","),
      roamTags(note).join(","),
    ].join("\t");
  }

  function dataSignature(): string {
    const config = settings();
    const current = options.getCurrentNote();
    return [
      noteKey(current),
      config.depth,
      config.refs ? "refs" : "",
      config.backlinks ? "backlinks" : "",
      config.tags ? "tags" : "",
      noteSignature(current),
      options.getNotes().map(noteSignature).join("\n"),
      expandedOnce ? options.getMarkdown().length : "",
    ].join("\n");
  }

  function buildGraph(width: number, height: number): { nodes: LocalNode[]; links: LocalLink[]; truncated: boolean } {
    const config = settings();
    const current = options.getCurrentNote();
    if (!current) return { nodes: [], links: [], truncated: false };

    const notes = unique([current, ...options.getNotes()], (note) => noteKey(note));
    const byLookup = buildLookup(notes);
    const currentKey = noteKey(current);
    const currentTags = currentRoamTags(current, options.getMarkdown());
    const outgoing = new Map<string, NoteSummary[]>();
    const incoming = new Map<string, NoteSummary[]>();
    const tagsByNote = new Map<string, string[]>();
    const tagNotes = new Map<string, NoteSummary[]>();
    const tagLabels = new Map<string, string>();
    const tagNeighbors = new Map<string, Map<string, string>>();
    const markdownOut = markdownRefs(options.getMarkdown());

    for (const note of notes) {
      const key = noteKey(note);
      if (!key) continue;
      const refs = key === currentKey ? unique([...(note.refs ?? []), ...markdownOut], normalizeLookup) : note.refs ?? [];
      const resolved = unique(refs
        .map((ref) => resolveRef(ref, byLookup, options.resolveNoteRef))
        .filter((target): target is NoteSummary => Boolean(target && noteKey(target) && noteKey(target) !== key)), noteKey);
      outgoing.set(key, resolved);
      const tags = key === currentKey ? currentTags : roamTags(note);
      tagsByNote.set(key, tags);
      for (const tag of tags) {
        const lower = tagKey(tag);
        if (!lower) continue;
        if (!tagLabels.has(lower)) tagLabels.set(lower, tag);
        const tagged = tagNotes.get(lower) ?? [];
        tagged.push(note);
        tagNotes.set(lower, unique(tagged, noteKey));
      }
      for (let i = 0; i < tags.length; i += 1) {
        for (let j = i + 1; j < tags.length; j += 1) {
          const a = tagKey(tags[i] || "");
          const b = tagKey(tags[j] || "");
          if (!a || !b || a === b) continue;
          const aNeighbors = tagNeighbors.get(a) ?? new Map<string, string>();
          const bNeighbors = tagNeighbors.get(b) ?? new Map<string, string>();
          aNeighbors.set(b, tagLabels.get(b) || tags[j] || b);
          bNeighbors.set(a, tagLabels.get(a) || tags[i] || a);
          tagNeighbors.set(a, aNeighbors);
          tagNeighbors.set(b, bNeighbors);
        }
      }
    }

    for (const note of notes) {
      const key = noteKey(note);
      if (!key) continue;
      for (const target of outgoing.get(key) ?? []) {
        const targetKey = noteKey(target);
        if (!targetKey) continue;
        const list = incoming.get(targetKey) ?? [];
        list.push(note);
        incoming.set(targetKey, unique(list, noteKey));
      }
      for (const ref of note.backlinks ?? []) {
        const source = resolveRef(ref, byLookup, options.resolveNoteRef);
        if (!source || noteKey(source) === key) continue;
        const list = incoming.get(key) ?? [];
        list.push(source);
        incoming.set(key, unique(list, noteKey));
      }
    }

    const nodes = new Map<string, LocalNode>();
    const links = new Map<string, LocalLink>();
    let index = 0;
    let truncated = false;

    function addNote(note: NoteSummary, depth: number, type: "current" | "note" = "note"): boolean {
      const id = noteKey(note);
      if (!id) return false;
      const existing = nodes.get(id);
      if (existing) {
        existing.depth = Math.min(existing.depth, depth);
        if (type === "current") existing.type = "current";
        return true;
      }
      if (nodes.size >= MAX_LOCAL_GRAPH_NODES) {
        truncated = true;
        return false;
      }
      const pos = seededPosition(index++, depth, width, height);
      nodes.set(id, {
        id,
        label: displayTitle(note),
        type,
        depth,
        note,
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
      });
      return true;
    }

    function addTag(tag: string, depth: number): boolean {
      const clean = String(tag || "").trim().replace(/^#/, "");
      if (!clean) return false;
      const id = tagNodeId(clean);
      if (nodes.has(id)) {
        nodes.get(id)!.depth = Math.min(nodes.get(id)!.depth, depth);
        return true;
      }
      if (nodes.size >= MAX_LOCAL_GRAPH_NODES) {
        truncated = true;
        return false;
      }
      const pos = seededPosition(index++, depth, width, height);
      nodes.set(id, {
        id,
        label: `#${clean}`,
        type: "tag",
        tag: clean,
        depth,
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
      });
      return true;
    }

    function addLink(source: string, target: string, type: LocalLink["type"]): void {
      if (!source || !target || source === target) return;
      if (type === "tag" && source.startsWith("tag:") && target.startsWith("tag:") && source > target) {
        [source, target] = [target, source];
      }
      if (links.size >= MAX_LOCAL_GRAPH_LINKS) {
        truncated = true;
        return;
      }
      const id = `${source}\n${target}\n${type}`;
      if (!links.has(id)) links.set(id, { id, source, target, type });
    }

    addNote(current, 0, "current");
    const queue: Array<{ note: NoteSummary; depth: number }> = [{ note: current, depth: 0 }];
    const expanded = new Set<string>();

    while (queue.length > 0) {
      const item = queue.shift()!;
      const key = noteKey(item.note);
      if (!key || expanded.has(`${key}:${item.depth}`) || item.depth >= config.depth) continue;
      expanded.add(`${key}:${item.depth}`);
      const nextDepth = item.depth + 1;

      if (config.refs) {
        for (const target of outgoing.get(key) ?? []) {
          const targetKey = noteKey(target);
          if (!addNote(target, nextDepth) || !targetKey) continue;
          addLink(key, targetKey, "ref");
          if (nextDepth < config.depth) queue.push({ note: target, depth: nextDepth });
        }
      }

      if (config.backlinks) {
        for (const source of incoming.get(key) ?? []) {
          const sourceKey = noteKey(source);
          if (!addNote(source, nextDepth) || !sourceKey) continue;
          addLink(sourceKey, key, "backlink");
          if (nextDepth < config.depth) queue.push({ note: source, depth: nextDepth });
        }
      }

      if (config.tags) {
        for (const tag of tagsByNote.get(key) ?? []) {
          const tagId = tagNodeId(tag);
          if (!addTag(tag, nextDepth)) continue;
          addLink(key, tagId, "tag");
          const coTags = tagsByNote.get(key) ?? [];
          for (const coTag of coTags) {
            const coTagId = tagNodeId(coTag);
            if (coTagId === tagId || !nodes.has(coTagId)) continue;
            addLink(tagId, coTagId, "tag");
          }
          if (nextDepth >= config.depth) continue;
          const lower = tagKey(tag);
          for (const relatedTag of tagNeighbors.get(lower)?.values() ?? []) {
            const relatedTagId = tagNodeId(relatedTag);
            if (!addTag(relatedTag, nextDepth + 1)) continue;
            addLink(tagId, relatedTagId, "tag");
          }
          for (const taggedNote of tagNotes.get(lower) ?? []) {
            const taggedKey = noteKey(taggedNote);
            if (!taggedKey || taggedKey === key) continue;
            if (!addNote(taggedNote, nextDepth + 1)) continue;
            addLink(tagId, taggedKey, "tag");
          }
        }
      }
    }

    return { nodes: [...nodes.values()], links: [...links.values()], truncated };
  }

  function renderGraph(): void {
    clearGraph();
    if (mode === "workspace") {
      void renderWorkspaceGraph();
      return;
    }
    const rect = options.canvas.getBoundingClientRect();
    const width = Math.max(300, Math.round(rect.width || options.canvas.clientWidth || 360));
    const height = Math.max(240, Math.round(rect.height || options.canvas.clientHeight || 260));
    const graph = buildGraph(width, height);
    const { nodes, links } = graph;
    if (nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-local-graph-empty";
      empty.textContent = "No local graph";
      options.canvas.replaceChildren(empty);
      options.status.textContent = "";
      return;
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Local graph");
    svg.classList.add("aaronnote-local-graph-svg");

    const viewportLayer = document.createElementNS(svg.namespaceURI, "g") as SVGGElement;
    viewportLayer.classList.add("aaronnote-local-graph-viewport");
    const linkLayer = document.createElementNS(svg.namespaceURI, "g") as SVGGElement;
    linkLayer.classList.add("aaronnote-local-graph-links");
    const nodeLayer = document.createElementNS(svg.namespaceURI, "g") as SVGGElement;
    nodeLayer.classList.add("aaronnote-local-graph-nodes");
    viewportLayer.append(linkLayer, nodeLayer);
    svg.append(viewportLayer);
    options.canvas.replaceChildren(svg);

    let zoom = { x: 0, y: 0, k: 1 };

    function pointIn(element: SVGGraphicsElement, event: MouseEvent | PointerEvent | WheelEvent): DOMPoint | null {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const matrix = element.getScreenCTM();
      return matrix ? point.matrixTransform(matrix.inverse()) : null;
    }

    function applyViewportTransform(): void {
      viewportLayer.setAttribute(
        "transform",
        `translate(${zoom.x.toFixed(2)} ${zoom.y.toFixed(2)}) scale(${zoom.k.toFixed(3)})`,
      );
    }

    function wheelDeltaPixels(event: WheelEvent): number {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 320;
      return event.deltaY;
    }

    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const svgPoint = pointIn(svg, event);
      const graphPoint = pointIn(viewportLayer, event);
      if (!svgPoint || !graphPoint) return;
      const factor = Math.exp(-wheelDeltaPixels(event) * 0.0015);
      const nextK = clampNumber(zoom.k * factor, LOCAL_GRAPH_MIN_ZOOM, LOCAL_GRAPH_MAX_ZOOM);
      zoom = {
        k: nextK,
        x: svgPoint.x - graphPoint.x * nextK,
        y: svgPoint.y - graphPoint.y * nextK,
      };
      applyViewportTransform();
    }, { passive: false });

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const linkEls = links.map((link) => {
      const line = document.createElementNS(svg.namespaceURI, "line") as SVGLineElement;
      line.classList.add("aaronnote-local-graph-link", `is-${link.type}`);
      line.dataset.linkType = link.type;
      line.setAttribute("stroke-linecap", "round");
      linkLayer.appendChild(line);
      return { link, line };
    });

    let dragNode: LocalNode | null = null;
    let dragMoved = false;
    let selectedNodeId = "";

    function selectNode(node: LocalNode): void {
      selectedNodeId = node.id;
      const neighborIds = new Set<string>([node.id]);
      for (const { link } of linkEls) {
        if (link.source === node.id) neighborIds.add(link.target);
        if (link.target === node.id) neighborIds.add(link.source);
      }
      for (const { node: candidate, group } of nodeEls) {
        group.classList.toggle("is-selected", candidate.id === node.id);
        group.classList.toggle("is-dimmed", !neighborIds.has(candidate.id));
      }
      for (const { link, line } of linkEls) {
        const related = link.source === node.id || link.target === node.id;
        line.classList.toggle("is-selected", related);
        line.classList.toggle("is-dimmed", !related);
      }
      options.status.textContent = `${nodes.length} nodes · ${links.length} links · ${node.label}${graph.truncated ? " · capped" : ""}`;
    }

    const nodeEls = nodes.map((node) => {
      const group = document.createElementNS(svg.namespaceURI, "g") as SVGGElement;
      group.classList.add("aaronnote-local-graph-node", `is-${node.type}`, `depth-${Math.min(2, node.depth)}`);
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", node.label);
      const circle = document.createElementNS(svg.namespaceURI, "circle") as SVGCircleElement;
      circle.setAttribute("r", node.type === "current" ? "9" : node.type === "tag" ? "5.5" : "7");
      const text = document.createElementNS(svg.namespaceURI, "text") as SVGTextElement;
      text.textContent = labelFit(node.label);
      text.setAttribute("y", node.type === "tag" ? "17" : "20");
      group.append(circle, text);
      group.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        dragNode = node;
        dragMoved = false;
        node.fx = node.x;
        node.fy = node.y;
        group.setPointerCapture(event.pointerId);
      });
      group.addEventListener("pointermove", (event) => {
        if (dragNode !== node) return;
        const local = pointIn(viewportLayer, event);
        if (!local) return;
        if (Math.abs(local.x - node.x) + Math.abs(local.y - node.y) > 3) dragMoved = true;
        node.fx = Math.max(14, Math.min(width - 14, local.x));
        node.fy = Math.max(14, Math.min(height - 22, local.y));
        node.x = node.fx;
        node.y = node.fy;
        applyPositions();
      });
      group.addEventListener("pointerup", (event) => {
        if (dragNode !== node) return;
        group.releasePointerCapture(event.pointerId);
        dragNode = null;
        if (!dragMoved) { node.fx = undefined; node.fy = undefined; }
      });
      group.addEventListener("click", (event) => {
        if (dragMoved) return;
        event.preventDefault();
        selectNode(node);
      });
      group.addEventListener("dblclick", (event) => {
        if (node.type === "tag" && node.tag) {
          options.openTag(node.tag);
          return;
        }
        if (node.note?.file) options.openNote(node.note, { newWindow: event.metaKey || event.altKey });
      });
      group.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (selectedNodeId !== node.id) { selectNode(node); return; }
        if (node.type === "tag" && node.tag) options.openTag(node.tag);
        else if (node.note?.file) options.openNote(node.note);
      });
      group.addEventListener("auxclick", (event) => {
        if (event.button !== 1 || !node.note?.file) return;
        event.preventDefault();
        options.openNote(node.note, { newWindow: true });
      });
      nodeLayer.appendChild(group);
      return { node, group };
    });

    function applyPositions(): void {
      for (const { link, line } of linkEls) {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (!source || !target) continue;
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x));
        line.setAttribute("y2", String(target.y));
      }
      for (const { node, group } of nodeEls) {
        group.setAttribute("transform", `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
      }
    }

    function runSimulation(ticks: number): void {
      for (let tick = 0; tick < ticks; tick += 1) {
        if (isCollapsed()) return;
        const alpha = Math.max(0.018, 0.13 * (1 - tick / 120));
        for (const { link } of linkEls) {
          const source = nodeMap.get(link.source);
          const target = nodeMap.get(link.target);
          if (!source || !target) continue;
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const desired = link.type === "tag" ? 64 : 92;
          const strength = (distance - desired) / distance * (link.type === "tag" ? 0.018 : 0.024) * alpha;
          const fx = dx * strength;
          const fy = dy * strength;
          if (source.fx == null) {
            source.vx += fx;
            source.vy += fy;
          }
          if (target.fx == null) {
            target.vx -= fx;
            target.vy -= fy;
          }
        }
        for (let i = 0; i < nodes.length; i += 1) {
          const a = nodes[i]!;
          for (let j = i + 1; j < nodes.length; j += 1) {
            const b = nodes[j]!;
            const dx = b.x - a.x || 0.01;
            const dy = b.y - a.y || 0.01;
            const distance = Math.max(12, Math.hypot(dx, dy));
            const strength = (a.type === "tag" || b.type === "tag" ? 44 : 66) / (distance * distance) * alpha;
            const fx = dx * strength;
            const fy = dy * strength;
            if (a.fx == null) {
              a.vx -= fx;
              a.vy -= fy;
            }
            if (b.fx == null) {
              b.vx += fx;
              b.vy += fy;
            }
          }
        }
        for (const node of nodes) {
          const targetRadius = Math.min(width, height) * (node.depth === 0 ? 0 : node.depth === 1 ? 0.24 : 0.39);
          const dx = node.x - width / 2;
          const dy = node.y - height / 2;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const tx = width / 2 + dx / distance * targetRadius;
          const ty = height / 2 + dy / distance * targetRadius;
          if (node.fx == null) {
            node.vx += (tx - node.x) * 0.006 * alpha;
            node.vy += (ty - node.y) * 0.006 * alpha;
            if (node.type === "current") {
              node.vx += (width / 2 - node.x) * 0.03 * alpha;
              node.vy += (height / 2 - node.y) * 0.03 * alpha;
            }
            node.x = Math.max(18, Math.min(width - 18, node.x + node.vx));
            node.y = Math.max(20, Math.min(height - 26, node.y + node.vy));
            node.vx *= 0.82;
            node.vy *= 0.82;
          } else {
            node.x = node.fx;
            node.y = node.fy ?? node.y;
          }
        }
      }
    }

    runSimulation(150);
    applyPositions();
    options.status.textContent = `${nodes.length} nodes · ${links.length} links${graph.truncated ? " · capped" : ""}`;
  }

  function update(force = false): void {
    if (isCollapsed()) return;
    expandedOnce = true;
    options.depthLabel.textContent = options.depthInput.value;
    const key = dataSignature();
    if (!force && key === renderKey) return;
    renderKey = key;
    renderGraph();
  }

  function scheduleUpdate(delay = 40): void {
    if (isCollapsed()) return;
    resizeTimer.schedule(() => update(true), undefined, delay);
  }

  function collapse(): void {
    options.root.classList.add("is-collapsed");
    options.toggleButton.setAttribute("aria-expanded", "false");
    clearGraph();
  }

  function toggle(): void {
    const collapsed = isCollapsed();
    options.root.classList.toggle("is-collapsed", !collapsed);
    options.toggleButton.setAttribute("aria-expanded", collapsed ? "true" : "false");
    if (collapsed) {
      update(true);
    } else {
      clearGraph();
    }
  }

  function invalidate(): void {
    renderKey = "";
    if (workspacePayload && options.getIndexVersion && workspacePayload.indexVersion !== options.getIndexVersion()) {
      workspacePayload = null;
    }
    if (!isCollapsed()) scheduleUpdate();
  }

  options.toggleButton.addEventListener("click", toggle);
  for (const input of [options.depthInput, options.refsInput, options.backlinksInput, options.tagsInput]) {
    input.addEventListener("input", () => update(true));
    input.addEventListener("change", () => update(true));
  }
  for (const button of options.modeButtons ?? []) {
    button.addEventListener("click", () => {
      const next = button.dataset.graphMode === "workspace" ? "workspace" : "local";
      if (next === mode) return;
      mode = next;
      options.root.dataset.graphMode = mode;
      for (const candidate of options.modeButtons ?? []) candidate.classList.toggle("is-active", candidate === button);
      options.depthInput.disabled = mode === "workspace";
      options.depthLabel.hidden = mode === "workspace";
      searchInput.disabled = mode === "local";
      groupInput.disabled = mode === "local";
      detail.hidden = true;
      renderKey = "";
      update(true);
    });
  }
  searchInput.disabled = true;
  groupInput.disabled = true;
  window.addEventListener("resize", () => scheduleUpdate(120));

  return { toggle, collapse, update, invalidate };
}
