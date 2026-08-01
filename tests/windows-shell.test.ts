import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createWindowsZip, moveWindowsPathToRecycleBin } from "../server/lib/windows-shell.mjs";

describe("Windows shell adapter", () => {
  test("uses the architecture-independent system recycle API and escapes paths", async () => {
    const calls: unknown[][] = [];
    await moveWindowsPathToRecycleBin("C:\\Notes\\Aaron's note.md", {
      kind: "file",
      run: async (...args: unknown[]) => { calls.push(args); },
    });

    expect(calls[0]?.[0]).toBe("powershell.exe");
    expect(calls[0]?.[1]).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]));
    expect(String((calls[0]?.[1] as string[]).at(-1))).toContain("DeleteFile");
    expect(String((calls[0]?.[1] as string[]).at(-1))).toContain("Aaron''s note.md");
    expect(calls[0]?.[2]).toEqual({ windowsHide: true });
  });

  test("creates zip exports through the Windows framework API", async () => {
    const calls: unknown[][] = [];
    await createWindowsZip("C:\\Noema\\export", "C:\\Exports\\notes.zip", {
      run: async (...args: unknown[]) => { calls.push(args); },
    });
    const command = String((calls[0]?.[1] as string[]).at(-1));
    expect(command).toContain("System.IO.Compression.ZipFile");
    expect(command).toContain("CreateFromDirectory");
    expect(command).toContain("notes.zip");
  });
});
