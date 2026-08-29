import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import {
  breakParagraph,
  KP_FORCED_BREAK,
  type KpGlue,
  type KpIncrementalCache,
  type KpItem,
  type KpLayout,
} from "../../../linebreak/knuth-plass.ts";
import { mixedCjkItems } from "../../../linebreak/mixed-cjk.ts";
import { waitForParser } from "../parser-watcher.ts";
import { hasViewportDecorationRefresh } from "../../viewport-refresh.ts";
import { isCoalescedVisualTyping } from "./typing-burst.ts";

export type LineBreakingMode = "optimal" | "native";

export const setOptimalLineBreakingMode = StateEffect.define<LineBreakingMode>();

const lineBreakingModeField = StateField.define<LineBreakingMode>({
  create: () => "optimal",
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setOptimalLineBreakingMode)) return effect.value;
    }
    return value;
  },
});

export function optimalLineBreakingController(initial: LineBreakingMode): Extension {
  return lineBreakingModeField.init(() => initial);
}

export function optimalLineBreakingMode(state: EditorState): LineBreakingMode {
  return state.field(lineBreakingModeField, false) ?? "native";
}

type AppliedLayout = {
  doc: Text;
  decorations: DecorationSet;
};

const applyOptimalLayout = StateEffect.define<AppliedLayout>();

const optimalLinebreakDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setOptimalLineBreakingMode) && effect.value === "native") {
        value = Decoration.none;
      } else if (effect.is(applyOptimalLayout) && effect.value.doc === transaction.state.doc) {
        value = effect.value.decorations;
      }
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class OptimalBreakWidget extends WidgetType {
  toDOM(): HTMLElement {
    const br = document.createElement("br");
    br.className = "cm-kp-break";
    br.setAttribute("aria-hidden", "true");
    return br;
  }

  eq(): boolean {
    return true;
  }

  get lineBreaks(): number {
    return 1;
  }
}

class OptimalSpacerWidget extends WidgetType {
  readonly width: number;
  readonly role: KpGlue["role"];

