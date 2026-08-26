export type WorkspaceDockPosition = "left" | "right" | "bottom";

export type WorkspaceDockPanelState = {
  id: string;
  position: WorkspaceDockPosition;
  pinned: boolean;
  size: number;
  order: number;
};

export type WorkspaceDockState = {
  version: 1;
  panels: WorkspaceDockPanelState[];
};

export type WorkspaceDockPanel = {
  id: string;
  label: string;
  element: () => HTMLElement | null;
  open: () => void | Promise<void>;
  close: () => void | Promise<void>;
  focus?: () => void;
  defaultPosition: WorkspaceDockPosition;
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
};

export type WorkspaceDockController = {
  register: (panel: WorkspaceDockPanel) => void;
  show: (id: string) => Promise<boolean>;
  hide: (id: string) => Promise<boolean>;
  toggle: (id: string) => Promise<boolean>;
  syncVisibility: (id: string, visible: boolean) => void;
  setPinned: (id: string, pinned: boolean) => boolean;
  move: (id: string, position: WorkspaceDockPosition, beforeId?: string) => boolean;
  resize: (id: string, size: number) => boolean;
  state: () => WorkspaceDockState;
  destroy: () => void;
};

type WorkspaceDockControllerOptions = {
  body: HTMLElement;
  storage?: Pick<Storage, "getItem" | "setItem">;
  storageKey?: string;
  floatingCloseDelayMs?: number;
};

const POSITIONS: WorkspaceDockPosition[] = ["left", "right", "bottom"];
const DEFAULT_STORAGE_KEY = "noema.workspace.docks.v1";
const DEFAULT_MIN_SIZE: Record<WorkspaceDockPosition, number> = {
  left: 232,
  right: 232,
  bottom: 96,
};
const DEFAULT_MAX_SIZE: Record<WorkspaceDockPosition, number> = {
  left: 720,
  right: 720,
  bottom: 720,
};

function isPosition(value: unknown): value is WorkspaceDockPosition {
  return value === "left" || value === "right" || value === "bottom";
}

function finiteInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function safeId(value: unknown): string {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id) ? id : "";
}

export function parseWorkspaceDockState(raw: string | null | undefined): WorkspaceDockState {
  const fallback: WorkspaceDockState = { version: 1, panels: [] };
  if (!raw || raw.length > 64 * 1024) return fallback;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; panels?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.panels)) return fallback;
    const ids = new Set<string>();
    const panels: WorkspaceDockPanelState[] = [];
    for (const candidate of parsed.panels.slice(0, 64)) {
      if (!candidate || typeof candidate !== "object") continue;
      const value = candidate as Record<string, unknown>;
      const id = safeId(value.id);
      if (!id || ids.has(id) || !isPosition(value.position)) continue;
      ids.add(id);
      panels.push({
        id,
        position: value.position,
        pinned: value.pinned !== false,
        size: Math.max(64, Math.min(4096, finiteInteger(value.size, 320))),
        order: Math.max(0, Math.min(4096, finiteInteger(value.order, panels.length))),
      });
    }
    return { version: 1, panels };
  } catch {
    return fallback;
  }
}

export function serializeWorkspaceDockState(state: WorkspaceDockState): string {
  return JSON.stringify({
    version: 1,
    panels: state.panels.map((panel) => ({
      id: panel.id,
      position: panel.position,
      pinned: panel.pinned,
      size: panel.size,
      order: panel.order,
    })),
  });
}

