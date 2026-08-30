import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Server ESM module lives outside the renderer TypeScript graph.
import { createKernelLatexProvider } from "../server/lib/kernel-latex-provider.mjs";

describe("shared-host kernel LaTeX provider", () => {
  test("routes prepare, metadata, and postprocess through Go", async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      const data = url.endsWith("preparePandoc")
        ? { meta: { title: "Noema" }, markdown: "prepared", warnings: [], features: { usesSideComment: false, usesTikz: true } }
        : url.endsWith("extractMetadata")
          ? { meta: { title: "Noema" } }
          : url.endsWith("planTemplate")
            ? { segments: ["A ", " B ", ""], placeholders: ["title", "body"] }
            : { latex: "postprocessed\n" };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const provider = createKernelLatexProvider({ baseUrl: "http://127.0.0.1:43127/", fetchImpl });
    await expect(provider.prepare("source", {
      rules: { hiddenBlocks: ["private"] },
      citationKeyMap: new Map([["refs\0Key", "refs:Key"]]),
    })).resolves.toEqual({
      meta: { title: "Noema" }, markdown: "prepared", warnings: [], features: { usesSideComment: false, usesTikz: true },
    });
    await expect(provider.metadata("source")).resolves.toEqual({ title: "Noema" });
    await expect(provider.postprocess("draft")).resolves.toBe("postprocessed\n");
    const plan = await provider.planTemplate("A {{title}} B {{body}}", ["title", "body", "title"]);
    expect(plan).toEqual({ segments: ["A ", " B ", ""], placeholders: ["title", "body"] });
    expect(provider.renderTemplate(plan, { title: "Noema", body: "Body" })).toBe("A Noema B Body");
    const firstInit = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(firstInit?.body || ""))).toEqual({
      markdown: "source",
      rules: { hiddenBlocks: ["private"] },
      citationKeyMap: { ["refs\0Key"]: "refs:Key" },
      disableAnnotations: false,
    });
  });

  test("surfaces kernel errors and rejects incomplete responses", async () => {
    const failed = createKernelLatexProvider({
      baseUrl: "http://127.0.0.1:43127",
      fetchImpl: async () => new Response(JSON.stringify({ code: -1, msg: "private block malformed" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    });
    await expect(failed.prepare("source")).rejects.toThrow("private block malformed");

    const incomplete = createKernelLatexProvider({
      baseUrl: "http://127.0.0.1:43127",
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    });
    await expect(incomplete.postprocess("draft")).rejects.toThrow("incomplete");
    expect(() => incomplete.renderTemplate({ segments: [], placeholders: [] }, {})).toThrow("Invalid");
  });
});
