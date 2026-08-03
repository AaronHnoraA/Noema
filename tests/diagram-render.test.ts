import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { enableDiagramInteraction, normalizeMermaidSource, staticAaronMindmap } from "../src/diagram-render.ts";

function pointerEvent(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string }): MouseEvent {
  const event = new MouseEvent(type, init);
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  return event;
}

describe("diagram render helpers", () => {
  test("keeps full Mermaid source unchanged for marmind fences", () => {
    expect(normalizeMermaidSource("graph LR\nA --- B", "marmind"))
      .toBe("graph LR\nA --- B");
  });

  test("adds mindmap header for plain marmind trees", () => {
    expect(normalizeMermaidSource("Root\n  Branch\n    Detail", "marmind"))
      .toBe("mindmap\n  Root\n    Branch\n      Detail");
  });

  test("keeps empty marmind fences empty", () => {
    expect(normalizeMermaidSource("   \n", "marmind")).toBe("");
  });

  test("accepts Markdown-ish list trees in marmind fences", () => {
    expect(normalizeMermaidSource("- Root\n  - Branch\n    - Detail", "marmind"))
      .toBe("mindmap\n  Root\n    Branch\n      Detail");
  });

  test("supports Noema inline LaTeX in plain marmind nodes", () => {
    expect(normalizeMermaidSource("Math\n  Energy \\(E=mc^2\\)\n  Half \\(\\frac{1}{2}\\)", "marmind"))
      .toBe([
        "mindmap",
        "  Math",
        '    noema_math_1["`Energy $$E=mc^2$$`"]',
        '    noema_math_2["`Half $$\\frac{1}{2}$$`"]',
      ].join("\n"));
  });

  test("keeps ordered list markers in marmind labels", () => {
    expect(normalizeMermaidSource("1. Root\n  2) Branch", "markmind"))
      .toBe("mindmap\n  1. Root\n    2) Branch");
  });

  test("keeps Aaron mindmap fences static while Mermaid mindmaps stay generic", () => {
    expect(staticAaronMindmap("marmind")).toBe(true);
    expect(staticAaronMindmap("markmind")).toBe(true);
    expect(staticAaronMindmap("mindmap")).toBe(false);
    expect(staticAaronMindmap("mermaid")).toBe(false);
  });

  test("enables diagram interaction with toolbar chrome and lets nodes be selected", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';

    enableDiagramInteraction(div);
    div.querySelector("text")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(div.classList.contains("cm-diagram-interactive")).toBe(true);
    expect(div.querySelector(".cm-diagram-toolbar")).toBeTruthy();
    expect(div.querySelectorAll(".cm-diagram-control")).toHaveLength(5);
    expect(div.querySelector("#node-a")?.classList.contains("cm-diagram-selected")).toBe(true);
  });

  test("diagram toolbar zooms and resets the svg", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g id="node-a"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    div.querySelector<HTMLButtonElement>(".cm-diagram-control-zoom-in")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(svg.style.transform).toContain("scale(1.18)");

    div.querySelector<HTMLButtonElement>(".cm-diagram-control-reset")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(svg.style.transform).toContain("translate(0px, 0px) scale(1)");
  });

  test("wheel and trackpad scrolling pan the diagram", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 12, deltaY: 24, clientX: 8, clientY: 8 });
    svg.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(svg.style.transform).toContain("translate(-12px, -24px) scale(1)");
  });

  test("ctrl-wheel trackpad pinch zooms around the gesture point", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -40,
      clientX: 8,
      clientY: 8,
    });
    Object.defineProperty(event, "ctrlKey", { value: true });
    svg.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(Number(div.dataset.diagramScale)).toBeGreaterThan(1);
    expect(svg.style.transform).not.toContain("scale(1)");
  });

  test("pseudo-fullscreen expands inside the web view and Escape restores the view", () => {
    const div = document.createElement("div");
    document.body.append(div);
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    div.querySelector<HTMLButtonElement>(".cm-diagram-control-zoom-in")!.click();
    const before = svg.style.transform;
    div.querySelector<HTMLButtonElement>(".cm-diagram-control-fullscreen")!.click();

    expect(div.classList.contains("is-diagram-fullscreen")).toBe(true);
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(true);
    expect(div.querySelector<HTMLButtonElement>(".cm-diagram-control-fullscreen")!.textContent).toBe("Exit");

    div.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    expect(div.classList.contains("is-diagram-fullscreen")).toBe(false);
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(false);
    expect(svg.style.transform).toBe(before);
    div.remove();
  });

  test("touch input starts dragging after a long press", () => {
    vi.useFakeTimers();
    try {
      const div = document.createElement("div");
      div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
      const svg = div.querySelector<SVGSVGElement>("svg")!;

      enableDiagramInteraction(div);
      svg.dispatchEvent(pointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 20,
        pointerId: 8,
        pointerType: "touch",
      }));
      expect(div.classList.contains("is-long-pressing")).toBe(true);

      vi.advanceTimersByTime(260);
      div.dispatchEvent(pointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 22,
        clientY: 29,
        pointerId: 8,
        pointerType: "touch",
      }));

      expect(div.classList.contains("is-panning")).toBe(true);
      expect(svg.style.transform).toContain("translate(12px, 9px)");
    } finally {
      vi.useRealTimers();
    }
  });

  test("static Aaron mindmap diagrams use the same interaction controller", () => {
    const div = document.createElement("div");
    div.className = "cm-aaron-mindmap";
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g class="mindmap-node" id="root"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }));
    div.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 12, clientY: 9 }));

    expect(div.querySelector(".cm-diagram-toolbar")).toBeTruthy();
    expect(svg.style.transform).toContain("translate(12px, 9px)");
  });

  test("drags diagrams by translating the svg", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 20 }));
    div.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 28, clientY: 15 }));
    div.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 28, clientY: 15 }));

    expect(svg.style.transform).toContain("translate(18px, -5px)");
  });

  test("sanitizes SVG diagram links and dispatches safe links", () => {
    const div = document.createElement("div");
    div.innerHTML = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<a id="ok" href="https://example.com"><text>ok</text></a>',
      '<a id="bad" href="javascript:alert(1)"><text>bad</text></a>',
      "</svg>",
    ].join("");
    let opened = "";
    div.addEventListener("aaronnote:open-url", (event) => {
      event.preventDefault();
      opened = (event as CustomEvent<{ href: string }>).detail.href;
    });

    enableDiagramInteraction(div);
    div.querySelector("#ok text")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(div.querySelector("#ok")?.getAttribute("target")).toBe("_blank");
    expect(div.querySelector("#bad")?.hasAttribute("href")).toBe(false);
    expect(opened).toBe("https://example.com");
  });
});
