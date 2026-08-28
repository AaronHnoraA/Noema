import type { EditorView } from "@codemirror/view";
import type { RendererActivityState } from "../renderer-activity.ts";

/**
 * The smallest editor surface needed by the focus quiescence adapter.
 * Keeping this contract at the CM6 boundary means host shells never need to
 * know how the editor is rendered or how its state is preserved.
 */
export type FocusQuiescenceEditor = Pick<EditorView, "contentDOM">;

/**
 * Keyboard names that represent browser/system controls rather than editor
 * input.  Named editor controls (arrows, Enter, Tab, deletion and Escape) are
 * intentionally kept out of this set and are replayed as well.
 */
const NON_EDITOR_KEY_NAMES = new Set([
  "Unidentified",
  "Dead",
  "Compose",
  "Process",
  "AltGraph",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Pause",
  "PrintScreen",
  "ContextMenu",
  "BrowserBack",
  "BrowserForward",
  "BrowserHome",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserFavorites",
  "BrowserStop",
  "Power",
  "Sleep",
  "WakeUp",
  "Eject",
  "LaunchMail",
  "LaunchMediaPlayer",
  "MediaPlayPause",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "AudioVolumeDown",
  "AudioVolumeMute",
  "AudioVolumeUp",
]);

const EDITOR_PRIMARY_MODIFIER_CODES = new Set([
  // Cmd/Ctrl authoring shortcuts handled by the shared renderer.
  "KeyA", "KeyB", "KeyC", "KeyD", "KeyF", "KeyI", "KeyK",
  "KeyP", "KeyQ", "KeyS", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ",
  "Slash", "BracketLeft", "BracketRight",
]);

function normalizedEditorKey(event: Pick<KeyboardEvent, "key" | "code">): string {
  if (event.key === "Spacebar" || event.key === "Space" || event.key === "SPC"
      || event.code === "Space") return " ";
  if (event.code === "NumpadEnter" || /^(?:Return|RET|CR|NumpadEnter)$/iu.test(event.key)) {
    return "Enter";
  }
  if (event.key === "Backtab" || event.key === "ISO_Left_Tab" || event.key === "Shift-Tab") {
    return "Tab";
  }
  return event.key;
}

function isNamedEditorKey(key: string): boolean {
  return key === "Enter"
    || key === "Tab"
    || key === "Backspace"
    || key === "Delete"
    || key === "Escape"
    || key === "ArrowLeft"
    || key === "ArrowRight"
    || key === "ArrowUp"
    || key === "ArrowDown"
    || key === "Home"
    || key === "End"
    || key === "PageUp"
    || key === "PageDown";
}

function isPrintableEditorText(key: string): boolean {
  if (!key || NON_EDITOR_KEY_NAMES.has(key) || /^F\d{1,2}$/u.test(key)) return false;
  if (isNamedEditorKey(key)) return false;
  // Browser/system key names are ASCII words (Help, ZoomIn, EraseEof, ...),
  // whereas non-ASCII multi-code-point values are legitimate emoji, CJK and
  // composed text. A real keyboard never emits an ASCII word as one printable
  // key; IME text arrives through composition and is guarded separately.
  if (key.length > 1 && /^[\x20-\x7e]+$/u.test(key)) return false;
  return true;
}

/**
 * Return true for a key that belongs to the editor's shared key pipeline.
 * This is deliberately independent of a host adapter: Emacs can report a
 * parked event on `body`, while the renderer still decides whether it is safe
 * to retarget that event to CM6.
 */
export function isReplayableEditorKeydown(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">,
): boolean {
  if (event.isComposing) return false;
  const key = normalizedEditorKey(event);
  if (!key || NON_EDITOR_KEY_NAMES.has(key) || /^F\d{1,2}$/u.test(key)) return false;
  if (isNamedEditorKey(key)) return true;

  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (!hasModifier) return isPrintableEditorText(key);
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    // Emacs/xwidget owns bare Ctrl+letter/digit chords in the Emacs host.
    return /^(?:Key[A-Z]|Digit\d)$/u.test(event.code) || isPrintableEditorText(key);
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    // Option/Hyper follows the same xwidget forwarding contract.
    return /^(?:Key[A-Z]|Digit\d)$/u.test(event.code) || isPrintableEditorText(key);
  }
  if (event.metaKey && !event.ctrlKey && !event.altKey) {
    return EDITOR_PRIMARY_MODIFIER_CODES.has(event.code);
  }
  return false;
}

