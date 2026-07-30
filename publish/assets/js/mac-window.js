/* mac-window.js — macOS-style draggable floating windows (non-modal) */

(function () {
  "use strict";

  let _zTop = 300;
  const _wins = new Set();

  /* Default positions: cascade from top-left */
  let _cascade = { x: 80, y: 60 };
  function nextPos(w, h) {
    const pos = { x: _cascade.x, y: _cascade.y };
    _cascade = {
      x: Math.min(_cascade.x + 28, window.innerWidth  - w - 20),
      y: Math.min(_cascade.y + 28, window.innerHeight - h - 20),
    };
    if (_cascade.x > window.innerWidth  - w - 20 ||
        _cascade.y > window.innerHeight - h - 20) {
      _cascade = { x: 80, y: 60 };
    }
    return pos;
  }

  /* Bring a window to the top */
  function raiseWin(el) {
    _zTop += 1;
    el.style.zIndex = _zTop;
  }

  /* Make an element draggable by a handle */
  function makeDraggable(win, handle) {
    let startX, startY, startL, startT;

    function onMove(e) {
      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      let newL = startL + (cx - startX);
      let newT = startT + (cy - startY);
      /* Keep inside viewport */
      newL = Math.max(0, Math.min(newL, window.innerWidth  - win.offsetWidth));
      newT = Math.max(0, Math.min(newT, window.innerHeight - 38));
      win.style.left = newL + "px";
      win.style.top  = newT + "px";
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend",  onUp);
    }

    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("wc")) return;
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      startL = win.offsetLeft;
      startT = win.offsetTop;
      raiseWin(win);
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });

    handle.addEventListener("touchstart", (e) => {
      if (e.target.classList.contains("wc")) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startL = win.offsetLeft;
      startT = win.offsetTop;
      raiseWin(win);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend",  onUp);
    });
  }

  /* Make an element resizable from bottom-right corner */
  function makeResizable(win, handle) {
    let startX, startY, startW, startH;

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.width  = Math.max(280, startW + dx) + "px";
      win.style.height = Math.max(120, startH + dy) + "px";
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    }

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startW = win.offsetWidth;
      startH = win.offsetHeight;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  }

  /**
   * MacWindow.open(opts) → handle { el, close }
   *
   * opts:
   *   title       {string}   Window title bar text
   *   build       {fn(bodyEl, [focusEl])}  Called to populate the window
   *   width       {number}   Initial width  (default 800)
   *   height      {number}   Initial height (default 600)
   *   hasFocus    {boolean}  Show a focus strip at the bottom (default false)
   *   onClose     {fn}       Called when window is destroyed
   */
  function open(opts = {}) {
    const {
      title    = "",
      build    = () => {},
      width    = 800,
      height   = 600,
      hasFocus = false,
      onClose  = null,
    } = opts;

    const win = document.createElement("div");
    win.className = "macwin";

    const pos = nextPos(width, height);
    win.style.left   = pos.x + "px";
    win.style.top    = pos.y + "px";
    win.style.width  = width  + "px";
    win.style.height = height + "px";
    raiseWin(win);

    /* Chrome */
    const chrome = document.createElement("div");
    chrome.className = "macwin-chrome";

    const controls = document.createElement("div");
    controls.className = "window-controls";

    const btnClose = document.createElement("span");
    btnClose.className = "wc wc-close";
    btnClose.title = "Close";

    const btnMin = document.createElement("span");
    btnMin.className = "wc wc-min";
    btnMin.title = "Minimise";

    const btnMax = document.createElement("span");
    btnMax.className = "wc wc-max";
    btnMax.title = "Maximise";

    controls.appendChild(btnClose);
    controls.appendChild(btnMin);
    controls.appendChild(btnMax);

    const titleEl = document.createElement("div");
    titleEl.className = "macwin-title";
    titleEl.textContent = title;

    /* Spacer mirrors controls width for true centering */
    const spacer = document.createElement("div");
    spacer.style.cssText = "width:53px;flex-shrink:0;";

    chrome.appendChild(controls);
    chrome.appendChild(titleEl);
    chrome.appendChild(spacer);
    win.appendChild(chrome);

    /* Body */
    const body = document.createElement("div");
    body.className = "macwin-body";
    win.appendChild(body);

    /* Optional focus strip */
    let focus = null;
    if (hasFocus) {
      focus = document.createElement("div");
      focus.className = "macwin-focus empty";
      win.appendChild(focus);
    }

    /* Resize handle */
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "macwin-resize";
    win.appendChild(resizeHandle);

    /* Close */
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      win.remove();
      _wins.delete(handle);
      onClose && onClose();
    }

    /* Maximise toggle */
    let maximised = false;
    let savedRect = null;

    function toggleMax() {
      if (!maximised) {
        savedRect = {
          left: win.style.left, top: win.style.top,
          width: win.style.width, height: win.style.height,
        };
        win.style.left   = "0";
        win.style.top    = "0";
        win.style.width  = "100vw";
        win.style.height = "100vh";
        win.classList.add("is-maximised");
      } else {
        if (savedRect) {
          win.style.left   = savedRect.left;
          win.style.top    = savedRect.top;
          win.style.width  = savedRect.width;
          win.style.height = savedRect.height;
        }
        win.classList.remove("is-maximised");
      }
      maximised = !maximised;
    }

    btnClose.addEventListener("click", close);
    btnMax.addEventListener("click", toggleMax);
    /* Min: no-op visually (could minimise to taskbar if ever needed) */

    win.addEventListener("mousedown", () => raiseWin(win));

    makeDraggable(win, chrome);
    makeResizable(win, resizeHandle);

    document.body.appendChild(win);

    /* Populate */
    build(body, focus);

    const handle = { el: win, close };
    _wins.add(handle);
    return handle;
  }

  /* ESC closes the topmost window */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || _wins.size === 0) return;
    /* Find highest z-index among open windows */
    let topWin = null, topZ = -Infinity;
    for (const h of _wins) {
      const z = parseInt(h.el.style.zIndex || "0", 10);
      if (z > topZ) { topZ = z; topWin = h; }
    }
    if (topWin) { e.preventDefault(); topWin.close(); }
  });

  window.MacWindow = { open };
})();
