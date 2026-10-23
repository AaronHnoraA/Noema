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
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Line, Range } from "@codemirror/state";
import { parser as markdownParser } from "@lezer/markdown";
import { rangeInsideAny } from "../../../math-ranges.ts";
import {
  constructSources,
  constructViewPlugin,
  literalRangesOnLine,
  renderedConstructsPinned,
  selectionOpensSource,
  type ConstructSource,
} from "../constructs/index.ts";
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
import { mountHtmlEmbed, type HtmlEmbedHandle } from "../../../../html-embed.ts";
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

declare global {
  interface Window {
    NoemaResolveAssetUrl?: (src: string) => string;
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
    const resolved = window.NoemaResolveAssetUrl?.(path) ?? path;
    const exported = drawioImageSrc(resolved, page);
    return exported ? { src: exported, card: false } : { src: resolved, card: true };
  }
  return { src: window.NoemaResolveAssetUrl?.(raw) ?? raw, card: false };
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
      iframe.setAttribute("data-noema-src", frame.src);
    } else {
      iframe.setAttribute("src", frame.src);
    }
    return;
  }
  if (happyDomTestEnvironmentP()) {
    iframe.setAttribute("data-noema-srcdoc", frame.srcdoc);
  } else {
    iframe.setAttribute("srcdoc", frame.srcdoc);
  }
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