/** Return the text payload for an ordinary parked insert-mode key, if any. */
export function editorTextFromKeydown(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">,
): string | null {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = normalizedEditorKey(event);
  if (!isPrintableEditorText(key)) return null;
  return key;
}

/**
 * Re-dispatch one parked key at CM6's contentDOM. Focusing during capture does
 * not retarget the original browser event, so this is the renderer-level
 * bridge that lets the normal document keydown/CM6 pipeline handle controls,
 * Vim commands and modifier chords without a second host implementation.
 */
export function replayEditorKeydown(target: HTMLElement, source: KeyboardEvent): boolean {
  if (!isReplayableEditorKeydown(source)) return false;
  const replayed = new KeyboardEvent(source.type, {
    bubbles: true,
    cancelable: true,
    key: normalizedEditorKey(source),
    code: source.code,
    location: source.location,
    ctrlKey: source.ctrlKey,
    metaKey: source.metaKey,
    altKey: source.altKey,
    shiftKey: source.shiftKey,
    repeat: source.repeat,
    isComposing: source.isComposing,
  });
  target.dispatchEvent(replayed);
  return true;
}

export type FocusQuiescenceController = {
  /** Apply the shared renderer activity lifecycle. */
  setActivity(state: RendererActivityState): void;
  /** Reflect the shared renderer hidden gate. Pausing parks immediately. */
  setPaused(paused: boolean): void;
  /** Park native contenteditable focus without destroying CM6 state. */
  setQuiescent(quiescent: boolean): void;
  /** Mark editor activity without manufacturing focus. */
  notifyActivity(): void;
  /** Wake the editor synchronously for an input or pointer event. */
  wake(): void;
  /** Park the editor if the current surface is safe to quiesce. */
  park(): void;
  /** Remove listeners and the pending one-shot timer. */
  destroy(): void;
};

export type FocusQuiescenceOptions = {
  /** Host capability. Disabled hosts receive no listeners and no timer. */
  enabled: boolean;
  view: FocusQuiescenceEditor;
  /** The renderer-owned editor surface, including its CM6 scroller/widgets. */
  editorSurface: HTMLElement;
  isSurfaceVisible: () => boolean;
  /** Shared CM6 pointer-selection state, when the host has one. */
  isPointerSelecting?: () => boolean;
  /** Modal/native-widget/tool surfaces that must retain ownership of input. */
  isInteractionBlocked?: () => boolean;
  /**
   * Route an editor-owned key that arrived after focus was parked. Browsers do
   * not retarget an already-dispatched keydown when wake() focuses CM6, so a
   * renderer-level callback is the only way to preserve that first key. It must
   * return true only when it replayed/handled the key.
   */
  onParkedKeydown?: (event: KeyboardEvent) => boolean;
  /** One-shot inactivity delay for the standalone controller fallback. */
  inactivityMs?: number;
  /** The shared renderer gate owns this timer in production. */
  autoPark?: boolean;
  document?: Document;
  window?: Window;
};

const DEFAULT_INACTIVITY_MS = 1000;

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isNativeInputElement(element: Element | null, contentDOM: HTMLElement): boolean {
  if (!element || element === contentDOM) return false;
  const input = element.closest(
    "input, textarea, select, button, a, [contenteditable='true'], [data-aaronnote-vim='native']",
  );
  return Boolean(input && input !== contentDOM);
}

/**
 * Park only the native contenteditable focus. CM6's document, selection, Vim
 * model, undo history and decorations remain untouched. This is deliberately
 * a renderer concern: Emacs and Electron use the same controller, while a
 * host merely opts in when its native WebKit surface needs this workaround.
 */
