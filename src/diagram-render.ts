import DOMPurify from "dompurify";
import { getKatexMacros } from "./katex-macros.ts";
import { ensureMathStyles } from "./math-render.ts";
import { katexCompatibleLatex } from "./tex-compat.ts";
import { safeHref } from "./url-safety.ts";
export { supportedDiagramLang } from "./diagram-langs.ts";

type DiagramCacheValue = { html: string; error?: string };

const MERMAID_CACHE_LIMIT = 96;
const MERMAID_CACHE_BYTES = 8_000_000; // 8 MB
const MAX_MERMAID_SOURCE_CHARS = 80_000;
const MIN_DIAGRAM_SCALE = 0.25;
const MAX_DIAGRAM_SCALE = 4;
const DIAGRAM_ZOOM_FACTOR = 1.18;
const DIAGRAM_LONG_PRESS_MS = 260;
const DIAGRAM_LONG_PRESS_CANCEL_PX = 8;
const DIAGRAM_KEYBOARD_PAN_PX = 48;
const mermaidCache = new Map<string, DiagramCacheValue>();
let mermaidCacheBytes = 0;
let renderSeq = 0;

type DiagramDragState = { x: number; y: number; panX: number; panY: number; moved: boolean };

type DiagramTouchPoint = { x: number; y: number };

type DiagramTouchGesture = {
  pointerIds: [number, number];
  distance: number;
  centerX: number;
  centerY: number;
  scale: number;
  panX: number;
  panY: number;
};

type DiagramInteractionState = {
  scale: number;
  panX: number;
  panY: number;
  autoFit: boolean;
  drag: DiagramDragState | null;
  pendingDrag: DiagramDragState | null;
  longPressTimer: number | null;
  suppressNextClick: boolean;
  zoomLabel: HTMLButtonElement | null;
  resizeObserver: ResizeObserver | null;
  applyTransform: () => void;
  applyScale: (next: number, originX?: number, originY?: number) => void;
  reset: () => void;
  fit: () => void;
  close: () => void;
};

type DiagramLightbox = {
  overlay: HTMLDivElement;
  stage: HTMLDivElement;
  state: DiagramInteractionState;
  origin: HTMLElement | null;
  onKeyDown: (event: KeyboardEvent) => void;
};

/**
 * An inline diagram is a picture: no pan, no zoom, no pointer capture, so a
 * click reaches the editor and opens the source. The pan/zoom machinery below
 * belongs to the lightbox a reader opens on demand, and it is torn down with
 * that lightbox. One lightbox is open at a time.
 */
let openLightbox: DiagramLightbox | null = null;

/** Release a diagram whose owning widget is being removed. */
export function disposeDiagramInteraction(element: HTMLElement): void {
  element.removeAttribute("data-diagram-render-key");
  if (openLightbox?.origin === element) openLightbox.state.close();
}

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

const FOREIGN_OBJECT_HTML_ATTR = "data-noema-foreign-html";

function sanitizeForeignObjectHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, iframe, object, embed, link, meta, base, style").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      if (/^on/i.test(attribute.name) || attribute.name.toLowerCase() === "srcdoc") {
        node.removeAttribute(attribute.name);
      }
    });
  });
  return DOMPurify.sanitize(template.innerHTML, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base", "style"],
    FORBID_ATTR: ["srcdoc"],
  });
}

export function sanitizeDiagramSvg(svg: string): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  template.content.querySelectorAll<SVGForeignObjectElement>("foreignObject").forEach((foreignObject) => {
    const safeHtml = sanitizeForeignObjectHtml(foreignObject.innerHTML);
    foreignObject.replaceChildren();
    foreignObject.setAttribute(FOREIGN_OBJECT_HTML_ATTR, safeHtml);
  });

  return DOMPurify.sanitize(template.innerHTML, {
    USE_PROFILES: { svg: true, svgFilters: true, mathMl: true },
    // foreignObject is needed for Mermaid mindmap labels. Its HTML was sanitized
    // separately and is carried through this SVG-only pass in an inert data attr.
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["href", "xlink:href", "target", "title", "requiredExtensions", "xmlns", "style"],
  });
}

