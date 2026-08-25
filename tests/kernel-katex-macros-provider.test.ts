import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Server ESM module lives outside the renderer TS graph.
import { createKernelKatexMacrosProvider } from "../server/lib/kernel-katex-macros-provider.mjs";

describe("desktop kernel KaTeX macros provider", () => {
  test("loads the Go endpoint without parsing files in Node", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { dir: "/macros", macros: { "\\R": "\\mathbb{R}" }, errors: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = createKernelKatexMacrosProvider({ baseUrl: "http://127.0.0.1:43127/", fetchImpl });
    await expect(provider.load("/macros")).resolves.toEqual({
      dir: "/macros", macros: { "\\R": "\\mathbb{R}" }, errors: [],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:43127/api/noema/config/katexMacros",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ dir: "/macros" }) }),
    );
  });

  test("surfaces kernel failures for the runtime fallback boundary", async () => {
    const provider = createKernelKatexMacrosProvider({
      baseUrl: "http://127.0.0.1:43127",
      fetchImpl: async () => new Response(JSON.stringify({ code: -1, msg: "macro read failed" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    });
    await expect(provider.load("/macros")).rejects.toThrow("macro read failed");
  });
});
