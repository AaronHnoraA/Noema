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
import { vimKeepsRenderedObjects } from "../vim-objects.ts";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { blockMathRangesOverlapping, mergeOverlappingRanges, rangeInsideAny } from "../../../math-ranges.ts";
import { scanInlineMathRanges } from "../../../../inline-math.ts";
import {
  applyImageLayout,
  imageLayoutFromAttrs,
  readImageTrailingAttrs,
  type ImageAlign,
  type ImageLayoutAttrs,
} from "../../../../image-attrs.ts";
import { applyFigureLayout, arrangeWithNextFigure, figureHeightHandle, figureLayoutTarget, figureMoveGrip } from "../../../figure-layout-menu.ts";
import { imageRowGrip, imageRowAt, imageRowSplitHandle, imageRowHeightHandle, joinNextImage, sizeImageRowItem } from "../../../image-row-layout.ts";
import { openImageViewer } from "../../../image-viewer.ts";
import { markdownLinkDestination } from "../../../../markdown-link.ts";
import {
  VISUAL_ATTACHMENT_IFRAME_ALLOW,
  drawioAttachmentP,
  drawioAttachmentTitle,
  drawioImageSrc,
  splitDrawioSource,
  visualAttachmentEmbeddableP,
  visualAttachmentFrame,
  visualAttachmentKind,
  visualAttachmentSandbox,
  visualAttachmentTitle,
  mediaPlayerKind,
} from "../../../../visual-attachments.ts";
import { hasViewportDecorationRefresh } from "../../../viewport-refresh.ts";
import { isCoalescedVisualTyping } from "../typing-burst.ts";
import { rememberPersistentVisualPluginState, restorePersistentVisualPluginState } from "../visual-mode.ts";

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

/**
 * A `.drawio` reference resolves to the host's SVG export of that file, so the
 * widget below renders it through the ordinary `<img>` path. `card` is true
 * when the file is not a Noema asset and therefore has no exporter.
 */
