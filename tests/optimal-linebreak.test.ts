import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import {
  optimalLinebreakAudit,
  resetOptimalLinebreakAudit,
} from "../src/cm6/extensions/visual/optimal-linebreak.ts";
import { refreshViewportDecorationsNow } from "../src/cm6/viewport-refresh.ts";

function rect(width: number, height = 24): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  };
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function installLayoutMocks(
  measureText: (text: string) => { width: number } = (text) => ({ width: [...text].length * 10 }),
): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "16px serif",
    fontKerning: "normal",
    measureText,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function mockRect(this: HTMLElement) {
    return rect(this.classList.contains("cm-line") ? 150 : 800);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("optimal Visual-mode line breaking", () => {
  test("adds zero-source line breaks without changing Markdown", async () => {
    installLayoutMocks();
    const source = "中文排版需要在整个段落中选择更好的断点，同时保持English words readable and stable。";
    const host = document.createElement("div");
    host.style.font = "16px serif";
    document.body.append(host);
    const editor = createEditor(host, { initialContent: source });

    await settleLayout();
    expect(host.querySelector(".cm-kp-paragraph")).not.toBeNull();
    expect(host.querySelectorAll(".cm-kp-break").length).toBeGreaterThan(0);
    expect(editor.getMarkdown()).toBe(source);

    editor.destroy();
  });

  test("does not run paragraph layout synchronously inside an inline typing transaction", async () => {
    installLayoutMocks();
    const host = document.createElement("div");
    host.style.font = "16px serif";
    document.body.append(host);
    const editor = createEditor(host, {
      initialContent: "这是一个用于验证输入热路径的中文English混合长段落，需要足够长以产生多个断点。",
    });
    await settleLayout();
    resetOptimalLinebreakAudit();

    editor.view.dispatch({
      changes: { from: 4, insert: "新" },
      userEvent: "input.type",
    });

    expect(optimalLinebreakAudit().paragraphLayouts).toBe(0);
    expect(editor.getMarkdown()).toContain("新");
    editor.destroy();
  });

  test("reuses the unchanged DP frontier when the typing burst settles", async () => {
    installLayoutMocks();
    const source = "中文English混合排版需要稳定增量维护。".repeat(35);
    const host = document.createElement("div");
    host.style.font = "16px serif";
    document.body.append(host);
    const editor = createEditor(host, { initialContent: source });
    await settleLayout();
    resetOptimalLinebreakAudit();

    const position = source.length - 3;
    editor.view.dispatch({
      changes: { from: position, insert: "新" },
      userEvent: "input.type",
    });
    expect(optimalLinebreakAudit().paragraphLayouts).toBe(0);

    await new Promise<void>((resolve) => window.setTimeout(resolve, 140));
    await settleLayout();
    const after = optimalLinebreakAudit();
    expect(after.paragraphLayouts).toBe(1);
    expect(after.reusedBreakpoints).toBeGreaterThan(100);
    expect(editor.getMarkdown()).toBe(`${source.slice(0, position)}新${source.slice(position)}`);
    editor.destroy();
  });

  test("merges Markdown soft newlines visually but preserves hard breaks and source offsets", async () => {
    installLayoutMocks();
    const source = "第一行中文English mixed prose\n第二行继续参与同一个段落  \n第三行必须从硬换行后开始";
    const host = document.createElement("div");
    host.style.font = "16px serif";
    document.body.append(host);
    const editor = createEditor(host, { initialContent: source });
    await settleLayout();

    expect(host.querySelector(".cm-kp-spacer-soft-newline")).not.toBeNull();
    expect(editor.getMarkdown()).toBe(source);
    const hardBreak = source.lastIndexOf("\n") + 1;
    editor.setSelection(hardBreak);
    expect(editor.getSelection()).toEqual({ from: hardBreak, to: hardBreak });
    editor.destroy();
  });

  test("keeps styled Markdown on the native fallback path", async () => {
    installLayoutMocks();
    const host = document.createElement("div");
    host.style.font = "16px serif";
    document.body.append(host);
    const editor = createEditor(host, {
      initialContent: "这里包含 **强调文字** and a [link](https://example.test)，暂时不得改变编辑映射。",
    });
    await settleLayout();

    expect(host.querySelector(".cm-kp-paragraph")).toBeNull();
    expect(editor.getMarkdown()).toContain("**强调文字**");
    editor.destroy();
  });

  test("bounds one-time work and falls back for pathological paragraphs", async () => {
    installLayoutMocks();
    const host = document.createElement("div");
    host.style.font = "16px serif";
    document.body.append(host);
    resetOptimalLinebreakAudit();
    const editor = createEditor(host, { initialContent: "中文".repeat(2_000) });
    await settleLayout();

    const bounded = optimalLinebreakAudit();
    expect(bounded.paragraphLayouts).toBe(1);
    expect(bounded.evaluatedEdges).toBeLessThan(100_000);
    editor.destroy();

    host.replaceChildren();
    resetOptimalLinebreakAudit();
    const fallback = createEditor(host, { initialContent: "中文".repeat(2_100) });
    await settleLayout();
    expect(optimalLinebreakAudit().fallbacks).toBeGreaterThan(0);
    expect(optimalLinebreakAudit().evaluatedEdges).toBe(0);
    expect(host.querySelector(".cm-kp-paragraph")).toBeNull();
    fallback.destroy();
  });

  test("time-slices multiple uncached paragraphs across measure passes", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    installLayoutMocks((text) => {
      clock += 7;
      return { width: [...text].length * 10 };
    });
    const source = [
      "第一段中文English混合排版需要选择全段最优断点。".repeat(6),
      "第二段中文English混合排版也需要保持编辑响应。".repeat(6),
      "第三段中文English混合排版用于验证分帧提交。".repeat(6),
    ].join("\n\n");
    const host = document.createElement("div");
    document.body.append(host);
    resetOptimalLinebreakAudit();
    const editor = createEditor(host, { initialContent: source });

    await settleLayout();
    await settleLayout();
    const measured = optimalLinebreakAudit();
    expect(measured.deferredPasses).toBeGreaterThan(0);
    expect(measured.paragraphLayouts).toBeGreaterThan(1);
    expect(editor.getMarkdown()).toBe(source);
    editor.destroy();
  });

  test("reuses the combined DecorationSet on an all-cache-hit refresh", async () => {
    installLayoutMocks();
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, {
      initialContent: "缓存命中的中文English段落不应重新排序全部装饰范围。".repeat(8),
    });
    await settleLayout();
    resetOptimalLinebreakAudit();

    refreshViewportDecorationsNow(editor.view);
    await settleLayout();
    const refreshed = optimalLinebreakAudit();
    expect(refreshed.cacheHits).toBeGreaterThan(0);
    expect(refreshed.decorationSetBuilds).toBe(0);
    editor.destroy();
  });
});
