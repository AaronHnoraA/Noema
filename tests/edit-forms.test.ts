import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { largeChange, resolveEdits } from "../server/lib/edit-forms.mjs";

const at = (_source: string, value: any) => value as number;
const apply = (source: string, edits: any[]) => {
  let out = source;
  for (const edit of resolveEdits(source, edits, at).sort((a, b) => b.from - a.from))
    out = out.slice(0, edit.from) + edit.newText + out.slice(edit.to);
  return out;
};

describe("C74 edit forms", () => {
  const doc = "# T\n\nalpha line\nbeta line\ngamma line\n";
  test("C74 replace by unique text, as an agent's own Edit tool does", () => {
    expect(apply(doc, [{ oldText: "beta", newText: "BETA" }])).toBe("# T\n\nalpha line\nBETA line\ngamma line\n");
    expect(() => apply(doc, [{ oldText: "line", newText: "x" }])).toThrow("more than once");
    expect(() => apply(doc, [{ oldText: "delta", newText: "x" }])).toThrow("not in the current text");
  });
  test("C74 lines, after, before and append", () => {
    expect(apply(doc, [{ lines: [3, 4], newText: "one\ntwo" }])).toBe("# T\n\none\ntwo\ngamma line\n");
    expect(apply(doc, [{ after: "beta", newText: "inserted" }])).toBe("# T\n\nalpha line\nbeta line\ninserted\ngamma line\n");
    expect(apply(doc, [{ before: "# T", newText: "front" }])).toBe("front\n# T\n\nalpha line\nbeta line\ngamma line\n");
    expect(apply(doc, [{ append: "end\n" }])).toBe(doc + "end\n");
    expect(apply("no newline", [{ append: "end" }])).toBe("no newline\nend");
    expect(() => apply(doc, [{ lines: [3, 3], oldText: "wrong", newText: "x" }])).toThrow("differs");
  });
  test("C74 stale positions fall back to the text they name", () => {
    const moved = "A new first line\n" + doc;
    const from = doc.indexOf("beta");
    expect(apply(moved, [{ from, to: from + 4, oldText: "beta", newText: "BETA" }])).toContain("BETA line");
  });
  test("C74 a change too large is the person's to see", () => {
    const big = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    expect(largeChange(big, big.toUpperCase(), 100)).toBe(true);
    expect(largeChange(big, big, 5)).toBe(false);
    expect(largeChange("a\nb", "c\nd", 2)).toBe(false);
  });
});

describe("C74 the edit API", () => {
  async function fixture(texts: string[], saves: any[], emacs?: (body: any) => any) {
    const { ApiRouter } = await import("../server/infrastructure/api-router.mjs");
    const { createAgentApiHandlers } = await import("../server/Features/Agent/api.mjs");
    const { createEmacsApiHandlers } = await import("../server/Features/Emacs/api.mjs");
    const people: any[] = [];
    let opens = 0;
    const router = new ApiRouter().register(createEmacsApiHandlers({ apiFile: emacs ?? (() => ({ ok: false })) } as any));
    const call = async (channel: string, args: any[] = []): Promise<any> => {
      if (channel === "noema:api:notes:open") { const content = texts[Math.min(opens, texts.length - 1)]; opens++; return { ok: true, file: args[0], content, version: `v${opens}` }; }
      if (channel === "noema:api:notes:save") { const reply = saves.shift() ?? { ok: true }; reply.sent = args[0]; return reply; }
      return router.call(channel, args);
    };
    router.register(createAgentApiHandlers({ router, call, onNeedsPerson: (p: any) => people.push(p) }));
    return { call, people };
  }

  test("C74 an edit naming its text lands on the newest version after a lost save race", async () => {
    const first = "# T\n\nalpha\nbeta\n";
    const typed = "# T\n\nThe person typed this.\nalpha\nbeta\n";
    const saves: any[] = [{ ok: false, conflict: true }, { ok: true }];
    const { call } = await fixture([first, typed], saves);
    const conflict = saves[0], ok = saves[1];
    const reply = await call("noema:api:agent:document:edit", [{ file: "/n/a.md", edits: [{ oldText: "beta", newText: "BETA" }] }]);
    expect(reply).toMatchObject({ ok: true });
    expect(conflict.sent.content).toBe("# T\n\nalpha\nBETA\n");
    expect(ok.sent).toMatchObject({ content: "# T\n\nThe person typed this.\nalpha\nBETA\n", baseVersion: "v2" });
  });

  test("C74 a change rewriting most of a note goes to the person", async () => {
    const big = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const saves: any[] = [];
    const { call, people } = await fixture([big], saves);
    const reply = await call("noema:api:agent:document:edit", [{ file: "/n/a.md", authorSession: "tok", content: big.toUpperCase() }]);
    expect(reply).toMatchObject({ ok: false, needsPerson: true });
    expect(people).toEqual([{ file: "/n/a.md", session: "tok", reason: "This edit rewrites most of a.md." }]);
    expect(saves).toHaveLength(0);
    expect(await call("noema:api:agent:document:edit", [{ file: "/n/a.md", content: big.toUpperCase(), allowLarge: true }])).toMatchObject({ ok: true });
  });

  test("C74 another text file changes through Emacs, in characters", async () => {
    const asked: any[] = [];
    let text = "x = '😀'\ny = 2\n";
    const emacs = (body: any) => {
      asked.push(body);
      if (body.action === "read") return { ok: true, content: text, version: "h1" };
      return { ok: true, applied: body.edits.length };
    };
    const { call } = await fixture(["unused"], [], emacs);
    const reply = await call("noema:api:agent:file:edit", [{ file: "/src/main.py", edits: [{ oldText: "y = 2", newText: "y = 3" }] }]);
    expect(reply).toMatchObject({ ok: true });
    const apply = asked.find((body) => body.action === "apply");
    // "x = '😀'\n" is 8 characters but 9 UTF-16 units.
    expect(apply).toMatchObject({ file: "/src/main.py", version: "h1", edits: [{ from: 8, to: 13, oldText: "y = 2", newText: "y = 3" }] });
  });
});
