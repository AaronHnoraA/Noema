import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observed = new Set<Element>();
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }
  observe(target: Element): void { this.observed.add(target); }
  unobserve(target: Element): void { this.observed.delete(target); }
  disconnect(): void { this.observed.clear(); }
  resize(target: Element, width: number, height: number): void {
    this.callback([{
      target,
      contentRect: { width },
      borderBoxSize: { inlineSize: width, blockSize: height },
    } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

async function frame(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestResizeObserver.instances.length = 0;
  document.body.replaceChildren();
});

describe("wrapped figure geometry", () => {
  test("measures a changed float box and a resized xwidget pane once per frame", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const host = document.createElement("div");
    document.body.append(host);
    const source = "![diagram](missing.png){align:left; wrap:on}\n\nText beside the figure.";
    const editor = createEditor(host, { initialContent: source });
    editor.setMarkdownSelection(source.length);
    const figure = host.querySelector<HTMLElement>(".aaronnote-image-wrap");
    expect(figure).not.toBeNull();
    const figureObserver = TestResizeObserver.instances.find((observer) => observer.observed.has(figure!));
    const hostObserver = TestResizeObserver.instances.find((observer) => observer.observed.has(host));
    expect(figureObserver).toBeDefined();
    expect(hostObserver).toBeDefined();

    const measure = vi.spyOn(editor.view, "requestMeasure");
    const beforeFloat = measure.mock.calls.length;
    figureObserver!.resize(figure!, 200, 250);
    await frame();
    expect(measure.mock.calls.length).toBeGreaterThan(beforeFloat);

    const beforeWidth = measure.mock.calls.length;
    figureObserver!.resize(figure!, 300, 250);
    await frame();
    expect(measure.mock.calls.length).toBeGreaterThan(beforeWidth);

    host.scrollLeft = 220;
    const beforeHost = measure.mock.calls.length;
    hostObserver!.resize(host, 360, 900);
    await frame();
    expect(host.scrollLeft).toBe(220);
    expect(measure.mock.calls.length).toBeGreaterThan(beforeHost);

    editor.destroy();
    expect(hostObserver!.observed.has(host)).toBe(false);
    expect(figureObserver!.observed.has(figure!)).toBe(false);
  });
});