function hydrateDiagramForeignObjects(element: HTMLElement): void {
  element.querySelectorAll<SVGForeignObjectElement>(`foreignObject[${FOREIGN_OBJECT_HTML_ATTR}]`).forEach((foreignObject) => {
    foreignObject.innerHTML = foreignObject.getAttribute(FOREIGN_OBJECT_HTML_ATTR) ?? "";
    foreignObject.removeAttribute(FOREIGN_OBJECT_HTML_ATTR);
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

function macroDefinitionsFor(tex: string): string {
  const macros = getKatexMacros();
  const needed = new Set<string>();
  const pending = Array.from(tex.matchAll(/\\[A-Za-z]+|\\./g), (match) => match[0]);

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (needed.has(name) || macros[name] == null) continue;
    needed.add(name);
    pending.push(...Array.from(macros[name]!.matchAll(/\\[A-Za-z]+|\\./g), (match) => match[0]));
  }

  return Object.entries(macros)
    .filter(([name]) => needed.has(name))
    .map(([name, body]) => {
      const arity = Math.max(0, ...Array.from(body.matchAll(/#([1-9])/g), (match) => Number(match[1])));
      const params = Array.from({ length: arity }, (_, index) => `#${index + 1}`).join("");
      return `\\gdef${name}${params}{${body}}`;
    })
    .join("");
}

function normalizeMindmapLatex(value: string): string {
  const delimited = value.replace(/\\\(([^\n]*?)\\\)/g, (_match, tex: string) => `$$${tex}$$`);
  return delimited.replace(/\$\$([^\n]*?)\$\$/g, (_match, tex: string) => {
    const compatible = katexCompatibleLatex(tex.trim());
    return `$$${macroDefinitionsFor(compatible)}${compatible}$$`;
  });
}

function markdownMindmapMathNode(text: string, index: number): string {
  if (!text.includes("$$")) return text;
  const escaped = text.replace(/`/g, "&#96;").replace(/"/g, "&quot;");
  return `noema_math_${index}[\"\`${escaped}\`\"]`;
}

function normalizeMindmapSource(source: string): string {
  const lines = String(source || "").replace(/\t/g, "  ").split(/\r?\n/);
  const meaningful = lines.filter((line) => line.trim());
  if (meaningful.length === 0) return "";
  if (MERMAID_START_RE.test(meaningful[0]!.trim())) return normalizeMindmapLatex(source.trim());

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
    const text = normalizeMindmapLatex(cleanMindmapText(heading?.[2] ?? listText ?? line));
    const node = markdownMindmapMathNode(text || `Node ${index + 1}`, index);
    return `${"  ".repeat(Math.max(1, level + 1))}${node}`;
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

function configureDiagramSvg(svg: SVGSVGElement, element?: HTMLElement): void {
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  svg.style.transformOrigin = "0 0";
  svg.style.touchAction = "none";
  if (element?.classList.contains("cm-aaron-mindmap")) {
    const size = diagramSvgSize(svg);
    svg.style.display = "block";
    svg.style.width = `${size.width}px`;
    svg.style.height = `${size.height}px`;
    svg.style.margin = "0";
  }
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

function wheelDeltaPixels(event: WheelEvent, viewport: { width: number; height: number }): { x: number; y: number } {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return { x: event.deltaX * 16, y: event.deltaY * 16 };
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return { x: event.deltaX * viewport.width, y: event.deltaY * viewport.height };
  }
  return { x: event.deltaX, y: event.deltaY };
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
  const zoomOut = diagramControlButton("−", "zoom-out", "Zoom out", () => state.applyScale(state.scale / DIAGRAM_ZOOM_FACTOR));
  const zoomLabel = diagramControlButton("100%", "reset", "Reset to 100%", () => state.reset());
  const zoomIn = diagramControlButton("+", "zoom-in", "Zoom in", () => state.applyScale(state.scale * DIAGRAM_ZOOM_FACTOR));
  const fit = diagramControlButton("Fit", "fit", "Fit diagram to view", () => state.fit());
  const close = diagramControlButton("Close", "close", "Close the diagram viewer", () => state.close());
  state.zoomLabel = zoomLabel;
  toolbar.append(zoomOut, zoomLabel, zoomIn, fit, close);
  element.append(toolbar);
  state.applyTransform();
}

function bindDiagramInteraction(element: HTMLElement): DiagramInteractionState {
  const state: DiagramInteractionState = {
    scale: 1,
    panX: 0,
    panY: 0,
    autoFit: true,
    drag: null,
    pendingDrag: null,
    longPressTimer: null,
    suppressNextClick: false,
    zoomLabel: null,
    resizeObserver: null,
    applyTransform: () => {
      const activeSvg = currentDiagramSvg(element);
      if (!activeSvg) return;
      configureDiagramSvg(activeSvg, element);
      activeSvg.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
      element.dataset.diagramScale = String(state.scale);
      if (state.zoomLabel) state.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
    },
    applyScale: (next: number, originX = element.clientWidth / 2, originY = element.clientHeight / 2) => {
      const prev = state.scale;
      state.scale = clampScale(next);
      state.autoFit = false;
      if (prev > 0 && prev !== state.scale) {
        const factor = state.scale / prev;
        state.panX = originX - (originX - state.panX) * factor;
        state.panY = originY - (originY - state.panY) * factor;
      }
      state.applyTransform();
    },
    reset: () => {
      state.scale = 1;
      state.autoFit = false;
      const activeSvg = currentDiagramSvg(element);
      const rect = element.getBoundingClientRect();
      const hasViewport = (element.clientWidth || rect.width) > 1 && (element.clientHeight || rect.height) > 1;
      if (activeSvg && hasViewport) {
        const viewport = diagramViewportSize(element);
        const content = diagramSvgSize(activeSvg);
        state.panX = (viewport.width - content.width) / 2;
        state.panY = (viewport.height - content.height) / 2;
      } else {
        state.panX = 0;
        state.panY = 0;
      }
      state.applyTransform();
    },
    fit: () => {
      const activeSvg = currentDiagramSvg(element);
      if (!activeSvg) return;
      const viewport = diagramViewportSize(element);
      const content = diagramSvgSize(activeSvg);
      const inset = 48;
      const fitWidth = Math.max(1, viewport.width - inset);
      const fitHeight = Math.max(1, viewport.height - inset);
      const nextScale = Math.min(
        1,
        clampScale(Math.min(fitWidth / content.width, fitHeight / content.height)),
      );
      state.scale = nextScale;
      state.panX = (viewport.width - content.width * nextScale) / 2;
      state.panY = (viewport.height - content.height * nextScale) / 2;
      state.autoFit = true;
      state.applyTransform();
    },
    close: () => {
      if (openLightbox?.state !== state) return;
      const lightbox = openLightbox;
      openLightbox = null;
      document.removeEventListener("keydown", lightbox.onKeyDown, true);
      document.body.classList.remove("has-diagram-fullscreen");
      if (state.longPressTimer != null) window.clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
      state.resizeObserver?.disconnect();
      state.resizeObserver = null;
      // Only hand the keyboard back when the viewer still had it. A diagram
      // disposed while the reader is typing somewhere else must not steal focus.
      const hadFocus = lightbox.overlay.contains(document.activeElement);
      lightbox.overlay.remove();
      if (hadFocus && lightbox.origin?.isConnected) {
        const expand = lightbox.origin.querySelector<HTMLButtonElement>(".cm-diagram-expand");
        expand?.focus({ preventScroll: true });
      }
    },
  };

  if (typeof ResizeObserver !== "undefined") {
    let previousWidth = 0;
    let previousHeight = 0;
    state.resizeObserver = new ResizeObserver((entries) => {
      if (!element.isConnected) {
        state.resizeObserver?.disconnect();
        state.resizeObserver = null;
        return;
      }
      const rect = entries[0]?.contentRect;
      const width = rect?.width ?? element.clientWidth;
      const height = rect?.height ?? element.clientHeight;
      if (width <= 1 || height <= 1 || (width === previousWidth && height === previousHeight)) return;
      previousWidth = width;
      previousHeight = height;
      if (state.autoFit) state.fit();
    });
    state.resizeObserver.observe(element);
  }

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
    state.autoFit = false;
    if (Number.isFinite(pointerId)) element.setPointerCapture?.(pointerId);
    element.classList.add("is-panning");
  };
  const touchPointers = new Map<number, DiagramTouchPoint>();
  let touchGesture: DiagramTouchGesture | null = null;
  const beginTouchGesture = (): boolean => {
    const pair = Array.from(touchPointers.entries()).slice(0, 2);
    if (pair.length < 2) return false;
    const [[firstId, first], [secondId, second]] = pair;
    const rect = element.getBoundingClientRect();
    clearLongPress();
    state.drag = null;
    state.autoFit = false;
    touchGesture = {
      pointerIds: [firstId, secondId],
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      centerX: (first.x + second.x) / 2 - rect.left,
      centerY: (first.y + second.y) / 2 - rect.top,
      scale: state.scale,
      panX: state.panX,
      panY: state.panY,
    };
    element.setPointerCapture?.(firstId);
    element.setPointerCapture?.(secondId);
    element.classList.add("is-panning");
    return true;
  };

  element.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".cm-diagram-toolbar")) return;
    event.preventDefault();
    event.stopPropagation();
  });

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".cm-diagram-toolbar")) return;
    event.preventDefault();
    event.stopPropagation();
    element.focus({ preventScroll: true });
    const start = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY, moved: false };
    const pointerType = event.pointerType || "mouse";
    if (pointerType === "touch") {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (beginTouchGesture()) return;
      beginDrag(start, event.pointerId);
      return;
    }
    if (pointerType === "pen") {
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
    if (touchPointers.has(event.pointerId)) {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (touchGesture) {
      const [firstId, secondId] = touchGesture.pointerIds;
      const first = touchPointers.get(firstId);
      const second = touchPointers.get(secondId);
      if (first && second) {
        event.preventDefault();
        event.stopPropagation();
        const rect = element.getBoundingClientRect();
        const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
        const centerX = (first.x + second.x) / 2 - rect.left;
        const centerY = (first.y + second.y) / 2 - rect.top;
        const nextScale = clampScale(touchGesture.scale * distance / touchGesture.distance);
        const factor = nextScale / touchGesture.scale;
        state.scale = nextScale;
        state.panX = centerX - (touchGesture.centerX - touchGesture.panX) * factor;
        state.panY = centerY - (touchGesture.centerY - touchGesture.panY) * factor;
        state.autoFit = false;
        state.applyTransform();
      }
      return;
    }
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
  const endPointer = (event: PointerEvent): void => {
    const wasTouch = touchPointers.delete(event.pointerId);
    if (wasTouch && touchGesture) {
      touchGesture = null;
      state.suppressNextClick = true;
      state.drag = null;
      clearLongPress();
      element.releasePointerCapture?.(event.pointerId);
      const remaining = touchPointers.entries().next().value as [number, DiagramTouchPoint] | undefined;
      if (remaining) {
        const [pointerId, point] = remaining;
        beginDrag({ x: point.x, y: point.y, panX: state.panX, panY: state.panY, moved: true }, pointerId);
      } else {
        element.classList.remove("is-panning");
      }
      window.setTimeout(() => { state.suppressNextClick = false; }, 0);
      return;
    }
    endDrag(event);
  };
  element.addEventListener("pointerup", endPointer);
  element.addEventListener("pointercancel", endPointer);
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
  let webkitGestureActive = false;
  let webkitGestureStartScale = 1;
  element.addEventListener("gesturestart", (event: Event) => {
    stopDiagramControlEvent(event);
    webkitGestureActive = true;
    webkitGestureStartScale = state.scale;
  });
  element.addEventListener("gesturechange", (event: Event) => {
    stopDiagramControlEvent(event);
    const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
    const rect = element.getBoundingClientRect();
    state.applyScale(
      webkitGestureStartScale * Math.max(0.01, gesture.scale ?? 1),
      (gesture.clientX ?? rect.left + rect.width / 2) - rect.left,
      (gesture.clientY ?? rect.top + rect.height / 2) - rect.top,
    );
  });
  element.addEventListener("gestureend", (event: Event) => {
    stopDiagramControlEvent(event);
    webkitGestureActive = false;
  });
  element.addEventListener("wheel", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".cm-diagram-toolbar")) return;
    event.preventDefault();
    event.stopPropagation();
    if (webkitGestureActive) return;
    const rect = element.getBoundingClientRect();
    const delta = wheelDeltaPixels(event, diagramViewportSize(element));
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-delta.y * 0.0025);
      state.applyScale(
        state.scale * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return;
    }

    const horizontal = event.shiftKey && Math.abs(delta.x) < Math.abs(delta.y)
      ? delta.y
      : delta.x;
    const vertical = event.shiftKey && Math.abs(delta.x) < Math.abs(delta.y)
      ? 0
      : delta.y;
    state.autoFit = false;
    state.panX -= horizontal;
    state.panY -= vertical;
    state.applyTransform();
  }, { passive: false });
  element.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLButtonElement && event.key !== "Escape") return;
    if (event.key === "Escape") {
      stopDiagramControlEvent(event);
      state.close();
      return;
    }
    const pan = (x: number, y: number): void => {
      stopDiagramControlEvent(event);
      state.autoFit = false;
      state.panX += x;
      state.panY += y;
      state.applyTransform();
    };
    if (event.key === "ArrowLeft") pan(DIAGRAM_KEYBOARD_PAN_PX, 0);
    else if (event.key === "ArrowRight") pan(-DIAGRAM_KEYBOARD_PAN_PX, 0);
    else if (event.key === "ArrowUp") pan(0, DIAGRAM_KEYBOARD_PAN_PX);
    else if (event.key === "ArrowDown") pan(0, -DIAGRAM_KEYBOARD_PAN_PX);
    else if (["+", "="].includes(event.key)) {
      stopDiagramControlEvent(event);
      state.applyScale(state.scale * DIAGRAM_ZOOM_FACTOR);
    } else if (event.key === "-") {
      stopDiagramControlEvent(event);
      state.applyScale(state.scale / DIAGRAM_ZOOM_FACTOR);
    } else if (event.key === "0") {
      stopDiagramControlEvent(event);
      state.reset();
    }
  });

  return state;
}

