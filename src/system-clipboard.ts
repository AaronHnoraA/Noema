/**
 * One place that answers "put this text on the machine's clipboard".
 *
 * The browser answer — `navigator.clipboard.writeText`, with a detached
 * `<textarea>` + `execCommand("copy")` fallback — is correct in Chromium and in
 * a normal Safari tab. It is not sufficient in the Emacs xwidget host: that
 * page runs inside a WKWebView that Emacs owns, where both APIs require
 * transient user activation the page frequently does not have (a key Emacs
 * forwarded, a toolbar command that already awaited a promise, a Vim operator
 * that yanks without any DOM event of its own). The write then fails silently
 * and the text never reaches the macOS pasteboard, so nothing can be pasted
 * into another application.
 *
 * The host running the page can always write the pasteboard, so hosts that need
 * to install a writer here and every copy in the product routes through
 * `writeSystemClipboard`. `src/` never learns how a particular host does it.
 */

/** Writes TEXT to the machine clipboard. Resolves false when it could not. */
export type SystemClipboardWriter = (text: string) => Promise<boolean>;

let hostWriter: SystemClipboardWriter | null = null;

/**
 * Install (or clear, with null) the host transport used by every copy.
 *
 * A normal browser tab installs nothing and keeps the browser path below.
 */
export function setSystemClipboardWriter(writer: SystemClipboardWriter | null): void {
  hostWriter = writer;
}

export function systemClipboardWriter(): SystemClipboardWriter | null {
  return hostWriter;
}

async function writeViaBrowser(text: string): Promise<boolean> {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // Denied (no user activation, not a secure context): try execCommand.
    }
  }
  if (typeof document === "undefined" || !document.body) return false;
  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.style.position = "fixed";
  fallback.style.left = "-9999px";
  document.body.appendChild(fallback);
  try {
    fallback.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    fallback.remove();
  }
}

/** The host and browser target the same pasteboard. Use its installed writer
 * once, so a pending WebKit permission prompt cannot hold up a completed copy. */
export async function writeSystemClipboard(text: string): Promise<boolean> {
  if (typeof text !== "string") return false;
  const writer = hostWriter;
  if (!writer) return writeViaBrowser(text);
  try {
    return await writer(text);
  } catch {
    return false;
  }
}
