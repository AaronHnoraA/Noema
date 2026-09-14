;;; noema-interaction-result.el --- Result buffer support for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This module provides a shared result buffer for noema-interaction backend output.

;;; Code:

(require 'subr-x)
(require 'noema-interaction-session)

(defconst noema-interaction-result-kind-labels
  '((prompt . "Prompt")
    (assistant . "Assistant")
    (tool . "Tool")
    (status . "Status")
    (error . "Error")
    (meta . "Meta")
    (event . "Event")
    (raw . "Raw"))
  "Display labels used in result buffers.")

(defvar noema-interaction-result-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-interaction-result-refresh)
    (define-key map (kbd "k") #'noema-interaction-result-clear)
    map)
  "Keymap for `noema-interaction-result-mode'.")

(define-derived-mode noema-interaction-result-mode special-mode "AI-Result"
  "Major mode for noema-interaction result buffers."
  (setq-local truncate-lines nil))

(declare-function noema-interaction-frontend-append "noema-interaction" (kind text &optional project-root))

(defun noema-interaction-result-buffer-name (&optional project-root)
  "Return the result buffer name for PROJECT-ROOT."
  (format "*AI Result: %s*" (noema-interaction-project-name project-root)))

(defun noema-interaction-result-buffer (&optional project-root)
  "Return the result buffer for PROJECT-ROOT."
  (let ((buffer (get-buffer-create (noema-interaction-result-buffer-name project-root))))
    (with-current-buffer buffer
      (setq default-directory (or project-root (noema-interaction-project-root))))
    buffer))

(defun noema-interaction-result-open ()
  "Open the noema-interaction result buffer for the current project."
  (interactive)
  (let ((buffer (noema-interaction-result-buffer)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-result-mode)
        (noema-interaction-result-mode)))
    (pop-to-buffer buffer)))

(defun noema-interaction-result-refresh ()
  "Refresh the noema-interaction result buffer."
  (interactive)
  (let ((buffer (current-buffer)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-result-mode)
        (noema-interaction-result-mode)))))

(defun noema-interaction-result-clear ()
  "Clear the noema-interaction result buffer."
  (interactive)
  (let ((inhibit-read-only t))
    (erase-buffer)))

(defun noema-interaction-result-append (kind text &optional project-root)
  "Append TEXT with KIND to the result buffer for PROJECT-ROOT."
  (let ((buffer (noema-interaction-result-buffer project-root))
        (timestamp (format-time-string "%H:%M:%S"))
        (label (or (alist-get kind noema-interaction-result-kind-labels)
                   (capitalize (format "%s" kind)))))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-result-mode)
        (noema-interaction-result-mode))
      (let ((inhibit-read-only t))
        (goto-char (point-max))
        (insert (propertize (format "%s  %s\n" label timestamp)
                            'face 'bold))
        (insert (string-trim-right text))
        (insert "\n\n")
        (goto-char (point-max)))))
  (when (and (memq kind '(assistant tool status error meta event))
             (fboundp 'noema-interaction-frontend-append))
    (noema-interaction-frontend-append kind text project-root)))

(provide 'noema-interaction-result)
;;; noema-interaction-result.el ends here
