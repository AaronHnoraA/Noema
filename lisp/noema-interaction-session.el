;;; noema-interaction-session.el --- Session model for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This module owns project-scoped state for noema-interaction.

;;; Code:

(require 'project)
(require 'noema-interaction-backend)

(defvar noema-interaction-default-backend 'claude
  "Default backend used for new noema-interaction sessions.")

(defvar noema-interaction--session-table (make-hash-table :test 'equal)
  "Hashtable mapping project roots to noema-interaction session plists.")

(defun noema-interaction-project-root ()
  "Return the current project root or `default-directory'."
  (if-let* ((project (project-current nil default-directory)))
      (expand-file-name (project-root project))
    (expand-file-name default-directory)))

(defun noema-interaction--normalize-backend (backend)
  "Return BACKEND when supported, otherwise fall back to the default backend."
  (if (or (noema-interaction-backend-spec backend)
          (memq backend '(claude codex opencode chat)))
      backend
    noema-interaction-default-backend))

(defun noema-interaction-session-get (&optional project-root)
  "Return the noema-interaction session plist for PROJECT-ROOT."
  (let ((root (or project-root (noema-interaction-project-root))))
    (or (gethash root noema-interaction--session-table)
        (let ((session (list :project-root root
                             :backend noema-interaction-default-backend
                             :chat-backend nil
                             :profile "default"
                             :initialized nil
                             :profile-bootstrap-sent-backends nil
                             :profile-injected-backends nil
                             :last-prompt nil
                             :last-status nil
                             :last-error nil
                             :run-state 'idle)))
          (puthash root session noema-interaction--session-table)
          session))))

(defun noema-interaction-session-backend (&optional project-root)
  "Return the backend configured for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :backend))

(defun noema-interaction-session-profile (&optional project-root)
  "Return the profile configured for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :profile))

(defun noema-interaction-session-set-backend (backend &optional project-root)
  "Store BACKEND in the session for PROJECT-ROOT and return the backend."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root)))
         (value (noema-interaction--normalize-backend backend)))
    (setq session (plist-put session :backend value))
    (puthash root session noema-interaction--session-table)
    value))

(defun noema-interaction-session-chat-backend (&optional project-root)
  "Return the selected HTTP chat model name for PROJECT-ROOT, or nil."
  (plist-get (noema-interaction-session-get project-root) :chat-backend))

(defun noema-interaction-session-set-chat-backend (name &optional project-root)
  "Store HTTP chat model NAME in the session for PROJECT-ROOT and return it."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :chat-backend name))
    (puthash root session noema-interaction--session-table)
    name))

(defun noema-interaction-session-set-profile (profile &optional project-root)
  "Store PROFILE in the session for PROJECT-ROOT and return it."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :profile profile))
    (puthash root session noema-interaction--session-table)
    profile))

(defun noema-interaction-session-initialized-p (&optional project-root)
  "Return non-nil when PROJECT-ROOT has completed initial workbench setup."
  (plist-get (noema-interaction-session-get project-root) :initialized))

(defun noema-interaction-session-set-initialized (value &optional project-root)
  "Store VALUE as the initialized flag for PROJECT-ROOT and return VALUE."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :initialized value))
    (puthash root session noema-interaction--session-table)
    value))

(defun noema-interaction-session-profile-injected-backends (&optional project-root)
  "Return the backends with injected profile state for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :profile-injected-backends))

(defun noema-interaction-session-profile-bootstrap-sent-backends (&optional project-root)
  "Return the backends with bootstrap prompt already sent for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :profile-bootstrap-sent-backends))

(defun noema-interaction-session-profile-bootstrap-sent-p (backend &optional project-root)
  "Return non-nil when BACKEND already got bootstrap prompt for PROJECT-ROOT."
  (memq backend (noema-interaction-session-profile-bootstrap-sent-backends project-root)))

(defun noema-interaction-session-mark-profile-bootstrap-sent (backend &optional project-root)
  "Record BACKEND as having received bootstrap prompt for PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root)))
         (backends (plist-get session :profile-bootstrap-sent-backends)))
    (unless (memq backend backends)
      (setq backends (cons backend backends)))
    (setq session (plist-put session :profile-bootstrap-sent-backends backends))
    (puthash root session noema-interaction--session-table)
    backends))

