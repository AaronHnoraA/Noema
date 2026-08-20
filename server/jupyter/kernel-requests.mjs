// Shell-channel introspection requests: complete, inspect, is_complete,
// history, comm_info.
//
// These are the half of the Jupyter message spec an interactive frontend needs
// but a "run the cell, show the outputs" loop does not, so they were missing
// from the original vscode-jupyter port. @jupyterlab/services already
// implements every one of them on KernelConnection; this module exists to
// normalize the replies into the camelCase shapes the API layer speaks, and —
// more importantly — to bound them in time.
//
// Bounding matters: ipykernel services the shell channel strictly in order, so
// a complete_request issued while a long cell is running is not answered until
// that cell finishes. Without a timeout, typing during a 10-minute run would
// hang the completion popup for 10 minutes. Every request here resolves to an
// empty/absent result instead of waiting, and the caller renders nothing.

import { raceTimeout } from "./util.mjs";

const TIMED_OUT = Symbol("jupyter-request-timeout");

async function bounded(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return await promise;
  const settled = Promise.resolve(promise).catch((ex) => ({ __error: ex }));
  const result = await raceTimeout(timeoutMs, TIMED_OUT, settled);
  if (result === TIMED_OUT) return TIMED_OUT;
  if (result && result.__error) throw result.__error;
  return result;
}

function replyContent(reply) {
  const content = reply?.content;
  return content && typeof content === "object" ? content : null;
}

/**
 * `complete_request`. Returns the raw match strings plus, when the kernel
 * supplies it, the richer per-item metadata from `_jupyter_types_experimental`
 * (IPython's de-facto standard, also what JupyterLab's completer consumes):
 * a type name and, for callables, a signature.
 *
 * `cursorStart`/`cursorEnd` are offsets into `code` describing the span the
 * matches replace — the kernel decides how much of the token it is completing
 * (`os.pa|` replaces `pa`, but `df['co|` may replace the whole quoted key), so
 * a client must never assume a word boundary of its own.
 */
export async function completeOnKernel(kernel, { code, cursorPos, timeoutMs = 3000 } = {}) {
  const position = Number.isFinite(cursorPos) ? Number(cursorPos) : String(code || "").length;
  const empty = { matches: [], items: [], cursorStart: position, cursorEnd: position, complete: false };
  if (!kernel || typeof kernel.requestComplete !== "function") return empty;

  const reply = await bounded(
    kernel.requestComplete({ code: String(code || ""), cursor_pos: position }),
    timeoutMs,
  );
  if (reply === TIMED_OUT) return { ...empty, timedOut: true };
  const content = replyContent(reply);
  if (!content || content.status !== "ok") return empty;

  const matches = Array.isArray(content.matches) ? content.matches.map((value) => String(value)) : [];
  const experimental = content.metadata?._jupyter_types_experimental;
  const detail = new Map();
  if (Array.isArray(experimental)) {
    for (const entry of experimental) {
      const text = String(entry?.text ?? "");
      if (!text || detail.has(text)) continue;
      detail.set(text, {
        type: String(entry?.type ?? ""),
        signature: String(entry?.signature ?? ""),
      });
    }
  }
  return {
    matches,
    items: matches.map((text) => ({ text, ...(detail.get(text) || { type: "", signature: "" }) })),
    cursorStart: Number(content.cursor_start ?? position),
    cursorEnd: Number(content.cursor_end ?? position),
    complete: true,
  };
}

/**
 * `inspect_request` — the `Shift+Tab` / `?obj` docstring popup. `detailLevel`
 * 0 is the summary, 1 is the source (`??obj`).
 */
export async function inspectOnKernel(kernel, { code, cursorPos, detailLevel = 0, timeoutMs = 5000 } = {}) {
  const position = Number.isFinite(cursorPos) ? Number(cursorPos) : String(code || "").length;
  const empty = { found: false, data: {}, metadata: {} };
  if (!kernel || typeof kernel.requestInspect !== "function") return empty;

  const reply = await bounded(
    kernel.requestInspect({
      code: String(code || ""),
      cursor_pos: position,
      detail_level: detailLevel === 1 ? 1 : 0,
    }),
    timeoutMs,
  );
  if (reply === TIMED_OUT) return { ...empty, timedOut: true };
  const content = replyContent(reply);
  if (!content || content.status !== "ok") return empty;
  return {
    found: Boolean(content.found),
    data: content.data || {},
    metadata: content.metadata || {},
  };
}

/**
 * `is_complete_request` — whether a code fragment is a complete statement.
 * Status is one of `complete`, `incomplete`, `invalid`, `unknown`; for
 * `incomplete` the kernel also says what to indent the continuation line by.
 * Kernels are not required to implement it, and one that doesn't answers
 * `unknown`, which callers must treat as "assume complete".
 */
export async function isCompleteOnKernel(kernel, { code, timeoutMs = 3000 } = {}) {
  const empty = { status: "unknown", indent: "" };
  if (!kernel || typeof kernel.requestIsComplete !== "function") return empty;

  const reply = await bounded(kernel.requestIsComplete({ code: String(code || "") }), timeoutMs);
  if (reply === TIMED_OUT) return { ...empty, timedOut: true };
  const content = replyContent(reply);
  if (!content) return empty;
  return {
    status: String(content.status || "unknown"),
    indent: String(content.indent || ""),
  };
}

/**
 * `history_request`. Only the `tail` and `search` access patterns are exposed;
 * `range` needs a session id the cell model has no equivalent of.
 */
export async function historyOnKernel(kernel, { pattern = "", count = 100, output = false, timeoutMs = 5000 } = {}) {
  const empty = { history: [] };
  if (!kernel || typeof kernel.requestHistory !== "function") return empty;

  const request = pattern
    ? { output, raw: true, hist_access_type: "search", pattern: String(pattern), n: Number(count) || 100, unique: true }
    : { output, raw: true, hist_access_type: "tail", n: Number(count) || 100 };
  const reply = await bounded(kernel.requestHistory(request), timeoutMs);
  if (reply === TIMED_OUT) return { ...empty, timedOut: true };
  const content = replyContent(reply);
  if (!content || content.status !== "ok" || !Array.isArray(content.history)) return empty;
  return {
    history: content.history.map((entry) => {
      const [session, lineNumber, source] = Array.isArray(entry) ? entry : [];
      // With `output: true` the third element is a [input, output] pair.
      const pair = Array.isArray(source) ? source : [source, ""];
      return {
        session: Number(session) || 0,
        lineNumber: Number(lineNumber) || 0,
        source: String(pair[0] ?? ""),
        output: String(pair[1] ?? ""),
      };
    }),
  };
}

/**
 * `comm_info_request` — the comms currently open on the kernel. Used to tell a
 * reconnecting widget manager which ipywidgets models still exist, which is the
 * ipywidgets 7 path (ipywidgets 8 uses the control comm instead).
 */
export async function commInfoOnKernel(kernel, { targetName = "", timeoutMs = 5000 } = {}) {
  const empty = { comms: {} };
  if (!kernel || typeof kernel.requestCommInfo !== "function") return empty;

  const reply = await bounded(
    kernel.requestCommInfo(targetName ? { target_name: String(targetName) } : {}),
    timeoutMs,
  );
  if (reply === TIMED_OUT) return { ...empty, timedOut: true };
  const content = replyContent(reply);
  if (!content || content.status !== "ok") return empty;
  return { comms: content.comms || {} };
}
