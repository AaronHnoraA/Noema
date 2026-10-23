import { afterEach, beforeEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  HTML_EMBED_PARK_HIDDEN_MS,
  HTML_EMBED_PARK_OFFSCREEN_MS,
  htmlEmbedActivityParticipant,
  htmlEmbedCount,
  mountHtmlEmbed,
  type HtmlEmbedHandle,
} from "../src/html-embed.ts";

/** A hand-driven IntersectionObserver: tests decide what is in view. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  targets = new Set<Element>();
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.disconnected = true; this.targets.clear(); }
  show(target: Element, visible: boolean): void {
    this.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const original = globalThis.IntersectionObserver;
const sources = new Map<HTMLIFrameElement, string[]>();
const handles: HtmlEmbedHandle[] = [];

function embed(options: { explicitHeight?: boolean } = {}): { frame: HTMLIFrameElement; figure: HTMLElement; handle: HtmlEmbedHandle } {
  const figure = document.createElement("figure");
  const frame = document.createElement("iframe");
  figure.append(frame);
  document.body.append(figure);
  sources.set(frame, []);
  const handle = mountHtmlEmbed(frame, {
    src: "noema-asset://page.html",
    title: "page.html",
    container: figure,
    explicitHeight: options.explicitHeight,
    setSource: (target, src) => { sources.get(target)?.push(src); },
  });
  handles.push(handle);
  return { frame, figure, handle };
}

const observer = (): FakeObserver => FakeObserver.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeObserver.instances = [];
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  htmlEmbedActivityParticipant().setActivity?.("active");
  document.body.replaceChildren();
  sources.clear();
  globalThis.IntersectionObserver = original;
  vi.useRealTimers();
});

describe("HTML embed lifecycle", () => {
  test("loads only once the frame comes near the viewport", () => {
    const { frame, handle } = embed();
    expect(handle.state()).toBe("pending");
    expect(sources.get(frame)).toEqual([]);
    observer().show(frame, true);
    expect(handle.state()).toBe("live");
    expect(sources.get(frame)).toEqual(["noema-asset://page.html"]);
  });

  test("parks a frame that stays off screen and reloads it on return", () => {
    const { frame, handle } = embed();
    observer().show(frame, true);
    observer().show(frame, false);
    vi.advanceTimersByTime(HTML_EMBED_PARK_OFFSCREEN_MS - 1);
    expect(handle.state()).toBe("live");
    vi.advanceTimersByTime(1);
    expect(handle.state()).toBe("parked");
    expect(sources.get(frame)!.at(-1)).toBe("about:blank");
    observer().show(frame, true);
    expect(handle.state()).toBe("live");
    expect(sources.get(frame)!.at(-1)).toBe("noema-asset://page.html");
  });

  test("a brief scroll away does not unload the page", () => {
    const { frame, handle } = embed();
    observer().show(frame, true);
    observer().show(frame, false);
    vi.advanceTimersByTime(1000);
    observer().show(frame, true);
    vi.advanceTimersByTime(HTML_EMBED_PARK_OFFSCREEN_MS * 2);
    expect(handle.state()).toBe("live");
    expect(sources.get(frame)).toHaveLength(1);
  });

  test("parks visible frames while the pane stays hidden, and restores them", () => {
    const { frame, handle } = embed();
    observer().show(frame, true);
    const participant = htmlEmbedActivityParticipant();
    participant.setActivity?.("hidden");
    vi.advanceTimersByTime(HTML_EMBED_PARK_HIDDEN_MS);
    expect(handle.state()).toBe("parked");
    participant.setActivity?.("active");
    expect(handle.state()).toBe("live");
  });

  test("dispose releases the observer entry and, with the last embed, the shared listeners", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const first = embed();
    const second = embed();
    expect(htmlEmbedCount()).toBe(2);
    expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
    first.handle.dispose();
    expect(observer().targets.has(first.frame)).toBe(false);
    expect(observer().disconnected).toBe(false);
    second.handle.dispose();
    expect(htmlEmbedCount()).toBe(0);
    expect(observer().disconnected).toBe(true);
    expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  test("a disposed frame's pending park timer does nothing", () => {
    const { frame, handle } = embed();
    observer().show(frame, true);
    observer().show(frame, false);
    handle.dispose();
    vi.advanceTimersByTime(HTML_EMBED_PARK_OFFSCREEN_MS);
    expect(sources.get(frame)!.at(-1)).toBe("noema-asset://page.html");
  });
});

describe("HTML embed bridge", () => {
  function post(frame: HTMLIFrameElement, data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
  }

  test("opens a roam link through the editor's link route", () => {
    const { frame, figure } = embed();
    observer().show(frame, true);
    const opened: unknown[] = [];
    figure.addEventListener("noema:open-url", (event) => opened.push((event as CustomEvent).detail));
    post(frame, { type: "noema:open-url", href: "roam://20261016T101010" });
    post(frame, { type: "noema:open-url", href: "javascript:alert(1)" });
    expect(opened).toEqual([{ href: "roam://20261016T101010", newWindow: false }]);
  });

  test("ignores messages from any other window", () => {
    const { frame, figure } = embed();
    observer().show(frame, true);
    const opened: unknown[] = [];
    figure.addEventListener("noema:open-url", (event) => opened.push(event));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "noema:open-url", href: "roam://x" }, source: window }));
    expect(opened).toEqual([]);
  });

  test("resizes to the page's height unless the note fixed one", () => {
    const fluid = embed();
    observer().show(fluid.frame, true);
    post(fluid.frame, { type: "noema:resize", height: 812.4 });
    expect(fluid.frame.style.height).toBe("812px");
    const fixed = embed({ explicitHeight: true });
    observer().show(fixed.frame, true);
    post(fixed.frame, { type: "noema:resize", height: 812 });
    expect(fixed.frame.style.height).toBe("");
  });

  test("full screen keeps the frame live, exits on Escape and never parks meanwhile", () => {
    const { frame, handle } = embed();
    observer().show(frame, true);
    handle.toggleFullscreen(true);
    expect(document.querySelector(".noema-embed-fullscreen-bar")).not.toBeNull();
    observer().show(frame, false);
    vi.advanceTimersByTime(HTML_EMBED_PARK_OFFSCREEN_MS * 2);
    expect(handle.state()).toBe("live");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".noema-embed-fullscreen-bar")).toBeNull();
    expect(document.querySelector(".noema-embed-fullscreen")).toBeNull();
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(false);
  });

  test("disposing a full-screen embed tears the full screen down", () => {
    const { frame, handle } = embed();
    observer().show(frame, true);
    handle.toggleFullscreen(true);
    handle.dispose();
    expect(document.querySelector(".noema-embed-fullscreen-bar")).toBeNull();
    expect(document.querySelector("iframe.noema-embed-fullscreen")).toBeNull();
  });
});
