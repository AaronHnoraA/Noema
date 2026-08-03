import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  enableDiagramInteraction,
  normalizeMermaidSource,
  sanitizeDiagramSvg,
  staticAaronMindmap,
} from "../src/diagram-render.ts";
import { setKatexMacros } from "../src/katex-macros.ts";

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

  test("carries the active Noema KaTeX macros into marmind formulas", () => {
    setKatexMacros({ "\\R": "\\mathbb{R}" });
    try {
      expect(normalizeMermaidSource("Space \\(x\\in\\R^n\\)", "marmind"))
        .toContain('$$\\gdef\\R{\\mathbb{R}}x\\in\\R^n$$');
    } finally {
      setKatexMacros({});
    }
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

  test("preserves sanitized HTML and MathML labels inside Mermaid foreignObject nodes", () => {
    const sanitized = sanitizeDiagramSvg([
      '<svg xmlns="http://www.w3.org/2000/svg">',
      "<foreignObject>",
      '<div xmlns="http://www.w3.org/1999/xhtml"><span class="katex">x</span><math><mi>x</mi></math>',
      '<script>alert(1)</script><img src="x" onerror="alert(2)"></div>',
      "</foreignObject>",
      "</svg>",
    ].join(""));
    const div = document.createElement("div");
    div.innerHTML = sanitized;

    enableDiagramInteraction(div);

    expect(div.querySelector("foreignObject .katex")?.textContent).toBe("x");
    // Mermaid's legacy math output includes a KaTeX HTML layer, while browsers
    // that retain MathML also keep its accessibility layer.
    expect(div.querySelector("foreignObject")?.textContent).toContain("x");
    expect(div.querySelector("script")).toBeNull();
    expect(div.querySelector("img")?.hasAttribute("onerror") ?? false).toBe(false);
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
    const host = document.createElement("section");
    const div = document.createElement("div");
    const after = document.createElement("span");
    host.append(div, after);
    document.body.append(host);
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    enableDiagramInteraction(div);
    div.querySelector<HTMLButtonElement>(".cm-diagram-control-zoom-in")!.click();
    const before = svg.style.transform;
    div.querySelector<HTMLButtonElement>(".cm-diagram-control-fullscreen")!.click();

    expect(div.classList.contains("is-diagram-fullscreen")).toBe(true);
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(true);
    expect(div.parentElement?.classList.contains("cm-diagram-fullscreen-portal")).toBe(true);
    expect(div.parentElement?.parentElement).toBe(document.body);
    expect(div.parentElement?.dataset.aaronnoteVim).toBe("native");
    expect(div.parentElement?.dataset.noemaGestureScope).toBe("diagram");
    expect(host.querySelector(".cm-diagram-fullscreen-placeholder")).not.toBeNull();
    expect(div.querySelector<HTMLButtonElement>(".cm-diagram-control-fullscreen")!.textContent).toBe("Exit");

    div.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    expect(div.classList.contains("is-diagram-fullscreen")).toBe(false);
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(false);
    expect(div.parentElement).toBe(host);
    expect(host.children[0]).toBe(div);
    expect(host.children[1]).toBe(after);
    expect(document.querySelector(".cm-diagram-fullscreen-portal")).toBeNull();
    expect(host.querySelector(".cm-diagram-fullscreen-placeholder")).toBeNull();
    expect(div.tabIndex).toBe(0);
    expect(svg.style.transform).toBe(before);
    host.remove();
  });

  test("fullscreen keeps trackpad pan, native pinch, and touchscreen pinch local to the diagram", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><text>Root</text></g></svg>';
    document.body.append(div);
    const svg = div.querySelector<SVGSVGElement>("svg")!;
    enableDiagramInteraction(div);
    div.querySelector<HTMLButtonElement>(".cm-diagram-control-fullscreen")!.click();

    const pan = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 14,
      deltaY: 20,
      clientX: 50,
      clientY: 40,
    });
    svg.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    expect(svg.style.transform).toContain("translate(-14px, -20px)");

    const gestureStart = new Event("gesturestart", { bubbles: true, cancelable: true });
    const gestureChange = new Event("gesturechange", { bubbles: true, cancelable: true });
    Object.defineProperties(gestureChange, {
      scale: { value: 1.5 },
      clientX: { value: 60 },
      clientY: { value: 40 },
    });
    svg.dispatchEvent(gestureStart);
    svg.dispatchEvent(gestureChange);
    expect(Number(div.dataset.diagramScale)).toBeCloseTo(1.5);

    svg.dispatchEvent(pointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 30,
      clientY: 40,
      pointerId: 11,
      pointerType: "touch",
    }));
    svg.dispatchEvent(pointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 90,
      clientY: 40,
      pointerId: 12,
      pointerType: "touch",
    }));
    div.dispatchEvent(pointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 120,
      clientY: 50,
      pointerId: 12,
      pointerType: "touch",
    }));
    expect(Number(div.dataset.diagramScale)).toBeGreaterThan(1.5);

    div.dispatchEvent(pointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 120,
      clientY: 50,
      pointerId: 12,
      pointerType: "touch",
    }));
    div.dispatchEvent(pointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 30,
      clientY: 40,
      pointerId: 11,
      pointerType: "touch",
    }));
    div.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
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
