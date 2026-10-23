/**
 * Lifecycle of an embedded HTML document (`![](page.html)`).
 *
 * An embed is a whole document with its own script runtime, so its cost is
 * not the frame's pixels but what runs inside it. The controller gives every
 * embed one explicit lifetime:
 *
 *   pending  — the frame exists, sized, with no document. Nothing runs.
 *   live     — the document is loaded; it is near the viewport.
 *   parked   — the document was unloaded (`about:blank`) after it stayed off
 *              screen, or the pane stayed hidden, for a while. Coming back
 *              into view reloads it.
 *
 * Loading waits for the frame to come near the viewport (one shared
 * IntersectionObserver for all embeds), parking is driven by that observer
 * and by the renderer activity gate, and disposal releases the observer
 * entry, timers, full-screen state and the shared `message` listener when the
 * last embed goes.
 *
 * The embedded page may talk to Noema with `parent.postMessage`:
 *
 *   { type: "noema:open-url", href: "roam://<id>", newWindow?: boolean }
 *   { type: "noema:resize", height: <px> }        // ignored with an explicit height
 *   { type: "noema:fullscreen", on?: boolean }    // omitted `on` toggles
 *
 * Messages are accepted only from the frame's own window.
 */

import type { RendererActivityParticipant, RendererActivityState } from "./renderer-activity.ts";
import { safeHref } from "./url-safety.ts";

export const HTML_EMBED_PARK_OFFSCREEN_MS = 90_000;
export const HTML_EMBED_PARK_HIDDEN_MS = 60_000;
export const HTML_EMBED_VIEWPORT_MARGIN = "600px 0px";
const BLANK = "about:blank";
const BAR_HEIGHT = 30;
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 6000;

export type HtmlEmbedState = "pending" | "live" | "parked";

export interface HtmlEmbedOptions {
  /** The resolved document URL. */
  src: string;
  /** Shown in the full-screen bar. */
  title: string;
  /** The figure the embed lives in; opened links are dispatched from it. */
  container: HTMLElement;
  /** A height written in the note wins over the page's own resize requests. */
  explicitHeight?: boolean;
  /** Called after the page resized its frame, so the editor can re-measure. */
  onResize?: () => void;
  /** How a URL is put on the frame. Tests substitute an attribute. */
  setSource?: (frame: HTMLIFrameElement, src: string) => void;
}

export interface HtmlEmbedHandle {
  state(): HtmlEmbedState;
  toggleFullscreen(on?: boolean): void;
  dispose(): void;
}

interface FullscreenSession {
  /** The frame on screen: the embed itself, or a body-level copy. */
  frame: HTMLIFrameElement;
  copied: boolean;
  bar: HTMLElement;
  controller: AbortController;
  returnFocus: Element | null;
}

interface EmbedRecord {
  frame: HTMLIFrameElement;
  options: HtmlEmbedOptions;
  state: HtmlEmbedState;
  visible: boolean;
  parkTimer: ReturnType<typeof setTimeout> | null;
  fullscreen: FullscreenSession | null;
}

const records = new Map<HTMLIFrameElement, EmbedRecord>();
let observer: IntersectionObserver | null = null;
let rendererHidden = false;
let activeFullscreen: EmbedRecord | null = null;

function defaultSetSource(frame: HTMLIFrameElement, src: string): void {
  frame.setAttribute("src", src);
}

function setState(record: EmbedRecord, state: HtmlEmbedState): void {
  record.state = state;
  record.frame.dataset.embedState = state;
}

function clearPark(record: EmbedRecord): void {
  if (record.parkTimer !== null) clearTimeout(record.parkTimer);
  record.parkTimer = null;
}

function load(record: EmbedRecord): void {
  clearPark(record);
  if (record.state === "live") return;
  (record.options.setSource ?? defaultSetSource)(record.frame, record.options.src);
  setState(record, "live");
}

function park(record: EmbedRecord): void {
  clearPark(record);
  if (record.state !== "live" || record.fullscreen) return;
  (record.options.setSource ?? defaultSetSource)(record.frame, BLANK);
  setState(record, "parked");
}

