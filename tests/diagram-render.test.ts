import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  disposeDiagramInteraction,
  normalizeMermaidSource,
  presentDiagramFigure,
  sanitizeDiagramSvg,
  staticAaronMindmap,
} from "../src/diagram-render.ts";
import { setKatexMacros } from "../src/katex-macros.ts";

/**
 * Lay the diagram out as a figure, then open its viewer the way a reader does.
 * Pan and zoom live on the viewer's stage, never on the figure in the document.
 */
function expandDiagram(figure: HTMLElement): { stage: HTMLElement; svg: SVGSVGElement } {
  presentDiagramFigure(figure);
  figure.querySelector<HTMLButtonElement>(".cm-diagram-expand")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const stage = document.querySelector<HTMLElement>(".cm-diagram-lightbox .cm-diagram-stage")!;
  return { stage, svg: stage.querySelector<SVGSVGElement>("svg")! };
}

function closeDiagram(): void {
  document.querySelector<HTMLButtonElement>(".cm-diagram-control-close")?.click();
}

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

    presentDiagramFigure(div);

    expect(div.querySelector("foreignObject .katex")?.textContent).toBe("x");
    // Mermaid's legacy math output includes a KaTeX HTML layer, while browsers
    // that retain MathML also keep its accessibility layer.
    expect(div.querySelector("foreignObject")?.textContent).toContain("x");
    expect(div.querySelector("script")).toBeNull();
    expect(div.querySelector("img")?.hasAttribute("onerror") ?? false).toBe(false);
  });

  test("an inline diagram is a plain figure: no toolbar, no pan, no captured clicks", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g id="node-a"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    presentDiagramFigure(div);

    expect(div.classList.contains("cm-diagram-figure")).toBe(true);
    expect(div.classList.contains("cm-diagram-interactive")).toBe(false);
    expect(div.querySelector(".cm-diagram-toolbar")).toBeNull();
    expect(svg.style.transform).toBe("");
    expect(svg.style.height).toBe("auto");

    // A click on the diagram must reach the editor so the fence's source opens.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    svg.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);

    const down = pointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 20 });
    svg.dispatchEvent(down);
    div.dispatchEvent(pointerEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 50 }));
    expect(down.defaultPrevented).toBe(false);
    expect(svg.style.transform).toBe("");
  });

  test("an inline diagram does not swallow wheel scrolling", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    const svg = div.querySelector<SVGSVGElement>("svg")!;

    presentDiagramFigure(div);
    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 12, deltaY: 24, clientX: 8, clientY: 8 });
    svg.dispatchEvent(plain);
    const pinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, clientX: 8, clientY: 8 });
    Object.defineProperty(pinch, "ctrlKey", { value: true });
    svg.dispatchEvent(pinch);

    expect(plain.defaultPrevented).toBe(false);
    expect(pinch.defaultPrevented).toBe(false);
    expect(svg.style.transform).toBe("");
  });

  test("the ⤢ button opens a viewer that owns a clone, and closing disposes it", () => {
    const host = document.createElement("section");
    const div = document.createElement("div");
    const after = document.createElement("span");
    host.append(div, after);
    document.body.append(host);
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><text>Root</text></g></svg>';
    const figureSvg = div.querySelector<SVGSVGElement>("svg")!;

    const { stage, svg } = expandDiagram(div);
    const overlay = stage.parentElement!;

    expect(overlay.classList.contains("cm-diagram-lightbox")).toBe(true);
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.dataset.aaronnoteVim).toBe("native");
    expect(overlay.dataset.noemaGestureScope).toBe("diagram");
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(true);
    expect(stage.querySelector(".cm-diagram-toolbar")).toBeTruthy();
    expect(stage.querySelectorAll(".cm-diagram-control")).toHaveLength(5);
    // The figure stays exactly where it was, untouched.
    expect(div.parentElement).toBe(host);
    expect(host.children[0]).toBe(div);
    expect(host.children[1]).toBe(after);
    expect(svg).not.toBe(figureSvg);

    stage.querySelector<HTMLButtonElement>(".cm-diagram-control-zoom-in")!.click();
    expect(svg.style.transform).toContain("scale(1.18)");
    expect(figureSvg.style.transform).toBe("");

    stage.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    expect(document.querySelector(".cm-diagram-lightbox")).toBeNull();
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(false);
    host.remove();
  });

  test("the viewer toolbar zooms and resets its clone", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g id="node-a"><text>Root</text></g></svg>';
    document.body.append(div);

    const { stage, svg } = expandDiagram(div);
    stage.querySelector<HTMLButtonElement>(".cm-diagram-control-zoom-in")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(svg.style.transform).toContain("scale(1.18)");

    stage.querySelector<HTMLButtonElement>(".cm-diagram-control-reset")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(svg.style.transform).toContain("translate(0px, 0px) scale(1)");

    closeDiagram();
    div.remove();
  });

  test("a node in the viewer can be selected", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    document.body.append(div);

    const { stage } = expandDiagram(div);
    stage.querySelector("text")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(stage.classList.contains("cm-diagram-interactive")).toBe(true);
    expect(stage.querySelector("#node-a")?.classList.contains("cm-diagram-selected")).toBe(true);

    closeDiagram();
    div.remove();
  });

  test("the viewer keeps trackpad pan, native pinch, and touchscreen pinch local to the diagram", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><text>Root</text></g></svg>';
    document.body.append(div);
    const { stage, svg } = expandDiagram(div);

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
    expect(Number(stage.dataset.diagramScale)).toBeCloseTo(1.5);

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
    stage.dispatchEvent(pointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 120,
      clientY: 50,
      pointerId: 12,
      pointerType: "touch",
    }));
    expect(Number(stage.dataset.diagramScale)).toBeGreaterThan(1.5);

    closeDiagram();
    div.remove();
  });

  test("touch drags the viewer directly, with no long press to wait out", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    document.body.append(div);
    const { stage, svg } = expandDiagram(div);

    svg.dispatchEvent(pointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 20,
      pointerId: 8,
      pointerType: "touch",
    }));
    stage.dispatchEvent(pointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 22,
      clientY: 29,
      pointerId: 8,
      pointerType: "touch",
    }));

    expect(stage.classList.contains("is-panning")).toBe(true);
    expect(svg.style.transform).toContain("translate(12px, 9px)");

    closeDiagram();
    div.remove();
  });

  test("an Aaron mind map is a figure too, and its viewer pans like any other", () => {
    const div = document.createElement("div");
    div.className = "cm-aaron-mindmap";
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g class="mindmap-node" id="root"><text>Root</text></g></svg>';
    document.body.append(div);
    const figureSvg = div.querySelector<SVGSVGElement>("svg")!;

    presentDiagramFigure(div);
    expect(div.getAttribute("style")).toBeNull();
    expect(figureSvg.style.height).toBe("auto");

    const { stage, svg } = expandDiagram(div);
    expect(stage.classList.contains("cm-aaron-mindmap")).toBe(true);
    svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 12, clientY: 9 }));

    expect(stage.querySelector(".cm-diagram-toolbar")).toBeTruthy();
    expect(svg.style.transform).toContain("translate(12px, 9px)");

    closeDiagram();
    div.remove();
  });

  test("drags the viewer by translating the svg", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g id="node-a"><text>Root</text></g></svg>';
    document.body.append(div);
    const { stage, svg } = expandDiagram(div);

    svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 20 }));
    stage.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 28, clientY: 15 }));
    stage.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 28, clientY: 15 }));

    expect(svg.style.transform).toContain("translate(18px, -5px)");

    closeDiagram();
    div.remove();
  });

  test("disposing a diagram closes a viewer it still owns", () => {
    const div = document.createElement("div");
    div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"><g><text>Root</text></g></svg>';
    document.body.append(div);
    expandDiagram(div);
    expect(document.querySelector(".cm-diagram-lightbox")).toBeTruthy();

    disposeDiagramInteraction(div);

    expect(document.querySelector(".cm-diagram-lightbox")).toBeNull();
    expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(false);
    div.remove();
  });

  test("sanitizes SVG diagram links and dispatches safe links from the figure", () => {
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

    presentDiagramFigure(div);
    div.querySelector("#ok text")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(div.querySelector("#ok")?.getAttribute("target")).toBe("_blank");
    expect(div.querySelector("#bad")?.hasAttribute("href")).toBe(false);
    expect(opened).toBe("https://example.com");
  });
});
