import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  commInfoOnKernel,
  completeOnKernel,
  historyOnKernel,
  inspectOnKernel,
  isCompleteOnKernel,
} from "../server/jupyter/kernel-requests.mjs";

// Shell-channel introspection against a scripted fake kernel. The behaviours
// that matter here are the ones a real kernel makes easy to get wrong: the
// completion span comes from the kernel (not a client word boundary), the
// experimental type metadata is optional, an unimplemented request answers
// "unknown" rather than failing, and a busy kernel must time out rather than
// block the caller.

function kernelReplying(method: string, content: unknown) {
  return { [method]: async () => ({ content }) } as any;
}

function kernelHanging(method: string) {
  return { [method]: () => new Promise(() => {}) } as any;
}

describe("kernel introspection requests", () => {
  test("complete returns the kernel's replacement span, not a guessed one", async () => {
    const kernel = kernelReplying("requestComplete", {
      status: "ok",
      matches: ["df['count']", "df['country']"],
      cursor_start: 3,
      cursor_end: 9,
    });
    const result = await completeOnKernel(kernel, { code: "df['cou", cursorPos: 7 });
    expect(result.matches).toEqual(["df['count']", "df['country']"]);
    expect(result.cursorStart).toBe(3);
    expect(result.cursorEnd).toBe(9);
    expect(result.complete).toBe(true);
  });

  test("complete merges _jupyter_types_experimental metadata onto matches", async () => {
    const kernel = kernelReplying("requestComplete", {
      status: "ok",
      matches: ["append", "argsort"],
      cursor_start: 0,
      cursor_end: 2,
      metadata: {
        _jupyter_types_experimental: [
          { text: "append", type: "function", signature: "(obj, /)" },
        ],
      },
    });
    const result = await completeOnKernel(kernel, { code: "ap", cursorPos: 2 });
    expect(result.items).toEqual([
      { text: "append", type: "function", signature: "(obj, /)" },
      { text: "argsort", type: "", signature: "" },
    ]);
  });

  test("complete on an error reply yields no matches rather than throwing", async () => {
    const kernel = kernelReplying("requestComplete", { status: "error", ename: "Boom" });
    const result = await completeOnKernel(kernel, { code: "x", cursorPos: 1 });
    expect(result.matches).toEqual([]);
    expect(result.complete).toBe(false);
  });

  test("a busy kernel times out instead of blocking the caller", async () => {
    const result = await completeOnKernel(kernelHanging("requestComplete"), {
      code: "x",
      cursorPos: 1,
      timeoutMs: 20,
    });
    expect(result.timedOut).toBe(true);
    expect(result.matches).toEqual([]);
  });

  test("inspect surfaces the mime bundle", async () => {
    const kernel = kernelReplying("requestInspect", {
      status: "ok",
      found: true,
      data: { "text/plain": "Signature: len(obj, /)" },
      metadata: {},
    });
    const result = await inspectOnKernel(kernel, { code: "len", cursorPos: 3 });
    expect(result.found).toBe(true);
    expect(result.data["text/plain"]).toContain("len");
  });

  test("is_complete reports the continuation indent", async () => {
    const kernel = kernelReplying("requestIsComplete", { status: "incomplete", indent: "    " });
    const result = await isCompleteOnKernel(kernel, { code: "if True:" });
    expect(result).toMatchObject({ status: "incomplete", indent: "    " });
  });

  test("a kernel without is_complete degrades to unknown", async () => {
    const result = await isCompleteOnKernel({} as any, { code: "if True:" });
    expect(result).toEqual({ status: "unknown", indent: "" });
  });

  test("history flattens tail entries", async () => {
    const kernel = kernelReplying("requestHistory", {
      status: "ok",
      history: [[1, 1, "a = 1"], [1, 2, "print(a)"]],
    });
    const result = await historyOnKernel(kernel, { count: 2 });
    expect(result.history).toEqual([
      { session: 1, lineNumber: 1, source: "a = 1", output: "" },
      { session: 1, lineNumber: 2, source: "print(a)", output: "" },
    ]);
  });

  test("history keeps the paired output when output: true was requested", async () => {
    const kernel = kernelReplying("requestHistory", {
      status: "ok",
      history: [[1, 1, ["a = 1", "1"]]],
    });
    const result = await historyOnKernel(kernel, { count: 1, output: true });
    expect(result.history[0]).toEqual({ session: 1, lineNumber: 1, source: "a = 1", output: "1" });
  });

  test("comm_info returns the open comms", async () => {
    const kernel = kernelReplying("requestCommInfo", {
      status: "ok",
      comms: { "comm-1": { target_name: "jupyter.widget" } },
    });
    const result = await commInfoOnKernel(kernel, { targetName: "jupyter.widget" });
    expect(result.comms["comm-1"]).toEqual({ target_name: "jupyter.widget" });
  });
});