export function createWorkspaceDockController(options: WorkspaceDockControllerOptions): WorkspaceDockController {
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
  const restored = parseWorkspaceDockState(options.storage?.getItem(storageKey));
  const definitions = new Map<string, WorkspaceDockPanel>();
  const panelStates = new Map(restored.panels.map((panel) => [panel.id, { ...panel }]));
  const visible = new Set<string>();
  const rails = new Map<WorkspaceDockPosition, HTMLElement>();
  const buttons = new Map<string, HTMLButtonElement>();
  const closeTimers = new Map<string, number>();
  const cleanups: Array<() => void> = [];
  let destroyed = false;
  let draggedId = "";

  options.body.classList.add("noema-dock-managed");

  const clampSize = (definition: WorkspaceDockPanel, position: WorkspaceDockPosition, value: number): number => {
    const minimum = definition.minSize ?? DEFAULT_MIN_SIZE[position];
    const maximum = definition.maxSize ?? DEFAULT_MAX_SIZE[position];
    return Math.round(Math.max(minimum, Math.min(maximum, value)));
  };

  const orderedStates = (): WorkspaceDockPanelState[] => [...panelStates.values()]
    .filter((panel) => definitions.has(panel.id))
    .sort((a, b) => POSITIONS.indexOf(a.position) - POSITIONS.indexOf(b.position) || a.order - b.order || a.id.localeCompare(b.id));

  const snapshot = (): WorkspaceDockState => ({ version: 1, panels: orderedStates().map((panel) => ({ ...panel })) });

  const persist = (): void => {
    if (!options.storage) return;
    try {
      options.storage.setItem(storageKey, serializeWorkspaceDockState(snapshot()));
    } catch {
      // A private/locked-down WebView may reject storage; the live layout
      // remains usable and simply starts from defaults next time.
    }
  };

  const activePinnedSize = (position: WorkspaceDockPosition): number => {
    const state = orderedStates().find((candidate) => candidate.position === position && candidate.pinned && visible.has(candidate.id));
    return state?.size ?? 0;
  };

  const syncInsets = (): void => {
    for (const position of POSITIONS) {
      const size = activePinnedSize(position);
      options.body.style.setProperty(`--noema-dock-${position}-size`, `${size}px`);
      options.body.classList.toggle(`noema-dock-${position}-open`, size > 0);
    }
  };

  const clearCloseTimer = (id: string): void => {
    const timer = closeTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    closeTimers.delete(id);
  };

  const scheduleFloatingClose = (id: string): void => {
    clearCloseTimer(id);
    const state = panelStates.get(id);
    if (!state || state.pinned || !visible.has(id)) return;
    closeTimers.set(id, window.setTimeout(() => {
      closeTimers.delete(id);
      void hide(id);
    }, options.floatingCloseDelayMs ?? 550));
  };

  const decoratePanel = (id: string): void => {
    const definition = definitions.get(id);
    const state = panelStates.get(id);
    const element = definition?.element();
    if (!definition || !state || !element) return;
    element.classList.add("noema-workspace-dock-panel");
    element.dataset.noemaDockPanel = id;
    element.dataset.noemaDockPosition = state.position;
    element.dataset.noemaDockPinned = String(state.pinned);
    element.style.setProperty("--noema-workspace-dock-size", `${state.size}px`);

    let pin = element.querySelector<HTMLButtonElement>(`:scope > [data-noema-dock-pin="${id}"], :scope > header [data-noema-dock-pin="${id}"]`);
    if (!pin) {
      pin = document.createElement("button");
      pin.type = "button";
      pin.dataset.noemaDockPin = id;
      pin.className = "noema-workspace-dock-pin";
      const header = element.querySelector<HTMLElement>(":scope > header, :scope > [data-agenda-full-header]");
      (header || element).appendChild(pin);
      const onPin = () => setPinned(id, !panelStates.get(id)?.pinned);
      pin.addEventListener("click", onPin);
      cleanups.push(() => pin?.removeEventListener("click", onPin));
    }
    pin.textContent = state.pinned ? "Unpin" : "Pin";
    pin.title = state.pinned ? "Float this dock" : "Keep this dock open";
    pin.setAttribute("aria-pressed", String(state.pinned));

    let resizeHandle = element.querySelector<HTMLElement>(`:scope > [data-noema-dock-resize="${id}"]`);
    if (!resizeHandle) {
      resizeHandle = document.createElement("div");
      resizeHandle.className = "noema-workspace-dock-resize";
      resizeHandle.dataset.noemaDockResize = id;
      resizeHandle.setAttribute("role", "separator");
      resizeHandle.tabIndex = 0;
      element.appendChild(resizeHandle);
      const onDoubleClick = () => resize(id, definition.defaultSize);
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const onMove = (moveEvent: PointerEvent) => {
          const rect = element.getBoundingClientRect();
          const next = state.position === "left"
            ? moveEvent.clientX - rect.left
            : state.position === "right"
              ? rect.right - moveEvent.clientX
              : rect.bottom - moveEvent.clientY;
          resize(id, next, false);
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          persist();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp, { once: true });
      };
      resizeHandle.addEventListener("dblclick", onDoubleClick);
      resizeHandle.addEventListener("pointerdown", onPointerDown);
      cleanups.push(() => {
        resizeHandle?.removeEventListener("dblclick", onDoubleClick);
        resizeHandle?.removeEventListener("pointerdown", onPointerDown);
      });
    }
    resizeHandle.dataset.noemaDockPosition = state.position;
    resizeHandle.setAttribute("aria-orientation", state.position === "bottom" ? "horizontal" : "vertical");

    if (element.dataset.noemaDockHoverBound !== "true") {
      element.dataset.noemaDockHoverBound = "true";
      const onEnter = () => clearCloseTimer(id);
      const onLeave = () => scheduleFloatingClose(id);
      element.addEventListener("pointerenter", onEnter);
      element.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        element.removeEventListener("pointerenter", onEnter);
        element.removeEventListener("pointerleave", onLeave);
      });
    }
  };

  const renderRails = (): void => {
    for (const position of POSITIONS) {
      const rail = rails.get(position);
      if (!rail) continue;
      const fragment = document.createDocumentFragment();
      for (const state of orderedStates().filter((panel) => panel.position === position)) {
        const definition = definitions.get(state.id);
        const button = buttons.get(state.id);
        if (!definition || !button) continue;
        button.classList.toggle("is-active", visible.has(state.id));
        button.classList.toggle("is-pinned", state.pinned);
        button.setAttribute("aria-expanded", String(visible.has(state.id)));
        button.title = `${definition.label} · ${state.pinned ? "pinned" : "floating"}`;
        fragment.appendChild(button);
      }
      rail.replaceChildren(fragment);
    }
  };

  const syncVisibility = (id: string, nextVisible: boolean): void => {
    if (destroyed || !definitions.has(id)) return;
    const state = panelStates.get(id);
    if (!state) return;
    if (nextVisible) {
      for (const other of orderedStates()) {
        if (other.id === id || other.position !== state.position || !visible.has(other.id)) continue;
        visible.delete(other.id);
        clearCloseTimer(other.id);
        void definitions.get(other.id)?.close();
      }
      visible.add(id);
      queueMicrotask(() => decoratePanel(id));
    } else {
      visible.delete(id);
      clearCloseTimer(id);
    }
    decoratePanel(id);
    syncInsets();
    renderRails();
  };

  const show = async (id: string): Promise<boolean> => {
    const definition = definitions.get(id);
    if (destroyed || !definition) return false;
    await definition.open();
    syncVisibility(id, true);
    definition.focus?.();
    return true;
  };

  const hide = async (id: string): Promise<boolean> => {
    const definition = definitions.get(id);
    if (destroyed || !definition) return false;
    await definition.close();
    syncVisibility(id, false);
    return true;
  };

  const toggle = async (id: string): Promise<boolean> => visible.has(id) ? hide(id) : show(id);

  const setPinned = (id: string, pinned: boolean): boolean => {
    const state = panelStates.get(id);
    if (destroyed || !state || state.pinned === pinned) return false;
    state.pinned = pinned;
    decoratePanel(id);
    syncInsets();
    renderRails();
    persist();
    if (!pinned) scheduleFloatingClose(id);
    return true;
  };

  const move = (id: string, position: WorkspaceDockPosition, beforeId?: string): boolean => {
    const state = panelStates.get(id);
    const definition = definitions.get(id);
    if (destroyed || !state || !definition || !isPosition(position)) return false;
    const peers = orderedStates().filter((panel) => panel.position === position && panel.id !== id);
    const before = beforeId ? peers.findIndex((panel) => panel.id === beforeId) : -1;
    const insertion = before >= 0 ? before : peers.length;
    peers.splice(insertion, 0, state);
    peers.forEach((panel, index) => { panel.order = index; });
    state.position = position;
    state.size = clampSize(definition, position, state.size);
    if (visible.has(id)) {
      for (const other of peers) {
        if (other.id === id || !visible.has(other.id)) continue;
        visible.delete(other.id);
        void definitions.get(other.id)?.close();
      }
    }
    decoratePanel(id);
    syncInsets();
    renderRails();
    persist();
    return true;
  };

  const resize = (id: string, size: number, shouldPersist = true): boolean => {
    const state = panelStates.get(id);
    const definition = definitions.get(id);
    if (destroyed || !state || !definition || !Number.isFinite(size)) return false;
    const next = clampSize(definition, state.position, size);
    if (next === state.size) return false;
    state.size = next;
    decoratePanel(id);
    syncInsets();
    if (shouldPersist) persist();
    return true;
  };

  for (const position of POSITIONS) {
    const rail = document.createElement("nav");
    rail.className = `noema-workspace-dock-rail is-${position}`;
    rail.dataset.noemaDockRail = position;
    rail.setAttribute("aria-label", `${position[0].toUpperCase()}${position.slice(1)} dock`);
    const onDragOver = (event: DragEvent) => {
      if (!draggedId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    };
    const onDrop = (event: DragEvent) => {
      const id = event.dataTransfer?.getData("application/x-noema-dock-panel") || draggedId;
      if (!id) return;
      event.preventDefault();
      const target = (event.target instanceof Element ? event.target.closest<HTMLElement>("[data-noema-dock-button]") : null);
      move(id, position, target?.dataset.noemaDockButton);
      draggedId = "";
    };
    rail.addEventListener("dragover", onDragOver);
    rail.addEventListener("drop", onDrop);
    cleanups.push(() => {
      rail.removeEventListener("dragover", onDragOver);
      rail.removeEventListener("drop", onDrop);
    });
    options.body.appendChild(rail);
    rails.set(position, rail);
  }

  const register = (definition: WorkspaceDockPanel): void => {
    if (destroyed || !safeId(definition.id) || definitions.has(definition.id)) return;
    definitions.set(definition.id, definition);
    const restoredState = panelStates.get(definition.id);
    const position = restoredState?.position ?? definition.defaultPosition;
    panelStates.set(definition.id, {
      id: definition.id,
      position,
      pinned: restoredState?.pinned ?? true,
      size: clampSize(definition, position, restoredState?.size ?? definition.defaultSize),
      order: restoredState?.order ?? definitions.size - 1,
    });
    const button = document.createElement("button");
    button.type = "button";
    button.draggable = true;
    button.dataset.noemaDockButton = definition.id;
    button.textContent = definition.label;
    const onClick = () => { void toggle(definition.id); };
    const onPointerEnter = () => {
      const state = panelStates.get(definition.id);
      if (state && !state.pinned && !visible.has(definition.id)) void show(definition.id);
      clearCloseTimer(definition.id);
    };
    const onPointerLeave = () => scheduleFloatingClose(definition.id);
    const onDragStart = (event: DragEvent) => {
      draggedId = definition.id;
      event.dataTransfer?.setData("application/x-noema-dock-panel", definition.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      options.body.classList.add("is-dock-dragging");
    };
    const onDragEnd = () => {
      draggedId = "";
      options.body.classList.remove("is-dock-dragging");
    };
    button.addEventListener("click", onClick);
    button.addEventListener("pointerenter", onPointerEnter);
    button.addEventListener("pointerleave", onPointerLeave);
    button.addEventListener("dragstart", onDragStart);
    button.addEventListener("dragend", onDragEnd);
    cleanups.push(() => {
      button.removeEventListener("click", onClick);
      button.removeEventListener("pointerenter", onPointerEnter);
      button.removeEventListener("pointerleave", onPointerLeave);
      button.removeEventListener("dragstart", onDragStart);
      button.removeEventListener("dragend", onDragEnd);
    });
    buttons.set(definition.id, button);
    decoratePanel(definition.id);
    renderRails();
    persist();
  };

  return {
    register,
    show,
    hide,
    toggle,
    syncVisibility,
    setPinned,
    move,
    resize,
    state: snapshot,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const id of closeTimers.keys()) clearCloseTimer(id);
      for (const cleanup of cleanups.splice(0)) cleanup();
      for (const rail of rails.values()) rail.remove();
      for (const definition of definitions.values()) {
        const element = definition.element();
        element?.classList.remove("noema-workspace-dock-panel");
        element?.removeAttribute("data-noema-dock-panel");
        element?.removeAttribute("data-noema-dock-position");
        element?.removeAttribute("data-noema-dock-pinned");
      }
      options.body.classList.remove(
        "noema-dock-managed",
        "noema-dock-left-open",
        "noema-dock-right-open",
        "noema-dock-bottom-open",
        "is-dock-dragging",
      );
      for (const position of POSITIONS) options.body.style.removeProperty(`--noema-dock-${position}-size`);
    },
  };
}
