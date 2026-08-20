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
      const self: any = {
        msg: { header: { msg_id: msgId } },
        done,
        onStdin: undefined as undefined | ((msg: any) => void),
        inputReplies: [] as Array<{ content: any; parentHeader: any }>,
        sendInputReply(content: any, parentHeader: any) {
          self.inputReplies.push({ content, parentHeader });
        },
        /** Test helper: pretend the kernel blocked on input(). */
        askForInput(prompt = "? ", password = false) {
          self.onStdin?.({
            header: { msg_type: "input_request", msg_id: "stdin-1" },
            content: { prompt, password },
          });
        },
        // Test helper: feed a scripted sequence of iopub messages, then settle `done`.
        async __run(
          messages: Array<{ channel?: string; header: any; content: any; parent_header?: any }>,
          replyStatus = "ok",
          replyPayload?: any[],
        ) {
          for (const message of messages) {
            const full = {
              channel: message.channel || "iopub",
              header: message.header,
              parent_header: message.parent_header ?? { msg_id: msgId },
              content: message.content,
            };
            for (const listener of listeners.slice()) listener(undefined, { msg: full });
          }
          resolveDone({ content: { status: replyStatus, ...(replyPayload ? { payload: replyPayload } : {}) } });
        },
      };
      return self;
    },
  };
}

