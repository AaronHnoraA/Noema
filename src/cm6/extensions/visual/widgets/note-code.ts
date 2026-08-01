import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { MeasuredWidget } from "./measured-widget.ts";
import { api } from "../../../../../aaronnote/api-client.ts";
import { highlightCodeForEditor, onCodeHighlightReady } from "../../../../code-highlight-async.ts";
import { hasViewportDecorationRefresh, scheduleViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { parseNoteCodeLine } from "../../../../../shared/note-code.mjs";
import { sourceEditorName } from "../../../../../aaronnote/host-mode.ts";
import { desktopPlatformLabels } from "../../../../../shared/desktop-shell.mjs";

type NoteCodeLine = {
  commandFrom: number;
  commandTo: number;
  path: string;
  id: string;
};

type NoteCodeResult = {
  ok?: boolean;
  file?: string;
  path?: string;
  id?: string;
  body?: string;
  language?: string;
  mtimeMs?: number;
  size?: number;
  message?: string;
};

type NoteCodeCacheEntry = {
  value: NoteCodeResult;
  expiresAt: number;
  bytes: number;
};

const noteCodeCache = new Map<string, NoteCodeCacheEntry>();
const noteCodePending = new Map<string, Promise<NoteCodeResult>>();
const NOTE_CODE_CACHE_LIMIT = 64;
const NOTE_CODE_CACHE_BYTES = 8_000_000;
const NOTE_CODE_CACHE_TTL_MS = 1500;
let noteCodeCacheBytes = 0;

function currentNotePath(): string {
  try {
    return new URL(window.location.href).searchParams.get("file") || "";
  } catch {
    return "";
  }
}

function cacheKey(notePath: string, path: string, id: string): string {
  return `${notePath}\0${path}\0${id}`;
}

function entryBytes(value: NoteCodeResult): number {
  return String(value.body || "").length * 2 + 256;
}

function remember(key: string, value: NoteCodeResult): NoteCodeResult {
  const previous = noteCodeCache.get(key);
  if (previous) noteCodeCacheBytes -= previous.bytes;
  noteCodeCache.delete(key);
  const bytes = entryBytes(value);
  noteCodeCache.set(key, { value, bytes, expiresAt: Date.now() + NOTE_CODE_CACHE_TTL_MS });
  noteCodeCacheBytes += bytes;
  while (noteCodeCache.size > NOTE_CODE_CACHE_LIMIT || noteCodeCacheBytes > NOTE_CODE_CACHE_BYTES) {
    const oldest = noteCodeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const removed = noteCodeCache.get(oldest);
    noteCodeCache.delete(oldest);
    noteCodeCacheBytes -= removed?.bytes || 0;
  }
  return value;
}

function cached(key: string): NoteCodeResult | null {
  const item = noteCodeCache.get(key);
  if (!item) return null;
  if (item.expiresAt < Date.now()) {
    noteCodeCache.delete(key);
    noteCodeCacheBytes -= item.bytes;
    return null;
  }
  noteCodeCache.delete(key);
  noteCodeCache.set(key, item);
  return item.value;
}

function readRegion(notePath: string, path: string, id: string): Promise<NoteCodeResult> {
  const key = cacheKey(notePath, path, id);
  const found = cached(key);
  if (found) return Promise.resolve(found);
  const pending = noteCodePending.get(key);
  if (pending) return pending;
  const next = api.noteCode.readRegion({ notePath, path, id })
    .then((value) => remember(key, value))
    .finally(() => noteCodePending.delete(key));
  noteCodePending.set(key, next);
  return next;
}

function highlightedCode(code: string, language: string): HTMLElement {
  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  pre.append(codeEl);
  const ranges = highlightCodeForEditor(language, code);
  let pos = 0;
  for (const range of ranges) {
    if (range.from > pos) codeEl.append(document.createTextNode(code.slice(pos, range.from)));
    const span = document.createElement("span");
    span.className = range.className;
    span.textContent = code.slice(range.from, range.to);
    codeEl.append(span);
    pos = range.to;
  }
  if (pos < code.length) codeEl.append(document.createTextNode(code.slice(pos)));
  return pre;
}

function primaryOpenModifier(event: MouseEvent): boolean {
  if (event.metaKey && !event.ctrlKey) return true;
  return !/Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey;
}

class NoteCodeWidget extends MeasuredWidget {
  notePath: string;
  spec: NoteCodeLine;
  from: number;
  to: number;

  constructor(notePath: string, spec: NoteCodeLine, from: number, to: number) {
    super();
    this.notePath = notePath;
    this.spec = spec;
    this.from = from;
    this.to = to;
  }

  protected measureKey(): string {
    return `note-code:${this.notePath}:${this.spec.path}:${this.spec.id}`;
  }

  protected estimatedHeightFallback(): number { return 120; }

  eq(other: NoteCodeWidget): boolean {
    return this.notePath === other.notePath
      && this.spec.path === other.spec.path
      && this.spec.id === other.spec.id
      && this.from === other.from
      && this.to === other.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-note-code-widget";
    wrap.dataset.cmSourceFrom = String(this.from);
    wrap.dataset.cmSourceTo = String(this.to);
    wrap.dataset.cmOpenSource = "true";

    const header = document.createElement("div");
    header.className = "cm-note-code-header";
    const title = document.createElement("span");
    title.className = "cm-note-code-title";
    title.textContent = `${this.spec.path} [${this.spec.id}]`;
    header.append(title);

    const openBtn = document.createElement("button");
    let openFile = "";
    let openTag = "";
    openBtn.type = "button";
    openBtn.className = "cm-note-code-open-btn";
    const sourceEditor = sourceEditorName();
    const primaryModifier = desktopPlatformLabels(window.noemaDesktop?.platform || (/Mac/.test(navigator.platform) ? "darwin" : "")).primaryModifier;
    openBtn.textContent = `Open in ${sourceEditor}`;
    openBtn.title = `${primaryModifier}-click to open in ${sourceEditor}`;
    openBtn.setAttribute("aria-label", `${primaryModifier}-click to open in ${sourceEditor}`);
    openBtn.disabled = true;
    openBtn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    openBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!openFile || !primaryOpenModifier(event)) return;
      void api.emacs.open({ file: openFile, tag: openTag });
    });
    header.append(openBtn);

    wrap.append(header);

    const body = document.createElement("div");
    body.className = "cm-note-code-body";
    body.textContent = "Loading code...";
    wrap.append(body);

    void readRegion(this.notePath, this.spec.path, this.spec.id)
      .then((result) => {
        if (!wrap.isConnected) return;
        body.replaceChildren();
        if (!result.ok || typeof result.body !== "string") {
          wrap.classList.add("cm-note-code-error");
          body.textContent = result.message || "Code region not found";
        } else {
          body.append(highlightedCode(result.body, result.language || "lean4"));
          if (result.file) {
            openFile = String(result.file);
            openTag = this.spec.id;
            openBtn.disabled = false;
          }
        }
        scheduleViewportDecorationRefresh(view);
      })
      .catch((err) => {
        if (!wrap.isConnected) return;
        wrap.classList.add("cm-note-code-error");
        body.textContent = err instanceof Error ? err.message : "Code region load failed";
        scheduleViewportDecorationRefresh(view);
      });

    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(): boolean { return true; }
}

