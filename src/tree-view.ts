import { closestByAttribute } from "./dom-ancestry.ts";

export interface NoemaTreeNode<T = unknown> {
  id: string;
  label: string;
  detail?: string;
  icon?: string;
  disabled?: boolean;
  draggable?: boolean;
  expanded?: boolean;
  children?: NoemaTreeNode<T>[];
  value: T;
}

export interface NoemaTreeActivation<T> {
  node: NoemaTreeNode<T>;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface NoemaTreeOptions<T> {
  nodes?: NoemaTreeNode<T>[];
  ariaLabel?: string;
  onActivate?: (activation: NoemaTreeActivation<T>) => void;
  onToggle?: (node: NoemaTreeNode<T>, expanded: boolean) => void;
  onContextMenu?: (node: NoemaTreeNode<T>, event: MouseEvent) => void;
  onDragStart?: (node: NoemaTreeNode<T>, event: DragEvent) => void;
  onDrop?: (target: NoemaTreeNode<T>, sourceId: string, event: DragEvent) => void;
  renderLabel?: (node: NoemaTreeNode<T>, host: HTMLElement) => void;
  renderTrailing?: (node: NoemaTreeNode<T>, host: HTMLElement) => void;
}

export interface NoemaTreeController<T> {
  setNodes(nodes: NoemaTreeNode<T>[]): void;
  toggle(id: string, expanded?: boolean): boolean;
  isExpanded(id: string): boolean;
  focus(id: string): boolean;
  destroy(): void;
}

type IndexedTreeNode<T> = { node: NoemaTreeNode<T>; parentId: string | null; level: number };

export function createTreeView<T>(
  root: HTMLElement,
  options: NoemaTreeOptions<T> = {},
): NoemaTreeController<T> {
  let nodes = options.nodes ?? [];
  const expanded = new Set<string>();
  const index = new Map<string, IndexedTreeNode<T>>();
  let focusedId = "";
  let draggingId = "";

  root.classList.add("noema-tree");
  root.setAttribute("role", "tree");
  root.setAttribute("aria-label", options.ariaLabel || "Tree");

  const indexNodes = (items: NoemaTreeNode<T>[], parentId: string | null, level: number): void => {
    for (const node of items) {
      if (!node.id || index.has(node.id)) throw new Error(`Duplicate or empty tree id: ${node.id}`);
      index.set(node.id, { node, parentId, level });
      if (node.expanded) expanded.add(node.id);
      indexNodes(node.children ?? [], node.id, level + 1);
    }
  };

  const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>("[data-noema-tree-id]")];
  const rowFor = (id: string): HTMLElement | undefined => rows().find((row) => row.dataset.noemaTreeId === id);

