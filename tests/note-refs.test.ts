import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { resolveNoteReference } from "../shared/note-refs.mjs";

const notes = [
  { id: "n-reset", title: "Reset procedure", path: "ops/reset.md", file: "/vault/ops/reset.md", tags: ["set", "physics"] },
  { id: "n-set", title: "Set", path: "math/set.md", file: "/vault/math/set.md", aliases: ["Sets"] },
  { id: "n-data", title: "Datasets", path: "ml/data.md", file: "/vault/ml/data.md", tags: ["src"] },
  { id: "n-page", title: "Topic page", path: "topic/page.md", file: "/vault/topic/page.md" },
  { id: "n-other", title: "Other page", path: "other/page.md", file: "/vault/other/page.md" },
];
const resolve = (ref: string) => resolveNoteReference(notes, ref)?.id;

describe("note references", () => {
  test("resolve by identity", () => {
    expect(resolve("n-set")).toBe("n-set");
    expect(resolve("Set")).toBe("n-set");
    expect(resolve("sets")).toBe("n-set");
    expect(resolve("roam://n-data#section")).toBe("n-data");
    expect(resolve("math/set.md")).toBe("n-set");
    expect(resolve("/vault/ops/reset.md")).toBe("n-reset");
    expect(resolve("Topic%20page")).toBe("n-page");
  });

  test("resolve by location on whole path segments", () => {
    expect(resolve("reset")).toBe("n-reset");
    expect(resolve("ops/reset")).toBe("n-reset");
    expect(resolve("./ml/data.md")).toBe("n-data");
    expect(resolve("other/page")).toBe("n-other");
    expect(resolve("topic/page.md")).toBe("n-page");
    // An ambiguous name keeps the first note, as the index order defines.
    expect(resolve("page")).toBe("n-page");
  });

  test("never resolve by substring or by tag", () => {
    // "set" used to open the first note whose path merely contained it.
    expect(resolve("et")).toBeUndefined();
    expect(resolve("rese")).toBeUndefined();
    expect(resolve("a.md")).toBeUndefined();
    expect(resolve("procedure")).toBeUndefined();
    // A tag describes a note; it is not a name for it.
    expect(resolve("physics")).toBeUndefined();
    expect(resolve("src")).toBeUndefined();
    expect(resolve("")).toBeUndefined();
  });

  test("an updated note list is resolved afresh", () => {
    const first = [{ id: "a", title: "Alpha", path: "alpha.md" }];
    expect(resolveNoteReference(first, "Beta")).toBeUndefined();
    const second = [...first, { id: "b", title: "Beta", path: "beta.md" }];
    expect(resolveNoteReference(second, "Beta")?.id).toBe("b");
    expect(resolveNoteReference(first, "Beta")).toBeUndefined();
  });
});
