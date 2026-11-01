;;; noema.el --- Emacs-native Noema entry point -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Emacs hosts Markdown and real ACP sessions. Pi accompanies Emacs and keeps
;; one child per project; context and document review do not require gptel.

;;; Code:

(require 'noema-pi-router)

;;;###autoload
(defun noema ()
  "Open the primary Noema structured-agent surface."
  (interactive)
  (noema-pi-router-open default-directory))

(provide 'noema)
;;; noema.el ends here
