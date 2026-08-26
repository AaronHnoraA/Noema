/**
 * Host-neutral application menu controller.
 *
 * Adapted from SiYuan's AGPL-3.0 `app/src/menus/Menu.ts` and
 * `app/src/util/setPosition.ts`.  Noema owns the DOM/class contract and keeps
 * command semantics in callers (`runHostCommand` or editor commands).
 */

export type NoemaMenuItemType = "separator" | "submenu" | "readonly" | "empty" | "custom";

export type NoemaMenuItem = {
  id?: string;
  label: string;
  detail?: string;
  accelerator?: string;
  type?: NoemaMenuItemType;
  /** Compatibility shorthand for existing Noema context-menu builders. */
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  warning?: boolean;
  checked?: boolean;
  current?: boolean;
  ignore?: boolean;
  index?: number;
  submenu?: readonly NoemaMenuItem[];
  loadSubmenu?: () => Promise<readonly NoemaMenuItem[]>;
  run?: () => void | Promise<void>;
  bind?: (element: HTMLElement) => void;
};

export type MenuAnchor = {
  left: number;
  top: number;
  targetHeight?: number;
  targetLeft?: number;
  sticky?: boolean;
};

export type MenuViewport = {
  width: number;
  height: number;
  topBoundary: number;
  margin: number;
};

export type MenuPosition = { left: number; top: number };

export type MenuController = {
  open(items: readonly NoemaMenuItem[], anchor: MenuAnchor): void;
  close(): void;
  contains(target: Node | null): boolean;
  focusFirst(): void;
  readonly visible: boolean;
};

export type MenuControllerOptions = {
  topBoundary?: () => number;
  onError?: (error: unknown) => void;
  onClose?: () => void;
};

export function computeMenuPosition(
  rect: Pick<DOMRect, "width" | "height">,
  anchor: MenuAnchor,
  viewport: MenuViewport,
): MenuPosition {
  const topBoundary = Math.max(viewport.margin, viewport.topBoundary);
  const maxLeft = Math.max(viewport.margin, viewport.width - rect.width - viewport.margin);
  let left = Math.max(viewport.margin, Math.min(anchor.left, maxLeft));
  let top = anchor.top;

  if (top < topBoundary) {
    top = topBoundary;
  } else if (top + rect.height > viewport.height - viewport.margin) {
    const above = anchor.top - rect.height - (anchor.targetHeight ?? 0);
    top = above >= topBoundary
      ? above
      : Math.max(topBoundary, viewport.height - rect.height - viewport.margin);
  }

  if (anchor.left + rect.width > viewport.width - viewport.margin) {
    left = Math.max(viewport.margin, viewport.width - rect.width - (anchor.targetLeft ?? viewport.margin));
  }
  return { left, top };
}

export function positionMenuElement(
  element: HTMLElement,
  anchor: MenuAnchor,
  topBoundary = 0,
): MenuPosition {
  element.style.left = `${anchor.left}px`;
  element.style.top = `${anchor.top}px`;
  const rect = element.getBoundingClientRect();
  const sameAnchor = element.dataset.positionTop === String(anchor.top);
  const lockedBottom = sameAnchor ? Number(element.dataset.positionBottom) : Number.NaN;
  const lockedX = sameAnchor ? Number(element.dataset.positionX) : Number.NaN;
  let position = computeMenuPosition(rect, anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
    topBoundary,
    margin: 6,
  });

  if (anchor.sticky && sameAnchor) {
    if (Number.isFinite(lockedX)) position.left = lockedX;
    if (Number.isFinite(lockedBottom)) {
      position.top = anchor.top + rect.height <= window.innerHeight
        ? Math.max(topBoundary, anchor.top)
        : Math.max(topBoundary, lockedBottom - rect.height);
    }
  }
  element.style.left = `${position.left}px`;
  element.style.top = `${position.top}px`;
  if (anchor.sticky) {
    const actual = element.getBoundingClientRect();
    element.dataset.positionTop = String(anchor.top);
    element.dataset.positionBottom = String(actual.bottom);
    element.dataset.positionX = String(position.left);
  } else {
    delete element.dataset.positionTop;
    delete element.dataset.positionBottom;
    delete element.dataset.positionX;
  }
  return position;
}

