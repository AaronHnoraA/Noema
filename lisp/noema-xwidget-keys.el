;;; noema-xwidget-keys.el --- Noema xwidget input bridge -*- lexical-binding: t; -*-

;; This module intentionally preserves the existing Markdown/xwidget key
;; bridge.  It owns focus transfer, Emacs key forwarding, undo/redo/Shift-Tab
;; routing, and xwidget/windmove advice as one lifecycle boundary.

;;; Code:

(require 'cl-lib)
(require 'seq)
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

(defconst my/noema--xwidget-emacs-meta-keys '(?x ?w ?W ?q ?o ?O)
  "Command keys deliberately forwarded to Emacs by the renderer.")

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
  (interactive (list last-command-event))
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
        ;; The renderer forwards Cmd-X/W/Q and Cmd-O/Shift-O to Emacs. Every
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
            ;; M-<arrow> is windmove in every Emacs window, a Noema pane
            ;; included: the page forwards Cmd+Arrow for the same reason.
            (unless (and (equal modifiers '(meta))
                         (memq basic '(left right up down)))
              (define-key map
                          (vector (event-convert-list
                                   (append modifiers (list basic))))
                          binding))))))
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
  "Deliver Noema document keys that reach Emacs instead of the page.
Emacs receives a pane's keys only while WebKit lacks the native keyboard."
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
  "Keep recovery keys on in every Noema xwidget pane.
Emacs sees a pane's keys only while WebKit lacks the native keyboard: the
page hands it to Emacs whenever Emacs takes the keyboard, and on macOS Emacs
cannot give it back (`xwidget-webkit-pass-command-event' is GTK-only), so a
pane entered from the keyboard receives its keys through this map until it
is clicked.  While WebKit holds the keyboard, Emacs never sees them, so the
map costs nothing on the normal typing path.  Driven by
`xwidget-webkit-edit-mode' transitions; no timer or polling."
  (when (my/noema--xwidget-buffer-p)
    (my/noema-xwidget-recovery-mode 1)))

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
          (ignore-errors (xwidget-webkit-edit-mode -1))
          ;; Tell the page too: macOS still offers WebKit arrows and other
          ;; function keys, which must not pull the keyboard back to it.
          ;; Every Noema page honours this (aaronnote/host-keyboard.ts); a
          ;; pane without a client id receives it as a broadcast.
          (my/noema-command "host-owns-keyboard"))))))

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
  "Arm BUFFER for page input only if it still owns the selected pane."
  (when (and (buffer-live-p buffer)
             (eq buffer (window-buffer (selected-window))))
    (my/noema--focus-xwidget-window (selected-window))))

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

