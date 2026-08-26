import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

// @ts-ignore Node ESM modules live outside the TS application graph.
import { createKernelBibliographyProvider } from "../server/lib/kernel-bibliography-provider.mjs";
// @ts-ignore Node ESM modules live outside the TS application graph.
import { bibliographyForDocument, configureBibliography, configureBibliographyProvider } from "../server/lib/bibliography.mjs";

function response(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() { return payload; },
  } as Response;
}

afterEach(() => configureBibliographyProvider(null));

describe("kernel bibliography provider", () => {
  test("maps an in-box note to the bounded Go library endpoint", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createKernelBibliographyProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async (url: string, options: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(options.body)) });
        return response({ code: 0, data: { files: [], diagnostics: [], source: "kernel-bibliography" } });
      },
    });

    expect(provider.owns("/notes/project/note.md")).toBe(true);
    expect(provider.owns("/outside/note.md")).toBe(false);
    await expect(provider.load({ file: "/notes/project/note.md", metadataContent: "#+begin meta\n#+end meta" }))
      .resolves.toMatchObject({ source: "kernel-bibliography" });
    expect(calls).toEqual([{
      url: "http://127.0.0.1:43127/api/noema/markdown/loadBibliography",
      body: {
        notebook: "box-1",
        path: "/project/note.md",
        metadata: "#+begin meta\n#+end meta",
      },
    }]);
  });

  test("fails closed on malformed kernel responses", async () => {
    const provider = createKernelBibliographyProvider({
      baseUrl: "http://127.0.0.1:43127",
      box: { id: "box-1", root: "/notes" },
      fetchImpl: async () => response({ code: 0, data: { files: null } }),
    });
    await expect(provider.load({ file: "/notes/note.md", metadataContent: "" }))
      .rejects.toThrow(/invalid shape/i);
  });

  test("feeds the existing citation resolver without moving source-offset semantics into Go", async () => {
    configureBibliography({ root: "/notes" });
    configureBibliographyProvider({
      owns: () => true,
      async load() {
        return {
          source: "kernel-bibliography",
          diagnostics: [],
          files: [{
            file: "/notes/bib/refs.bib",
            path: "bib/refs.bib",
            namespace: "bib/refs",
            shortNamespace: "refs",
            diagnostics: [],
            entries: [{
              type: "book",
              key: "Ada",
              fields: { author: "Lovelace, Ada", title: "Notes", year: "1843" },
              namespace: "bib/refs",
              shortNamespace: "refs",
              file: "/notes/bib/refs.bib",
              path: "bib/refs.bib",
              id: "bib-ada",
            }],
          }],
        };
      },
    });
    const content = "See @@cite(refs) [Ada].";
    const result = await bibliographyForDocument({ file: "/notes/note.md", content });
    expect(result).toMatchObject({
      source: "kernel-bibliography",
      citations: [{ from: 4, namespace: "refs", keys: ["Ada"], numbers: [1], diagnostics: [] }],
      references: [{ id: "bib-ada", number: 1 }],
    });
  });
});
