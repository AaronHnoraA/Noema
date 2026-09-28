;;; noema-compose.el --- Noema composition UI using embedded gptel -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Noema owns the entry points, while the complete embedded gptel source owns
;; the mature arbitrary-buffer, context, preset, transient and rewrite UX.
;; This is intentionally a thin composition layer, not a second LLM client.
;;
;; In a Noema Markdown pane there is no Emacs region or text to act on: the
;; page owns both.  Each command then asks the page for its selection and
;; `noema-md-bridge' runs the same gptel UI on the note's source buffer.

;;; Code:

(require 'noema-upstream)
(require 'gptel)
(require 'noema-md-bridge)

(declare-function gptel-add "gptel-context" (&optional arg))
(declare-function gptel-menu "gptel-transient" ())
(declare-function gptel-rewrite "gptel-rewrite" ())

;;;###autoload
(defun noema-compose (&optional name)
  "Open a gptel composition buffer named NAME for lightweight Noema work.
From a Noema pane its selection (else the note) comes along as context."
  (interactive)
  (if (and (called-interactively-p 'any) (noema-md-bridge-pane-p))
      (noema-md-bridge-compose)
    (gptel (or name "Noema Compose") nil nil t)))

;;;###autoload
(defun noema-compose-send (&optional arg)
  "Send from the current buffer using embedded gptel.
ARG is passed unchanged to `gptel-send'."
  (interactive "P")
  (if (noema-md-bridge-pane-p)
      (noema-md-bridge-compose)
    (gptel-send arg)))

;;;###autoload
(defun noema-compose-menu ()
  "Open embedded gptel's complete transient configuration UI."
  (interactive)
  (require 'gptel-transient)
  (gptel-menu))

;;;###autoload
(defun noema-compose-add-context (&optional arg)
  "Add region, buffer or file context using embedded gptel.
ARG is passed unchanged to `gptel-add'.  In a Noema pane the page's selection,
else its whole note, is added."
  (interactive "P")
  (if (noema-md-bridge-pane-p)
      (noema-md-bridge-add-context)
    (require 'gptel-context)
    (gptel-add arg)))

;;;###autoload
(defun noema-compose-rewrite ()
  "Open embedded gptel's non-destructive rewrite interface.
In a Noema pane the page's selection (else its cursor line) is rewritten in
the note's source buffer, where the diff/ediff/accept review happens; the
accepted text is saved back and the pane reloads."
  (interactive)
  (if (noema-md-bridge-pane-p)
      (noema-md-bridge-rewrite)
    (require 'gptel-rewrite)
    (gptel-rewrite)))

(provide 'noema-compose)
;;; noema-compose.el ends here
