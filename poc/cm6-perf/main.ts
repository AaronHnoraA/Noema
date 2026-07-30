/**
 * Noema CM6 performance POC.
 *
 * Measures the real Noema editor path instead of a synthetic CM6 setup:
 * createEditor -> live preview -> math/table/fenced-code widgets -> app theme.
 */

import "../../src/styles/widgets.css";
import "../../src/styles/theme-typora.css";
import "../../src/styles/typography.css";

import { createEditor, type Editor } from "../../src/editor-api.ts";

type MetricSet = {
  firstRenderMs: number;
  keystrokeP50: number;
  scrollFPS: number;
};

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function measureKeystrokeLatency(editor: Editor, n = 20): Promise<number> {
  const view = editor.view;
  const latencies: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    view.dispatch({ changes: { from: 0, to: 0, insert: "x" }, sequential: true });
    await nextFrame();
    latencies.push(performance.now() - t0);
  }
  for (let i = 0; i < n; i++) {
    view.dispatch({ changes: { from: 0, to: 1 } });
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
  console.log(`[perf] keystroke p50: ${p50.toFixed(1)} ms (n=${n})`);
  return p50;
}

async function measureScrollFPS(editor: Editor, durationMs = 2000): Promise<number> {
  const scroller = editor.view.scrollDOM;
  let frames = 0;
  const start = performance.now();
  const end = start + durationMs;
  const step = 40;

  return new Promise((resolve) => {
    let pos = 0;
    function tick() {
      if (performance.now() >= end) {
        const fps = (frames / durationMs) * 1000;
        console.log(`[perf] scroll fps: ${fps.toFixed(1)}`);
        resolve(fps);
        return;
      }
      scroller.scrollTop = pos;
      pos = pos < scroller.scrollHeight ? pos + step : 0;
      frames++;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

async function measureAaronnoteEditor(content: string): Promise<MetricSet> {
  if (editor) {
    editor.destroy();
    editor = null;
  }
  container.innerHTML = "";

  const t0 = performance.now();
  editor = createEditor(container, {
    kernel: "cm6",
    initialContent: content,
  });
  await nextFrame();
  const firstRenderMs = performance.now() - t0;
  console.log(`[perf] firstRender: ${firstRenderMs.toFixed(1)} ms`);

  return {
    firstRenderMs,
    keystrokeP50: await measureKeystrokeLatency(editor),
    scrollFPS: await measureScrollFPS(editor),
  };
}

function renderMetrics(metrics: MetricSet): void {
  metricsEl.textContent =
    `firstRender: ${metrics.firstRenderMs.toFixed(0)} ms  |  ` +
    `keystroke p50: ${metrics.keystrokeP50.toFixed(1)} ms  |  ` +
    `scroll fps: ${metrics.scrollFPS.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Editor setup
// ---------------------------------------------------------------------------

const container = document.getElementById("editor-container")!;
const metricsEl = document.getElementById("metrics")!;

let editor: Editor | null = null;

document.getElementById("btn-load")!.addEventListener("click", async () => {
  metricsEl.textContent = "Loading...";
  const resp = await fetch("../../roam/project/UNSW/ISO(202603)/meeting.md");
  const content = await resp.text();
  renderMetrics(await measureAaronnoteEditor(content));
});
