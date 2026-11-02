;;; noema-pi-router.el --- Emacs companion and project Pi routing -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; One Pi accompanies Emacs; each local project gets its own Pi on first use.
;; Native ACP identities and provider history remain authoritative.
;; Pi gets the progressively disclosed Noema API, with coordinator access for
;; retained Research projects. It never grants human approvals itself.
;; noema-pi-sessions owns durable references; tools/agent/acp owns clients.
;; Lifecycle contracts: docs/design/pi-sessions.md in the Emacs repository.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'json)
(require 'noema-pi-sessions)
(require 'noema-context)
(require 'tools/agent/acp)

(defconst noema-pi-router--resource-directory
  (expand-file-name "../resources/pi/" (file-name-directory (or load-file-name buffer-file-name))))
(defconst noema-pi-router--profile
  (with-temp-buffer
    (insert-file-contents (expand-file-name "profile.json" noema-pi-router--resource-directory))
    (json-parse-buffer :object-type 'hash-table :array-type 'list)))

(declare-function +noema-api-call "noema/bridge/config" (channel args callback &optional timeout))
(declare-function +noema--ensure-server "noema/bridge/config" (&optional callback))
(declare-function +agent-api-identified "tools/agent/api" (body))
(declare-function +agent-context-state "tools/agent/context" (&optional window))
(declare-function +agent-context--deliver "tools/agent/context" (buffer blocks &optional instructions no-focus))
(declare-function noema-agent-worker-claim-coordinator-requests "noema-agent-worker" (root &optional on-complete))
(defvar +noema--ready)

(defgroup noema-pi-router nil
  "Per-project Pi session manager for Noema."
  :group 'applications)

;;;; Companion and project routing

(defcustom noema-pi-auto-start t
  "Start the Emacs companion at interactive startup; project Pi is on demand."
  :type 'boolean :group 'noema-pi-router)

(defcustom noema-pi-idle-delay 0.5
  "Idle seconds before automatic companion prewarming.
Explicit open/send commands do not wait for this timer."
  :type 'number :group 'noema-pi-router)
(defvar noema-pi-router--startup-timer nil)

(defun noema-pi-router--cancel-startup ()
  (when (timerp noema-pi-router--startup-timer)
    (cancel-timer noema-pi-router--startup-timer))
  (setq noema-pi-router--startup-timer nil))

(defun noema-pi-router--warmup ()
  "Run one idle prewarm, never a model task or a display action."
  (setq noema-pi-router--startup-timer nil)
  (when (and noema-pi-assistant-mode (not noninteractive))
    (condition-case err
        (noema-pi-emacs-ensure)
      (error (noema-pi-router--warn "%s" (error-message-string err))))))

(defun noema-pi-router--schedule-startup ()
  "Own one idle timer for the Emacs companion only."
  (unless (timerp noema-pi-router--startup-timer)
    (setq noema-pi-router--startup-timer
          (run-with-idle-timer (max 0 noema-pi-idle-delay) nil #'noema-pi-router--warmup))))

;;;###autoload
(defun noema-pi-startup ()
  "Enable the companion lifecycle according to `noema-pi-auto-start'."
  (when (and noema-pi-auto-start (not noninteractive))
    (noema-pi-assistant-mode 1)))

(defun noema-pi-router--auto-start-changed (&optional _name _value)
  "Apply the unified configuration switch to automatic work immediately."
  (noema-pi-assistant-mode (if (and noema-pi-auto-start (not noninteractive)) 1 -1)))

(defconst noema-pi-router-session-name "pi"
  "Display name of a project Pi in the shared Agent runtime.")

(defvar noema-pi-router--emacs-buffer nil "Emacs companion Pi buffer.")
(defvar-local noema-pi-parent nil "The project Pi's Emacs companion buffer.")
(put 'noema-pi-parent 'permanent-local t)

(defun noema-pi-router--parse-json (source)
  "Parse a Pi-owned JSON value without loading Research."
  (json-parse-string source :object-type 'hash-table :array-type 'array
                     :null-object :null :false-object :false))

(defun noema-pi-router--remembered (scope)
  "Return SCOPE's active native conversation from Pi's own session store."
  (or (noema-pi-sessions-active-native scope)
      (when (and (not (equal scope "emacs"))
                 (not (seq-some (lambda (record) (equal (gethash "scope" record) scope))
                                (noema-pi-sessions-records))))
        (when-let* ((native (noema-pi-router--legacy-native-session-id scope)))
          (noema-pi-sessions-import-native scope native (noema-pi-router--legacy-registry-file scope))
          native))))

(defvar-local noema-pi-router--confirmed-native nil
  "The native conversation whose provider-owned history was verified.")
(defvar-local noema-pi-router--history-request nil)
(defvar-local noema-pi-router--history-dirty nil)
(defvar-local noema-pi-router--history-observed nil)
(defvar-local noema-pi-router--history-timer nil)
(defvar-local noema-pi-router--history-generation nil)

(defun noema-pi-router--current-p (scope buffer native client)
  "Whether BUFFER still owns this SCOPE, native conversation and client."
  (and (buffer-live-p buffer)
       (not (+agent-acp-client-exited-p buffer))
       (equal native (+agent-acp-state-value buffer '(:session :id)))
       (eq client (+agent-acp-state-value buffer '(:client)))
       (let ((attached (buffer-local-value 'noema-pi-router--scope buffer)))
         (or (not attached)
             (and (equal attached scope)
                  (eq buffer (if (equal scope "emacs") noema-pi-router--emacs-buffer
                               (gethash scope noema-pi-router--buffers))))))))

(defun noema-pi-router--history-result (buffer token rows error-object)
  "Accept TOKEN's history result only while its exact client still owns it."
  (when (and (buffer-live-p buffer)
             (eq token (buffer-local-value 'noema-pi-router--history-request buffer)))
    (with-current-buffer buffer
      (let* ((key (cdr token)) (scope (nth 1 key)) (native (nth 2 key))
             (client (nth 3 key)) (generation (nth 4 key))
             (next noema-pi-router--history-dirty))
        (setq noema-pi-router--history-request nil noema-pi-router--history-dirty nil)
        (when (noema-pi-router--current-p scope buffer native client)
          (unless error-object
            (cond
             ((seq-some (lambda (row) (equal (map-elt row 'sessionId) native)) rows)
              (noema-pi-sessions-observe scope buffer)
              (setq noema-pi-router--confirmed-native native noema-pi-router--history-observed key))
             ((equal generation 0) (noema-pi-sessions-note-volatile scope native))))
          (when next (noema-pi-router--remember scope buffer (nth 4 next))))))))

(defun noema-pi-router--remember (scope buffer &optional completed-generation)
  "Confirm history once per client and observe each actual turn once."
  (when-let* ((native (+agent-acp-state-value buffer '(:session :id))))
    (let* ((client (+agent-acp-state-value buffer '(:client)))
           (generation (or completed-generation (+agent-acp-state-value buffer '(:request-count))))
           (key (list (noema-pi-sessions--file) scope native client generation)))
      (when (noema-pi-router--current-p scope buffer native client)
        (with-current-buffer buffer
          (cond
           ((equal key noema-pi-router--history-observed) nil)
           (noema-pi-router--history-request
            (unless (equal key (cdr noema-pi-router--history-request))
              (setq noema-pi-router--history-dirty key)))
           ((or (equal noema-pi-router--confirmed-native native)
                (equal (+agent-acp-state-value buffer '(:resume-session-id)) native))
            (noema-pi-sessions-observe scope buffer)
            (setq noema-pi-router--confirmed-native native noema-pi-router--history-observed key))
           (t
            (let ((token (cons (make-symbol "pi-history") key)))
              (setq noema-pi-router--history-request token)
              (condition-case err
                  (+agent-acp-list-native-sessions
                   buffer (apply-partially #'noema-pi-router--history-result buffer token) 1)
                (error
                 (when (eq token noema-pi-router--history-request)
                   (setq noema-pi-router--history-request nil noema-pi-router--history-dirty nil))
                 (signal (car err) (cdr err))))))))))))

(defun noema-pi-router--turn-complete (buffer _event)
  "Observe native and structured turns through the same shared event."
  (when (and (buffer-live-p buffer)
             (buffer-local-value 'noema-pi-router--scope buffer))
    (with-current-buffer buffer
      (setq noema-pi-router--history-generation (+agent-acp-state-value buffer '(:request-count)))
      (unless (timerp noema-pi-router--history-timer)
        (let ((scope noema-pi-router--scope)
              (native (+agent-acp-state-value buffer '(:session :id)))
              (client (+agent-acp-state-value buffer '(:client))) timer)
          (setq timer
                (run-at-time
                 0 nil
                 (lambda ()
                   (when (and (buffer-live-p buffer)
                              (eq timer (buffer-local-value 'noema-pi-router--history-timer buffer)))
                     (with-current-buffer buffer
                       (setq noema-pi-router--history-timer nil)
                       (when (noema-pi-router--current-p scope buffer native client)
                         (noema-pi-router--remember scope buffer noema-pi-router--history-generation)))))))
          (setq noema-pi-router--history-timer timer))))))
(add-hook '+agent-acp-turn-complete-functions #'noema-pi-router--turn-complete)

(defun noema-pi-router--group (buffer)
  "Expose Pi's independent source group using only buffer facts."
  (when (and (buffer-live-p buffer)
             (memq (buffer-local-value '+agent-acp-session-origin buffer) '(pi pi-emacs pi-project)))
    '(:key pi :label "Pi")))
(add-hook '+agent-session-group-functions #'noema-pi-router--group)

(defun noema-pi-router--show-or-resume (buffer)
  "Show BUFFER, explicitly reconnecting its actual conversation if needed."
  (if (memq (plist-get (+agent-session-snapshot buffer) :process-state) '(dead disconnected))
      (+agent-acp-restart-native buffer
                                 (or (+agent-acp-state-value buffer '(:session :id))
                                     (+agent-acp-state-value buffer '(:resume-session-id))
                                     (noema-pi-router--remembered
                                      (buffer-local-value 'noema-pi-router--scope buffer))))
    (+agent-acp-show-buffer buffer)
    buffer))

(defun noema-pi-emacs-ensure (&optional focus)
  "Return the one Emacs companion Pi, starting or resuming it when necessary."
  ;; The companion's API must work before the first Markdown page is opened.
  ;; Reuse the supervised host asynchronously; native Pi initialization does
  ;; not wait on it and batch callers never start a real host implicitly.
  (when (and (not noninteractive) (not (bound-and-true-p +noema--ready))
             (fboundp '+noema--ensure-server))
    (+noema--ensure-server))
  (if (buffer-live-p noema-pi-router--emacs-buffer)
      (if focus (noema-pi-router--show-or-resume noema-pi-router--emacs-buffer)
        noema-pi-router--emacs-buffer)
    (noema-pi-router--start-scope
     "emacs" noema-pi-companion-directory (noema-pi-router--remembered "emacs") focus)))

;;;###autoload
(defun noema-pi-emacs-open (&optional project)
  "Recall the global Pi; in its selected view, hide it and return to editing.
With prefix PROJECT, open the editor source's project Pi instead."
  (interactive "P")
  (cond
   (project (noema-pi-router-open))
   ((and (buffer-live-p noema-pi-router--emacs-buffer)
         (eq (window-buffer (selected-window)) noema-pi-router--emacs-buffer))
    (+agent-acp-hide noema-pi-router--emacs-buffer))
   (t (noema-pi-emacs-ensure t))))

(defun noema-pi-router--source-scope ()
  "Resolve the editor's project without creating a Pi or a Research project."
  (remote-require-on-client 'tools/agent/context)
  (let* ((context (+agent-context-state))
         (root (or (and (or (alist-get 'file context)
                            (equal (alist-get 'mode context) "dired-mode"))
                        (alist-get 'root context))
                   (alist-get 'activeProject context))))
    (cond (root (noema-pi-project-root root))
          ((and (eq (+agent-session-kind (current-buffer)) 'pi)
                (not (equal noema-pi-router--scope "emacs"))) noema-pi-router--scope)
          (t "emacs"))))

;;;###autoload
(defun noema-pi-open (&optional companion)
  "Toggle this project's own Pi, creating it on first use.
Outside a project, or with prefix COMPANION, toggle the Emacs companion."
  (interactive "P")
  (let* ((scope (if companion "emacs" (noema-pi-router--source-scope)))
         (buffer (if (equal scope "emacs") noema-pi-router--emacs-buffer
                   (gethash scope noema-pi-router--buffers))))
    (if (and (buffer-live-p buffer) (eq (window-buffer (selected-window)) buffer))
        (+agent-acp-hide buffer)
      (if (equal scope "emacs") (noema-pi-emacs-ensure t)
        (noema-pi-router--show-or-resume (noema-pi-project-ensure scope))))))

(defun noema-pi-project-ensure (directory)
  "Return DIRECTORY's child Pi without selecting its window."
  (setq directory (or (remote-client-file-name (remote-canonicalize-emacs-file-name directory)) directory))
  (when (file-remote-p directory)
    (user-error "The Emacs companion's project Pi currently requires a local project"))
  (noema-pi-emacs-ensure)
  (let ((root (noema-pi-router--root directory)))
    (or (noema-pi-router-buffer root) (noema-pi-router--launch root nil))))

(defun noema-pi-router--from-header (from)
  "Return the header naming the Agent session FROM, proven by its identity.
An Agent cannot be answered, or told from a person, without this."
  (remote-require-on-client 'tools/agent/api)
  (let ((session (+agent-api-identified from)))
    (format "[From Agent session: agent=%s buffer=%s nativeSessionId=%s root=%s. This is another Agent, not the person. It hears you only through this call: noema_call channel=noema:api:emacs:agent args=%s]\n\n"
            (plist-get session :agent) (buffer-name (plist-get session :buffer))
            (plist-get session :native-session-id) (plist-get session :root)
            ;; Buffer names are not ASCII, and `json-serialize' answers in bytes.
            (decode-coding-string
             (json-serialize
              (vector `((action . "send") (buffer . ,(buffer-name (plist-get session :buffer)))
                        (nativeSessionId . ,(plist-get session :native-session-id))
                        (prompt . "<your answer>"))))
             'utf-8))))

(defun noema-pi-send (directory prompt &optional companion focus)
  "Submit PROMPT to DIRECTORY's child Pi, or the COMPANION.
Queue behind an active turn; never interrupt or replay the current turn."
  (unless (and (stringp prompt) (not (string-empty-p (string-trim prompt))))
    (user-error "A Pi request is required"))
  (let ((buffer (if companion (noema-pi-emacs-ensure)
                  (noema-pi-project-ensure directory))))
    (when (memq (plist-get (+agent-session-snapshot buffer) :process-state) '(dead disconnected))
      (user-error "Pi is disconnected; resume it in Pi Sessions before submitting a new task"))
    (remote-require-on-client 'tools/agent/context)
    (+agent-context--deliver buffer `(((type . "text") (text . ,prompt))) nil (not focus))
    buffer))

(cl-defun noema-pi-api (body)
  "Handle Pi's own semantic session API through the local Emacs gateway."
  (let* ((action (or (noema-pi-router--string body "action") "status"))
         (record (when-let* ((id (noema-pi-router--string body "sessionId")))
                   (noema-pi-sessions-find id)))
         (companion (if record (equal (gethash "role" record) "emacs")
                      (eq (noema-pi-router--value body "companion") t)))
         (root (if record (unless companion (gethash "scope" record))
                 (noema-pi-router--string body "root")))
         (focus (eq (noema-pi-router--value body "focus") t))
         (prompt (noema-pi-router--string body "prompt"))
         (from (noema-pi-router--value body "from")) buffer)
    (when (equal action "context")
      (remote-require-on-client 'tools/agent/context)
      (cl-return-from noema-pi-api `((ok . t) (context . ,(+agent-context-state)))))
    (when root
      (unless (file-name-absolute-p root) (user-error "Project root must be absolute"))
      (setq root (noema-pi-router--root root)))
    (when (equal action "list")
      (let* ((offset (or (noema-pi-router--value body "offset") 0))
             (limit (or (noema-pi-router--value body "limit") 20))
             (history (seq-filter (lambda (item)
                                    (cond (root (equal (gethash "scope" item) root))
                                          (companion (equal (gethash "role" item) "emacs"))
                                          (t t))) (noema-pi-sessions-records)))
             (total (length history)) children)
        (unless (and (integerp offset) (>= offset 0) (integerp limit) (<= 1 limit 100))
          (user-error "offset must be >= 0 and limit must be 1..100"))
        (maphash (lambda (directory child)
                   (when (and (buffer-live-p child) (or (null root) (equal root directory)))
                     (push `((root . ,directory) (buffer . ,(buffer-name child))
                             (nativeSessionId . ,(+agent-acp-state-value child '(:session :id)))
                             (state . ,(noema-pi-sessions--state child))) children)))
                 noema-pi-router--buffers)
        (setq children (sort children (lambda (a b) (string< (alist-get 'root a) (alist-get 'root b)))))
        (cl-return-from noema-pi-api
          `((ok . t) (currentProject . ,(bound-and-true-p +project-active-root))
            (companion . ,(when (buffer-live-p noema-pi-router--emacs-buffer)
                            (+agent-acp-state-value noema-pi-router--emacs-buffer '(:session :id))))
            (children . ,(vconcat (seq-subseq children (min offset (length children))
                                             (min (length children) (+ offset limit)))))
            (childrenTotal . ,(length children))
            (childrenNextOffset . ,(when (< (+ offset limit) (length children)) (+ offset limit)))
            (sessions . ,(vconcat (seq-subseq history (min offset total) (min total (+ offset limit)))))
            (total . ,total) (nextOffset . ,(when (< (+ offset limit) total) (+ offset limit)))))))
    (unless (or companion (and root (file-name-absolute-p root) (file-directory-p root)))
      (user-error "Specify companion:true or an existing absolute project root"))
    (setq buffer
          (pcase action
            ("status" (if companion noema-pi-router--emacs-buffer (noema-pi-router-buffer root)))
            ("ensure" (if companion (noema-pi-emacs-ensure focus)
                        (let ((child (noema-pi-project-ensure root)))
                          (if focus (noema-pi-router--show-or-resume child) child))))
            ("send" (noema-pi-send root (if (memq from '(nil :null)) prompt
                                          (concat (noema-pi-router--from-header from) prompt))
                                   companion focus))
            ("resume" (unless record (user-error "sessionId is required"))
             (noema-pi-sessions-resume record))
            ("new" (noema-pi-sessions-new (if companion "emacs" (noema-pi-project-root root))))
            ("archive" (unless record (user-error "sessionId is required"))
             (noema-pi-sessions-archive record) nil)
            (_ (user-error "Unknown Pi operation: %s" action))))
    `((ok . t) (accepted . ,(not (equal action "status")))
      (role . ,(if companion "emacs" "project")) (root . ,(or root noema-pi-companion-directory))
      (buffer . ,(when (buffer-live-p buffer) (buffer-name buffer)))
      (nativeSessionId . ,(when (buffer-live-p buffer) (+agent-acp-state-value buffer '(:session :id))))
      (state . ,(noema-pi-sessions--state buffer))
      (parent . ,(and (not companion) (buffer-live-p noema-pi-router--emacs-buffer)
                      (buffer-name noema-pi-router--emacs-buffer))))))

;;;###autoload
(defun noema-pi-request-prompt-document (&optional directory source selection)
  "Ask the project Pi for an ordinary Noema Markdown prompt document.
SOURCE and SELECTION are references, never copied into a new Compose UI."
  (interactive)
  (let* ((directory (or directory default-directory))
         (purpose (read-string "Prompt document purpose: "))
         (request (format "%s%s%s"
                          (noema-agent-text "prompt-document" :project directory :purpose purpose)
                          (if source (format " Source reference: %s." source) "")
                          (if selection (concat "\n" selection) ""))))
    (unless (fboundp '+noema--ensure-server) (user-error "Noema host integration is unavailable"))
    (+noema--ensure-server (lambda () (noema-pi-send directory request nil t)))))

(defun noema-pi-router--project-activated (root)
  "Withdraw a previous project's Pi view; never create a client on entry."
  (dolist (window (window-list (selected-frame) 'nomini))
    (when (window-live-p window)
      (let* ((buffer (window-buffer window))
             (scope (buffer-local-value 'noema-pi-router--scope buffer)))
        (when (and scope (not (equal scope "emacs"))
                   (not (equal scope (and root (noema-pi-project-root root)))))
          (save-selected-window
            (with-selected-window window (+agent-acp-hide buffer))))))))
(add-hook '+project-activated-hook #'noema-pi-router--project-activated)

(defun noema-pi-router--startup ()
  "Schedule the companion after interactive startup; issue no model prompt."
  (when (and noema-pi-assistant-mode (not noninteractive))
    (noema-pi-router--schedule-startup)))

;;;###autoload
(define-minor-mode noema-pi-assistant-mode
  "Prewarm the Emacs companion; project Pi clients are created on demand.
Disabling stops automatic launches; existing conversations remain available."
  :global t :group 'noema-pi-router
  (if noema-pi-assistant-mode
      (progn
        (add-hook 'emacs-startup-hook #'noema-pi-router--startup)
        (when after-init-time (noema-pi-router--startup)))
    (remove-hook 'emacs-startup-hook #'noema-pi-router--startup)
    (noema-pi-router--cancel-startup)))

(defcustom noema-pi-companion-directory (file-name-as-directory (expand-file-name "~"))
  "Working directory of the Emacs-wide Pi, separate from any entered project."
  :type 'directory :group 'noema-pi-router)

(defcustom noema-pi-agent-directory (locate-user-emacs-file "var/noema/pi/")
  "Pi agent directory Noema deploys and passes to Pi as `PI_CODING_AGENT_DIR'.
Noema owns its manager keys in `settings.json', `SYSTEM.md' and the
`extensions/noema-manager' extension; other settings are kept."
  :type 'directory
  :group 'noema-pi-router)

(defcustom noema-pi-config-directory (locate-user-emacs-file "etc/noema/pi/")
  "Private local Pi settings and authentication, linked into its runtime directory."
  :type 'directory :group 'noema-pi-router)

(defcustom noema-pi-runtime-directory (locate-user-emacs-file "var/agent/pi/runtime/")
  "Emacs-owned pinned npm runtime installed by make pi-setup."
  :type 'directory :group 'noema-pi-router)

(defcustom noema-pi-credentials-file nil
  "Optional credential import source; nil uses Emacs's own private Pi auth.
An explicit source is imported once without changing it."
  :type '(choice (const nil) file)
  :group 'noema-pi-router)

(defcustom noema-pi-codex-auth-file "~/.codex/auth.json"
  "Codex CLI login that Noema's Pi may use for openai-codex models.
Noema reads only its access token through a command; it does not copy the
token or refresh token into Pi's credential store."
  :type 'file
  :group 'noema-pi-router)

(defcustom noema-pi-model (gethash "defaultModel" noema-pi-router--profile)
  "Model the Pi manager uses, as \"provider/model-id\".
Session management needs little reasoning, so a small, cheap model is right.
Empty uses the first pool model on initial deployment, then keeps Pi's saved
choice."
  :type 'string
  :group 'noema-pi-router)

(defcustom noema-pi-model-pool (gethash "modelPool" noema-pi-router--profile)
  "Ordered model choices for Noema's Pi manager.
Pi uses this list for native model cycling, and Noema uses it for its quick
model picker.  A model appears in the live ACP picker only when Pi advertises
it and its provider is authenticated."
  :type '(repeat string)
  :group 'noema-pi-router)

(defcustom noema-pi-thinking-level (gethash "thinkingLevel" noema-pi-router--profile "medium")
  "Thinking level of the Pi manager."
  :type '(choice (const "off") (const "minimal") (const "low") (const "medium") (const "high"))
  :group 'noema-pi-router)

(defcustom noema-pi-permission-policy
  (intern (gethash "permissionPolicy" noema-pi-router--profile "allow"))
  "Tool permission policy for Emacs companion and project Pi sessions."
  :type '(choice (const allow) (const ask)) :group 'noema-pi-router)

(defun noema-pi-router--apply-permissions (buffer)
  "Apply Pi's configured tool permissions through the shared ACP owner."
  (+agent-acp-set-permission-responder
   buffer (and (eq noema-pi-permission-policy 'allow) #'agent-shell-permission-allow-always) t))

(defun noema-pi-router--permission-policy-changed (&optional _name _value)
  "Apply a Config change to existing Pi clients and pending requests."
  (dolist (session (+agent-acp-sessions))
    (when (eq (+agent-session-kind session) 'pi)
      (noema-pi-router--apply-permissions (plist-get session :buffer)))))

(defcustom noema-pi-system-prompt nil
  "A private system prompt, or nil for the versioned resources/pi/SYSTEM.md.
Nil is the default on purpose: a copy read at load time goes stale the moment
the file changes under a running Emacs, and would then be deployed as an override."
  :type '(choice (const :tag "Versioned prompt" nil) string) :group 'noema-pi-router)

(defcustom noema-pi-router-minimum-pi-acp "0.8.0"
  "Oldest pi-acp version validated with Noema's ACP, MCP and permission flow."
  :type 'string
  :group 'noema-pi-router)

(defcustom noema-pi-router-minimum-node "22.19.0"
  "Oldest Node.js version pi-acp supports."
  :type 'string
  :group 'noema-pi-router)

(defconst noema-pi-router--api-key-variables
  '("ANTHROPIC_API_KEY" "OPENAI_API_KEY" "DEEPSEEK_API_KEY"
    "GEMINI_API_KEY" "XAI_API_KEY" "OPENROUTER_API_KEY")
  "Provider keys pi-acp reads from its environment.")

(defvar noema-pi-router--buffers (make-hash-table :test #'equal)
  "Project root to live Pi agent-shell buffer, for this Emacs session.")

(defvar noema-pi-router--starting (make-hash-table :test #'equal)
  "Global or project Pi scopes whose client is being started.")

(defvar-local noema-pi-router--claim-timer nil
  "Debounce timer for claiming coordinator requests after Pi tool calls.")
(defvar-local noema-pi-router--claim-request nil)
(defvar-local noema-pi-router--claim-dirty nil)
(defvar-local noema-pi-router--subscriptions nil)
(defvar-local noema-pi-router--attached-state nil)

(defvar noema-pi-router-model-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-m") #'noema-pi-select-model)
    (define-key map (kbd "C-c M-m") #'noema-pi-cycle-model)
    map)
  "Keys for switching models in the Noema Pi session.")

(define-minor-mode noema-pi-router-model-mode
  "Provide a small model picker and keyboard cycling in Noema Pi buffers."
  :lighter nil
  :keymap noema-pi-router-model-mode-map)

(defun noema-pi-router--pool ()
  "Return the validated, ordered Pi model pool."
  (unless (and noema-pi-model-pool
               (cl-every (lambda (model)
                           (and (stringp model)
                                (string-match-p "\\`[^/[:space:]]+/[^/[:space:]]+\\'" model)))
                         noema-pi-model-pool)
               (= (length noema-pi-model-pool)
                  (length (delete-dups (copy-sequence noema-pi-model-pool)))))
    (user-error "Pi model pool needs unique provider/model-id entries"))
  noema-pi-model-pool)

(defun noema-pi-router--available-pool ()
  "Return Pi pool entries the current ACP session advertises."
  (seq-filter (lambda (model)
                (member model (+agent-acp-available-model-ids)))
              (noema-pi-router--pool)))

;;;###autoload
(defun noema-pi-select-model ()
  "Quickly choose an available model from the Noema Pi pool."
  (interactive)
  (unless (and (bound-and-true-p noema-pi-router-model-mode)
               (equal +agent-acp-session-agent "pi"))
    (user-error "Select a Noema Pi session first"))
  (let ((available (noema-pi-router--available-pool)))
    (unless available
      (user-error "No Pi pool models are available; check Pi provider logins"))
    (+agent-acp-set-model
     (completing-read "Pi model: " available nil t nil nil
                      (and (member (+agent-acp-current-model-id) available)
                           (+agent-acp-current-model-id))))))

;;;###autoload
(defun noema-pi-cycle-model ()
  "Select the next available model in the Noema Pi pool."
  (interactive)
  (unless (and (bound-and-true-p noema-pi-router-model-mode)
               (equal +agent-acp-session-agent "pi"))
    (user-error "Select a Noema Pi session first"))
  (let* ((available (noema-pi-router--available-pool))
         (position (cl-position (+agent-acp-current-model-id) available :test #'equal)))
    (unless available
      (user-error "No Pi pool models are available; check Pi provider logins"))
    (+agent-acp-set-model
     (nth (mod (1+ (or position -1)) (length available)) available))))

(defun noema-pi-router--root (directory)
  "Query DIRECTORY's existing Research or shared Agent project root."
  (or (and (fboundp 'noema-project-root) (noema-project-root directory))
      (let ((default-directory (file-name-as-directory (expand-file-name directory))))
        (+agent-acp-project-root))))

;;;###autoload
(defun noema-pi-project-root (&optional directory)
  "Return the project scope whose Pi serves DIRECTORY, without creating one."
  (noema-pi-router--root (or directory default-directory)))

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
  (unless (fboundp '+noema-api-call)
    (user-error "Noema host integration is unavailable"))
  (+noema-api-call channel (vector body) callback 30))

(defun noema-pi-router--warn (format-string &rest args)
  "Log a Pi manager problem built from FORMAT-STRING and ARGS to `*Warnings*'."
  (display-warning 'noema-pi-router (apply #'format format-string args) :warning))

(defun noema-pi-router--legacy-registry-file (root)
  "Return ROOT's D-028 Pi registry path."
  (expand-file-name "pi.json" (expand-file-name ".agent" root)))

(defun noema-pi-router--legacy-native-session-id (root)
  "Return the native Pi session id remembered by D-028 for ROOT, or nil."
  (let ((path (noema-pi-router--legacy-registry-file root)))
    (and (file-readable-p path)
         (ignore-errors
           (with-temp-buffer
             (insert-file-contents path)
             (noema-pi-router--string (noema-pi-router--parse-json (buffer-string))
                                      "nativeSessionId"))))))

;;;; Deployment

(defun noema-pi-router--read-file (file)
  "Return FILE's contents, or nil when it cannot be read."
  (and (file-readable-p file)
       (with-temp-buffer
         (insert-file-contents file)
         (buffer-string))))

(defun noema-pi-router--write-file (file content)
  "Write CONTENT to FILE unless FILE already holds exactly CONTENT."
  (unless (equal (noema-pi-router--read-file file) content)
    (make-directory (file-name-directory file) t)
    (let ((coding-system-for-write 'utf-8-unix))
      (write-region content nil file nil 'silent))))

(defun noema-pi-router--json (object)
  "Serialize hash-table OBJECT as a JSON character string."
  (let ((json (json-serialize object :null-object :null :false-object :false)))
    (concat (if (multibyte-string-p json) json (decode-coding-string json 'utf-8)) "\n")))

(defun noema-pi-router--runtime-command ()
  "Return the exact Emacs-owned ACP command; never fall back to system Pi."
  (list (or (executable-find "node") "node")
        (expand-file-name "node_modules/@automatalabs/pi-acp/dist/index.js" noema-pi-runtime-directory)))

(defun noema-pi-router--link-file (source link)
  "Link owned runtime LINK to SOURCE, retaining any old regular file."
  (unless (and (file-symlink-p link) (equal (file-truename link) (file-truename source)))
    (make-directory (file-name-directory link) t)
    (cond ((file-symlink-p link) (delete-file link))
          ((file-exists-p link)
           (let ((archive (expand-file-name "legacy/" noema-pi-agent-directory)))
             (make-directory archive t)
             (rename-file link (make-temp-name (expand-file-name (concat (file-name-nondirectory link) "-") archive))))))
    (make-symbolic-link (expand-file-name source) link)))

(defun noema-pi-router--private-file (directory name)
  "Migrate NAME once into private etc, then link DIRECTORY's native entry."
  (let ((file (expand-file-name name noema-pi-config-directory))
        (old (expand-file-name name directory)))
    (make-directory noema-pi-config-directory t)
    (unless (= (file-modes noema-pi-config-directory) #o700)
      (set-file-modes noema-pi-config-directory #o700))
    (unless (file-exists-p file)
      (cond ((file-exists-p old)
             (if (file-symlink-p old) (copy-file old file)
               (rename-file old file)))
            ((and (equal name "auth.json") noema-pi-credentials-file
                  (file-readable-p (expand-file-name noema-pi-credentials-file)))
             (copy-file (expand-file-name noema-pi-credentials-file) file))
            (t (noema-pi-router--write-file file "{}\n"))))
    (unless (= (file-modes file) #o600) (set-file-modes file #o600))
    (noema-pi-router--link-file file old)
    file))

(defun noema-pi-router--settings (file)
  "Return FILE's Pi settings with Noema's manager keys applied.
Keys Noema does not own are kept, so choices made inside Pi survive."
  (let ((settings (or (ignore-errors
                        (let ((parsed (noema-pi-router--parse-json (noema-pi-router--read-file file))))
                          (and (hash-table-p parsed) parsed)))
                      (make-hash-table :test #'equal)))
        (model (string-trim (or noema-pi-model "")))
        (pool (noema-pi-router--pool)))
    (puthash "defaultTools" [] settings)
    (puthash "enableSkillCommands" :false settings)
    (puthash "defaultThinkingLevel" noema-pi-thinking-level settings)
    (puthash "enabledModels" (vconcat pool) settings)
    (when (and (string-empty-p model)
               (not (noema-pi-router--string settings "defaultModel")))
      (setq model (car pool)))
    (unless (string-empty-p model)
      (if-let* ((slash (string-search "/" model)))
          (progn
            (puthash "defaultProvider" (substring model 0 slash) settings)
            (puthash "defaultModel" (substring model (1+ slash)) settings))
        (puthash "defaultModel" model settings)))
    settings))

(defun noema-pi-router--codex-login-p ()
  "Return non-nil when the configured Codex CLI has an access token."
  (when-let* ((content (noema-pi-router--read-file
                        (expand-file-name noema-pi-codex-auth-file)))
              (auth (ignore-errors (noema-pi-router--parse-json content)))
              (tokens (noema-pi-router--value auth "tokens")))
    (and (equal (noema-pi-router--string auth "auth_mode") "chatgpt")
         (noema-pi-router--string tokens "access_token"))))

(defun noema-pi-router--codex-token-command ()
  "Return Pi's command reference to the local Codex access token."
  (when-let* ((node (executable-find "node"))
              (library (locate-library "noema-pi-router"))
              (script (expand-file-name "../scripts/noema-codex-token.mjs"
                                        (file-name-directory library)))
              (_ (file-readable-p script)))
    (concat "!" (shell-quote-argument node) " "
            (shell-quote-argument script) " "
            (shell-quote-argument (expand-file-name noema-pi-codex-auth-file)))))

(defun noema-pi-router--private-credentials (directory)
  "Remove an earlier token-command entry from the owned private auth store.
Provider entries and an explicit import source are preserved. The Codex
access token is read by reference and never stored in Pi's auth file."
  (when-let* ((_ (noema-pi-router--codex-login-p))
              (command (noema-pi-router--codex-token-command)))
    (let* ((target (file-truename (expand-file-name "auth.json" directory)))
           (auth (or (ignore-errors
                       (let ((parsed (noema-pi-router--parse-json
                                      (noema-pi-router--read-file target))))
                         (and (hash-table-p parsed) parsed)))
                     (make-hash-table :test #'equal)))
           (entry (gethash "openai-codex" auth))
           (old-bridge (and (equal (noema-pi-router--string entry "type") "api_key")
                            (equal (noema-pi-router--string entry "key") command))))
      (when old-bridge
        (when old-bridge
          (remhash "openai-codex" auth))
        (let ((temporary (make-temp-file (expand-file-name ".auth-" (file-name-directory target)))))
          (unwind-protect
              (progn
                (set-file-modes temporary #o600)
                (let ((coding-system-for-write 'utf-8-unix))
                  (write-region (noema-pi-router--json auth) nil temporary nil 'silent))
                (rename-file temporary target t))
            (when (file-exists-p temporary)
              (delete-file temporary))))))))

(defun noema-pi-router--configure-codex-model-auth (directory)
  "Configure DIRECTORY's built-in Codex models to read the CLI login.
Pi's built-in `openai-codex' provider is OAuth-only.  Its `models.json'
`apiKey' override enables the supported command credential path without
copying the token into Pi configuration."
  (when-let* ((_ (noema-pi-router--codex-login-p))
              (command (noema-pi-router--codex-token-command)))
    (let* ((file (expand-file-name "models.json" directory))
           (models (or (ignore-errors
                         (let ((parsed (noema-pi-router--parse-json
                                        (noema-pi-router--read-file file))))
                           (and (hash-table-p parsed) parsed)))
                       (make-hash-table :test #'equal)))
           (providers (or (gethash "providers" models)
                          (make-hash-table :test #'equal)))
           (codex (or (gethash "openai-codex" providers)
                      (make-hash-table :test #'equal))))
      (puthash "apiKey" command codex)
      (puthash "openai-codex" codex providers)
      (puthash "providers" providers models)
      (noema-pi-router--write-file file (noema-pi-router--json models)))))

;;;###autoload
(defun noema-pi-deploy ()
  "Write Noema's Pi manager setup into `noema-pi-agent-directory'.
Return the environment Pi runs with.  It is idempotent: unchanged files are
not rewritten and settings Noema does not own are kept."
  (interactive)
  (let* ((directory (file-name-as-directory (expand-file-name noema-pi-agent-directory)))
         (settings (noema-pi-router--private-file directory "settings.json"))
         (source (file-name-directory (directory-file-name noema-pi-router--resource-directory)))
         (builtin-prompt (expand-file-name "SYSTEM.md" noema-pi-router--resource-directory)))
    (make-directory directory t)
    (make-directory noema-pi-companion-directory t)
    (noema-pi-router--private-file directory "auth.json")
    (noema-pi-router--private-file directory "models.json")
    (noema-pi-router--write-file settings (noema-pi-router--json (noema-pi-router--settings settings)))
    (if (null noema-pi-system-prompt)
        (noema-pi-router--link-file builtin-prompt (expand-file-name "SYSTEM.md" directory))
      (let ((private (expand-file-name "SYSTEM.md" noema-pi-config-directory)))
        (noema-pi-router--write-file private (concat (string-trim noema-pi-system-prompt) "\n"))
        (noema-pi-router--link-file private (expand-file-name "SYSTEM.md" directory))))
    (noema-pi-router--link-file
     (expand-file-name "extensions/noema-manager/index.ts" noema-pi-router--resource-directory)
     (expand-file-name "extensions/noema-manager/index.ts" directory))
    (noema-pi-router--private-credentials directory)
    (noema-pi-router--configure-codex-model-auth directory)
    (when (called-interactively-p 'interactive)
      (message "Noema Pi manager deployed in %s" (abbreviate-file-name directory)))
    (list (concat "PI_CODING_AGENT_DIR=" (directory-file-name directory))
          (concat "NOEMA_PI_SOURCE=" (file-name-directory (directory-file-name source)))
          "PI_SKIP_VERSION_CHECK=1")))

;;;; Physical runtime attachment

;;;###autoload
(defun noema-pi-router-buffer (&optional directory)
  "Return the live Pi buffer of DIRECTORY's project, or nil.
Never starts one; use `noema-pi-router-open' for that."
  (let* ((root (noema-pi-router--root (or directory default-directory)))
         (buffer (gethash root noema-pi-router--buffers)))
    (and (buffer-live-p buffer) buffer)))

(defun noema-pi-router--mcp-servers (&optional endpoint)
  "Return the two-tool API facade and optional retained Research coordinator."
  (append
   (list `((name . "noema-api")
           (command . ,(or (executable-find "node") "node"))
           (args . [,(expand-file-name "../scripts/agent-mcp.mjs"
                                      (file-name-directory (locate-library "noema-pi-router")))])
           ;; The facade marks what Pi tells an Agent; the model cannot leave it out.
           (env . [((name . "NOEMA_CALLER") (value . "pi"))])))
   (when-let* ((coordinator (noema-pi-router--string endpoint "coordinatorUrl")))
     (list `((name . "noema-coordinator") (type . "http") (url . ,coordinator) (headers . ()))))))

;;;###autoload
(defun noema-pi-router-claim (&optional directory on-complete)
  "Carry out pending Pi manager requests of DIRECTORY's project."
  (interactive)
  (require 'noema-agent-worker)
  (noema-agent-worker-claim-coordinator-requests
   (noema-pi-router--root (or directory default-directory)) on-complete))

(defun noema-pi-router--claim (root buffer native client)
  "Claim once, merging tool events that arrive during the host request."
  (let ((token (make-symbol "pi-claim")))
    (with-current-buffer buffer (setq noema-pi-router--claim-request token))
    (condition-case err
        (noema-pi-router-claim
         root
         (lambda ()
           (when (and (buffer-live-p buffer)
                      (eq token (buffer-local-value 'noema-pi-router--claim-request buffer)))
             (with-current-buffer buffer
               (setq noema-pi-router--claim-request nil)
               (let ((dirty noema-pi-router--claim-dirty))
                 (setq noema-pi-router--claim-dirty nil)
                 (when (and dirty (noema-pi-router--current-p root buffer native client))
                   (noema-pi-router--schedule-claim root buffer)))))))
      (error
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (when (eq token noema-pi-router--claim-request)
             (setq noema-pi-router--claim-request nil noema-pi-router--claim-dirty nil))))
       (signal (car err) (cdr err))))))

(defun noema-pi-router--schedule-claim (root buffer)
  "Merge tool activity into one bounded-delay claim, without per-chunk IO."
  (when (and (buffer-live-p buffer) (bound-and-true-p +noema--ready))
    (with-current-buffer buffer
      (if noema-pi-router--claim-request (setq noema-pi-router--claim-dirty t)
        (unless (timerp noema-pi-router--claim-timer)
          (let ((native (+agent-acp-state-value buffer '(:session :id)))
		(client (+agent-acp-state-value buffer '(:client))) timer)
            (setq timer
                  (run-at-time
                   0.5 nil
                   (lambda ()
                     (when (and (buffer-live-p buffer)
				(eq timer (buffer-local-value 'noema-pi-router--claim-timer buffer)))
                       (with-current-buffer buffer
			 (setq noema-pi-router--claim-timer nil)
			 (when (and (bound-and-true-p +noema--ready)
                                    (noema-pi-router--current-p root buffer native client)
                                    (fboundp 'noema-project-root) (noema-project-root root))
                           (noema-pi-router--claim root buffer native client)))))))
            (setq noema-pi-router--claim-timer timer)))))))

(defvar-local noema-pi-router--scope nil "Pi scope attached to this physical buffer.")
(put 'noema-pi-router--scope 'permanent-local t)

(defun noema-pi-router--release (buffer)
  "Release BUFFER's physical-client work while retaining its Pi role."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (timerp noema-pi-router--claim-timer) (cancel-timer noema-pi-router--claim-timer))
      (when (timerp noema-pi-router--history-timer) (cancel-timer noema-pi-router--history-timer))
      (setq noema-pi-router--claim-timer nil
            noema-pi-router--claim-request nil noema-pi-router--claim-dirty nil
            noema-pi-router--history-timer nil noema-pi-router--history-generation nil
            noema-pi-router--history-request nil noema-pi-router--history-dirty nil
            noema-pi-router--history-observed nil noema-pi-router--attached-state nil)
      (let ((subscriptions noema-pi-router--subscriptions))
        (setq noema-pi-router--subscriptions nil)
        (dolist (token subscriptions) (+agent-acp-unsubscribe :buffer buffer :subscription token))))))

(defun noema-pi-router--client-ended (buffer)
  (when (and (buffer-live-p buffer) (buffer-local-value 'noema-pi-router--scope buffer))
    (noema-pi-router--release buffer)))
(add-hook '+agent-acp-client-ended-functions #'noema-pi-router--client-ended)

(defun noema-pi-router--killed-h ()
  (let ((buffer (current-buffer)) (scope noema-pi-router--scope))
    (noema-pi-router--release buffer)
    (if (equal scope "emacs")
        (when (eq noema-pi-router--emacs-buffer buffer) (setq noema-pi-router--emacs-buffer nil))
      (when (eq (gethash scope noema-pi-router--buffers) buffer) (remhash scope noema-pi-router--buffers)))))

(defun noema-pi-router--attach (scope buffer)
  "Attach one physical BUFFER to SCOPE, including after native restart."
  (if (equal scope "emacs")
      (progn
        (setq noema-pi-router--emacs-buffer buffer)
        (maphash (lambda (_ child)
                   (when (buffer-live-p child)
                     (with-current-buffer child (setq-local noema-pi-parent buffer))))
                 noema-pi-router--buffers))
    (puthash scope buffer noema-pi-router--buffers))
  (with-current-buffer buffer
    (setq-local +agent-acp-strict-restore t)
    (noema-pi-router--apply-permissions buffer)
    (unless (and (equal noema-pi-router--scope scope) noema-pi-router--subscriptions
                 (eq noema-pi-router--attached-state (+agent-acp-state-value buffer nil)))
      (noema-pi-router--release buffer)
      (setq-local noema-pi-router--scope scope
                  noema-pi-router--attached-state (+agent-acp-state-value buffer nil)
                  noema-pi-parent (unless (equal scope "emacs") noema-pi-router--emacs-buffer))
      (noema-pi-router-model-mode 1)
      (add-hook 'kill-buffer-hook #'noema-pi-router--killed-h nil t)
      (add-hook 'change-major-mode-hook #'noema-pi-router--killed-h nil t)
      (push (+agent-acp-subscribe :buffer buffer :event 'clean-up
                                  :callback (lambda (_) (noema-pi-router--release buffer)))
            noema-pi-router--subscriptions)
      (if (+agent-acp-state-value buffer '(:session :id))
          (noema-pi-router--remember scope buffer)
        (push (+agent-acp-subscribe :buffer buffer :event 'init-finished
                                    :callback (lambda (_) (noema-pi-router--remember scope buffer)))
              noema-pi-router--subscriptions))
      (unless (equal scope "emacs")
        (push (+agent-acp-subscribe
               :buffer buffer :event 'tool-call-update
               :callback (lambda (event)
                           (when (member (map-nested-elt event '(:data :tool-call :status)) '("completed" "failed"))
                             (noema-pi-router--schedule-claim scope buffer))))
              noema-pi-router--subscriptions))))
  buffer)

(defun noema-pi-router--adopt-runtime (buffer _name root)
  "Reattach a restarted Pi buffer without creating a Research association."
  (pcase (buffer-local-value '+agent-acp-session-origin buffer)
    ('pi-emacs (noema-pi-router--attach "emacs" buffer))
    ((or 'pi 'pi-project) (noema-pi-router--attach root buffer))))
(add-hook '+agent-session-adopt-functions #'noema-pi-router--adopt-runtime)

(defun noema-pi-router--session-action (operation buffer &rest _arguments)
  "Own Pi's management entry through the existing domain action boundary."
  (cond
   ((eq (+agent-session-kind buffer) 'pi)
    (pcase operation
      ('manage (with-current-buffer buffer (call-interactively #'noema-pi-sessions)) t)
      ('new (noema-pi-sessions-new (noema-pi-sessions--buffer-scope buffer)) t)))
   ((and (eq operation 'new) (with-current-buffer buffer (derived-mode-p 'noema-pi-sessions-mode)))
    (with-current-buffer buffer (noema-pi-sessions-new-at-point)) t)))
(add-hook '+agent-session-action-functions #'noema-pi-router--session-action)

(defun noema-pi-router--start-scope (scope directory native focus &optional endpoint)
  "Start or resume exactly one Pi conversation through the shared runtime."
  (when (gethash scope noema-pi-router--starting)
    (user-error "Pi is already starting for %s" scope))
  (puthash scope t noema-pi-router--starting)
  (unwind-protect
      (let ((config (or (+agent-acp-pi-config (cons (concat "NOEMA_PI_SCOPE=" scope) (noema-pi-deploy))
                                             (noema-pi-router--runtime-command))
                        (user-error "Pi is unavailable; run M-x noema-pi-doctor")))
            buffer attached)
        (setq config (+agent-acp-pinned-config config nil (lambda () noema-pi-thinking-level)))
        (setf (alist-get :mcp-servers config) (noema-pi-router--mcp-servers endpoint))
        (unwind-protect
            (progn
              (setq buffer (+agent-acp-start :config config :directory directory :session-id native :strict-restore t
                                            :focus focus :origin (if (equal scope "emacs") 'pi-emacs 'pi-project)))
              (+agent-acp-mark-session-buffer buffer
                                             (if (equal scope "emacs") "pi/emacs" noema-pi-router-session-name)
                                             "pi" directory)
              (prog1 (noema-pi-router--attach scope buffer) (setq attached t)))
          (when (and (not attached) (buffer-live-p buffer))
            ;; A mode hook can fail before the normal kill hooks are installed.
            (unwind-protect
                (with-current-buffer buffer (noema-pi-router--killed-h))
              (+agent-acp-kill buffer)))))
    (remhash scope noema-pi-router--starting)))

(defun noema-pi-router--launch (root focus)
  "Start ROOT's child Pi without requiring a Research Project or a live host."
  (or (noema-pi-router-buffer root)
      (noema-pi-router--start-scope root root (noema-pi-router--remembered root) focus)))

;;;###autoload
(defun noema-pi-router-open (&optional directory)
  "Show the Pi manager of DIRECTORY's project (default: here), starting it.
A live Pi buffer is reused.  Otherwise Pi resumes the conversation recorded
in Pi's own active pointer, or starts a fresh one."
  (interactive)
  (remote-require-on-client 'tools/agent/context)
  (let ((directory (or directory (alist-get 'directory (+agent-context-state)))))
    (unless directory (user-error "No editor source; select a project before opening its Pi"))
    (noema-pi-router--show-or-resume (noema-pi-project-ensure directory))))

;;;; Lifecycle

(defun noema-pi-close-project (&optional directory _interrupt)
  "End only DIRECTORY's project Pi, retaining its native session record."
  (interactive (list default-directory))
  (when-let* ((buffer (noema-pi-router-buffer (or directory default-directory))))
    (+agent-acp-close buffer)))

(defun noema-pi-router--shutdown-all ()
  "Close every Pi session when Emacs exits, so pi-acp can clean up."
  (noema-pi-router--cancel-startup)
  ;; Teardown may synchronously remove/rebind entries in the owned table.
  (dolist (buffer (delete-dups (cons noema-pi-router--emacs-buffer
                                    (hash-table-values noema-pi-router--buffers))))
    (when (buffer-live-p buffer)
      (noema-pi-router--release buffer)
      (ignore-errors (+agent-acp-shutdown buffer)))))

(add-hook 'kill-emacs-hook #'noema-pi-router--shutdown-all)

;;;; Doctor

(defun noema-pi-router--program-version (program &rest args)
  "Return the first line PROGRAM ARGS prints, or nil."
  (ignore-errors (car (apply #'process-lines program args))))

(defun noema-pi-router--version-at-least-p (minimum version)
  "Return non-nil when VERSION is at least MINIMUM."
  (and (stringp version)
       (string-match "[0-9]+\\(?:\\.[0-9]+\\)*" version)
       (ignore-errors (version<= minimum (match-string 0 version)))))

(defun noema-pi-router--credentials ()
  "Describe the credentials the Pi manager can use, or return nil.
An `auth.json' that holds no provider entry does not count."
  (or (when-let* ((_ (noema-pi-router--codex-login-p))
                  (command (noema-pi-router--codex-token-command))
                  (content (noema-pi-router--read-file
                            (expand-file-name "models.json" noema-pi-agent-directory)))
                  (models (ignore-errors (noema-pi-router--parse-json content)))
                  (providers (noema-pi-router--value models "providers"))
                  (codex (noema-pi-router--value providers "openai-codex"))
                  ((equal (noema-pi-router--string codex "apiKey") command)))
        "Codex CLI login")
      (seq-find (lambda (name)
                  (let ((value (getenv name)))
                    (and value (not (string-empty-p value)))))
                noema-pi-router--api-key-variables)
      (seq-some (lambda (file)
                  (let ((parsed (ignore-errors
                                  (noema-pi-router--parse-json (noema-pi-router--read-file file)))))
                    (and (hash-table-p parsed)
                         (> (hash-table-count parsed) 0)
                         (abbreviate-file-name file))))
                (list (expand-file-name "auth.json" noema-pi-agent-directory)
                      (and noema-pi-credentials-file (expand-file-name noema-pi-credentials-file))))))

(defun noema-pi-router--login-command ()
  "Return a shell command that runs the Pi CLI bundled with pi-acp, or nil."
  (when-let* ((cli (expand-file-name
                    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
                    noema-pi-runtime-directory))
              ((file-readable-p cli)))
    (format "PI_CODING_AGENT_DIR=%s node %s"
            (shell-quote-argument (directory-file-name (expand-file-name noema-pi-agent-directory)))
            (shell-quote-argument cli))))

(defun noema-pi-router-checks ()
  "Return Pi deployment checks as (OK LABEL DETAIL) lists."
  (let* ((command (noema-pi-router--runtime-command))
         (acp (and (file-readable-p (cadr command)) (cadr command)))
         (acp-version (and acp (apply #'noema-pi-router--program-version (append command '("--version")))))
         (node (executable-find "node"))
         (node-version (and node (noema-pi-router--program-version node "--version")))
         (credentials (noema-pi-router--credentials))
         (extension (expand-file-name "extensions/noema-manager/index.ts" noema-pi-agent-directory))
         (config (+agent-acp-config-for "pi")))
    (list
     (list (and acp t) "Emacs-owned pi-acp"
           (or acp "missing: run make pi-setup in the Emacs configuration"))
     (list (noema-pi-router--version-at-least-p noema-pi-router-minimum-pi-acp acp-version)
           (format "pi-acp >= %s" noema-pi-router-minimum-pi-acp)
           (or acp-version "unknown"))
     (list (noema-pi-router--version-at-least-p noema-pi-router-minimum-node node-version)
           (format "node >= %s" noema-pi-router-minimum-node)
           (or node-version "missing"))
     (list (and credentials t) "Pi credentials"
           (or credentials
               (format "none: run `%s', then /login (or set a provider API key)"
                       (or (noema-pi-router--login-command) "pi"))))
     (list (and config t) "agent-shell Pi configuration"
           (if config "agent-shell-pi" "agent-shell-pi is unavailable"))
     (list t "manager deployment"
           (if (file-readable-p extension)
               (abbreviate-file-name noema-pi-agent-directory)
             "written when Pi first starts (M-x noema-pi-deploy)"))
     (list t "manager model"
           (if (string-empty-p (string-trim (or noema-pi-model "")))
               (format "pool default: %s" (car (noema-pi-router--pool)))
             noema-pi-model))
     (list t "model pool" (string-join (noema-pi-router--pool) ", "))
     (list (bound-and-true-p +noema--ready) "Noema host"
           (if (bound-and-true-p +noema--ready) "ready" "not started (it starts on first use)")))))

;;;###autoload
(defun noema-pi-doctor ()
  "Report whether Pi is deployed well enough to manage this project."
  (interactive)
  (let ((checks (noema-pi-router-checks))
        (buffer (get-buffer-create "*Noema Pi doctor*"))
        (root (noema-pi-router--root default-directory)))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "Noema Pi manager — %s\n\n" (abbreviate-file-name root)))
        (dolist (check checks)
          (insert (format "%s %-32s %s\n" (if (car check) "✓" "✗") (nth 1 check) (nth 2 check)))))
      (special-mode))
    (display-buffer buffer)
    (when (and (fboundp '+noema-api-call) (bound-and-true-p +noema--ready))
      (noema-pi-router--api
       "noema:api:research:coordinator:endpoint" `((cwd . ,root))
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
