import katex from "katex";
import katexCssText from "katex/dist/katex.min.css?inline";
import { getKatexMacros, getKatexMacrosVersion, type KatexMacroMap } from "./katex-macros.ts";

type KatexRenderOptions = {
  displayMode?: boolean;
  throwOnError?: boolean;
  strict?: boolean | "error" | "ignore" | "warn";
  trust?: boolean;
  output?: "html" | "mathml" | "htmlAndMathml";
  deferUntilIdle?: boolean;
  macros?: KatexMacroMap;
};

const mathHtmlCache = new Map<string, { html: string; error?: string }>();
const MATH_HTML_CACHE_LIMIT = 512;
const MATH_HTML_CACHE_BYTES = 4_000_000; // 4 MB
export const MATH_RENDER_ERROR_MAX_LENGTH = 320;
let mathHtmlCacheBytes = 0;

export function formatMathRenderError(error: unknown, maxLength = MATH_RENDER_ERROR_MAX_LENGTH): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.replace(/\s+/g, " ").trim() || "Math render failed";
  if (message.length <= maxLength) return message;
  return `${message.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function mathHtmlEntryBytes(v: { html: string; error?: string }): number {
  return (v.html.length + (v.error?.length ?? 0)) * 2;
}

function cachedMathHtml(key: string): { html: string; error?: string } | undefined {
  const cached = mathHtmlCache.get(key);
  if (!cached) return undefined;
  mathHtmlCache.delete(key);
  mathHtmlCache.set(key, cached);
  return cached;
}

function rememberMathHtml(key: string, value: { html: string; error?: string }): void {
  if (mathHtmlCache.has(key)) return;
  mathHtmlCache.set(key, value);
  mathHtmlCacheBytes += mathHtmlEntryBytes(value);
  while (mathHtmlCache.size > MATH_HTML_CACHE_LIMIT || mathHtmlCacheBytes > MATH_HTML_CACHE_BYTES) {
    const oldest = mathHtmlCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    const old = mathHtmlCache.get(oldest)!;
    mathHtmlCacheBytes -= mathHtmlEntryBytes(old);
    mathHtmlCache.delete(oldest);
  }
}

export function clearMathRenderCache(): void {
  mathHtmlCache.clear();
  mathHtmlCacheBytes = 0;
}

export function mathRenderCacheSize(): number {
  return mathHtmlCache.size;
}

export function disposeMathRuntime(): void {
  clearMathRenderCache();
  if (typeof document !== "undefined") {
    document.querySelectorAll<HTMLStyleElement>("style[data-aaronnote-katex-css]").forEach((style) => style.remove());
    document.querySelectorAll<HTMLLinkElement>("link[data-aaronnote-katex-css]").forEach((link) => link.remove());
  }
}

// The active macro set is part of the rendered output, so it must be part of the
// cache key — otherwise changing macros would serve stale HTML.
function mathOutputMode(options: KatexRenderOptions): "html" | "mathml" | "htmlAndMathml" {
  return options.output ?? "mathml";
}

function mathCacheKey(tex: string, options: KatexRenderOptions): string {
  return `${getKatexMacrosVersion()}\n${options.displayMode ? "display" : "inline"}\n${mathOutputMode(options)}\n${tex}`;
}

export function renderMathHTML(
  tex: string,
  options: KatexRenderOptions,
): { html: string; error?: string } {
  const key = mathCacheKey(tex, options);
  const cached = cachedMathHtml(key);
  if (cached) {
    if (!cached.error) ensureKatexCss(katexCssText);
    return cached;
  }
  try {
    const resolved = katexOptions(options);
    const html = katex.renderToString(tex, resolved);
    ensureKatexCss(katexCssText);
    const rendered = { html };
    rememberMathHtml(key, rendered);
    return rendered;
  } catch (error) {
    return {
      html: "",
      error: formatMathRenderError(error),
    };
  }
}

export function renderMathLazy(
  tex: string,
  element: HTMLElement,
  options: KatexRenderOptions,
  onError: (error: string) => void,
): void {
  const key = mathCacheKey(tex, options);
  element.setAttribute("data-math-render-key", key);
  const cached = cachedMathHtml(key);
  if (cached) {
    applyRenderedMath(element, key, cached, onError);
    return;
  }
  if (options.deferUntilIdle === true) {
    element.textContent = tex;
    const idle = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 16));
    idle(() => {
      if (element.getAttribute("data-math-render-key") !== key || !element.isConnected) return;
      applyRenderedMath(element, key, renderMathHTML(tex, options), onError);
    }, { timeout: 500 });
    return;
  }
  applyRenderedMath(element, key, renderMathHTML(tex, options), onError);
}

function applyRenderedMath(
  element: HTMLElement,
  key: string,
  rendered: { html: string; error?: string },
  onError: (error: string) => void,
): void {
  if (!rendered.error) {
    element.innerHTML = rendered.html;
    fitRenderedMath(element);
    return;
  }
  if (element.getAttribute("data-math-render-key") !== key) return;
  onError(formatMathRenderError(rendered.error));
  rememberMathHtml(key, rendered);
  fitRenderedMath(element);
}

function katexOptions(options: KatexRenderOptions): KatexRenderOptions {
  // Pass a shallow copy of the macro map: KaTeX mutates it in place when the TeX
  // uses \gdef/\global\def, and we must not leak one note's globals into the
  // shared environment.
  return {
    displayMode: options.displayMode,
    throwOnError: true,
    strict: options.strict,
    trust: options.trust,
    output: mathOutputMode(options),
    macros: { ...(options.macros ?? getKatexMacros()) },
  };
}

function ensureKatexCss(css: string): void {
  if (typeof document === "undefined") return;
  if (document.querySelector("link[data-aaronnote-katex-css], style[data-aaronnote-katex-css]")) return;
  const link = document.createElement("link");
  link.dataset.aaronnoteKatexCss = "embedded";
  link.rel = "stylesheet";
  link.href = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
  document.head.appendChild(link);
}

function fitRenderedMath(element: HTMLElement): void {
  const schedule = window.requestAnimationFrame?.bind(window) ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
  schedule(() => {
    if (!element.isConnected) return;
    const child = firstRenderableChild(element);
    if (!child) return;
    child.style.transform = "";
    child.style.transformOrigin = "";
    child.style.display = "";
    child.style.maxWidth = "";
    element.style.minHeight = "";
    element.classList.remove("is-math-scaled");

    const available = Math.max(1, element.clientWidth || element.parentElement?.clientWidth || window.innerWidth - 32);
    const natural = Math.max(child.scrollWidth, child.getBoundingClientRect().width);
    if (!Number.isFinite(natural) || natural <= available) return;

    const scale = Math.max(0.54, Math.min(1, (available - 2) / natural));
    if (scale >= 0.995) return;
    child.style.display = "inline-block";
    child.style.transform = `scale(${scale})`;
    child.style.transformOrigin = "center top";
    child.style.maxWidth = `${100 / scale}%`;
    element.classList.add("is-math-scaled");

    const height = child.getBoundingClientRect().height;
    if (height > 0) element.style.minHeight = `${Math.ceil(height)}px`;
  });
}

function firstRenderableChild(element: HTMLElement): HTMLElement | null {
  const preferred = element.querySelector<HTMLElement>(".katex-display, .katex, math, mjx-container");
  if (preferred) return preferred;
  return element.firstElementChild instanceof HTMLElement ? element.firstElementChild : null;
}
