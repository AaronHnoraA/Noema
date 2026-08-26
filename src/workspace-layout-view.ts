import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  findWorkspaceNode,
  moveWorkspaceTab,
  parseWorkspaceLayout,
  persistableWorkspaceLayout,
  resizeWorkspaceSplit,
  splitWorkspaceLeaf,
  updateWorkspaceTab,
  workspaceLeaves,
  workspaceTabs,
  type WorkspaceLayoutNode,
  type WorkspaceLayoutState,
  type WorkspaceLeaf,
  type WorkspaceSplitDirection,
  type WorkspaceTab,
} from "./workspace-layout.ts";
import { closestByAttribute } from "./dom-ancestry.ts";

export interface WorkspaceTabMountContext<T> {
  leafId: string;
  tab: WorkspaceTab<T>;
  host: HTMLElement;
}

export interface WorkspaceLayoutViewOptions<T> {
  state: WorkspaceLayoutState<T>;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  storageKey?: string;
  idFactory?: (kind: "leaf" | "split" | "tab") => string;
  cloneTab?: (tab: WorkspaceTab<T>, id: string) => WorkspaceTab<T>;
  mountTab: (context: WorkspaceTabMountContext<T>) => void | (() => void);
  onStateChange?: (state: WorkspaceLayoutState<T>) => void;
  onPopoutTab?: (tab: WorkspaceTab<T>) => void;
  canCloseTab?: (tab: WorkspaceTab<T>) => boolean;
}

export interface WorkspaceLayoutView<T> {
  getState(): WorkspaceLayoutState<T>;
  setState(state: WorkspaceLayoutState<T>): void;
  splitActive(direction: WorkspaceSplitDirection, after?: boolean): boolean;
  activate(leafId: string, tabId: string): void;
  close(tabId: string): boolean;
  updateTab(tabId: string, update: (tab: WorkspaceTab<T>) => WorkspaceTab<T>): boolean;
  destroy(): void;
}

type MountedTab = { host: HTMLElement; dispose?: () => void };

