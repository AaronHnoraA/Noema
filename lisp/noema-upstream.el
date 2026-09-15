;;; noema-upstream.el --- Load Noema-owned upstream implementations -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; gptel and Magent remain embedded.  agent-shell, acp.el and shell-maker are
;; pristine package-vc dependencies; never put their retired copies on load-path.

;;; Code:

(require 'cl-lib)

(defconst noema-upstream-root
  (file-name-directory
   (directory-file-name
    (file-name-directory (or load-file-name buffer-file-name))))
  "Absolute root of the embedded Noema source tree.")

(defconst noema-upstream-load-paths
  '("upstream/gptel"
    "upstream/magent/lisp"
    "upstream/codex-cli"
    "upstream/claude-code-ide")
  "Complete upstream source trees internalized by Noema.")

(defun noema-upstream-activate ()
  "Put Noema's embedded upstream source trees before external packages."
  ;; Also remove obsolete paths on config reload; do not unload live sessions.
  (dolist (name '("acp" "shell-maker" "agent-shell"))
    (let ((retired (expand-file-name (concat "upstream/" name) noema-upstream-root)))
      (setq load-path
            (cl-remove-if (lambda (path)
                            (and path (equal (directory-file-name (expand-file-name path)) retired)))
                          load-path))))
  (dolist (relative (reverse noema-upstream-load-paths))
    (let ((directory (file-name-as-directory
                      (expand-file-name relative noema-upstream-root))))
      (unless (file-directory-p directory)
        (error "Noema embedded upstream is missing: %s" directory))
      (setq load-path (cons directory (delete directory load-path))))))

(noema-upstream-activate)

(provide 'noema-upstream)
;;; noema-upstream.el ends here
