import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { diskVersionChangedAfterSave } from "../pages/external-save.ts";

describe("external save version gate", () => {
  test("waits for the pane's own save response before classifying a watcher event", async () => {
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    let saving = true;
    let version = "before";
    const check = diskVersionChangedAfterSave(
      "note.md",
      () => ({ file: "note.md", version }),
      () => saving ? writing : Promise.resolve(),
      async () => "after",
    );
    version = "after";
    saving = false;
    finish();
    expect(await check).toBe(false);
  });

  test("reports an actual external version and ignores a file switch", async () => {
    let file = "note.md";
    const current = () => ({ file, version: "ours" });
    const idle = async () => {};
    expect(await diskVersionChangedAfterSave("note.md", current, idle, async () => "theirs")).toBe(true);
    file = "other.md";
    expect(await diskVersionChangedAfterSave("note.md", current, idle, async () => "theirs")).toBe(false);
  });

  test("rereads when another local save completes during disk verification", async () => {
    let version = "first";
    let reads = 0;
    const changed = await diskVersionChangedAfterSave(
      "note.md",
      () => ({ file: "note.md", version }),
      async () => {},
      async () => {
        reads += 1;
        if (reads === 1) {
          version = "second";
          return "first";
        }
        return "second";
      },
    );
    expect(changed).toBe(false);
    expect(reads).toBe(2);
  });
});
