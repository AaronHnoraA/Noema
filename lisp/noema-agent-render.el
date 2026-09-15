;;; noema-agent-render.el --- Bounded hidden agent rendering -*- lexical-binding: t; -*-

;;; Commentary:
;; Optional Noema integration, not a patch to agent-shell.  The only upstream
;; contracts are the :state keyword on --update-fragment/--update-text and the
;; state's :buffer.  Keep the contract tests when upgrading package-vc.
;; Transport, events, permissions and process lifetime are never intercepted.

;;; Code:
(require 'cl-lib)
(require 'map)
(require 'agent-shell)

(defgroup noema-agent-render nil "Noema agent display performance." :group 'applications)
(defcustom noema-agent-render-policy 'always
  "Render output always, only when visible, or never (headless).
Noema sessions use a buffer-local `visible' policy."
  :type '(choice (const always) (const visible) (const never)) :group 'noema-agent-render)
(defcustom noema-agent-render-cache-max-bytes (* 4 1024 1024)
  "Maximum approximate deferred bytes per buffer; discard oldest first."
  :type 'natnum :group 'noema-agent-render)
(defvar-local noema-agent-render--pending nil "FIFO of pending render operations.")
(defvar-local noema-agent-render--tail nil)
(defvar-local noema-agent-render--bytes 0)
(defvar noema-agent-render--replaying nil)

(defun noema-agent-render--dispatch (original arguments)
  "Render ORIGINAL with ARGUMENTS, or enqueue it in bounded O(1) FIFO storage."
  (let ((buffer (map-elt (plist-get arguments :state) :buffer)))
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (if (or noema-agent-render--replaying
                (eq noema-agent-render-policy 'always)
                (and (eq noema-agent-render-policy 'visible) (get-buffer-window buffer t)))
            (apply original arguments)
          (let* (;; STATE remains live while hidden.  Pin the turn namespace
                 ;; now so later submissions cannot move earlier output.
                 (arguments (if (plist-get arguments :namespace-id) arguments
                              (plist-put (copy-sequence arguments) :namespace-id
                                         (map-elt (plist-get arguments :state) :request-count))))
                 (bytes (+ 64 (cl-loop for value in arguments when (stringp value)
                                     sum (string-bytes value))))
                 (cell (list (list bytes original arguments))))
            (if noema-agent-render--tail (setcdr noema-agent-render--tail cell)
              (setq noema-agent-render--pending cell))
            (setq noema-agent-render--tail cell)
            (cl-incf noema-agent-render--bytes bytes)
            (while (> noema-agent-render--bytes (max 0 noema-agent-render-cache-max-bytes))
              (cl-decf noema-agent-render--bytes (caar noema-agent-render--pending))
              (setq noema-agent-render--pending (cdr noema-agent-render--pending)))
            (unless noema-agent-render--pending (setq noema-agent-render--tail nil))
            nil))))))

(defun noema-agent-render--fragment (original &rest arguments)
  "Defer expensive fragment rendering when appropriate."
  (noema-agent-render--dispatch original arguments))
(defun noema-agent-render--text (original &rest arguments)
  "Defer text rendering without deferring ACP notifications."
  (noema-agent-render--dispatch original arguments))

(defun noema-agent-render-flush (&optional buffer)
  "Replay BUFFER's bounded pending output in arrival order."
  (interactive)
  (with-current-buffer (or buffer (current-buffer))
    (let ((operations noema-agent-render--pending)
          (noema-agent-render--replaying t))
      (setq noema-agent-render--pending nil noema-agent-render--tail nil
            noema-agent-render--bytes 0)
      (dolist (operation operations)
        (condition-case err
            (apply (nth 1 operation) (nth 2 operation))
          (error (display-warning 'noema-agent-render (error-message-string err) :warning)))))))

(defun noema-agent-render--visible (window)
  "Flush only the agent buffer newly displayed in WINDOW."
  (when (window-live-p window)
    (with-current-buffer (window-buffer window)
      (when (and noema-agent-render--pending (eq noema-agent-render-policy 'visible))
        (noema-agent-render-flush)))))

(define-minor-mode noema-agent-render-mode
  "Enable Noema's optional hidden rendering adapter globally.
Disabling flushes queued output and leaves normal upstream behavior."
  :global t :group 'noema-agent-render
  (if noema-agent-render-mode
      (progn
        (advice-add 'agent-shell--update-fragment :around #'noema-agent-render--fragment)
        (advice-add 'agent-shell--update-text :around #'noema-agent-render--text)
        (add-hook 'window-buffer-change-functions #'noema-agent-render--visible))
    (advice-remove 'agent-shell--update-fragment #'noema-agent-render--fragment)
    (advice-remove 'agent-shell--update-text #'noema-agent-render--text)
    (remove-hook 'window-buffer-change-functions #'noema-agent-render--visible)
    (dolist (buffer (buffer-list))
      (when (buffer-local-value 'noema-agent-render--pending buffer) (noema-agent-render-flush buffer)))))

(provide 'noema-agent-render)
;;; noema-agent-render.el ends here
