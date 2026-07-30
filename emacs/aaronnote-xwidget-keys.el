;;; xwidget-keys.el --- Noema xwidget input bridge -*- lexical-binding: t; -*-

;; This module intentionally preserves the existing Markdown/xwidget key
;; bridge.  It owns focus transfer, Emacs key forwarding, undo/redo/Shift-Tab
;; routing, and xwidget/windmove advice as one lifecycle boundary.

;;; Code:

(require 'cl-lib)
(require 'subr-x)

(defvar my/aaronnote--app-buffer)
(defvar my/aaronnote--client-buffers)
(defvar my/aaronnote--port)
(defvar my/aaronnote--xwidget-advice-installed nil)
(defvar my/aaronnote--windmove-focus-advice-installed nil)
(defvar my/xwidget--session-id)
(defvar-local my/aaronnote--client-id nil)
(defvar-local my/aaronnote-buffer-file-name nil)
(defvar-local my/aaronnote--xwidget-forced-name nil)
(defvar-local my/aaronnote--xwidget-pending-file nil)

(declare-function my/aaronnote--buffer-for-client "init-aaronnote" (client))
(declare-function my/aaronnote--open-file-in-web "init-aaronnote" (file))
(declare-function my/aaronnote-command "init-aaronnote" (command &optional detail))
(declare-function my/aaronnote-jupyter-url-p "init-aaronnote-jupyter" (url))
(declare-function my/xwidget-current-url "init-browser" (&optional buffer))
(declare-function my/xwidget-focus "init-browser" (&optional buffer))
(declare-function my/xwidget-undo "init-browser" ())
(declare-function my/xwidget-redo "init-browser" ())
(declare-function xwidget-buffer "xwidget" (xwidget))
(declare-function xwidget-webkit-edit-mode "xwidget" (&optional arg))
(declare-function xwidget-webkit-pass-command-event "xwidget" (event))

(defun my/aaronnote--select-emacs-window (&optional window)
  "Select WINDOW and ask the window system to focus its frame."
  (let ((window (or window (selected-window))))
    (when (window-live-p window)
      (select-window window)
      (when (fboundp 'select-frame-set-input-focus)
        (ignore-errors
          (select-frame-set-input-focus (window-frame window)))))))

(defun my/aaronnote--focus-minibuffer-if-active ()
  "Move focus to the active minibuffer after a forwarded Noema key."
  (when-let* ((window (active-minibuffer-window)))
    (my/aaronnote--select-emacs-window window)))

(defun my/aaronnote--release-xwidget-input-buffer (&optional buffer)
  "Exit xwidget edit mode in BUFFER when it is an Noema xwidget."
  (let ((buffer (or buffer my/aaronnote--app-buffer)))
    (when (and (buffer-live-p buffer)
               (fboundp 'xwidget-webkit-edit-mode))
      (with-current-buffer buffer
        (when (eq major-mode 'xwidget-webkit-mode)
          (ignore-errors (xwidget-webkit-edit-mode -1)))))))

(defun my/aaronnote--focus-xwidget-window (window)
  "Focus Noema xwidget WINDOW like a direct window click."
  (when (window-live-p window)
    (let ((buffer (window-buffer window)))
      (when (my/aaronnote--xwidget-buffer-p buffer)
        (select-window window)
        (my/aaronnote--select-emacs-window window)
        (setq my/aaronnote--app-buffer buffer)
        (when (fboundp 'my/xwidget-focus)
          (my/xwidget-focus buffer))))))

(defun my/aaronnote--focus-xwidget-window-if-still-selected (window buffer)
  "Focus WINDOW's xwidget if WINDOW still displays BUFFER and is selected."
  (when (and (window-live-p window)
             (eq window (selected-window))
             (eq (window-buffer window) buffer))
    (my/aaronnote--focus-xwidget-window window)))

(defun my/aaronnote--focus-selected-window-after-move (&optional source-window)
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
                   (my/aaronnote--xwidget-buffer-p source-buffer))
          (my/aaronnote--release-xwidget-input-buffer source-buffer))
        (cond
         ((my/aaronnote--xwidget-buffer-p target-buffer)
          (my/aaronnote--focus-xwidget-window target-window)
          (run-at-time 0.05 nil
                       #'my/aaronnote--focus-xwidget-window-if-still-selected
                       target-window target-buffer))
         ((and source-buffer
               (my/aaronnote--xwidget-buffer-p source-buffer))
          (my/aaronnote--select-emacs-window target-window)))))))

(defun my/aaronnote--focus-forwarded-key-target (&optional source-window)
  "Restore input focus after an Noema-forwarded key leaves SOURCE-WINDOW."
  (if (active-minibuffer-window)
      (my/aaronnote--focus-minibuffer-if-active)
    (my/aaronnote--focus-selected-window-after-move source-window)))

(defun my/aaronnote--windmove-focus-advice (orig-fun &rest args)
  "Around advice for windmove commands to focus Noema targets correctly."
  (let ((source-window (selected-window)))
    (prog1 (apply orig-fun args)
      (my/aaronnote--focus-selected-window-after-move source-window))))

(defun my/aaronnote--release-xwidget-input ()
  "Exit Noema xwidget edit mode before Emacs handles forwarded keys."
  (my/aaronnote--release-xwidget-input-buffer my/aaronnote--app-buffer))

(defun my/aaronnote--queue-emacs-key (keys key-string)
  "Queue KEYS forwarded from Noema for Emacs' normal command loop.
KEY-STRING is used only for diagnostics."
  (let ((binding (key-binding keys)))
    (cond
     ((or (commandp binding) (keymapp binding))
      (setq unread-command-events
            (nconc (listify-key-sequence keys)
                   unread-command-events))
      (run-at-time 0.05 nil #'my/aaronnote--focus-forwarded-key-target
                   (selected-window)))
     (t
      (message "Noema: no binding for %s" key-string)))))

(defun my/aaronnote--key-source-buffer (&optional client)
  "Return the Noema buffer that forwarded a key for CLIENT."
  (or (my/aaronnote--buffer-for-client client)
      (let ((selected-buffer (window-buffer (selected-window))))
        (and (my/aaronnote--xwidget-buffer-p selected-buffer)
             selected-buffer))
      (and (buffer-live-p my/aaronnote--app-buffer)
           my/aaronnote--app-buffer)))

(defun my/aaronnote--key-source-window (&optional client)
  "Return the visible window that forwarded a key for CLIENT."
  (let ((source-buffer (my/aaronnote--key-source-buffer client)))
    (or (and (buffer-live-p source-buffer)
             (get-buffer-window source-buffer 'visible))
        (let ((window (selected-window)))
          (and (window-live-p window)
               (my/aaronnote--xwidget-buffer-p (window-buffer window))
               window)))))

(defun my/aaronnote--run-emacs-key (key-string &optional client)
  "Execute Emacs key KEY-STRING forwarded from the Noema browser.
CLIENT, when non-nil, identifies the Noema xwidget that sent the key."
  (condition-case err
      (let ((keys (ignore-errors (kbd key-string))))
        (when (and keys (> (length keys) 0))
          (let ((source-buffer (my/aaronnote--key-source-buffer client))
                (win (my/aaronnote--key-source-window client)))
            (my/aaronnote--release-xwidget-input-buffer source-buffer)
            (if (window-live-p win)
                (progn
                  (my/aaronnote--select-emacs-window win)
                  (my/aaronnote--queue-emacs-key keys key-string))
              (my/aaronnote--select-emacs-window)
              (my/aaronnote--queue-emacs-key keys key-string)))))
    (error
     (message "Noema key forward failed (%s): %s"
              key-string (error-message-string err)))))

(defun my/aaronnote--xwidget-buffer-p (&optional buffer)
  "Return non-nil when BUFFER hosts the local Noema xwidget page."
  (let ((buffer (or buffer (current-buffer))))
    (and (buffer-live-p buffer)
         (or (eq buffer my/aaronnote--app-buffer)
             (with-current-buffer buffer
               (and (eq major-mode 'xwidget-webkit-mode)
                    (or
                     my/aaronnote--client-id
                     my/aaronnote-buffer-file-name
                     my/aaronnote--xwidget-forced-name
                     (and (integerp my/aaronnote--port)
                          (fboundp 'my/xwidget-current-url)
                          (when-let* ((url (my/xwidget-current-url buffer)))
                            (string-prefix-p
                             (format "http://127.0.0.1:%d/" my/aaronnote--port)
                             url))))))))))

(defun my/aaronnote--jupyter-xwidget-buffer-p (&optional buffer)
  "Return non-nil when BUFFER hosts the Noema-owned Jupyter xwidget page."
  (let ((buffer (or buffer (current-buffer))))
    (and (buffer-live-p buffer)
         (with-current-buffer buffer
           (and (eq major-mode 'xwidget-webkit-mode)
                (or (equal (and (boundp 'my/xwidget--session-id)
                                my/xwidget--session-id)
                           "aaronnote-jupyter")
                    (and (progn
                           (unless (fboundp 'my/aaronnote-jupyter-url-p)
                             (require 'init-aaronnote-jupyter nil t))
                           (fboundp 'my/aaronnote-jupyter-url-p))
                         (fboundp 'my/xwidget-current-url)
                         (when-let* ((url (my/xwidget-current-url buffer)))
                           (my/aaronnote-jupyter-url-p url)))))))))

(defun my/aaronnote--pass-xwidget-command-event (event)
  "Pass EVENT through to xwidget when the current buffer is not Noema."
  (if (fboundp 'xwidget-webkit-pass-command-event)
      (xwidget-webkit-pass-command-event event)
    (setq unread-command-events
          (nconc (list event) unread-command-events))))

(defun my/aaronnote--jupyter-xwidget-command (event command)
  "Route xwidget EVENT/COMMAND to Jupyter, or pass EVENT through."
  (pcase command
    ("undo"
     (if (fboundp 'my/xwidget-undo)
         (my/xwidget-undo)
       (my/aaronnote--pass-xwidget-command-event event)))
    ("redo"
     (if (fboundp 'my/xwidget-redo)
         (my/xwidget-redo)
       (my/aaronnote--pass-xwidget-command-event event)))
    (_
     (my/aaronnote--pass-xwidget-command-event event))))

(defun my/aaronnote--xwidget-editor-command (event command &optional detail)
  "Route xwidget EVENT to Noema COMMAND, or pass it through otherwise."
  (cond
   ((my/aaronnote--xwidget-buffer-p)
    (my/aaronnote-command command detail))
   ((my/aaronnote--jupyter-xwidget-buffer-p)
    (my/aaronnote--jupyter-xwidget-command event command))
   (t
    (my/aaronnote--pass-xwidget-command-event event))))

(defun my/aaronnote-xwidget-undo (event)
  "Route Command-z / Meta-z from Noema xwidget to web undo."
  (interactive "e")
  (my/aaronnote--xwidget-editor-command event "undo"))

(defun my/aaronnote-xwidget-redo (event)
  "Route Command-Shift-z / Meta-Shift-z from Noema xwidget to web redo."
  (interactive "e")
  (my/aaronnote--xwidget-editor-command event "redo"))

(defun my/aaronnote-xwidget-shift-tab (event)
  "Route Shift-Tab to Noema in xwidget without losing the Shift modifier."
  (interactive "e")
  (my/aaronnote--xwidget-editor-command
   event
   "key"
   '((key . "Tab")
     (shiftKey . t))))

(defun my/aaronnote--xwidget-callback-advice (_xwidget _event-type)
  "After xwidget callback: fire pending file POST on load-finished."
  (when (and (eq _event-type 'load-changed)
             (string-equal (nth 3 last-input-event) "load-finished"))
    (let ((buf (and (fboundp 'xwidget-buffer)
                    (xwidget-buffer _xwidget))))
      (when (buffer-live-p buf)
        (with-current-buffer buf
          (when my/aaronnote--xwidget-pending-file
            (let ((file my/aaronnote--xwidget-pending-file)
                  (pending-buf (current-buffer)))
              (setq-local my/aaronnote--xwidget-pending-file nil)
              (run-at-time 0.3 nil
                           (lambda ()
                             (when (buffer-live-p pending-buf)
                               (my/aaronnote--open-file-in-web file)))))))))))

(defun my/aaronnote--install-windmove-focus-advice ()
  "Install focus repair advice for windmove transitions involving Noema."
  (unless my/aaronnote--windmove-focus-advice-installed
    (dolist (command '(windmove-left windmove-right windmove-up windmove-down))
      (when (fboundp command)
        (advice-add command :around #'my/aaronnote--windmove-focus-advice)))
    (setq my/aaronnote--windmove-focus-advice-installed t)))

(with-eval-after-load 'xwidget
  (unless my/aaronnote--xwidget-advice-installed
    (advice-add 'xwidget-webkit-callback :after
                #'my/aaronnote--xwidget-callback-advice)
    (setq my/aaronnote--xwidget-advice-installed t))
  (dolist (map (list xwidget-webkit-mode-map xwidget-webkit-edit-mode-map))
    (dolist (key '("M-z"))
      (define-key map (kbd key) #'my/aaronnote-xwidget-undo))
    (dolist (key '("M-Z" "M-S-z"))
      (define-key map (kbd key) #'my/aaronnote-xwidget-redo))
    (dolist (key '("<backtab>" "<iso-lefttab>" "S-TAB" "S-<tab>"))
      (define-key map (kbd key) #'my/aaronnote-xwidget-shift-tab))))

(with-eval-after-load 'windmove
  (my/aaronnote--install-windmove-focus-advice))

(provide 'aaronnote-xwidget-keys)
;;; xwidget-keys.el ends here