function resolveImageSrc(src: string): { src: string; card: boolean } {
  const raw = String(src || "").trim();
  if (!raw) return { src: raw, card: false };
  if (drawioAttachmentP(raw)) {
    const { path, page } = splitDrawioSource(raw);
    const resolved = window.AaronnoteResolveAssetUrl?.(path) ?? path;
    const exported = drawioImageSrc(resolved, page);
    return exported ? { src: exported, card: false } : { src: resolved, card: true };
  }
  return { src: window.AaronnoteResolveAssetUrl?.(raw) ?? raw, card: false };
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
  resolvedSrc: string;
  /** A `.drawio` outside the vault: no exporter, so it shows as a file card. */
  drawioCard: boolean;
  alt: string;
  from: number;
  baseTo: number;
  to: number;
  layout: ImageLayoutAttrs;
  inRow: boolean;
  joinable: boolean;

  constructor(src: string, alt: string, from: number, baseTo: number, to: number, layout: ImageLayoutAttrs, inRow = false, joinable = false) {
    super();
    this.src = src;
    const resolution = resolveImageSrc(src);
    this.resolvedSrc = resolution.src;
    this.drawioCard = resolution.card;
    this.alt = alt;
    this.from = from;
    this.baseTo = baseTo;
    this.to = to;
    this.layout = layout;
    this.inRow = inRow;
    this.joinable = joinable;
  }

  protected get measuredBlock(): boolean { return !this.layout.wrap; }
  protected get observeSize(): boolean { return true; }

  protected measureKey(): string {
    // Intrinsic dimensions belong to a resource; rendered height belongs to
    // this layout and caption. Two sizes of the same picture cannot share it.
    return "img:" + JSON.stringify([this.resolvedSrc, this.alt, this.layout, this.inRow]);
  }

  protected measureGroupKey(): string {
    const kind = visualAttachmentKind(this.src) || "image";
    const caption = this.alt.trim() ? "caption" : "plain";
    return ["img", kind, this.layout.align, this.layout.wrap ? "wrap" : "block", this.inRow ? "row" : "single", caption,
      this.layout.width, this.layout.height].join(":");
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
    return this.sameContent(other) && this.from === other.from &&
      this.baseTo === other.baseTo &&
      this.to === other.to;
  }

  private sameContent(other: ImageWidget): boolean {
    return this.src === other.src && this.resolvedSrc === other.resolvedSrc && this.alt === other.alt &&
      this.inRow === other.inRow &&
      this.joinable === other.joinable &&
      this.layout.align === other.layout.align &&
      this.layout.wrap === other.layout.wrap &&
      this.layout.width === other.layout.width &&
      this.layout.height === other.layout.height;
  }

  updateDOM(dom: HTMLElement, view: EditorView, previous: ImageWidget): boolean {
    if (!this.sameContent(previous)) return false;
    // Moving source offsets must not reload an iframe, restart an animation,
    // or send a decoded image through a second lazy-load/layout cycle.
    setSourceRange(dom, this.from, this.to);
    dom.dataset.cmSourceBaseTo = String(this.baseTo);
    syncImageRow(dom, view, this.from, this.layout);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("figure");
    let resizableImage: HTMLImageElement | null = null;
    wrap.className = "cm-image-widget";
    setSourceRange(wrap, this.from, this.to);
    wrap.dataset.cmSourceBaseTo = String(this.baseTo);
    applyImageLayout(wrap, this.layout);

    if (this.src) {
      const kind = visualAttachmentKind(this.src);
      const resolvedSrc = this.resolvedSrc;
      if (this.drawioCard) {
        const card = document.createElement("div");
        card.className = "cm-image-render cm-visual-file-card cm-visual-file-card-drawio";
        card.textContent = drawioAttachmentTitle(this.alt);
        card.title = `System Open: ${this.src}`;
        wrap.append(card);
        wrap.classList.add("cm-visual-attachment", "cm-visual-attachment-drawio");
      } else if (kind) {
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
      } else if (mediaPlayerKind(this.src)) {
        // No autoplay: a note full of clips must not decode them all while
        // scrolling. Metadata alone sizes the player.
        const media = document.createElement(mediaPlayerKind(this.src)!);
        media.className = "cm-image-render cm-media-player";
        media.src = resolvedSrc;
        media.controls = true;
        media.preload = "metadata";
        if (media instanceof HTMLVideoElement) media.playsInline = true;
        if (this.alt) media.title = this.alt;
        media.addEventListener("loadedmetadata", () => { if (wrap.isConnected) view.requestMeasure(); });
        media.addEventListener("error", () => {
          wrap.classList.add("cm-image-broken");
          wrap.title = `Media not found: ${this.src}`;
          view.requestMeasure();
        });
        wrap.classList.add("cm-media-widget");
        wrap.append(media);
      } else {
        const img = document.createElement("img");
        const drawio = drawioAttachmentP(this.src);
        img.src = resolvedSrc;
        img.alt = this.alt;
        img.className = drawio ? "cm-image-render cm-drawio-render" : "cm-image-render";
        if (drawio) {
          img.title = drawioAttachmentTitle(this.alt);
          wrap.classList.add("cm-visual-attachment", "cm-visual-attachment-drawio");
        }
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("load", () => { if (wrap.isConnected) view.requestMeasure(); });
        img.onerror = () => {
          wrap.classList.add("cm-image-broken");
          wrap.title = `Image not found: ${this.src}`;
          view.requestMeasure();
        };
        img.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openImageViewer(wrap);
        });
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
      if (view.state.readOnly) return;
      const target = figureLayoutTarget(view, wrap);
      if (target) applyFigureLayout(view, target, next);
    };
    const toolbar = buildImageToolbar(this.layout, applyLayout, () => {
      if (!joinNextImage(view, Number(wrap.dataset.cmSourceFrom))) arrangeWithNextFigure(view, wrap);
    }, this.joinable ? "Place with next image" : "Place with next figure");
    if (!this.inRow && !view.state.readOnly) toolbar.append(figureMoveGrip(view, wrap));
    wrap.append(toolbar);
    syncImageRow(wrap, view, this.from, this.layout, resizableImage);
    if (resizableImage) {
      wrap.append(buildImageResizeHandle(wrap, resizableImage, this.layout, applyLayout, view));
    }
    if (!this.inRow && !view.state.readOnly) wrap.append(figureHeightHandle(view, wrap, "image"));

    return this.registerMeasured(wrap, view);
  }

  ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return Boolean(target?.closest(".cm-image-toolbar, .cm-image-resize-handle, .cm-figure-height-handle, .cm-image-row-grip, .cm-image-row-split, .cm-image-row-height, .cm-media-player"));
  }
}

