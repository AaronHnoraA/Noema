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
(defvar my/noema--xwidget-advice-installed nil)
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
(declare-function my/xwidget-focus "init-browser" (&optional buffer))
(declare-function my/xwidget-undo "init-browser" ())
(declare-function my/xwidget-redo "init-browser" ())
(declare-function xwidget-buffer "xwidget" (xwidget))
(declare-function xwidget-webkit-edit-mode "xwidget" (&optional arg))
(declare-function xwidget-webkit-pass-command-event "xwidget" (event))

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
    (let ((buffer (window-buffer window)))
      (when (my/noema--xwidget-buffer-p buffer)
        (select-window window)
        (my/noema--select-emacs-window window)
        (setq my/noema--app-buffer buffer)
        (when (fboundp 'my/xwidget-focus)
          (my/xwidget-focus buffer))))))

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
  "Pass EVENT through to xwidget when the current buffer is not Noema."
  (if (fboundp 'xwidget-webkit-pass-command-event)
      (xwidget-webkit-pass-command-event event)
    (setq unread-command-events
          (nconc (list event) unread-command-events))))

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
  (dolist (map (list xwidget-webkit-mode-map xwidget-webkit-edit-mode-map))
    (dolist (key '("M-z"))
      (define-key map (kbd key) #'my/noema-xwidget-undo))
    (dolist (key '("M-Z" "M-S-z"))
      (define-key map (kbd key) #'my/noema-xwidget-redo))
    (dolist (key '("<backtab>" "<iso-lefttab>" "S-TAB" "S-<tab>"))
      (define-key map (kbd key) #'my/noema-xwidget-shift-tab))))

(with-eval-after-load 'windmove
  (my/noema--install-windmove-focus-advice))

(provide 'noema-xwidget-keys)
;;; noema-xwidget-keys.el ends here
