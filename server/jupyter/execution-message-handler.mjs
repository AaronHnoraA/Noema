// Drives one execute_request against a live jlab kernel connection and
// assembles the same output/widget-message shape the old ephemeral-per-exec
// WebSocket implementation in server/lib/jupyter-cell.mjs produced. Ported
// concept from microsoft/vscode-jupyter's `cellExecutionMessageHandler.ts`
// (iopub -> notebook-output mapping, display_id tracking, Output-widget
// swallowing), adapted to aaronnote's flat `outputs[]` result shape.
//
// Captures ALL iopub/comm traffic visible on `kernel` for the lifetime of this
// call (via `kernel.anyMessage`), not just messages for this execution's own
// msg_id — matching the old model, where the multiplexed per-exec WebSocket
// saw every iopub broadcast (from any client sharing the kernel) during its
// lifetime. This is what lets `widgetMessages` capture ipywidgets state that a
// *browser*-side widget-runtime connection (a separate ZMQ identity) changed
// concurrently: IOPub is a ZMQ PUB/SUB fanout, so every subscriber — including
// this server-owned connection — sees it.

import { createOutputWidgetRouter } from "../lib/jupyter-output-router.mjs";

function objectValue(value) {
  return value && typeof value === "object" ? value : {};
}

/** Is this comm_open content an ipywidgets comm (any widget, not just Output)? */
export function jupyterWidgetCommOpenP(content) {
  const targetName = String(content?.target_name || "");
  if (/^jupyter\.widget(?:\.|$)/.test(targetName)) return true;
  const data = objectValue(content?.data);
  const state = objectValue(data.state);
  const modelName = String(state._model_name || "");
  const modelModule = String(state._model_module || "");
  const viewName = String(state._view_name || "");
  const viewModule = String(state._view_module || "");
  return Boolean(modelName || modelModule || viewName || viewModule);
}

/**
 * @param {import("@jupyterlab/services").Kernel.IKernelConnection} kernel
 * @param {string} code
 * @param {object} [options]
 * @returns {Promise<{status: string, executionCount: number|null, outputs: object[], widgetMessages?: object[], widgetMessagesTruncated?: boolean, widgetOutputs?: Record<string, object[]>}>}
 */
