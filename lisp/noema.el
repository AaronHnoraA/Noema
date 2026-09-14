;;; noema.el --- Emacs-native Noema entry point -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Emacs is Noema's product host.  Embedded gptel supplies composition UX;
;; embedded agent-shell/acp supplies structured agent sessions; embedded Magent
;; supplies the local runtime, queue, ledger and optional gptel-backed agent.

;;; Code:

(require 'noema-upstream)
(require 'noema-compose)
(require 'noema-agent-acp)

;;;###autoload
(defun noema ()
  "Open the primary Noema structured-agent surface."
  (interactive)
  (noema-agent-start 'magent))

(provide 'noema)
;;; noema.el ends here
