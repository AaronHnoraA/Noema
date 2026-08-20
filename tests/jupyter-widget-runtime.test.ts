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

  test("mounts captured comm state live before background kernel reconciliation", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    // Captured comms are rebound to the live KernelConnection first.  A
    // control-comm restore is only background reconciliation, so a busy Cell
    // cannot block the widget UI or queue repeated restore requests.
    const replayIdx = source.indexOf("await this.restoreFromMessages(messages)");
    const restoreIdx = source.indexOf("void this.restoreFromKernel()");
    expect(replayIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(replayIdx);
    expect(source).toContain("private restoreEnabled = false");
    expect(source).toContain("if (!this.restoreEnabled) return");
    // Inline output and popout can mount the same widget concurrently; replay
    // must serialize and tolerate comms created by an earlier replay/restore.
    expect(source).toContain("private replayQueue: Promise<void>");
    expect(source).toContain("createOrReuseComm(");
    expect(source).toContain("Comm is already created");
    // Output widgets executed headless restore with empty outputs; we seed them.
    expect(source).toContain("async seedOutputWidgets(");
    expect(source).toContain('outputModel.set("outputs", outputs)');
    expect(source).toContain("await this.seedOutputWidgets(widgetOutputs)");
    expect(source).not.toContain("outputModel.save_changes");
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

  test("widget-runtime setup waits only for the socket connection and does not probe a busy kernel", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    expect(source).toContain("async function waitForRuntimeConnection(");
    expect(source).toContain("kernel.connectionStatusChanged.connect(");
    expect(source).toContain('kernel.connectionStatus === "connected"');
    expect(source).toContain("await waitForRuntimeConnection(kernel);");
    expect(source).not.toContain("kernel.iopubMessage.connect(");
    expect(source).not.toContain("kernel.requestKernelInfo()");
    expect(source).not.toContain("await kernel.info");
  });

  test("keeps widget comm callbacks off JEP-91 subshells", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    // Sage advertises subshell support, but plotting/typesetting from an
    // @interact observer in that subshell can deadlock the whole kernel.
    expect(source).toContain("CommsOverSubshells");
    expect(source).toContain("commsOverSubshells: CommsOverSubshells.Disabled");
  });

  test("widget-runtime KernelConnections are disposed on pagehide", () => {
    const source = readFileSync(join(process.cwd(), "src/jupyter-widget-runtime.ts"), "utf8");
    expect(source).toContain("export function disposeJupyterWidgetRuntimes()");
    expect(source).toContain('window.addEventListener("pagehide", () => disposeJupyterWidgetRuntimes());');
  });
});