  const renderNodes = (items: NoemaTreeNode<T>[], parent: HTMLElement, level: number): void => {
    for (const node of items) {
      const hasChildren = Boolean(node.children?.length);
      const row = document.createElement("div");
      row.className = "noema-tree-row";
      row.dataset.noemaTreeId = node.id;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(level));
      row.setAttribute("aria-disabled", String(Boolean(node.disabled)));
      if (hasChildren) row.setAttribute("aria-expanded", String(expanded.has(node.id)));
      row.tabIndex = node.id === focusedId || (!focusedId && rows().length === 0) ? 0 : -1;
      row.draggable = Boolean(node.draggable && !node.disabled);
      if (row.tabIndex === 0) focusedId = node.id;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "noema-tree-toggle";
      toggle.dataset.noemaTreeToggle = "";
      toggle.tabIndex = -1;
      toggle.disabled = !hasChildren;
      toggle.setAttribute("aria-label", `${expanded.has(node.id) ? "Collapse" : "Expand"} ${node.label}`);
      toggle.textContent = hasChildren ? (expanded.has(node.id) ? "▾" : "▸") : "";

      const icon = document.createElement("span");
      icon.className = "noema-tree-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = node.icon || (hasChildren ? "◇" : "·");

      const text = document.createElement("span");
      text.className = "noema-tree-text";
      if (options.renderLabel) options.renderLabel(node, text);
      else text.textContent = node.label;

      row.append(toggle, icon, text);
      if (node.detail) {
        const detail = document.createElement("small");
        detail.className = "noema-tree-detail";
        detail.textContent = node.detail;
        row.append(detail);
      }
      if (options.renderTrailing) {
        const trailing = document.createElement("span");
        trailing.className = "noema-tree-trailing";
        options.renderTrailing(node, trailing);
        row.append(trailing);
      }
      parent.append(row);

      if (hasChildren && expanded.has(node.id)) {
        const group = document.createElement("div");
        group.className = "noema-tree-group";
        group.setAttribute("role", "group");
        parent.append(group);
        renderNodes(node.children!, group, level + 1);
      }
    }
  };

  const render = (): void => {
    const restoreFocus = root.contains(document.activeElement);
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.noemaTreeId || focusedId
      : focusedId;
    root.replaceChildren();
    renderNodes(nodes, root, 1);
    if (!rowFor(focusedId)) focusedId = rows()[0]?.dataset.noemaTreeId || "";
    for (const row of rows()) row.tabIndex = row.dataset.noemaTreeId === focusedId ? 0 : -1;
    if (restoreFocus && previousFocus) rowFor(previousFocus)?.focus();
  };

  const activate = (node: NoemaTreeNode<T>, event: MouseEvent | KeyboardEvent): void => {
    if (node.disabled) return;
    options.onActivate?.({
      node,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });
  };

  const rowFromEvent = (event: Event): HTMLElement | null => closestByAttribute(
    event.target instanceof Node ? event.target : null,
    "data-noema-tree-id",
    null,
    root,
  );

  const toggle = (id: string, next?: boolean): boolean => {
    const entry = index.get(id);
    if (!entry?.node.children?.length) return false;
    const willExpand = next ?? !expanded.has(id);
    if (willExpand) expanded.add(id);
    else expanded.delete(id);
    options.onToggle?.(entry.node, willExpand);
    render();
    return true;
  };

  const focus = (id: string): boolean => {
    const row = rowFor(id);
    if (!row) return false;
    focusedId = id;
    for (const item of rows()) item.tabIndex = item === row ? 0 : -1;
    row.focus();
    return true;
  };

  const onClick = (event: MouseEvent): void => {
    const row = rowFromEvent(event);
    const id = row?.dataset.noemaTreeId || "";
    const entry = index.get(id);
    if (!row || !entry) return;
    focus(id);
    if (closestByAttribute(event.target instanceof Node ? event.target : null, "data-noema-tree-toggle", null, row)) {
      toggle(id);
      return;
    }
    activate(entry.node, event);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const row = rowFromEvent(event);
    const id = row?.dataset.noemaTreeId || "";
    const entry = index.get(id);
    if (!entry) return;
    const visibleRows = rows().filter((item) => item.getAttribute("aria-disabled") !== "true");
    const position = visibleRows.indexOf(row!);
    let target = "";
    if (event.key === "ArrowDown") target = visibleRows[position + 1]?.dataset.noemaTreeId || "";
    else if (event.key === "ArrowUp") target = visibleRows[position - 1]?.dataset.noemaTreeId || "";
    else if (event.key === "Home") target = visibleRows[0]?.dataset.noemaTreeId || "";
    else if (event.key === "End") target = visibleRows.at(-1)?.dataset.noemaTreeId || "";
    else if (event.key === "ArrowRight") {
      if (entry.node.children?.length && !expanded.has(id)) toggle(id, true);
      else target = entry.node.children?.[0]?.id || "";
    } else if (event.key === "ArrowLeft") {
      if (entry.node.children?.length && expanded.has(id)) toggle(id, false);
      else target = entry.parentId || "";
    } else if (event.key === "Enter") activate(entry.node, event);
    else if (event.key === " ") entry.node.children?.length ? toggle(id) : activate(entry.node, event);
    else return;
    event.preventDefault();
    if (target) focus(target);
    else if (rowFor(id)) focus(id);
  };

  const onContextMenu = (event: MouseEvent): void => {
    const entry = index.get(rowFromEvent(event)?.dataset.noemaTreeId || "");
    if (entry && options.onContextMenu) {
      event.preventDefault();
      options.onContextMenu(entry.node, event);
    }
  };

  const onDragStart = (event: DragEvent): void => {
    const entry = index.get(rowFromEvent(event)?.dataset.noemaTreeId || "");
    if (!entry?.node.draggable || entry.node.disabled) return;
    draggingId = entry.node.id;
    event.dataTransfer?.setData("application/x-noema-tree-node", draggingId);
    event.dataTransfer?.setData("text/plain", draggingId);
    options.onDragStart?.(entry.node, event);
  };

  const onDragOver = (event: DragEvent): void => {
    if (draggingId && rowFromEvent(event)) event.preventDefault();
  };

  const onDrop = (event: DragEvent): void => {
    const entry = index.get(rowFromEvent(event)?.dataset.noemaTreeId || "");
    const sourceId = event.dataTransfer?.getData("application/x-noema-tree-node") || draggingId;
    if (!entry || !sourceId || sourceId === entry.node.id) return;
    event.preventDefault();
    options.onDrop?.(entry.node, sourceId, event);
    draggingId = "";
  };

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);

  const setNodes = (next: NoemaTreeNode<T>[]): void => {
    nodes = next;
    index.clear();
    indexNodes(nodes, null, 1);
    for (const id of [...expanded]) if (!index.has(id)) expanded.delete(id);
    render();
  };
  setNodes(nodes);

  return {
    setNodes,
    toggle,
    isExpanded: (id) => expanded.has(id),
    focus,
    destroy(): void {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("contextmenu", onContextMenu);
      root.removeEventListener("dragstart", onDragStart);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("drop", onDrop);
      root.replaceChildren();
      root.removeAttribute("role");
    },
  };
}
