import { highlightCode, type CodeHighlightRange } from "./code-highlight.ts";

type HighlightResponse = {
  id: number;
  ranges: CodeHighlightRange[];
};

const WORKER_HIGHLIGHT_THRESHOLD = 12_000;
const ASYNC_CACHE_LIMIT = 192;
const ASYNC_CACHE_BYTES = 8_000_000; // 8 MB

const asyncCache = new Map<string, CodeHighlightRange[]>();
const pending = new Map<number, string>();
const pendingKeys = new Set<string>();
const listeners = new Set<() => void>();
let worker: Worker | null | undefined;
let nextRequestId = 1;
let readyVersion = 0;
let asyncCacheBytes = 0;

function asyncEntryBytes(ranges: CodeHighlightRange[]): number {
  return ranges.length * 48;
}

function cacheKey(lang: string, text: string): string {
  return `${lang.trim().toLowerCase()}\u0000${text}`;
}

function remember(key: string, ranges: CodeHighlightRange[]): CodeHighlightRange[] {
  if (asyncCache.has(key)) return ranges;
  asyncCache.set(key, ranges);
  asyncCacheBytes += asyncEntryBytes(ranges);
  while (asyncCache.size > ASYNC_CACHE_LIMIT || asyncCacheBytes > ASYNC_CACHE_BYTES) {
    const oldest = asyncCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    const old = asyncCache.get(oldest)!;
    asyncCacheBytes -= asyncEntryBytes(old);
    asyncCache.delete(oldest);
  }
  return ranges;
}

function notifyReady(): void {
  readyVersion++;
  for (const listener of listeners) listener();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(new URL("./code-highlight-worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
      const key = pending.get(event.data.id);
      if (!key) return;
      pending.delete(event.data.id);
      pendingKeys.delete(key);
      remember(key, event.data.ranges);
      notifyReady();
    });
    worker.addEventListener("error", () => {
      for (const key of pending.values()) pendingKeys.delete(key);
      pending.clear();
      worker?.terminate();
      worker = null;
    });
  } catch {
    worker = null;
  }
  return worker;
}

export function onCodeHighlightReady(listener: () => void): () => void {
  listeners.add(listener);
  if (readyVersion > 0) void Promise.resolve().then(listener);
  return () => listeners.delete(listener);
}

export function highlightCodeForEditor(lang: string, text: string): CodeHighlightRange[] {
  if (text.length < WORKER_HIGHLIGHT_THRESHOLD) return highlightCode(lang, text);

  const key = cacheKey(lang, text);
  const cached = asyncCache.get(key);
  if (cached) {
    asyncCache.delete(key);
    asyncCache.set(key, cached);
    return cached;
  }

  const backgroundWorker = getWorker();
  if (!backgroundWorker) return highlightCode(lang, text);
  if (!pendingKeys.has(key)) {
    const id = nextRequestId++;
    pending.set(id, key);
    pendingKeys.add(key);
    backgroundWorker.postMessage({ id, lang, text });
  }
  return [];
}

export function disposeHighlightWorker(): void {
  worker?.terminate();
  worker = undefined; // reset to "not initialized" so next call recreates it
  for (const key of pending.values()) pendingKeys.delete(key);
  pending.clear();
  pendingKeys.clear();
  listeners.clear();
  asyncCache.clear();
  asyncCacheBytes = 0;
  readyVersion = 0;
}
