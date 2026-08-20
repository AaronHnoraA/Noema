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
 * Apply the `payload` list an `execute_reply` may carry. The payload mechanism
 * is marked deprecated in the Jupyter spec but every IPython release still
 * uses it, and it is the only way these three behaviours reach a frontend:
 *
 * - `page`     — the `?obj` / `%pdoc` pager. Notebook frontends render it as
 *                ordinary cell output, so it goes through `pushOutput` and is
 *                persisted with the rest of the outputs.
 * - `set_next_input` — `%load`, `%recall`, `%rerun`. Returned to the caller so
 *                the cell source can be replaced (`replace: true`) or a new
 *                cell inserted below.
 * - `ask_exit` — `exit` / `quit` typed in a cell. Returned so the caller can
 *                shut the kernel down (unless the kernel asked to be kept).
 */
export function applyReplyPayloads(reply, pushOutput) {
  const payloads = Array.isArray(reply?.content?.payload) ? reply.content.payload : [];
  let setNextInput;
  let askExit;
  for (const item of payloads) {
    const source = String(item?.source || "");
    if (source === "page" && item.data && typeof pushOutput === "function") {
      pushOutput({ output_type: "display_data", data: item.data, metadata: {} });
    } else if (source === "set_next_input") {
      setNextInput = { text: String(item.text ?? ""), replace: Boolean(item.replace) };
    } else if (source === "ask_exit") {
      askExit = { keepKernel: Boolean(item.keepkernel) };
    }
  }
  return { setNextInput, askExit };
}

/**
 * @param {import("@jupyterlab/services").Kernel.IKernelConnection} kernel
 * @param {string} code
 * @param {object} [options]
 * @returns {Promise<{status: string, executionCount: number|null, outputs: object[], setNextInput?: {text: string, replace: boolean}, askExit?: {keepKernel: boolean}, widgetMessages?: object[], widgetMessagesTruncated?: boolean, widgetOutputs?: Record<string, object[]>}>}
 */
export function executeOnKernel(kernel, code, options = {}) {
  const {
    silent = false,
    storeHistory = true,
    stopOnError = false,
    streamLimit = 1024 * 1024,
    widgetMessageLimit = 512,
    widgetMessageBytesLimit = 8 * 1024 * 1024,
    execTimeoutMs = 0,
    onEvent,
    onStdin,
  } = options;

  // Live patch stream. The resolved `outputs` array stays authoritative — a
  // consumer that misses or drops events still ends up correct — so these are
  // deliberately cheap patches rather than repeated snapshots: appending to a
  // merged stream output must not re-send the whole (up to `streamLimit`)
  // text on every chunk.
  const emit = typeof onEvent === "function"
    ? (event) => { try { onEvent(event); } catch { /* a bad consumer must never break execution */ } }
    : null;

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
      emit?.({ kind: "clear" });
    }
    if (output.output_type === "stream") {
      if (streamTruncated) return;
      const last = outputs[outputs.length - 1];
      if (last && last.output_type === "stream" && last.name === output.name) {
        last.text += output.text;
        emit?.({ kind: "append", index: outputs.length - 1, text: String(output.text || "") });
      } else {
        outputs.push(output);
        // Snapshot: a merged stream output is mutated in place by later
        // chunks, and events are buffered before they are sent, so handing
        // out the live object would let a queued "set" grow text it should
        // not have and double-count against the "append" that follows.
        emit?.({ kind: "set", index: outputs.length - 1, output: { ...output } });
      }
      streamBytes += Buffer.byteLength(String(output.text || ""), "utf8");
      if (streamBytes > streamLimit) {
        streamTruncated = true;
        const marker = {
          output_type: "stream",
          name: "stderr",
          text: `\n[aaronnote: output truncated at ${streamLimit} bytes]\n`,
        };
        outputs.push(marker);
        emit?.({ kind: "set", index: outputs.length - 1, output: { ...marker } });
      }
      return;
    }
    const displayId = output?.transient?.display_id;
    if (displayId && output.output_type === "update_display_data") {
      if (displayIndexes.has(displayId)) {
        const index = displayIndexes.get(displayId);
        outputs[index] = { ...output, output_type: "display_data" };
        emit?.({ kind: "set", index, output: { ...outputs[index] } });
        return;
      }
      output = { ...output, output_type: "display_data" };
    }
    if (displayId) displayIndexes.set(displayId, outputs.length);
    outputs.push(output);
    emit?.({ kind: "set", index: outputs.length - 1, output: { ...output } });
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
      // Only advertise stdin when somebody can actually answer. With no
      // handler, `input()` raises StdinNotImplementedError immediately, which
      // is a clean error; advertising stdin with nobody listening would hang
      // the kernel — and this key's execution queue — forever.
      allow_stdin: Boolean(onStdin),
      stop_on_error: stopOnError,
    });
    const msgId = future.msg.header.msg_id;

    const anyMessageHandler = (_kernel, { msg }) => {
      rememberWidgetMessage(msg);
      outputRouter.track(msg);
      if (msg?.parent_header?.msg_id !== msgId || msg.channel !== "iopub") return;
      const type = msg.header?.msg_type || "";
      const content = msg.content || {};
      const parentId = msgId;
      if (type === "status") {
        // The kernel's own busy/idle, distinct from the execute_reply status:
        // it is what a frontend shows as the running indicator, and the only
        // signal that a cell is still working while producing no output.
        emit?.({ kind: "status", state: String(content.execution_state || "") });
      } else if (type === "execute_input") {
        executionCount = content.execution_count ?? executionCount;
        emit?.({ kind: "executionCount", value: executionCount ?? null });
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
          emit?.({ kind: "clear" });
        }
      }
    };

    kernel.anyMessage.connect(anyMessageHandler);

    const disarmTimeout = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };
    const armTimeout = () => {
      if (!(execTimeoutMs > 0) || settled) return;
      disarmTimeout();
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error("Jupyter execution timed out");
        err.statusCode = 504;
        rejectDone(err);
      }, execTimeoutMs);
    };
    const cleanup = () => {
      kernel.anyMessage.disconnect(anyMessageHandler);
      disarmTimeout();
    };

    if (onStdin) {
      future.onStdin = (message) => {
        if (message?.header?.msg_type !== "input_request") return;
        const content = objectValue(message.content);
        // A cell blocked on input() is not a hung cell. Stop the execution
        // timeout while we wait for a human, or a prompt left up for longer
        // than the timeout would be killed as if the kernel had wedged.
        disarmTimeout();
        Promise.resolve()
          .then(() => onStdin({
            prompt: String(content.prompt || ""),
            password: Boolean(content.password),
          }))
          .then(
            (value) => ({ status: "ok", value: String(value ?? "") }),
            // U+0004 (EOT) is how jupyter_client spells "no input": ipykernel
            // turns it into EOFError, so a cancelled or timed-out prompt ends
            // the cell with a normal Python error instead of leaving the
            // kernel — and this key's queue — blocked on a read forever.
            () => ({ status: "ok", value: "\u0004" }),
          )
          .then((reply) => {
            try {
              future.sendInputReply(reply, message.header);
            } catch {
              /* the kernel died while we were waiting */
            }
            armTimeout();
          });
      };
    }

    armTimeout();

    future.done.then(
      (reply) => {
        if (settled) return;
        settled = true;
        cleanup();
        const { setNextInput, askExit } = applyReplyPayloads(reply, pushOutput);
        resolveDone({
          status: reply.content.status || "ok",
          executionCount,
          outputs,
          ...(setNextInput ? { setNextInput } : {}),
          ...(askExit ? { askExit } : {}),
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
