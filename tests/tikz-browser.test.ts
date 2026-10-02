import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  inlineTikzFigures,
  prepareTikzSvg,
  renderTikzBrowser,
  setTikzRendererForTests,
} from "../src/tikz-browser.ts";

const SVG = '<svg viewBox="0 0 40 20"><path stroke="black" d="M0 0L40 20"/></svg>';

describe("browser TikZ rendering", () => {
  test("keeps authored colours in the SVG and adds readable dark variants", () => {
    const host = document.createElement("div");
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">
      <text fill="#000099">label</text>
      <path data-source-id="node:1" stroke="black" fill="#d9d9ff" />
      <text data-source-id="node:1" fill="#000000">x</text>
      <text data-source-id="node:1" fill="#000099">blue x</text>
      <svg color="#000099"><path fill="currentColor" /></svg>
    </svg>`;
    const svg = host.querySelector("svg")!;
    prepareTikzSvg(svg);

    const label = svg.querySelector("text")!;
    const darkBlue = label.style.getPropertyValue("--note-tikz-dark-fill");
    expect(label.getAttribute("fill")).toBe("#000099");
    expect(label.hasAttribute("data-noema-tikz-dark-fill")).toBe(true);
    expect(darkBlue).toMatch(/^#[0-9a-f]{6}$/);
    const rgb = darkBlue.slice(1).match(/../g)!.map((part) => parseInt(part, 16));
    const linear = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (channels: number[]) =>
      0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
    expect((luminance(rgb) + 0.05) / (luminance([20, 26, 39]) + 0.05)).toBeGreaterThanOrEqual(5.45);
    expect(svg.querySelector("path")?.hasAttribute("data-noema-tikz-dark-fill")).toBe(false);
    expect(svg.querySelector("path")?.hasAttribute("data-noema-tikz-dark-stroke")).toBe(false);
    expect(svg.querySelector('text[data-source-id="node:1"]')?.hasAttribute("data-noema-tikz-on-light")).toBe(true);
    expect(svg.querySelectorAll('text[data-source-id="node:1"]')[1]?.hasAttribute("data-noema-tikz-dark-fill")).toBe(false);
    expect(svg.querySelector("svg")?.hasAttribute("data-noema-tikz-dark-color")).toBe(true);
  });

  test("hydrates a figure only when it first approaches the viewport", async () => {
    let onEntries: ((entries: IntersectionObserverEntry[]) => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) { onEntries = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const calls: string[] = [];
    setTikzRendererForTests(async (source) => { calls.push(source); return SVG; });
    const figure = document.createElement("noema-tikz");
    figure.dataset.source = "\\draw (0,0) -- (9,9);";
    try {
      document.body.append(figure);
      await Promise.resolve();
      expect(calls).toHaveLength(0);
      onEntries?.([{ target: figure, isIntersecting: true } as unknown as IntersectionObserverEntry]);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(calls).toHaveLength(1);
      expect(figure.querySelector("svg")).toBeTruthy();
    } finally {
      figure.remove();
      setTikzRendererForTests(null);
      vi.unstubAllGlobals();
    }
  });

  test("reuses the same source across openings and renders an edited source once", async () => {
    const calls: string[] = [];
    setTikzRendererForTests(async (source) => {
      calls.push(source);
      return SVG;
    });
    try {
      const source = "\\draw (0,0) -- (1,1);";
      const first = await renderTikzBrowser(source);
      const reopened = await renderTikzBrowser(source);
      const edited = await renderTikzBrowser("\\draw (0,0) -- (2,2);");
      expect(first.ok).toBe(true);
      expect(reopened).toBe(first);
      expect(edited.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(first.intrinsic).toEqual({ widthEm: 4, heightEm: 2 });
    } finally {
      setTikzRendererForTests(null);
    }
  });

  test("shows a completed render while its disk cache write is pending", async () => {
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: (_store: string, mode: string) => mode === "readonly"
        ? { objectStore: () => ({ get: () => {
          const request: { result?: unknown; onsuccess?: () => void } = {};
          queueMicrotask(() => request.onsuccess?.());
          return request;
        } }) }
        : { objectStore: () => ({
          put: () => {},
          count: () => {
            const request: { result?: number; onsuccess?: () => void } = {};
            queueMicrotask(() => { request.result = 0; request.onsuccess?.(); });
            return request;
          },
        }) }, // The write transaction deliberately never completes.
    };
    vi.stubGlobal("indexedDB", { open: () => {
      const request: { result?: typeof db; onsuccess?: () => void } = {};
      queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
      return request;
    } });
    vi.resetModules();
    const isolated = await import("../src/tikz-browser.ts");
    isolated.setTikzRendererForTests(async () => SVG);
    try {
      const result = await Promise.race([
        isolated.renderTikzBrowser("\\draw (0,0) -- (3,3);"),
        new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 100)),
      ]);
      expect(result).not.toBe("timed out");
      expect(result).toMatchObject({ ok: true, svg: SVG });
    } finally {
      isolated.setTikzRendererForTests(null);
      vi.unstubAllGlobals();
    }
  });

  test("freezes TikZ into standalone HTML without a local SVG reference", async () => {
    setTikzRendererForTests(async () => SVG);
    try {
      const html = await inlineTikzFigures('<!DOCTYPE html><html><body><noema-tikz data-source="\\draw (0,0) -- (1,1);"></noema-tikz></body></html>');
      expect(html).toContain('<svg');
      expect(html).toContain('class="aaronnote-tikz-image"');
      expect(html).not.toContain('data-source=');
      expect(html).not.toContain('tikz-*.svg');
    } finally {
      setTikzRendererForTests(null);
    }
  });

  test("standalone TikZ carries the dark colour variant without changing its authored fill", async () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 40 20"><text fill="#000099">label</text></svg>');
    try {
      const html = await inlineTikzFigures('<html><body><noema-tikz data-source="\\node {label};"></noema-tikz></body></html>');
      expect(html).toContain('fill="#000099"');
      expect(html).toContain("data-noema-tikz-dark-fill");
      expect(html).toContain("--note-tikz-dark-fill:");
    } finally {
      setTikzRendererForTests(null);
    }
  });
});