export function createFocusQuiescenceController(
  options: FocusQuiescenceOptions,
): FocusQuiescenceController {
  const {
    enabled,
    view,
    editorSurface,
    isSurfaceVisible,
    isPointerSelecting = () => false,
    isInteractionBlocked = () => false,
    onParkedKeydown,
    inactivityMs = DEFAULT_INACTIVITY_MS,
    autoPark = true,
    document: documentRef = document,
    window: windowRef = window,
  } = options;
  const contentDOM = view.contentDOM;

  let destroyed = false;
  let paused = false;
  let quiescent = false;
  let parked = false;
  let composing = false;
  let pointerActive = false;
  let inactivityTimer = 0;

  const clearInactivityTimer = (): void => {
    if (!inactivityTimer) return;
    windowRef.clearTimeout(inactivityTimer);
    inactivityTimer = 0;
  };

  const activeElement = (): Element | null => documentRef.activeElement;

  const editorHasFocus = (): boolean => activeElement() === contentDOM;

  const canUseEditorSurface = (): boolean =>
    !destroyed
    && !paused
    && !documentRef.hidden
    && isSurfaceVisible()
    && !isInteractionBlocked();

  const canPark = (): boolean =>
    canUseEditorSurface()
    && editorHasFocus()
    && !composing
    && !pointerActive
    && !isPointerSelecting();

  const detachedKeyboardTarget = (target: EventTarget | null): boolean => {
    const active = activeElement();
    if (active && active !== documentRef.body && active !== documentRef.documentElement) return false;
    const element = eventElement(target);
    if (isNativeInputElement(element, contentDOM)) return false;
    return target === null
      || target === documentRef
      || target === documentRef.body
      || target === documentRef.documentElement
      || (element instanceof Node && editorSurface.contains(element));
  };

  const canHandleKeyboardEvent = (event: Event): boolean => {
    if (!canUseEditorSurface()) return false;
    const element = eventElement(event.target);
    if (isNativeInputElement(element, contentDOM)) return false;
    return editorHasFocus() || detachedKeyboardTarget(event.target);
  };

  const scheduleInactivity = (): void => {
    clearInactivityTimer();
    if (!autoPark || !canPark() || composing || pointerActive || isPointerSelecting()) return;
    inactivityTimer = windowRef.setTimeout(() => {
      inactivityTimer = 0;
      if (canPark()) parkNow();
    }, Math.max(0, inactivityMs));
  };

  const parkNow = (): void => {
    clearInactivityTimer();
    if (!editorHasFocus()) return;
    parked = true;
    // Do not hide/rebuild CM6. The only operation here is the native focus
    // release that stops WebKit's persistent caret/selection compositor work.
    contentDOM.blur();
  };

  const wakeNow = (): void => {
    if (!canUseEditorSurface()) return;
    clearInactivityTimer();
    parked = false;
    contentDOM.focus({ preventScroll: true });
  };

  const notifyActivity = (): void => {
    if (!canUseEditorSurface() || !editorHasFocus()) {
      clearInactivityTimer();
      return;
    }
    scheduleInactivity();
  };

  const onFocusIn = (event: FocusEvent): void => {
    if (event.target !== contentDOM) {
      clearInactivityTimer();
      return;
    }
    parked = false;
    notifyActivity();
  };

  const onFocusOut = (): void => {
    clearInactivityTimer();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (!canHandleKeyboardEvent(event)) return;
    if (event.isComposing) {
      composing = true;
      clearInactivityTimer();
    }
    const wasParked = parked;
    if (wasParked) {
      wakeNow();
      // Focusing during capture does not retarget this keydown. Give the
      // shared renderer one chance to replay the editor-owned event; all
      // controls, Vim commands and shortcuts then use the normal pipeline.
      if (!event.isComposing && onParkedKeydown?.(event)) {
        event.preventDefault();
        // The renderer keydown listener is registered on the same capture
        // target. stopPropagation() would still allow a later listener on
        // document to process the original body-targeted event a second time.
        event.stopImmediatePropagation();
        return;
      }
    }
    if (!composing) notifyActivity();
  };

  const onBeforeInput = (event: InputEvent): void => {
    if (!canHandleKeyboardEvent(event)) return;
    if (event.isComposing) {
      composing = true;
      clearInactivityTimer();
    }
    if (parked) wakeNow();
    if (!composing) notifyActivity();
  };

  const onCompositionStart = (event: CompositionEvent): void => {
    if (!canHandleKeyboardEvent(event)) return;
    composing = true;
    clearInactivityTimer();
    if (parked) wakeNow();
  };

  const onCompositionEnd = (event: CompositionEvent): void => {
    // compositionend can arrive after focus has already moved to a native
    // widget or another host surface. Always release the local guard, but
    // only restart the editor timer when the editor still owns focus.
    if (!composing) return;
    composing = false;
    if (canHandleKeyboardEvent(event)) notifyActivity();
  };

  const isEditorPointerTarget = (target: EventTarget | null): boolean => {
    const element = eventElement(target);
    if (!element || !editorSurface.contains(element)) return false;
    return !isNativeInputElement(element, contentDOM);
  };

  const onPointerDown = (event: PointerEvent | MouseEvent): void => {
    if (!canUseEditorSurface() || !isEditorPointerTarget(event.target)) return;
    pointerActive = true;
    clearInactivityTimer();
    if (parked) wakeNow();
  };

  const onPointerActivity = (): void => {
    if (!pointerActive) return;
    clearInactivityTimer();
  };

  const finishPointer = (): void => {
    if (!pointerActive) return;
    pointerActive = false;
    // Let CM6 finish its pointer transaction before consulting its
    // isPointerSelecting state. This also avoids a timer during a drag.
    queueMicrotask(notifyActivity);
  };

  const onVisibilityChange = (): void => {
    if (documentRef.hidden) {
      clearInactivityTimer();
      composing = false;
      return;
    }
    notifyActivity();
  };

  const listeners: Array<[
    EventTarget,
    string,
    EventListener,
    AddEventListenerOptions | boolean | undefined,
  ]> = [];

  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListener,
    listenerOptions?: AddEventListenerOptions | boolean,
  ): void => {
    target.addEventListener(type, listener, listenerOptions);
    listeners.push([target, type, listener, listenerOptions]);
  };

  if (!enabled) {
    return {
      setActivity: () => {},
      setPaused: () => {},
      setQuiescent: () => {},
      notifyActivity: () => {},
      wake: () => {},
      park: () => {},
      destroy: () => {},
    };
  }

  listen(documentRef, "focusin", onFocusIn as EventListener, true);
  listen(documentRef, "focusout", onFocusOut as EventListener, true);
  listen(documentRef, "keydown", onKeydown as EventListener, true);
  listen(documentRef, "beforeinput", onBeforeInput as EventListener, true);
  listen(documentRef, "compositionstart", onCompositionStart as EventListener, true);
  listen(documentRef, "compositionend", onCompositionEnd as EventListener, true);
  listen(editorSurface, "pointerdown", onPointerDown as EventListener, true);
  listen(editorSurface, "mousedown", onPointerDown as EventListener, true);
  listen(documentRef, "pointermove", onPointerActivity as EventListener, true);
  listen(documentRef, "mousemove", onPointerActivity as EventListener, true);
  listen(documentRef, "pointerup", finishPointer as EventListener, true);
  listen(documentRef, "pointercancel", finishPointer as EventListener, true);
  listen(documentRef, "mouseup", finishPointer as EventListener, true);
  listen(documentRef, "lostpointercapture", finishPointer as EventListener, true);
  listen(documentRef, "visibilitychange", onVisibilityChange as EventListener, false);

  const controller: FocusQuiescenceController = {
    setActivity(state: RendererActivityState): void {
      if (state === "hidden" || state === "destroyed") {
        controller.setPaused(true);
        return;
      }
      if (paused) controller.setPaused(false);
      controller.setQuiescent(state === "quiescent");
    },
    setPaused(next: boolean): void {
      if (destroyed || paused === next) return;
      paused = next;
      clearInactivityTimer();
      if (next) {
        quiescent = false;
        composing = false;
        pointerActive = false;
        // Pausing is stronger than the normal eligibility checks: if some
        // host transition left CM6 focused, release it synchronously.
        if (editorHasFocus()) parkNow();
        return;
      }
      // Resume never focuses the editor. If a real user/host action already
      // focused it, the normal idle timer may be started; otherwise it stays
      // parked until an input or pointer event wakes it.
      notifyActivity();
    },
    setQuiescent(next: boolean): void {
      if (destroyed || quiescent === next) return;
      quiescent = next;
      clearInactivityTimer();
      if (next) {
        // Quiescence is allowed to park only native focus. The editor remains
        // usable so the shared gate can wake it on the first real key/pointer.
        if (editorHasFocus()) parkNow();
      } else {
        notifyActivity();
      }
    },
    notifyActivity,
    wake: wakeNow,
    park(): void {
      if (canPark()) parkNow();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInactivityTimer();
      for (const [target, type, listener, listenerOptions] of listeners) {
        target.removeEventListener(type, listener, listenerOptions);
      }
      listeners.length = 0;
    },
  };

  return controller;
}