function schedulePark(record: EmbedRecord, delay: number): void {
  if (record.state !== "live" || record.fullscreen || record.parkTimer !== null) return;
  record.parkTimer = setTimeout(() => {
    record.parkTimer = null;
    if (!records.has(record.frame)) return;
    if (rendererHidden || !record.visible) park(record);
  }, delay);
}

function onIntersection(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const record = records.get(entry.target as HTMLIFrameElement);
    if (!record) continue;
    record.visible = entry.isIntersecting;
    if (record.visible) {
      clearPark(record);
      if (!rendererHidden) load(record);
    } else {
      schedulePark(record, HTML_EMBED_PARK_OFFSCREEN_MS);
    }
  }
}

function recordForSource(source: MessageEventSource | null): EmbedRecord | null {
  if (!source) return null;
  for (const record of records.values()) {
    if (record.frame.contentWindow === source || record.fullscreen?.frame.contentWindow === source) return record;
  }
  return null;
}

function onMessage(event: MessageEvent): void {
  const record = recordForSource(event.source);
  if (!record) return;
  const data = event.data as { type?: unknown; href?: unknown; newWindow?: unknown; height?: unknown; on?: unknown } | null;
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  switch (data.type) {
    case "noema:open-url": {
      const href = typeof data.href === "string" ? data.href.trim() : "";
      if (!href || href.length > 4096 || !safeHref(href) || !record.options.container.isConnected) return;
      const newWindow = data.newWindow === true;
      if (!newWindow) exitFullscreen(record);
      record.options.container.dispatchEvent(new CustomEvent("noema:open-url", {
        bubbles: true, cancelable: true, detail: { href, newWindow },
      }));
      break;
    }
    case "noema:resize": {
      const height = Number(data.height);
      if (record.options.explicitHeight || record.fullscreen || !Number.isFinite(height)) return;
      const next = `${Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)))}px`;
      if (record.frame.style.height === next) return;
      record.frame.style.height = next;
      record.frame.style.maxHeight = "none";
      record.options.onResize?.();
      break;
    }
    case "noema:fullscreen":
      toggleFullscreen(record, typeof data.on === "boolean" ? data.on : undefined);
      break;
    default:
      break;
  }
}

function ensureShared(): void {
  if (records.size !== 1) return;
  window.addEventListener("message", onMessage);
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(onIntersection, { rootMargin: HTML_EMBED_VIEWPORT_MARGIN });
  }
}

function releaseShared(): void {
  if (records.size !== 0) return;
  window.removeEventListener("message", onMessage);
  observer?.disconnect();
  observer = null;
}

// ---------------------------------------------------------------------------
// Full screen
// ---------------------------------------------------------------------------

function copyFrame(original: HTMLIFrameElement, src: string, setSource: (frame: HTMLIFrameElement, src: string) => void): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  for (const name of ["sandbox", "allow", "referrerpolicy", "title"]) {
    const value = original.getAttribute(name);
    if (value !== null) frame.setAttribute(name, value);
  }
  setSource(frame, src);
  return frame;
}

/**
 * Promote the live frame in place, which keeps the page's state. If an
 * ancestor makes `position: fixed` relative to itself, the promoted frame does
 * not cover the viewport; then a copy is shown from the body instead and the
 * inline frame is parked meanwhile, so two runtimes never run at once.
 */