function itemType(item: NoemaMenuItem): NoemaMenuItemType | "action" {
  if (item.separator) return "separator";
  if (item.type) return item.type;
  if (item.submenu || item.loadSubmenu) return "submenu";
  return "action";
}

export function normalizeMenuItems(items: readonly NoemaMenuItem[]): NoemaMenuItem[] {
  const inserted: NoemaMenuItem[] = [];
  for (const item of items) {
    if (item.ignore) continue;
    if (Number.isInteger(item.index)) {
      inserted.splice(Math.max(0, Math.min(item.index!, inserted.length)), 0, item);
    } else {
      inserted.push(item);
    }
  }
  const result: NoemaMenuItem[] = [];
  for (const item of inserted) {
    if (itemType(item) === "separator") {
      if (result.length > 0 && itemType(result[result.length - 1]!) !== "separator") result.push(item);
    } else {
      result.push(item);
    }
  }
  if (result.length > 0 && itemType(result[result.length - 1]!) === "separator") result.pop();
  return result;
}

function visibleMenuElement(element: HTMLElement): boolean {
  if (element.hidden || element.classList.contains("fn__none")) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

function focusableRows(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(":scope > button[data-noema-menu-row]"))
    .filter((row) => !row.disabled && visibleMenuElement(row));
}

export function updateMenuItemGroupClasses(root: HTMLElement): void {
  const visible = Array.from(root.children).filter((child): child is HTMLElement => (
    child instanceof HTMLElement && visibleMenuElement(child)
  ));
  for (const child of visible) child.classList.remove("noema-menu-group-first", "noema-menu-group-last");
  let group: HTMLElement[] = [];
  const finish = () => {
    group[0]?.classList.add("noema-menu-group-first");
    group[group.length - 1]?.classList.add("noema-menu-group-last");
    group = [];
  };
  for (const child of visible) {
    if (child.getAttribute("role") === "separator") finish();
    else group.push(child);
  }
  finish();
}

class NoemaMenuController implements MenuController {
  private readonly root: HTMLElement;
  private readonly options: MenuControllerOptions;
  private child: NoemaMenuController | null = null;
  private parent: NoemaMenuController | null;
  private parentButton: HTMLButtonElement | null;
  private renderToken = 0;

  constructor(
    root: HTMLElement,
    options: MenuControllerOptions,
    parent: NoemaMenuController | null = null,
    parentButton: HTMLButtonElement | null = null,
  ) {
    this.root = root;
    this.options = options;
    this.parent = parent;
    this.parentButton = parentButton;
    this.root.addEventListener("keydown", (event) => this.handleKeydown(event));
  }

  get visible(): boolean { return !this.root.hidden; }

  contains(target: Node | null): boolean {
    return Boolean(target && (this.root.contains(target) || this.child?.contains(target)));
  }

  open(items: readonly NoemaMenuItem[], anchor: MenuAnchor): void {
    this.closeChild();
    this.renderToken++;
    this.root.replaceChildren();
    const normalized = normalizeMenuItems(items);
    for (const item of normalized) this.root.appendChild(this.renderItem(item));
    if (normalized.length === 0) this.root.appendChild(this.renderItem({ label: "No actions", type: "empty" }));
    this.root.hidden = false;
    this.root.tabIndex = -1;
    positionMenuElement(this.root, anchor, this.options.topBoundary?.() ?? 0);
    updateMenuItemGroupClasses(this.root);
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    this.renderToken++;
    this.closeChild();
    this.root.hidden = true;
    this.root.replaceChildren();
    if (!this.parent) this.options.onClose?.();
  }

  focusFirst(): void { focusableRows(this.root)[0]?.focus(); }

  private closeChild(): void {
    if (!this.child) return;
    const childRoot = this.child.root;
    this.child.close();
    childRoot.remove();
    this.child = null;
  }

  private closeTree(): void {
    let root: NoemaMenuController = this;
    while (root.parent) root = root.parent;
    root.close();
  }

