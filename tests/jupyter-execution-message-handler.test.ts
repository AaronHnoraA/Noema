import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { executeOnKernel } from "../server/jupyter/execution-message-handler.mjs";

// Exercises executeOnKernel's iopub -> outputs mapping against a scripted fake
// kernel (no real process), covering the exact behaviors the old ephemeral-WS
// runExecuteOnKernel in server/lib/jupyter-cell.mjs had: stream concatenation,
// display_id update-in-place, clear_output(wait), error outputs, and
// Output-widget message routing. This is the parity safety net called out as
// the highest-risk item in the raw-kernel-stack migration plan.

function makeFakeKernel() {
  const listeners: Array<(kernel: unknown, args: { msg: any }) => void> = [];
  let msgCounter = 0;

  return {
    anyMessage: {
      connect(handler: (kernel: unknown, args: { msg: any }) => void) {
        listeners.push(handler);
      },
      disconnect(handler: (kernel: unknown, args: { msg: any }) => void) {
        const idx = listeners.indexOf(handler);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    },
    requestExecute(_content: unknown) {
      const msgId = `msg-${++msgCounter}`;
      let resolveDone: (value: unknown) => void;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      return {
        msg: { header: { msg_id: msgId } },
        done,
        // Test helper: feed a scripted sequence of iopub messages, then settle `done`.
        async __run(messages: Array<{ channel?: string; header: any; content: any; parent_header?: any }>, replyStatus = "ok") {
          for (const message of messages) {
            const full = {
              channel: message.channel || "iopub",
              header: message.header,
              parent_header: message.parent_header ?? { msg_id: msgId },
              content: message.content,
            };
            for (const listener of listeners.slice()) listener(undefined, { msg: full });
          }
          resolveDone({ content: { status: replyStatus } });
        },
      };
    },
  };
}

describe("executeOnKernel (fake kernel)", () => {
  function setup() {
    const kernel = makeFakeKernel();
    const originalRequestExecute = kernel.requestExecute.bind(kernel);
    let capturedFuture: ReturnType<typeof originalRequestExecute> | null = null;
    kernel.requestExecute = (content: unknown) => {
      capturedFuture = originalRequestExecute(content);
      return capturedFuture;
    };
    return { kernel, getFuture: () => capturedFuture! };
  }

  test("merges consecutive stdout stream outputs", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code");
    await (getFuture() as any).__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "a" } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "b" } },
    ]);
    const result = await resultPromise;
    expect(result.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "ab" }]);
    expect(result.status).toBe("ok");
  });

  test("update_display_data replaces the prior display in place", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code");
    await (getFuture() as any).__run([
      {
        header: { msg_type: "display_data" },
        content: { data: { "text/plain": "v1" }, transient: { display_id: "d1" } },
      },
      {
        header: { msg_type: "update_display_data" },
        content: { data: { "text/plain": "v2" }, transient: { display_id: "d1" } },
      },
    ]);
    const result = await resultPromise;
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ output_type: "display_data", data: { "text/plain": "v2" } });
  });

  test("clear_output(wait=true) defers clearing until the next output arrives", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code");
    await (getFuture() as any).__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "old" } },
      { header: { msg_type: "clear_output" }, content: { wait: true } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "new" } },
    ]);
    const result = await resultPromise;
    expect(result.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "new" }]);
  });

  test("captures error outputs with traceback", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code");
    await (getFuture() as any).__run(
      [
        {
          header: { msg_type: "error" },
          content: { ename: "ValueError", evalue: "bad", traceback: ["line1", "line2"] },
        },
      ],
      "error",
    );
    const result = await resultPromise;
    expect(result.status).toBe("error");
    expect(result.outputs[0]).toMatchObject({ output_type: "error", ename: "ValueError", evalue: "bad" });
  });

  test("routes Output-widget-scoped outputs into widgetOutputs instead of top-level outputs", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code");
    const future = getFuture() as any;
    const msgId = future.msg.header.msg_id;
    // Models a synchronous `out = Output(); with out: print(...)` inside the
    // currently-executing cell: the Output widget's comm_open state carries
    // *this* execution's own msg_id, so outputs sharing that parent_header
    // (the default from __run when no override is given) get scoped into the
    // widget instead of the top-level cell outputs — this is the initial
    // synchronous output ipywidgets' `interact` needs to seed the widget with
    // before the browser's live widget connection exists (the Phase 4 fix).
    await future.__run([
      {
        header: { msg_type: "comm_open" },
        content: {
          comm_id: "output-comm-1",
          target_name: "jupyter.widget",
          data: { state: { _model_name: "OutputModel", _model_module: "@jupyter-widgets/output", msg_id: msgId } },
        },
      },
      {
        header: { msg_type: "stream" },
        content: { name: "stdout", text: "inside widget" },
      },
    ]);
    const result = await resultPromise;
    expect(result.outputs).toEqual([]);
    expect(result.widgetOutputs?.["output-comm-1"]).toEqual([
      { output_type: "stream", name: "stdout", text: "inside widget" },
    ]);
  });

  test("captures widget comm_open/comm_msg into widgetMessages", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code");
    const future = getFuture() as any;
    await future.__run([
      {
        header: { msg_type: "comm_open" },
        content: {
          comm_id: "slider-1",
          target_name: "jupyter.widget",
          data: { state: { _model_name: "IntSliderModel", _model_module: "@jupyter-widgets/controls" } },
        },
      },
      {
        header: { msg_type: "comm_msg" },
        content: { comm_id: "slider-1", data: { method: "update", state: { value: 5 } } },
      },
    ]);
    const result = await resultPromise;
    expect(result.widgetMessages).toHaveLength(2);
    expect(result.widgetMessages?.[1]).toMatchObject({ content: { comm_id: "slider-1" } });
  });

  test("stream byte cap truncates and appends a truncation marker", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code", { streamLimit: 10 });
    const future = getFuture() as any;
    await future.__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "0123456789ABCDEF" } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "more" } },
    ]);
    const result = await resultPromise;
    const last = result.outputs[result.outputs.length - 1];
    expect(last.name).toBe("stderr");
    expect(String(last.text)).toContain("truncated");
  });
});
