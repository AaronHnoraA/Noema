;;; noema-pi-router.el --- Per-project Pi session manager -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; D-032, D-035.  Every Noema project (the nearest `noema.toml', otherwise the
;; directory of the `.noema' file) has one Pi.  Pi is not a worker like Codex,
;; Claude or OpenCode: it is the project's session manager and never does
;; project work.
;;
;; - Role.  Noema deploys its own Pi agent directory
;;   (`noema-pi-agent-directory', passed as `PI_CODING_AGENT_DIR'):
;;   `settings.json' turns off Pi's built-in tools and thinking and selects
;;   `noema-pi-model'; `SYSTEM.md' replaces Pi's coding prompt with a few
;;   manager lines; a generated extension keeps only the coordinator MCP tools
;;   active, blocks every other tool and drops project context files from the
;;   prompt.  The person's own Pi setup is untouched; credentials are shared
;;   through a link to `noema-pi-credentials-file'.
;; - Authority.  Pi's only tools are `/mcp/coordinator'.  They run as actor
;;   `pi' and cannot touch names the person pinned.  Anything that touches a
;;   live agent (`run.start', `session.cancel', `session.close') is a durable
;;   request that Emacs claims when Pi starts and after each Pi tool call.  Pi
;;   has no approval power (D-008).
;; - Lifecycle.  Visiting a `.noema' file starts its project's Pi hidden.  When
;;   the project's last `.noema' buffer has been gone for
;;   `noema-pi-stop-delay' seconds, or `noema-pi-close-project' runs, Pi and
;;   the project's idle agent processes stop; an agent still running a Run
;;   stops once the Run ends.  Session names and native ids stay, so the next
;;   visit resumes them.

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
(declare-function noema-agent-worker-buffer-busy-p "noema-agent-worker" (buffer))
(declare-function noema-agent-worker-stop-buffer "noema-agent-worker" (buffer))
(declare-function noema-agent-worker-cancel-buffer "noema-agent-worker" (buffer))
(declare-function noema-agent-worker-buffer "noema-agent-worker" (worker))
(defvar my/noema--ready)

(defgroup noema-pi-router nil
  "Per-project Pi session manager for Noema."
  :group 'applications)

(defconst noema-pi-router-session-name "pi"
  "Reserved D-031 session name of the project's Pi manager.")

(defcustom noema-pi-auto-start t
  "Whether visiting a `.noema' file starts its project's Pi in the background.
Only projects with `.noema' documents get a Pi; one Pi serves every document
of a project."
  :type 'boolean
  :group 'noema-pi-router)

(defcustom noema-pi-stop-delay 30
  "Seconds after a project's last `.noema' buffer closes before its Pi stops.
The project's idle agent processes stop with it."
  :type 'number
  :group 'noema-pi-router)

(defcustom noema-pi-agent-directory (locate-user-emacs-file "var/noema/pi/")
  "Pi agent directory Noema deploys and passes to Pi as `PI_CODING_AGENT_DIR'.
Noema owns its manager keys in `settings.json', `SYSTEM.md' and the
`extensions/noema-manager' extension; other settings are kept."
  :type 'directory
  :group 'noema-pi-router)

(defcustom noema-pi-credentials-file "~/.pi/agent/auth.json"
  "Pi credential store linked into `noema-pi-agent-directory'.
Logging in once with Pi is then enough for the Noema manager too."
  :type 'file
  :group 'noema-pi-router)

(defcustom noema-pi-model ""
  "Model the Pi manager uses, as \"provider/model-id\".
Session management needs little reasoning, so a small, cheap model is right.
Empty keeps Pi's own default."
  :type 'string
  :group 'noema-pi-router)

(defcustom noema-pi-thinking-level "off"
  "Thinking level of the Pi manager."
  :type '(choice (const "off") (const "minimal") (const "low") (const "medium") (const "high"))
  :group 'noema-pi-router)

(defcustom noema-pi-system-prompt
  "You are Pi, the Noema session manager of one project. You never do project
work: no reading, editing or running code and no research answers. Carry out
the person's request about agent sessions with the Noema tools, then reply in
at most two short sentences. When a request needs anything else, name the
Emacs command that does it."
  "System prompt that replaces Pi's default coding prompt in `SYSTEM.md'."
  :type 'string
  :group 'noema-pi-router)

(defcustom noema-pi-router-minimum-pi-acp "0.8.0"
  "Oldest pi-acp version validated with Noema's ACP, MCP and permission flow."
  :type 'string
  :group 'noema-pi-router)

(defcustom noema-pi-router-minimum-node "22.19.0"
  "Oldest Node.js version pi-acp supports."
  :type 'string
  :group 'noema-pi-router)

(defconst noema-pi-router--api-key-variables
  '("ANTHROPIC_API_KEY" "OPENAI_API_KEY" "GEMINI_API_KEY" "XAI_API_KEY" "OPENROUTER_API_KEY")
  "Provider keys pi-acp reads from its environment.")

(defconst noema-pi-router--extension
  "// Generated by Noema (noema-pi-router.el).  Do not edit: redeployed on start.
// The Noema Pi only manages agent sessions through the coordinator tools.
const ALLOWED = /^mcp__noema-coordinator__/;

export default function (pi: any) {
  const restrict = () => {
    const wanted = pi.getAllTools().map((tool: any) => tool.name)
      .filter((name: string) => ALLOWED.test(name));
    const active = pi.getActiveTools();
    if (wanted.length !== active.length || wanted.some((name: string) => !active.includes(name))) {
      pi.setActiveTools(wanted);
    }
  };
  pi.on(\"session_start\", restrict);
  pi.on(\"before_agent_start\", (event: any) => {
    restrict();
    let prompt = event.systemPrompt;
    for (const file of event.systemPromptOptions?.contextFiles ?? []) {
      if (typeof file?.content === \"string\" && file.content) prompt = prompt.split(file.content).join(\"\");
    }
    return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
  });
  pi.on(\"tool_call\", (event: any) =>
    ALLOWED.test(event.toolName) ? undefined : { block: true, reason: \"The Noema Pi only manages sessions.\" });
}
"
  "Extension that confines the Noema Pi to coordinator tools.")

(defvar noema-pi-router--buffers (make-hash-table :test #'equal)
  "Project root to live Pi agent-shell buffer, for this Emacs session.")

(defvar noema-pi-router--starting (make-hash-table :test #'equal)
  "Project roots whose Pi is being started.")

(defvar noema-pi-router--show (make-hash-table :test #'equal)
  "Project roots whose Pi should be displayed once it has started.")

(defvar noema-pi-router--stop-timers (make-hash-table :test #'equal)
  "Project root to the pending timer that stops its Pi and idle agents.")

(defvar noema-pi-router--closing (make-hash-table :test #'equal)
  "Project roots that were closed; their agents stop when their Runs end.")

(defvar-local noema-pi-router--claim-timer nil
  "Debounce timer for claiming coordinator requests after Pi tool calls.")

(defun noema-pi-router--root (directory)
  "Return the normalized project root that owns Pi for DIRECTORY.
Like `noema-research-repository-root', the nearest `noema.toml' wins;
otherwise DIRECTORY itself is the root."
  (or (noema-project-root directory)
      (file-name-as-directory (expand-file-name directory))))

;;;###autoload
(defun noema-pi-project-root (&optional directory)
  "Return the Noema project root whose Pi serves DIRECTORY."
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
  (unless (fboundp 'my/noema-api-call)
    (user-error "Noema host integration is unavailable"))
  (my/noema-api-call channel (vector body) callback 30))

(defun noema-pi-router--warn (format-string &rest args)
  "Log a Pi manager problem built from FORMAT-STRING and ARGS to `*Warnings*'."
  (display-warning 'noema-pi-router (apply #'format format-string args) :warning))

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

(defun noema-pi-router--settings (file)
  "Return FILE's Pi settings with Noema's manager keys applied.
Keys Noema does not own are kept, so choices made inside Pi survive."
  (let ((settings (or (ignore-errors
                        (let ((parsed (noema-research-parse-json (noema-pi-router--read-file file))))
                          (and (hash-table-p parsed) parsed)))
                      (make-hash-table :test #'equal)))
        (model (string-trim (or noema-pi-model ""))))
    (puthash "defaultTools" [] settings)
    (puthash "enableSkillCommands" :false settings)
    (puthash "defaultThinkingLevel" noema-pi-thinking-level settings)
    (unless (string-empty-p model)
      (if-let* ((slash (string-search "/" model)))
          (progn
            (puthash "defaultProvider" (substring model 0 slash) settings)
            (puthash "defaultModel" (substring model (1+ slash)) settings))
        (puthash "defaultModel" model settings)))
    settings))

(defun noema-pi-router--link-credentials (directory)
  "Link `noema-pi-credentials-file' into Pi agent DIRECTORY when it has none."
  (let ((source (expand-file-name noema-pi-credentials-file))
        (target (expand-file-name "auth.json" directory)))
    (when (and (file-exists-p source)
               (not (file-exists-p target))
               (not (file-symlink-p target))
               (not (equal (file-truename (file-name-directory source))
                           (file-truename directory))))
      (make-symbolic-link source target))))

;;;###autoload
(defun noema-pi-deploy ()
  "Write Noema's Pi manager setup into `noema-pi-agent-directory'.
Return the environment Pi runs with.  It is idempotent: unchanged files are
not rewritten and settings Noema does not own are kept."
  (interactive)
  (let* ((directory (file-name-as-directory (expand-file-name noema-pi-agent-directory)))
         (settings (expand-file-name "settings.json" directory)))
    (make-directory directory t)
    (noema-pi-router--write-file settings (noema-pi-router--json (noema-pi-router--settings settings)))
    (noema-pi-router--write-file (expand-file-name "SYSTEM.md" directory)
                                 (concat (string-trim noema-pi-system-prompt) "\n"))
    (noema-pi-router--write-file (expand-file-name "extensions/noema-manager/index.ts" directory)
                                 noema-pi-router--extension)
    (noema-pi-router--link-credentials directory)
    (when (called-interactively-p 'interactive)
      (message "Noema Pi manager deployed in %s" (abbreviate-file-name directory)))
    (list (concat "PI_CODING_AGENT_DIR=" (directory-file-name directory))
          "PI_SKIP_VERSION_CHECK=1")))

;;;; Starting

;;;###autoload
(defun noema-pi-router-buffer (&optional directory)
  "Return the live Pi buffer of DIRECTORY's project, or nil.
Never starts one; use `noema-pi-router-open' for that."
  (let* ((root (noema-pi-router--root (or directory default-directory)))
         (buffer (or (gethash root noema-pi-router--buffers)
                     (noema-agent-acp-session-buffer noema-pi-router-session-name root))))
    (and (buffer-live-p buffer) buffer)))

(defun noema-pi-router--mcp-servers (endpoint)
  "Return the agent-shell MCP servers of the Pi manager from ENDPOINT.
Only the coordinator: the shared Noema tools are for workers, and every tool
description Pi carries costs tokens on every turn."
  (when-let* ((coordinator (noema-pi-router--string endpoint "coordinatorUrl")))
    (list `((name . "noema-coordinator") (type . "http") (url . ,coordinator) (headers . ())))))

(defun noema-pi-router--adopt (root buffer)
  "Record BUFFER's native Pi session as ROOT's `pi' session name."
  (when (and (buffer-live-p buffer) (fboundp 'my/noema-api-call))
    (condition-case error-object
        (noema-pi-router--api
         "aaronnote:api:research:session:promote"
         (noema-agent-promote--session-spec buffer "Pi manager" "Project session management")
         (lambda (result promote-error)
           (if promote-error
               (noema-pi-router--warn "Pi session could not be recorded: %s"
                                      (noema-agent-promote--error-message promote-error))
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
                      (noema-pi-router--warn "Pi session name could not be bound: %s"
                                             (noema-agent-promote--error-message bind-error))
                    (ignore-errors
                      (delete-file (noema-pi-router--legacy-registry-file root))))))))))
      (error
       (noema-pi-router--warn "Pi session could not be recorded: %s"
                              (error-message-string error-object))))))

;;;###autoload
(defun noema-pi-router-claim (&optional directory)
  "Carry out pending Pi manager requests of DIRECTORY's project."
  (interactive)
  (require 'noema-agent-worker)
  (noema-agent-worker-claim-coordinator-requests
   (noema-pi-router--root (or directory default-directory))))

(defun noema-pi-router--schedule-claim (root buffer)
  "Claim ROOT's requests shortly after Pi's tool activity in BUFFER."
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

(defun noema-pi-router--start (root native endpoint focus)
  "Start ROOT's Pi manager, resuming NATIVE when known.
ENDPOINT carries the coordinator URL.  Display the buffer when FOCUS."
  (let* ((servers (or (noema-pi-router--mcp-servers endpoint)
                      (user-error "The Noema coordinator endpoint is unavailable")))
         (config (or (noema-agent-acp-pi-config (noema-pi-deploy))
                     (user-error "Pi (pi-acp) is not configured; run M-x noema-pi-doctor"))))
    (setf (alist-get :mcp-servers config) servers)
    (let ((buffer (noema-agent-acp-start :config config :directory root
                                         :session-id native :focus focus)))
      (noema-agent-acp-mark-session-buffer buffer noema-pi-router-session-name "pi" root)
      (puthash root buffer noema-pi-router--buffers)
      (with-current-buffer buffer
        (add-hook 'kill-buffer-hook
                  (lambda ()
                    (when (eq (gethash root noema-pi-router--buffers) buffer)
                      (remhash root noema-pi-router--buffers)))
                  nil t))
      (noema-agent-acp-subscribe
       :buffer buffer :event 'init-finished
       :callback (lambda (_event)
                   (noema-pi-router--adopt root buffer)
                   ;; Requests queued while no Pi was running are not lost.
                   (noema-pi-router-claim root)))
      (noema-agent-acp-subscribe
       :buffer buffer :event 'tool-call-update
       :callback (lambda (_event) (noema-pi-router--schedule-claim root buffer)))
      buffer)))

(defun noema-pi-router--launch (root focus)
  "Start ROOT's Pi once, resuming its recorded conversation; show it when FOCUS."
  (when focus
    (puthash root t noema-pi-router--show))
  (unless (or (noema-pi-router-buffer root) (gethash root noema-pi-router--starting))
    (unless (fboundp 'my/noema--ensure-server)
      (user-error "Noema host integration is unavailable"))
    (puthash root t noema-pi-router--starting)
    (let ((abandon (lambda (reason)
                     (remhash root noema-pi-router--starting)
                     (remhash root noema-pi-router--show)
                     (noema-pi-router--warn "Pi for %s did not start: %s"
                                            (abbreviate-file-name root) reason))))
      (my/noema--ensure-server
       (lambda ()
         (noema-pi-router--api
          "aaronnote:api:research:coordinator:endpoint" `((cwd . ,root))
          (lambda (endpoint endpoint-error)
            (if (or endpoint-error (not (noema-pi-router--string endpoint "coordinatorUrl")))
                (funcall abandon "the coordinator endpoint is unavailable")
              (noema-pi-router--api
               "aaronnote:api:research:session:name:get"
               `((cwd . ,root) (name . ,noema-pi-router-session-name))
               (lambda (result _name-error)
                 (remhash root noema-pi-router--starting)
                 (let ((show (gethash root noema-pi-router--show)))
                   (remhash root noema-pi-router--show)
                   (unless (or (noema-pi-router-buffer root)
                               (and (not show) (gethash root noema-pi-router--closing)))
                     (condition-case error-object
                         (noema-pi-router--start
                          root
                          (or (noema-pi-router--string
                               (noema-pi-router--value result "name") "nativeSessionId")
                              (noema-pi-router--legacy-native-session-id root))
                          endpoint show)
                       (error (funcall abandon (error-message-string error-object))))))))))))))))

;;;###autoload
(defun noema-pi-router-ensure (&optional directory)
  "Return the running Pi of DIRECTORY's project, starting it hidden if needed.
While Pi is starting this returns nil."
  (let ((root (noema-pi-router--root (or directory default-directory))))
    (or (noema-pi-router-buffer root)
        (progn (noema-pi-router--launch root nil) nil))))

;;;###autoload
(defun noema-pi-router-open (&optional directory)
  "Show the Pi manager of DIRECTORY's project (default: here), starting it.
A live Pi buffer is reused.  Otherwise Pi resumes the conversation recorded
under the project's `pi' session name, or starts a fresh one."
  (interactive (list default-directory))
  (let* ((root (noema-pi-router--root (or directory default-directory)))
         (live (noema-pi-router-buffer root)))
    (remhash root noema-pi-router--closing)
    (if live
        (noema-agent-acp-show-buffer live)
      (noema-pi-router--launch root t))))

;;;; Lifecycle

(defun noema-pi-router--document-root (buffer)
  "Return the project root of BUFFER when it visits a `.noema' document."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (and buffer-file-name
           (derived-mode-p 'noema-research-mode)
           (noema-pi-router--root (file-name-directory buffer-file-name))))))

(defun noema-pi-router--project-documents (root &optional except)
  "Return live `.noema' buffers of project ROOT other than EXCEPT."
  (seq-filter (lambda (buffer)
                (and (not (eq buffer except))
                     (equal (noema-pi-router--document-root buffer) root)))
              (buffer-list)))

(defun noema-pi-router--project-agents (root)
  "Return live agent buffers, Pi included, that belong to project ROOT."
  (seq-filter (lambda (buffer)
                (and (noema-agent-acp-agent-buffer-p buffer)
                     (equal (buffer-local-value 'noema-agent-acp-session-root buffer) root)))
              (buffer-list)))

(defun noema-pi-router--busy-agents (root)
  "Return ROOT's agent buffers that a Noema Run is still using."
  (and (featurep 'noema-agent-worker)
       (seq-filter #'noema-agent-worker-buffer-busy-p (noema-pi-router--project-agents root))))

(defun noema-pi-router--cancel-stop (root)
  "Cancel ROOT's pending stop."
  (when-let* ((timer (gethash root noema-pi-router--stop-timers)))
    (when (timerp timer) (cancel-timer timer))
    (remhash root noema-pi-router--stop-timers)))

(defun noema-pi-router--stop-if-unused (root)
  "Close project ROOT unless a `.noema' document of it is open again."
  (remhash root noema-pi-router--stop-timers)
  (unless (noema-pi-router--project-documents root)
    (noema-pi-close-project root)))

;;;###autoload
(defun noema-pi-router-note-visit (&optional buffer)
  "Record that `.noema' BUFFER is open and start its project's Pi.
`noema-research-mode' calls this.  Pi starts in the background only when
`noema-pi-auto-start' is non-nil and Emacs is interactive."
  (when-let* ((buffer (or buffer (current-buffer)))
              (root (noema-pi-router--document-root buffer)))
    (noema-pi-router--cancel-stop root)
    (remhash root noema-pi-router--closing)
    (with-current-buffer buffer
      (add-hook 'kill-buffer-hook #'noema-pi-router-note-release nil t))
    (when (and noema-pi-auto-start (not noninteractive))
      (condition-case error-object
          (noema-pi-router-ensure root)
        (error
         (noema-pi-router--warn "Pi for %s did not start: %s"
                                (abbreviate-file-name root) (error-message-string error-object)))))))

(defun noema-pi-router-note-release ()
  "Schedule project cleanup when the current `.noema' buffer is its last."
  (when-let* ((root (noema-pi-router--document-root (current-buffer))))
    (unless (noema-pi-router--project-documents root (current-buffer))
      (noema-pi-router--cancel-stop root)
      (puthash root (run-at-time noema-pi-stop-delay nil #'noema-pi-router--stop-if-unused root)
               noema-pi-router--stop-timers))))

;;;###autoload
(defun noema-pi-close-project (&optional directory interrupt)
  "Stop the Pi and idle agent processes of DIRECTORY's project.
Session names and native ids stay, so reopening the project resumes them.
An agent still running a Run keeps going and stops when the Run ends; with
INTERRUPT (asked interactively) those Runs are cancelled first.  Return the
number of agent buffers stopped now."
  (interactive
   (let* ((root (noema-pi-router--root default-directory))
          (busy (length (noema-pi-router--busy-agents root))))
     (list root (and (> busy 0)
                     (yes-or-no-p (format "%d agent%s of %s still running a Run; cancel %s? "
                                          busy (if (= busy 1) " is" "s are")
                                          (abbreviate-file-name root)
                                          (if (= busy 1) "it" "them")))))))
  (let ((root (noema-pi-router--root (or directory default-directory)))
        (agents nil)
        (stopped 0))
    (noema-pi-router--cancel-stop root)
    (puthash root t noema-pi-router--closing)
    (setq agents (noema-pi-router--project-agents root))
    (when agents
      (require 'noema-agent-worker)
      (dolist (buffer agents)
        (if (noema-agent-worker-buffer-busy-p buffer)
            (when interrupt
              (noema-agent-worker-cancel-buffer buffer))
          (when (noema-agent-worker-stop-buffer buffer)
            (cl-incf stopped)))))
    (unless (buffer-live-p (gethash root noema-pi-router--buffers))
      (remhash root noema-pi-router--buffers))
    (when (called-interactively-p 'interactive)
      (message "Noema: stopped %d agent process%s of %s" stopped (if (= stopped 1) "" "es")
               (abbreviate-file-name root)))
    stopped))

(defun noema-pi-router--after-run (worker _state)
  "Stop WORKER's agent once its Run ends in a project that was closed meanwhile."
  (when-let* ((buffer (noema-agent-worker-buffer worker))
              ((buffer-live-p buffer))
              (root (buffer-local-value 'noema-agent-acp-session-root buffer))
              ((gethash root noema-pi-router--closing))
              ((not (noema-pi-router--project-documents root))))
    (run-at-time 0 nil (lambda ()
                         (when (buffer-live-p buffer)
                           (noema-agent-worker-stop-buffer buffer))))))

(with-eval-after-load 'noema-agent-worker
  (add-hook 'noema-agent-worker-run-finished-functions #'noema-pi-router--after-run))

(defun noema-pi-router--shutdown-all ()
  "Close every Pi session when Emacs exits, so pi-acp can clean up."
  (maphash (lambda (_root buffer)
             (when (buffer-live-p buffer)
               (ignore-errors (noema-agent-acp-shutdown buffer))))
           noema-pi-router--buffers))

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
  (or (seq-find (lambda (name)
                  (let ((value (getenv name)))
                    (and value (not (string-empty-p value)))))
                noema-pi-router--api-key-variables)
      (seq-some (lambda (file)
                  (let ((parsed (ignore-errors
                                  (noema-research-parse-json (noema-pi-router--read-file file)))))
                    (and (hash-table-p parsed)
                         (> (hash-table-count parsed) 0)
                         (abbreviate-file-name file))))
                (list (expand-file-name "auth.json" noema-pi-agent-directory)
                      (expand-file-name noema-pi-credentials-file)))))

(defun noema-pi-router--login-command ()
  "Return a shell command that runs the Pi CLI bundled with pi-acp, or nil."
  (when-let* ((acp (executable-find "pi-acp"))
              (cli (expand-file-name
                    "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
                    (file-name-directory (file-truename acp))))
              ((file-readable-p cli)))
    (format "PI_CODING_AGENT_DIR=%s node %s"
            (shell-quote-argument (directory-file-name (expand-file-name noema-pi-agent-directory)))
            (shell-quote-argument cli))))

(defun noema-pi-router-checks ()
  "Return Pi deployment checks as (OK LABEL DETAIL) lists."
  (let* ((acp (executable-find "pi-acp"))
         (acp-version (and acp (noema-pi-router--program-version acp "--version")))
         (node (executable-find "node"))
         (node-version (and node (noema-pi-router--program-version node "--version")))
         (credentials (noema-pi-router--credentials))
         (extension (expand-file-name "extensions/noema-manager/index.ts" noema-pi-agent-directory))
         (config (noema-agent-acp-config-for "pi")))
    (list
     (list (and acp t) "pi-acp on PATH"
           (or acp "missing: npm install -g @automatalabs/pi-acp@0.8.0"))
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
               "Pi default (set noema-pi-model to a small model)"
             noema-pi-model))
     (list (bound-and-true-p my/noema--ready) "Noema host"
           (if (bound-and-true-p my/noema--ready) "ready" "not started (it starts on first use)")))))

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
