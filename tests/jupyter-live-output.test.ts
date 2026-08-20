import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { executeOnKernel } from "../server/jupyter/execution-message-handler.mjs";
import { applyCeilLiveEvent } from "../src/cm6/extensions/visual/widgets/block-extras.ts";

// The contract between the server's live patch stream and the client that
// paints it. These two implementations are in different languages of the same
// codebase and can silently drift, so the test drives the *real* client
// reducer with the *real* server events and asserts they converge on the
// outputs the execute response carries.

function fakeKernel() {
  const listeners: Array<(kernel: unknown, args: { msg: any }) => void> = [];
  return {
    anyMessage: {
      connect(handler: any) { listeners.push(handler); },
      disconnect(handler: any) {
        const idx = listeners.indexOf(handler);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    },
    requestExecute() {
      const msgId = "msg-1";
      let resolveDone: (value: unknown) => void;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      return {
        msg: { header: { msg_id: msgId } },
        done,
        async __run(messages: any[]) {
          for (const message of messages) {
            for (const listener of listeners.slice()) {
              listener(undefined, {
                msg: {
                  channel: "iopub",
                  parent_header: { msg_id: msgId },
                  header: message.header,
                  content: message.content,
                },
              });
            }
          }
          resolveDone!({ content: { status: "ok" } });
        },
      };
    },
  } as any;
}

async function runAndReplay(messages: any[]) {
  const kernel = fakeKernel();
  let future: any = null;
  const original = kernel.requestExecute.bind(kernel);
  kernel.requestExecute = (content: unknown) => (future = original(content));
  const events: any[] = [];
  const promise = executeOnKernel(kernel, "code", { onEvent: (event: any) => events.push(event) });
  await future.__run(messages);
  const result = await promise;
  let painted: Array<Record<string, unknown>> = [];
  for (const event of events) painted = applyCeilLiveEvent(painted, event);
  return { painted, result };
}

describe("live output patches converge on the execute response", () => {
  test("interleaved streams, displays, and an error", async () => {
    const { painted, result } = await runAndReplay([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "step 1\n" } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "step 2\n" } },
      { header: { msg_type: "stream" }, content: { name: "stderr", text: "warn\n" } },
      { header: { msg_type: "display_data" }, content: { data: { "text/plain": "v1" }, transient: { display_id: "d" } } },
      { header: { msg_type: "update_display_data" }, content: { data: { "text/plain": "v2" }, transient: { display_id: "d" } } },
      { header: { msg_type: "execute_result" }, content: { execution_count: 3, data: { "text/plain": "9" } } },
      { header: { msg_type: "error" }, content: { ename: "ValueError", evalue: "boom", traceback: ["tb"] } },
    ]);
    expect(painted).toEqual(result.outputs);
  });

  test("clear_output mid-run drops what was already painted", async () => {
    const { painted, result } = await runAndReplay([
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "old" } },
      { header: { msg_type: "clear_output" }, content: { wait: false } },
      { header: { msg_type: "stream" }, content: { name: "stdout", text: "new" } },
    ]);
    expect(painted).toEqual(result.outputs);
    expect(painted).toEqual([{ output_type: "stream", name: "stdout", text: "new" }]);
  });

  test("a tqdm-style progress bar (clear_output wait, then redraw) converges", async () => {
    const messages: any[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ header: { msg_type: "clear_output" }, content: { wait: true } });
      messages.push({ header: { msg_type: "stream" }, content: { name: "stderr", text: `${i * 20}%` } });
    }
    const { painted, result } = await runAndReplay(messages);
    expect(painted).toEqual(result.outputs);
    expect(painted).toEqual([{ output_type: "stream", name: "stderr", text: "80%" }]);
  });
});
