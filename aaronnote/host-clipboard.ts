import { setSystemClipboardWriter } from "../src/system-clipboard.ts";
import { hostMode } from "./host-mode.ts";

/**
 * Teach `src/system-clipboard.ts` how this host reaches the machine clipboard.
 *
 * Only the Emacs xwidget host needs one. Its page runs in a WKWebView owned by
 * Emacs, where `navigator.clipboard.writeText` and `execCommand("copy")` both
 * need transient user activation the page often does not have, so a copy can
 * succeed inside the page and still never appear on the macOS pasteboard. The
 * web-host process has no such restriction: `POST /api/clipboard` pipes the
 * text through `pbcopy`.
 *
 * Electron already owns a real clipboard, and the read-only server host must
 * not touch the machine running it — both keep the plain browser path.
 */
export function installHostClipboard(): void {
  if (hostMode() !== "emacs") return;
  setSystemClipboardWriter(async (text) => {
    const response = await fetch("/api/clipboard", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    });
    return response.ok;
  });
}