/**
 * Open the diagram in a viewer. The viewer owns a clone of the SVG, so the
 * figure in the document is never moved, re-parented, or left behind in a
 * transformed state — which is what made an edit above a diagram lose its
 * zoom before. Closing it disposes every listener it installed.
 */
export function openDiagramLightbox(origin: HTMLElement): void {
  const svg = currentDiagramSvg(origin);
  if (!svg) return;
  openLightbox?.state.close();

  const overlay = document.createElement("div");
  overlay.className = "cm-editor cm-diagram-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Expanded diagram");
  overlay.setAttribute("data-aaronnote-vim", "native");
  overlay.setAttribute("data-noema-gesture-scope", "diagram");

  const stage = document.createElement("div");
  stage.className = "cm-diagram-interactive cm-diagram-stage";
  if (origin.classList.contains("cm-aaron-mindmap")) stage.classList.add("cm-aaron-mindmap");
  stage.tabIndex = 0;
  stage.style.touchAction = "none";
  stage.append(svg.cloneNode(true) as SVGSVGElement);
  overlay.append(stage);
  document.body.append(overlay);
  document.body.classList.add("has-diagram-fullscreen");

  sanitizeDiagramLinks(stage);
  const stageSvg = currentDiagramSvg(stage);
  if (stageSvg) configureDiagramSvg(stageSvg, stage);

  const state = bindDiagramInteraction(stage);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || openLightbox?.state !== state) return;
    event.preventDefault();
    event.stopPropagation();
    state.close();
  };
  openLightbox = { overlay, stage, state, origin, onKeyDown };
  document.addEventListener("keydown", onKeyDown, true);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) state.close();
  });

  installDiagramToolbar(stage, state);
  stage.focus({ preventScroll: true });
  const schedule = window.requestAnimationFrame?.bind(window)
    ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  schedule(() => {
    if (openLightbox?.state === state) state.fit();
  });
}

