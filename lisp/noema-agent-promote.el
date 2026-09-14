;;; noema-agent-promote.el --- Attach agent-shell sessions to Noema -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; A native ACP session can predate Noema.  Promotion records that native
;; identity and an independent Noema Session/Workstream identity without
;; pretending the earlier transcript was observed by Noema.

;;; Code:

(require 'map)
(require 'subr-x)
(require 'noema-agent-acp)

(declare-function my/noema-api-call "init-aaronnote"
                  (channel args callback &optional timeout))
(defvar my/noema--ready)

(defvar-local noema-agent-promote--session-id nil
  "Noema Session id attached to the current agent-shell buffer.")

(defun noema-agent-promote--error-message (error-object)
  "Return a readable message from ERROR-OBJECT."
  (or (and (hash-table-p error-object) (gethash "message" error-object))
      (and (listp error-object)
           (or (alist-get 'message error-object)
               (alist-get :message error-object)))
      "request failed"))

(defun noema-agent-promote--session-spec (&optional buffer title goal)
  "Return the promotion payload for agent-shell BUFFER.
TITLE and GOAL describe the Workstream created when this is the first
promotion.  The ACP session id remains the native id; Noema assigns its own
logical Session id on the host."
  (with-current-buffer (or buffer (current-buffer))
    (unless (noema-agent-acp-agent-buffer-p (current-buffer))
      (user-error "Current buffer is not an agent-shell session"))
    (let* ((buffer (current-buffer))
           (native-id (noema-agent-acp-state-value buffer '(:session :id)))
           (config (noema-agent-acp-state-value buffer '(:agent-config)))
           (identifier (map-elt config :identifier))
           (session-title (noema-agent-acp-state-value buffer '(:session :title)))
           (cwd (expand-file-name default-directory)))
      (unless (and (stringp native-id) (not (string-empty-p native-id)))
        (user-error "The agent-shell session has no native session id yet"))
      `((cwd . ,cwd)
        (executionTarget . ,cwd)
        (agent . ,(if identifier (symbol-name identifier) "agent-shell"))
        (transport . "acp")
        (nativeSessionId . ,native-id)
        (title . ,(or (and (stringp title) title)
                      (and (stringp session-title) session-title)
                      (buffer-name)))
        (goal . ,(or goal ""))
        (capabilities
         . ((sessionList . ,(and (noema-agent-acp-state-value buffer '(:supports-session-list)) t))
            (sessionLoad . ,(and (noema-agent-acp-state-value buffer '(:supports-session-load)) t))
            (sessionResume . ,(and (noema-agent-acp-state-value buffer '(:supports-session-resume)) t))
            (sessionFork . ,(and (noema-agent-acp-state-value buffer '(:supports-session-fork)) t))
            (modelId . ,(or (noema-agent-acp-state-value buffer '(:session :model-id)) ""))
            (modeId . ,(or (noema-agent-acp-state-value buffer '(:session :mode-id)) ""))))))))

;;;###autoload
(defun noema-agent-promote-current-session (&optional title goal)
  "Promote the current agent-shell session into Noema.
TITLE and GOAL initialize a new Workstream when this native session has not
already been attached.  Repeating the command is idempotent."
  (interactive
   (list (read-string "Research title (empty uses session title): ")
         (read-string "Research goal (optional): ")))
  (unless (and (fboundp 'my/noema-api-call)
               (bound-and-true-p my/noema--ready))
    (user-error "Noema web-host is not ready"))
  (let ((buffer (current-buffer))
        (payload (noema-agent-promote--session-spec nil title goal)))
    (my/noema-api-call
     "aaronnote:api:research:session:promote"
     (vector payload)
     (lambda (result error-object)
       (if error-object
           (message "Noema session promotion failed: %s"
                    (noema-agent-promote--error-message error-object))
         (let ((id (and (hash-table-p result) (gethash "id" result))))
           (when (buffer-live-p buffer)
             (with-current-buffer buffer
               (setq noema-agent-promote--session-id id)))
           (message "Noema session attached%s"
                    (if id (format ": %s" id) ""))))))))

;;;###autoload
(defun noema-research-history-index (&optional directory)
  "Rebuild Noema's read-only native history index for DIRECTORY's project.
When DIRECTORY is nil, use `default-directory'.  Source discovery happens in
the host and never changes native history files."
  (interactive)
  (unless (and (fboundp 'my/noema-api-call)
               (bound-and-true-p my/noema--ready))
    (user-error "Noema web-host is not ready"))
  (my/noema-api-call
   "aaronnote:api:research:history:index"
   (vector `((cwd . ,(expand-file-name (or directory default-directory)))))
   (lambda (result error-object)
     (if error-object
         (message "Noema history indexing failed: %s"
                  (noema-agent-promote--error-message error-object))
       (message "Noema history indexed: %s records"
                (or (and (hash-table-p result) (gethash "records" result))
                    0))))))

(provide 'noema-agent-promote)
;;; noema-agent-promote.el ends here
