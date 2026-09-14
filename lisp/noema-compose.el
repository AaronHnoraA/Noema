;;; noema-compose.el --- Noema composition UI using embedded gptel -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Noema owns the entry points, while the complete embedded gptel source owns
;; the mature arbitrary-buffer, context, preset, transient and rewrite UX.
;; This is intentionally a thin composition layer, not a second LLM client.

;;; Code:

(require 'noema-upstream)
(require 'gptel)

(declare-function gptel-add "gptel-context" (&optional arg))
(declare-function gptel-menu "gptel-transient" ())
(declare-function gptel-rewrite "gptel-rewrite" ())

;;;###autoload
(defun noema-compose (&optional name)
  "Open a gptel composition buffer named NAME for lightweight Noema work."
  (interactive)
  (gptel (or name "Noema Compose") nil nil t))

;;;###autoload
(defun noema-compose-send (&optional arg)
  "Send from the current buffer using embedded gptel.
ARG is passed unchanged to `gptel-send'."
  (interactive "P")
  (gptel-send arg))

;;;###autoload
(defun noema-compose-menu ()
  "Open embedded gptel's complete transient configuration UI."
  (interactive)
  (require 'gptel-transient)
  (gptel-menu))

;;;###autoload
(defun noema-compose-add-context (&optional arg)
  "Add region, buffer or file context using embedded gptel.
ARG is passed unchanged to `gptel-add'."
  (interactive "P")
  (require 'gptel-context)
  (gptel-add arg))

;;;###autoload
(defun noema-compose-rewrite ()
  "Open embedded gptel's non-destructive rewrite interface."
  (interactive)
  (require 'gptel-rewrite)
  (gptel-rewrite))

(provide 'noema-compose)
;;; noema-compose.el ends here
