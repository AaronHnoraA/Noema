/**
 * Leave no DOM selection behind between tests. A selection still pointing
 * into a destroyed editor's nodes makes happy-dom report positions in the next
 * editor wrongly when CM6 rereads the selection, so a test's outcome would
 * depend on which test ran before it. A browser cannot keep a selection
 * inside removed nodes, so clearing it models the real page.
 */
import { afterEach } from "@voidzero-dev/vite-plus-test";

afterEach(() => {
  if (typeof document !== "undefined") document.getSelection?.()?.removeAllRanges();
});
