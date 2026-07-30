import DOMPurify from "dompurify";
import { safeHref } from "./url-safety.ts";
export { supportedDiagramLang } from "./diagram-langs.ts";

type DiagramCacheValue = { html: string; error?: string };

const MERMAID_CACHE_LIMIT = 96;
const MERMAID_CACHE_BYTES = 8_000_000; // 8 MB
const MAX_MERMAID_SOURCE_CHARS = 80_000;
const MIN_DIAGRAM_SCALE = 0.55;
const MAX_DIAGRAM_SCALE = 2.4;
const DIAGRAM_ZOOM_STEP = 0.12;
const DIAGRAM_LONG_PRESS_MS = 260;
const DIAGRAM_LONG_PRESS_CANCEL_PX = 8;
const mermaidCache = new Map<string, DiagramCacheValue>();
let mermaidCacheBytes = 0;
let renderSeq = 0;

type DiagramDragState = { x: number; y: number; panX: number; panY: number; moved: boolean };

type DiagramInteractionState = {
  scale: number;
  panX: number;
  panY: number;
  drag: DiagramDragState | null;
  pendingDrag: DiagramDragState | null;
  longPressTimer: number | null;
  suppressNextClick: boolean;
  applyTransform: () => void;
  applyScale: (next: number, originX?: number, originY?: number) => void;
  reset: () => void;
  fit: () => void;
};

const diagramInteractions = new WeakMap<HTMLElement, DiagramInteractionState>();

function mermaidEntryBytes(v: DiagramCacheValue): number {
  return (v.html.length + (v.error?.length ?? 0)) * 2;
}

function cachedMermaid(key: string): DiagramCacheValue | undefined {
  const cached = mermaidCache.get(key);
  if (!cached) return undefined;
  mermaidCache.delete(key);
  mermaidCache.set(key, cached);
  return cached;
}

function rememberMermaid(key: string, value: DiagramCacheValue): void {
  if (mermaidCache.has(key)) return;
  mermaidCache.set(key, value);
  mermaidCacheBytes += mermaidEntryBytes(value);
  while (mermaidCache.size > MERMAID_CACHE_LIMIT || mermaidCacheBytes > MERMAID_CACHE_BYTES) {
    const oldest = mermaidCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    const old = mermaidCache.get(oldest)!;
    mermaidCacheBytes -= mermaidEntryBytes(old);
    mermaidCache.delete(oldest);
  }
}

export function clearDiagramRenderCache(): void {
  mermaidCache.clear();
  mermaidCacheBytes = 0;
}

export function diagramRenderCacheSize(): number {
  return mermaidCache.size;
}

export function disposeDiagramRuntime(): void {
  clearDiagramRenderCache();
}

function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // foreignObject is needed for Mermaid mindmap node labels (div.nodeLabel inside foreignObject).
    // DOMPurify sanitizes the HTML content inside foreignObject using its HTML rules,
    // so scripts/iframes/event-handlers are still stripped.
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["href", "xlink:href", "target", "title", "requiredExtensions", "xmlns", "style"],
  });
}

function sanitizeDiagramLinks(element: HTMLElement): void {
  element.querySelectorAll<SVGElement>("a").forEach((anchor) => {
    const href = anchor.getAttribute("href")
      || anchor.getAttribute("xlink:href")
      || anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href")
      || "";
    if (!href || !safeHref(href)) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("xlink:href");
      anchor.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
      return;
    }
    anchor.setAttribute("href", href);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });
}

const MERMAID_START_RE = /^(?:mindmap|flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta|packet-beta)\b/i;
const MINDMAP_LANGS = new Set(["mindmap", "marmind", "markmind"]);
const AARON_MINDMAP_LANGS = new Set(["marmind", "markmind"]);

function diagramLang(info = ""): string {
  return String(info || "").trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
}

function cleanMindmapText(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
}

function normalizeMindmapSource(source: string): string {
  const lines = String(source || "").replace(/\t/g, "  ").split(/\r?\n/);
  const meaningful = lines.filter((line) => line.trim());
  if (meaningful.length === 0) return "";
  if (MERMAID_START_RE.test(meaningful[0]!.trim())) return source.trim();

  const normalized = meaningful.map((line, index) => {
    const rawIndent = line.match(/^\s*/)?.[0].length ?? 0;
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    const level = heading
      ? heading[1]!.length - 1
      : bullet
        ? Math.floor((bullet[1]?.length ?? 0) / 2)
        : Math.floor(rawIndent / 2);
    const listText = bullet && /^\d/.test(bullet[2]!)
      ? `${bullet[2]} ${bullet[3]}`
      : bullet?.[3];
    const text = cleanMindmapText(heading?.[2] ?? listText ?? line);
    return `${"  ".repeat(Math.max(1, level + 1))}${text || `Node ${index + 1}`}`;
  });
  return ["mindmap", ...normalized].join("\n");
}