export function createWorkspaceLayoutView<T>(
  root: HTMLElement,
  options: WorkspaceLayoutViewOptions<T>,
): WorkspaceLayoutView<T> {
  const mounts = new Map<string, MountedTab>();
  let sequence = 0;
  let draggedTabId = "";
  let destroyed = false;
  const makeId = options.idFactory ?? ((kind) => `${kind}-${Date.now().toString(36)}-${(++sequence).toString(36)}`);
  const fallback = options.state;
  let state = options.storage && options.storageKey
    ? parseWorkspaceLayout(options.storage.getItem(options.storageKey), fallback)
    : fallback;

  root.classList.add("noema-workspace-layout");
  root.dataset.workspaceLayoutVersion = "1";

  const persist = (): void => {
    if (!options.storage || !options.storageKey) return;
    try {
      options.storage.setItem(options.storageKey, JSON.stringify(persistableWorkspaceLayout(state)));
    } catch {
      // A sensitive-only or unavailable storage state must not block layout.
    }
  };

  const disposeRemovedMounts = (): void => {
    const live = new Set(workspaceTabs(state.root).map((tab) => tab.id));
    for (const [id, mount] of mounts) {
      if (live.has(id)) continue;
      mount.dispose?.();
      mount.host.remove();
      mounts.delete(id);
    }
  };

  const mountFor = (leafId: string, tab: WorkspaceTab<T>): MountedTab => {
    let mount = mounts.get(tab.id);
    if (mount) return mount;
    const host = document.createElement("section");
    host.className = "noema-workspace-tab-panel";
    host.dataset.noemaWorkspaceTabPanel = tab.id;
    host.setAttribute("role", "tabpanel");
    host.setAttribute("aria-label", tab.title);
    const dispose = options.mountTab({ leafId, tab, host });
    mount = { host, ...(dispose ? { dispose } : {}) };
    mounts.set(tab.id, mount);
    return mount;
  };

  const setState = (next: WorkspaceLayoutState<T>): void => {
    if (destroyed || next === state) return;
    state = next;
    disposeRemovedMounts();
    render();
    persist();
    options.onStateChange?.(state);
  };

  const activate = (leafId: string, tabId: string): void => {
    setState(activateWorkspaceTab(state, leafId, tabId));
  };

  const close = (tabId: string): boolean => {
    const tab = workspaceTabs(state.root).find((item) => item.id === tabId);
    if (!tab || options.canCloseTab?.(tab) === false) return false;
    const next = closeWorkspaceTab(state, tabId);
    if (next === state) return false;
    setState(next);
    return true;
  };

  const splitActive = (direction: WorkspaceSplitDirection, after = true): boolean => {
    const leaf = findWorkspaceNode(state.root, state.activeLeafId);
    if (leaf?.type !== "leaf") return false;
    const active = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
    if (!active) return false;
    const tabId = makeId("tab");
    const tab = options.cloneTab
      ? options.cloneTab(active, tabId)
      : { ...active, id: tabId, title: `${active.title} · split` };
    const leafId = makeId("leaf");
    const next = splitWorkspaceLeaf(state, leaf.id, {
      type: "leaf",
      id: leafId,
      tabs: [tab],
      activeTabId: tab.id,
    }, direction, { leafId, splitId: makeId("split") }, after);
    if (next === state) return false;
    setState(next);
    return true;
  };

  const renderTab = (leaf: WorkspaceLeaf<T>, tab: WorkspaceTab<T>, tabs: HTMLElement): void => {
    const selected = tab.id === leaf.activeTabId;
    const item = document.createElement("div");
    item.className = "noema-workspace-tab";
    item.dataset.noemaWorkspaceTab = tab.id;
    item.draggable = true;
    item.setAttribute("role", "presentation");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "noema-workspace-tab-label";
    button.dataset.noemaWorkspaceActivate = tab.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.textContent = tab.title;
    button.title = tab.title;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "noema-workspace-tab-close";
    closeButton.dataset.noemaWorkspaceClose = tab.id;
    closeButton.setAttribute("aria-label", `Close ${tab.title}`);
    closeButton.textContent = "×";
    closeButton.hidden = workspaceTabs(state.root).length === 1 || options.canCloseTab?.(tab) === false;

    item.append(button, closeButton);
    tabs.append(item);
  };

  const renderLeaf = (leaf: WorkspaceLeaf<T>): HTMLElement => {
    const element = document.createElement("section");
    element.className = "noema-workspace-leaf";
    element.dataset.noemaWorkspaceLeaf = leaf.id;
    element.classList.toggle("is-active", state.activeLeafId === leaf.id);

    const header = document.createElement("header");
    header.className = "noema-workspace-tabbar";
    const tabs = document.createElement("div");
    tabs.className = "noema-workspace-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Workspace tabs");
    leaf.tabs.forEach((tab) => renderTab(leaf, tab, tabs));

    const actions = document.createElement("div");
    actions.className = "noema-workspace-leaf-actions";
    for (const [direction, label] of [["lr", "Split right"], ["tb", "Split below"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.noemaWorkspaceSplit = direction;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.textContent = direction === "lr" ? "◫" : "⬒";
      actions.append(button);
    }
    header.append(tabs, actions);

    const body = document.createElement("div");
    body.className = "noema-workspace-leaf-body";
    body.dataset.noemaWorkspaceDrop = "center";
    for (const tab of leaf.tabs) {
      const existing = mounts.get(tab.id);
      if (tab.id !== leaf.activeTabId && !existing) continue;
      const mount = existing ?? mountFor(leaf.id, tab);
      mount.host.hidden = tab.id !== leaf.activeTabId;
      mount.host.dataset.noemaWorkspaceLeaf = leaf.id;
      body.append(mount.host);
    }
    element.append(header, body);
    return element;
  };

  const beginResize = (
    event: PointerEvent,
    split: WorkspaceLayoutNode<T>,
    dividerIndex: number,
    element: HTMLElement,
  ): void => {
    if (split.type !== "split") return;
    event.preventDefault();
    const startState = state;
    const start = split.direction === "lr" ? event.clientX : event.clientY;
    const size = split.direction === "lr" ? element.clientWidth : element.clientHeight;
    const move = (moveEvent: PointerEvent): void => {
      const position = split.direction === "lr" ? moveEvent.clientX : moveEvent.clientY;
      setState(resizeWorkspaceSplit(startState, split.id, dividerIndex, (position - start) / Math.max(1, size)));
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const renderNode = (node: WorkspaceLayoutNode<T>): HTMLElement => {
    if (node.type === "leaf") return renderLeaf(node);
    const element = document.createElement("div");
    element.className = `noema-workspace-split is-${node.direction}`;
    element.dataset.noemaWorkspaceSplitNode = node.id;
    element.dataset.direction = node.direction;
    const sizes = node.sizes;
    node.children.forEach((child, index) => {
      const slot = document.createElement("div");
      slot.className = "noema-workspace-split-slot";
      slot.style.flex = `${sizes[index] ?? 1} 1 0`;
      slot.append(renderNode(child));
      element.append(slot);
      if (index < node.children.length - 1) {
        const divider = document.createElement("div");
        divider.className = "noema-workspace-divider";
        divider.dataset.noemaWorkspaceDivider = `${node.id}:${index}`;
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-orientation", node.direction === "lr" ? "vertical" : "horizontal");
        divider.tabIndex = 0;
        divider.addEventListener("pointerdown", (event) => beginResize(event, node, index, element));
        divider.addEventListener("dblclick", () => {
          const equal = { ...node, sizes: Array(node.children.length).fill(1 / node.children.length) };
          setState({ ...state, root: replaceNode(state.root, node.id, equal) });
        });
        element.append(divider);
      }
    });
    return element;
  };

  const render = (): void => {
    if (destroyed) return;
    const focusedTab = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.noemaWorkspaceActivate || ""
      : "";
    root.replaceChildren(renderNode(state.root));
    if (focusedTab) root.querySelector<HTMLElement>(`[data-noema-workspace-activate="${CSS.escape(focusedTab)}"]`)?.focus();
  };

  const replaceNode = (
    node: WorkspaceLayoutNode<T>,
    id: string,
    replacement: WorkspaceLayoutNode<T>,
  ): WorkspaceLayoutNode<T> => {
    if (node.id === id) return replacement;
    if (node.type === "leaf") return node;
    return { ...node, children: node.children.map((child) => replaceNode(child, id, replacement)) };
  };

  const leafFromEvent = (event: Event): WorkspaceLeaf<T> | null => {
    const element = closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-workspace-leaf", null, root);
    const node = findWorkspaceNode(state.root, element?.dataset.noemaWorkspaceLeaf || "");
    return node?.type === "leaf" ? node : null;
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target instanceof Node ? event.target : null;
    const leaf = leafFromEvent(event);
    if (!leaf) return;
    const activateButton = closestByAttribute(target, "data-noema-workspace-activate", null, root);
    if (activateButton?.dataset.noemaWorkspaceActivate) {
      activate(leaf.id, activateButton.dataset.noemaWorkspaceActivate);
      return;
    }
    const closeButton = closestByAttribute(target, "data-noema-workspace-close", null, root);
    if (closeButton?.dataset.noemaWorkspaceClose) {
      close(closeButton.dataset.noemaWorkspaceClose);
      return;
    }
    const splitButton = closestByAttribute(target, "data-noema-workspace-split", null, root);
    if (splitButton?.dataset.noemaWorkspaceSplit) {
      if (state.activeLeafId !== leaf.id) state = { ...state, activeLeafId: leaf.id };
      splitActive(splitButton.dataset.noemaWorkspaceSplit as WorkspaceSplitDirection);
      return;
    }
    if (state.activeLeafId !== leaf.id) setState({ ...state, activeLeafId: leaf.id });
  };

  const onDoubleClick = (event: MouseEvent): void => {
    const tabElement = closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-workspace-activate", null, root);
    const tab = workspaceTabs(state.root).find((item) => item.id === tabElement?.dataset.noemaWorkspaceActivate);
    if (tab) options.onPopoutTab?.(tab);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const tabElement = closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-workspace-activate", null, root);
    const leaf = leafFromEvent(event);
    if (!tabElement || !leaf) return;
    const index = leaf.tabs.findIndex((tab) => tab.id === tabElement.dataset.noemaWorkspaceActivate);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % leaf.tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + leaf.tabs.length) % leaf.tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = leaf.tabs.length - 1;
    else if ((event.key === "Delete" || event.key === "Backspace") && (event.metaKey || event.ctrlKey)) {
      close(leaf.tabs[index]!.id);
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    activate(leaf.id, leaf.tabs[next]!.id);
  };

  const onDragStart = (event: DragEvent): void => {
    const tabElement = closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-workspace-tab", null, root);
    draggedTabId = tabElement?.dataset.noemaWorkspaceTab || "";
    if (!draggedTabId) return;
    event.dataTransfer?.setData("application/x-noema-workspace-tab", draggedTabId);
    event.dataTransfer?.setData("text/plain", draggedTabId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    root.classList.add("is-tab-dragging");
  };

  const dropDirection = (event: DragEvent, body: HTMLElement): WorkspaceSplitDirection | null => {
    const rect = body.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const y = (event.clientY - rect.top) / Math.max(1, rect.height);
    const edge = 0.24;
    if (x < edge || x > 1 - edge) return "lr";
    if (y < edge || y > 1 - edge) return "tb";
    return null;
  };

  const onDragOver = (event: DragEvent): void => {
    if (!draggedTabId || !leafFromEvent(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };

  const onDrop = (event: DragEvent): void => {
    const leaf = leafFromEvent(event);
    const sourceId = event.dataTransfer?.getData("application/x-noema-workspace-tab") || draggedTabId;
    if (!leaf || !sourceId) return;
    event.preventDefault();
    const tabElement = closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-workspace-tab", null, root);
    const body = closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-workspace-drop", null, root);
    const direction = body ? dropDirection(event, body) : null;
    const sourceLeaf = workspaceLeaves(state.root).find((item) => item.tabs.some((tab) => tab.id === sourceId));
    const rect = body?.getBoundingClientRect();
    const after = direction === "lr"
      ? event.clientX >= (rect?.left || 0) + (rect?.width || 0) / 2
      : event.clientY >= (rect?.top || 0) + (rect?.height || 0) / 2;
    const index = tabElement
      ? Math.max(0, leaf.tabs.findIndex((tab) => tab.id === tabElement.dataset.noemaWorkspaceTab))
      : leaf.tabs.length;
    const next = moveWorkspaceTab(state, sourceId, leaf.id, {
      leafId: makeId("leaf"),
      splitId: makeId("split"),
      ...(direction && !(sourceLeaf?.id === leaf.id && sourceLeaf.tabs.length === 1) ? { direction, after } : { index }),
    });
    draggedTabId = "";
    root.classList.remove("is-tab-dragging");
    setState(next);
  };

  const onDragEnd = (): void => {
    draggedTabId = "";
    root.classList.remove("is-tab-dragging");
  };

  root.addEventListener("click", onClick);
  root.addEventListener("dblclick", onDoubleClick);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  root.addEventListener("dragend", onDragEnd);
  render();
  persist();

  return {
    getState: () => state,
    setState,
    splitActive,
    activate,
    close,
    updateTab(tabId, update): boolean {
      const next = updateWorkspaceTab(state, tabId, update);
      if (next === state) return false;
      setState(next);
      return true;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      root.removeEventListener("click", onClick);
      root.removeEventListener("dblclick", onDoubleClick);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("dragstart", onDragStart);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("dragend", onDragEnd);
      for (const mount of mounts.values()) mount.dispose?.();
      mounts.clear();
      root.replaceChildren();
      root.classList.remove("noema-workspace-layout", "is-tab-dragging");
      delete root.dataset.workspaceLayoutVersion;
    },
  };
}
