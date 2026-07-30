import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Jupyter widget runtime", () => {
  test("uses the JupyterLab widget manager output implementation for live interact output", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");

    expect(source).toContain('import * as widgetOutput from "@jupyter-widgets/jupyterlab-manager/lib/output";');
    expect(source).toContain('import { KernelWidgetManager, WIDGET_VIEW_MIMETYPE } from "@jupyter-widgets/jupyterlab-manager/lib/manager";');
    expect(source).toContain('import { WidgetRenderer } from "@jupyter-widgets/jupyterlab-manager/lib/renderer";');
    expect(source).toContain("extends KernelWidgetManager");
    expect(source).toContain("restoreWidgets()");
    expect(source).toContain("/jupyter/widget-runtimes/");
    expect(source).toContain("runtimeWebSocketCtor");
    // Shares the cell-output render stack (KaTeX LaTeX + HTML iframe handling)
    // instead of a bespoke RenderMimeRegistry.
    expect(source).toContain("createBaseRenderMime()");
    expect(source).toContain('"jupyter-js-widgets": "@jupyter-widgets/base"');
    expect(source).toContain('document.body.dataset.baseUrl ??= new URL("/jupyter/", window.location.origin).toString();');
    expect(source).not.toContain('import * as widgetOutput from "@jupyter-widgets/html-manager/lib/output";');
    expect(source).not.toContain('import * as widgetOutput from "@jupyter-widgets/output";');
    expect(source).not.toContain('@jupyterlab/outputarea/style/index.js');
  });

  test("mounts kernel-state-first and seeds Output widgets captured server-side", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    // restoreFromKernel (live control comm) is attempted before the captured
    // message replay fallback, so interactive widgets resolve their models and
    // slider round-trips update outputs in place.
    const restoreIdx = source.indexOf("await this.restoreFromKernel()");
    const replayIdx = source.indexOf("await this.restoreFromMessages(messages)");
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(replayIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(replayIdx);
    // Inline output and popout can mount the same widget concurrently; replay
    // must serialize and tolerate comms created by an earlier replay/restore.
    expect(source).toContain("private replayQueue: Promise<void>");
    expect(source).toContain("createOrReuseComm(");
    expect(source).toContain("Comm is already created");
    // Output widgets executed headless restore with empty outputs; we seed them.
    expect(source).toContain("async seedOutputWidgets(");
    expect(source).toContain('outputModel.set("outputs", outputs)');
    expect(source).toContain("await this.seedOutputWidgets(widgetOutputs)");
  });

  test("first-run fix: a cold/empty restore is not permanently memoized, and mount() retries once", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    // restoreFromKernel used to cache restoreWidgets()'s promise forever, so a
    // 0-model result from a not-yet-warm connection wedged every later mount
    // onto the same empty promise — the "works on the second run" bug.
    expect(source).toContain("private async attemptRestoreFromKernel()");
    expect(source).toContain("if (this.loadedModelCount() === 0) this.restorePromise = null;");
    // mount() retries the restore once in-place before falling back to a
    // static message replay, so a single Run is enough once the connection
    // has actually warmed up.
    const firstRestoreIdx = source.indexOf("await this.restoreFromKernel();");
    const retryCommentIdx = source.indexOf("classic \"works on the second run\" symptom");
    const secondRestoreIdx = source.lastIndexOf("await this.restoreFromKernel();", source.indexOf("modelsAfterRestore"));
    expect(retryCommentIdx).toBeGreaterThan(firstRestoreIdx);
    expect(secondRestoreIdx).toBeGreaterThan(retryCommentIdx);
  });

  test("each widget-runtime connection is warmed up (connected + first iopub seen) before use", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    // Each browser widget connection is a fresh ZMQ identity/subscription on
    // the server bridge, so it has its own slow-joiner window independent of
    // the server's own persistent execution connection.
    expect(source).toContain("async function warmupRuntimeConnection(");
    expect(source).toContain('kernel.connectionStatus !== "connected"');
    expect(source).toContain("kernel.iopubMessage.connect(");
    expect(source).toContain("kernel.requestKernelInfo()");
    expect(source).toContain("await warmupRuntimeConnection(kernel);");
  });

  test("widget-runtime KernelConnections are disposed on pagehide", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    expect(source).toContain("export function disposeJupyterWidgetRuntimes()");
    expect(source).toContain('window.addEventListener("pagehide", () => disposeJupyterWidgetRuntimes());');
  });
});
