/**
 * Embedded editing surfaces: elements inside the editor that edit text with an
 * editor of their own rather than CM6's document — a table cell's input, a
 * formula's MathLive field, a diagram lightbox, a meta summary editor.
 *
 * Keys typed into one belong to it: Vim does not interpret them, the editor
 * does not take focus back on pointer events, scroll handling leaves them
 * alone, and Emacs does not receive them. A surface opts in with
 * `markEmbeddedSurface`; every place that has to tell such a surface from the
 * document asks through the selectors here, so the rule has one spelling.
 * See `docs/architecture/rendered-constructs.md`.
 */

/** The attribute that marks an embedded surface, and its value. */
export const EMBEDDED_SURFACE_ATTRIBUTE = "data-aaronnote-vim";
export const EMBEDDED_SURFACE_VALUE = "native";

/** Matches an element marked as an embedded surface. */
export const EMBEDDED_SURFACE_SELECTOR = `[${EMBEDDED_SURFACE_ATTRIBUTE}='${EMBEDDED_SURFACE_VALUE}']`;

/** Matches a browser text control. CM6's own `.cm-content` is one too; exclude it where it matters. */
export const NATIVE_TEXT_CONTROL_SELECTOR = "input, textarea, select, [contenteditable='true']";

/** Mark ELEMENT as an embedded editing surface. */
export function markEmbeddedSurface(element: HTMLElement): void {
  element.setAttribute(EMBEDDED_SURFACE_ATTRIBUTE, EMBEDDED_SURFACE_VALUE);
}

/** The element an event target is, or the element holding a text node target. */
export function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

/** Whether TARGET is inside an embedded editing surface. */
export function isInEmbeddedSurface(target: EventTarget | null): boolean {
  return Boolean(eventTargetElement(target)?.closest(EMBEDDED_SURFACE_SELECTOR));
}
