import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_NOEMA_PROTOCOL_URL_BYTES,
  noemaProtocolUrlFromArgv,
  parseNoemaProtocolUrl,
  protocolPathWithin,
  verifyNoemaProtocolTarget,
} from "../desktop/protocol-url.mjs";

describe("Noema desktop protocol URLs", () => {
  test("resolves workspace-relative Markdown and fragment anchors", () => {
    expect(parseNoemaProtocolUrl(
      "noema://open?path=Papers%2F%CE%B1.md#Main%20Result",
      { workspaceRoot: "/Users/example/Notes", platform: "darwin" },
    )).toEqual({
      action: "open-note",
      file: "/Users/example/Notes/Papers/α.md",
      scope: "workspace",
      workspaceRoot: "/Users/example/Notes",
      hash: "Main Result",
      dom: "",
      disposition: "",
    });
  });

  test("accepts explicit absolute Markdown with DOM targets and new-window disposition", () => {
    expect(parseNoemaProtocolUrl(
      "noema://open?file=%2Ftmp%2FStandalone.MARKDOWN&dom=Proof%2FStep%202&disposition=new",
      { workspaceRoot: "/notes", platform: "darwin" },
    )).toEqual({
      action: "open-note",
      file: "/tmp/Standalone.MARKDOWN",
      scope: "absolute",
      workspaceRoot: "",
      hash: "",
      dom: "Proof/Step 2",
      disposition: "new",
    });
    expect(parseNoemaProtocolUrl(
      "noema://open?file=C%3A%5CNotes%5Cpaper.md",
      { platform: "win32" },
    )).toMatchObject({ file: "C:\\Notes\\paper.md", scope: "absolute" });
  });

  test("maps the only supported app routes without accepting arbitrary host URLs", () => {
    expect(parseNoemaProtocolUrl("noema://wiki")).toEqual({
      action: "open-route", route: "/wiki", disposition: "",
    });
    expect(parseNoemaProtocolUrl("NOEMA://GRAPH?disposition=new")).toEqual({
      action: "open-route", route: "/wiki?view=graph", disposition: "new",
    });
  });

  test("recognizes protocol arguments and verifies path containment on both path dialects", () => {
    expect(noemaProtocolUrlFromArgv(["Electron", "--flag", "NoEmA://wiki"])).toBe("NoEmA://wiki");
    expect(noemaProtocolUrlFromArgv(["Electron", "/notes/a.md"])).toBe("");
    expect(protocolPathWithin("/notes", "/notes/a.md", "darwin")).toBe(true);
    expect(protocolPathWithin("/notes", "/notes-old/a.md", "darwin")).toBe(false);
    expect(protocolPathWithin("C:\\Notes", "C:\\Notes\\a.md", "win32")).toBe(true);
    expect(protocolPathWithin("C:\\Notes", "C:\\Other\\a.md", "win32")).toBe(false);
  });

  test("canonicalizes real files and rejects missing, directory and symlink-escape targets", async () => {
    const suite = await mkdtemp(join(tmpdir(), "noema-protocol-url-"));
    const root = join(suite, "notes");
    const outside = join(suite, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(root, "inside.md"), "# Inside\n", "utf8");
      await writeFile(join(outside, "outside.md"), "# Outside\n", "utf8");
      await mkdir(join(root, "folder.md"));
      await symlink(join(outside, "outside.md"), join(root, "escape.md"));

      const inside = parseNoemaProtocolUrl("noema://open?path=inside.md", {
        workspaceRoot: root,
        platform: "darwin",
      });
      expect(verifyNoemaProtocolTarget(inside, { platform: "darwin" })).toMatchObject({
        action: "open-note",
        file: await realpath(join(root, "inside.md")),
        workspaceRoot: await realpath(root),
      });
      const escape = parseNoemaProtocolUrl("noema://open?path=escape.md", {
        workspaceRoot: root,
        platform: "darwin",
      });
      expect(() => verifyNoemaProtocolTarget(escape, { platform: "darwin" })).toThrow("symbolic link");
      const missing = parseNoemaProtocolUrl("noema://open?path=missing.md", {
        workspaceRoot: root,
        platform: "darwin",
      });
      expect(() => verifyNoemaProtocolTarget(missing, { platform: "darwin" })).toThrow("does not exist");
      const directory = parseNoemaProtocolUrl("noema://open?path=folder.md", {
        workspaceRoot: root,
        platform: "darwin",
      });
      expect(() => verifyNoemaProtocolTarget(directory, { platform: "darwin" })).toThrow("not a file");
    } finally {
      await rm(suite, { recursive: true, force: true });
    }
  });

  test("rejects ambiguous, unsafe, unsupported and oversized requests", () => {
    const invalid = [
      "https://open?path=a.md",
      "noema://",
      "noema://unknown",
      "noema://user@open?path=a.md",
      "noema://open/extra?path=a.md",
      "noema://open",
      "noema://open?path=a.md&file=%2Ftmp%2Fa.md",
      "noema://open?path=%2Fabsolute.md",
      "noema://open?path=..%2Foutside.md",
      "noema://open?path=.private%2Fa.md",
      "noema://open?file=relative.md",
      "noema://open?file=%2Ftmp%2F.hidden%2Fa.md",
      "noema://open?file=%2Ftmp%2Fa.png",
      "noema://open?path=a.md&hash=one#two",
      "noema://open?path=a.md&hash=one&dom=two",
      "noema://open?path=a.md&disposition=split-right",
      "noema://open?path=a.md&bogus=1",
      "noema://open?path=a.md&path=b.md",
      "noema://wiki?view=graph",
      "noema://wiki#fragment",
      "noema://open?path=a.md#%ZZ",
      "noema://open?path=a.md#%0A",
      "noema://open?path=a.md\n",
    ];
    for (const value of invalid) {
      expect(() => parseNoemaProtocolUrl(value, {
        workspaceRoot: "/notes",
        platform: "darwin",
      }), value).toThrow("Invalid Noema URL");
    }
    const oversized = `noema://open?path=${"a".repeat(MAX_NOEMA_PROTOCOL_URL_BYTES)}.md`;
    expect(() => parseNoemaProtocolUrl(oversized, { workspaceRoot: "/notes" })).toThrow("too long");
  });
});