export function normalizeMermaidSource(source: string, info = ""): string {
  return MINDMAP_LANGS.has(diagramLang(info)) ? normalizeMindmapSource(source) : source;
}

export function staticAaronMindmap(info = ""): boolean {
  return AARON_MINDMAP_LANGS.has(diagramLang(info));
}

function aaronMindmapThemeSource(source: string): string {
  return [
    "---",
    "config:",
    "  theme: base",
    "  themeVariables:",
    "    background: '#f7f4ed'",
    "    primaryColor: '#f3ead7'",
    "    primaryBorderColor: '#9b8770'",
    "    primaryTextColor: '#1e1a16'",
    "    secondaryColor: '#e7eee6'",
    "    secondaryBorderColor: '#71816f'",
    "    secondaryTextColor: '#1e1a16'",
    "    tertiaryColor: '#f7f4ed'",
    "    tertiaryBorderColor: '#b9ab98'",
    "    tertiaryTextColor: '#1e1a16'",
    "    lineColor: '#867560'",
    "    textColor: '#1e1a16'",
    "    fontFamily: 'Avenir Next, Inter, system-ui, sans-serif'",
    "---",
    source,
  ].join("\n");
}

function diagramHrefFromAnchor(anchor: SVGElement): string {
  return anchor.getAttribute("href")
    || anchor.getAttribute("xlink:href")
    || anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href")
    || "";
}

function primaryLinkModifier(event: MouseEvent): boolean {
  if (event.metaKey && !event.ctrlKey) return true;
  return !/Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey;
}

function dispatchDiagramLink(element: HTMLElement, event: MouseEvent, href: string): void {
  if (!safeHref(href)) return;
  event.preventDefault();
  event.stopPropagation();
  const openEvent = new CustomEvent("aaronnote:open-url", {
    bubbles: true,
    cancelable: true,
    detail: { href, newWindow: event.button === 1 || primaryLinkModifier(event) },
  });
  element.dispatchEvent(openEvent);
  if (!openEvent.defaultPrevented) {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

function selectedDiagramNode(target: EventTarget | null): SVGElement | null {
  if (!(target instanceof SVGElement)) return null;
  return target.closest<SVGElement>("a, g.node, g.mindmap-node, g[class*='node'], g[id]")
    ?? target.closest<SVGElement>("text");
}

function currentDiagramSvg(element: HTMLElement): SVGSVGElement | null {
  return element.querySelector<SVGSVGElement>("svg");
}

function configureDiagramSvg(svg: SVGSVGElement): void {
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  svg.style.transformOrigin = "0 0";
  svg.style.touchAction = "none";
}

function clampScale(value: number): number {
  return Math.min(MAX_DIAGRAM_SCALE, Math.max(MIN_DIAGRAM_SCALE, value));
}

function diagramViewportSize(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(1, element.clientWidth || rect.width || 1),
    height: Math.max(1, element.clientHeight || rect.height || 1),
  };
}

function diagramSvgSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map((part) => Number(part));
  if (viewBox && viewBox.length >= 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3]) && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }

  const width = svgLengthAttr(svg, "width");
  const height = svgLengthAttr(svg, "height");
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }

  const rect = svg.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || svg.clientWidth || 1),
    height: Math.max(1, rect.height || svg.clientHeight || 1),
  };
}

function svgLengthAttr(svg: SVGSVGElement, name: "width" | "height"): number {
  const raw = (svg.getAttribute(name) || "").trim();
  return raw.endsWith("%") ? Number.NaN : Number.parseFloat(raw);
}

function stopDiagramControlEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function diagramControlButton(label: string, action: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cm-diagram-control cm-diagram-control-${action}`;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("mousedown", stopDiagramControlEvent);
  button.addEventListener("pointerdown", stopDiagramControlEvent);
  button.addEventListener("click", (event) => {
    stopDiagramControlEvent(event);
    onClick();
  });
  return button;
}

function installDiagramToolbar(element: HTMLElement, state: DiagramInteractionState): void {
  Array.from(element.children).forEach((child) => {
    if (child instanceof HTMLElement && child.classList.contains("cm-diagram-toolbar")) child.remove();
  });

  const toolbar = document.createElement("div");
  toolbar.className = "cm-diagram-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Diagram controls");
  toolbar.addEventListener("mousedown", stopDiagramControlEvent);
  toolbar.addEventListener("pointerdown", stopDiagramControlEvent);
  toolbar.addEventListener("click", (event) => event.stopPropagation());
  toolbar.append(
    diagramControlButton("-", "zoom-out", "Zoom out", () => state.applyScale(state.scale - DIAGRAM_ZOOM_STEP)),
    diagramControlButton("+", "zoom-in", "Zoom in", () => state.applyScale(state.scale + DIAGRAM_ZOOM_STEP)),
    diagramControlButton("1:1", "reset", "Reset zoom", () => state.reset()),
    diagramControlButton("Fit", "fit", "Fit to view", () => state.fit()),
  );
  element.append(toolbar);
}

function bindDiagramInteraction(element: HTMLElement): DiagramInteractionState {
  const state: DiagramInteractionState = {
    scale: 1,
    panX: 0,
    panY: 0,
    drag: null,
    pendingDrag: null,
    longPressTimer: null,
    suppressNextClick: false,
    applyTransform: () => {
      const activeSvg = currentDiagramSvg(element);
      if (!activeSvg) return;
      configureDiagramSvg(activeSvg);
      activeSvg.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    },
    applyScale: (next: number, originX = element.clientWidth / 2, originY = element.clientHeight / 2) => {
      const prev = state.scale;
      state.scale = clampScale(next);
      if (prev > 0 && prev !== state.scale) {
        const factor = state.scale / prev;
        state.panX = originX - (originX - state.panX) * factor;
        state.panY = originY - (originY - state.panY) * factor;
      }
      state.applyTransform();
    },
    reset: () => {
      state.scale = 1;
      state.panX = 0;
      state.panY = 0;
      state.applyTransform();
    },
    fit: () => {
      const activeSvg = currentDiagramSvg(element);
      if (!activeSvg) return;
      const viewport = diagramViewportSize(element);
      const content = diagramSvgSize(activeSvg);
      const inset = 28;
      const fitWidth = Math.max(1, viewport.width - inset);
      const fitHeight = Math.max(1, viewport.height - inset);
      const nextScale = Math.min(
        1,
        clampScale(Math.min(fitWidth / content.width, fitHeight / content.height)),
      );
      state.scale = nextScale;
      state.panX = Math.max(0, (viewport.width - content.width * nextScale) / 2);
      state.panY = Math.max(0, (viewport.height - content.height * nextScale) / 2);
      state.applyTransform();
    },
  };

  const clearLongPress = (): void => {
    if (state.longPressTimer != null) {
      window.clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
    state.pendingDrag = null;
    element.classList.remove("is-long-pressing");
  };
  const beginDrag = (start: DiagramDragState, pointerId: number): void => {
    clearLongPress();
    state.drag = start;
    if (Number.isFinite(pointerId)) element.setPointerCapture?.(pointerId);
    element.classList.add("is-panning");
  };

  element.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (
      target instanceof Element
      && target.closest("svg")
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("svg")) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: false };
    const pointerType = event.pointerType || "mouse";
    if (pointerType === "touch" || pointerType === "pen") {
      clearLongPress();
      state.pendingDrag = start;
      element.classList.add("is-long-pressing");
      const pointerId = event.pointerId;
      state.longPressTimer = window.setTimeout(() => {
        if (!state.pendingDrag) return;
        beginDrag(state.pendingDrag, pointerId);
      }, DIAGRAM_LONG_PRESS_MS);
      return;
    }
    beginDrag(start, event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (state.pendingDrag && !state.drag) {
      const dx = event.clientX - state.pendingDrag.x;
      const dy = event.clientY - state.pendingDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > DIAGRAM_LONG_PRESS_CANCEL_PX) clearLongPress();
      return;
    }
    if (!state.drag) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - state.drag.x;
    const dy = event.clientY - state.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) state.drag.moved = true;
    state.panX = state.drag.panX + dx;
    state.panY = state.drag.panY + dy;
    state.applyTransform();
  });
  const endDrag = (event?: PointerEvent): void => {
    state.suppressNextClick = Boolean(state.drag?.moved);
    state.drag = null;
    clearLongPress();
    element.classList.remove("is-panning");
    if (event && Number.isFinite(event.pointerId)) element.releasePointerCapture?.(event.pointerId);
    if (state.suppressNextClick) window.setTimeout(() => { state.suppressNextClick = false; }, 0);
  };
  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", endDrag);
  element.addEventListener("click", (event) => {
    if (state.suppressNextClick) {
      event.preventDefault();
      event.stopPropagation();
      state.suppressNextClick = false;
      return;
    }
    const anchor = (event.target as Element | null)?.closest<SVGElement>("a");
    if (anchor) {
      const href = diagramHrefFromAnchor(anchor);
      if (href) dispatchDiagramLink(element, event, href);
      return;
    }
    const node = selectedDiagramNode(event.target);
    if (!node) return;
    element.querySelectorAll(".cm-diagram-selected").forEach((selected) => {
      selected.classList.remove("cm-diagram-selected");
    });
    node.classList.add("cm-diagram-selected");
  });
  element.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.reset();
  });
  element.addEventListener("wheel", (event) => {
    const target = event.target;
    const overDiagram = target instanceof Element && Boolean(target.closest("svg"));
    if (!overDiagram && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    state.applyScale(
      state.scale + (event.deltaY < 0 ? DIAGRAM_ZOOM_STEP : -DIAGRAM_ZOOM_STEP),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  }, { passive: false });

  return state;
}

export function enableDiagramInteraction(element: HTMLElement): void {
  const svg = currentDiagramSvg(element);
  if (!svg) return;

  element.classList.add("cm-diagram-interactive");
  element.style.overflow = "hidden";
  configureDiagramSvg(svg);
  sanitizeDiagramLinks(element);

  let state = diagramInteractions.get(element);
  if (!state) {
    state = bindDiagramInteraction(element);
    diagramInteractions.set(element, state);
    element.dataset.diagramInteractionBound = "true";
  }
  installDiagramToolbar(element, state);
  state.applyTransform();
}

export function renderMermaidLazy(
  source: string,
  element: HTMLElement,
  onError: (message: string) => void,
  options: { lang?: string; onRender?: () => void } = {},
): void {
  const trimmed = normalizeMermaidSource(source, options.lang).trim();
  const staticMindmap = staticAaronMindmap(options.lang);
  const renderSource = staticMindmap ? aaronMindmapThemeSource(trimmed) : trimmed;
  const key = `mermaid\n${staticMindmap ? "aaron-mindmap" : "interactive"}\n${renderSource}`;
  element.setAttribute("data-diagram-render-key", key);
  element.classList.remove("aaronnote-diagram-error");
  element.classList.toggle("cm-aaron-mindmap", staticMindmap);
  if (!trimmed) {
    element.replaceChildren();
    options.onRender?.();
    return;
  }
  if (trimmed.length > MAX_MERMAID_SOURCE_CHARS) {
    onError("Diagram is too large to render inline");
    options.onRender?.();
    return;
  }

  const cached = cachedMermaid(key);
  if (cached) {
    if (cached.error) {
      onError(cached.error);
      options.onRender?.();
    } else {
      element.innerHTML = cached.html;
      enableDiagramInteraction(element);
      options.onRender?.();
    }
    return;
  }

  const seq = ++renderSeq;
  element.textContent = "Rendering diagram...";
  void (async () => {
    await new Promise<void>((resolve) => {
      const idle = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 16));
      idle(() => resolve(), { timeout: 180 });
    });
    if (element.getAttribute("data-diagram-render-key") !== key || !element.isConnected) return;
    try {
      const mermaid = (await import("mermaid")).default;
      // Aaron mindmap (marmind/markmind): antiscript lets the per-diagram frontmatter
      // ---config--- block take effect (strict blocks it). DOMPurify is our sanitizer anyway.
      // Interactive diagrams keep strict for defence-in-depth.
      if (staticMindmap) {
        mermaid.initialize({ startOnLoad: false, securityLevel: "antiscript" });
      } else {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      }
      const id = `aaronnote-mermaid-${Date.now()}-${seq}`;
      const result = await mermaid.render(id, renderSource);
      if (element.getAttribute("data-diagram-render-key") !== key || !element.isConnected) return;
      const html = sanitizeSvg(result.svg);
      rememberMermaid(key, { html });
      element.innerHTML = html;
      enableDiagramInteraction(element);
      options.onRender?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rememberMermaid(key, { html: "", error: message });
      if (element.getAttribute("data-diagram-render-key") !== key || !element.isConnected) return;
      onError(message);
      options.onRender?.();
    }
  })();
}
