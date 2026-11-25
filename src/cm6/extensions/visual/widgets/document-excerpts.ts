import type { EditorView } from "@codemirror/view";
import { api, type NoteCodeExcerpt } from "../../../../../pages/api-client.ts";
import { renderHighlightedCode } from "../../../../code-highlight-dom.ts";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";

type ExcerptRequest = { notePath: string; path: string; lines?: string; region?: string; section?: string; symbol?: string; context?: string; lang?: string };

const connected = new WeakSet<HTMLElement>();
const requests = new Map<string, Promise<NoteCodeExcerpt>>();
const recent = new Map<string, { value: NoteCodeExcerpt; expiresAt: number }>();
let recentSize = 0;

export function currentNotePath(): string {
  if (window.NoemaCurrentFile) return window.NoemaCurrentFile();
  return new URLSearchParams(window.location.search).get("file") || "";
}

function readExcerpt(request: ExcerptRequest, refresh: boolean): Promise<NoteCodeExcerpt> {
  const key = JSON.stringify(request);
  const previous = recent.get(key);
  if (!refresh && previous && previous.expiresAt > Date.now()) return Promise.resolve(previous.value);
  const pending = requests.get(key);
  if (pending) return pending;
  const promise = api.noteCode.readExcerpt(request).then((value) => {
    const overwritten = recent.get(key);
    if (overwritten) recentSize -= overwritten.value.body.length;
    recent.delete(key);
    recent.set(key, { value, expiresAt: Date.now() + 1500 });
    recentSize += value.body.length;
    while (recent.size > 32 || recentSize > 2_000_000) {
      const first = recent.keys().next().value;
      if (first === undefined) break;
      recentSize -= recent.get(first)!.value.body.length;
      recent.delete(first);
    }
    return value;
  }).finally(() => requests.delete(key));
  requests.set(key, promise);
  return promise;
}

const deferredLoads = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

export function loadWhenVisible(node: HTMLElement, load: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    queueMicrotask(load);
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting && entry.target.isConnected) continue;
      observer?.unobserve(entry.target);
      const run = deferredLoads.get(entry.target);
      deferredLoads.delete(entry.target);
      if (entry.isIntersecting) run?.();
    }
  }, { rootMargin: "180px" });
  deferredLoads.set(node, load);
  observer.observe(node);
}

export function connectDocumentExcerpts(root: ParentNode, view: EditorView): void {
  for (const element of root.querySelectorAll<HTMLElement>(".noema-source-excerpt[data-excerpt-src]")) {
    if (connected.has(element)) continue;
    connected.add(element);
    const status = element.querySelector<HTMLElement>(".noema-excerpt-status");
    const fallback = element.querySelector<HTMLElement>(".noema-excerpt-fallback");
    const output = element.querySelector<HTMLElement>(".noema-excerpt-output");
    const lines = element.querySelector<HTMLElement>(".noema-excerpt-lines");
    const copy = element.querySelector<HTMLButtonElement>("[data-excerpt-copy]");
    const open = element.querySelector<HTMLButtonElement>("[data-excerpt-open]");
    const refresh = element.querySelector<HTMLButtonElement>("[data-excerpt-refresh]");
    if (!status || !fallback || !output || !lines || !copy || !open || !refresh) continue;
    const data = element.dataset;
    const attributes = { path: data.excerptSrc!, lines: data.excerptLines,
      region: data.excerptRegion, section: data.excerptSection, symbol: data.excerptSymbol, context: data.excerptContext, lang: data.excerptLang };
    let result: NoteCodeExcerpt | null = null;
    let resultNote = "";
    const load = async (fresh = false) => {
      if (!element.isConnected || refresh.disabled) return;
      const notePath = currentNotePath();
      refresh.disabled = true;
      copy.disabled = true;
      open.disabled = true;
      status.hidden = false;
      status.textContent = fresh ? "Refreshing source…" : "Loading source…";
      try {
        const loaded = await readExcerpt({ notePath, ...attributes }, fresh);
        if (!element.isConnected || notePath !== currentNotePath()) return;
        result = loaded;
        resultNote = notePath;
        lines.textContent = loaded.startLine === loaded.endLine ? `L${loaded.startLine}` : `L${loaded.startLine}–${loaded.endLine}`;
        const pre = document.createElement("pre");
        pre.className = "noema-excerpt-code";
        pre.tabIndex = 0;
        const code = document.createElement("code");
        renderHighlightedCode(code, loaded.body, loaded.language);
        pre.append(code);
        output.replaceChildren(pre);
        fallback.hidden = true;
        status.textContent = loaded.truncated ? "Preview limited to 200 lines." : "";
        status.hidden = !loaded.truncated;
        copy.disabled = false;
        copy.textContent = "Copy";
        open.disabled = false;
        open.title = `Open source at line ${loaded.startLine}`;
      } catch (error) {
        if (!element.isConnected || notePath !== currentNotePath()) return;
        result = null;
        lines.textContent = "";
        output.replaceChildren();
        fallback.hidden = false;
        status.textContent = error instanceof Error ? error.message : "The source could not be read.";
      } finally {
        refresh.disabled = false;
        if (element.isConnected) view.requestMeasure();
      }
    };
    refresh.addEventListener("click", () => { void load(true); });
    copy.addEventListener("click", () => {
      if (!result || resultNote !== currentNotePath()) return;
      void writeSystemClipboard(result.body).then((copied) => {
        if (copied && copy.isConnected) copy.textContent = "Copied";
      });
    });
    open.addEventListener("click", () => {
      if (!result || resultNote !== currentNotePath()) return;
      void api.emacs.open({ file: result.file, line: result.startLine }).catch((error: unknown) => {
        status.hidden = false;
        status.textContent = error instanceof Error ? error.message : "The source could not be opened.";
      });
    });
    loadWhenVisible(element, () => { void load(); });
  }
}
