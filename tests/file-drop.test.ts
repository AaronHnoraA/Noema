import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { installFileDropGuard } from "../pages/host-file-drop.ts";
import { dropAttachmentFiles } from "../src/cm6/editor-cm6.ts";
import { pasteDataTransfer } from "../src/paste.ts";

function dragEvent(type: string, types: string[]): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types } });
  return event;
}

describe("files dropped on a Noema page", () => {
  test("a file drop never reaches WebKit's navigation, a text drag stays", () => {
    const target = new EventTarget();
    const remove = installFileDropGuard(target);
    for (const type of ["dragover", "drop"]) {
      const files = dragEvent(type, ["Files"]);
      target.dispatchEvent(files);
      expect(files.defaultPrevented).toBe(true);
      const text = dragEvent(type, ["text/plain"]);
      target.dispatchEvent(text);
      expect(text.defaultPrevented).toBe(false);
    }
    remove();
    const after = dragEvent("drop", ["Files"]);
    target.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  test("a text file becomes a link, not the note's content", async () => {
    const file = new File(["# Body\n"], "note.md", { type: "text/markdown" });
    const upload = vi.fn(async () => ({ markdownPath: "assets/note.md", name: "note.md" }));
    const dispatched: unknown[] = [];
    const view = {
      posAtCoords: () => 3,
      dispatch: (spec: unknown) => dispatched.push(spec),
      focus: () => {},
      state: {
        doc: { toString: () => "", lineAt: () => ({ from: 0, to: 0, text: "" }), length: 0 },
        selection: { main: { from: 0, to: 0, head: 0, anchor: 0 }, ranges: [] },
      },
    };
    const event = new Event("drop", { cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [file], items: [], getData: () => "" },
    });
    const taken = dropAttachmentFiles(view as never, event, {
      pasteAssets: { uploadBlobAsset: upload },
    } as never);
    expect(taken).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
  });

  test("a drop without files stays with CodeMirror", () => {
    const event = new Event("drop", { cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [], items: [], getData: () => "text" },
    });
    expect(dropAttachmentFiles({} as never, event, {
      pasteAssets: { uploadBlobAsset: async () => null },
    } as never)).toBe(false);
  });
});

describe("what a paste takes from the clipboard", () => {
  test("a spreadsheet's table wins over the picture beside it", async () => {
    const upload = vi.fn(async () => null);
    const inserted: string[] = [];
    const html = "<table><tr><td>a</td><td>b</td></tr></table>";
    const data = {
      files: [new File(["x"], "image.png", { type: "image/png" })],
      items: [],
      getData: (type: string) => (type === "text/html" ? html : "a\tb"),
    } as unknown as DataTransfer;
    await pasteDataTransfer(data, {
      assets: { uploadBlobAsset: upload },
      insertMarkdown: (markdown: string) => { inserted.push(markdown); return true; },
    } as never);
    expect(upload).not.toHaveBeenCalled();
    expect(inserted[0]).toContain("|");
  });
});
