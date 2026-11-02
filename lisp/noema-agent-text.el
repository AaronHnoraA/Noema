;;; noema-agent-text.el --- Agent-facing text as data -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Prompts live in resources/agent/ and are read when used, so changing one
;; needs no compilation, reload or restart (Pi C26).  This file requires
;; nothing, because entries load before the Agent runtime does.

;;; Code:

(defconst noema-agent-text-directory
  (expand-file-name "../resources/agent/"
                    (file-name-directory (or load-file-name buffer-file-name)))
  "Where Agent-facing text lives.")

(defun noema-agent-text (name &rest values)
  "Return the text resources/agent/NAME.md with VALUES filled in.
VALUES is a plist of field names and strings: `:project' fills {project}."
  (let ((text (with-temp-buffer
                (insert-file-contents (expand-file-name (concat name ".md")
                                                        noema-agent-text-directory))
                (buffer-string))))
    (setq text (replace-regexp-in-string "\\`[ \t\n]+\\|[ \t\n]+\\'" "" text))
    (while values
      (setq text (string-replace (format "{%s}" (substring (symbol-name (pop values)) 1))
                                 (pop values) text)))
    text))

(provide 'noema-agent-text)
;;; noema-agent-text.el ends here
