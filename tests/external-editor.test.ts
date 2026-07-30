import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openInVSCode,
  taggedSourceLocation,
  vscodeOpenCommand,
} from "../server/lib/external-editor.mjs";

describe("standalone VS Code adapter", () => {
  test("opens an exact one-based VS Code location in a new window", () => {
    expect(vscodeOpenCommand({
      cli: "/opt/bin/code",
      file: "/tmp/example file.md",
      line: 7,
      col: 3,
    })).toEqual({
      command: "/opt/bin/code",
      args: ["--new-window", "--goto", "/tmp/example file.md:7:4"],
    });
  });

  test("resolves note-code tags before launching", async () => {
    const root = await mkdtemp(join(tmpdir(), "noema-editor-"));
    const file = join(root, "source.lean");
    await writeFile(file, "# prelude\n-- @aaronnote group-cancel\n#check Nat\n");
    expect(await taggedSourceLocation(file, "group-cancel")).toEqual({ line: 2, col: 0 });

    const calls: unknown[][] = [];
    const result = await openInVSCode({ file, tag: "group-cancel" }, {
      env: { NOEMA_VSCODE: "/bin/echo", PATH: "" },
      run: async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
    });
    expect(result).toMatchObject({ ok: true, editor: "vscode", newWindow: true, line: 2, col: 0 });
    expect(calls[0]?.[1]).toEqual(["--new-window", "--goto", `${file}:2:1`]);
  });
});