  private renderItem(item: NoemaMenuItem): HTMLElement {
    const type = itemType(item);
    if (type === "separator") {
      const separator = document.createElement("div");
      separator.className = "aaronnote-context-separator";
      separator.setAttribute("role", "separator");
      return separator;
    }
    if (type === "readonly" || type === "empty" || type === "custom") {
      const row = document.createElement("div");
      row.className = `noema-menu-${type}`;
      row.setAttribute("role", type === "readonly" ? "menuitem" : "presentation");
      if (item.label) row.textContent = item.label;
      item.bind?.(row);
      return row;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.noemaMenuRow = "true";
    if (item.id) button.dataset.menuId = item.id;
    button.disabled = Boolean(item.disabled);
    button.dataset.danger = item.danger ? "true" : "false";
    button.dataset.warning = item.warning ? "true" : "false";
    button.classList.toggle("is-current", Boolean(item.current));
    button.setAttribute("role", item.checked !== undefined ? "menuitemcheckbox" : "menuitem");
    if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
    if (type === "submenu") button.setAttribute("aria-haspopup", "menu");
    button.innerHTML = "<span></span><small></small>";
    button.querySelector("span")!.textContent = `${item.checked ? "✓ " : ""}${item.label}`;
    button.querySelector("small")!.textContent = item.accelerator || item.detail || (type === "submenu" ? "›" : "");
    item.bind?.(button);
    button.addEventListener("pointerenter", () => {
      button.focus({ preventScroll: true });
      if (type === "submenu") void this.openSubmenu(button, item, false);
      else this.closeChild();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      if (type === "submenu") {
        void this.openSubmenu(button, item, true);
        return;
      }
      this.closeTree();
      Promise.resolve(item.run?.()).catch((error) => this.options.onError?.(error));
    });
    return button;
  }

  private async openSubmenu(button: HTMLButtonElement, item: NoemaMenuItem, focus: boolean): Promise<void> {
    if (this.child?.parentButton === button) {
      if (focus) this.child.focusFirst();
      return;
    }
    this.closeChild();
    const childRoot = document.createElement("div");
    childRoot.className = `${this.root.className} noema-menu-submenu`;
    childRoot.hidden = true;
    childRoot.setAttribute("role", "menu");
    document.body.appendChild(childRoot);
    const child = new NoemaMenuController(childRoot, this.options, this, button);
    this.child = child;
    const rect = button.getBoundingClientRect();
    const anchor = { left: rect.right - 3, top: rect.top, targetLeft: rect.width, sticky: true };
    const token = ++this.renderToken;
    if (item.submenu) {
      child.open(item.submenu, anchor);
    } else if (item.loadSubmenu) {
      child.open([{ label: "Loading…", type: "readonly" }], anchor);
      try {
        const loaded = await item.loadSubmenu();
        if (token !== this.renderToken || this.child !== child || !button.isConnected) return;
        child.open(loaded.length > 0 ? loaded : [{ label: "No actions", type: "empty" }], anchor);
      } catch (error) {
        if (token !== this.renderToken || this.child !== child) return;
        child.open([{ label: "Unable to load", type: "empty" }], anchor);
        this.options.onError?.(error);
      }
    }
    if (focus) child.focusFirst();
  }

  private handleKeydown(event: KeyboardEvent): void {
    const rows = focusableRows(this.root);
    const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    const index = active ? rows.indexOf(active) : -1;
    const focusAt = (next: number) => {
      if (rows.length === 0) return;
      rows[(next + rows.length) % rows.length]!.focus();
    };
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index < 0 ? rows.length - 1 : index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(rows.length - 1);
    else if (event.key === "ArrowRight" && active?.getAttribute("aria-haspopup") === "menu") active.click();
    else if (event.key === "ArrowLeft" && this.parent) {
      const parentButton = this.parentButton;
      this.parent.closeChild();
      parentButton?.focus();
    } else if ((event.key === "Enter" || event.key === " ") && active) active.click();
    else if (event.key === "Escape") this.closeTree();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
}

export function createMenuController(
  root: HTMLElement,
  options: MenuControllerOptions = {},
): MenuController {
  return new NoemaMenuController(root, options);
}
