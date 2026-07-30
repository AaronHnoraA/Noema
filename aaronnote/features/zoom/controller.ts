import type { Editor } from "../../../src/editor-api.ts";

type VisualZoomAnchor = { clientX: number; clientY: number };

export type ZoomControllerOptions = {
  editor: Editor;
  host: HTMLElement;
  toolsPanel: HTMLElement;
  editorSurfaceVisible: () => boolean;
  primaryModifier: (event: KeyboardEvent) => boolean;
  scheduleAssistUpdate: () => void;
  setStatus: (message: string) => void;
};

export type ZoomController = {
  layoutZoomPercent: () => string;
  updateLayoutZoomTool: () => void;
  stepLayoutZoom: (direction: -1 | 1, options?: { announce?: boolean }) => boolean;
  resetLayoutZoom: (options?: { announce?: boolean }) => boolean;
  runLayoutZoomShortcut: (event: KeyboardEvent) => boolean;
  runVisualZoomShortcut: (event: KeyboardEvent) => boolean;
  destroy: () => void;
};

const LAYOUT_ZOOM_MIN = 0.72;
const LAYOUT_ZOOM_MAX = 1.55;
const LAYOUT_ZOOM_STEP = 0.08;
const VISUAL_ZOOM_MIN = 1;
const VISUAL_ZOOM_MAX = 2;
const VISUAL_ZOOM_STEP = 0.12;
const VISUAL_ZOOM_PINCH_SNAP = 0.05;

