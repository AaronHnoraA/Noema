import type { Editor } from "../src/lib.ts";
import type { ViewUpdate } from "@codemirror/view";
import type { SnippetSummary } from "./types.ts";
import { newNoemaId, type NoemaIdKind } from "../shared/identity.mjs";

export type SnippetTabstop = {
  index: number;
  from: number;
  to: number;
  primary: boolean;
  text?: string;
  choices?: string[];
};

export type ParsedSnippet = {
  text: string;
  tabstops: SnippetTabstop[];
};

type SnippetFrame = {
  stops: SnippetTabstop[];
  order: number[];
  cursor: number;
  activeIndex: number | null;
};

export type SnippetExpansionOptions = {
  selectedText?: string;
  newId?: (kind: NoemaIdKind) => string;
};

const SAFE_SELECTED_TEXT_RE = /`\(or\s+yas-selected-text\s+(?:"([^"]*)"|'([^']*)|nil)\)`/g;
const SAFE_CHOICE_RE = /\$\{(\d+):\$\$\(yas-choose-value\s+'\(([^)]*)\)\)\}/g;
const SAFE_NOEMA_ID_RE = /`\(my\/noema-new-id\s+(?:"(repository|page|block)"|'(repository|page|block))\)`/g;
const YAS_TABSTOP_RE = /\$(?:\d+|\{\d+(?::[^}]*)?\})/;

function hasDynamicBacktickExpression(body: string): boolean {
  for (const match of body.matchAll(/`([^`]*)`/g)) {
    // A backtick span containing a field is Markdown snippet output (for
    // example, `$1`), not a YAS backquoted Emacs Lisp expression.
    if (!YAS_TABSTOP_RE.test(match[1] ?? "")) return true;
  }
  return false;
}

function decodeYasQuotedList(source: string): string[] {
  const values: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    values.push((match[1] ?? match[2] ?? "").replace(/\\([\\"'])/g, "$1"));
  }
  return values;
}

function portableSnippetBody(
  body: string,
  selectedText: string,
  idFactory: (kind: NoemaIdKind) => string,
): string {
  return body
    .replace(SAFE_SELECTED_TEXT_RE, (_whole, doubleFallback: string, singleFallback: string) => (
      selectedText || doubleFallback || singleFallback || ""
    ))
    .replace(SAFE_CHOICE_RE, (_whole, index: string, raw: string) => {
      const choices = decodeYasQuotedList(raw);
      return choices.length > 0 ? `\${${index}|${choices.join(",")}|}` : `\${${index}}`;
    })
    .replace(SAFE_NOEMA_ID_RE, (_whole, doubleKind: string, quotedKind: string) => (
      idFactory((doubleKind || quotedKind) as NoemaIdKind)
    ));
}

export function snippetBrowserCompatibility(body: string): { compatible: boolean; diagnostic?: string } {
  const stripped = String(body || "")
    .replace(SAFE_SELECTED_TEXT_RE, "")
    .replace(SAFE_CHOICE_RE, "")
    .replace(SAFE_NOEMA_ID_RE, "");
  if (hasDynamicBacktickExpression(stripped) || /\$\$?\([^)]*\)/.test(stripped)) {
    return { compatible: false, diagnostic: "dynamic Emacs Lisp is not executed in Noema" };
  }
  if (/\$\{(?:TM_[A-Z_]+|[A-Z][A-Z0-9_]+)(?::[^}]*)?\}/.test(stripped)) {
    return { compatible: false, diagnostic: "unsupported TextMate variable" };
  }
  return { compatible: true };
}

function normalizeSnippetBody(body: string): string {
  return body.replace(/(^|\n)([ \t]*\\\[[\s\S]*?\n[ \t]*\\\])\n(\$0)$/, "$1$2$3");
}

function sortedStopIndexes(stops: SnippetTabstop[]): number[] {
  const indexes = [...new Set(stops.map((stop) => stop.index))];
  return indexes.sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });
}

function mapPointThroughReplacement(point: number, from: number, to: number, newSize: number): number {
  const delta = newSize - (to - from);
  if (point <= from) return point;
  if (point >= to) return point + delta;
  return from + newSize;
}

function mapSelectionThroughReplacement(
  selection: { from: number; to: number },
  from: number,
  to: number,
  newSize: number,
): { from: number; to: number } {
  return {
    from: mapPointThroughReplacement(selection.from, from, to, newSize),
    to: mapPointThroughReplacement(selection.to, from, to, newSize),
  };
}

export function expandSnippetBody(snippet: SnippetSummary, options: SnippetExpansionOptions = {}): ParsedSnippet {
  const body = normalizeSnippetBody(portableSnippetBody(
    snippet.body ?? "",
    options.selectedText ?? "",
    options.newId ?? newNoemaId,
  ));
  const values = new Map<number, string>();
  const tabstops: SnippetTabstop[] = [];
  let text = "";

  function valueFor(index: number, fallback: string): string {
    if (!values.has(index)) values.set(index, fallback);
    return values.get(index) ?? "";
  }

  function pushTabstop(index: number, value: string, choices?: string[]): void {
    const from = text.length;
    text += value;
    tabstops.push({ index, from, to: text.length, primary: false, text: value, choices });
  }

  function parseChoiceOptions(raw: string): string[] {
    const options: string[] = [];
    let value = "";
    for (let pos = 0; pos < raw.length; pos++) {
      const ch = raw[pos]!;
      if (ch === "\\" && pos + 1 < raw.length && /[,|\\]/.test(raw[pos + 1]!)) {
        value += raw[++pos];
      } else if (ch === ",") {
        options.push(value);
        value = "";
      } else {
        value += ch;
      }
    }
    options.push(value);
    return options.map((x) => x.trim()).filter(Boolean);
  }

  function findChoiceEnd(source: string, start: number): number {
    for (let pos = start; pos < source.length - 1; pos++) {
      if (source[pos] === "|" && source[pos + 1] === "}") return pos;
    }
    return -1;
  }

  function skipTemplate(source: string, start = 0, endChar = ""): number {
    let i = start;
    while (i < source.length) {
      if (endChar && source[i] === endChar) return i + 1;
      if (source[i] === "$" && source[i + 1] === "{") {
        let pos = i + 2;
        let digits = "";
        while (/\d/.test(source[pos] ?? "")) {
          digits += source[pos];
          pos++;
        }
        if (!digits) {
          i++;
          continue;
        }
        const marker = source[pos];
        if (marker === "}") {
          i = pos + 1;
          continue;
        }
        if (marker === "|") {
          const end = findChoiceEnd(source, pos + 1);
          if (end >= 0) {
            i = end + 2;
            continue;
          }
        }
        if (marker === ":") {
          i = skipTemplate(source, pos + 1, "}");
          continue;
        }
      }
      i++;
    }
    return i;
  }

  function parseTemplate(source: string, start = 0, endChar = ""): number {
    let i = start;
    while (i < source.length) {
      if (endChar && source[i] === endChar) return i + 1;

      if (source[i] !== "$") {
        if (source[i] === "\\" && source[i + 1] === "$") {
          text += "$";
          i += 2;
          continue;
        }
        text += source[i];
        i++;
        continue;
      }

      if (source[i + 1] === "{") {
        let pos = i + 2;
        let digits = "";
        while (/\d/.test(source[pos] ?? "")) {
          digits += source[pos];
          pos++;
        }
        if (!digits) {
          text += source[i];
          i++;
          continue;
        }

        const index = Number(digits);
        const marker = source[pos];
        if (marker === "}") {
          pushTabstop(index, index === 0 ? "" : valueFor(index, ""));
          i = pos + 1;
          continue;
        }
        if (marker === "|") {
          const end = findChoiceEnd(source, pos + 1);
          if (end >= 0) {
            const options = parseChoiceOptions(source.slice(pos + 1, end));
            pushTabstop(index, valueFor(index, options[0] ?? ""), options);
            i = end + 2;
            continue;
          }
        }
        if (marker === ":") {
          if (values.has(index)) {
            const end = skipTemplate(source, pos + 1, "}");
            pushTabstop(index, values.get(index) ?? "");
            i = end;
            continue;
          }
          const from = text.length;
          const end = parseTemplate(source, pos + 1, "}");
          const value = text.slice(from);
          values.set(index, value);
          tabstops.push({ index, from, to: text.length, primary: false, text: value });
          i = end;
          continue;
        }
        text += source[i];
        i++;
        continue;
      }

      let pos = i + 1;
      let digits = "";
      while (/\d/.test(source[pos] ?? "")) {
        digits += source[pos];
        pos++;
      }
      if (digits) {
        const index = Number(digits);
        pushTabstop(index, index === 0 ? "" : valueFor(index, ""));
        i = pos;
        continue;
      }

      text += source[i];
      i++;
    }
    return i;
  }

  parseTemplate(body);

  const seen = new Set<number>();
  for (const stop of tabstops) {
    if (!seen.has(stop.index)) {
      stop.primary = true;
      seen.add(stop.index);
    }
  }

  return { text, tabstops };
}

function nodeContains(root: HTMLElement, node: Node): boolean {
  return node === root || root.contains(node);
}

function textLength(node: Node): number {
  return node.textContent?.length ?? 0;
}

function textOffsetIn(root: HTMLElement, boundaryNode: Node, boundaryOffset: number): number | null {
  let offset = 0;
  let found = false;

  function visit(node: Node): void {
    if (found) return;
    if (node === boundaryNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += Math.max(0, Math.min(boundaryOffset, node.textContent?.length ?? 0));
      } else {
        const children = Array.from(node.childNodes);
        for (const child of children.slice(0, Math.max(0, boundaryOffset))) {
          offset += textLength(child);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(root);
  return found ? offset : null;
}

function domPointAtTextOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  const clamped = Math.max(0, target);
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const len = current.textContent?.length ?? 0;
    if (offset + len >= clamped) {
      return { node: current, offset: clamped - offset };
    }
    offset += len;
    current = walker.nextNode();
  }
  return { node: root, offset: root.childNodes.length };
}

export function insertExpandedSnippetIntoContentEditable(
  root: HTMLElement,
  snippet: SnippetSummary,
  deleteBefore = 0,
): boolean {
  const { text } = expandSnippetBody(snippet);
  if (!text) return false;
  const selection = root.ownerDocument.defaultView?.getSelection() ?? window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!nodeContains(root, range.startContainer) || !nodeContains(root, range.endContainer)) return false;

  const startOffset = textOffsetIn(root, range.startContainer, range.startOffset);
  if (startOffset == null) return false;
  const replaceFrom = domPointAtTextOffset(root, startOffset - deleteBefore);
  const replaceRange = range.cloneRange();
  replaceRange.setStart(replaceFrom.node, replaceFrom.offset);
  replaceRange.deleteContents();

  const textNode = root.ownerDocument.createTextNode(text);
  replaceRange.insertNode(textNode);
  replaceRange.setStart(textNode, text.length);
  replaceRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(replaceRange);
  return true;
}

export class SnippetSession {
  private frames: SnippetFrame[] = [];
  private readonly editor: Editor;
  private observesTransactions = false;
  private internalUpdateDepth = 0;

  constructor(editor: Editor) {
    this.editor = editor;
    if (typeof this.editor.onViewUpdate === "function") {
      this.observesTransactions = true;
      this.editor.onViewUpdate((update) => this.observeUpdate(update));
      this.editor.onDocumentReset?.(() => this.clear());
    }
  }

  clear(): void {
    this.frames = [];
  }

  active(): boolean {
    return this.validateActiveSelection();
  }

  activeChoices(): readonly string[] {
    if (!this.validateActiveSelection()) return [];
    const frame = this.topFrame();
    const active = frame?.activeIndex;
    if (active == null) return [];
    return frame?.stops.find((stop) => stop.index === active && stop.primary)?.choices ?? [];
  }

  choose(value: string): boolean {
    const choices = this.activeChoices();
    if (!choices.includes(value)) return false;
    const frame = this.topFrame()!;
    const primary = frame.stops.find((stop) => stop.index === frame.activeIndex && stop.primary);
    if (!primary) return false;
    const oldFrom = primary.from;
    const oldTo = primary.to;
    const inserted = this.withInternalUpdate(() => this.editor.replaceRange(oldFrom, oldTo, value, "all"));
    if (!this.observesTransactions) this.mapReplacement(oldFrom, oldTo, value.length, primary);
    primary.from = inserted.from;
    primary.to = inserted.to;
    primary.text = value;
    primary.choices = undefined;
    return true;
  }

  insert(snippet: SnippetSummary, deleteBefore = 0): boolean {
    const compatibility = snippetBrowserCompatibility(snippet.body ?? "");
    if (snippet.browserCompatible === false || !compatibility.compatible) return false;
    if (!this.validateActiveSelection()) this.clear();
    const selectionBefore = this.editor.getSelection();
    const selectedText = selectionBefore.from === selectionBefore.to
      ? ""
      : this.editor.textBetween(selectionBefore.from, selectionBefore.to);
    const { text, tabstops } = expandSnippetBody(snippet, { selectedText });
    if (!text) return false;
    const parent = this.topFrame();
    if (parent && !this.syncActive(parent)) return false;
    const selection = this.editor.getSelection();
    const replaceFrom = Math.max(0, selection.from - deleteBefore);
    const replaceTo = selection.to;
    const inserted = this.withInternalUpdate(() => this.editor.insertText(text, deleteBefore));
    if (!this.observesTransactions) this.mapReplacement(replaceFrom, replaceTo, inserted.to - inserted.from);
    const stops = this.mapInsertedStops(tabstops, inserted.from);
    if (stops.length === 0) return true;
    const frame: SnippetFrame = {
      stops: stops.map((stop) => ({
        ...stop,
      })),
      order: sortedStopIndexes(tabstops),
      cursor: -1,
      activeIndex: null,
    };
    this.frames.push(frame);
    if (!this.next()) this.frames.pop();
    return true;
  }

  next(): boolean {
    const hadSession = this.frames.length > 0;
    if (!this.validateActiveSelection()) return false;
    while (this.frames.length > 0) {
      const frame = this.topFrame()!;
      if (!this.syncActive(frame)) return false;
      frame.cursor += 1;
      if (frame.cursor >= frame.order.length) {
        this.frames.pop();
        continue;
      }
      const index = frame.order[frame.cursor]!;
      const target = frame.stops.find((stop) => stop.index === index && stop.primary)
        ?? frame.stops.find((stop) => stop.index === index);
      if (!target) continue;
      frame.activeIndex = index;
      this.selectStop(target);
      return true;
    }
    return hadSession;
  }

  previous(): boolean {
    const hadSession = this.frames.length > 0;
    if (!this.validateActiveSelection()) return false;
    while (this.frames.length > 0) {
      const frame = this.topFrame()!;
      if (!this.syncActive(frame)) return false;
      frame.cursor -= 1;
      if (frame.cursor < 0) {
        frame.cursor = 0;
        return hadSession;
      }
      const index = frame.order[frame.cursor]!;
      const target = frame.stops.find((stop) => stop.index === index && stop.primary)
        ?? frame.stops.find((stop) => stop.index === index);
      if (!target) continue;
      frame.activeIndex = index;
      this.selectStop(target);
      return true;
    }
    return hadSession;
  }

  private topFrame(): SnippetFrame | null {
    return this.frames[this.frames.length - 1] ?? null;
  }

  private syncActive(frame: SnippetFrame): boolean {
    if (frame.activeIndex == null) return true;
    const primary = frame.stops.find((stop) => stop.index === frame.activeIndex && stop.primary);
    if (!primary) return true;

    const selection = this.editor.getSelection();
    if (this.observesTransactions && !this.selectionInsideStop(selection, primary)) {
      this.clear();
      return false;
    }
    let restoreSelection = selection;
    const replacementEnd = this.observesTransactions
      ? primary.to
      : Math.max(primary.to, selection.from, selection.to);
    const value = this.editor.textBetween(primary.from, replacementEnd);
    const oldTo = primary.to;
    const oldText = primary.text;
    const oldSize = oldTo - primary.from;
    const newSize = value.length;
    const delta = newSize - oldSize;
    if (oldText != null && value !== oldText) this.dropStopsInside(frame, primary, oldTo);
    primary.text = value;
    primary.to = primary.from + newSize;

    if (delta !== 0) this.shiftStopsAfter(primary.from, delta, primary);

    const mirrors = frame.stops
      .filter((stop) => stop.index === frame.activeIndex && stop !== primary)
      .sort((a, b) => b.from - a.from);
    for (const mirror of mirrors) {
      const mirrorOldSize = mirror.to - mirror.from;
      const oldMirrorFrom = mirror.from;
      const oldMirrorTo = mirror.to;
      const inserted = this.withInternalUpdate(() => this.editor.replaceRange(mirror.from, mirror.to, value, "end"));
      const mirrorDelta = value.length - mirrorOldSize;
      if (!this.observesTransactions) {
        mirror.from = inserted.from;
        mirror.to = inserted.to;
      }
      mirror.text = value;
      if (mirrorDelta !== 0) {
        restoreSelection = mapSelectionThroughReplacement(restoreSelection, oldMirrorFrom, oldMirrorTo, value.length);
        if (!this.observesTransactions) this.mapReplacement(oldMirrorFrom, oldMirrorTo, value.length, mirror);
      }
    }
    this.withInternalUpdate(() => this.editor.setSelection(restoreSelection.from, restoreSelection.to));
    return true;
  }

  private dropStopsInside(frame: SnippetFrame, primary: SnippetTabstop, oldTo: number): void {
    frame.stops = frame.stops.filter((stop) => {
      if (stop === primary) return true;
      return !(stop.from >= primary.from && stop.to <= oldTo);
    });
  }

  private shiftStopsAfter(anchor: number, delta: number, except: SnippetTabstop): void {
    for (const frame of this.frames) {
      for (const stop of frame.stops) {
        if (stop === except) continue;
        if (stop.from > anchor) {
          stop.from += delta;
          stop.to += delta;
        } else if (stop.to > anchor) {
          stop.to += delta;
        }
      }
    }
  }

  private mapReplacement(from: number, to: number, newSize: number, except?: SnippetTabstop): void {
    const delta = newSize - (to - from);
    for (const frame of this.frames) {
      for (const stop of frame.stops) {
        if (stop === except) continue;
        if (stop.to <= from) continue;
        if (stop.from >= to) {
          stop.from += delta;
          stop.to += delta;
          continue;
        }
        stop.from = Math.min(stop.from, from);
        stop.to = Math.max(stop.from + newSize, stop.to + delta);
      }
    }
  }

  private selectStop(stop: SnippetTabstop): void {
    this.editor.setSelection(stop.from, stop.to);
  }

  private withInternalUpdate<T>(run: () => T): T {
    this.internalUpdateDepth += 1;
    try {
      return run();
    } finally {
      this.internalUpdateDepth -= 1;
    }
  }

  private observeUpdate(update: ViewUpdate): void {
    if (this.frames.length === 0) return;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue;
      for (const frame of this.frames) {
        for (const stop of frame.stops) {
          stop.from = transaction.changes.mapPos(stop.from, -1);
          stop.to = transaction.changes.mapPos(stop.to, 1);
        }
      }
    }
    if (this.internalUpdateDepth === 0 && update.docChanged) {
      const frame = this.topFrame();
      const primary = frame?.stops.find((stop) => stop.index === frame.activeIndex && stop.primary);
      if (primary) primary.choices = undefined;
    }
    if (this.internalUpdateDepth === 0 && (update.selectionSet || update.docChanged)) {
      this.validateActiveSelection();
    }
  }

  private selectionInsideStop(selection: { from: number; to: number }, stop: SnippetTabstop): boolean {
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    return from >= stop.from && to <= stop.to;
  }

  private validateActiveSelection(): boolean {
    const frame = this.topFrame();
    if (!frame) return false;
    // Minimal editor doubles used by non-CM integrations cannot expose
    // transactions. Production Noema always takes the strict CM6 path.
    if (!this.observesTransactions) return true;
    if (frame.activeIndex == null) return true;
    const primary = frame.stops.find((stop) => stop.index === frame.activeIndex && stop.primary)
      ?? frame.stops.find((stop) => stop.index === frame.activeIndex);
    if (!primary || !this.selectionInsideStop(this.editor.getSelection(), primary)) {
      this.clear();
      return false;
    }
    return true;
  }

  private mapInsertedStops(
    tabstops: SnippetTabstop[],
    insertedFrom: number,
  ): SnippetTabstop[] {
    return tabstops.map((stop) => {
      return {
        ...stop,
        from: insertedFrom + stop.from,
        to: insertedFrom + stop.to,
      };
    });
  }
}

export function snippetLabel(snippet: SnippetSummary): string {
  return snippet.key || snippet.name || "snippet";
}

export function snippetDetail(snippet: SnippetSummary): string {
  const kind = snippet.kind ? `kind:${snippet.kind}` : "";
  return [snippet.description || snippet.name, snippet.mode, kind, snippet.group, snippet.provider]
    .filter(Boolean)
    .join(" / ");
}

function snippetKey(snippet: SnippetSummary): string {
  return String(snippet.key ?? "").trim();
}

function fuzzyPrefixMatch(candidate: string, query: string): boolean {
  if (!query) return false;
  let pos = 0;
  for (const ch of query) {
    pos = candidate.indexOf(ch, pos);
    if (pos < 0) return false;
    pos += 1;
  }
  return true;
}

export function snippetScore(snippet: SnippetSummary, query: string, allowFuzzy = true): number {
  const key = snippetKey(snippet);
  const commandAlias = snippet.mode === "tex-mode" && key && !key.startsWith("\\")
    && String(snippet.body || "").trimStart().startsWith(`\\${key}`)
    ? `\\${key}`
    : "";
  const candidates = [key, commandAlias, ...(snippet.aliases ?? [])]
    .map((value) => value.toLowerCase())
    .filter(Boolean);
  if (candidates.length === 0 || !query) return Number.POSITIVE_INFINITY;
  if (candidates.some((candidate) => candidate === query)) return 0;
  if (candidates.some((candidate) => candidate.startsWith(query))) return 1;
  if (!allowFuzzy) return Number.POSITIVE_INFINITY;
  if (candidates.some((candidate) => candidate.includes(query))) return 2;
  if (candidates.some((candidate) => fuzzyPrefixMatch(candidate, query))) return 3;
  return Number.POSITIVE_INFINITY;
}

export type SnippetUsage = { count: number; lastUsed: number };

export function snippetStableId(snippet: SnippetSummary): string {
  return snippet.id || [snippet.provider, snippet.kind, snippet.mode, snippet.key].filter(Boolean).join(":");
}

export class SnippetUsageStore {
  private static readonly storageKey = "aaronnote.snippet-ranking.v1";
  private readonly entries = new Map<string, SnippetUsage>();
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private saveTimer = 0;

  constructor(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = null) {
    this.storage = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
    try {
      const parsed = JSON.parse(this.storage?.getItem(SnippetUsageStore.storageKey) || "{}");
      for (const [id, value] of Object.entries(parsed)) {
        const usage = value as Partial<SnippetUsage>;
        if (Number.isFinite(usage.count) && Number.isFinite(usage.lastUsed)) {
          this.entries.set(id, { count: Math.max(0, Number(usage.count)), lastUsed: Number(usage.lastUsed) });
        }
      }
    } catch {}
  }

  get(snippet: SnippetSummary): SnippetUsage | undefined {
    return this.entries.get(snippetStableId(snippet));
  }

  record(snippet: SnippetSummary, now = Date.now()): void {
    const id = snippetStableId(snippet);
    if (!id) return;
    const previous = this.entries.get(id);
    this.entries.set(id, { count: (previous?.count ?? 0) + 1, lastUsed: now });
    if (this.entries.size > 512) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [drop] of oldest.slice(0, this.entries.size - 512)) this.entries.delete(drop);
    }
    this.scheduleSave();
  }

  clear(): void {
    this.entries.clear();
    if (this.saveTimer) globalThis.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    try { this.storage?.removeItem(SnippetUsageStore.storageKey); } catch {}
  }

  private scheduleSave(): void {
    if (!this.storage) return;
    if (this.saveTimer) globalThis.clearTimeout(this.saveTimer);
    this.saveTimer = globalThis.setTimeout(() => {
      this.saveTimer = 0;
      try { this.storage?.setItem(SnippetUsageStore.storageKey, JSON.stringify(Object.fromEntries(this.entries))); } catch {}
    }, 1_000) as unknown as number;
  }
}

function providerPriority(snippet: SnippetSummary): number {
  if (Number.isFinite(snippet.priority)) return Number(snippet.priority);
  switch (snippet.provider) {
    case "personal": return 500;
    case "document": return 440;
    case "katex": return 400;
    case "aaronnote": return 300;
    case "latex-workshop": return 180;
    case "overleaf": return 160;
    default: return snippet.source?.includes("aaronnote:builtin") ? 300 : 240;
  }
}

export type SnippetMatchOptions = {
  mode?: string;
  kind?: string;
  limit?: number;
  allowFuzzy?: boolean;
  context?: SnippetSummary["context"];
  usage?: SnippetUsageStore;
  documentFrequency?: ReadonlyMap<string, number>;
  now?: number;
};

export function matchingSnippetsForPrefix(
  snippets: readonly SnippetSummary[],
  prefix: string,
  options: SnippetMatchOptions = {},
): SnippetSummary[] {
  const query = prefix.toLowerCase();
  const mode = options.mode || "";
  const activeKind = (options.kind || "").toLowerCase();
  const limit = Math.max(1, options.limit ?? 10);
  const now = options.now ?? Date.now();
  type RankedSnippet = { snippet: SnippetSummary; match: number; secondary: number };
  const compare = (a: RankedSnippet, b: RankedSnippet): number => {
    if (a.match !== b.match) return a.match - b.match;
    if (a.secondary !== b.secondary) return b.secondary - a.secondary;
    return snippetLabel(a.snippet).localeCompare(snippetLabel(b.snippet));
  };
  const best: RankedSnippet[] = [];
  for (const snippet of snippets) {
    if (snippet.browserCompatible === false || (mode && snippet.mode !== mode)) continue;
    const snippetKind = (snippet.kind || "").toLowerCase();
    if (snippetKind && snippetKind !== activeKind) continue;
    if (options.context && snippet.context) {
      const inContext = options.context === "math"
        ? snippet.context.startsWith("math") || snippet.context === "markdown"
        : snippet.context === options.context;
      if (!inContext) continue;
    }
    const match = snippetScore(snippet, query, options.allowFuzzy !== false);
    if (!Number.isFinite(match)) continue;
    const frequency = options.documentFrequency?.get(snippetKey(snippet)) ?? 0;
    const usage = options.usage?.get(snippet);
    const recentDays = usage ? Math.max(0, (now - usage.lastUsed) / 86_400_000) : Number.POSITIVE_INFINITY;
    const adaptive = (usage?.count ?? 0) * 8 + (Number.isFinite(recentDays) ? Math.max(0, 24 - recentDays) : 0);
    const item = {
      snippet,
      match,
      secondary: providerPriority(snippet) * 100
        + Math.log2(1 + Math.max(0, frequency)) * 80
        + Math.max(0, Number(snippet.weight) || 0)
        + adaptive,
    };

    // The popup consumes only a small fixed number of results. Maintain that
    // ordered top-k directly instead of allocating and sorting every match.
    let low = 0;
    let high = best.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(item, best[middle]!) < 0) high = middle;
      else low = middle + 1;
    }
    if (low >= limit) continue;
    best.splice(low, 0, item);
    if (best.length > limit) best.pop();
  }
  return best.map((item) => item.snippet);
}

export type SnippetPopupKeyAction =
  | { type: "none" }
  | { type: "consume" }
  | { type: "move"; delta: number }
  | { type: "page"; delta: number }
  | { type: "edge"; edge: "first" | "last" }
  | { type: "accept" }
  | { type: "select"; index: number }
  | { type: "dismiss" };

export type SnippetPopupKeyInput = {
  key: string;
  shiftKey?: boolean;
  commandKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

export function snippetPopupKeyName(key: string): string {
  const normalized = String(key || "");
  if (/^(?:Enter|Return|RET|CR|NumpadEnter)$/i.test(normalized)) return "Enter";
  if (/^(?:Esc|Escape)$/i.test(normalized)) return "Escape";
  if (/^(?:Backtab|Shift-Tab)$/i.test(normalized)) return "Shift-Tab";
  return normalized;
}

function snippetPopupDigitIndex(key: string): number | null {
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  if (key === "0") return 9;
  const digit = key.match(/^Digit([0-9])$/)?.[1] ?? key.match(/^Numpad([0-9])$/)?.[1];
  if (digit == null) return null;
  return digit === "0" ? 9 : Number(digit) - 1;
}

export function snippetPopupKeyAction(input: SnippetPopupKeyInput): SnippetPopupKeyAction {
  if (input.isComposing) return { type: "none" };
  const key = snippetPopupKeyName(input.key);
  const selectorModOnly = Boolean(input.commandKey || input.altKey)
    && (!input.ctrlKey || Boolean(input.commandKey))
    && !input.shiftKey;
  if (selectorModOnly) {
    const index = snippetPopupDigitIndex(key);
    return index == null ? { type: "none" } : { type: "select", index };
  }
  if (input.commandKey || input.ctrlKey || input.altKey) return { type: "none" };
  if (key === "ArrowDown") return { type: "move", delta: 1 };
  if (key === "ArrowUp") return { type: "move", delta: -1 };
  if (key === "PageDown") return { type: "page", delta: 6 };
  if (key === "PageUp") return { type: "page", delta: -6 };
  if (key === "Home") return { type: "edge", edge: "first" };
  if (key === "End") return { type: "edge", edge: "last" };
  if (key === "Enter") return { type: "consume" };
  if (key === "Tab" && !input.shiftKey) return { type: "accept" };
  if (key === "Escape") return { type: "dismiss" };
  return { type: "none" };
}
