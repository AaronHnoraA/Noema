;;; noema-pi-watch.el --- Tell Pi's watches what sessions did -*- lexical-binding: t; -*-

;;; Commentary:
;; A watch can wait for an execution session's turn to end or its client to
;; exit, and only Emacs knows those facts.  A Project with no watches costs one
;; `file-exists-p' per turn and no host call.  Contract: docs/design/pi-watches.md.

;;; Code:

(require 'tools/agent/acp)

(declare-function +noema-api-call "noema/bridge/config" (channel args callback &optional timeout))
(declare-function remote-client-file-name "remote" (file))

(defun noema-pi-watch--root (buffer)
  "Return the native Project root of BUFFER's session when it has watches."
  (when-let* ((root (plist-get (+agent-session-snapshot buffer) :root))
              (local (remote-client-file-name root))
              ((file-exists-p (expand-file-name ".agent/pi/journal.jsonl" local))))
    local))

(defun noema-pi-watch--report (buffer name)
  "Report session fact NAME of BUFFER; never start the host or show a failure."
  (when (and (buffer-live-p buffer) (eq (+agent-session-kind buffer) 'agent)
             (fboundp '+noema-api-call))
    (when-let* ((root (noema-pi-watch--root buffer)))
      (+noema-api-call
       "noema:api:agent:pi:watch"
       (vector `((root . ,root) (op . "event") (name . ,name) (buffer . ,(buffer-name buffer))
                 (agent . ,(format "%s" (plist-get (+agent-session-snapshot buffer) :agent)))))
       #'ignore))))

(defun noema-pi-watch--turn-complete (buffer _event)
  "Report that BUFFER's turn ended."
  (noema-pi-watch--report buffer "turn-end"))

(defun noema-pi-watch--client-ended (buffer)
  "Report that BUFFER's client exited."
  (noema-pi-watch--report buffer "client-exit"))

(add-hook '+agent-acp-turn-complete-functions #'noema-pi-watch--turn-complete)
(add-hook '+agent-acp-client-ended-functions #'noema-pi-watch--client-ended)

(provide 'noema-pi-watch)
;;; noema-pi-watch.el ends here