/** The lifecycle handle of an HTML embed, keyed by its figure. */
const htmlEmbeds = new WeakMap<HTMLElement, HtmlEmbedHandle>();

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
          iframe.setAttribute("allow", VISUAL_ATTACHMENT_IFRAME_ALLOW);
          iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
          iframe.setAttribute("sandbox", visualAttachmentSandbox(kind));
          if (frame.mode === "src") {
            // The controller loads the document near the viewport, unloads it
            // when it stays away, and is released in destroy().
            htmlEmbeds.set(wrap, mountHtmlEmbed(iframe, {
              src: frame.src,
              title: this.alt.trim() || this.src.split(/[?#]/, 1)[0]!.split("/").pop() || "HTML",
              container: wrap,
              explicitHeight: Boolean(this.layout.height),
              onResize: () => { if (wrap.isConnected) view.requestMeasure(); },
              setSource: (target, src) => setVisualFrameSource(target, { kind, mode: "src", src }),
            }));
          } else {
            setVisualFrameSource(iframe, frame);
          }
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
    const embed = htmlEmbeds.get(wrap);
    if (embed) toolbar.append(imageToolSeparator(), imageToolButton("⤢", "Full screen (Esc exits)", false, () => embed.toggleFullscreen(true)));
    wrap.append(toolbar);
    syncImageRow(wrap, view, this.from, this.layout, resizableImage);
    if (resizableImage) {
      wrap.append(buildImageResizeHandle(wrap, resizableImage, this.layout, applyLayout, view));
    }
    if (!this.inRow && !view.state.readOnly) wrap.append(figureHeightHandle(view, wrap, "image"));

    return this.registerMeasured(wrap, view);
  }

  destroy(dom: HTMLElement): void {
    htmlEmbeds.get(dom)?.dispose();
    htmlEmbeds.delete(dom);
    super.destroy(dom);
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
    const originalWidth = wrap.style.getPropertyValue("--noema-image-width");
    const originalMaxWidth = wrap.style.getPropertyValue("--noema-image-max-width");
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
      wrap.style.setProperty("--noema-image-width", `${pendingWidth}px`);
      wrap.style.setProperty("--noema-image-max-width", "none");
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
      if (originalWidth) wrap.style.setProperty("--noema-image-width", originalWidth);
      else wrap.style.removeProperty("--noema-image-width");
      if (originalMaxWidth) wrap.style.setProperty("--noema-image-max-width", originalMaxWidth);
      else wrap.style.removeProperty("--noema-image-max-width");
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

/** One image on a line: its Markdown source, any trailing `{...}` layout, and what to draw. */
type ImageMatch = {
  from: number;
  /** End of the image syntax itself. */
  to: number;
  /** End including the trailing layout attributes. */
  fullTo: number;
  alt: string;
  src: string;
  layout: ImageLayoutAttrs;
  /** A Markdown `![...](...)` image, as opposed to an `[](page.html)` embed. */
  markdown: boolean;
};

const imagesByLine = new WeakMap<EditorState, Map<number, readonly ImageMatch[]>>();

/** Markdown Image nodes inside LINE: from the editor's tree, or a parse of the line when the tree has not reached it. */
function imageNodesOnLine(state: EditorState, line: Line): Array<{ from: number; to: number; labelEnd: number | null; url: { from: number; to: number } | null }> {
  const nodes: Array<{ from: number; to: number; labelEnd: number | null; url: { from: number; to: number } | null }> = [];
  const parsed = syntaxTreeAvailable(state, line.to);
  const tree = parsed ? syntaxTree(state) : markdownParser.parse(line.text);
  const offset = parsed ? 0 : line.from;
  tree.iterate({
    from: parsed ? line.from : 0,
    to: parsed ? line.to : line.text.length,
    enter(node) {
      if (node.name !== "Image") return;
      const from = node.from + offset;
      const to = node.to + offset;
      // `![alt⏎](src)` is one image to Markdown, but CodeMirror refuses a
      // plugin decoration that replaces a line break: the whole view update
      // throws and the document cannot be opened. Such an image stays source.
      if (from < line.from || to > line.to) return false;
      // The syntax tree knows where the label ends and what the destination
      // is. Cutting the source at the first `)` truncated every path with a
      // parenthesis in it: `fig(1).png`, `<image (1).png>`.
      const close = node.node.getChildren("LinkMark")
        .find((mark) => line.text.slice(mark.from + offset - line.from, mark.to + offset - line.from) === "]");
      const url = node.node.getChild("URL");
      nodes.push({
        from,
        to,
        labelEnd: close ? close.from + offset : null,
        url: url ? { from: url.from + offset, to: url.to + offset } : null,
      });
      return false;
    },
  });
  return nodes;
}

/** The images drawn on LINE, outside code and math, in source order; cached by state. */
function imagesOnLine(state: EditorState, line: Line): readonly ImageMatch[] {
  let byLine = imagesByLine.get(state);
  if (!byLine) imagesByLine.set(state, byLine = new Map());
  const cached = byLine.get(line.from);
  if (cached) return cached;
  const images: ImageMatch[] = [];
  if (line.text.includes("](")) {
    const literal = literalRangesOnLine(state, line);
    const trailingAttrs = (to: number) => {
      const trailing = readImageTrailingAttrs(line.text.slice(to - line.from), 0);
      return { fullTo: trailing ? to + trailing.to : to, layout: imageLayoutFromAttrs(trailing?.attrs ?? {}) };
    };
    for (const node of imageNodesOnLine(state, line)) {
      if (rangeInsideAny(node.from, node.to, literal)) continue;
      const raw = line.text.slice(node.from - line.from, node.to - line.from);
      const m = raw.match(IMAGE_RE);
      const alt = node.labelEnd != null ? line.text.slice(node.from + 2 - line.from, node.labelEnd - line.from) : m?.[1] ?? "";
      const src = node.url
        ? markdownLinkDestination(line.text.slice(node.url.from - line.from, node.url.to - line.from), { stripTitle: false })
        : markdownLinkDestination(m?.[2] ?? "");
      images.push({ from: node.from, to: node.to, alt, src, markdown: true, ...trailingAttrs(node.to) });
    }
    EMPTY_HTML_LINK_EMBED_RE.lastIndex = 0;
    for (const match of line.text.matchAll(EMPTY_HTML_LINK_EMBED_RE)) {
      if (line.text[(match.index ?? 0) - 1] === "!") continue;
      const src = markdownLinkDestination(match[1] ?? "");
      if (visualAttachmentKind(src) !== "html") continue;
      const from = line.from + (match.index ?? 0);
      const to = from + (match[0] ?? "").length;
      if (rangeInsideAny(from, to, literal) || images.some((image) => from < image.fullTo && to > image.from)) continue;
      images.push({ from, to, alt: "", src, markdown: false, ...trailingAttrs(to) });
    }
    images.sort((left, right) => left.from - right.from);
  }
  byLine.set(line.from, images);
  return images;
}

/** Images as rendered constructs. Only a caret opens one; a range keeps it rendered. */
const imageConstructSource: ConstructSource = {
  kind: "image",
  at(state, pos) {
    return imagesOnLine(state, state.doc.lineAt(pos))
      .filter((image) => image.from <= pos && pos < image.fullTo)
      .map((image) => ({ from: image.from, to: image.fullTo, block: false, kind: "image", reveal: "caret-edge" }));
  },
};

function imageOpened(state: EditorState, image: ImageMatch): boolean {
  return selectionOpensSource(state, image.from, image.fullTo, "caret-edge", "object");
}

function buildImageDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const state = view.state;
  let previousLine = 0;
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    for (let pos = vFrom; pos <= vTo;) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= previousLine) continue;
      previousLine = line.number;
      for (const image of imagesOnLine(state, line)) {
        const widget = () => image.markdown
          ? new ImageWidget(image.src, image.alt, image.from, image.to, image.fullTo, image.layout,
            Boolean(imageRowAt(state, image.from)), joinNextImage(view, image.from, false))
          : new ImageWidget(image.src, image.alt, image.from, image.to, image.fullTo, image.layout);
        if (!imageOpened(state, image)) {
          decos.push(Decoration.replace({ widget: widget() }).range(image.from, image.fullTo));
          continue;
        }
        // Editing the source of an image that has a line to itself keeps the
        // picture under it, as MarkText and Typora show source and image
        // together. Replacing the picture with one line of source collapsed
        // the page every time the caret passed an image.
        if (image.markdown
            && !line.text.slice(0, image.from - line.from).trim()
            && !line.text.slice(image.fullTo - line.from).trim()) {
          decos.push(Decoration.widget({ widget: widget(), side: 1 }).range(image.fullTo));
        }
      }
    }
  }
  return Decoration.set(decos, true);
}

/** The images the caret has opened; only the caret's line can hold one. */
function activeImageSourceKey(view: EditorView): string {
  const state = view.state;
  if (!state.selection.main.empty || renderedConstructsPinned(state)) return "";
  return imagesOnLine(state, state.doc.lineAt(state.selection.main.head))
    .filter((image) => imageOpened(state, image))
    .map((image) => `${image.from}:${image.fullTo}`)
    .join("|");
}

// ---------------------------------------------------------------------------
// ViewPlugin export
// ---------------------------------------------------------------------------

/**
 * The decoration positions map during a typing burst; their DOM metadata must
 * follow too, since source clicks, attachment links and layout menus use it
 * before the delayed rebuild. This only touches mounted figures and reads no
 * layout. Editing a figure itself requires a fresh render instead.
 */
function mapFigureSourceRanges(update: ViewUpdate): boolean {
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

export const imageExtension = constructViewPlugin({
  build: buildImageDecorations,
  revealKey: activeImageSourceKey,
  mapDuringTyping: mapFigureSourceRanges,
  provide: () => constructSources.of(imageConstructSource),
});
