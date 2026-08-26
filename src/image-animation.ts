/**
 * Scroll-time image animation controller adapted from SiYuan's
 * app/src/protyle/util/imageAnimation.ts (AGPL-3.0).
 */

export const IMAGE_ANIMATION_PAUSED_CLASS = "noema-image-animation-paused";

export function createImageAnimationController<T>(
  setTimer: (callback: () => void, delay: number) => T,
  clearTimer: (timer: T) => void,
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
  };

  const resume = (element: HTMLElement, delay: number): void => {
    cancelResume(element);
    if (!element.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)) return;
    if (delay <= 0) {
      element.classList.remove(IMAGE_ANIMATION_PAUSED_CLASS);
      return;
    }
    const timer = setTimer(() => {
      resumeTimers.delete(element);
      element.classList.remove(IMAGE_ANIMATION_PAUSED_CLASS);
    }, delay);
    resumeTimers.set(element, timer);
  };

  const pauseTemporarily = (element: HTMLElement, delay: number): void => {
    pause(element);
    resume(element, delay);
  };

  return { pause, pauseTemporarily, resume };
}

const imageAnimationController = createImageAnimationController(
  (callback, delay) => globalThis.setTimeout(callback, delay),
  (timer) => globalThis.clearTimeout(timer),
);

export const pauseImageAnimation = imageAnimationController.pause;
export const pauseImageAnimationTemporarily = imageAnimationController.pauseTemporarily;
export const resumeImageAnimation = imageAnimationController.resume;
