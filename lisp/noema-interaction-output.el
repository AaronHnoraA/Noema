;;; noema-interaction-output.el --- Output buffer support for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This module provides a shared output buffer for noema-interaction events.

;;; Code:

(require 'subr-x)
(require 'noema-interaction-session)

(defcustom noema-interaction-output-max-bytes (* 16 1024 1024)
  "Soft maximum size of one project output buffer.
Trimming runs only after appends and preserves a generous tail so streaming
does not trigger whole-buffer work for each small delta."
  :type 'integer
  :group 'noema-interaction)

(defvar noema-interaction-output-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-interaction-output-refresh)
    (define-key map (kbd "k") #'noema-interaction-output-clear)
    map)
  "Keymap for `noema-interaction-output-mode'.")

(define-derived-mode noema-interaction-output-mode special-mode "AI-Output"
  "Major mode for noema-interaction output buffers.")

(defun noema-interaction-output-buffer-name (&optional project-root)
  "Return the output buffer name for PROJECT-ROOT."
  (format "*AI Output: %s*" (noema-interaction-project-name project-root)))

(defun noema-interaction-output-buffer (&optional project-root)
  "Return the output buffer for PROJECT-ROOT."
  (let ((buffer (get-buffer-create (noema-interaction-output-buffer-name project-root))))
    (with-current-buffer buffer
      (setq default-directory (or project-root (noema-interaction-project-root))))
    buffer))

(defun noema-interaction-output-open ()
  "Open the noema-interaction output buffer for the current project."
  (interactive)
  (let ((buffer (noema-interaction-output-buffer)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-output-mode)
        (noema-interaction-output-mode)))
    (pop-to-buffer buffer)))

(defun noema-interaction-output-refresh ()
  "Refresh the noema-interaction output buffer."
  (interactive)
  (let ((buffer (current-buffer)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-output-mode)
        (noema-interaction-output-mode)))))

(defun noema-interaction-output-clear ()
  "Clear the noema-interaction output buffer."
  (interactive)
  (let ((inhibit-read-only t))
    (erase-buffer)))

(defun noema-interaction-output--trim-if-needed ()
  "Trim the oldest output in the current buffer after its soft size cap."
  (let ((buffer-bytes (1- (position-bytes (point-max)))))
    (when (and (integerp noema-interaction-output-max-bytes)
               (> noema-interaction-output-max-bytes 0)
               (> buffer-bytes noema-interaction-output-max-bytes))
      (let* ((tail-bytes (floor (* noema-interaction-output-max-bytes 0.75)))
             (target-byte (max 1 (- (position-bytes (point-max)) tail-bytes)))
             (target (or (byte-to-position target-byte) (point-min)))
             (cut (save-excursion
                    (goto-char target)
                    (or (search-forward "\n\n[" nil t) target))))
        (delete-region (point-min) cut)))))

(defun noema-interaction-output-stream-start (kind &optional metadata project-root)
  "Start a streaming KIND block and return its insertion marker.
METADATA is inserted once above the streamed body for PROJECT-ROOT."
  (let ((buffer (noema-interaction-output-buffer project-root))
        (timestamp (format-time-string "%H:%M:%S")))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-output-mode)
        (noema-interaction-output-mode))
      (let ((inhibit-read-only t))
        (goto-char (point-max))
        (insert (format "[%s] %s\n" timestamp (upcase (format "%s" kind))))
        (when (and (stringp metadata) (not (string-empty-p metadata)))
          (insert metadata "\n"))
        (let ((marker (copy-marker (point) t)))
          (noema-interaction-output--trim-if-needed)
          marker)))))

(defun noema-interaction-output-stream-append (marker text)
  "Append TEXT at streaming insertion MARKER in constant local work."
  (when (and (markerp marker)
             (marker-buffer marker)
             (stringp text)
             (not (string-empty-p text)))
    (with-current-buffer (marker-buffer marker)
      (let ((inhibit-read-only t))
        (save-excursion
          (goto-char marker)
          (insert text))))))

(defun noema-interaction-output-stream-finish (marker)
  "Finish the streaming block at MARKER and release it."
  (when (and (markerp marker) (marker-buffer marker))
    (with-current-buffer (marker-buffer marker)
      (let ((inhibit-read-only t))
        (save-excursion
          (goto-char marker)
          (unless (bolp) (insert "\n"))
          (insert "\n"))
        (noema-interaction-output--trim-if-needed)))
    (set-marker marker nil)))

(defun noema-interaction-output-append (kind text &optional project-root)
  "Append TEXT with KIND to the output buffer for PROJECT-ROOT."
  (let ((buffer (noema-interaction-output-buffer project-root))
        (timestamp (format-time-string "%H:%M:%S")))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-output-mode)
        (noema-interaction-output-mode))
      (let ((inhibit-read-only t))
        (goto-char (point-max))
        (insert (format "[%s] %s\n%s\n\n"
                        timestamp
                        (upcase (format "%s" kind))
                        (string-trim-right text)))
        (noema-interaction-output--trim-if-needed))))
  nil)

(provide 'noema-interaction-output)
;;; noema-interaction-output.el ends here
