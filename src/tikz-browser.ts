import DOMPurify from "dompurify";

import { normalizeTikzSource, tikzSourceHash } from "./tikz-render.ts";

export type BrowserTikzResult = {
  ok: boolean;
  svg?: string;
  intrinsic?: { widthEm: number; heightEm: number };
  message?: string;
};

type CachedRender = { key: string; svg: string; createdAt: number };
type WorkerReply = { id: number; svg?: string; error?: string };

const RENDER_VERSION = "tikz-editor-be197d85";
const MEMORY_LIMIT = 128;
const DISK_LIMIT = 256;
const memory = new Map<string, BrowserTikzResult>();
const pending = new Map<string, Promise<BrowserTikzResult>>();
const workerRequests = new Map<number, {
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
}>();
let nextRequestId = 0;
let worker: Worker | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let testRenderer: ((source: string) => Promise<string>) | null = null;

function cacheKey(source: string): string {
  return `${RENDER_VERSION}:${tikzSourceHash(source)}`;
}

function remember(key: string, result: BrowserTikzResult): void {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, result);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}

function openCache(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open("noema-tikz-render-cache", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("renders")) {
          db.createObjectStore("renders", { keyPath: "key" }).createIndex("createdAt", "createdAt");
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function readCache(key: string): Promise<string | null> {
  const db = await openCache();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction("renders", "readonly").objectStore("renders").get(key);
      request.onsuccess = () => resolve((request.result as CachedRender | undefined)?.svg ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeCache(key: string, svg: string): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    try {
      const transaction = db.transaction("renders", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("TikZ cache write failed"));
      transaction.onabort = () => reject(transaction.error || new Error("TikZ cache write aborted"));
      const store = transaction.objectStore("renders");
      store.put({ key, svg, createdAt: Date.now() } satisfies CachedRender);
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - DISK_LIMIT;
        if (excess <= 0) return;
        const cursor = store.index("createdAt").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry || excess <= 0) return;
          entry.delete();
          excess--;
          entry.continue();
        };
      };
    } catch (error) {
      reject(error);
    }
  });
}

function rejectWorkerRequests(error: Error): void {
  for (const request of workerRequests.values()) request.reject(error);
  workerRequests.clear();
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./tikz-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const request = workerRequests.get(reply.id);
    if (!request) return;
    workerRequests.delete(reply.id);
    if (reply.svg) request.resolve(reply.svg);
    else request.reject(new Error(reply.error || "TikZ rendering failed"));
  };
  worker.onerror = (event) => rejectWorkerRequests(new Error(event.message || "TikZ worker failed"));
  return worker;
}

function runWorker(source: string): Promise<string> {
  if (testRenderer) return testRenderer(source);
  return new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    try {
      workerRequests.set(id, { resolve, reject });
      getWorker().postMessage({ id, source });
    } catch (error) {
      workerRequests.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function intrinsicSize(svg: string): BrowserTikzResult["intrinsic"] {
  const raw = /\bviewBox=["']([^"']+)["']/i.exec(svg)?.[1];
  const numbers = raw?.trim().split(/[\s,]+/).map(Number) ?? [];
  const width = numbers[2];
  const height = numbers[3];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { widthEm: width / 10, heightEm: height / 10 };
}

function fromSvg(svg: string): BrowserTikzResult {
  return { ok: true, svg, intrinsic: intrinsicSize(svg) };
}

/** One render per source/version across figures and file opens on this origin. */
export function renderTikzBrowser(source: string): Promise<BrowserTikzResult> {
  const normalized = normalizeTikzSource(source);
  if (!normalized) return Promise.resolve({ ok: false, message: "Empty TikZ source" });
  const key = cacheKey(source);
  const hit = memory.get(key);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const request = (async () => {
    const stored = await readCache(key);
    if (stored) {
      const result = fromSvg(stored);
      remember(key, result);
      return result;
    }
    try {
      const svg = await runWorker(normalized);
      const result = fromSvg(svg);
      remember(key, result);
      await writeCache(key, svg).catch(() => {});
      return result;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  })();
  pending.set(key, request);
  void request.then(() => pending.delete(key), () => pending.delete(key));
  return request;
}

/** Render output is treated as untrusted markup before entering the note DOM. */
export function sanitizedTikzSvg(svg: string): string {
  return String(DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } }));
}

/** Freeze browser-rendered TikZ into a standalone document with no asset file. */
export async function inlineTikzFigures(html: string): Promise<string> {
  if (!html.includes("<noema-tikz")) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const figures = Array.from(parsed.querySelectorAll<HTMLElement>("noema-tikz[data-source]"));
  await Promise.all(figures.map(async (figure) => {
    const source = figure.dataset.source || "";
    const result = await renderTikzBrowser(source);
    if (result.ok && result.svg) {
      figure.innerHTML = sanitizedTikzSvg(result.svg);
      figure.querySelector("svg")?.classList.add("aaronnote-tikz-image");
      figure.removeAttribute("data-source");
      if (result.intrinsic) {
        figure.style.setProperty("--aaronnote-tikz-natural-width", `${result.intrinsic.widthEm}em`);
      }
    } else {
      figure.textContent = result.message || "TikZ rendering failed";
      figure.classList.add("is-tikz-error");
    }
  }));
  return `<!DOCTYPE html>\n${parsed.documentElement.outerHTML}`;
}

export function setTikzRendererForTests(renderer: ((source: string) => Promise<string>) | null): void {
  testRenderer = renderer;
  memory.clear();
  pending.clear();
}

function installTikzElement(): void {
  if (typeof window === "undefined" || !window.customElements || window.customElements.get("noema-tikz")) return;
  let visibilityObserver: IntersectionObserver | null = null;
  const hydrate = (figure: HTMLElement): void => {
    if (typeof Worker === "undefined" && !testRenderer) return;
    const source = figure.dataset.source || "";
    if (!source || figure.dataset.rendered === "true") return;
    void renderTikzBrowser(source).then((result) => {
      if (!figure.isConnected || figure.dataset.source !== source) return;
      if (result.ok && result.svg) {
        figure.innerHTML = sanitizedTikzSvg(result.svg);
        figure.querySelector("svg")?.classList.add("aaronnote-tikz-image");
        figure.dataset.rendered = "true";
        figure.removeAttribute("data-source");
        if (result.intrinsic) {
          figure.style.setProperty("--aaronnote-tikz-natural-width", `${result.intrinsic.widthEm}em`);
        }
      } else {
        figure.textContent = result.message || "TikZ rendering failed";
        figure.classList.add("is-tikz-error");
      }
    });
  };
  class NoemaTikzElement extends HTMLElement {
    connectedCallback(): void {
      if (!this.dataset.source || this.dataset.rendered === "true") return;
      if (typeof IntersectionObserver === "undefined") {
        hydrate(this);
        return;
      }
      visibilityObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          visibilityObserver?.unobserve(entry.target);
          hydrate(entry.target as HTMLElement);
        }
      }, { rootMargin: "400px 0px" });
      visibilityObserver.observe(this);
    }

    disconnectedCallback(): void {
      visibilityObserver?.unobserve(this);
    }
  }
  window.customElements.define("noema-tikz", NoemaTikzElement);
}

installTikzElement();
