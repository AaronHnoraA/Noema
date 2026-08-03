import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import type { Editor } from "../src/editor-api.ts";
import { createZoomController } from "../aaronnote/features/zoom/controller.ts";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--aaronnote-layout-zoom");
  document.documentElement.style.removeProperty("--aaronnote-visual-zoom");
});

function setup() {
  const host = document.createElement("div");
  const wrap = document.createElement("div");
  wrap.className = "typora-web-wrap";
  host.append(wrap);
  const toolsPanel = document.createElement("div");
  toolsPanel.innerHTML = `
    <span data-layout-zoom-value></span>
    <button data-layout-zoom-action="out"></button>
    <button data-layout-zoom-action="in"></button>
  `;
  document.body.append(host, toolsPanel);
  const requestMeasure = vi.fn();
  const statuses: string[] = [];
  const controller = createZoomController({
    editor: { view: { requestMeasure } } as unknown as Editor,
    host,
    toolsPanel,
    editorSurfaceVisible: () => true,
    primaryModifier: (event) => event.metaKey,
    scheduleAssistUpdate: vi.fn(),
    setStatus: (message) => statuses.push(message),
  });
  return { controller, requestMeasure, statuses, toolsPanel };
}

describe("zoom feature controller", () => {
  test("preserves layout zoom steps, status, measure and tool state", () => {
    const { controller, requestMeasure, statuses, toolsPanel } = setup();
    expect(controller.stepLayoutZoom(1, { announce: true })).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--aaronnote-layout-zoom")).toBe("1.080");
    expect(controller.layoutZoomPercent()).toBe("108%");
    expect(statuses).toEqual(["Layout zoom 108%"]);
    expect(requestMeasure).toHaveBeenCalledOnce();
    expect(toolsPanel.querySelector("[data-layout-zoom-value]")?.textContent).toBe("108%");
    controller.destroy();
  });

  test("owns and removes visual wheel listeners", () => {
    const { controller } = setup();
    const wheel = (): WheelEvent => {
      const event = new Event("wheel", { cancelable: true }) as WheelEvent;
      Object.defineProperties(event, {
        ctrlKey: { value: true },
        metaKey: { value: false },
        deltaY: { value: -100 },
        deltaMode: { value: 0 },
        clientX: { value: 20 },
        clientY: { value: 20 },
      });
      return event;
    };
    document.dispatchEvent(wheel());
    const zoom = document.documentElement.style.getPropertyValue("--aaronnote-visual-zoom");
    expect(Number(zoom)).toBeGreaterThan(1);
    controller.destroy();
    document.documentElement.style.removeProperty("--aaronnote-visual-zoom");
    document.dispatchEvent(wheel());
    expect(document.documentElement.style.getPropertyValue("--aaronnote-visual-zoom")).toBe("");
  });

  test("yields wheel and native pinch gestures to interactive diagrams", () => {
    const { controller } = setup();
    const diagram = document.createElement("div");
    diagram.className = "cm-diagram-interactive";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    diagram.append(svg);
    document.body.append(diagram);
    const diagramWheel = vi.fn((event: Event) => event.preventDefault());
    const diagramGesture = vi.fn((event: Event) => event.preventDefault());
    diagram.addEventListener("wheel", diagramWheel);
    diagram.addEventListener("gesturestart", diagramGesture);
    diagram.addEventListener("gesturechange", diagramGesture);

    const wheel = new Event("wheel", { bubbles: true, cancelable: true }) as WheelEvent;
    Object.defineProperties(wheel, {
      ctrlKey: { value: true },
      metaKey: { value: false },
      deltaY: { value: -100 },
      deltaMode: { value: 0 },
      clientX: { value: 20 },
      clientY: { value: 20 },
    });
    svg.dispatchEvent(wheel);

    const gestureStart = new Event("gesturestart", { bubbles: true, cancelable: true });
    const gestureChange = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.defineProperty(gestureChange, "scale", { value: 1.4 });
    svg.dispatchEvent(gestureStart);
    svg.dispatchEvent(gestureChange);

    expect(diagramWheel).toHaveBeenCalledOnce();
    expect(diagramGesture).toHaveBeenCalledTimes(2);
    expect(document.documentElement.style.getPropertyValue("--aaronnote-visual-zoom")).toBe("");
    controller.destroy();
  });
});
