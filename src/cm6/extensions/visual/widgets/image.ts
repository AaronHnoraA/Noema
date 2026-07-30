/**
 * Phase 6 — Image widget for the CM6 kernel.
 *
 * Lezer node: Image (same children as Link but with leading `!`)
 *
 * Behavior:
 *   cursor OUTSIDE Image node → Decoration.replace with <img> widget
 *   cursor INSIDE  Image node → source stays editable; live-preview
 *                               already folds [ ] and (url) to syntax-hint
 *
 * The src is extracted with a regex from the raw node text so we don't
 * depend on a specific Lezer child node layout (which varies between
 * @lezer/markdown versions).
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeInsideAny } from "../../../math-ranges.ts";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import {
  applyImageLayout,
  imageLayoutFromAttrs,
  imageLayoutToTrailingAttrs,
  readImageTrailingAttrs,
  type ImageAlign,
  type ImageLayoutAttrs,
} from "../../../../image-attrs.ts";
import { markdownLinkDestination } from "../../../../markdown-link.ts";
import {
  VISUAL_ATTACHMENT_IFRAME_ALLOW,
  visualAttachmentEmbeddableP,
  visualAttachmentFrame,
  visualAttachmentKind,
  visualAttachmentSandbox,
  visualAttachmentTitle,
} from "../../../../visual-attachments.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";

declare global {
  interface Window {
    AaronnoteResolveAssetUrl?: (src: string) => string;
  }
}

function setSourceRange(el: HTMLElement, from: number, to: number): void {
  el.dataset.cmSourceFrom = String(from);
  el.dataset.cmSourceTo = String(to);
  el.dataset.cmSourceAnchor = String(Math.min(to, from + 1));
  el.dataset.cmOpenSource = "true";
}

function resolveImageSrc(src: string): string {
  const raw = String(src || "").trim();
  if (!raw) return raw;
  return window.AaronnoteResolveAssetUrl?.(raw) ?? raw;
}

function happyDomTestEnvironmentP(): boolean {
  return typeof navigator !== "undefined" && /\bHappyDOM\//.test(navigator.userAgent);
}

function setVisualFrameSource(
  iframe: HTMLIFrameElement,
  frame: ReturnType<typeof visualAttachmentFrame>,
): void {
  if (frame.mode === "src") {
    if (happyDomTestEnvironmentP()) {
      iframe.setAttribute("data-aaronnote-src", frame.src);
    } else {
      iframe.setAttribute("src", frame.src);
    }
    return;
  }
  if (happyDomTestEnvironmentP()) {
    iframe.setAttribute("data-aaronnote-srcdoc", frame.srcdoc);
  } else {
    iframe.setAttribute("srcdoc", frame.srcdoc);
  }
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

class ImageWidget extends MeasuredWidget {
  src: string;
  alt: string;
  from: number;
  to: number;
  layout: ImageLayoutAttrs;

  constructor(src: string, alt: string, from: number, to: number, layout: ImageLayoutAttrs) {
    super();
    this.src = src;
    this.alt = alt;
    this.from = from;
    this.to = to;
    this.layout = layout;
  }

  protected get measuredBlock(): boolean { return !this.layout.wrap; }

  protected measureKey(): string { return "img:" + this.src; }

  protected measureGroupKey(): string {
    const kind = visualAttachmentKind(this.src) || "image";
    const caption = this.alt.trim() ? "caption" : "plain";
    return ["img", kind, this.layout.align, this.layout.wrap ? "wrap" : "block", caption].join(":");
  }

  protected estimatedHeightFallback(): number {
    const explicitHeight = Number.parseFloat(this.layout.height);
    if (Number.isFinite(explicitHeight) && explicitHeight > 0) {
      return explicitHeight + (this.alt.trim() ? 34 : 0) + 12;
    }
    if (visualAttachmentKind(this.src)) return this.alt.trim() ? 196 : 164;
    return this.alt.trim() ? 292 : 258;
  }

  eq(other: ImageWidget): boolean {
    return this.src === other.src &&
      this.alt === other.alt &&
      this.from === other.from &&
      this.to === other.to &&
      this.layout.align === other.layout.align &&
      this.layout.wrap === other.layout.wrap &&
      this.layout.width === other.layout.width &&
      this.layout.height === other.layout.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("figure");
    let resizableImage: HTMLImageElement | null = null;
    wrap.className = "cm-image-widget";
    setSourceRange(wrap, this.from, this.to);
    applyImageLayout(wrap, this.layout);

    if (this.src) {
      const kind = visualAttachmentKind(this.src);
      const resolvedSrc = resolveImageSrc(this.src);
      if (kind) {
        if (visualAttachmentEmbeddableP(kind, resolvedSrc)) {
          const frame = visualAttachmentFrame(kind, resolvedSrc);
          const iframe = document.createElement("iframe");
          iframe.className = `cm-image-render cm-visual-embed cm-visual-embed-${kind}`;
          iframe.title = visualAttachmentTitle(kind, this.alt);
          iframe.setAttribute("loading", "lazy");
          iframe.setAttribute("allow", VISUAL_ATTACHMENT_IFRAME_ALLOW);
          iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
          iframe.setAttribute("sandbox", visualAttachmentSandbox(kind));
          setVisualFrameSource(iframe, frame);
          iframe.addEventListener("load", () => { if (wrap.isConnected) view.requestMeasure(); });
          wrap.append(iframe);
        } else {
          const card = document.createElement("div");
          card.className = `cm-image-render cm-visual-file-card cm-visual-file-card-${kind}`;
          card.textContent = visualAttachmentTitle(kind, this.alt);
          card.title = `System Open: ${this.src}`;
          wrap.append(card);
        }
        wrap.classList.add("cm-visual-attachment", `cm-visual-attachment-${kind}`);
      } else {
        const img = document.createElement("img");
        img.src = resolvedSrc;
        img.alt = this.alt;
        img.className = "cm-image-render";
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("load", () => { if (wrap.isConnected) view.requestMeasure(); });
        img.onerror = () => {
          wrap.classList.add("cm-image-broken");
          wrap.title = `Image not found: ${this.src}`;
          view.requestMeasure();
        };
        wrap.append(img);
        resizableImage = img;
      }
    } else {
      wrap.classList.add("cm-image-broken");
      wrap.textContent = this.alt || "image";
    }
    if (this.alt.trim()) {
      const caption = document.createElement("figcaption");
      caption.className = "cm-image-caption";
      caption.textContent = this.alt.trim();
      wrap.append(caption);
    }

    // Hover toolbar: align / wrap / width. Each control rewrites the trailing
    // `{...}` layout attrs on the image source, preserving the base markdown
    // (including any title) so the change round-trips byte-for-byte.
    const applyLayout = (next: ImageLayoutAttrs): void => {
      const full = view.state.doc.sliceString(this.from, this.to);
      const base = full.match(IMAGE_RE)?.[0] ?? full;
      const trailing = imageLayoutToTrailingAttrs(next);
      const insert = trailing ? `${base} ${trailing}` : base;
      if (insert === full) return;
      view.dispatch({ changes: { from: this.from, to: this.to, insert } });
      view.requestMeasure();
    };
    wrap.append(buildImageToolbar(this.layout, applyLayout));
    if (resizableImage) {
      wrap.append(buildImageResizeHandle(wrap, resizableImage, this.layout, applyLayout, view));
    }

    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return Boolean(target?.closest(".cm-image-toolbar, .cm-image-resize-handle"));
  }
}

function buildImageResizeHandle(
  wrap: HTMLElement,
  image: HTMLImageElement,
  layout: ImageLayoutAttrs,
  apply: (next: ImageLayoutAttrs) => void,
  view: EditorView,
): HTMLButtonElement {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cm-image-resize-handle";
  handle.title = "Drag to resize image";
  handle.setAttribute("aria-label", handle.title);

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const fallbackWidth = Number.parseFloat(layout.width) || 320;
    const startWidth = image.getBoundingClientRect().width || fallbackWidth;
    const contentWidth = Math.max(160, view.contentDOM.clientWidth || wrap.parentElement?.clientWidth || 960);
    const maxWidth = Math.max(96, Math.floor(contentWidth));
    let pendingWidth = Math.round(startWidth);
    let frame = 0;
    let finished = false;
    handle.classList.add("is-resizing");
    wrap.classList.add("is-resizing");
    handle.setPointerCapture?.(event.pointerId);

    const detach = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      handle.classList.remove("is-resizing");
      wrap.classList.remove("is-resizing");
    };
    const paint = (): void => {
      frame = 0;
      if (!wrap.isConnected || finished) return;
      wrap.style.setProperty("--aaronnote-image-width", `${pendingWidth}px`);
      wrap.style.setProperty("--aaronnote-image-max-width", "none");
      view.requestMeasure();
    };
    const move = (moveEvent: PointerEvent): void => {
      moveEvent.preventDefault();
      pendingWidth = Math.max(96, Math.min(maxWidth, Math.round(startWidth + moveEvent.clientX - startX)));
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const finish = (finishEvent: PointerEvent): void => {
      finishEvent.preventDefault();
      finishEvent.stopPropagation();
      finished = true;
      if (frame) window.cancelAnimationFrame(frame);
      handle.releasePointerCapture?.(finishEvent.pointerId);
      detach();
      apply({ ...layout, width: `${pendingWidth}px`, height: "" });
    };
    const cancel = (cancelEvent: PointerEvent): void => {
      finished = true;
      if (frame) window.cancelAnimationFrame(frame);
      handle.releasePointerCapture?.(cancelEvent.pointerId);
      detach();
      if (layout.width) wrap.style.setProperty("--aaronnote-image-width", layout.width);
      else wrap.style.removeProperty("--aaronnote-image-width");
      view.requestMeasure();
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
  });
  return handle;
}

function stopImageEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function imageToolButton(label: string, title: string, active: boolean, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-image-tool-button" + (active ? " is-active" : "");
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("mousedown", stopImageEvent);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  return button;
}

function imageToolSeparator(): HTMLElement {
  const sep = document.createElement("span");
  sep.className = "cm-image-tool-sep";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

function buildImageToolbar(
  layout: ImageLayoutAttrs,
  apply: (next: ImageLayoutAttrs) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "cm-image-toolbar";
  bar.addEventListener("mousedown", stopImageEvent);
  const set = (patch: Partial<ImageLayoutAttrs>): ImageLayoutAttrs => ({ ...layout, ...patch });
  const isBlock = (align: ImageAlign): boolean => layout.align === align && !layout.wrap;
  const isWrap = (align: ImageAlign): boolean => layout.align === align && layout.wrap;
  bar.append(
    imageToolButton("L", "Align left", isBlock("left"), () => apply(set({ align: "left", wrap: false }))),
    imageToolButton("C", "Align center", isBlock("center"), () => apply(set({ align: "center", wrap: false }))),
    imageToolButton("R", "Align right", isBlock("right"), () => apply(set({ align: "right", wrap: false }))),
    imageToolSeparator(),
    imageToolButton("◧", "Wrap text, float left", isWrap("left"), () => apply(set({ align: "left", wrap: true }))),
    imageToolButton("◨", "Wrap text, float right", isWrap("right"), () => apply(set({ align: "right", wrap: true }))),
    imageToolSeparator(),
    imageToolButton("25%", "Width 25%", layout.width === "25%", () => apply(set({ width: "25%" }))),
    imageToolButton("50%", "Width 50%", layout.width === "50%", () => apply(set({ width: "50%" }))),
    imageToolButton("75%", "Width 75%", layout.width === "75%", () => apply(set({ width: "75%" }))),
    imageToolButton("100%", "Width 100%", layout.width === "100%", () => apply(set({ width: "100%" }))),
    imageToolButton("Auto", "Reset width", !layout.width, () => apply(set({ width: "" }))),
  );
  return bar;
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------

// Extracts alt and src from the raw Image markdown text (![alt](src "title"))
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]*)\)/;
const EMPTY_HTML_LINK_EMBED_RE = /\[\]\(([^)\n]+)\)/g;

function rangeOverlaps(from: number, to: number, ranges: ReadonlyArray<{ from: number; to: number }>): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function imageExcludedRanges(view: EditorView): Array<{ from: number; to: number }> {
  const visibleRanges = view.visibleRanges;
  const ranges: Array<{ from: number; to: number }> = blockMathRangesOverlapping(view.state, visibleRanges)
    .map(({ from, to }) => ({ from, to }));
  for (const { from, to } of visibleRanges) {
    ranges.push(...scanInlineMathRanges(view.state.doc.sliceString(from, to), from));
  }
  for (const { from, to } of visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (["FencedCode", "CodeBlock", "IndentedCode", "InlineCode"].includes(node.name)) {
          ranges.push({ from: node.from, to: node.to });
          return false;
        }
        return true;
      },
    });
  }
  return mergeOverlappingRanges(ranges);
}

function buildImageDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const occupied: Array<{ from: number; to: number }> = [];
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const visibleRanges = view.visibleRanges;
  const excludedRanges = imageExcludedRanges(view);

  for (const { from: vFrom, to: vTo } of visibleRanges) {
    syntaxTree(view.state).iterate({
      from: vFrom,
      to: vTo,
      enter(node) {
        if (rangeInsideAny(node.from, node.to, excludedRanges)) return false;
        if (node.name !== "Image") return;
        const line = doc.lineAt(node.to);
        const trailing = readImageTrailingAttrs(doc.sliceString(node.to, line.to), 0);
        const fullTo = trailing ? node.to + trailing.to : node.to;
        const cursorInside = sel.from <= fullTo && sel.to >= node.from;
        if (cursorInside) return false; // editable source

        const raw = doc.sliceString(node.from, node.to);
        const m = raw.match(IMAGE_RE);
        const alt = m?.[1] ?? "";
        // src may include optional title; strip the title part and trim
        const srcFull = m?.[2] ?? "";
        const src = markdownLinkDestination(srcFull);
        const layout = imageLayoutFromAttrs(trailing?.attrs ?? {});

        decos.push(
          Decoration.replace({
            widget: new ImageWidget(src, alt, node.from, fullTo, layout),
          }).range(node.from, fullTo),
        );
        occupied.push({ from: node.from, to: fullTo });
        return false;
      },
    });
  }

  const seenLines = new Set<number>();
  for (const { from: vFrom, to: vTo } of visibleRanges) {
    for (let line = doc.lineAt(vFrom); line.from <= vTo; line = doc.line(line.number + 1)) {
      if (!seenLines.has(line.number)) {
        seenLines.add(line.number);
        EMPTY_HTML_LINK_EMBED_RE.lastIndex = 0;
        for (const match of line.text.matchAll(EMPTY_HTML_LINK_EMBED_RE)) {
          const matchText = match[0] ?? "";
          if (line.text[(match.index ?? 0) - 1] === "!") continue;
          const alt = "";
          const src = markdownLinkDestination(match[1] ?? "");
          if (visualAttachmentKind(src) !== "html") continue;
          const from = line.from + (match.index ?? 0);
          const to = from + matchText.length;
          if (rangeInsideAny(from, to, excludedRanges) || rangeOverlaps(from, to, occupied)) continue;
          const trailing = readImageTrailingAttrs(doc.sliceString(to, line.to), 0);
          const fullTo = trailing ? to + trailing.to : to;
          const cursorInside = sel.from <= fullTo && sel.to >= from;
          if (cursorInside) continue;
          const layout = imageLayoutFromAttrs(trailing?.attrs ?? {});
          decos.push(
            Decoration.replace({
              widget: new ImageWidget(src, alt, from, fullTo, layout),
            }).range(from, fullTo),
          );
          occupied.push({ from, to: fullTo });
        }
      }
      if (line.to >= vTo || line.number >= doc.lines) break;
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(decos, true);
}

function activeImageSourceKey(view: EditorView): string {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const firstLine = doc.lineAt(sel.from).number;
  const lastLine = doc.lineAt(Math.min(sel.to, doc.length)).number;
  if (lastLine - firstLine > 50) return `wide:${sel.from}:${sel.to}`;
  const keys: string[] = [];

  for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
    const line = doc.line(lineNum);
    const inlineMathRanges = scanInlineMathRanges(line.text, line.from);
    syntaxTree(view.state).iterate({
      from: line.from,
      to: line.to,
      enter(node) {
        if (rangeInsideAny(node.from, node.to, inlineMathRanges)) return false;
        if (node.name !== "Image") return;
        const trailing = readImageTrailingAttrs(doc.sliceString(node.to, line.to), 0);
        const fullTo = trailing ? node.to + trailing.to : node.to;
        if (sel.from <= fullTo && sel.to >= node.from) keys.push(`${node.from}:${fullTo}`);
        return false;
      },
    });

    EMPTY_HTML_LINK_EMBED_RE.lastIndex = 0;
    let link: RegExpExecArray | null;
    while ((link = EMPTY_HTML_LINK_EMBED_RE.exec(line.text)) !== null) {
      if (line.text[(link.index ?? 0) - 1] === "!") continue;
      const src = markdownLinkDestination(link[1] ?? "");
      if (visualAttachmentKind(src) !== "html") continue;
      const from = line.from + (link.index ?? 0);
      const to = from + (link[0] ?? "").length;
      if (rangeInsideAny(from, to, inlineMathRanges)) continue;
      const trailing = readImageTrailingAttrs(line.text.slice((link.index ?? 0) + (link[0] ?? "").length), 0);
      const fullTo = trailing ? to + trailing.to : to;
      if (sel.from <= fullTo && sel.to >= from) keys.push(`${from}:${fullTo}`);
    }
  }
  return keys.join("|");
}

// ---------------------------------------------------------------------------
// ViewPlugin export
// ---------------------------------------------------------------------------

class ImagePlugin {
  decorations: DecorationSet;
  private activeSourceKey: string;

  constructor(view: EditorView) {
    this.activeSourceKey = activeImageSourceKey(view);
    this.decorations = buildImageDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    if (update.docChanged || update.viewportChanged || hasViewportDecorationRefresh(update)) {
      this.activeSourceKey = activeImageSourceKey(update.view);
      this.decorations = buildImageDecorations(update.view);
    } else if (update.selectionSet) {
      const nextSourceKey = activeImageSourceKey(update.view);
      if (nextSourceKey === this.activeSourceKey) return;
      this.activeSourceKey = nextSourceKey;
      this.decorations = buildImageDecorations(update.view);
    }
  }
}

export const imageExtension = ViewPlugin.fromClass(ImagePlugin, {
  decorations: (v) => v.decorations,
});
