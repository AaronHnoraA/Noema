/**
 * Pure recursive split/tab layout model.
 *
 * It keeps renderer DOM and editor instances out of persisted state. Tabs are
 * opaque models; a host adapter hydrates only the active tab of each leaf.
 */

export type WorkspaceSplitDirection = "lr" | "tb";

export interface WorkspaceTab<T = Record<string, unknown>> {
  id: string;
  kind: string;
  title: string;
  state: T;
  sensitive?: boolean;
}

export interface WorkspaceLeaf<T = Record<string, unknown>> {
  type: "leaf";
  id: string;
  tabs: WorkspaceTab<T>[];
  activeTabId: string;
}

export interface WorkspaceSplit<T = Record<string, unknown>> {
  type: "split";
  id: string;
  direction: WorkspaceSplitDirection;
  children: WorkspaceLayoutNode<T>[];
  /** Relative flex weights; always normalized and aligned to children. */
  sizes: number[];
}

export type WorkspaceLayoutNode<T = Record<string, unknown>> = WorkspaceLeaf<T> | WorkspaceSplit<T>;

export interface WorkspaceLayoutState<T = Record<string, unknown>> {
  version: 1;
  root: WorkspaceLayoutNode<T>;
  activeLeafId: string;
}

export interface WorkspaceLayoutIds {
  leafId: string;
  splitId: string;
}

export interface MoveWorkspaceTabOptions extends WorkspaceLayoutIds {
  direction?: WorkspaceSplitDirection;
  after?: boolean;
  index?: number;
}

const MAX_LAYOUT_DEPTH = 32;
const MAX_LAYOUT_NODES = 512;
const MAX_LAYOUT_TABS = 512;

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

