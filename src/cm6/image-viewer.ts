/** Lightweight Noema adaptation of Adjustable Media's layout image viewer. */

type MediaSource = { src: string; alt: string };

export function openImageViewer(figure: HTMLElement, origin?: HTMLImageElement): void {
  const selected = origin ?? figure.querySelector<HTMLImageElement>("img.cm-image-render");
  if (!selected) return;
  const siblings = figure.classList.contains("cm-image-row-item")
    ? [...(figure.parentElement?.children ?? [])].filter((item): item is HTMLElement =>
        item instanceof HTMLElement && item.classList.contains("cm-image-row-item"))
    : [figure];
  const items = figure === selected ? [selected] : siblings.flatMap((item) => {
    const image = item.querySelector<HTMLImageElement>("img.cm-image-render");
    return image ? [image] : [];
  });
  if (items.length === 0) return;
  const sources = items.map((image) => ({ src: image.currentSrc || image.src, alt: image.alt }));
  openMediaViewer(sources, Math.max(0, items.indexOf(selected)), selected, "Image");
}

/** Shared by the editor and standalone HTML. Keep the browser implementation self-contained. */
export function openMediaViewer(
  sources: readonly MediaSource[], initial: number, origin: HTMLElement, kind: "Image" | "Diagram", release?: () => void,
): void {
  const document = origin.ownerDocument;
  document.querySelector<HTMLDialogElement>("dialog.cm-image-viewer[open]")?.close();
  const overlay = document.createElement("dialog");
  overlay.className = "cm-image-viewer";
  overlay.setAttribute("aria-label", `${kind} viewer`);
  const stage = document.createElement("div");
  stage.className = "cm-image-viewer-stage";
  const image = document.createElement("img");
  image.className = "cm-image-viewer-image";
  image.draggable = false;
  stage.append(image);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cm-image-viewer-close";
  close.textContent = "×";
  close.setAttribute("aria-label", `Close ${kind.toLowerCase()} viewer`);
  const counter = document.createElement("span");
  counter.className = "cm-image-viewer-counter";
  overlay.append(stage, close, counter);
  document.body.append(overlay);
  const listeners = new AbortController();
  let index = initial;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const paint = () => { image.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; };
  const show = () => {
    const source = sources[index]!;
    image.src = source.src;
    image.alt = source.alt;
    counter.textContent = sources.length > 1 ? `${index + 1} / ${sources.length}` : "";
    zoom = 1;
    panX = panY = 0;
    paint();
  };
  const teardown = () => {
    listeners.abort();
    overlay.remove();
    release?.();
    if (!document.querySelector("dialog.cm-image-viewer[open]") && origin.isConnected) origin.focus({ preventScroll: true });
  };
  const finish = () => {
    overlay.close();
    teardown();
  };
  overlay.addEventListener("close", teardown, { once: true, signal: listeners.signal });
  close.addEventListener("click", finish, { signal: listeners.signal });
  stage.addEventListener("click", (event) => { if (event.target === stage) finish(); }, { signal: listeners.signal });
  const zoomAt = (next: number, x: number, y: number) => {
    const desired = Math.min(10, Math.max(1, next));
    const rect = stage.getBoundingClientRect();
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    panX = desired === 1 ? 0 : dx - ((dx - panX) * desired) / zoom;
    panY = desired === 1 ? 0 : dy - ((dy - panY) * desired) / zoom;
    zoom = desired;
    paint();
  };
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY);
  }, { passive: false, signal: listeners.signal });
  image.addEventListener("dblclick", (event) => {
    event.preventDefault();
    zoomAt(zoom > 1 ? 1 : 2.5, event.clientX, event.clientY);
  }, { signal: listeners.signal });
  image.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || zoom <= 1) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const oldX = panX;
    const oldY = panY;
    image.setPointerCapture?.(event.pointerId);
    const move = (pointer: PointerEvent) => { panX = oldX + pointer.clientX - startX; panY = oldY + pointer.clientY - startY; paint(); };
    const stop = () => { image.removeEventListener("pointermove", move); image.removeEventListener("pointerup", stop); image.removeEventListener("pointercancel", cancel); };
    const cancel = () => { stop(); panX = oldX; panY = oldY; paint(); };
    image.addEventListener("pointermove", move);
    image.addEventListener("pointerup", stop);
    image.addEventListener("pointercancel", cancel);
  }, { signal: listeners.signal });
  document.addEventListener("keydown", (event) => {
    if (!overlay.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (sources.length < 2) return;
      event.preventDefault();
      event.stopPropagation();
      index = (index + (event.key === "ArrowLeft" ? -1 : 1) + sources.length) % sources.length;
      show();
    }
  }, { capture: true, signal: listeners.signal });
  show();
  overlay.showModal();
  close.focus({ preventScroll: true });
}

/** Use the same image activation for native widgets and rendered document fragments. */
export function connectImagePreview(image: HTMLImageElement, activate: () => void, singleClick = false): void {
  if (image.closest("a") || image.classList.contains("noema-media-trigger")) return;
  image.tabIndex = 0;
  image.setAttribute("role", "button");
  image.setAttribute("aria-haspopup", "dialog");
  image.setAttribute("aria-label", image.alt ? `Enlarge ${image.alt}` : "Enlarge image");
  image.classList.add("noema-media-trigger");
  const open = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  };
  if (!singleClick) image.addEventListener("dblclick", open);
  image.addEventListener("click", (event) => {
    if (singleClick || event.detail === 0) open(event);
  });
  image.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") open(event);
  });
}

/** Activate the images already shipped in the standalone article. */
export function connectPublishedImages(
  root: HTMLElement,
  connect: typeof connectImagePreview,
  open: typeof openMediaViewer,
): void {
  for (const image of root.querySelectorAll("img")) {
    connect(image, () => {
      const group = image.closest(".noema-image-layout-row");
      const items = group ? [...group.querySelectorAll("img")].filter((item) => !item.closest("a")) : [image];
      const sources = items.map((item) => ({ src: item.currentSrc || item.src, alt: item.alt }));
      open(sources, Math.max(0, items.indexOf(image)), image, "Image");
    }, true);
  }
}

export function connectDiagramPreview(container: HTMLElement, host: HTMLElement): void {
  const existing = host.querySelector<HTMLButtonElement>(":scope > .noema-diagram-enlarge");
  if (!container.querySelector("svg")) { existing?.remove(); return; }
  if (existing) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "noema-diagram-enlarge";
  button.textContent = "⤢";
  button.setAttribute("aria-label", "Enlarge diagram");
  button.title = "Enlarge diagram";
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const svg = container.querySelector("svg");
    if (!svg) return;
    const text = new XMLSerializer().serializeToString(svg);
    const src = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    openMediaViewer([{ src, alt: "Diagram" }], 0, button, "Diagram", () => URL.revokeObjectURL(src));
  });
  host.append(button);
}
