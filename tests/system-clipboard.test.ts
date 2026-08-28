import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { EditorSelection, EditorState } from "@codemirror/state";

import {
  setSystemClipboardWriter,
  systemClipboardWriter,
  writeSystemClipboard,
} from "../src/system-clipboard.ts";
import { copiedText } from "../src/cm6/copied-text.ts";
import { installHostClipboard } from "../aaronnote/host-clipboard.ts";
import { pasteDataTransfer } from "../src/paste.ts";

type MutableWindow = Window & { __aaronnoteHostMode?: string };

function setHostMode(mode: string | undefined): void {
  if (mode === undefined) delete (window as MutableWindow).__aaronnoteHostMode;
  else (window as MutableWindow).__aaronnoteHostMode = mode;
}

afterEach(() => {
  setSystemClipboardWriter(null);
  setHostMode(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copiedText", () => {
  function state(doc: string, selection: EditorSelection): EditorState {
    return EditorState.create({
      doc,
      selection,
      extensions: EditorState.allowMultipleSelections.of(true),
    });
  }

  test("joins the non-empty ranges", () => {
    const doc = "alpha\nbeta\ngamma";
    const selection = EditorSelection.create([
      EditorSelection.range(0, 5),
      EditorSelection.range(6, 10),
    ]);
    expect(copiedText(state(doc, selection))).toBe("alpha\nbeta");
  });

  test("copies the cursor's whole line when nothing is selected", () => {
    const doc = "alpha\nbeta\ngamma";
    expect(copiedText(state(doc, EditorSelection.single(7)))).toBe("beta");
  });

  test("does not repeat a line two cursors share", () => {
    const doc = "alpha\nbeta";
    const selection = EditorSelection.create([
      EditorSelection.cursor(6),
      EditorSelection.cursor(9),
    ]);
    expect(copiedText(state(doc, selection))).toBe("beta");
  });
});

describe("writeSystemClipboard", () => {
  test("uses the browser clipboard when no host writer is installed", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await writeSystemClipboard("copied")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("copied");
  });

  test("falls back to execCommand when the clipboard API is denied", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand: () => boolean }).execCommand = execCommand;

    expect(await writeSystemClipboard("copied")).toBe(true);
    expect(execCommand).toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
  });

  // The Emacs xwidget host is exactly the case where both browser paths fail,
  // so the reported result has to come from the host writer, not from them.
  test("reports the host writer's result even when the browser write fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    const host = vi.fn(async () => true);
    setSystemClipboardWriter(host);

    expect(await writeSystemClipboard("copied")).toBe(true);
    expect(host).toHaveBeenCalledWith("copied");
  });

  test("reports failure when the host writer rejects", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    setSystemClipboardWriter(async () => { throw new Error("offline"); });

    expect(await writeSystemClipboard("copied")).toBe(false);
  });
});

describe("installHostClipboard", () => {
  test("installs a writer that posts to the host in the Emacs xwidget host", async () => {
    setHostMode(undefined); // No injected mode and no ?host=desktop means Emacs.
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    installHostClipboard();
    const writer = systemClipboardWriter();
    expect(writer).not.toBeNull();
    expect(await writer!("copied")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/clipboard", expect.objectContaining({
      method: "POST",
      body: "copied",
    }));
  });

  test("leaves the desktop and server hosts on the browser clipboard", () => {
    for (const mode of ["desktop", "server"]) {
      setSystemClipboardWriter(null);
      setHostMode(mode);
      installHostClipboard();
      expect(systemClipboardWriter()).toBeNull();
    }
  });
});

describe("pasteDataTransfer", () => {
  function emptyTransfer(): DataTransfer {
    return {
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      types: [],
      getData: () => "",
    } as unknown as DataTransfer;
  }

  // WKWebView inside Emacs dispatches the paste event but exposes no pasteboard
  // data to the page; dropping the paste there is what made Cmd-V do nothing.
  test("asks the host when the paste event carries no data", async () => {
    const insertMarkdown = vi.fn(() => true);
    const readSystemClipboardFallback = vi.fn(async () => ({ kind: "text" as const, text: "from host" }));

    expect(await pasteDataTransfer(emptyTransfer(), { insertMarkdown, readSystemClipboardFallback })).toBe(true);
    expect(readSystemClipboardFallback).toHaveBeenCalled();
    expect(insertMarkdown).toHaveBeenCalledWith("from host", undefined);
  });

  test("still prefers the event's own data", async () => {
    const insertMarkdown = vi.fn(() => true);
    const readSystemClipboardFallback = vi.fn(async () => ({ kind: "text" as const, text: "from host" }));
    const data = {
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? "from event" : ""),
    } as unknown as DataTransfer;

    expect(await pasteDataTransfer(data, { insertMarkdown, readSystemClipboardFallback })).toBe(true);
    expect(readSystemClipboardFallback).not.toHaveBeenCalled();
    expect(insertMarkdown).toHaveBeenCalledWith("from event", undefined);
  });
});
