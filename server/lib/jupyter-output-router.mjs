// ipywidgets Output-widget output routing.
//
// Mirrors the behaviour of VS Code Jupyter's cellExecutionMessageHandler: while
// an ipywidgets `Output` widget's context manager is active on the kernel it
// publishes a `msg_id` on its comm. Any iopub output (display_data / stream /
// execute_result / error / clear_output) whose `parent_header.msg_id` matches
// that value belongs *inside* the widget, not at the top level of the cell.
//
// The router tracks those msg_id windows from the widget comm traffic and lets
// the caller ask, for a given parent msg_id, which Output-widget comm (if any)
// should receive an output. Captured outputs are grouped by comm_id so the
// client can seed the widget after it mounts.

export function createOutputWidgetRouter() {
  const outputWidgetComms = new Set();
  const msgIdToOutputComm = new Map();
  const widgetOutputs = Object.create(null);
  const clearOnNext = new Set();

  const dropMsgIdsForComm = (commId) => {
    for (const [mid, cid] of Array.from(msgIdToOutputComm)) {
      if (cid === commId) msgIdToOutputComm.delete(mid);
    }
  };

  // Feed every widget comm message here (comm_open / comm_msg / comm_close),
  // before any parent-id filtering — comm bookkeeping is independent of which
  // execution a message belongs to.
  const track = (message) => {
    const type = String(message?.header?.msg_type || "");
    const content = message?.content && typeof message.content === "object" ? message.content : {};
    const commId = String(content.comm_id || "");
    if (!commId) return;
    if (type === "comm_open") {
      const data = content.data && typeof content.data === "object" ? content.data : {};
      const state = data.state && typeof data.state === "object" ? data.state : {};
      const modelName = String(state._model_name || "");
      const modelModule = String(state._model_module || "");
      if (modelName === "OutputModel" || /@jupyter-widgets\/output/.test(modelModule)) {
        outputWidgetComms.add(commId);
        if (state.msg_id) msgIdToOutputComm.set(String(state.msg_id), commId);
      }
      return;
    }
    if (type === "comm_close") {
      outputWidgetComms.delete(commId);
      dropMsgIdsForComm(commId);
      return;
    }
    if (type === "comm_msg" && outputWidgetComms.has(commId)) {
      const data = content.data && typeof content.data === "object" ? content.data : {};
      if (data.method === "update") {
        const state = data.state && typeof data.state === "object" ? data.state : {};
        if (Object.prototype.hasOwnProperty.call(state, "msg_id")) {
          dropMsgIdsForComm(commId);
          const nextMsgId = String(state.msg_id || "");
          if (nextMsgId) msgIdToOutputComm.set(nextMsgId, commId);
        }
      }
    }
  };

  // The Output-widget comm that should receive an output with the given parent
  // msg_id, or undefined for a top-level cell output.
  const targetCommFor = (parentId) => (parentId ? msgIdToOutputComm.get(parentId) : undefined);

  const pushOutput = (commId, output) => {
    const group = widgetOutputs[commId] || (widgetOutputs[commId] = []);
    if (clearOnNext.has(commId)) {
      clearOnNext.delete(commId);
      group.length = 0;
    }
    if (output.output_type === "stream") {
      const last = group[group.length - 1];
      if (last && last.output_type === "stream" && last.name === output.name) {
        last.text += output.text;
        return;
      }
    }
    group.push(output);
  };

  const clearOutput = (commId, wait) => {
    if (wait) {
      clearOnNext.add(commId);
      return;
    }
    widgetOutputs[commId] = [];
  };

  const hasOutputs = () => Object.keys(widgetOutputs).length > 0;

  return { track, targetCommFor, pushOutput, clearOutput, widgetOutputs, hasOutputs };
}
