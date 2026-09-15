;;; noema-pi-router.el --- Per-project Pi coordinator -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; D-032.  Every project root (nearest `noema.toml') has one Pi: an ordinary
;; `pi-acp' agent-shell buffer whose conversation is the reserved session name
;; `pi'.  Pi is the person's front door for session management, but it holds
;; no authority of its own:
;;
;; - its tools are the Noema coordinator MCP endpoint (`/mcp/coordinator'),
;;   which exposes the same deterministic session operations Emacs uses and
;;   refuses to touch names the person pinned;
;; - a `run.start' from Pi is only a durable request.  When Pi finishes a tool
;;   call this router asks the worker to claim pending requests, and each one
;;   runs through the ordinary frozen-RunSpec, lease and permission path;
;; - the coordinator role reaches Pi as MCP server instructions, which pi-acp
;;   appends to Pi's system prompt, so the person's Pi setup is untouched.
;;
;; Pi still has no approval power (D-008).  The D-028 `.agent/pi.json' file is
;; read once for migration and then replaced by the session-name registry.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'noema-research)
(require 'noema-agent-acp)
(require 'noema-agent-promote)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function noema-agent-worker-claim-coordinator-requests "noema-agent-worker" (root))
(defvar my/noema--ready)

(defgroup noema-pi-router nil
  "Per-project Pi coordinator for Noema."
  :group 'applications)

(defconst noema-pi-router-session-name "pi"
  "Reserved D-031 session name of the project coordinator.")

(defcustom noema-pi-router-minimum-pi-acp "0.8.0"
  "Oldest pi-acp version validated with Noema's ACP, MCP and permission flow."
  :type 'string
  :group 'noema-pi-router)

(defcustom noema-pi-router-minimum-node "22.19.0"
  "Oldest Node.js version pi-acp supports."
  :type 'string
  :group 'noema-pi-router)

(defvar noema-pi-router--buffers (make-hash-table :test #'equal)
  "Project root to live Pi agent-shell buffer, for this Emacs session.")

(defvar-local noema-pi-router--claim-timer nil
  "Debounce timer for claiming coordinator requests after Pi tool calls.")

(defun noema-pi-router--root (directory)
  "Return the normalized project root that owns Pi for DIRECTORY.
Like `noema-research-repository-root', the nearest `noema.toml' wins;
otherwise DIRECTORY itself is the root."
  (let* ((directory (file-name-as-directory (expand-file-name directory)))
         (root (locate-dominating-file directory "noema.toml")))
    (file-name-as-directory (expand-file-name (or root directory)))))

(defun noema-pi-router--value (object key)
  "Read string KEY from JSON-like OBJECT."
  (let ((value (cond ((hash-table-p object) (gethash key object))
                     ((listp object) (cdr (or (assoc key object)
                                              (assq (intern key) object)))))))
    (unless (memq value '(:null :false)) value)))

(defun noema-pi-router--string (object key)
  "Read a non-empty string KEY from OBJECT, or nil."
  (let ((value (noema-pi-router--value object key)))
    (and (stringp value) (not (string-empty-p value)) value)))

(defun noema-pi-router--api (channel body callback)
  "Call Noema CHANNEL with BODY and CALLBACK (RESULT ERROR)."
  (unless (fboundp 'my/noema-api-call)
    (user-error "Noema host integration is unavailable"))
  (my/noema-api-call channel (vector body) callback 30))

(defun noema-pi-router--legacy-registry-file (root)
  "Return ROOT's D-028 Pi registry path."
  (expand-file-name "pi.json" (expand-file-name noema-research-state-directory root)))

(defun noema-pi-router--legacy-native-session-id (root)
  "Return the native Pi session id remembered by D-028 for ROOT, or nil."
  (let ((path (noema-pi-router--legacy-registry-file root)))
    (and (file-readable-p path)
         (ignore-errors
           (with-temp-buffer
             (insert-file-contents path)
             (noema-pi-router--string (noema-research-parse-json (buffer-string))
                                      "nativeSessionId"))))))

;;;###autoload
(defun noema-pi-router-buffer (&optional directory)
  "Return the live Pi buffer of DIRECTORY's project, or nil.
Never starts one; use `noema-pi-router-open' for that."
  (let* ((root (noema-pi-router--root (or directory default-directory)))
         (buffer (or (gethash root noema-pi-router--buffers)
                     (noema-agent-acp-session-buffer noema-pi-router-session-name root))))
    (and (buffer-live-p buffer) buffer)))

(defun noema-pi-router--mcp-servers (endpoint)
  "Return agent-shell MCP servers for coordinator ENDPOINT."
  (let ((shared (noema-pi-router--string endpoint "mcpUrl"))
        (coordinator (noema-pi-router--string endpoint "coordinatorUrl")))
    (delq nil
          (list (and shared `((name . "noema") (type . "http") (url . ,shared) (headers . ())))
                (and coordinator
                     `((name . "noema-coordinator") (type . "http") (url . ,coordinator) (headers . ())))))))

(defun noema-pi-router--adopt (root buffer)
  "Record BUFFER's native Pi session as ROOT's `pi' session name."
  (when (and (buffer-live-p buffer) (fboundp 'my/noema-api-call))
    (condition-case error-object
        (noema-pi-router--api
         "aaronnote:api:research:session:promote"
         (noema-agent-promote--session-spec buffer "Pi coordinator" "Project coordination")
         (lambda (result promote-error)
           (if promote-error
               (display-warning 'noema-pi-router
                                (format "Pi session could not be recorded: %s"
                                        (noema-agent-promote--error-message promote-error))
                                :warning)
             (let ((id (noema-pi-router--string result "id")))
               (when (buffer-live-p buffer)
                 (with-current-buffer buffer
                   (setq-local noema-agent-promote--session-id id)))
               (noema-pi-router--api
                "aaronnote:api:research:session:name:bind"
                `((cwd . ,root) (name . ,noema-pi-router-session-name)
                  (agent . "pi") (sessionId . ,id))
                (lambda (_bound bind-error)
                  (if bind-error
                      (display-warning 'noema-pi-router
                                       (format "Pi session name could not be bound: %s"
                                               (noema-agent-promote--error-message bind-error))
                                       :warning)
                    (ignore-errors
                      (delete-file (noema-pi-router--legacy-registry-file root))))))))))
      (error
       (display-warning 'noema-pi-router
                        (format "Pi session could not be recorded: %s"
                                (error-message-string error-object))
                        :warning)))))

;;;###autoload
(defun noema-pi-router-claim (&optional directory)
  "Run pending Pi coordinator requests of DIRECTORY's project."
  (interactive)
  (require 'noema-agent-worker)
  (noema-agent-worker-claim-coordinator-requests
   (noema-pi-router--root (or directory default-directory))))

(defun noema-pi-router--schedule-claim (root buffer)
  "Claim ROOT's coordinator requests shortly after Pi's tool activity in BUFFER."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (timerp noema-pi-router--claim-timer)
        (cancel-timer noema-pi-router--claim-timer))
      (setq noema-pi-router--claim-timer
            (run-at-time 0.5 nil
                         (lambda ()
                           (when (buffer-live-p buffer)
                             (with-current-buffer buffer
                               (setq noema-pi-router--claim-timer nil)))
                           (noema-pi-router-claim root)))))))

(defun noema-pi-router--start (root native endpoint)
  "Start ROOT's Pi, resuming NATIVE when known, wired to coordinator ENDPOINT."
  (let ((config (or (noema-agent-acp-config-for "pi")
                    (user-error "Pi (pi-acp) is not configured; run M-x noema-pi-doctor")))
        (servers (noema-pi-router--mcp-servers endpoint)))
    (when servers
      (setf (alist-get :mcp-servers config) servers))
    (let ((buffer (noema-agent-acp-start :config config :directory root
                                         :session-id native :focus t)))
      (noema-agent-acp-mark-session-buffer buffer noema-pi-router-session-name "pi" root)
      (puthash root buffer noema-pi-router--buffers)
      (noema-agent-acp-subscribe
       :buffer buffer :event 'init-session
       :callback (lambda (_event) (noema-pi-router--adopt root buffer)))
      (noema-agent-acp-subscribe
       :buffer buffer :event 'tool-call-update
       :callback (lambda (_event) (noema-pi-router--schedule-claim root buffer)))
      buffer)))

;;;###autoload
(defun noema-pi-router-open (&optional directory)
  "Open the one Pi coordinator of DIRECTORY's project (default: here).
A live Pi buffer is reused.  Otherwise Pi resumes the conversation recorded
under the project's `pi' session name, or starts a fresh one."
  (interactive (list default-directory))
  (let* ((root (noema-pi-router--root (or directory default-directory)))
         (cached (noema-pi-router-buffer root)))
    (if cached
        (pop-to-buffer cached)
      (unless (fboundp 'my/noema--ensure-server)
        (user-error "Noema host integration is unavailable"))
      (my/noema--ensure-server
       (lambda ()
         (noema-pi-router--api
          "aaronnote:api:research:coordinator:endpoint" `((cwd . ,root))
          (lambda (endpoint _endpoint-error)
            (noema-pi-router--api
             "aaronnote:api:research:session:name:get"
             `((cwd . ,root) (name . ,noema-pi-router-session-name))
             (lambda (result _name-error)
               (let ((native (or (noema-pi-router--string
                                  (noema-pi-router--value result "name") "nativeSessionId")
                                 (noema-pi-router--legacy-native-session-id root))))
                 (unless (noema-pi-router-buffer root)
                   (noema-pi-router--start root native endpoint))))))))))))

(defun noema-pi-router--program-version (program &rest args)
  "Return the first line PROGRAM ARGS prints, or nil."
  (ignore-errors (car (apply #'process-lines program args))))

(defun noema-pi-router--version-at-least-p (minimum version)
  "Return non-nil when VERSION is at least MINIMUM."
  (and (stringp version)
       (string-match "[0-9]+\\(?:\\.[0-9]+\\)*" version)
       (ignore-errors (version<= minimum (match-string 0 version)))))

(defun noema-pi-router-checks ()
  "Return Pi deployment checks as (OK LABEL DETAIL) lists."
  (let* ((acp (executable-find "pi-acp"))
         (acp-version (and acp (noema-pi-router--program-version acp "--version")))
         (node (executable-find "node"))
         (node-version (and node (noema-pi-router--program-version node "--version")))
         (auth (expand-file-name "~/.pi/agent/auth.json")))
    (list
     (list (and acp t) "pi-acp on PATH"
           (or acp "missing: npm install -g @automatalabs/pi-acp@0.8.0"))
     (list (noema-pi-router--version-at-least-p noema-pi-router-minimum-pi-acp acp-version)
           (format "pi-acp >= %s" noema-pi-router-minimum-pi-acp)
           (or acp-version "unknown"))
     (list (noema-pi-router--version-at-least-p noema-pi-router-minimum-node node-version)
           (format "node >= %s" noema-pi-router-minimum-node)
           (or node-version "missing"))
     (list (file-readable-p auth) "Pi login"
           (if (file-readable-p auth) auth "not logged in: open Pi (C-c A P) and run /login"))
     (list (and (noema-agent-acp-config-for "pi") t) "agent-shell Pi configuration"
           (if (noema-agent-acp-config-for "pi") "agent-shell-pi" "agent-shell-pi is unavailable"))
     (list (bound-and-true-p my/noema--ready) "Noema host"
           (if (bound-and-true-p my/noema--ready) "ready" "not started (it starts on first use)")))))

;;;###autoload
(defun noema-pi-doctor ()
  "Report whether Pi is deployed well enough to coordinate this project."
  (interactive)
  (let ((checks (noema-pi-router-checks))
        (buffer (get-buffer-create "*Noema Pi doctor*"))
        (root (noema-pi-router--root default-directory)))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "Noema Pi coordinator — %s\n\n" (abbreviate-file-name root)))
        (dolist (check checks)
          (insert (format "%s %-32s %s\n" (if (car check) "✓" "✗") (nth 1 check) (nth 2 check)))))
      (special-mode))
    (display-buffer buffer)
    (when (and (fboundp 'my/noema-api-call) (bound-and-true-p my/noema--ready))
      (noema-pi-router--api
       "aaronnote:api:research:coordinator:endpoint" `((cwd . ,root))
       (lambda (endpoint error-object)
         (when (buffer-live-p buffer)
           (with-current-buffer buffer
             (let ((inhibit-read-only t)
                   (url (noema-pi-router--string endpoint "coordinatorUrl")))
               (goto-char (point-max))
               (insert (format "%s %-32s %s\n" (if (and url (not error-object)) "✓" "✗")
                               "coordinator MCP endpoint"
                               (or url "kernel is not listening yet")))))))))
    checks))

(provide 'noema-pi-router)
;;; noema-pi-router.el ends here
