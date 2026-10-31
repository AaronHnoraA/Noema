;;; noema.el --- Emacs-native Noema entry point -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Emacs is Noema's product host.  Embedded gptel supplies composition UX;
;; package-managed agent-shell/acp supplies structured agent sessions; embedded Magent
;; supplies the local runtime, queue, ledger and optional gptel-backed agent.

;;; Code:

(require 'noema-upstream)
(require 'tools/agent/compose)
(require 'tools/agent/acp)
(require 'noema-api)
(require 'noema-capability-ui)

;;;###autoload
(defun noema ()
  "Open the primary Noema structured-agent surface."
  (interactive)
  (+agent/start 'magent))

(provide 'noema)
;;; noema.el ends here