describe("executeOnKernel (fake kernel)", () => {
  function setup() {
    const kernel = makeFakeKernel();
    const originalRequestExecute = kernel.requestExecute.bind(kernel);
    let capturedFuture: ReturnType<typeof originalRequestExecute> | null = null;
    let capturedContent: any = null;
    kernel.requestExecute = (content: unknown) => {
      capturedContent = content;
      capturedFuture = originalRequestExecute(content);
      return capturedFuture;
    };
    return { kernel, getFuture: () => capturedFuture!, getContent: () => capturedContent };
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
  // --- execute_reply payloads -------------------------------------------
  // Deprecated in the spec, still emitted by every IPython release, and the
  // only transport for the pager, %load, and `exit`.

  test("a page payload becomes a display_data output", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "?len");
    await (getFuture() as any).__run(
      [{ header: { msg_type: "stream" }, content: { name: "stdout", text: "before" } }],
      "ok",
      [{ source: "page", data: { "text/plain": "Help on len" }, start: 0 }],
    );
    const result = await resultPromise;
    expect(result.outputs).toEqual([
      { output_type: "stream", name: "stdout", text: "before" },
      { output_type: "display_data", data: { "text/plain": "Help on len" }, metadata: {} },
    ]);
  });

  test("set_next_input is reported so %load can rewrite the cell", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "%load foo.py");
    await (getFuture() as any).__run([], "ok", [
      { source: "set_next_input", text: "print('loaded')", replace: true },
    ]);
    const result = await resultPromise;
    expect(result.setNextInput).toEqual({ text: "print('loaded')", replace: true });
    expect(result.askExit).toBeUndefined();
  });

  test("ask_exit is reported with its keepkernel flag", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "exit");
    await (getFuture() as any).__run([], "ok", [{ source: "ask_exit", keepkernel: false }]);
    const result = await resultPromise;
    expect(result.askExit).toEqual({ keepKernel: false });
  });

  test("stopOnError is off by default and forwarded when set", async () => {
    const permissive = setup();
    const permissivePromise = executeOnKernel(permissive.kernel as any, "code");
    await (permissive.getFuture() as any).__run([]);
    await permissivePromise;
    expect(permissive.getContent().stop_on_error).toBe(false);

    const strict = setup();
    const strictPromise = executeOnKernel(strict.kernel as any, "code", { stopOnError: true });
    await (strict.getFuture() as any).__run([]);
    await strictPromise;
    expect(strict.getContent().stop_on_error).toBe(true);
  });
  // --- live output events -----------------------------------------------
  // The resolved outputs array stays authoritative; these patches only make a
  // long-running cell show progress. So the invariant that matters is that
  // replaying them reproduces the final array exactly.

  function replay(events: any[]): Array<Record<string, unknown>> {
    let outputs: Array<Record<string, unknown>> = [];
    for (const event of events) {
      if (event.kind === "clear") outputs = [];
      else if (event.kind === "set") {
        outputs = outputs.slice();
        outputs[event.index] = event.output;
      } else if (event.kind === "append") {
        outputs = outputs.slice();
        const target = outputs[event.index];
        if (target) outputs[event.index] = { ...target, text: String(target.text ?? "") + event.text };
      }
    }
    return outputs;
  }

  test("replaying the emitted events reproduces the final outputs", async () => {
    const { kernel, getFuture } = setup();
    const events: any[] = [];
    const resultPromise = executeOnKernel(kernel as any, "code", { onEvent: (e: any) => events.push(e) });
    await (getFuture() as any).__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "one " } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "two" } },
      { header: { msg_type: "display_data" }, content: { data: { "text/plain": "fig" }, transient: { display_id: "d" } } },
      { header: { msg_type: "update_display_data" }, content: { data: { "text/plain": "fig2" }, transient: { display_id: "d" } } },
      { header: { msg_type: "error" }, content: { ename: "E", evalue: "v", traceback: ["t"] } },
    ]);
    const result = await resultPromise;
    expect(replay(events)).toEqual(result.outputs);
  });

  test("a merged stream emits an append, not a re-sent snapshot", async () => {
    const { kernel, getFuture } = setup();
    const events: any[] = [];
    const resultPromise = executeOnKernel(kernel as any, "code", { onEvent: (e: any) => events.push(e) });
    await (getFuture() as any).__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "a" } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "b" } },
    ]);
    await resultPromise;
    const outputEvents = events.filter((e) => e.kind === "set" || e.kind === "append");
    expect(outputEvents).toEqual([
      // The "set" is a snapshot taken before the merge, so replaying
      // set-then-append yields "ab" exactly once.
      { kind: "set", index: 0, output: { output_type: "stream", name: "stdout", text: "a" } },
      { kind: "append", index: 0, text: "b" },
    ]);
  });

  test("kernel busy/idle status is emitted", async () => {
    const { kernel, getFuture } = setup();
    const events: any[] = [];
    const resultPromise = executeOnKernel(kernel as any, "code", { onEvent: (e: any) => events.push(e) });
    await (getFuture() as any).__run([
      { header: { msg_type: "status" }, content: { execution_state: "busy" } },
      { header: { msg_type: "execute_input" }, content: { code: "code", execution_count: 7 } },
      { header: { msg_type: "status" }, content: { execution_state: "idle" } },
    ]);
    await resultPromise;
    expect(events.filter((e) => e.kind === "status").map((e) => e.state)).toEqual(["busy", "idle"]);
    expect(events.find((e) => e.kind === "executionCount")).toEqual({ kind: "executionCount", value: 7 });
  });

  test("clear_output emits a clear so the client drops what it painted", async () => {
    const { kernel, getFuture } = setup();
    const events: any[] = [];
    const resultPromise = executeOnKernel(kernel as any, "code", { onEvent: (e: any) => events.push(e) });
    await (getFuture() as any).__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "gone" } },
      { header: { msg_type: "clear_output" }, content: { wait: false } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "kept" } },
    ]);
    const result = await resultPromise;
    expect(events.some((e) => e.kind === "clear")).toBe(true);
    expect(replay(events)).toEqual(result.outputs);
  });

  test("a throwing consumer cannot break the execution", async () => {
    const { kernel, getFuture } = setup();
    const resultPromise = executeOnKernel(kernel as any, "code", {
      onEvent: () => { throw new Error("bad consumer"); },
    });
    await (getFuture() as any).__run([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "still here" } },
    ]);
    const result = await resultPromise;
    expect(result.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "still here" }]);
  });
  // --- stdin ------------------------------------------------------------

  test("allow_stdin is off unless a handler can answer", async () => {
    const quiet = setup();
    const quietPromise = executeOnKernel(quiet.kernel as any, "code");
    await (quiet.getFuture() as any).__run([]);
    await quietPromise;
    expect(quiet.getContent().allow_stdin).toBe(false);

    const loud = setup();
    const loudPromise = executeOnKernel(loud.kernel as any, "code", { onStdin: async () => "x" });
    await (loud.getFuture() as any).__run([]);
    await loudPromise;
    expect(loud.getContent().allow_stdin).toBe(true);
  });

  test("an answered input_request replies with the value and the request header", async () => {
    const { kernel, getFuture } = setup();
    const seen: any[] = [];
    const promise = executeOnKernel(kernel as any, "input('name: ')", {
      onStdin: async (request: any) => { seen.push(request); return "Ada"; },
    });
    const future = getFuture() as any;
    future.askForInput("name: ", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([{ prompt: "name: ", password: false }]);
    expect(future.inputReplies).toEqual([
      { content: { status: "ok", value: "Ada" }, parentHeader: { msg_type: "input_request", msg_id: "stdin-1" } },
    ]);
    await future.__run([]);
    await promise;
  });

  test("a rejected prompt answers EOF so the kernel is never left blocked", async () => {
    const { kernel, getFuture } = setup();
    const promise = executeOnKernel(kernel as any, "input()", {
      onStdin: async () => { throw new Error("cancelled"); },
    });
    const future = getFuture() as any;
    future.askForInput();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // U+0004 is what jupyter_client turns into EOFError.
    expect(future.inputReplies[0].content).toEqual({ status: "ok", value: "\u0004" });
    await future.__run([]);
    await promise;
  });

  test("the execution timeout is paused while a prompt is outstanding", async () => {
    const { kernel, getFuture } = setup();
    let release: (value: string) => void = () => {};
    const promise = executeOnKernel(kernel as any, "input()", {
      execTimeoutMs: 40,
      onStdin: () => new Promise<string>((resolve) => { release = resolve; }),
    });
    const future = getFuture() as any;
    future.askForInput();
    // Well past execTimeoutMs: a cell waiting on a human is not a hung cell.
    await new Promise((resolve) => setTimeout(resolve, 120));
    release("answered");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await future.__run([{ header: { msg_type: "stream" }, content: { name: "stdout", text: "ok" } }]);
    const result = await promise;
    expect(result.status).toBe("ok");
    expect(result.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "ok" }]);
  });
});
