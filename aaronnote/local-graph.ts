import type { GraphNode, GraphPayload, NoteSummary } from "./types.ts";
import type { WorkspaceGraph, WorkspaceGraphOptions } from "./workspace-graph.ts";
import { CoalescedTimer } from "../src/coalesced-timer.ts";
import { metadataTagsFromMarkdown } from "./note-tag-transaction.ts";
import type { RendererActivityState } from "../src/renderer-activity.ts";

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
  isVisible?: () => boolean;
  getWorkspaceGraph?: () => Promise<GraphPayload>;
  getIndexVersion?: () => number;
  getNotes: () => NoteSummary[];
  getCurrentNote: () => NoteSummary | undefined;
  getMarkdown: () => string;
  getMarkdownLength?: () => number;
  resolveNoteRef: (ref: string) => NoteSummary | undefined;
  openNote: (note: NoteSummary, options?: OpenNoteOptions) => void;
  openTag: (tag: string) => void;
  createWorkspaceGraph?: (options: WorkspaceGraphOptions) => WorkspaceGraph;
};

export type LocalGraphPanel = {
  toggle: () => void;
  collapse: () => void;
  suspend: () => void;
  setActivity: (state: RendererActivityState) => void;
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

function currentRoamTags(_note: NoteSummary | undefined, markdown: string): string[] {
  return metadataTagsFromMarkdown(markdown) ?? [];
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

export function workspaceGraphWithCurrentMarkdown(
  payload: GraphPayload,
  current: NoteSummary | undefined,
  markdown: string,
  resolveNoteRef: (ref: string) => NoteSummary | undefined,
): GraphPayload {
  const key = noteKey(current);
  if (!current || !key) return payload;
  const currentTags = currentRoamTags(current, markdown);
  const nodes = payload.nodes.map((node) => node.key === key
    ? { ...node, tags: currentTags }
    : { ...node });
  const knownNodeKeys = new Set(nodes.map((node) => node.key));
  for (const tag of currentTags) {
    const tagNode = tagNodeId(tag);
    if (knownNodeKeys.has(tagNode)) continue;
    knownNodeKeys.add(tagNode);
    nodes.push({ key: tagNode, title: `#${tag}`, kind: "tag", exists: true });
  }
  const edges = payload.edges
    .map((edge) => ({ ...edge, type: edge.type ?? "ref" as const }))
    .filter((edge) => !(
      (edge.type === "ref" && edge.source === key)
      || (edge.type === "tag" && (edge.source === key || edge.target === key))
    ));
  const seen = new Set(edges.map((edge) => `${edge.source}\0${edge.target}\0${edge.type || "ref"}`));
  for (const ref of markdownRefs(markdown)) {
    const target = resolveNoteRef(ref);
    const targetKey = noteKey(target);
    const edgeKey = `${key}\0${targetKey}\0ref`;
    if (!targetKey || targetKey === key || seen.has(edgeKey)) continue;
    edges.push({ source: key, target: targetKey, type: "ref" });
    seen.add(edgeKey);
  }
  for (const tag of currentTags) {
    const target = tagNodeId(tag);
    const edgeKey = `${key}\0${target}\0tag`;
    if (seen.has(edgeKey)) continue;
    edges.push({ source: key, target, type: "tag", directed: false });
    seen.add(edgeKey);
  }
  return { ...payload, nodes, edges };
}

export function createLocalGraphPanel(options: LocalGraphPanelOptions): LocalGraphPanel {
  let renderKey = "";
  const resizeTimer = new CoalescedTimer(40);
  let expandedOnce = false;
  let mode: "local" | "workspace" = "local";
  let workspaceGraph: WorkspaceGraph | null = null;
  let workspacePayload: GraphPayload | null = null;
  let activityState: RendererActivityState = "active";
  let pendingUpdate = false;

  function canRender(): boolean {
    return activityState === "active" || activityState === "recently-active";
  }
  let workspaceRequest = 0;
  const searchInput = options.searchInput ?? document.createElement("input");
  const groupInput = options.groupInput ?? document.createElement("select");
  const detail = options.detail ?? document.createElement("div");

  function isCollapsed(): boolean {
    return options.root.classList.contains("is-collapsed") || options.isVisible?.() === false;
  }

  function settings(): { depth: number; refs: boolean; backlinks: boolean; tags: boolean } {
    const depth = Math.max(1, Math.min(3, Number(options.depthInput.value) || 1));
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
    return workspaceGraphWithCurrentMarkdown(
      payload,
      options.getCurrentNote(),
      options.getMarkdown(),
      options.resolveNoteRef,
    );
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
      expandedOnce ? (options.getMarkdownLength?.() ?? options.getMarkdown().length) : "",
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

  async function renderLocalForceGraph(): Promise<void> {
    const request = ++workspaceRequest;
    const rect = options.canvas.getBoundingClientRect();
    const width = Math.max(300, Math.round(rect.width || options.canvas.clientWidth || 360));
    const height = Math.max(240, Math.round(rect.height || options.canvas.clientHeight || 260));
    const local = buildGraph(width, height);
    if (local.nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-local-graph-empty";
      empty.textContent = "No local graph";
      options.canvas.replaceChildren(empty);
      options.status.textContent = "";
      return;
    }
    const nodeByKey = new Map(local.nodes.map((node) => [node.id, node]));
    const payload: GraphPayload = {
      indexVersion: options.getIndexVersion?.() ?? 0,
      scope: "legacy",
      nodes: local.nodes.map((node) => ({
        key: node.id,
        id: node.note?.id,
        title: node.label,
        path: node.note?.file || node.note?.path,
        groupKey: node.note?.groupKey,
        groupLabel: node.note?.groupLabel,
        tags: node.type === "tag" ? [node.tag || node.label.replace(/^#/, "")] : roamTags(node.note),
        kind: node.type === "tag" ? "tag" : "note",
        exists: true,
      })),
      edges: local.links.map((link) => ({
        source: link.source,
        target: link.target,
        type: link.type,
        directed: link.type !== "tag",
      })),
      meta: {
        noteCount: local.nodes.filter((node) => node.type !== "tag").length,
        tagCount: local.nodes.filter((node) => node.type === "tag").length,
        edgeCount: local.links.length,
      },
    };
    try {
      const createGraph = options.createWorkspaceGraph
        ?? (await import("./workspace-graph.ts")).createWorkspaceGraph;
      if (request !== workspaceRequest || isCollapsed() || mode !== "local") return;
      workspaceGraph = createGraph({
        root: options.canvas,
        status: options.status,
        detail,
        searchInput,
        groupInput,
        payload,
        currentKey: currentKey(),
        openNode: (node, openOptions) => {
          const localNode = nodeByKey.get(node.key);
          if (localNode?.type === "tag" && localNode.tag) options.openTag(localNode.tag);
          else if (localNode?.note?.file) options.openNote(localNode.note, openOptions);
        },
        mode: "panel",
        maxNodes: MAX_LOCAL_GRAPH_NODES,
        settings: {
          showTags: true,
          showMissing: false,
          showAttachments: false,
          showOrphans: true,
          showArrows: true,
          showContext: false,
          colorBy: "group",
          scope: "global",
          neighborDepth: settings().depth,
          follow: true,
          localRoot: currentKey(),
        },
      });
      workspaceGraph.setActivity(activityState);
      if (local.truncated) options.status.textContent += " · capped";
    } catch (error) {
      if (request === workspaceRequest) {
        options.status.textContent = error instanceof Error ? error.message : "Local graph failed";
      }
    }
  }

  function renderGraph(): void {
    clearGraph();
    if (mode === "workspace") {
      void renderWorkspaceGraph();
      return;
    }
    void renderLocalForceGraph();
  }

  function update(force = false): void {
    if (isCollapsed()) return;
    if (!canRender()) {
      pendingUpdate = true;
      return;
    }
    expandedOnce = true;
    options.depthLabel.textContent = options.depthInput.value;
    const key = dataSignature();
    if (!force && key === renderKey) {
      pendingUpdate = false;
      return;
    }
    pendingUpdate = false;
    renderKey = key;
    renderGraph();
  }

  function scheduleUpdate(delay = 40): void {
    if (isCollapsed()) return;
    if (!canRender()) {
      pendingUpdate = true;
      return;
    }
    pendingUpdate = true;
    resizeTimer.schedule(() => update(true), undefined, delay);
  }

  function collapse(): void {
    options.root.classList.add("is-collapsed");
    options.toggleButton.setAttribute("aria-expanded", "false");
    clearGraph();
  }

  function suspend(): void {
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
    pendingUpdate = true;
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
      searchInput.disabled = false;
      groupInput.disabled = mode === "local";
      detail.hidden = true;
      renderKey = "";
      update(true);
    });
  }
  searchInput.disabled = false;
  groupInput.disabled = true;
  window.addEventListener("resize", () => scheduleUpdate(120));

  return {
    toggle,
    collapse,
    suspend,
    setActivity(state: RendererActivityState): void {
      if (activityState === state) return;
      const wasSuspended = activityState === "quiescent" || activityState === "hidden";
      activityState = state;
      workspaceGraph?.setActivity(state);
      if (state === "quiescent" || state === "hidden") {
        resizeTimer.cancel();
        return;
      }
      if (wasSuspended && pendingUpdate && !isCollapsed()) update(true);
    },
    update,
    invalidate,
  };
}
