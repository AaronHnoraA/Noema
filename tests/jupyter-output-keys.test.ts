import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { outputDialogEnterCloses, outputShortcut } from "../aaronnote/jupyter-output-keys.ts";

function shortcut(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return { action: outputShortcut(event), prevented: event.defaultPrevented };
}

describe("Jupyter output keyboard", () => {
  test("maps card navigation and output actions", () => {
    const card = document.createElement("article");
    expect(shortcut(card, "ArrowUp").action).toBe("previous");
    expect(shortcut(card, "ArrowDown").action).toBe("next");
    expect(shortcut(card, "Tab").action).toBe("fold");
    expect(shortcut(card, " ").action).toBe("expand");
    expect(shortcut(card, "Spacebar").action).toBe("expand");
    expect(shortcut(card, "Enter").action).toBe("popout");
    expect(shortcut(card, "Enter", { metaKey: true }).action).toBe("source");
    expect(shortcut(card, "?", { shiftKey: true }).action).toBe("help");
    expect(shortcut(card, "?", { shiftKey: false }).action).toBe("help");
  });

  test("leaves native controls and interactive widget keys alone", () => {
    const card = document.createElement("article");
    const input = document.createElement("input");
    const button = document.createElement("button");
    const widget = document.createElement("div");
    widget.className = "jupyter-widgets";
    const widgetChild = document.createElement("div");
    widget.append(widgetChild);
    const canvas = document.createElement("canvas");
    const focusable = document.createElement("div");
    focusable.tabIndex = 0;
    card.append(input, button, widget, canvas, focusable);
    for (const target of [input, button, widgetChild, canvas, focusable]) {
      expect(shortcut(target, "ArrowDown").action).toBe(null);
      expect(shortcut(target, "Tab").action).toBe(null);
      expect(shortcut(target, " ").action).toBe(null);
      expect(shortcut(target, "Enter", { metaKey: true }).action).toBe(null);
    }
    expect(shortcut(card, "ArrowDown", { shiftKey: true }).action).toBe(null);
    expect(shortcut(card, "ArrowDown", { ctrlKey: true }).action).toBe(null);
  });

  test("Enter closes full output while leaving controls inside it usable", () => {
    const dialog = document.createElement("div");
    const close = document.createElement("button");
    const body = document.createElement("div");
    const content = document.createElement("p");
    const input = document.createElement("input");
    const widgetButton = document.createElement("button");
    body.append(content, input, widgetButton);
    dialog.append(close, body);
    const closes = (target: HTMLElement, options: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options });
      target.dispatchEvent(event);
      return outputDialogEnterCloses(event, body);
    };
    expect(closes(close)).toBe(true);
    expect(closes(content)).toBe(true);
    expect(closes(input)).toBe(false);
    expect(closes(widgetButton)).toBe(false);
    expect(closes(content, { metaKey: true })).toBe(false);
  });
});
