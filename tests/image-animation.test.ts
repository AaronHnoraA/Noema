import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  createImageAnimationController,
  createImageAnimationFreezeFallback,
  imageAnimationActivityParticipant,
  IMAGE_ANIMATION_FREEZE_FRAME_CLASS,
  IMAGE_ANIMATION_PAUSED_CLASS,
  imageSourceMayAnimate,
} from "../src/image-animation.ts";
import { createEditor } from "../src/editor-api.ts";

function createScheduler() {
  let nextID = 0;
  const callbacks = new Map<number, () => void>();
  return {
    clearTimer: (id: number) => { callbacks.delete(id); },
    runAll: () => {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      pending.forEach((callback) => callback());
    },
    setTimer: (callback: () => void) => {
      callbacks.set(++nextID, callback);
      return nextID;
    },
  };
}

describe("SiYuan-derived image animation controller", () => {
  test("pauses immediately and resumes after the scheduled delay", () => {
    const scheduler = createScheduler();
    const controller = createImageAnimationController(scheduler.setTimer, scheduler.clearTimer);
    const target = document.createElement("div");
    controller.pauseTemporarily(target, 256);
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(true);
    scheduler.runAll();
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(false);
  });

  test("cancels a scheduled resume when the element pauses again", () => {
    const scheduler = createScheduler();
    const controller = createImageAnimationController(scheduler.setTimer, scheduler.clearTimer);
    const target = document.createElement("div");
    controller.pauseTemporarily(target, 256);
    controller.pause(target);
    scheduler.runAll();
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(true);
    controller.resume(target, 0);
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(false);
  });

  test("the production CM6 scroll surface uses the controller", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "![animated](demo.gif)" });
    editor.view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(editor.view.contentDOM.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(true);
    editor.destroy();
    host.remove();
  });

  test("shared renderer quiescence pauses editor image animation without a timer", () => {
    const target = document.createElement("div");
    const participant = imageAnimationActivityParticipant(target);
    participant.setActivity?.("quiescent");
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(true);
    participant.setActivity?.("active");
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(false);
    participant.setActivity?.("hidden");
    expect(target.classList.contains(IMAGE_ANIMATION_PAUSED_CLASS)).toBe(true);
  });

  test("recognizes likely animated image URLs without penalizing ordinary assets", () => {
    expect(imageSourceMayAnimate("figure.gif")).toBe(true);
    expect(imageSourceMayAnimate("/asset?path=demo%2Eapng&v=2")).toBe(true);
    expect(imageSourceMayAnimate("data:image/webp;base64,AAAA")).toBe(true);
    expect(imageSourceMayAnimate("figure.png")).toBe(false);
    expect(imageSourceMayAnimate("figure.jpeg")).toBe(false);
  });

  test("unsupported engines freeze one painted frame and restore the original image", () => {
    const target = document.createElement("div");
    const image = document.createElement("img");
    image.className = "cm-image-render";
    image.src = "animated.gif";
    image.style.display = "block";
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 120 },
      naturalHeight: { configurable: true, value: 60 },
    });
    image.getBoundingClientRect = () => new DOMRect(0, 0, 120, 60);
    target.append(image);
    document.body.append(target);

    const drawImage = vi.fn();
    const setTransform = vi.fn();
    const context = { drawImage, setTransform } as unknown as CanvasRenderingContext2D;
    const fallback = createImageAnimationFreezeFallback({
      createCanvas: () => {
        const canvas = document.createElement("canvas");
        Object.defineProperty(canvas, "getContext", { configurable: true, value: () => context });
        return canvas;
      },
      devicePixelRatio: () => 2,
    });

    fallback.pause(target);
    const frame = target.querySelector<HTMLCanvasElement>(`.${IMAGE_ANIMATION_FREEZE_FRAME_CLASS}`);
    expect(frame).toBeTruthy();
    expect(frame?.width).toBe(240);
    expect(frame?.height).toBe(120);
    expect(image.style.getPropertyValue("display")).toBe("none");
    expect(image.style.getPropertyPriority("display")).toBe("important");
    expect(drawImage).toHaveBeenCalledTimes(1);

    // Repeated scroll events reuse the same frozen frame.
    fallback.pause(target);
    expect(drawImage).toHaveBeenCalledTimes(1);

    fallback.resume(target);
    expect(target.querySelector(`.${IMAGE_ANIMATION_FREEZE_FRAME_CLASS}`)).toBeNull();
    expect(image.style.getPropertyValue("display")).toBe("block");
    expect(image.style.getPropertyPriority("display")).toBe("");
    target.remove();
  });
});
