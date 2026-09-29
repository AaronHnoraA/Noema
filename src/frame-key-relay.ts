/**
 * Key relay for sandboxed output frames.
 *
 * Script-bearing cell output renders in a sandboxed srcdoc iframe with an
 * opaque origin, so its key events never reach the hosting page.  The frame
 * runs this relay: it applies the host page's Emacs rules (the chord gate
 * `shouldForwardToEmacs` and the C-x/C-c prefix gate in
 * `aaronnote/xwidget-key-guard.ts`; a test keeps them identical), stops such
 * keys inside the output, and posts them to the page, whose
 * `installFrameKeyRelay` forwards them.  A frame without native focus leaves
 * every key to its host, as the page does.  It is plain ES5 because it runs
 * inside arbitrary output documents.
 */

export const FRAME_KEY_RELAY_MESSAGE = "__aaronnoteFrameKey";

export const FRAME_KEY_RELAY_SOURCE = `(function () {
  var ARROWS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
  var MODIFIERS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, OS: 1, Super: 1, Hyper: 1, CapsLock: 1,
    Fn: 1, FnLock: 1, NumLock: 1, ScrollLock: 1, AltGraph: 1, Dead: 1, Process: 1, Unidentified: 1, Compose: 1 };
  function physical(code) { return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || ARROWS[code] === 1; }
  function emacsChord(e) {
    if (e.isComposing) return false;
    var m = e.metaKey, c = e.ctrlKey, a = e.altKey, s = e.shiftKey, k = e.code;
    if (a && !m && !c) return !ARROWS[k] && physical(k);
    if (m && !c && !a && !s && ARROWS[k]) return true;
    if (m && !c && !a && k === "KeyO") return true;
    if (m && !c && !a && s && k === "KeyW") return true;
    if (m && !c && !a && !s) return k === "KeyX" || k === "KeyW" || k === "KeyQ";
    if (c && !m && !a) return k === "KeyX" || k === "KeyC" || k === "KeyG";
    return false;
  }
  var pending = false;
  document.addEventListener("keydown", function (e) {
    if (typeof document.hasFocus === "function" && !document.hasFocus()) {
      e.stopImmediatePropagation();
      return;
    }
    if (pending) {
      if (MODIFIERS[e.key] === 1) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.isComposing) { pending = false; return; }
      pending = false;
    } else if (emacsChord(e)) {
      pending = e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "KeyX" || e.code === "KeyC");
    } else {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    parent.postMessage({ ${FRAME_KEY_RELAY_MESSAGE}: true, key: e.key, code: e.code,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey }, "*");
  }, true);
})();`;

/** The relay as a script element for an output frame's srcdoc. */
export const FRAME_KEY_RELAY_SCRIPT = `<script>${FRAME_KEY_RELAY_SOURCE}</script>`;
