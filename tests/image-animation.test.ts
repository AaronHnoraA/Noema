import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  createImageAnimationController,
  IMAGE_ANIMATION_PAUSED_CLASS,
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
});
