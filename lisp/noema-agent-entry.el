;;; noema-agent-entry.el --- One pointer into a Project for ordinary Agents -*- lexical-binding: t; -*-

;; An ordinary ACP session has no Noema tools and no Skill catalog of its own.
;; Its first turn in a Project carries one hidden reference to the Project
;; maintenance Skill and the API command, as an extra ACP block like recalled
;; memory.  The block is a path, not content: nothing here reads the Project or
;; starts the Noema host.  Contract: docs/design/agent-management.md C51.

(require 'cl-lib)
(require 'noema-hy-memory)

(declare-function noema-project-root "noema-research" (path))
(defvar +agent-acp-session-origin)
(defvar agent-shell--state)

(defconst noema-agent-entry--source
  (file-name-directory (directory-file-name
                        (file-name-directory (or load-file-name buffer-file-name))))
  "Root of the Noema source tree this adapter loaded from.")

(defvar noema-agent-entry--sent (make-hash-table :test #'equal)
  "Native session IDs that already received the entry; bounded at 256.")
(defvar noema-agent-entry--pending nil
  "Bound to (SESSION . TEXT) while one ACP request is being built.")

(defun noema-agent-entry--command (root)
  "Return a shell command reading the effective maintenance Skill for ROOT."
  (let ((api (expand-file-name "scripts/agent-api.mjs" noema-agent-entry--source))
        (args (json-serialize
               (vector `((id . "noema-project-maintenance")
                         (root . ,(directory-file-name root)))))))
    (format "printf '%%s' %s | node %s call noema:api:agent:skill:read -"
            (shell-quote-argument (decode-coding-string args 'utf-8))
            (shell-quote-argument api))))

(defun noema-agent-entry--text (root)
  "Return the entry for Project ROOT."
  (let ((project (directory-file-name root)))
    (format "Noema Project %s. Its shared cache, memory, context, sub-Agents and ACP facts are described by the Skill noema-project-maintenance; read it before maintaining them, with:\n%s\nIf the Noema host is down, its file is %s. This is a reference, not a task."
            project (noema-agent-entry--command root)
            (expand-file-name "resources/skills/noema-project-maintenance/SKILL.md"
                              noema-agent-entry--source))))

(defun noema-agent-entry--pending-for (buffer prompt)
  "Return (SESSION . TEXT) when BUFFER's turn with PROMPT should carry the entry.
Pi has its catalog, and origins that own their context take none."
  (when (and (fboundp 'noema-project-root)
             (noema-hy-memory--conversation-p prompt)
             (noema-hy-memory--ordinary-session-p buffer)
             (not (memq (and (boundp '+agent-acp-session-origin)
                             (buffer-local-value '+agent-acp-session-origin buffer))
                        '(pi pi-emacs pi-project))))
    (when-let* ((session (map-nested-elt (buffer-local-value 'agent-shell--state buffer)
                                         '(:session :id)))
                ((not (gethash session noema-agent-entry--sent)))
                (scope (noema-hy-memory--local-root buffer))
                (root (noema-project-root scope)))
      (cons session (noema-agent-entry--text root)))))

(defun noema-agent-entry--send-command-a (original &rest args)
  "Offer the entry to the request ORIGINAL builds for one ordinary turn."
  (let ((noema-agent-entry--pending
         (condition-case nil
             (noema-agent-entry--pending-for
              (or (plist-get args :shell-buffer) (current-buffer))
              (plist-get args :prompt))
           (error nil))))
    (apply original args)))

(defun noema-agent-entry--prompt-request-a (original &rest args)
  "Append the pending entry to the ACP request ORIGINAL builds."
  (let ((pending noema-agent-entry--pending))
    (if (not (and pending (equal (car pending) (plist-get args :session-id))
                  (plist-get args :prompt)))
        (apply original args)
      (setq args (plist-put (copy-sequence args) :prompt
                            (vconcat (plist-get args :prompt)
                                     (vector `((type . "text") (text . ,(cdr pending)))))))
      (prog1 (apply original args)
        (when (>= (hash-table-count noema-agent-entry--sent) 256)
          (clrhash noema-agent-entry--sent))
        (puthash (car pending) t noema-agent-entry--sent)))))

;; Innermost: memory recall delays the send, and the entry is bound around the
;; synchronous part that actually builds the request.
(advice-add 'agent-shell--send-command :around #'noema-agent-entry--send-command-a
            '((depth . 100)))
(advice-add 'acp-make-session-prompt-request :around #'noema-agent-entry--prompt-request-a)

(provide 'noema-agent-entry)
;;; noema-agent-entry.el ends here