function syncImageRow(
  figure: HTMLElement, view: EditorView, from: number, layout: ImageLayoutAttrs,
  image: HTMLImageElement | null = figure.querySelector<HTMLImageElement>("img.cm-image-render"),
): void {
  const inRow = imageRowAt(view.state, from) !== null;
  figure.classList.toggle("cm-image-row-item", inRow);
  const existing = figure.querySelector<HTMLElement>(".cm-image-row-grip");
  const splitter = figure.querySelector<HTMLElement>(".cm-image-row-split");
  const heightHandle = figure.querySelector<HTMLElement>(".cm-image-row-height");
  if (!inRow || view.state.readOnly) {
    existing?.remove();
    splitter?.remove();
    heightHandle?.remove();
    figure.style.removeProperty("--cm-image-row-weight");
    return;
  }
  sizeImageRowItem(figure, image, layout);
  if (!existing) {
    const grip = imageRowGrip(view, figure);
    if (grip) figure.append(grip);
  }
  const row = imageRowAt(view.state, from);
  const index = row?.images.findIndex((span) => span.from === from) ?? -1;
  if (index === 0 && !heightHandle) {
    const handle = imageRowHeightHandle(view, figure);
    if (handle) figure.append(handle);
  } else if (index !== 0) heightHandle?.remove();
  if (index >= 0 && row && index < row.images.length - 1) {
    if (!splitter) {
      const handle = imageRowSplitHandle(view, figure);
      if (handle) figure.append(handle);
    }
  } else splitter?.remove();
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
    if (event.button !== 0 || view.state.readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const originalWidth = wrap.style.getPropertyValue("--aaronnote-image-width");
    const originalMaxWidth = wrap.style.getPropertyValue("--aaronnote-image-max-width");
    const rowItem = wrap.classList.contains("cm-image-row-item");
    const originalRowWeight = wrap.style.getPropertyValue("--cm-image-row-weight");
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
      if (rowItem) wrap.style.setProperty("--cm-image-row-weight", String(Math.max(0.25, Math.min(4, pendingWidth / 220))));
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
      if (originalWidth) wrap.style.setProperty("--aaronnote-image-width", originalWidth);
      else wrap.style.removeProperty("--aaronnote-image-width");
      if (originalMaxWidth) wrap.style.setProperty("--aaronnote-image-max-width", originalMaxWidth);
      else wrap.style.removeProperty("--aaronnote-image-max-width");
      if (rowItem) {
        if (originalRowWeight) wrap.style.setProperty("--cm-image-row-weight", originalRowWeight);
        else wrap.style.removeProperty("--cm-image-row-weight");
      }
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
  arrangeNext?: () => void,
  arrangeTitle = "Place with next figure",
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
  if (arrangeNext) bar.append(imageToolSeparator(), imageToolButton("↔", arrangeTitle, false, arrangeNext));
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
        // Only a caret opens an image's source. A range keeps it rendered,
        // as `activeImageSourceKey` already assumes: a rebuild during a range
        // selection (scroll, resize) used to reveal every crossed image.
        const cursorInside = !vimKeepsRenderedObjects(view)
          && sel.empty && sel.from <= fullTo && sel.from >= node.from;

        const raw = doc.sliceString(node.from, node.to);
        const m = raw.match(IMAGE_RE);
        const alt = m?.[1] ?? "";
        // src may include optional title; strip the title part and trim
        const srcFull = m?.[2] ?? "";
        const src = markdownLinkDestination(srcFull);
        const layout = imageLayoutFromAttrs(trailing?.attrs ?? {});
        if (cursorInside) {
          // Editing the source of an image that has a line to itself keeps the
          // picture under it, as MarkText and Typora show source and image
          // together. Replacing the picture with one line of source collapsed
          // the page every time the caret passed an image.
          if (!line.text.slice(0, node.from - line.from).trim() && !line.text.slice(fullTo - line.from).trim()) {
            decos.push(
              Decoration.widget({
                widget: new ImageWidget(src, alt, node.from, node.to, fullTo, layout,
                  Boolean(imageRowAt(view.state, node.from)), joinNextImage(view, node.from, false)),
                side: 1,
              }).range(fullTo),
            );
          }
          return false; // editable source
        }

        decos.push(
          Decoration.replace({
            widget: new ImageWidget(src, alt, node.from, node.to, fullTo, layout,
              Boolean(imageRowAt(view.state, node.from)), joinNextImage(view, node.from, false)),
            vimAtomic: true,
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
          const cursorInside = !vimKeepsRenderedObjects(view)
            && sel.empty && sel.from <= fullTo && sel.from >= from;
          if (cursorInside) continue;
          const layout = imageLayoutFromAttrs(trailing?.attrs ?? {});
          decos.push(
            Decoration.replace({
              widget: new ImageWidget(src, alt, from, to, fullTo, layout),
              vimAtomic: true,
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
  // A range selects the image's Markdown source without turning every crossed
  // image back into source. The old position-bearing `wide` key changed on
  // every pointer move and forced a full visible-image redecoration each time.
  if (!sel.empty) return "";
  const doc = view.state.doc;
  const firstLine = doc.lineAt(sel.from).number;
  const lastLine = doc.lineAt(Math.min(sel.to, doc.length)).number;
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

type ImagePluginSnapshot = { decorations: DecorationSet; activeSourceKey: string };
const imagePluginCacheKey = {};

class ImagePlugin {
  decorations: DecorationSet;
  private readonly view: EditorView;
  private activeSourceKey: string;

  constructor(view: EditorView) {
    this.view = view;
    const cached = restorePersistentVisualPluginState<ImagePluginSnapshot>(
      view.state,
      imagePluginCacheKey,
    );
    this.activeSourceKey = cached?.activeSourceKey ?? activeImageSourceKey(view);
    this.decorations = cached?.decorations ?? buildImageDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.compositionStarted && update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    if (isCoalescedVisualTyping(update) && this.mapSourceRanges(update)) {
      this.decorations = this.decorations.map(update.changes);
      return;
    }
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

  private mapSourceRanges(update: ViewUpdate): boolean {
    // The decoration positions map during a typing burst; their DOM metadata
    // must follow too, since source clicks, attachment links and layout menus
    // use it before the delayed rebuild. This only touches mounted figures and
    // reads no layout. Editing a figure itself requires a fresh render instead.
    const figures = [...update.view.dom.querySelectorAll<HTMLElement>(".cm-image-widget[data-cm-source-base-to]:not(.cm-tikz-env-widget)")];
    if (figures.some((figure) => update.changes.touchesRange(
      Number(figure.dataset.cmSourceFrom), Number(figure.dataset.cmSourceTo),
    ))) return false;
    for (const figure of figures) {
      const from = update.changes.mapPos(Number(figure.dataset.cmSourceFrom), 1);
      const to = update.changes.mapPos(Number(figure.dataset.cmSourceTo), -1);
      const baseTo = update.changes.mapPos(Number(figure.dataset.cmSourceBaseTo), -1);
      setSourceRange(figure, from, to);
      figure.dataset.cmSourceBaseTo = String(baseTo);
    }
    return true;
  }

  destroy(): void {
    rememberPersistentVisualPluginState(this.view, imagePluginCacheKey, {
      decorations: this.decorations,
      activeSourceKey: this.activeSourceKey,
    } satisfies ImagePluginSnapshot);
  }
}

export const imageExtension = ViewPlugin.fromClass(ImagePlugin, {
  decorations: (v) => v.decorations,
});
