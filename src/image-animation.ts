/**
 * Scroll-time image animation controller adapted from SiYuan's
 * app/src/protyle/util/imageAnimation.ts (AGPL-3.0).
 */

import type { RendererActivityParticipant, RendererActivityState } from "./renderer-activity.ts";

export const IMAGE_ANIMATION_PAUSED_CLASS = "noema-image-animation-paused";
export const IMAGE_ANIMATION_FREEZE_FRAME_CLASS = "noema-image-animation-freeze-frame";

type ImageAnimationEffects = {
  pause: (element: HTMLElement) => void;
  resume: (element: HTMLElement) => void;
};

type ImageAnimationFreezeFallbackOptions = {
  createCanvas?: () => HTMLCanvasElement;
  devicePixelRatio?: () => number;
  maxCanvasPixels?: number;
};

type FrozenImage = {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  display: string;
  displayPriority: string;
};

const ANIMATED_IMAGE_SOURCE_RE = /\.(?:gif|apng|webp)(?:[?#&]|$)/i;
const ANIMATED_IMAGE_DATA_RE = /^data:image\/(?:gif|apng|webp)(?:[;,]|$)/i;

/**
 * Return whether an image URL is likely to contain multiple frames.
 *
 * Static WebP files are intentionally included: browsers expose no portable
 * animation introspection before `:animated-image`, and freezing the handful
 * of visible WebP images is cheaper than letting one animated WebP keep the
 * compositor awake indefinitely. Ordinary PNG/JPEG assets stay untouched.
 */
export function imageSourceMayAnimate(source: string): boolean {
  const raw = String(source || "").trim();
  if (!raw) return false;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* retain the original URL */ }
  return ANIMATED_IMAGE_DATA_RE.test(decoded) || ANIMATED_IMAGE_SOURCE_RE.test(decoded);
}

function nativeImageAnimationControlAvailable(): boolean {
  return typeof CSS !== "undefined"
    && typeof CSS.supports === "function"
    && CSS.supports("image-animation", "paused");
}

/**
 * Freeze likely animated `<img>` elements in engines that do not implement
 * CSS Image Animation. A single canvas captures the currently painted frame;
 * the original image remains in the DOM but is not painted, which stops
 * WebKit/Blink from scheduling subsequent decoder/compositor frames. Restoring
 * activity removes the canvas and reveals the exact original element.
 */
export function createImageAnimationFreezeFallback(
  options: ImageAnimationFreezeFallbackOptions = {},
): ImageAnimationEffects {
  const frozen = new Map<HTMLImageElement, FrozenImage>();
  const createCanvas = options.createCanvas ?? (() => document.createElement("canvas"));
  const readDevicePixelRatio = options.devicePixelRatio
    ?? (() => Math.max(1, Number(globalThis.devicePixelRatio) || 1));
  const maxCanvasPixels = Math.max(1, options.maxCanvasPixels ?? 2_000_000);

  const restore = (image: HTMLImageElement, record: FrozenImage): void => {
    record.canvas.remove();
    if (record.display) image.style.setProperty("display", record.display, record.displayPriority);
    else image.style.removeProperty("display");
    frozen.delete(image);
  };

  const freeze = (root: HTMLElement, image: HTMLImageElement): void => {
    if (frozen.has(image) || !image.isConnected || !image.complete || image.naturalWidth <= 0) return;
    if (!imageSourceMayAnimate(image.currentSrc || image.src)) return;
    const rect = image.getBoundingClientRect();
    const width = rect.width || image.width || image.naturalWidth;
    const height = rect.height || image.height || image.naturalHeight;
    if (!(width > 0) || !(height > 0)) return;

    const requestedScale = Math.max(1, readDevicePixelRatio());
    const boundedScale = Math.min(requestedScale, Math.sqrt(maxCanvasPixels / (width * height)));
    const canvas = createCanvas();
    const pixelWidth = Math.max(1, Math.round(width * boundedScale));
    const pixelHeight = Math.max(1, Math.round(height * boundedScale));
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.className = `${image.className} ${IMAGE_ANIMATION_FREEZE_FRAME_CLASS}`.trim();
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.setProperty("width", `${width}px`, "important");
    canvas.style.setProperty("height", `${height}px`, "important");

    const context = canvas.getContext("2d");
    if (!context) return;
    try {
      context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
      context.drawImage(image, 0, 0, width, height);
    } catch {
      // A browser may reject an unusual image source. Leaving that one image
      // live is safer than replacing it with an empty frame.
      return;
    }

    const display = image.style.getPropertyValue("display");
    const displayPriority = image.style.getPropertyPriority("display");
    image.before(canvas);
    image.style.setProperty("display", "none", "important");
    frozen.set(image, { root, canvas, display, displayPriority });
  };

  return {
    pause(root): void {
      if (root instanceof HTMLImageElement) freeze(root, root);
      root.querySelectorAll<HTMLImageElement>("img").forEach((image) => freeze(root, image));
    },
    resume(root): void {
      for (const [image, record] of frozen) {
        if (record.root === root) restore(image, record);
      }
    },
  };
}

export function createImageAnimationController<T>(
  setTimer: (callback: () => void, delay: number) => T,
  clearTimer: (timer: T) => void,
  effects?: ImageAnimationEffects,
) {
  const resumeTimers = new WeakMap<HTMLElement, T>();

  const cancelResume = (element: HTMLElement): void => {
    const timer = resumeTimers.get(element);
    if (typeof timer === "undefined") return;
    clearTimer(timer);
    resumeTimers.delete(element);
  };

  const pause = (element: HTMLElement): void => {
    cancelResume(element);
    element.classList.add(IMAGE_ANIMATION_PAUSED_CLASS);
    effects?.pause(element);
  };

  const resume = (element: HTMLElement, delay: number): void => {
    cancelResume(element);
    if (!element.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)) return;
    if (delay <= 0) {
      element.classList.remove(IMAGE_ANIMATION_PAUSED_CLASS);
      effects?.resume(element);
      return;
    }
    const timer = setTimer(() => {
      resumeTimers.delete(element);
      element.classList.remove(IMAGE_ANIMATION_PAUSED_CLASS);
      effects?.resume(element);
    }, delay);
    resumeTimers.set(element, timer);
  };

  const pauseTemporarily = (element: HTMLElement, delay: number): void => {
    pause(element);
    resume(element, delay);
  };

  return { pause, pauseTemporarily, resume };
}