function enterFullscreen(record: EmbedRecord): void {
  if (record.fullscreen) return;
  if (activeFullscreen && activeFullscreen !== record) exitFullscreen(activeFullscreen);
  const setSource = record.options.setSource ?? defaultSetSource;
  const controller = new AbortController();
  const bar = document.createElement("div");
  bar.className = "noema-embed-fullscreen-bar";
  bar.setAttribute("role", "toolbar");
  const title = document.createElement("strong");
  title.textContent = record.options.title || "HTML";
  const hint = document.createElement("span");
  hint.textContent = "Esc · exit";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.title = "Exit full screen (Esc)";
  close.setAttribute("aria-label", "Exit full screen");
  close.addEventListener("click", () => exitFullscreen(record), { signal: controller.signal });
  bar.append(title, hint, close);
  document.body.append(bar);
  document.body.classList.add("has-diagram-fullscreen");

  load(record);
  // The promoted frame leaves the flow; hold the figure's height so the
  // editor's height map, and the reader's scroll position, stay put.
  const container = record.options.container;
  const held = container.getBoundingClientRect().height;
  if (held > 0) container.style.minHeight = `${held}px`;
  record.frame.classList.add("noema-embed-fullscreen");
  let frame = record.frame;
  let copied = false;
  const rect = frame.getBoundingClientRect();
  const covers = Math.abs(rect.top - BAR_HEIGHT) <= 2 && Math.abs(rect.left) <= 2
    && Math.abs(rect.width - document.documentElement.clientWidth) <= 4;
  if (!covers && rect.width > 0) {
    record.frame.classList.remove("noema-embed-fullscreen");
    frame = copyFrame(record.frame, record.options.src, setSource);
    frame.classList.add("noema-embed-fullscreen");
    document.body.append(frame);
    copied = true;
    setSource(record.frame, BLANK);
    setState(record, "parked");
  }
  record.fullscreen = { frame, copied, bar, controller, returnFocus: document.activeElement };
  activeFullscreen = record;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    exitFullscreen(record);
  }, { capture: true, signal: controller.signal });
  frame.focus({ preventScroll: true });
}

function exitFullscreen(record: EmbedRecord): void {
  const session = record.fullscreen;
  if (!session) return;
  record.fullscreen = null;
  if (activeFullscreen === record) activeFullscreen = null;
  session.controller.abort();
  session.bar.remove();
  record.options.container.style.removeProperty("min-height");
  if (session.copied) {
    session.frame.remove();
    if (record.visible && !rendererHidden) load(record);
  } else {
    record.frame.classList.remove("noema-embed-fullscreen");
  }
  if (!activeFullscreen) document.body.classList.remove("has-diagram-fullscreen");
  if (session.returnFocus instanceof HTMLElement && session.returnFocus.isConnected) {
    session.returnFocus.focus({ preventScroll: true });
  }
  if (!record.visible || rendererHidden) schedulePark(record, rendererHidden ? HTML_EMBED_PARK_HIDDEN_MS : HTML_EMBED_PARK_OFFSCREEN_MS);
}

function toggleFullscreen(record: EmbedRecord, on?: boolean): void {
  const next = on ?? !record.fullscreen;
  if (next) enterFullscreen(record);
  else exitFullscreen(record);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mountHtmlEmbed(frame: HTMLIFrameElement, options: HtmlEmbedOptions): HtmlEmbedHandle {
  const existing = records.get(frame);
  if (existing) disposeRecord(existing);
  const record: EmbedRecord = { frame, options, state: "pending", visible: false, parkTimer: null, fullscreen: null };
  setState(record, "pending");
  records.set(frame, record);
  ensureShared();
  if (observer) observer.observe(frame);
  else {
    // No observer (tests, very old engines): behave like an eager frame.
    record.visible = true;
    if (!rendererHidden) load(record);
  }
  return {
    state: () => record.state,
    toggleFullscreen: (on?: boolean) => { if (records.get(frame) === record) toggleFullscreen(record, on); },
    dispose: () => { if (records.get(frame) === record) disposeRecord(record); },
  };
}

function disposeRecord(record: EmbedRecord): void {
  exitFullscreen(record);
  clearPark(record);
  observer?.unobserve(record.frame);
  records.delete(record.frame);
  releaseShared();
}

/** Park every live embed once the pane has been hidden for a while. */
export function htmlEmbedActivityParticipant(): RendererActivityParticipant {
  return {
    setActivity(state: RendererActivityState): void {
      const hidden = state === "hidden" || state === "destroyed";
      if (hidden === rendererHidden && state !== "destroyed") return;
      rendererHidden = hidden;
      for (const record of records.values()) {
        if (state === "destroyed") park(record);
        else if (hidden) schedulePark(record, HTML_EMBED_PARK_HIDDEN_MS);
        else if (record.visible) load(record);
        else { clearPark(record); schedulePark(record, HTML_EMBED_PARK_OFFSCREEN_MS); }
      }
    },
  };
}

/** Diagnostics and tests: the embeds the controller currently owns. */
export function htmlEmbedCount(): number {
  return records.size;
}