(defvar my/noema--forwarded-command nil
  "While a key forwarded from a Noema page runs: (SOURCE-WINDOW . SNAPSHOT).
SNAPSHOT maps each window to the buffer it showed before the command.")

(defconst my/noema--forwarded-command-patience 6
  "Commands to wait for a forwarded command to settle before giving up.
Prefix arguments and transient menus take several commands to finish.")

(defvar my/noema--forwarded-command-countdown 0
  "Commands left before `my/noema--after-forwarded-command' gives up.")

(defun my/noema--window-snapshot ()
  "Return (WINDOW . BUFFER) for every window of the selected frame."
  (mapcar (lambda (window) (cons window (window-buffer window)))
          (window-list nil 'no-minibuf)))

(defun my/noema--forwarded-result-window (source snapshot)
  "Return the ordinary window a forwarded command opened or changed, or nil.
SOURCE is the Noema pane's window and SNAPSHOT the windows before the command.
Internal buffers (a leading space) and Noema pages are never a result."
  (let ((ordinary (lambda (window)
                    (let ((buffer (window-buffer window)))
                      (and (not (eq window source))
                           (not (string-prefix-p " " (buffer-name buffer)))
                           (not (my/noema--xwidget-buffer-p buffer)))))))
    (if (funcall ordinary (selected-window))
        (selected-window)
      (seq-find (lambda (window)
                  (and (funcall ordinary window)
                       (not (eq (cdr (assq window snapshot)) (window-buffer window)))))
                (window-list nil 'no-minibuf)))))

(defun my/noema--after-forwarded-command ()
  "Give the keyboard to what a command forwarded from a Noema page opened.
A key sent from the page (M-x, C-c A ..., H-...) runs in Emacs; when it shows
an agent session, a compose buffer, Treemacs, a terminal, ..., focus follows
it there instead of returning to the page's editor.  Waits out a pending
prefix argument, minibuffer or transient menu."
  (cond
   ;; Typing in the minibuffer (an M-x name, a prompt) is part of the same
   ;; command and may take any number of keys.
   ((active-minibuffer-window))
   ((or prefix-arg (bound-and-true-p transient--prefix))
    (when (<= (cl-decf my/noema--forwarded-command-countdown) 0)
      (my/noema--forget-forwarded-command)))
   (t
    (pcase-let ((`(,source . ,snapshot) my/noema--forwarded-command))
      (my/noema--forget-forwarded-command)
      (if-let* ((window (my/noema--forwarded-result-window source snapshot)))
          (my/noema--give-keyboard-to-result source window)
        ;; Nothing visible changed yet.  The pane keeps the keyboard, and a
        ;; window the command shows later (a process starting an agent, a
        ;; terminal, a compose buffer) still takes it within the grace period.
        (when (and (eq (selected-window) source)
                   (my/noema--xwidget-buffer-p (window-buffer source)))
          (my/noema--focus-xwidget-window source))
        (my/noema--await-forwarded-result source snapshot))))))

(defun my/noema--give-keyboard-to-result (source window)
  "Move the keyboard from Noema pane window SOURCE to result WINDOW."
  (when (and (window-live-p source)
             (my/noema--xwidget-buffer-p (window-buffer source)))
    (my/noema--release-xwidget-input-buffer (window-buffer source)))
  (my/noema--select-emacs-window window))

(defvar my/noema-forwarded-command-grace 2.0
  "Seconds a forwarded command may take to show its result window.
Commands that start a process display their buffer after they return; the
keyboard follows such a window only while the originating pane is still
selected, so a person who has moved on is never pulled back.")

(defvar my/noema--forwarded-await nil
  "(SOURCE SNAPSHOT TIMER) while waiting for a late forwarded result.")

(defun my/noema--stop-awaiting-forwarded-result ()
  "Stop waiting for a late forwarded result."
  (when-let* ((timer (nth 2 my/noema--forwarded-await)))
    (cancel-timer timer))
  (setq my/noema--forwarded-await nil)
  (remove-hook 'window-buffer-change-functions #'my/noema--forwarded-result-appeared))

(defun my/noema--await-forwarded-result (source snapshot)
  "Follow a window shown late on behalf of pane SOURCE, given SNAPSHOT."
  (my/noema--stop-awaiting-forwarded-result)
  (when (and (window-live-p source) (> my/noema-forwarded-command-grace 0))
    (setq my/noema--forwarded-await
          (list source snapshot
                (run-at-time my/noema-forwarded-command-grace nil
                             #'my/noema--stop-awaiting-forwarded-result)))
    (add-hook 'window-buffer-change-functions #'my/noema--forwarded-result-appeared)))

(defun my/noema--forwarded-result-appeared (&optional _frame)
  "Give the keyboard to a window a forwarded command showed late."
  (pcase-let ((`(,source ,snapshot ,_timer) my/noema--forwarded-await))
    (cond
     ((not (and (window-live-p source) (eq (selected-window) source)))
      (my/noema--stop-awaiting-forwarded-result))
     ((active-minibuffer-window))
     (t
      (when-let* ((window (my/noema--forwarded-result-window source snapshot)))
        (my/noema--stop-awaiting-forwarded-result)
        (my/noema--give-keyboard-to-result source window))))))

(defun my/noema--forget-forwarded-command ()
  "Stop following the last forwarded command."
  (setq my/noema--forwarded-command nil)
  (remove-hook 'post-command-hook #'my/noema--after-forwarded-command))

(defun my/noema--follow-forwarded-command (source)
  "Follow the next command's result on behalf of Noema pane window SOURCE."
  (my/noema--stop-awaiting-forwarded-result)
  (setq my/noema--forwarded-command (cons source (my/noema--window-snapshot))
        my/noema--forwarded-command-countdown my/noema--forwarded-command-patience)
  (add-hook 'post-command-hook #'my/noema--after-forwarded-command))

(defun my/noema--queue-emacs-key (keys key-string)
  "Queue KEYS forwarded from Noema for Emacs' normal command loop.
KEY-STRING is used only for diagnostics."
  (let ((binding (key-binding keys)))
    (cond
     ((or (commandp binding) (keymapp binding))
      (setq unread-command-events
            (nconc (listify-key-sequence keys)
                   unread-command-events))
      (my/noema--follow-forwarded-command (selected-window))
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

(defun my/noema--run-emacs-text (text)
  "Type TEXT into Emacs' selected window, as if typed there.
The Noema page forwards characters it received while Emacs owned the
keyboard; macOS keeps a clicked WebKit view as the keyboard's target."
  (setq unread-command-events
        (nconc (string-to-list text) unread-command-events)))

(defun my/noema--run-emacs-key (key-string &optional client host-owned)
  "Execute Emacs key KEY-STRING forwarded from the Noema browser.
CLIENT, when non-nil, identifies the Noema xwidget that sent the key.
HOST-OWNED means WebKit received the key although Emacs owns the keyboard
\(macOS offers it arrows first); it runs where Emacs is, without moving to
the page's pane."
  (condition-case err
      (let ((keys (ignore-errors (kbd key-string))))
        (when (and keys (> (length keys) 0) host-owned)
          (setq unread-command-events
                (nconc (listify-key-sequence keys) unread-command-events))
          (setq keys nil))
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
  (interactive (list last-command-event))
  (my/noema--xwidget-editor-command event "undo"))

(defun my/noema-xwidget-redo (event)
  "Route Command-Shift-z / Meta-Shift-z from Noema xwidget to web redo."
  (interactive (list last-command-event))
  (my/noema--xwidget-editor-command event "redo"))

(defun my/noema-xwidget-shift-tab (event)
  "Route Shift-Tab to Noema in xwidget without losing the Shift modifier."
  (interactive (list last-command-event))
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
  (interactive (list last-command-event))
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
  (interactive (list last-command-event))
  (my/noema--xwidget-editor-command event "paste"))

;; `(interactive "e")' demands a parameterized (mouse-style) event, so every
;; keyboard binding of the commands above used to signal "must be bound to an
;; event with parameters" -- Cmd-C/V/Z never reached the page.  They read
;; `last-command-event' instead, which is also what the pass-through needs.

;;;; Pane commands: Emacs text commands, performed by the page
;;
;; The placeholder buffer has no text, so an Emacs command that reads or edits
;; "the buffer" does nothing there.  `my/noema-keys-mode-map' remaps the common
;; ones onto these, which ask the page to do the same thing.

(defun my/noema-refresh-file (&optional discard)
  "Reload this Noema pane's note from disk, e.g. after an agent edited it.
Unlike a plain refresh this never writes the pane's draft over the file.  A
pane with unsaved edits refuses; with prefix argument DISCARD it drops them."
  (interactive "P")
  (my/noema-command "refresh-file"
                    (when discard '((value . "discard")))))

(defun my/noema-outline ()
  "Toggle the Noema page's live outline."
  (interactive)
  (my/noema-command "toggle-toc"))

(defun my/noema--pane-headings (file)
  "Return (LABEL . LINE) for each ATX heading of FILE on disk.
Fenced code blocks are skipped.  The page autosaves, so disk trails the page
by at most its autosave delay."
  (with-temp-buffer
    (insert-file-contents file)
    (goto-char (point-min))
    (let (headings fence)
      (while (not (eobp))
        (cond
         ((looking-at "^[ \t]*\\(```\\|~~~\\)")
          (setq fence (not fence)))
         ((and (not fence) (looking-at "^\\(#\\{1,6\\}\\)[ \t]+\\(.*?\\)[ \t#]*$"))
          (push (cons (concat (make-string (* 2 (1- (length (match-string 1)))) ?\s)
                              (match-string 2))
                      (line-number-at-pos))
                headings)))
        (forward-line 1))
      (nreverse headings))))

(defun my/noema-goto-heading ()
  "Jump the Noema page to a heading chosen in the minibuffer."
  (interactive)
  (let* ((file (or my/noema-buffer-file-name
                   (user-error "This Noema pane shows no file")))
         (headings (or (my/noema--pane-headings file)
                       (user-error "No headings in %s" (file-name-nondirectory file))))
         (label (completing-read "Heading: "
                                 (lambda (string predicate action)
                                   (if (eq action 'metadata)
                                       '(metadata (display-sort-function . identity))
                                     (complete-with-action action headings string predicate)))
                                 nil t)))
    (my/noema-command "goto-line"
                      `((value . ,(cdr (assoc label headings)))))))

(defun my/noema-find ()
  "Open the Noema page's find panel."
  (interactive)
  (my/noema-command "find"))

(defun my/noema-select-all ()
  "Select the whole note in the Noema page."
  (interactive)
  (my/noema-command "select-all"))

(defun my/noema-pane-copy ()
  "Copy the Noema page's selection (a Jupyter output selection included)."
  (interactive)
  (my/noema-xwidget-copy last-command-event))

(defun my/noema-pane-paste ()
  "Paste into the Noema page."
  (interactive)
  (my/noema-xwidget-paste last-command-event))

(defun my/noema-pane-cut ()
  "Cut the Noema page's selection."
  (interactive)
  (my/noema-xwidget-cut last-command-event))

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
