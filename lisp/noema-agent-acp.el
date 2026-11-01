;;; noema-agent-acp.el --- Research associations for the Emacs agent runtime -*- lexical-binding: t; -*-
(require 'cl-lib)
(require 'tools/agent/acp)

(defun noema-agent-export-config (config model-id)
  "Return a private export copy of CONFIG pinned to MODEL-ID.
Interactive model preferences never override this export-only selection."
  (let ((copy (+agent-acp-pinned-config config model-id "medium")))
    (when (eq (map-elt copy :identifier) 'claude-code)
      ;; Claude's SDK otherwise writes the private export prompt and note text
      ;; under ~/.claude/projects after the temporary workdir is removed.
      (let* ((meta (copy-tree (alist-get :session-meta copy)))
             (claude (copy-tree (alist-get 'claudeCode meta)))
             (options (copy-tree (alist-get 'options claude))))
        (setf (alist-get 'persistSession options) :false
              (alist-get 'settingSources options) []
              (alist-get 'skills options) []
              (alist-get 'tools options) ["Read" "Edit" "Write" "Glob" "Grep"]
              (alist-get 'disallowedTools options) ["Bash" "Task" "Skill" "WebFetch" "WebSearch"]
              (alist-get 'promptSuggestions options) :false
              (alist-get 'options claude) options
              (alist-get 'claudeCode meta) claude
              (alist-get :session-meta copy) meta)))
    copy))

(defun noema-agent-export-session-p (session)
  "Whether SESSION is a private LaTeX export turn, including older side turns."
  (let ((origin (plist-get session :origin))
        (root (plist-get session :root)))
    (or (eq origin 'latex-export)
        (and (eq origin 'side)
             (stringp root)
             (string-prefix-p "latex-export--"
                              (file-name-nondirectory
                               (directory-file-name root)))))))

(defun noema-agent-cleanup-export-history (session-id)
  "Remove only the native Codex rollout belonging to export SESSION-ID.
codex-acp does not expose an ephemeral session flag, so the private export
turn must be removed after its ACP buffer closes."
  (when (and (stringp session-id)
             (string-match-p
              "\\`[[:xdigit:]]\\{8\\}-[[:xdigit:]]\\{4\\}-[[:xdigit:]]\\{4\\}-[[:xdigit:]]\\{4\\}-[[:xdigit:]]\\{12\\}\\'"
              session-id))
    (let ((root (expand-file-name
                 "sessions" (or (getenv "CODEX_HOME")
                                (expand-file-name ".codex" (getenv "HOME"))))))
      (when (file-directory-p root)
        (dolist (file (directory-files-recursively
                       root (concat "-" (regexp-quote session-id) "\\.jsonl\\'") nil))
          (when (and (file-regular-p file) (not (file-symlink-p file))
                     (file-in-directory-p file root))
            (condition-case err
                (delete-file file)
              (error (message "Could not remove private Codex export rollout: %s"
                              (error-message-string err))))))))))

(defun noema-agent-register-session (buffer name root)
  "Bind NAME to BUFFER's conversation in ROOT's durable registry, if it has one.
Only a directory that already is a Noema project has one.  The work waits for
ACP initialization and then runs asynchronously; failing to reach the host
leaves the session registered on the Emacs side alone."
  (when (and (not (memq (buffer-local-value '+agent-acp-session-origin buffer) '(pi pi-emacs pi-project)))
             (fboundp 'noema-project-root)
             (noema-project-root root)
             (require 'noema-agent-promote nil t))
    (if (+agent-acp-state-value buffer '(:session :id))
        (noema-agent-promote-bind-session-name buffer name)
      (let (subscription)
        (setq subscription
              (+agent-acp-subscribe
               :buffer buffer :event 'init-finished
               :callback
               (lambda (_event)
                 (ignore-errors
                   (+agent-acp-unsubscribe :buffer buffer :subscription subscription))
                 (when (buffer-live-p buffer)
                   (noema-agent-promote-bind-session-name buffer name)))))))))

(defvar noema-agent-promote--session-id)
(declare-function noema-project-root "noema-research" (&optional directory))
(declare-function noema-project-workspace "noema-research" (root))

(defun noema-agent--project-root (directory)
  "Query an already available Research project resolver for DIRECTORY."
  (when (fboundp 'noema-project-root) (noema-project-root directory)))

(defun noema-agent--workspace (root)
  "Return ROOT's domain workspace only when Research already owns it."
  (when (and (fboundp 'noema-project-root) (noema-project-root root))
    (noema-project-workspace root)))

(defun noema-agent--session-id (buffer)
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (unless (memq +agent-acp-session-origin '(pi pi-emacs pi-project))
        (bound-and-true-p noema-agent-promote--session-id)))))

(defun noema-agent--group (buffer)
  "Expose Research affiliation to Emacs without consulting the host."
  (when (and (buffer-live-p buffer)
             (or (noema-agent--session-id buffer)
                 (eq (buffer-local-value '+agent-acp-session-origin buffer) 'run)))
    '(:key noema :label "Noema Research")))

(defun noema-agent--forget (buffer)
  (with-current-buffer buffer (setq-local noema-agent-promote--session-id nil)))

(defun noema-agent--close (buffer)
  "Remove private export history after its physical session has closed."
  (when (and (eq (buffer-local-value '+agent-acp-session-origin buffer) 'latex-export)
             (equal (+agent-acp--buffer-agent-id buffer) "codex"))
    (when-let* ((id (+agent-acp-state-value buffer '(:session :id))))
      (run-at-time 2 nil #'noema-agent-cleanup-export-history id))))

(defun noema-agent--action (operation buffer &rest args)
  "Handle only Research operations for a durably associated session."
  (when (and (buffer-live-p buffer) (noema-agent--session-id buffer))
    (require 'noema-sessions)
    (pcase operation
      ('rename (apply #'noema-sessions-agent-rename buffer args) t)
      ('restart (noema-sessions-agent-restart buffer) t)
      ('fork (apply #'noema-sessions-agent-fork buffer args) t)
      ('side-chat (noema-sessions-agent-side-chat buffer) t)
      ('archive (noema-sessions-agent-archive buffer) t)
      ('jump (noema-sessions-agent-jump buffer) t)
      ('compact (require 'noema-agent-worker) (noema-agent-worker-compact-session buffer) t))))

(defun noema-agent--operation-supported-p (operation buffer)
  "Report business operations only for an associated Research session."
  (and (noema-agent--session-id buffer)
       (memq operation '(fork compact archive jump))))

(defun noema-agent--menu (buffer)
  "Add Research actions only when BUFFER has a durable association."
  (when (noema-agent--session-id buffer)
    `("--" ["Jump to latest work block" (+agent-session-jump ,buffer)]
      ["Archive Research session" (+agent-session-archive ,buffer)])))

(defun noema-agent--attention (buffer)
  "Project active Research requests without querying or starting its host."
  (when (hash-table-p (bound-and-true-p noema-agent-worker--runs))
    (let (reason)
      (maphash (lambda (_ worker)
                 (when (eq buffer (noema-agent-worker-buffer worker))
                   (setq reason (cond ((noema-agent-worker-pending-permissions worker) 'permission)
                                      ((noema-agent-worker-pending-inputs worker) 'input)))))
               noema-agent-worker--runs)
      reason)))

(add-hook '+agent-project-root-functions #'noema-agent--project-root)
(add-hook '+agent-workspace-functions #'noema-agent--workspace)
(add-hook '+agent-session-adopt-functions #'noema-agent-register-session)
(add-hook '+agent-session-forget-functions #'noema-agent--forget)
(add-hook '+agent-session-id-functions #'noema-agent--session-id)
(add-hook '+agent-session-group-functions #'noema-agent--group)
(add-hook '+agent-session-close-functions #'noema-agent--close)
(add-hook '+agent-session-operation-functions #'noema-agent--operation-supported-p)
(add-hook '+agent-session-action-functions #'noema-agent--action)
(add-hook '+agent-session-menu-functions #'noema-agent--menu)
(add-hook '+agent-session-attention-functions #'noema-agent--attention)
(add-hook '+agent-session-private-functions #'noema-agent-export-session-p)

;; Preserve the existing model/quota preferences while their owner moves.
(dolist (pair `(("var/noema/agent-models.json" . ,+agent-acp-model-preferences-file)
                ("var/noema/agent-rate-limits.json" . ,+agent-acp-rate-limits-file)))
  (let ((old (locate-user-emacs-file (car pair))) (new (cdr pair)))
    (when (and (file-readable-p old) (not (file-exists-p new)))
      (make-directory (file-name-directory new) t)
      (copy-file old new))))

(require 'noema-hy-memory)
(provide 'noema-agent-acp)
;;; noema-agent-acp.el ends here