function normalizedSizes(count: number, sizes: readonly number[] = []): number[] {
  if (count <= 0) return [];
  const values = Array.from({ length: count }, (_, index) => {
    const value = Number(sizes[index]);
    return Number.isFinite(value) && value > 0 ? value : 1;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total);
}

function copyNode<T>(node: WorkspaceLayoutNode<T>): WorkspaceLayoutNode<T> {
  if (node.type === "leaf") return { ...node, tabs: [...node.tabs] };
  return { ...node, sizes: [...node.sizes], children: node.children.map(copyNode) };
}

function mapNode<T>(
  node: WorkspaceLayoutNode<T>,
  id: string,
  update: (target: WorkspaceLayoutNode<T>) => WorkspaceLayoutNode<T>,
): WorkspaceLayoutNode<T> {
  if (node.id === id) return update(node);
  if (node.type === "leaf") return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapNode(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function collapseNode<T>(node: WorkspaceLayoutNode<T>): WorkspaceLayoutNode<T> | null {
  if (node.type === "leaf") return node.tabs.length > 0 ? node : null;
  const children = node.children
    .map(collapseNode)
    .filter((child): child is WorkspaceLayoutNode<T> => Boolean(child));
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes: normalizedSizes(children.length, node.sizes) };
}

function firstLeaf<T>(node: WorkspaceLayoutNode<T>): WorkspaceLeaf<T> {
  return node.type === "leaf" ? node : firstLeaf(node.children[0]!);
}

export function workspaceLeaves<T>(node: WorkspaceLayoutNode<T>): WorkspaceLeaf<T>[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(workspaceLeaves);
}

export function workspaceTabs<T>(node: WorkspaceLayoutNode<T>): WorkspaceTab<T>[] {
  return workspaceLeaves(node).flatMap((leaf) => leaf.tabs);
}

export function findWorkspaceNode<T>(
  node: WorkspaceLayoutNode<T>,
  id: string,
): WorkspaceLayoutNode<T> | null {
  if (node.id === id) return node;
  if (node.type === "leaf") return null;
  for (const child of node.children) {
    const found = findWorkspaceNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findWorkspaceLeafForTab<T>(
  node: WorkspaceLayoutNode<T>,
  tabId: string,
): WorkspaceLeaf<T> | null {
  return workspaceLeaves(node).find((leaf) => leaf.tabs.some((tab) => tab.id === tabId)) ?? null;
}

function stateWithRoot<T>(state: WorkspaceLayoutState<T>, root: WorkspaceLayoutNode<T>): WorkspaceLayoutState<T> {
  const leaves = workspaceLeaves(root);
  const activeLeafId = leaves.some((leaf) => leaf.id === state.activeLeafId)
    ? state.activeLeafId
    : leaves[0]!.id;
  return { ...state, root, activeLeafId };
}

export function createWorkspaceLayout<T>(leaf: WorkspaceLeaf<T>): WorkspaceLayoutState<T> {
  if (!leaf.tabs.length) throw new Error("Workspace root leaf needs at least one tab");
  return normalizeWorkspaceLayout({ version: 1, root: copyNode(leaf), activeLeafId: leaf.id });
}

export function normalizeWorkspaceLayout<T>(state: WorkspaceLayoutState<T>): WorkspaceLayoutState<T> {
  const root = collapseNode(copyNode(state.root));
  if (!root) throw new Error("Workspace layout cannot be empty");
  const normalized = (node: WorkspaceLayoutNode<T>): WorkspaceLayoutNode<T> => {
    if (node.type === "leaf") {
      const activeTabId = node.tabs.some((tab) => tab.id === node.activeTabId)
        ? node.activeTabId
        : node.tabs[0]!.id;
      return { ...node, activeTabId };
    }
    const children = node.children.map(normalized);
    return { ...node, children, sizes: normalizedSizes(children.length, node.sizes) };
  };
  return stateWithRoot(state, normalized(root));
}

export function activateWorkspaceTab<T>(
  state: WorkspaceLayoutState<T>,
  leafId: string,
  tabId: string,
): WorkspaceLayoutState<T> {
  const leaf = findWorkspaceNode(state.root, leafId);
  if (leaf?.type !== "leaf" || !leaf.tabs.some((tab) => tab.id === tabId)) return state;
  return {
    ...state,
    activeLeafId: leafId,
    root: mapNode(state.root, leafId, (node) => ({ ...node as WorkspaceLeaf<T>, activeTabId: tabId })),
  };
}

export function updateWorkspaceTab<T>(
  state: WorkspaceLayoutState<T>,
  tabId: string,
  update: (tab: WorkspaceTab<T>) => WorkspaceTab<T>,
): WorkspaceLayoutState<T> {
  const leaf = findWorkspaceLeafForTab(state.root, tabId);
  if (!leaf) return state;
  let changed = false;
  const root = mapNode(state.root, leaf.id, (node) => {
    const target = node as WorkspaceLeaf<T>;
    const tabs = target.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      const next = update(tab);
      if (next !== tab) changed = true;
      return next;
    });
    return changed ? { ...target, tabs } : target;
  });
  return !changed || root === state.root ? state : { ...state, root };
}

export function splitWorkspaceLeaf<T>(
  state: WorkspaceLayoutState<T>,
  targetLeafId: string,
  newLeaf: WorkspaceLeaf<T>,
  direction: WorkspaceSplitDirection,
  ids: WorkspaceLayoutIds,
  after = true,
): WorkspaceLayoutState<T> {
  if (findWorkspaceNode(state.root, newLeaf.id) || findWorkspaceNode(state.root, ids.splitId)) {
    throw new Error("Workspace split ids must be unique");
  }
  const target = findWorkspaceNode(state.root, targetLeafId);
  if (target?.type !== "leaf" || newLeaf.tabs.length === 0) return state;

  const insertBeside = (node: WorkspaceLayoutNode<T>): WorkspaceLayoutNode<T> => ({
    type: "split",
    id: ids.splitId,
    direction,
    children: after ? [node, newLeaf] : [newLeaf, node],
    sizes: [0.5, 0.5],
  });

  const appendToMatchingParent = (node: WorkspaceLayoutNode<T>): WorkspaceLayoutNode<T> => {
    if (node.type === "leaf") return node.id === targetLeafId ? insertBeside(node) : node;
    const targetIndex = node.children.findIndex((child) => child.id === targetLeafId);
    if (targetIndex >= 0 && node.direction === direction) {
      const children = [...node.children];
      children.splice(targetIndex + (after ? 1 : 0), 0, newLeaf);
      const oldSizes = normalizedSizes(node.children.length, node.sizes);
      const targetSize = oldSizes[targetIndex] ?? 1 / node.children.length;
      const sizes = [...oldSizes];
      sizes[targetIndex] = targetSize / 2;
      sizes.splice(targetIndex + (after ? 1 : 0), 0, targetSize / 2);
      return { ...node, children, sizes: normalizedSizes(children.length, sizes) };
    }
    let changed = false;
    const children = node.children.map((child) => {
      const next = appendToMatchingParent(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, children } : node;
  };

  return normalizeWorkspaceLayout({
    ...state,
    root: appendToMatchingParent(state.root),
    activeLeafId: newLeaf.id,
  });
}

export function closeWorkspaceTab<T>(
  state: WorkspaceLayoutState<T>,
  tabId: string,
): WorkspaceLayoutState<T> {
  const source = findWorkspaceLeafForTab(state.root, tabId);
  if (!source || (workspaceTabs(state.root).length === 1 && source.tabs.length === 1)) return state;
  const tabIndex = source.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = source.tabs.filter((tab) => tab.id !== tabId);
  const activeTabId = source.activeTabId === tabId
    ? tabs[Math.min(tabIndex, tabs.length - 1)]?.id || ""
    : source.activeTabId;
  const root = collapseNode(mapNode(state.root, source.id, (node) => ({
    ...node as WorkspaceLeaf<T>, tabs, activeTabId,
  })));
  if (!root) return state;
  return normalizeWorkspaceLayout(stateWithRoot(state, root));
}

export function moveWorkspaceTab<T>(
  state: WorkspaceLayoutState<T>,
  tabId: string,
  targetLeafId: string,
  options: MoveWorkspaceTabOptions,
): WorkspaceLayoutState<T> {
  const source = findWorkspaceLeafForTab(state.root, tabId);
  const target = findWorkspaceNode(state.root, targetLeafId);
  if (!source || target?.type !== "leaf") return state;
  const tab = source.tabs.find((item) => item.id === tabId)!;

  if (options.direction) {
    if (source.id === targetLeafId && source.tabs.length === 1) return state;
    let removed = closeWorkspaceTab(state, tabId);
    // closeWorkspaceTab refuses the only tab. Moving it is still valid because
    // the new leaf keeps the workspace non-empty.
    if (removed === state && source.tabs.length === 1) {
      const emptyRoot = collapseNode(mapNode(state.root, source.id, (node) => ({
        ...node as WorkspaceLeaf<T>, tabs: [], activeTabId: "",
      })));
      if (emptyRoot) removed = normalizeWorkspaceLayout(stateWithRoot(state, emptyRoot));
    }
    const liveTarget = findWorkspaceNode(removed.root, targetLeafId);
    if (liveTarget?.type !== "leaf") return state;
    return splitWorkspaceLeaf(removed, targetLeafId, {
      type: "leaf",
      id: options.leafId,
      tabs: [tab],
      activeTabId: tab.id,
    }, options.direction, options, options.after);
  }

  if (source.id === targetLeafId) {
    const from = source.tabs.findIndex((item) => item.id === tabId);
    const tabs = source.tabs.filter((item) => item.id !== tabId);
    const index = Math.max(0, Math.min(options.index ?? tabs.length, tabs.length));
    tabs.splice(index, 0, tab);
    if (index === from) return state;
    return activateWorkspaceTab({
      ...state,
      root: mapNode(state.root, source.id, (node) => ({ ...node as WorkspaceLeaf<T>, tabs })),
    }, source.id, tab.id);
  }

  let root = mapNode(state.root, source.id, (node) => {
    const leaf = node as WorkspaceLeaf<T>;
    const tabs = leaf.tabs.filter((item) => item.id !== tabId);
    return { ...leaf, tabs, activeTabId: leaf.activeTabId === tabId ? tabs[0]?.id || "" : leaf.activeTabId };
  });
  root = mapNode(root, targetLeafId, (node) => {
    const leaf = node as WorkspaceLeaf<T>;
    const tabs = [...leaf.tabs];
    tabs.splice(Math.max(0, Math.min(options.index ?? tabs.length, tabs.length)), 0, tab);
    return { ...leaf, tabs, activeTabId: tab.id };
  });
  const collapsed = collapseNode(root);
  if (!collapsed) return state;
  return normalizeWorkspaceLayout({ ...state, root: collapsed, activeLeafId: targetLeafId });
}

export function resizeWorkspaceSplit<T>(
  state: WorkspaceLayoutState<T>,
  splitId: string,
  dividerIndex: number,
  deltaRatio: number,
  minimumRatio = 0.08,
): WorkspaceLayoutState<T> {
  const split = findWorkspaceNode(state.root, splitId);
  if (split?.type !== "split" || dividerIndex < 0 || dividerIndex >= split.children.length - 1) return state;
  const sizes = normalizedSizes(split.children.length, split.sizes);
  const combined = sizes[dividerIndex]! + sizes[dividerIndex + 1]!;
  const min = Math.min(Math.max(0, minimumRatio), combined / 2);
  const left = Math.max(min, Math.min(combined - min, sizes[dividerIndex]! + deltaRatio));
  sizes[dividerIndex] = left;
  sizes[dividerIndex + 1] = combined - left;
  return { ...state, root: mapNode(state.root, splitId, (node) => ({ ...node as WorkspaceSplit<T>, sizes })) };
}

export function persistableWorkspaceLayout<T>(state: WorkspaceLayoutState<T>): WorkspaceLayoutState<T> {
  const strip = (node: WorkspaceLayoutNode<T>): WorkspaceLayoutNode<T> => node.type === "leaf"
    ? { ...node, tabs: node.tabs.filter((tab) => !tab.sensitive).map((tab) => ({ ...tab })) }
    : { ...node, children: node.children.map(strip), sizes: [...node.sizes] };
  const root = collapseNode(strip(state.root));
  if (!root) throw new Error("Workspace contains only sensitive tabs");
  return normalizeWorkspaceLayout(stateWithRoot(state, root));
}

export function parseWorkspaceLayout<T>(
  value: unknown,
  fallback: WorkspaceLayoutState<T>,
): WorkspaceLayoutState<T> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return fallback;
    let nodes = 0;
    let tabs = 0;
    const ids = new Set<string>();
    const parseNode = (input: unknown, depth: number): WorkspaceLayoutNode<T> => {
      if (depth > MAX_LAYOUT_DEPTH || ++nodes > MAX_LAYOUT_NODES || !input || typeof input !== "object") throw new Error("Invalid layout node");
      const record = input as Record<string, unknown>;
      if (!validId(record.id) || ids.has(record.id)) throw new Error("Invalid layout id");
      ids.add(record.id);
      if (record.type === "leaf") {
        if (!Array.isArray(record.tabs) || record.tabs.length === 0) throw new Error("Empty layout leaf");
        const leafTabs = record.tabs.map((raw): WorkspaceTab<T> => {
          if (++tabs > MAX_LAYOUT_TABS || !raw || typeof raw !== "object") throw new Error("Invalid tab");
          const tab = raw as Record<string, unknown>;
          if (!validId(tab.id) || ids.has(tab.id) || !validId(tab.kind) || typeof tab.title !== "string" || tab.title.length > 1024) throw new Error("Invalid tab fields");
          ids.add(tab.id);
          return { id: tab.id, kind: tab.kind, title: tab.title, state: tab.state as T, sensitive: tab.sensitive === true };
        });
        return {
          type: "leaf",
          id: record.id,
          tabs: leafTabs,
          activeTabId: validId(record.activeTabId) ? record.activeTabId : leafTabs[0]!.id,
        };
      }
      if (record.type !== "split" || (record.direction !== "lr" && record.direction !== "tb") || !Array.isArray(record.children) || record.children.length < 2) throw new Error("Invalid split");
      const children = record.children.map((child) => parseNode(child, depth + 1));
      return {
        type: "split",
        id: record.id,
        direction: record.direction,
        children,
        sizes: normalizedSizes(children.length, Array.isArray(record.sizes) ? record.sizes as number[] : []),
      };
    };
    const root = parseNode((parsed as { root?: unknown }).root, 0);
    const activeLeafId = validId((parsed as { activeLeafId?: unknown }).activeLeafId)
      ? (parsed as { activeLeafId: string }).activeLeafId
      : firstLeaf(root).id;
    return normalizeWorkspaceLayout({ version: 1, root, activeLeafId });
  } catch {
    return fallback;
  }
}