export function executeOnKernel(kernel, code, options = {}) {
  const {
    silent = false,
    storeHistory = true,
    streamLimit = 1024 * 1024,
    widgetMessageLimit = 512,
    widgetMessageBytesLimit = 8 * 1024 * 1024,
    execTimeoutMs = 0,
  } = options;

  const outputs = [];
  const displayIndexes = new Map();
  const widgetCommIds = new Set();
  const outputRouter = createOutputWidgetRouter();
  const widgetMessages = [];
  let widgetMessageBytes = 0;
  let widgetMessagesTruncated = false;
  let streamBytes = 0;
  let streamTruncated = false;
  let clearOnNext = false;
  let executionCount = null;

  const rememberWidgetMessage = (message) => {
    if (widgetMessagesTruncated) return;
    const type = String(message?.header?.msg_type || "");
    if (!["comm_open", "comm_msg", "comm_close"].includes(type)) return;
    const content = objectValue(message?.content);
    const commId = String(content.comm_id || "");
    if (!commId) return;
    if (type === "comm_open") {
      if (!jupyterWidgetCommOpenP(content)) return;
      widgetCommIds.add(commId);
    } else if (!widgetCommIds.has(commId)) {
      return;
    }
    const payload = {
      channel: message.channel || "iopub",
      header: message.header || {},
      parent_header: message.parent_header || {},
      metadata: message.metadata || {},
      content,
      buffers: Array.isArray(message.buffers) ? message.buffers : [],
    };
    const encoded = JSON.stringify(payload);
    widgetMessageBytes += Buffer.byteLength(encoded, "utf8");
    if (widgetMessages.length >= widgetMessageLimit || widgetMessageBytes > widgetMessageBytesLimit) {
      widgetMessagesTruncated = true;
      return;
    }
    widgetMessages.push(payload);
  };

  const pushOutput = (output) => {
    if (clearOnNext) {
      outputs.length = 0;
      displayIndexes.clear();
      streamBytes = 0;
      streamTruncated = false;
      clearOnNext = false;
    }
    if (output.output_type === "stream") {
      if (streamTruncated) return;
      const last = outputs[outputs.length - 1];
      if (last && last.output_type === "stream" && last.name === output.name) {
        last.text += output.text;
      } else {
        outputs.push(output);
      }
      streamBytes += Buffer.byteLength(String(output.text || ""), "utf8");
      if (streamBytes > streamLimit) {
        streamTruncated = true;
        outputs.push({
          output_type: "stream",
          name: "stderr",
          text: `\n[aaronnote: output truncated at ${streamLimit} bytes]\n`,
        });
      }
      return;
    }
    const displayId = output?.transient?.display_id;
    if (displayId && output.output_type === "update_display_data") {
      if (displayIndexes.has(displayId)) {
        outputs[displayIndexes.get(displayId)] = { ...output, output_type: "display_data" };
        return;
      }
      output = { ...output, output_type: "display_data" };
    }
    if (displayId) displayIndexes.set(displayId, outputs.length);
    outputs.push(output);
  };

  const emitOutput = (parentId, output) => {
    const commId = outputRouter.targetCommFor(parentId);
    if (commId) outputRouter.pushOutput(commId, output);
    else pushOutput(output);
  };

  return new Promise((resolveDone, rejectDone) => {
    let settled = false;
    let timeoutHandle = null;
    const future = kernel.requestExecute({
      code,
      silent,
      store_history: storeHistory,
      allow_stdin: false,
      stop_on_error: false,
    });
    const msgId = future.msg.header.msg_id;

    const anyMessageHandler = (_kernel, { msg }) => {
      rememberWidgetMessage(msg);
      outputRouter.track(msg);
      if (msg?.parent_header?.msg_id !== msgId || msg.channel !== "iopub") return;
      const type = msg.header?.msg_type || "";
      const content = msg.content || {};
      const parentId = msgId;
      if (type === "execute_input") {
        executionCount = content.execution_count ?? executionCount;
      } else if (type === "stream") {
        emitOutput(parentId, { output_type: "stream", name: content.name || "stdout", text: content.text || "" });
      } else if (type === "execute_result") {
        executionCount = content.execution_count ?? executionCount;
        emitOutput(parentId, {
          output_type: "execute_result",
          execution_count: content.execution_count ?? null,
          data: content.data || {},
          metadata: content.metadata || {},
        });
      } else if (type === "display_data" || type === "update_display_data") {
        emitOutput(parentId, {
          output_type: type,
          data: content.data || {},
          metadata: content.metadata || {},
          transient: content.transient || {},
        });
      } else if (type === "error") {
        emitOutput(parentId, {
          output_type: "error",
          ename: content.ename || "",
          evalue: content.evalue || "",
          traceback: Array.isArray(content.traceback) ? content.traceback : [],
        });
      } else if (type === "clear_output") {
        const commId = outputRouter.targetCommFor(parentId);
        if (commId) {
          outputRouter.clearOutput(commId, Boolean(content.wait));
        } else if (content.wait) {
          clearOnNext = true;
        } else {
          outputs.length = 0;
          displayIndexes.clear();
          streamBytes = 0;
          streamTruncated = false;
        }
      }
    };

    kernel.anyMessage.connect(anyMessageHandler);
    const cleanup = () => {
      kernel.anyMessage.disconnect(anyMessageHandler);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    if (execTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error("Jupyter execution timed out");
        err.statusCode = 504;
        rejectDone(err);
      }, execTimeoutMs);
    }

    future.done.then(
      (reply) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveDone({
          status: reply.content.status || "ok",
          executionCount,
          outputs,
          ...(widgetMessages.length > 0 ? { widgetMessages, widgetMessagesTruncated } : {}),
          ...(outputRouter.hasOutputs() ? { widgetOutputs: outputRouter.widgetOutputs } : {}),
        });
      },
      (ex) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectDone(ex instanceof Error ? ex : new Error(String(ex)));
      },
    );
  });
}