function buildNoteCodeDecos(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const sel = view.state.selection.main;
  const notePath = currentNotePath();
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      const parsed = parseNoteCodeLine(line.text) as NoteCodeLine | null;
      if (parsed) {
        const commandFrom = line.from + parsed.commandFrom;
        const commandTo = line.from + parsed.commandTo;
        const cursorInside = sel.from <= commandTo && sel.to >= commandFrom;
        if (!cursorInside) {
          decos.push(
            Decoration.replace({
              widget: new NoteCodeWidget(notePath, parsed, commandFrom, commandTo),
            }).range(commandFrom, commandTo),
          );
        }
      }
      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(decos, true);
}

class NoteCodePlugin {
  decorations: DecorationSet;
  private cleanup: () => void;

  constructor(view: EditorView) {
    this.decorations = buildNoteCodeDecos(view);
    this.cleanup = onCodeHighlightReady(() => scheduleViewportDecorationRefresh(view));
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || hasViewportDecorationRefresh(update)) {
      this.decorations = buildNoteCodeDecos(update.view);
    }
  }

  destroy(): void {
    this.cleanup();
  }
}

export const noteCodePreviewExtension = ViewPlugin.fromClass(NoteCodePlugin, {
  decorations: (plugin) => plugin.decorations,
});

export const noteCodeEditingExtension = [];
