;;; noema-upstream.el --- Load Noema-owned upstream implementations -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Noema internalizes the complete source trees of gptel, acp.el,
;; shell-maker, agent-shell and Magent.  This module is the single place that
;; exposes those trees to Emacs.  They are not package-manager dependencies and
;; must not be resolved from `package-user-dir'.

;;; Code:

(require 'cl-lib)

(defconst noema-upstream-root
  (file-name-directory
   (directory-file-name
    (file-name-directory (or load-file-name buffer-file-name))))
  "Absolute root of the embedded Noema source tree.")

(defconst noema-upstream-load-paths
  '("upstream/gptel"
    "upstream/acp"
    "upstream/shell-maker"
    "upstream/agent-shell"
    "upstream/magent/lisp"
    "upstream/codex-cli"
    "upstream/claude-code-ide")
  "Complete upstream source trees internalized by Noema.")

(defun noema-upstream-activate ()
  "Put Noema's embedded upstream source trees before external packages."
  (dolist (relative (reverse noema-upstream-load-paths))
    (let ((directory (file-name-as-directory
                      (expand-file-name relative noema-upstream-root))))
      (unless (file-directory-p directory)
        (error "Noema embedded upstream is missing: %s" directory))
      (setq load-path (cons directory (delete directory load-path))))))

(noema-upstream-activate)

(provide 'noema-upstream)
;;; noema-upstream.el ends here
