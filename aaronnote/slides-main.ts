// Standalone, read-only slides page. This entry intentionally does not import
// main.ts, slide-deck.ts, Editor, Jupyter, cursor state, or mirror APIs.
import "../src/styles/widgets.css";
import "../src/styles/theme-typora.css";
import "../src/styles/typography.css";
import "./style.css";

import { setKatexMacros } from "../src/katex-macros.ts";
import { api } from "./api-client.ts";
import {
  createSlidePresentation,
  initialSlideTheme,
  type SlidePresentationController,
} from "./slide-presentation.ts";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app");
const file = new URLSearchParams(window.location.search).get("file") || "";
let presentation: SlidePresentationController | null = null;
let viewer: HTMLElement | null = null;
let loadGeneration = 0;
let reloadTimer = 0;
let destroyed = false;
let refreshWhenVisible = false;

window.AaronnoteCurrentFile = () => file;

function showError(message: string): void {
  const error = document.createElement("main");
  error.className = "aaronnote-slide-view-error";
  error.innerHTML = `<h1>Slides unavailable</h1><p></p>`;
  error.querySelector("p")!.textContent = message;
  if (!presentation) root.replaceChildren(error);
}

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  if (!file) {
    showError("Missing ?file= path");
    return;
  }
  try {
    const opened = await api.notes.open(file);
    if (destroyed || generation !== loadGeneration) return;
    const markdown = String(opened.content || "");
    document.title = `${file.split(/[\\/]/).at(-1) || "Slides"} — Slides`;
    if (presentation) presentation.update(markdown);
    else {
      viewer = document.createElement("div");
      viewer.className = "aaronnote-reveal-view aaronnote-basic-slide-view";
      viewer.dataset.theme = initialSlideTheme();
      viewer.tabIndex = -1;
      root.replaceChildren(viewer);
      presentation = createSlidePresentation({
        root: viewer,
        markdown,
        wholeDocumentFallback: true,
      });
    }
  } catch (error) {
    if (destroyed || generation !== loadGeneration) return;
    showError(error instanceof Error ? error.message : "Unable to read slides");
  }
}

function scheduleReload(): void {
  if (document.hidden) {
    refreshWhenVisible = true;
    return;
  }
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => { void load(); }, 120);
}

const lifecycle = new AbortController();
window.addEventListener("aaronnote:command", (event) => {
  const detail = (event as CustomEvent<{ command?: string; file?: string }>).detail;
  if (detail?.command === "note-saved" && detail.file === file) scheduleReload();
  else if (detail?.command === "notes-index-changed") scheduleReload();
}, { signal: lifecycle.signal });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && refreshWhenVisible) {
    refreshWhenVisible = false;
    scheduleReload();
  }
}, { signal: lifecycle.signal });
window.addEventListener("storage", (event) => {
  if (event.key === "aaronnote.slides.theme" && viewer) viewer.dataset.theme = initialSlideTheme();
}, { signal: lifecycle.signal });

function destroy(): void {
  if (destroyed) return;
  destroyed = true;
  loadGeneration += 1;
  window.clearTimeout(reloadTimer);
  lifecycle.abort();
  presentation?.destroy();
  presentation = null;
  viewer?.remove();
  viewer = null;
}

window.addEventListener("pagehide", (event) => {
  // A bfcache page is frozen, not closed. Keep its Reveal instance so Back
  // restores a live presentation; a real unload still performs full cleanup.
  if (!event.persisted) destroy();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !destroyed) scheduleReload();
});
window.addEventListener("beforeunload", destroy, { once: true });

void (async () => {
  try {
    const macros = await api.config.katexMacros();
    if (macros.macros) setKatexMacros(macros.macros);
  } catch {
    // Optional: plain KaTeX remains usable.
  }
  if (!destroyed) {
    await load();
    // The opener may still be flushing a dirty ordinary Markdown note. Its
    // save event normally refreshes us; this covers the startup race where
    // that event was broadcast before this page installed its listener.
    window.setTimeout(() => {
      if (!destroyed) void load();
    }, 500);
  }
})();