/**
 * Lay a rendered diagram out as a figure: intrinsic size, capped at the text
 * measure, no fixed viewport and no input handlers. GitHub and Gitea render a
 * Mermaid block the same way, and it is what keeps a click on the figure
 * reaching CodeMirror so the fence's source opens.
 */
export function presentDiagramFigure(element: HTMLElement): void {
  hydrateDiagramForeignObjects(element);
  const svg = currentDiagramSvg(element);
  if (!svg) return;

  element.classList.add("cm-diagram-figure");
  element.classList.remove("cm-diagram-interactive");
  element.removeAttribute("style");
  svg.style.removeProperty("transform");
  svg.style.removeProperty("touch-action");
  svg.style.maxWidth = "100%";
  svg.style.maxHeight = "none";
  svg.style.height = "auto";
  svg.style.removeProperty("width");
  sanitizeDiagramLinks(element);

  // The only event the figure claims: a link inside the diagram still routes
  // through the host so it opens where other Noema links open. Every other
  // click is left alone and reaches CodeMirror.
  if (element.dataset.diagramLinksBound !== "true") {
    element.dataset.diagramLinksBound = "true";
    element.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest<SVGElement>("a");
      if (!anchor) return;
      const href = diagramHrefFromAnchor(anchor);
      if (href) dispatchDiagramLink(element, event, href);
    });
  }

  Array.from(element.children).forEach((child) => {
    if (child instanceof HTMLElement && child.classList.contains("cm-diagram-expand")) child.remove();
  });
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "cm-diagram-expand";
  expand.textContent = "⤢";
  expand.title = "Open the diagram viewer";
  expand.setAttribute("aria-label", expand.title);
  // The figure belongs to the document: only this button takes the event, so
  // every other click still places the caret and reveals the source.
  expand.addEventListener("mousedown", stopDiagramControlEvent);
  expand.addEventListener("pointerdown", stopDiagramControlEvent);
  expand.addEventListener("click", (event) => {
    stopDiagramControlEvent(event);
    openDiagramLightbox(element);
  });
  element.append(expand);
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
      presentDiagramFigure(element);
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
      if (trimmed.includes("$$")) ensureMathStyles();
      // A diagram's own colours are its content, so Mermaid keeps its palette and
      // only the sheet the figure sits on follows the editor theme. Aaron mindmap
      // (marmind/markmind): antiscript lets the per-diagram frontmatter
      // ---config--- block take effect (strict blocks it). DOMPurify is our
      // sanitizer anyway. Interactive diagrams keep strict for defence-in-depth.
      if (staticMindmap) {
        mermaid.initialize({ startOnLoad: false, securityLevel: "antiscript", legacyMathML: true });
      } else {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", legacyMathML: true });
      }
      const id = `aaronnote-mermaid-${Date.now()}-${seq}`;
      const result = await mermaid.render(id, renderSource);
      if (element.getAttribute("data-diagram-render-key") !== key || !element.isConnected) return;
      const html = sanitizeDiagramSvg(result.svg);
      rememberMermaid(key, { html });
      element.innerHTML = html;
      presentDiagramFigure(element);
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