(defun noema-interaction-session-clear-profile-bootstrap-sent (backend &optional project-root)
  "Clear bootstrap-sent marker for BACKEND in PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root)))
         (backends (delq backend
                         (copy-sequence
                          (plist-get session :profile-bootstrap-sent-backends)))))
    (setq session (plist-put session :profile-bootstrap-sent-backends backends))
    (puthash root session noema-interaction--session-table)
    backends))

(defun noema-interaction-session-profile-injected-p (backend &optional project-root)
  "Return non-nil when BACKEND already got profile injection for PROJECT-ROOT."
  (memq backend (noema-interaction-session-profile-injected-backends project-root)))

(defun noema-interaction-session-mark-profile-injected (backend &optional project-root)
  "Record BACKEND as having completed profile injection for PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root)))
         (backends (plist-get session :profile-injected-backends)))
    (unless (memq backend backends)
      (setq backends (cons backend backends)))
    (setq session (plist-put session :profile-injected-backends backends))
    (puthash root session noema-interaction--session-table)
    backends))

(defun noema-interaction-session-clear-profile-injected (backend &optional project-root)
  "Clear profile-injected marker for BACKEND in PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root)))
         (backends (delq backend (copy-sequence
                                 (plist-get session :profile-injected-backends)))))
    (setq session (plist-put session :profile-injected-backends backends))
    (puthash root session noema-interaction--session-table)
    backends))

(defun noema-interaction-session-reset-profile-injected (&optional project-root)
  "Clear all profile bootstrap and injected markers for PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :profile-bootstrap-sent-backends nil))
    (setq session (plist-put session :profile-injected-backends nil))
    (puthash root session noema-interaction--session-table)
    nil))

(defun noema-interaction-project-name (&optional project-root)
  "Return a short display name for PROJECT-ROOT."
  (file-name-nondirectory
   (directory-file-name (or project-root (noema-interaction-project-root)))))

(defun noema-interaction-session-last-prompt (&optional project-root)
  "Return the last prompt stored for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :last-prompt))

(defun noema-interaction-session-set-last-prompt (prompt &optional project-root)
  "Store PROMPT as the last prompt for PROJECT-ROOT and return PROMPT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :last-prompt prompt))
    (puthash root session noema-interaction--session-table)
    prompt))

(defun noema-interaction-session-last-status (&optional project-root)
  "Return the last status string stored for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :last-status))

(defun noema-interaction-session-set-last-status (status &optional project-root)
  "Store STATUS as the last status for PROJECT-ROOT and return STATUS."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :last-status status))
    (puthash root session noema-interaction--session-table)
    status))

(defun noema-interaction-session-last-error (&optional project-root)
  "Return the last error string stored for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :last-error))

(defun noema-interaction-session-set-last-error (error-text &optional project-root)
  "Store ERROR-TEXT as the last error for PROJECT-ROOT and return ERROR-TEXT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :last-error error-text))
    (puthash root session noema-interaction--session-table)
    error-text))

(defun noema-interaction-session-run-state (&optional project-root)
  "Return the run state stored for PROJECT-ROOT."
  (plist-get (noema-interaction-session-get project-root) :run-state))

(defun noema-interaction-session-set-run-state (state &optional project-root)
  "Store STATE as the run state for PROJECT-ROOT and return STATE."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :run-state state))
    (puthash root session noema-interaction--session-table)
    state))

(defun noema-interaction-session-clear-runtime (&optional project-root)
  "Clear transient runtime state for PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (session (copy-sequence (noema-interaction-session-get root))))
    (setq session (plist-put session :last-status nil))
    (setq session (plist-put session :last-error nil))
    (setq session (plist-put session :run-state 'idle))
    (puthash root session noema-interaction--session-table)
    session))

(defun noema-interaction-panel-buffer-name (&optional project-root)
  "Return the control panel buffer name for PROJECT-ROOT."
  (format "*AI Workbench: %s*" (noema-interaction-project-name project-root)))

(provide 'noema-interaction-session)
;;; noema-interaction-session.el ends here
