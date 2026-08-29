;;; noema-xwidget-keys.el --- Noema xwidget input bridge -*- lexical-binding: t; -*-

;; This module intentionally preserves the existing Markdown/xwidget key
;; bridge.  It owns focus transfer, Emacs key forwarding, undo/redo/Shift-Tab
;; routing, and xwidget/windmove advice as one lifecycle boundary.

;;; Code:

(require 'cl-lib)
(require 'subr-x)

(defvar my/noema--app-buffer)
(defvar my/noema--client-buffers)
(defvar my/noema--port)
(defvar xwidget-webkit-mode-map)
(defvar xwidget-webkit-edit-mode-map)
(defvar xwidget-webkit-edit-mode)
(defvar my/noema--xwidget-advice-installed nil)
(defvar my/noema--xwidget-edit-mode-advice-installed nil)
(defvar my/noema--windmove-focus-advice-installed nil)
(defvar my/xwidget--session-id)
(defvar-local my/noema--client-id nil)
(defvar-local my/noema-buffer-file-name nil)
(defvar-local my/noema--xwidget-forced-name nil)
(defvar-local my/noema--xwidget-pending-file nil)

(declare-function my/noema--buffer-for-client "init-aaronnote" (client))
(declare-function my/noema--open-file-in-web "init-aaronnote" (file))
(declare-function my/noema-command "init-aaronnote" (command &optional detail))
(declare-function my/noema-jupyter-url-p "init-aaronnote-jupyter" (url))
(declare-function my/xwidget-current-url "init-browser" (&optional buffer))
(declare-function my/xwidget-undo "init-browser" ())
(declare-function my/xwidget-redo "init-browser" ())
(declare-function xwidget-buffer "xwidget" (xwidget))
(declare-function xwidget-webkit-edit-mode "xwidget" (&optional arg))
(declare-function xwidget-webkit-current-session "xwidget" ())
(declare-function xwidget-webkit-pass-command-event "xwidget" ())
(declare-function remote-gateway-register-method "remote-gateway" (method handler))

(defvar my/noema-xwidget-recovery-mode)

(defconst my/noema--xwidget-recovery-special-keys
  '(("<escape>" . "Escape")
    ("<delete>" . "Delete")
    ("<backspace>" . "Backspace")
    ("DEL" . "Backspace")
    ("RET" . "Enter")
    ("<return>" . "Enter")
    ("TAB" . "Tab")
    ("<tab>" . "Tab")
    ("<backtab>" . "Tab")
    ("<iso-lefttab>" . "Tab")
    ("S-TAB" . "Tab")
    ("S-<tab>" . "Tab")
    ("<left>" . "ArrowLeft")
    ("<right>" . "ArrowRight")
    ("<up>" . "ArrowUp")
    ("<down>" . "ArrowDown")
    ("<home>" . "Home")
    ("<end>" . "End")
    ("<prior>" . "PageUp")
    ("<next>" . "PageDown"))
  "Noema document keys that must recover a dropped xwidget edit mode.")

(defconst my/noema--xwidget-emacs-meta-keys '(?x ?w ?q)
  "Unshifted Command keys deliberately forwarded to Emacs by the renderer.")

(defconst my/noema--xwidget-emacs-control-keys '(?x ?c ?g)
  "Ctrl host prefixes deliberately kept by Emacs instead of the renderer.")

(defun my/noema--xwidget-recovery-active-p ()
  "Return non-nil only when a Noema pane has lost xwidget edit mode."
  (and my/noema-xwidget-recovery-mode
       (my/noema--xwidget-buffer-p)
       (not (bound-and-true-p xwidget-webkit-edit-mode))))

(defun my/noema--xwidget-key-name (event)
  "Return the browser KeyboardEvent key name represented by Emacs EVENT."
  (let ((basic (event-basic-type event)))
    (cond
     ((integerp basic) (char-to-string basic))
     ((alist-get (key-description (vector basic))
                 my/noema--xwidget-recovery-special-keys nil nil #'equal))
     ((pcase basic
        ('escape "Escape") ('delete "Delete") ('backspace "Backspace")
        ('return "Enter") ('tab "Tab") ('left "ArrowLeft")
        ('right "ArrowRight") ('up "ArrowUp") ('down "ArrowDown")
        ('home "Home") ('end "End") ('prior "PageUp") ('next "PageDown")
        (_ nil))))))

(defun my/noema--xwidget-key-code (key)
  "Return a browser KeyboardEvent code for normalized KEY."
  (cond
   ((string-match-p "\\`[[:alpha:]]\\'" key)
    (concat "Key" (upcase key)))
   ((string-match-p "\\`[0-9]\\'" key) (concat "Digit" key))
   ((equal key " ") "Space")
   ((equal key "/") "Slash")
   ((equal key "[") "BracketLeft")
   ((equal key "]") "BracketRight")
   ((member key '("=" "+")) "Equal")
   ((member key '("-" "_")) "Minus")
   ((equal key "\\") "Backslash")
   ((member key '("Escape" "Delete" "Backspace" "Enter" "Tab" "ArrowLeft"
                  "ArrowRight" "ArrowUp" "ArrowDown" "Home" "End" "PageUp"
                  "PageDown")) key)
   (t "")))

(defun my/noema--xwidget-recovery-detail (event)
  "Return the shared Noema key payload for Emacs EVENT."
  (when-let* ((key (my/noema--xwidget-key-name event)))
    (let ((modifiers (event-modifiers event)))
      `((key . ,key)
        (code . ,(my/noema--xwidget-key-code key))
        (metaKey . ,(and (memq 'meta modifiers) t))
        (ctrlKey . ,(and (memq 'control modifiers) t))
        (altKey . ,(and (or (memq 'alt modifiers) (memq 'hyper modifiers)) t))
        (shiftKey . ,(and (memq 'shift modifiers) t))))))

(defun my/noema--forward-recovery-key (buffer detail)
  "Forward DETAIL for Noema BUFFER outside the originating Emacs key command."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      ;; The renderer's host-key adapter feeds the same Vim/CM6 command table
      ;; as a native event. Emacs never evaluates JavaScript or waits for a
      ;; WebKit result on this exceptional recovery path.
      (my/noema-command "key" detail))))

(defun my/noema-xwidget-recover-key (event)
  "Deliver EVENT after a Noema xwidget pane has dropped edit focus."
  (interactive "e")
  (when-let* ((detail (my/noema--xwidget-recovery-detail event)))
    (run-at-time 0 nil #'my/noema--forward-recovery-key
                 (current-buffer) detail)
    (when-let* ((window (get-buffer-window (current-buffer) 'visible)))
      (my/noema--focus-xwidget-window window))))

(defvar my/noema-xwidget-recovery-mode-map
  (let ((map (make-sparse-keymap))
        (binding #'my/noema-xwidget-recover-key))
    ;; Printable keys cover every Vim operator/motion as well as Insert text,
    ;; but only during the exceptional edit-mode-off state. Normal typing is
    ;; never routed through Emacs or the gateway.
    (dotimes (offset 95)
      (let ((character (+ 32 offset)))
        (define-key map (char-to-string character) binding)
        ;; The renderer forwards only unshifted Cmd-X/W/Q to Emacs. Every
        ;; other Command+printable chord belongs to the shared web editor
        ;; (source toggle, history, formatting, find, save, zoom, CM6, ...).
        (unless (memq character my/noema--xwidget-emacs-meta-keys)
          (define-key map
                      (vector (event-convert-list (list 'meta character)))
                      binding))
        ;; An inert placeholder cannot meaningfully execute ordinary C-a/C-e
        ;; movement, C-d deletion, C-z history, or C-0 zoom. Recover all Ctrl
        ;; printable keys through the shared renderer except the explicit
        ;; Emacs host prefixes C-x/C-c and keyboard-quit C-g.
        (when (and (string-match-p "\\`[[:alnum:]]\\'"
                                   (char-to-string character))
                   (not (memq (downcase character)
                              my/noema--xwidget-emacs-control-keys)))
          (define-key map
                      (vector (event-convert-list
                               (list 'control character)))
                      binding))))
    (dolist (entry my/noema--xwidget-recovery-special-keys)
      (let ((basic (event-basic-type (aref (kbd (car entry)) 0))))
        (when basic
          ;; Named navigation/editing controls are never forwarded by the
          ;; renderer's Emacs chord gate, with or without these modifiers.
          (dolist (modifiers '(nil (shift) (meta) (meta shift) (control)
                                (control shift)))
            (define-key map
                        (vector (event-convert-list
                                 (append modifiers (list basic))))
                        binding)))))
    map)
  "Conditional recovery keys for a Noema xwidget pane.")

(defvar my/noema--xwidget-recovery-emulation-alist
  `((my/noema-xwidget-recovery-mode . ,my/noema-xwidget-recovery-mode-map))
  "High-precedence recovery map while a Noema xwidget is not editing.")

;; `windmove-mode' and similar global UI modes use emulation maps, which are
;; consulted before ordinary minor-mode maps. Recovery represents the page
;; that still owns this pane, so it must precede those maps only while its
;; buffer-local mode variable is non-nil.
(add-to-list 'emulation-mode-map-alists
             'my/noema--xwidget-recovery-emulation-alist)

(define-minor-mode my/noema-xwidget-recovery-mode
  "Recover Noema document keys only when xwidget edit mode drops."
  :init-value nil
  :lighter nil
  :keymap my/noema-xwidget-recovery-mode-map)

(defconst my/noema--xwidget-placeholder-mode-whitelist
  '(xwidget-webkit-edit-mode
    my/noema-keys-mode
    my/noema-xwidget-recovery-mode)
  "Local modes that belong to the Noema xwidget shell itself.")

(defun my/noema--harden-xwidget-placeholder (&optional buffer)
  "Make Noema xwidget BUFFER an inert, non-editable Emacs placeholder.
The actual document, history, completion, syntax and input state live in the
shared CM6 renderer. This buffer retains only xwidget identity/chrome modes."
  (let ((buffer (or buffer (current-buffer))))
    (when (and (buffer-live-p buffer)
               (my/noema--xwidget-buffer-p buffer))
      (with-current-buffer buffer
        ;; Globalized plugins often turn on a buffer-local worker during a
        ;; major-mode transition. Disable every such local mode except the
        ;; three explicit host-shell modes above; never toggle a genuinely
        ;; global mode from one placeholder buffer.
        (dolist (mode minor-mode-list)
          (when (and (local-variable-p mode)
                     (boundp mode)
                     (symbol-value mode)
                     (fboundp mode)
                     (not (memq mode
                                my/noema--xwidget-placeholder-mode-whitelist)))
            (ignore-errors (funcall mode -1))))
        (when (fboundp 'font-lock-mode) (font-lock-mode -1))
        (when (fboundp 'display-line-numbers-mode)
          (display-line-numbers-mode -1))
        (when (fboundp 'visual-line-mode) (visual-line-mode -1))
        (when (fboundp 'hl-line-mode) (hl-line-mode -1))
        (when (fboundp 'whitespace-mode) (whitespace-mode -1))
        (setq-local buffer-read-only t)
        (setq-local buffer-undo-list t)
        (setq-local buffer-auto-save-file-name nil)
        (setq-local completion-at-point-functions nil)
        (setq-local eldoc-documentation-functions nil)
        (setq-local syntax-propertize-function nil)
        (setq-local fontification-functions nil)
        (setq-local cursor-type nil)
        (setq-local bidi-display-reordering nil)
        (setq-local bidi-paragraph-direction 'left-to-right)
        (setq-local bidi-inhibit-bpa t)
        ;; A generic browser focus helper may inject JS synchronously. Noema's
        ;; shell arms native edit mode and sends the shared `focus' command via
        ;; its asynchronous host channel instead.
        (when (boundp 'my/xwidget-focus-script)
          (setq-local my/xwidget-focus-script nil))
        (set-buffer-modified-p nil)))))

(defun my/noema--sync-xwidget-recovery-mode (&rest _)
  "Enable recovery keys exactly while this Noema xwidget is not editing.
This is driven by `xwidget-webkit-edit-mode' transitions, so there is no
timer, polling, or per-key mode detection on the normal typing path."
  (when (my/noema--xwidget-buffer-p)
    (my/noema-xwidget-recovery-mode
     (if (bound-and-true-p xwidget-webkit-edit-mode) -1 1))))

(defun my/noema--identity-random-hex ()
  "Return 20 hexadecimal random digits for a Noema UUIDv7."
  (let* ((seed (if (fboundp 'gnutls-random)
                   (gnutls-random 32)
                 (format "%s:%s:%s:%s"
                         (float-time) (emacs-pid) (random) (recent-keys))))
         (digest (secure-hash 'sha256 seed)))
    (substring digest 0 20)))

(defun my/noema-new-id (&optional kind)
  "Return a UUIDv7 for Noema identity KIND.
KIND is one of page, block, or repository and documents the caller; the UUID
wire format intentionally remains standard and kind-neutral."
  (let* ((kind-name (if (symbolp kind) (symbol-name kind) (or kind "page")))
         (_ (unless (member kind-name '("page" "block" "repository"))
              (error "Unsupported Noema identity kind: %s" kind-name)))
         (millis (floor (* 1000 (float-time))))
         (time-hex (format "%012x" millis))
         (random-hex (my/noema--identity-random-hex))
         (variant (+ 8 (% (string-to-number (substring random-hex 3 4) 16) 4))))
    (format "%s-%s-7%s-%x%s-%s"
            (substring time-hex 0 8)
            (substring time-hex 8 12)
            (substring random-hex 0 3)
            variant
            (substring random-hex 4 7)
            (substring random-hex 7 19))))

(defun my/noema--select-emacs-window (&optional window)
  "Select WINDOW and ask the window system to focus its frame."
  (let ((window (or window (selected-window))))
    (when (window-live-p window)
      (select-window window)
      (when (fboundp 'select-frame-set-input-focus)
        (ignore-errors
          (select-frame-set-input-focus (window-frame window)))))))

(defun my/noema--focus-minibuffer-if-active ()
  "Move focus to the active minibuffer after a forwarded Noema key."
  (when-let* ((window (active-minibuffer-window)))
    (my/noema--select-emacs-window window)))

(defun noema-xwidget--choose-note-path (params _client)
  "Choose a note path requested by Noema using Emacs PARAMS.
The gateway response contains both the absolute path and its path relative to
the authorized repository root.  Cancelling the minibuffer is reported as a
normal result rather than a gateway error."
  (let* ((root (file-name-as-directory
                (expand-file-name
                 (format "%s" (or (alist-get 'root params) default-directory)))))
         (default-path (expand-file-name
                        (format "%s" (or (alist-get 'defaultPath params) root))))
         (title (format "%s" (or (alist-get 'title params) "Choose note path")))
         (kind (format "%s" (or (alist-get 'kind params) "directory"))))
    (condition-case nil
        (let* ((chosen
                (minibuffer-with-setup-hook
                    #'my/noema--focus-minibuffer-if-active
                  (if (string= kind "file")
                      (read-file-name (concat title ": ") root default-path nil)
                    (read-directory-name (concat title ": ") root default-path nil))))
               (absolute (expand-file-name chosen))
               (comparison (if (string= kind "file")
                               (file-name-directory absolute)
                             (file-name-as-directory absolute))))
          (unless (string-prefix-p root comparison)
            (user-error "Noema path must stay inside %s" root))
          (let ((relative (file-relative-name absolute root)))
            `((ok . t)
              (canceled . :json-false)
              (path . ,absolute)
              (relativePath . ,(if (string= relative ".") ""
                                 (directory-file-name relative))))))
      (quit '((ok . t) (canceled . t) (path . "") (relativePath . ""))))))

(when (fboundp 'remote-gateway-register-method)
  (remote-gateway-register-method
   "aaronnote.note.choose-path" #'noema-xwidget--choose-note-path))

(defun my/noema--release-xwidget-input-buffer (&optional buffer)
  "Exit xwidget edit mode in BUFFER when it is an Noema xwidget."
  (let ((buffer (or buffer my/noema--app-buffer)))
    (when (and (buffer-live-p buffer)
               (fboundp 'xwidget-webkit-edit-mode))
      (with-current-buffer buffer
        (when (eq major-mode 'xwidget-webkit-mode)
          (ignore-errors (xwidget-webkit-edit-mode -1)))))))

(defun my/noema--focus-xwidget-window (window)
  "Focus Noema xwidget WINDOW like a direct window click."
  (when (window-live-p window)
    (condition-case nil
        (let ((buffer (window-buffer window)))
          (when (my/noema--xwidget-buffer-p buffer)
            (select-window window)
            (my/noema--select-emacs-window window)
            (setq my/noema--app-buffer buffer)
            (when (fboundp 'xwidget-webkit-edit-mode)
              (with-current-buffer buffer
                (ignore-errors (xwidget-webkit-edit-mode 1))))
            ;; Notification-only: no JavaScript evaluation and no reply wait
            ;; in Emacs' focus/window command path.
            (with-current-buffer buffer
              (my/noema-command "focus"))))
      (quit
       (when (fboundp 'my/noema--record-interrupted-operation)
         (my/noema--record-interrupted-operation "xwidget focus handoff"))))))

(defun my/noema--focus-xwidget-buffer (buffer)
  "Asynchronously arm the visible Noema xwidget BUFFER for page input."
  (when-let* ((window (and (buffer-live-p buffer)
                           (get-buffer-window buffer 'visible))))
    (my/noema--focus-xwidget-window window)))

(defun my/noema--focus-xwidget-window-if-still-selected (window buffer)
  "Focus WINDOW's xwidget if WINDOW still displays BUFFER and is selected."
  (when (and (window-live-p window)
             (eq window (selected-window))
             (eq (window-buffer window) buffer))
    (my/noema--focus-xwidget-window window)))

(defun my/noema--focus-selected-window-after-move (&optional source-window)
  "Restore input focus after selection moves away from SOURCE-WINDOW.
If the target is Noema, enter xwidget edit focus.  If the source was
Noema and the target is a normal Emacs window, restore Emacs frame focus."
  (let ((target-window (selected-window)))
    (when (and (window-live-p target-window)
               (or (not (window-live-p source-window))
                   (not (eq target-window source-window))))
      (let ((target-buffer (window-buffer target-window))
            (source-buffer (and (window-live-p source-window)
                                (window-buffer source-window))))
        (when (and source-buffer
                   (my/noema--xwidget-buffer-p source-buffer))
          (my/noema--release-xwidget-input-buffer source-buffer))
        (cond
         ((my/noema--xwidget-buffer-p target-buffer)
          (my/noema--focus-xwidget-window target-window)
          (run-at-time 0.05 nil
                       #'my/noema--focus-xwidget-window-if-still-selected
                       target-window target-buffer))
         ((and source-buffer
               (my/noema--xwidget-buffer-p source-buffer))
          (my/noema--select-emacs-window target-window)))))))

(defun my/noema--focus-forwarded-key-target (&optional source-window)
  "Restore input focus after an Noema-forwarded key leaves SOURCE-WINDOW."
  (if (active-minibuffer-window)
      (my/noema--focus-minibuffer-if-active)
    (my/noema--focus-selected-window-after-move source-window)))

(defun my/noema--windmove-focus-advice (orig-fun &rest args)
  "Around advice for windmove commands to focus Noema targets correctly."
  (let ((source-window (selected-window)))
    (prog1 (apply orig-fun args)
      (my/noema--focus-selected-window-after-move source-window))))

(defun my/noema--release-xwidget-input ()
  "Exit Noema xwidget edit mode before Emacs handles forwarded keys."
  (my/noema--release-xwidget-input-buffer my/noema--app-buffer))

(defun my/noema--queue-emacs-key (keys key-string)
  "Queue KEYS forwarded from Noema for Emacs' normal command loop.
KEY-STRING is used only for diagnostics."
  (let ((binding (key-binding keys)))
    (cond
     ((or (commandp binding) (keymapp binding))
      (setq unread-command-events
            (nconc (listify-key-sequence keys)
                   unread-command-events))
      (run-at-time 0.05 nil #'my/noema--focus-forwarded-key-target
                   (selected-window)))
     (t
      (message "Noema: no binding for %s" key-string)))))

(defun my/noema--key-source-buffer (&optional client)
  "Return the Noema buffer that forwarded a key for CLIENT."
  (or (my/noema--buffer-for-client client)
      (let ((selected-buffer (window-buffer (selected-window))))
        (and (my/noema--xwidget-buffer-p selected-buffer)
             selected-buffer))
      (and (buffer-live-p my/noema--app-buffer)
           my/noema--app-buffer)))

(defun my/noema--key-source-window (&optional client)
  "Return the visible window that forwarded a key for CLIENT."
  (let ((source-buffer (my/noema--key-source-buffer client)))
    (or (and (buffer-live-p source-buffer)
             (get-buffer-window source-buffer 'visible))
        (let ((window (selected-window)))
          (and (window-live-p window)
               (my/noema--xwidget-buffer-p (window-buffer window))
               window)))))

(defun my/noema--run-emacs-key (key-string &optional client)
  "Execute Emacs key KEY-STRING forwarded from the Noema browser.
CLIENT, when non-nil, identifies the Noema xwidget that sent the key."
  (condition-case err
      (let ((keys (ignore-errors (kbd key-string))))
        (when (and keys (> (length keys) 0))
          (let ((source-buffer (my/noema--key-source-buffer client))
                (win (my/noema--key-source-window client)))
            (my/noema--release-xwidget-input-buffer source-buffer)
            (if (window-live-p win)
                (progn
                  (my/noema--select-emacs-window win)
                  (my/noema--queue-emacs-key keys key-string))
              (my/noema--select-emacs-window)
              (my/noema--queue-emacs-key keys key-string)))))
    (error
     (message "Noema key forward failed (%s): %s"
              key-string (error-message-string err)))))

(defun my/noema--xwidget-buffer-p (&optional buffer)
  "Return non-nil when BUFFER hosts the local Noema xwidget page."
  (let ((buffer (or buffer (current-buffer))))
    (and (buffer-live-p buffer)
         (or (eq buffer my/noema--app-buffer)
             (with-current-buffer buffer
               (and (eq major-mode 'xwidget-webkit-mode)
                    (or
                     my/noema--client-id
                     my/noema-buffer-file-name
                     my/noema--xwidget-forced-name
                     (and (integerp my/noema--port)
                          (fboundp 'my/xwidget-current-url)
                          (when-let* ((url (my/xwidget-current-url buffer)))
                            (string-prefix-p
                             (format "http://127.0.0.1:%d/" my/noema--port)
                             url))))))))))

(defun my/noema--jupyter-xwidget-buffer-p (&optional buffer)
  "Return non-nil when BUFFER hosts the Noema-owned Jupyter xwidget page."
  (let ((buffer (or buffer (current-buffer))))
    (and (buffer-live-p buffer)
         (with-current-buffer buffer
           (and (eq major-mode 'xwidget-webkit-mode)
                (or (equal (and (boundp 'my/xwidget--session-id)
                                my/xwidget--session-id)
                           "aaronnote-jupyter")
                    (and (progn
                           (unless (fboundp 'my/noema-jupyter-url-p)
                             (require 'init-aaronnote-jupyter nil t))
                           (fboundp 'my/noema-jupyter-url-p))
                         (fboundp 'my/xwidget-current-url)
                         (when-let* ((url (my/xwidget-current-url buffer)))
                           (my/noema-jupyter-url-p url)))))))))

(defun my/noema--pass-xwidget-command-event (event)
  "Pass EVENT through to xwidget when the current buffer is not Noema.
A nil EVENT means the command was run by name rather than from a key, and
there is nothing to pass on."
  (when event
    ;; The command takes no argument -- it reads `last-command-event' itself,
    ;; which is already EVENT here because every caller is an `interactive "e"'
    ;; command.  Passing one signalled wrong-number-of-arguments, so this
    ;; fallback used to error instead of passing anything through.
    (if (fboundp 'xwidget-webkit-pass-command-event)
        (xwidget-webkit-pass-command-event)
      (setq unread-command-events
            (nconc (list event) unread-command-events)))))

(defun my/noema--jupyter-xwidget-command (event command)
  "Route xwidget EVENT/COMMAND to Jupyter, or pass EVENT through."
  (pcase command
    ("undo"
     (if (fboundp 'my/xwidget-undo)
         (my/xwidget-undo)
       (my/noema--pass-xwidget-command-event event)))
    ("redo"
     (if (fboundp 'my/xwidget-redo)
         (my/xwidget-redo)
       (my/noema--pass-xwidget-command-event event)))
    (_
     (my/noema--pass-xwidget-command-event event))))

(defun my/noema--xwidget-editor-command (event command &optional detail)
  "Route xwidget EVENT to Noema COMMAND, or pass it through otherwise."
  (cond
   ((my/noema--xwidget-buffer-p)
    (my/noema-command command detail))
   ((my/noema--jupyter-xwidget-buffer-p)
    (my/noema--jupyter-xwidget-command event command))
   (t
    (my/noema--pass-xwidget-command-event event))))

(defun my/noema-xwidget-undo (event)
  "Route Command-z / Meta-z from Noema xwidget to web undo."
  (interactive "e")
  (my/noema--xwidget-editor-command event "undo"))

(defun my/noema-xwidget-redo (event)
  "Route Command-Shift-z / Meta-Shift-z from Noema xwidget to web redo."
  (interactive "e")
  (my/noema--xwidget-editor-command event "redo"))

(defun my/noema-xwidget-shift-tab (event)
  "Route Shift-Tab to Noema in xwidget without losing the Shift modifier."
  (interactive "e")
  (my/noema--xwidget-editor-command
   event
   "key"
   '((key . "Tab")
     (shiftKey . t))))

;; Clipboard.  On the macOS (NS) port `xwidget-webkit-pass-command-event' is a
;; no-op: xwidget.c can replay a Lisp key into the widget only under GTK, and
;; the Cocoa backend implements no counterpart -- `nm' on the Emacs binary shows
;; nsxwidget_{init,resize,webkit_execute_script,...} and no
;; nsxwidget_perform_lispy_event.  So every key Emacs binds to that command in
;; an xwidget buffer is simply swallowed, Cmd-C and Cmd-V included, and neither
;; copy nor paste ever happens.  Route them to Noema instead, which performs the
;; copy in the page and moves the text through the web host's own pasteboard
;; access rather than through WebKit's.

(defun my/noema-xwidget-copy (event)
  "Route Command-c / Meta-c from a Noema xwidget to the page's copy."
  (interactive "e")
  (my/noema--xwidget-editor-command event "copy"))

(defun my/noema-xwidget-cut (&optional event)
  "Route a cut request from a Noema xwidget to the page's cut.
Unlike the other routed commands this one has no key of its own: Cmd-x stays
Emacs' `execute-extended-command'.  It therefore takes EVENT optionally, so it
can be run by name until a key is chosen for it."
  (interactive (list last-input-event))
  (my/noema--xwidget-editor-command event "cut"))

(defun my/noema-xwidget-paste (event)
  "Route Command-v / Meta-v from a Noema xwidget to the page's paste."
  (interactive "e")
  (my/noema--xwidget-editor-command event "paste"))

(defun my/noema--install-xwidget-keys ()
  "Install Noema's xwidget key routing on the shared xwidget keymaps.

Re-applied from `xwidget-webkit-mode-hook' as well as at load time: the
clipboard keys are also claimed by the generic browser configuration, and the
two `with-eval-after-load' blocks have no defined order between them."
  (dolist (map (list xwidget-webkit-mode-map xwidget-webkit-edit-mode-map))
    (dolist (key '("M-z"))
      (define-key map (kbd key) #'my/noema-xwidget-undo))
    (dolist (key '("M-Z" "M-S-z"))
      (define-key map (kbd key) #'my/noema-xwidget-redo))
    (dolist (key '("M-c"))
      (define-key map (kbd key) #'my/noema-xwidget-copy))
    (dolist (key '("M-v"))
      (define-key map (kbd key) #'my/noema-xwidget-paste))
    (dolist (key '("<backtab>" "<iso-lefttab>" "S-TAB" "S-<tab>"))
      (define-key map (kbd key) #'my/noema-xwidget-shift-tab))))

(defun my/noema--xwidget-callback-advice (_xwidget _event-type)
  "After xwidget callback: fire pending file POST on load-finished."
  (when (and (eq _event-type 'load-changed)
             (string-equal (nth 3 last-input-event) "load-finished"))
    (let ((buf (and (fboundp 'xwidget-buffer)
                    (xwidget-buffer _xwidget))))
      (when (buffer-live-p buf)
        (with-current-buffer buf
          (when my/noema--xwidget-pending-file
            (let ((file my/noema--xwidget-pending-file)
                  (pending-buf (current-buffer)))
              (setq-local my/noema--xwidget-pending-file nil)
              (run-at-time 0.3 nil
                           (lambda ()
                             (when (buffer-live-p pending-buf)
                               (my/noema--open-file-in-web file)))))))))))

(defun my/noema--install-windmove-focus-advice ()
  "Install focus repair advice for windmove transitions involving Noema."
  (unless my/noema--windmove-focus-advice-installed
    (dolist (command '(windmove-left windmove-right windmove-up windmove-down))
      (when (fboundp command)
        (advice-add command :around #'my/noema--windmove-focus-advice)))
    (setq my/noema--windmove-focus-advice-installed t)))

(with-eval-after-load 'xwidget
  (unless my/noema--xwidget-advice-installed
    (advice-add 'xwidget-webkit-callback :after
                #'my/noema--xwidget-callback-advice)
    (setq my/noema--xwidget-advice-installed t))
  (unless my/noema--xwidget-edit-mode-advice-installed
    (advice-add 'xwidget-webkit-edit-mode :after
                #'my/noema--sync-xwidget-recovery-mode)
    (setq my/noema--xwidget-edit-mode-advice-installed t))
  (my/noema--install-xwidget-keys)
  (add-hook 'xwidget-webkit-mode-hook #'my/noema--install-xwidget-keys))

(with-eval-after-load 'windmove
  (my/noema--install-windmove-focus-advice))

(provide 'noema-xwidget-keys)
;;; noema-xwidget-keys.el ends here
