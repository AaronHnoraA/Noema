import * as widgetBase from "@jupyter-widgets/base";
import * as widgetControls from "@jupyter-widgets/controls";
import * as widgetOutput from "@jupyter-widgets/jupyterlab-manager/lib/output";
import { KernelWidgetManager, WIDGET_VIEW_MIMETYPE } from "@jupyter-widgets/jupyterlab-manager/lib/manager";
import { WidgetRenderer } from "@jupyter-widgets/jupyterlab-manager/lib/renderer";
import type { RenderMimeRegistry } from "@jupyterlab/rendermime";
import { KernelConnection, ServerConnection, type Kernel } from "@jupyterlab/services";
import { MessageLoop } from "@lumino/messaging";
import * as LuminoWidgets from "@lumino/widgets";
import requireJsSource from "requirejs/require.js?raw";
import { evaluateAmdLoaderSource, validWidgetModuleName, validWidgetModuleVersion, widgetModuleCdnUrls } from "./jupyter-widget-loader.ts";
import { createBaseRenderMime, type WidgetOutputsMap } from "./jupyter-rendermime.ts";

import "@jupyter-widgets/base/css/index.css";
import "@jupyter-widgets/controls/css/labvariables.css";
import "@jupyter-widgets/controls/css/widgets.css";
import "@lumino/widgets/style/index.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
// rendermime/outputarea base CSS is imported by ./jupyter-rendermime.ts.

export type JupyterWidgetRuntime = {
  id: string;
  name: string;
  generation?: number;
};

export type JupyterWidgetKernelMessage = {
  channel?: string;
  header?: { msg_id?: string; msg_type?: string; [key: string]: unknown };
  parent_header?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  content?: {
    comm_id?: string;
    target_name?: string;
    data?: unknown;
    [key: string]: unknown;
  };
  buffers?: ArrayBuffer[];
};

type RequireJs = {
  (modules: string[], onLoad: (module: unknown) => void, onError: (error: unknown) => void): void;
  config(options: {
    baseUrl?: string;
    map?: Record<string, Record<string, string>>;
    paths?: Record<string, string>;
  }): RequireJs;
  defined(name: string): boolean;
  undef(name: string): void;
};

type WidgetViewLike = {
  el?: HTMLElement;
  luminoWidget?: LuminoWidgets.Widget;
  pWidget?: LuminoWidgets.Widget;
  once?: (name: string, callback: () => void) => unknown;
  remove(): unknown;
};

type WidgetModelLike = {
  _handle_comm_msg?: (msg: JupyterWidgetKernelMessage) => unknown;
  _handle_comm_closed?: (msg: JupyterWidgetKernelMessage) => unknown;
  state_change?: Promise<unknown>;
};