export function createZoomController(options: ZoomControllerOptions): ZoomController {
  const {
    editor,
    host,
    toolsPanel,
    editorSurfaceVisible,
    primaryModifier,
    scheduleAssistUpdate,
    setStatus,
  } = options;
  let layoutZoom = 1;
  let visualZoom = 1;
  let visualGestureStartZoom = 1;
  let visualGestureAnchor: VisualZoomAnchor = { clientX: 0, clientY: 0 };
  let visualWheelRawZoom = 1;
  let visualWheelIdleTimer = 0;
  let destroyed = false;

  function layoutZoomPercent(): string {
    return `${Math.round(layoutZoom * 100)}%`;
  }

  function clampLayoutZoom(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(LAYOUT_ZOOM_MAX, Math.max(LAYOUT_ZOOM_MIN, value));
  }

  function updateLayoutZoomTool(): void {
    const value = toolsPanel.querySelector<HTMLElement>("[data-layout-zoom-value]");
    if (value) value.textContent = layoutZoomPercent();
    const min = layoutZoom <= LAYOUT_ZOOM_MIN + 0.001;
    const max = layoutZoom >= LAYOUT_ZOOM_MAX - 0.001;
    for (const button of toolsPanel.querySelectorAll<HTMLButtonElement>("[data-layout-zoom-action='out']")) button.disabled = min;
    for (const button of toolsPanel.querySelectorAll<HTMLButtonElement>("[data-layout-zoom-action='in']")) button.disabled = max;
  }

  function applyLayoutZoom(next: number, applyOptions: { announce?: boolean } = {}): boolean {
    const clamped = clampLayoutZoom(next);
    if (Math.abs(clamped - layoutZoom) < 0.001) return false;
    layoutZoom = clamped;
    document.documentElement.style.setProperty("--aaronnote-layout-zoom", layoutZoom.toFixed(3));
    editor.view.requestMeasure();
    window.dispatchEvent(new Event("resize"));
    scheduleAssistUpdate();
    updateLayoutZoomTool();
    if (applyOptions.announce) setStatus(`Layout zoom ${layoutZoomPercent()}`);
    return true;
  }

  function stepLayoutZoom(direction: -1 | 1, applyOptions: { announce?: boolean } = {}): boolean {
    return applyLayoutZoom(layoutZoom + direction * LAYOUT_ZOOM_STEP, applyOptions);
  }

  function resetLayoutZoom(applyOptions: { announce?: boolean } = {}): boolean {
    return applyLayoutZoom(1, applyOptions);
  }

  function visualZoomPercent(): string {
    return `${Math.round(visualZoom * 100)}%`;
  }

  function clampVisualZoom(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(VISUAL_ZOOM_MAX, Math.max(VISUAL_ZOOM_MIN, value));
  }

  function defaultVisualZoomAnchor(): VisualZoomAnchor {
    const rect = host.getBoundingClientRect();
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  }

  function eventVisualZoomAnchor(event: Event, fallback = defaultVisualZoomAnchor()): VisualZoomAnchor {
    const positioned = event as Event & { clientX?: number; clientY?: number };
    const clientX = Number(positioned.clientX);
    const clientY = Number(positioned.clientY);
    return Number.isFinite(clientX) && Number.isFinite(clientY) && (clientX !== 0 || clientY !== 0)
      ? { clientX, clientY }
      : fallback;
  }

  function applyVisualZoom(
    next: number,
    applyOptions: { announce?: boolean; anchor?: VisualZoomAnchor } = {},
  ): boolean {
    const clamped = clampVisualZoom(next);
    if (Math.abs(clamped - visualZoom) < 0.001) return false;
    const previous = visualZoom;
    const anchor = applyOptions.anchor;
    const wrap = anchor ? host.querySelector<HTMLElement>(".typora-web-wrap") : null;
    const wrapRect = wrap?.getBoundingClientRect();
    visualZoom = clamped;
    document.documentElement.style.setProperty("--aaronnote-visual-zoom", visualZoom.toFixed(3));
    if (anchor && wrapRect && previous > 0) {
      const ratio = visualZoom / previous;
      host.scrollLeft += (anchor.clientX - wrapRect.left) * (ratio - 1);
      host.scrollTop += (anchor.clientY - wrapRect.top) * (ratio - 1);
    }
    if (applyOptions.announce) setStatus(`Visual zoom ${visualZoomPercent()}`);
    return true;
  }

  function stepVisualZoom(direction: -1 | 1, applyOptions: { announce?: boolean } = {}): boolean {
    const next = visualZoom + direction * VISUAL_ZOOM_STEP;
    const crossesDefault = direction > 0
      ? visualZoom < 1 && next >= 1
      : visualZoom > 1 && next <= 1;
    return applyVisualZoom(crossesDefault || Math.abs(next - 1) < VISUAL_ZOOM_STEP / 2 ? 1 : next, applyOptions);
  }

  function resetVisualZoom(applyOptions: { announce?: boolean } = {}): boolean {
    return applyVisualZoom(1, applyOptions);
  }

  function runLayoutZoomShortcut(event: KeyboardEvent): boolean {
    if (!primaryModifier(event) || event.altKey || event.isComposing) return false;
    const code = event.code;
    const key = event.key;
    const zoomIn = code === "Equal" || code === "NumpadAdd" || key === "=" || key === "+";
    const zoomOut = code === "Minus" || code === "NumpadSubtract" || key === "-" || key === "_";
    const reset = code === "Digit0" || code === "Numpad0" || key === "0";
    if (!zoomIn && !zoomOut && !reset) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (zoomIn) stepLayoutZoom(1, { announce: true });
    else if (zoomOut) stepLayoutZoom(-1, { announce: true });
    else resetLayoutZoom({ announce: true });
    return true;
  }

  function runVisualZoomShortcut(event: KeyboardEvent): boolean {
    const tab = event.code === "Tab" || event.key === "Tab" || event.key === "Backtab" || event.key === "ISO_Left_Tab";
    const reset = event.code === "Digit0" || event.code === "Numpad0" || event.key === "0";
    if ((!tab && !reset) || !event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (reset) resetVisualZoom({ announce: true });
    else stepVisualZoom(event.shiftKey || event.key !== "Tab" ? -1 : 1, { announce: true });
    return true;
  }

  function visualZoomWheelFactor(event: WheelEvent): number {
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 18
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(1, window.innerHeight)
        : 1;
    return Math.exp(-event.deltaY * unit * 0.0025);
  }

  function snapPinchVisualZoom(value: number): number {
    return Math.abs(value - 1) <= VISUAL_ZOOM_PINCH_SNAP ? 1 : value;
  }

  function shouldHandleVisualZoomTarget(target: EventTarget | null): boolean {
    if (!editorSurfaceVisible()) return false;
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    return !element?.closest(".aaronnote-local-graph-panel, .aaronnote-modal");
  }

  function handleVisualZoomWheel(event: WheelEvent): void {
    // Meta+wheel is ordinary navigation on macOS and is too easy to trigger
    // accidentally. Trackpad pinch is handled by gesture events (or Ctrl+wheel).
    if (!event.ctrlKey || event.metaKey || !shouldHandleVisualZoomTarget(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!visualWheelIdleTimer) visualWheelRawZoom = visualZoom;
    visualWheelRawZoom = clampVisualZoom(visualWheelRawZoom * visualZoomWheelFactor(event));
    applyVisualZoom(snapPinchVisualZoom(visualWheelRawZoom), { anchor: eventVisualZoomAnchor(event) });
    window.clearTimeout(visualWheelIdleTimer);
    visualWheelIdleTimer = window.setTimeout(() => {
      visualWheelIdleTimer = 0;
      visualWheelRawZoom = visualZoom;
    }, 140);
  }

  function handleVisualGestureStart(event: Event): void {
    if (!shouldHandleVisualZoomTarget(event.target)) return;
    visualGestureStartZoom = visualZoom;
    visualGestureAnchor = eventVisualZoomAnchor(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function handleVisualGestureChange(event: Event): void {
    if (!shouldHandleVisualZoomTarget(event.target)) return;
    const scale = Number((event as Event & { scale?: number }).scale);
    if (!Number.isFinite(scale) || scale <= 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    applyVisualZoom(snapPinchVisualZoom(visualGestureStartZoom * scale), {
      anchor: eventVisualZoomAnchor(event, visualGestureAnchor),
    });
  }

  document.addEventListener("wheel", handleVisualZoomWheel, { capture: true, passive: false });
  document.addEventListener("gesturestart", handleVisualGestureStart, { capture: true, passive: false });
  document.addEventListener("gesturechange", handleVisualGestureChange, { capture: true, passive: false });

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener("wheel", handleVisualZoomWheel, { capture: true });
    document.removeEventListener("gesturestart", handleVisualGestureStart, { capture: true });
    document.removeEventListener("gesturechange", handleVisualGestureChange, { capture: true });
    window.clearTimeout(visualWheelIdleTimer);
    visualWheelIdleTimer = 0;
  }

  return {
    layoutZoomPercent,
    updateLayoutZoomTool,
    stepLayoutZoom,
    resetLayoutZoom,
    runLayoutZoomShortcut,
    runVisualZoomShortcut,
    destroy,
  };
}
