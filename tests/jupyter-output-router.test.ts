import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createOutputWidgetRouter } from "../server/lib/jupyter-output-router.mjs";

type Msg = {
  header: { msg_type: string };
  parent_header?: { msg_id?: string };
  content: Record<string, unknown>;
};

const commOpen = (commId: string, state: Record<string, unknown>): Msg => ({
  header: { msg_type: "comm_open" },
  content: { comm_id: commId, data: { state } },
});

const commUpdate = (commId: string, state: Record<string, unknown>): Msg => ({
  header: { msg_type: "comm_msg" },
  content: { comm_id: commId, data: { method: "update", state } },
});

const displayData = (parent: string, data: Record<string, unknown>): Msg => ({
  header: { msg_type: "display_data" },
  parent_header: { msg_id: parent },
  content: { data },
});

// Feed a message through the router exactly like the cell service does: track
// comm bookkeeping first, then, for output messages, route to a widget or the
// top level.
function feedOutput(router: ReturnType<typeof createOutputWidgetRouter>, msg: Msg, topLevel: unknown[]): void {
  router.track(msg);
  const parentId = msg.parent_header?.msg_id;
  const output = { output_type: msg.header.msg_type, ...msg.content };
  const commId = router.targetCommFor(parentId);
  if (commId) router.pushOutput(commId, output);
  else topLevel.push(output);
}

describe("output-widget router", () => {
  test("routes display output inside an active Output-widget context, not the top level", () => {
    const router = createOutputWidgetRouter();
    const topLevel: unknown[] = [];

    // @interact builds an Output widget, then (inside its context) renders.
    router.track(commOpen("out1", { _model_name: "OutputModel", _model_module: "@jupyter-widgets/output" }));
    router.track(commUpdate("out1", { msg_id: "exec1" }));
    feedOutput(router, displayData("exec1", { "image/png": "AAAA" }), topLevel);
    feedOutput(router, displayData("exec1", { "image/png": "BBBB" }), topLevel);
    router.track(commUpdate("out1", { msg_id: "" }));

    // Both images belong to the widget; nothing leaked to the cell top level.
    expect(topLevel).toHaveLength(0);
    expect(router.hasOutputs()).toBe(true);
    expect(router.widgetOutputs.out1).toHaveLength(2);
    expect((router.widgetOutputs.out1[0] as unknown as { data: Record<string, unknown> }).data["image/png"]).toBe("AAAA");
  });

  test("output after the context closes returns to the top level", () => {
    const router = createOutputWidgetRouter();
    const topLevel: unknown[] = [];
    router.track(commOpen("out1", { _model_name: "OutputModel" }));
    router.track(commUpdate("out1", { msg_id: "exec1" }));
    feedOutput(router, displayData("exec1", { "text/plain": "in" }), topLevel);
    router.track(commUpdate("out1", { msg_id: "" }));
    feedOutput(router, displayData("exec1", { "text/plain": "out" }), topLevel);

    expect(topLevel).toHaveLength(1);
    expect(router.widgetOutputs.out1).toHaveLength(1);
  });

  test("streams concatenate within a widget group and clear_output(wait) defers", () => {
    const router = createOutputWidgetRouter();
    router.track(commOpen("out1", { _model_name: "OutputModel" }));
    router.track(commUpdate("out1", { msg_id: "exec1" }));
    router.pushOutput("out1", { output_type: "stream", name: "stdout", text: "a" });
    router.pushOutput("out1", { output_type: "stream", name: "stdout", text: "b" });
    expect(router.widgetOutputs.out1).toHaveLength(1);
    expect((router.widgetOutputs.out1[0] as unknown as { text: string }).text).toBe("ab");

    // Deferred clear takes effect on the next appended output.
    router.clearOutput("out1", true);
    expect(router.widgetOutputs.out1).toHaveLength(1);
    router.pushOutput("out1", { output_type: "stream", name: "stdout", text: "c" });
    expect(router.widgetOutputs.out1).toHaveLength(1);
    expect((router.widgetOutputs.out1[0] as unknown as { text: string }).text).toBe("c");
  });

  test("ignores non-Output comms", () => {
    const router = createOutputWidgetRouter();
    const topLevel: unknown[] = [];
    router.track(commOpen("slider1", { _model_name: "FloatSliderModel", _model_module: "@jupyter-widgets/controls" }));
    router.track(commUpdate("slider1", { msg_id: "exec1" }));
    feedOutput(router, displayData("exec1", { "image/png": "AAAA" }), topLevel);
    // A slider comm never captures output — the display stays at the top level.
    expect(topLevel).toHaveLength(1);
    expect(router.hasOutputs()).toBe(false);
  });
});