declare global {
  interface Window {
    requirejs?: RequireJs;
    define?: {
      (name: string, dependencies: string[], factory: () => unknown): void;
      amd?: unknown;
    };
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

let requireJsReady: Promise<RequireJs> | null = null;

function installBundledRequireJs(): RequireJs {
  // RequireJS declares its globals with top-level `var`.  In xwidget-webkit,
  // an indirect eval can execute that source successfully without reflecting
  // those bindings onto `window`.  Execute it in a function scope, return the
  // bindings explicitly, and install them ourselves.
  const bindings = evaluateAmdLoaderSource(requireJsSource);
  if (typeof bindings.requirejs !== "function" || typeof bindings.define !== "function") {
    throw new Error("Bundled RequireJS did not expose its AMD bindings");
  }
  window.requirejs = bindings.requirejs as RequireJs;
  window.define = bindings.define as Window["define"];
  // Some third-party widget bundles inspect the conventional `require`
  // global even though Noema itself uses `requirejs`.
  (window as unknown as { require?: RequireJs }).require = (typeof bindings.require === "function" ? bindings.require : bindings.requirejs) as RequireJs;
  return bindings.requirejs as RequireJs;
}

function ensureRequireJs(): Promise<RequireJs> {
  if (window.requirejs) return Promise.resolve(window.requirejs);
  if (requireJsReady) return requireJsReady;
  requireJsReady = new Promise((resolve, reject) => {
    try {
      resolve(installBundledRequireJs());
    } catch (error) {
      reject(new Error(`Failed to initialize the bundled RequireJS runtime: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  return requireJsReady;
}

function requireModule(requireJs: RequireJs, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => requireJs([name], resolve, reject));
}

function defineCoreAmdModules(): void {
  const define = window.define;
  const requireJs = window.requirejs;
  if (!define || !requireJs) throw new Error("RequireJS globals are unavailable");
  requireJs.config({
    map: {
      "*": {
        "jupyter-js-widgets": "@jupyter-widgets/base",
      },
    },
  });
  const modules: Array<[string, unknown]> = [
    ["@jupyter-widgets/base", widgetBase],
    ["@jupyter-widgets/controls", widgetControls],
    ["@jupyter-widgets/output", widgetOutput],
  ];
  for (const [name, value] of modules) {
    if (!requireJs.defined(name)) define(name, [], () => value);
  }
}

const coreWidgetModules = new Map<string, unknown>([
  ["@jupyter-widgets/base", widgetBase],
  ["@jupyter-widgets/controls", widgetControls],
  ["@jupyter-widgets/output", widgetOutput],
]);

async function loadCustomWidgetModule(moduleName: string, moduleVersion: string): Promise<unknown> {
  if (!validWidgetModuleName(moduleName)) throw new Error(`Invalid widget module name: ${moduleName}`);
  if (!validWidgetModuleVersion(moduleVersion)) throw new Error(`Invalid widget module version: ${moduleVersion}`);
  document.body.dataset.baseUrl ??= new URL("/jupyter/", window.location.origin).toString();
  // Standard ipywidgets (including @interact sliders) are already bundled.
  // Returning them directly avoids making core controls depend on an AMD
  // compatibility layer that is only needed by third-party widget packages.
  const coreModule = coreWidgetModules.get(moduleName);
  if (coreModule) return coreModule;
  const requireJs = await ensureRequireJs();
  defineCoreAmdModules();
  const localPath = `${window.location.origin}/jupyter/nbextensions/${moduleName}/index`;
  requireJs.config({ paths: { [moduleName]: localPath } });
  try {
    return await requireModule(requireJs, moduleName);
  } catch {
    requireJs.undef(moduleName);
  }
  for (const cdnPath of widgetModuleCdnUrls(moduleName, moduleVersion)) {
    console.info(`[aaronnote-jupyter] loading widget module ${moduleName}@${moduleVersion} from ${new URL(cdnPath).hostname}`);
    requireJs.config({ paths: { [moduleName]: cdnPath } });
    try {
      return await requireModule(requireJs, moduleName);
    } catch {
      requireJs.undef(moduleName);
    }
  }
  throw new Error(`Unable to load widget module ${moduleName}@${moduleVersion} from local nbextensions or CDN`);
}

class AaronnoteWidgetManager extends KernelWidgetManager {
  readonly renderMime: RenderMimeRegistry;
  private restorePromise: Promise<void> | null = null;
  private replayQueue: Promise<void> = Promise.resolve();
  private readonly replayedMessages = new Set<string>();
  private readonly views = new Set<WidgetViewLike>();
  private readonly seededOutputComms = new Set<string>();

  constructor(kernel: Kernel.IKernelConnection) {
    // Same render stack as cell outputs (KaTeX LaTeX, iframe/HTML handling) so
    // content shown *inside* widgets (e.g. an @interact Output area) matches
    // the surrounding cell output exactly.
    const renderMime = createBaseRenderMime();
    super(kernel, renderMime);
    this.renderMime = renderMime;
    this.registerCoreWidgetModules();
    this.renderMime.addFactory({
      safe: false,
      mimeTypes: [WIDGET_VIEW_MIMETYPE],
      createRenderer: (options) => new WidgetRenderer(options, this as never),
    }, 0);
    window.addEventListener("resize", () => {
      for (const view of this.views) {
        const widget = view.luminoWidget || view.pWidget;
        if (widget) MessageLoop.postMessage(widget, LuminoWidgets.Widget.ResizeMessage.UnknownSize);
      }
    });
  }

  get rendermime(): RenderMimeRegistry {
    return this.renderMime;
  }

  private registerCoreWidgetModules(): void {
    this.register({
      name: "@jupyter-widgets/base",
      version: String(widgetBase.JUPYTER_WIDGETS_VERSION || "2.0.0"),
      exports: widgetBase as never,
    });
    this.register({
      name: "@jupyter-widgets/controls",
      version: String(widgetControls.JUPYTER_CONTROLS_VERSION || "2.0.0"),
      exports: widgetControls as never,
    });
    this.register({
      name: "@jupyter-widgets/output",
      version: String(widgetOutput.OUTPUT_WIDGET_VERSION || "1.0.0"),
      exports: widgetOutput as never,
    });
  }

  protected override async loadClass(className: string, moduleName: string, moduleVersion: string): Promise<never> {
    try {
      return await super.loadClass(className, moduleName, moduleVersion) as never;
    } catch (registeredError) {
      const module = await loadCustomWidgetModule(moduleName, moduleVersion);
      const exports = module && typeof module === "object" ? module as Record<string, unknown> : {};
      const nestedDefault = exports.default && typeof exports.default === "object" ? exports.default as Record<string, unknown> : {};
      const value = exports[className] ?? nestedDefault[className];
      if (typeof value !== "function") {
        const message = registeredError instanceof Error ? registeredError.message : String(registeredError);
        throw new Error(`Class ${className} not found in widget module ${moduleName}@${moduleVersion}: ${message}`);
      }
      return value as never;
    }
  }

  async displayView(view: unknown, host: HTMLElement): Promise<void> {
    const resolved = await view as WidgetViewLike;
    const widget = resolved.luminoWidget || resolved.pWidget;
    if (widget) {
      LuminoWidgets.Widget.attach(widget, host);
    } else if (resolved.el instanceof HTMLElement) {
      host.append(resolved.el);
    } else {
      throw new Error("Widget view has no attachable DOM element");
    }
    this.views.add(resolved);
    resolved.once?.("remove", () => this.views.delete(resolved));
  }

  restoreFromKernel(): Promise<void> {
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.attemptRestoreFromKernel();
    return this.restorePromise;
  }

  private async attemptRestoreFromKernel(): Promise<void> {
    try {
      await this.restoreWidgets();
    } finally {
      // A restore that loaded nothing may simply have raced the connection
      // warming up (comm target registration / IOPub subscribe still
      // settling) rather than reflecting "this kernel truly has no widgets".
      // Don't let that empty result wedge every *later* mount attempt onto
      // the same stale promise — clear it so the next restoreFromKernel()
      // call (this mount's retry, or a future cell run) gets a fresh look.
      if (this.loadedModelCount() === 0) this.restorePromise = null;
    }
  }

  loadedModelCount(): number {
    const models = (this as unknown as { _models?: Record<string, unknown> })._models;
    return models ? Object.keys(models).length : 0;
  }

  async restoreFromMessages(messages: JupyterWidgetKernelMessage[] = []): Promise<void> {
    const run = this.replayQueue.then(async () => {
      for (const message of messages) await this.replayKernelMessage(message);
    });
    this.replayQueue = run.catch(() => undefined);
    await run;
  }

  private existingKernelComm(commId: string): Kernel.IComm | null {
    const kernel = this.kernel as unknown as { _comms?: Map<string, Kernel.IComm> };
    return kernel._comms?.get(commId) ?? null;
  }

  private createOrReuseComm(targetName: string, commId: string): Kernel.IComm {
    const existing = this.existingKernelComm(commId);
    if (existing) return existing;
    try {
      return this.kernel.createComm(targetName, commId);
    } catch (error) {
      const createdByConcurrentReplay = this.existingKernelComm(commId);
      if (createdByConcurrentReplay && /Comm is already created/.test(errorText(error))) {
        return createdByConcurrentReplay;
      }
      throw error;
    }
  }

  private async replayKernelMessage(message: JupyterWidgetKernelMessage): Promise<void> {
    const type = String(message?.header?.msg_type || "");
    if (!["comm_open", "comm_msg", "comm_close"].includes(type)) return;
    const commId = String(message?.content?.comm_id || "");
    if (!commId) return;
    const key = [
      type,
      commId,
      String(message?.header?.msg_id || ""),
      JSON.stringify(message?.content?.data ?? null).slice(0, 512),
    ].join("\0");
    if (this.replayedMessages.has(key)) return;

    if (type === "comm_open") {
      if (this.has_model(commId)) {
        this.replayedMessages.add(key);
        return;
      }
      const targetName = String(message?.content?.target_name || this.comm_target_name);
      const comm = this.createOrReuseComm(targetName, commId);
      await this.handle_comm_open(new widgetBase.shims.services.Comm(comm), message as never);
      this.replayedMessages.add(key);
      return;
    }

    if (!this.has_model(commId)) return;
    const model = await this.get_model(commId) as unknown as WidgetModelLike;
    if (type === "comm_close") {
      model._handle_comm_closed?.(message);
      this.replayedMessages.add(key);
      return;
    }
    model._handle_comm_msg?.(message);
    await model.state_change?.catch(() => undefined);
    this.replayedMessages.add(key);
  }

  // Seed the outputs of any Output widget with content captured server-side
  // during the (headless) execution. ipywidgets' Output widget captures
  // display output via a frontend msg_id hook, so a widget executed without a
  // live frontend restores with an empty `outputs` trait — we replay the
  // captured nbformat outputs so the initial render (e.g. an @interact's first
  // plot) shows inside the widget, matching JupyterLab / VS Code Jupyter.
  async seedOutputWidgets(widgetOutputs?: WidgetOutputsMap): Promise<void> {
    if (!widgetOutputs) return;
    for (const [commId, outputs] of Object.entries(widgetOutputs)) {
      if (this.seededOutputComms.has(commId)) continue;
      if (!Array.isArray(outputs) || outputs.length === 0) continue;
      if (!this.has_model(commId)) continue;
      let model: unknown;
      try { model = await this.get_model(commId); } catch { continue; }
      const outputModel = model as { set?: (key: string, value: unknown) => void; save_changes?: () => void };
      if (typeof outputModel.set !== "function") continue;
      this.seededOutputComms.add(commId);
      outputModel.set("outputs", outputs);
      outputModel.save_changes?.();
    }
  }

  async mount(modelId: string, host: HTMLElement, messages: JupyterWidgetKernelMessage[] = [], widgetOutputs?: WidgetOutputsMap): Promise<() => void> {
    // Kernel-state-first: pull live widget state directly from the kernel via
    // the ipywidgets control comm (KernelWidgetManager.restoreWidgets), exactly
    // like JupyterLab and VS Code Jupyter. This is what makes interaction work:
    // the live view registers its own comm/message hooks, so slider changes
    // round-trip and Output areas update in place.
    let restoreError: unknown = null;
    try {
      await this.restoreFromKernel();
    } catch (error) {
      restoreError = error;
    }
    if (!this.has_model(modelId)) {
      // The first restore can lose a race against the connection actually
      // warming up (comm target registration / IOPub subscribe settling) —
      // this is the classic "works on the second run" symptom. Since a 0-model
      // restore no longer wedges restorePromise (see restoreFromKernel), retry
      // once, in-place, before falling back to a static message replay.
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      try {
        await this.restoreFromKernel();
      } catch (error) {
        restoreError = error;
      }
    }
    const modelsAfterRestore = this.loadedModelCount();
    const viaRestore = this.has_model(modelId);
    // Fallback for kernels whose ipywidgets predate the control comm, or when
    // the live state was unavailable: replay the comm messages captured during
    // execution. This yields a static (non-interactive) view but avoids a hard
    // failure.
    let replayError: unknown = null;
    if (!this.has_model(modelId) && messages.length > 0) {
      try {
        await this.restoreFromMessages(messages);
      } catch (error) {
        replayError = error;
      }
    }
    if (!this.has_model(modelId)) {
      // Report *why* nothing resolved so the failure is actionable on screen
      // instead of a bare "model not found": which mechanism ran, how much it
      // produced, and the live connection state.
      const parts = [
        restoreError
          ? `kernel restore failed: ${errorText(restoreError)}`
          : `kernel restore loaded ${modelsAfterRestore} model(s)`,
        replayError
          ? `message replay failed: ${errorText(replayError)}`
          : `${messages.length} replay message(s)`,
        `kernel ${this.kernel.connectionStatus}/${this.kernel.status}`,
      ];
      const detail = parts.join("; ");
      console.error(`[aaronnote-jupyter] widget model ${modelId} not found — ${detail}`);
      throw new Error(`widget model not found (${detail})`);
    }
    console.info(
      `[aaronnote-jupyter] mounted widget ${modelId.slice(0, 8)} via ${viaRestore ? "kernel-restore (LIVE)" : "message-replay (static)"}`
      + ` — ${this.loadedModelCount()} models, kernel ${this.kernel.connectionStatus}/${this.kernel.status}`,
    );
    await this.seedOutputWidgets(widgetOutputs);
    const model = await this.get_model(modelId);
    const view = await this.create_view(model);
    host.replaceChildren();
    await this.displayView(view, host);
    return () => {
      try { (view as unknown as WidgetViewLike).remove(); } catch {}
    };
  }
}

type RuntimeEntry = {
  kernel: KernelConnection;
  manager: AaronnoteWidgetManager;
};

let runtimeEntries: Map<string, Promise<RuntimeEntry>> | undefined;

type WebSocketHandler = ((event: Event) => unknown) | null;
type WebSocketMessageHandler = ((event: MessageEvent) => unknown) | null;

function runtimeChannelsUrl(runtime: JupyterWidgetRuntime, sessionId: string): string {
  const url = new URL(`/jupyter/widget-runtimes/${encodeURIComponent(runtime.id)}/channels`, window.location.origin);
  url.searchParams.set("session_id", sessionId);
  return url.toString().replace(/^http/i, "ws");
}

function runtimeWebSocketCtor(runtime: JupyterWidgetRuntime): typeof WebSocket {
  return class AaronnoteRuntimeWebSocket {
    onopen: WebSocketHandler = null;
    onclose: WebSocketHandler = null;
    onerror: WebSocketHandler = null;
    onmessage: WebSocketMessageHandler = null;
    private readonly socket: WebSocket;
    private binaryTypeValue: BinaryType = "blob";
    private readonly targetUrl: string;

    constructor(url: string | URL, protocols?: string | string[]) {
      const requested = new URL(String(url), window.location.href);
      const sessionId = requested.searchParams.get("session_id") || crypto.randomUUID();
      this.targetUrl = runtimeChannelsUrl(runtime, sessionId);
      this.socket = protocols && (Array.isArray(protocols) ? protocols.length > 0 : protocols)
        ? new WebSocket(this.targetUrl, protocols)
        : new WebSocket(this.targetUrl);
      this.socket.binaryType = this.binaryTypeValue;
      this.socket.onopen = (event) => this.onopen?.call(this, event);
      this.socket.onclose = (event) => this.onclose?.call(this, event);
      this.socket.onerror = (event) => this.onerror?.call(this, event);
      this.socket.onmessage = (event) => this.onmessage?.call(this, event);
    }

    get readyState(): number {
      return this.socket.readyState;
    }

    get url(): string {
      return this.targetUrl;
    }

    get protocol(): string {
      return this.socket.protocol;
    }

    get extensions(): string {
      return this.socket.extensions;
    }

    get bufferedAmount(): number {
      return this.socket.bufferedAmount;
    }

    get binaryType(): BinaryType {
      return this.binaryTypeValue;
    }

    set binaryType(value: BinaryType) {
      this.binaryTypeValue = value;
      this.socket.binaryType = value;
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      this.socket.send(data as never);
    }

    close(code?: number, reason?: string): void {
      this.socket.close(code, reason);
    }

    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
      if (!listener) return;
      (this.socket as EventTarget).addEventListener(type, listener, options);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
      if (!listener) return;
      (this.socket as EventTarget).removeEventListener(type, listener, options);
    }

    dispatchEvent(event: Event): boolean {
      return this.socket.dispatchEvent(event);
    }
  } as unknown as typeof WebSocket;
}

function runtimeEntryMap(): Map<string, Promise<RuntimeEntry>> {
  runtimeEntries ??= new Map<string, Promise<RuntimeEntry>>();
  return runtimeEntries;
}

function runtimeKey(runtime: JupyterWidgetRuntime): string {
  return `${runtime.id}:${Number(runtime.generation || 1)}`;
}

function disposeOlderGenerations(runtime: JupyterWidgetRuntime): void {
  const keep = runtimeKey(runtime);
  const entries = runtimeEntryMap();
  for (const [key, pending] of Array.from(entries.entries())) {
    if (!key.startsWith(`${runtime.id}:`) || key === keep) continue;
    entries.delete(key);
    void pending.then(({ kernel }) => kernel.dispose()).catch(() => {});
  }
}

// Wait for the connection to actually be usable before trusting it: not just
// "kernel_info replied on shell" (jlab's own `kernel.info` already waits for
// that) but "connected" *and* at least one IOPub message seen. Each browser
// widget connection is its own fresh ZMQ identity/subscription on the server
// bridge, so it has the same slow-joiner window a brand-new subscriber always
// does — without this, the very first restoreWidgets() call on it can race
// past comm state that hasn't arrived yet (the root cause of "works on the
// second run").
async function warmupRuntimeConnection(kernel: KernelConnection, timeoutMs = 10_000): Promise<void> {
  await withTimeout(
    (async () => {
      if (kernel.connectionStatus !== "connected") {
        await new Promise<void>((resolve) => {
          const handler = (_sender: unknown, status: string) => {
            if (status !== "connected") return;
            kernel.connectionStatusChanged.disconnect(handler as never);
            resolve();
          };
          kernel.connectionStatusChanged.connect(handler as never);
          if (kernel.connectionStatus === "connected") {
            kernel.connectionStatusChanged.disconnect(handler as never);
            resolve();
          }
        });
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          kernel.iopubMessage.disconnect(finish as never);
          resolve();
        };
        kernel.iopubMessage.connect(finish as never);
        // Poke the kernel in case no iopub traffic is already in flight; retry
        // once shortly after in case the first request raced kernel startup.
        kernel.requestKernelInfo().catch(() => {});
        window.setTimeout(() => { if (!settled) kernel.requestKernelInfo().catch(() => {}); }, 500);
      });
    })(),
    timeoutMs,
    "Timed out warming up the widget kernel connection",
  );
}

async function createRuntimeEntry(runtime: JupyterWidgetRuntime): Promise<RuntimeEntry> {
  const baseUrl = new URL("/jupyter/", window.location.origin).toString();
  const serverSettings = ServerConnection.makeSettings({
    baseUrl,
    wsUrl: "ws://aaronnote-widget-runtime/",
    token: "",
    WebSocket: runtimeWebSocketCtor(runtime),
  });
  const kernel = new KernelConnection({
    model: { id: runtime.id, name: runtime.name },
    serverSettings,
    username: "aaronnote-widget",
    handleComms: true,
  });
  await kernel.info;
  await warmupRuntimeConnection(kernel);
  return { kernel, manager: new AaronnoteWidgetManager(kernel) };
}

function getRuntimeEntry(runtime: JupyterWidgetRuntime): Promise<RuntimeEntry> {
  disposeOlderGenerations(runtime);
  const key = runtimeKey(runtime);
  const entries = runtimeEntryMap();
  const existing = entries.get(key);
  if (existing) return existing;
  const pending = createRuntimeEntry(runtime).catch((error) => {
    entries.delete(key);
    throw error;
  });
  entries.set(key, pending);
  return pending;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function mountJupyterWidget(
  host: HTMLElement,
  modelId: string,
  runtime: JupyterWidgetRuntime,
  messages: JupyterWidgetKernelMessage[] = [],
  widgetOutputs?: WidgetOutputsMap,
): Promise<() => void> {
  if (!runtime.id || !runtime.name) throw new Error("Missing live Jupyter widget runtime");
  const { manager } = await withTimeout(getRuntimeEntry(runtime), 15_000, "Timed out connecting to live Jupyter kernel");
  return await withTimeout(manager.mount(modelId, host, messages, widgetOutputs), 20_000, "Timed out restoring interactive widget state");
}

/** Dispose every live widget-runtime KernelConnection (all generations, all kernels). */
export function disposeJupyterWidgetRuntimes(): void {
  const entries = runtimeEntryMap();
  for (const [key, pending] of Array.from(entries.entries())) {
    entries.delete(key);
    void pending.then(({ kernel }) => kernel.dispose()).catch(() => {});
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => disposeJupyterWidgetRuntimes());
}