  constructor(width: number, role: KpGlue["role"]) {
    super();
    this.width = width;
    this.role = role;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-kp-spacer cm-kp-spacer-${this.role}`;
    span.style.width = `${Math.max(0, this.width)}px`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  eq(other: OptimalSpacerWidget): boolean {
    return this.role === other.role && Math.abs(this.width - other.width) < 0.01;
  }
}

const breakWidget = new OptimalBreakWidget();
const MAX_PARAGRAPH_CHARS = 4_096;
const MAX_CACHE_PARAGRAPHS = 128;
const MAX_CACHE_BYTES = 8_000_000;
const TYPING_SETTLE_MS = 120;
const WIDTH_EPSILON_PX = 0.25;

type ParagraphSyntax = {
  from: number;
  to: number;
  hardBreakEnds: ReadonlySet<number>;
  hiddenRanges: readonly { from: number; to: number }[];
};

type CachedParagraph = {
  from: number;
  to: number;
  text: string;
  width: number;
  styleKey: string;
  bytes: number;
  decorations: readonly Range<Decoration>[];
  incremental: KpIncrementalCache;
  dirty: boolean;
  usedAt: number;
};

export type OptimalLinebreakAudit = {
  paragraphVisits: number;
  paragraphLayouts: number;
  cacheHits: number;
  fallbacks: number;
  evaluatedEdges: number;
  reusedBreakpoints: number;
};

const audit: OptimalLinebreakAudit = {
  paragraphVisits: 0,
  paragraphLayouts: 0,
  cacheHits: 0,
  fallbacks: 0,
  evaluatedEdges: 0,
  reusedBreakpoints: 0,
};

export function optimalLinebreakAudit(): OptimalLinebreakAudit {
  return { ...audit };
}

export function resetOptimalLinebreakAudit(): void {
  audit.paragraphVisits = 0;
  audit.paragraphLayouts = 0;
  audit.cacheHits = 0;
  audit.fallbacks = 0;
  audit.evaluatedEdges = 0;
  audit.reusedBreakpoints = 0;
}

function topLevelPlainParagraph(node: { node: { parent: { name: string } | null; firstChild: { name: string; nextSibling: unknown } | null } }): boolean {
  if (node.node.parent?.name !== "Document") return false;
  for (let child = node.node.firstChild; child; child = child.nextSibling as typeof child) {
    if (child.name !== "HardBreak") return false;
  }
  return true;
}

function visibleParagraphs(view: EditorView): ParagraphSyntax[] {
  const tree = syntaxTree(view.state);
  const paragraphs = new Map<string, ParagraphSyntax>();
  for (const visible of view.visibleRanges) {
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (node.name !== "Paragraph" || !topLevelPlainParagraph(node)) return;
        const key = `${node.from}:${node.to}`;
        if (paragraphs.has(key)) return false;
        const hardBreakEnds = new Set<number>();
        const hiddenRanges: Array<{ from: number; to: number }> = [];
        node.node.cursor().iterate((child) => {
          if (child.name === "HardBreak") {
            hardBreakEnds.add(child.to);
            if (child.to - child.from > 1) hiddenRanges.push({ from: child.from, to: child.to - 1 });
          }
        });
        paragraphs.set(key, { from: node.from, to: node.to, hardBreakEnds, hiddenRanges });
        return false;
      },
    });
  }
  return [...paragraphs.values()].sort((left, right) => left.from - right.from);
}

function lineElementAt(view: EditorView, position: number): HTMLElement | null {
  try {
    const dom = view.domAtPos(position).node;
    const element = dom.nodeType === Node.ELEMENT_NODE ? dom as Element : dom.parentElement;
    return element?.closest<HTMLElement>(".cm-line") ?? null;
  } catch {
    return null;
  }
}

function fontShorthand(style: CSSStyleDeclaration): string {
  if (style.font && style.font !== "") return style.font;
  return [style.fontStyle || "normal", style.fontWeight || "400", style.fontSize, style.fontFamily]
    .filter(Boolean)
    .join(" ");
}

function styleKeyFor(style: CSSStyleDeclaration): string {
  return [
    fontShorthand(style),
    style.fontKerning,
    style.fontFeatureSettings,
    style.fontVariantLigatures,
    style.letterSpacing,
  ].join("|");
}

function numericPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineStarts(doc: Text, paragraph: ParagraphSyntax): number[] {
  const starts = [doc.lineAt(paragraph.from).from];
  let line = doc.lineAt(paragraph.from);
  while (line.to < paragraph.to) {
    line = doc.line(line.number + 1);
    starts.push(line.from);
  }
  return starts;
}

function adjustmentMap(layout: KpLayout): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of layout.lines) {
    for (const adjustment of line.adjustments) {
      result.set(adjustment.item, (result.get(adjustment.item) ?? 0) + adjustment.delta);
    }
  }
  return result;
}

function decorationsFor(
  doc: Text,
  paragraph: ParagraphSyntax,
  items: readonly KpItem[],
  layout: KpLayout,
): readonly Range<Decoration>[] {
  if (!layout.feasible || layout.lines.length === 0) return [];
  const ranges: Range<Decoration>[] = lineStarts(doc, paragraph).map((position) => (
    Decoration.line({ class: "cm-kp-paragraph" }).range(position)
  ));
  const breakItems = new Set(layout.lines.slice(0, -1).map((line) => line.breakItem));
  const adjustments = adjustmentMap(layout);

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind === "box") {
      if (item.tracking && Math.abs(item.tracking) > WIDTH_EPSILON_PX) {
        ranges.push(Decoration.mark({
          class: "cm-kp-compressed-punctuation",
          attributes: { style: `letter-spacing:${item.tracking}px` },
        }).range(item.from, item.to));
      }
      continue;
    }
    if (item.kind === "penalty") {
      if (breakItems.has(index) && item.penalty > KP_FORCED_BREAK) {
        ranges.push(Decoration.widget({ widget: breakWidget, side: 1 }).range(item.from));
      }
      continue;
    }
    if (breakItems.has(index)) {
      const decoration = item.from < item.to
        ? Decoration.replace({ widget: breakWidget })
        : Decoration.widget({ widget: breakWidget, side: 1 });
      ranges.push(decoration.range(item.from, item.to));
      continue;
    }

    const delta = adjustments.get(index) ?? 0;
    if (item.role === "soft-newline") {
      ranges.push(Decoration.replace({
        widget: new OptimalSpacerWidget(item.width + delta, item.role),
      }).range(item.from, item.to));
    } else if (item.from === item.to && item.width + delta > WIDTH_EPSILON_PX) {
      ranges.push(Decoration.widget({
        widget: new OptimalSpacerWidget(item.width + delta, item.role),
        side: 1,
      }).range(item.from));
    } else if (item.from < item.to && Math.abs(delta) > WIDTH_EPSILON_PX) {
      ranges.push(Decoration.mark({
        class: "cm-kp-adjusted-space",
        attributes: { style: `letter-spacing:${delta}px` },
      }).range(item.from, item.to));
    }
  }
  return ranges;
}

function estimateCacheBytes(entry: Omit<CachedParagraph, "bytes">): number {
  return entry.text.length * 2
    + entry.decorations.length * 72
    + entry.incremental.items.length * 96
    + entry.incremental.points.length * 320
    + 256;
}

class OptimalLinebreakPlugin {
  private readonly view: EditorView;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly cache = new Map<string, CachedParagraph>();
  private readonly widthCache = new Map<string, number>();
  private cacheBytes = 0;
  private timer = 0;
  private generation = 0;
  private useCounter = 0;
  private waitingForParse = false;
  private viewportQuietAt = 0;
  private readonly measureKey = {};
  private readonly compositionEnd = (): void => {
    if (this.context) this.schedule(TYPING_SETTLE_MS);
  };

  constructor(view: EditorView) {
    this.view = view;
    this.canvas = view.dom.ownerDocument.createElement("canvas");
    this.context = this.canvas.getContext("2d");
    view.contentDOM.addEventListener("compositionend", this.compositionEnd);
    const fontsReady = view.dom.ownerDocument.fonts?.ready ?? Promise.resolve();
    if (this.context && optimalLineBreakingMode(view.state) === "optimal") {
      void fontsReady.then(() => this.schedule(0));
    }
  }

  update(update: ViewUpdate): void {
    if (optimalLineBreakingMode(update.state) !== "optimal") {
      this.cancel();
      this.cache.clear();
      this.cacheBytes = 0;
      return;
    }
    // Headless DOMs and hardened webviews may expose <canvas> without a 2D
    // context. Native wrapping is already the safe fallback; avoid queuing a
    // measure/timer that can never produce a layout.
    if (!this.context) return;

    if (update.docChanged) this.mapCache(update);
    if (update.view.composing) return;
    if (isCoalescedVisualTyping(update)) return;
    const now = performance.now();
    const viewportRefresh = hasViewportDecorationRefresh(update);
    if (update.viewportChanged) {
      this.viewportQuietAt = now + TYPING_SETTLE_MS;
      // CM6 can publish one viewport per animation frame during a fast wheel or
      // trackpad gesture. Keep already-cached paragraphs, let newly visible
      // ones use native wrapping, and fill them only after scrolling is quiet.
      // Running canvas measurement + DP in every scroll frame regresses the
      // browser's existing viewport path even though one paragraph is cheap.
      this.schedule(TYPING_SETTLE_MS);
    } else if ((viewportRefresh || update.geometryChanged) && now < this.viewportQuietAt) {
      // The shared viewport refresh arrives a frame or two after the scroll
      // update. It belongs to the same burst and must not bypass the quiet
      // window by scheduling an immediate measure.
      this.schedule(Math.ceil(this.viewportQuietAt - now));
    } else if (update.docChanged
        || viewportRefresh
        || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setOptimalLineBreakingMode)))) {
      this.schedule(0);
    } else if (update.geometryChanged) {
      this.schedule(0);
    }
  }

  private mapCache(update: ViewUpdate): void {
    const changed: Array<{ from: number; to: number }> = [];
    update.changes.iterChangedRanges((fromA, toA) => changed.push({ from: fromA, to: toA }));
    const mapped = new Map<string, CachedParagraph>();
    this.cacheBytes = 0;
    for (const entry of this.cache.values()) {
      const overlaps = changed.some((range) => range.from <= entry.to && range.to >= entry.from);
      const from = update.changes.mapPos(entry.from, -1);
      const to = update.changes.mapPos(entry.to, 1);
      const delta = from - entry.from;
      const decorations = overlaps || delta === 0
        ? entry.decorations
        : entry.decorations.map((range) => range.value.range(range.from + delta, range.to + delta));
      const next = { ...entry, from, to, decorations, dirty: overlaps };
      mapped.set(`${from}:${to}`, next);
      this.cacheBytes += next.bytes;
    }
    this.cache.clear();
    for (const [key, entry] of mapped) this.cache.set(key, entry);
  }

  private schedule(delay: number): void {
    this.cancel();
    const generation = ++this.generation;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (!this.view.dom.isConnected || optimalLineBreakingMode(this.view.state) !== "optimal") return;
      const scheduledState = this.view.state;
      this.view.requestMeasure({
        key: this.measureKey,
        read: (view) => this.measure(view, scheduledState, generation),
        write: (measured, view) => {
          if (!measured || measured.generation !== this.generation || view.state !== measured.state) return;
          // CM6 is still inside its measure/update cycle during `write` and
          // rejects nested dispatch. A microtask commits the already-computed
          // DecorationSet without another layout read.
          queueMicrotask(() => {
            if (!view.dom.isConnected
                || measured.generation !== this.generation
                || view.state !== measured.state) return;
            view.dispatch({ effects: applyOptimalLayout.of({
              doc: view.state.doc,
              decorations: measured.decorations,
            }) });
          });
        },
      });
    }, delay);
  }

  private cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.generation += 1;
  }

  private measure(
    view: EditorView,
    state: EditorState,
    generation: number,
  ): { state: EditorState; generation: number; decorations: DecorationSet } | null {
    if (view.state !== state || !this.context || optimalLineBreakingMode(state) !== "optimal") return null;
    const parseTo = view.visibleRanges.reduce((maximum, range) => Math.max(maximum, range.to), 0);
    if (!ensureSyntaxTree(state, parseTo, 8)) {
      this.dropDirtyCache();
      if (!this.waitingForParse) {
        this.waitingForParse = true;
        void waitForParser(view, parseTo).then(() => {
          this.waitingForParse = false;
          if (view.dom.isConnected && optimalLineBreakingMode(view.state) === "optimal") this.schedule(0);
        });
      }
      return {
        state,
        generation,
        decorations: this.cachedDecorations(),
      };
    }

    for (const paragraph of visibleParagraphs(view)) {
      audit.paragraphVisits += 1;
      const text = state.doc.sliceString(paragraph.from, paragraph.to);
      if (!text || text.length > MAX_PARAGRAPH_CHARS) {
        audit.fallbacks += 1;
        continue;
      }
      const lineElement = lineElementAt(view, paragraph.from);
      if (!lineElement) {
        audit.fallbacks += 1;
        continue;
      }
      const rect = lineElement.getBoundingClientRect();
      const style = lineElement.ownerDocument.defaultView?.getComputedStyle(lineElement);
      if (!style || rect.width <= 0) continue;
      const lineWidth = rect.width - numericPixels(style.paddingInlineStart) - numericPixels(style.paddingInlineEnd);
      const em = numericPixels(style.fontSize) || 16;
      if (lineWidth <= 0 || em <= 0) continue;
      const styleKey = styleKeyFor(style);
      const cacheKey = `${paragraph.from}:${paragraph.to}`;
      const cached = this.cache.get(cacheKey);
      if (cached
          && !cached.dirty
          && cached.text === text
          && Math.abs(cached.width - lineWidth) <= WIDTH_EPSILON_PX
          && cached.styleKey === styleKey) {
        cached.usedAt = ++this.useCounter;
        audit.cacheHits += 1;
        continue;
      }

      this.context.font = fontShorthand(style);
      this.context.fontKerning = "normal";
      const measure = (value: string): number => {
        const key = `${styleKey}\u0000${value}`;
        const hit = this.widthCache.get(key);
        if (hit !== undefined) return hit;
        const width = this.context!.measureText(value).width;
        if (this.widthCache.size >= 4_096) this.widthCache.delete(this.widthCache.keys().next().value!);
        this.widthCache.set(key, width);
        return width;
      };
      const items = mixedCjkItems(text, {
        from: paragraph.from,
        em,
        measure,
        hardBreakEnds: paragraph.hardBreakEnds,
        hiddenRanges: paragraph.hiddenRanges,
        emergencyLineWidth: lineWidth,
      });
      const layout = breakParagraph(items, { lineWidth, tolerance: 3 }, cached?.incremental);
      audit.evaluatedEdges += layout.evaluatedEdges;
      audit.reusedBreakpoints += layout.reusedBreakpoints;
      if (!layout.feasible) {
        audit.fallbacks += 1;
        if (cached) this.cacheBytes -= cached.bytes;
        this.cache.delete(cacheKey);
        continue;
      }
      audit.paragraphLayouts += 1;
      const decorations = decorationsFor(state.doc, paragraph, items, layout);
      const withoutBytes = {
        from: paragraph.from,
        to: paragraph.to,
        text,
        width: lineWidth,
        styleKey,
        decorations,
        incremental: layout.incremental!,
        dirty: false,
        usedAt: ++this.useCounter,
      };
      const entry: CachedParagraph = {
        ...withoutBytes,
        bytes: estimateCacheBytes(withoutBytes),
      };
      if (cached) this.cacheBytes -= cached.bytes;
      this.cache.set(cacheKey, entry);
      this.cacheBytes += entry.bytes;
    }

    // Syntax-changing edits can split or remove the old paragraph. Such stale
    // entries remain available during this pass as continuation candidates but
    // must never leak old ranges into the committed DecorationSet.
    this.dropDirtyCache();

    this.evictCache();
    return {
      state,
      generation,
      decorations: this.cachedDecorations(),
    };
  }

  private dropDirtyCache(): void {
    for (const [key, entry] of this.cache) {
      if (!entry.dirty) continue;
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
  }

  private cachedDecorations(): DecorationSet {
    const ranges = [...this.cache.values()].flatMap((entry) => entry.decorations);
    return Decoration.set(ranges, true);
  }

  private evictCache(): void {
    while (this.cache.size > MAX_CACHE_PARAGRAPHS || this.cacheBytes > MAX_CACHE_BYTES) {
      let oldestKey = "";
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (entry.usedAt < oldestUse) {
          oldestKey = key;
          oldestUse = entry.usedAt;
        }
      }
      if (!oldestKey) break;
      const entry = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.cacheBytes -= entry.bytes;
    }
  }

  destroy(): void {
    this.cancel();
    this.view.contentDOM.removeEventListener("compositionend", this.compositionEnd);
    this.cache.clear();
    this.widthCache.clear();
  }
}

const optimalLinebreakPlugin = ViewPlugin.fromClass(OptimalLinebreakPlugin);

export const optimalLinebreakExtension: Extension = [
  optimalLinebreakDecorations,
  optimalLinebreakPlugin,
];