const imageAnimationEffects = nativeImageAnimationControlAvailable()
  ? undefined
  : createImageAnimationFreezeFallback();

const imageAnimationController = createImageAnimationController(
  (callback, delay) => globalThis.setTimeout(callback, delay),
  (timer) => globalThis.clearTimeout(timer),
  imageAnimationEffects,
);

export const pauseImageAnimation = imageAnimationController.pause;
export const pauseImageAnimationTemporarily = imageAnimationController.pauseTemporarily;
export const resumeImageAnimation = imageAnimationController.resume;

/**
 * Pause only the animated images inside a scrolling editor.
 *
 * Applying the paused class to the editor root invalidates selector matching
 * for its entire descendant tree. Formula-heavy notes contain thousands of
 * KaTeX elements, so that broad class mutation can turn every scroll event
 * into a full style recalculation even when the note contains no images.
 * Scoping the mutation to likely animated image nodes keeps the same behavior
 * without coupling unrelated visual widgets to the image policy.
 */
export function pauseScrollingImageAnimationTemporarily(
  root: HTMLElement,
  delay: number,
): void {
  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    if (!imageSourceMayAnimate(image.currentSrc || image.src)) return;
    pauseImageAnimationTemporarily(image, delay);
  });
}

/** Pause animated editor images whenever the shared renderer is idle/hidden. */
export function imageAnimationActivityParticipant(element: HTMLElement): RendererActivityParticipant {
  return {
    setActivity(state: RendererActivityState): void {
      if (state === "active" || state === "recently-active") {
        resumeImageAnimation(element, 0);
      } else {
        pauseImageAnimation(element);
      }
    },
  };
}
