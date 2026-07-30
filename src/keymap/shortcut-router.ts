/**
 * Keyboard shortcut primitives for Noema.
 *
 * Problem this solves: the main keydown handler had 40+ branches each
 * spelling out `event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
 * && event.key.toLowerCase() === "x"` inline, with two shadowed `primaryMod`
 * bindings and duplicated platform-detection logic between the renderer and the
 * main process. `matchChord` collapses that into a single readable call.
 *
 * Usage:
 *   if (matchChord(event, { primary: true, shift: false, alt: false, key: "l" })) …
 */

/** State snapshot built once at the top of the keydown listener. */
export type ShortcutCtx = {
  editorOwnsTarget: boolean;
  fromLeanEmbedded: boolean;
  overlayOpen: boolean;
  vimMode: string;
  notesTool: string;
};

export type ChordSpec = {
  /**
   * Platform primary modifier: Cmd on Mac, Ctrl elsewhere.
   * true = required, false = must be absent, undefined = don't-care.
   */
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Explicit Cmd key (Mac-only semantics). Use `primary` for cross-platform
   * modifiers; use `meta` only when you explicitly want Cmd-but-not-Ctrl.
   */
  meta?: boolean;
  ctrl?: boolean;
  key: string;
};

const isMac = (): boolean => /Mac/.test(navigator.platform);

/** Returns the platform-primary modifier state for a keyboard event. */
export function primaryMod(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Returns true when `event` matches `spec`.
 *
 * Replaces chains like:
 *   primaryMod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l"
 * with:
 *   matchChord(event, { primary: true, shift: false, alt: false, key: "l" })
 */
export function matchChord(event: KeyboardEvent, spec: ChordSpec): boolean {
  if (event.key.toLowerCase() !== spec.key) return false;
  if (spec.primary !== undefined && primaryMod(event) !== spec.primary) return false;
  if (spec.shift !== undefined && event.shiftKey !== spec.shift) return false;
  if (spec.alt !== undefined && event.altKey !== spec.alt) return false;
  if (spec.meta !== undefined && event.metaKey !== spec.meta) return false;
  if (spec.ctrl !== undefined && event.ctrlKey !== spec.ctrl) return false;
  return true;
}

/**
 * History (undo/redo) chord recognition — shared between renderer and the
 * before-input-event check in the main process.
 *
 * Returns "undo", "redo", or null.
 */
export function historyChordKind(event: { key: string; altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): "undo" | "redo" | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  // macOS: Ctrl+Z is redo (Emacs convention)
  if (isMac() && event.ctrlKey && !event.metaKey && key === "z") return "redo";
  const primary = isMac()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primary) return null;
  if (key === "z" && !event.shiftKey) return "undo";
  if (key === "z" && event.shiftKey) return "redo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}
