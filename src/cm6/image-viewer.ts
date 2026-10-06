/** Lightweight Noema adaptation of Adjustable Media's layout image viewer. */
let closeViewer: (() => void) | null = null;

export function openImageViewer(figure: HTMLElement): void {
  const siblings = figure.classList.contains("cm-image-row-item")
    ? [...(figure.parentElement?.children ?? [])].filter((item): item is HTMLElement =>
        item instanceof HTMLElement && item.classList.contains("cm-image-row-item"))
    : [figure];
  const images = siblings.map((item) => item.querySelector<HTMLImageElement>("img.cm-image-render"))
    .filter((item): item is HTMLImageElement => item instanceof HTMLImageElement);
  if (images.length === 0) return;
  closeViewer?.();
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement("div");
  overlay.className = "cm-image-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Image viewer");
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
  close.setAttribute("aria-label", "Close image viewer");
  const counter = document.createElement("span");
  counter.className = "cm-image-viewer-counter";
  overlay.append(stage, close, counter);
  document.body.append(overlay);
  const listeners = new AbortController();
  let index = Math.max(0, images.indexOf(figure.querySelector<HTMLImageElement>("img.cm-image-render")!));
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const paint = () => { image.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`; };
  const show = () => {
    const source = images[index]!;
    image.src = source.currentSrc || source.src;
    image.alt = source.alt;
    counter.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : "";
    zoom = 1;
    panX = panY = 0;
    paint();
  };
  const finish = () => {
    listeners.abort();
    overlay.remove();
    if (closeViewer === finish) closeViewer = null;
    origin?.focus({ preventScroll: true });
  };
  closeViewer = finish;
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
    if (event.key === "Escape") { event.preventDefault(); finish(); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (images.length < 2) return;
      event.preventDefault();
      index = (index + (event.key === "ArrowLeft" ? -1 : 1) + images.length) % images.length;
      show();
    }
  }, { capture: true, signal: listeners.signal });
  show();
  close.focus({ preventScroll: true });
}
