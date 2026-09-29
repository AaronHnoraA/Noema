;;; noema-agent-acp.el --- Noema boundary for package-managed agent-shell/ACP -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; The unmodified package-managed agent-shell and acp.el implementations own physical
;; agent sessions.  Noema owns durable work/session identity.  All coupling to
;; agent-shell implementation details is isolated here so document workers do
;; not serialize agent-shell buffers or private state as canonical data.

;;; Code:

(require 'map)
(require 'json)
(require 'project)
(require 'seq)
(require 'simple)
(require 'tab-line)
(require 'noema-upstream)
(require 'agent-shell)
(require 'acp)
(require 'noema-agent-render)
(noema-agent-render-mode 1)

(declare-function magent-start "magent-agent-shell" ())
(declare-function remote-client-file-name "remote" (file &optional context))
(declare-function agent-shell-insert "agent-shell" (&key text submit no-focus shell-buffer))
(declare-function shell-maker-finish-output "shell-maker" (&key config success on-output))
(declare-function evil-define-minor-mode-key "evil-core" (state mode key def &rest bindings))
(declare-function evil-insert-state "evil-states" (&optional arg))
;; Session registry commands for the Agent window live in `noema-sessions',
;; which depends on this boundary.
(declare-function noema-sessions-agent-restart "noema-sessions" (&optional buffer))
(declare-function noema-sessions-agent-rename "noema-sessions" (&optional buffer new-name))
(declare-function noema-sessions-agent-fork "noema-sessions" (&optional buffer child))
(declare-function noema-sessions-agent-side-chat "noema-sessions" (&optional buffer))
(declare-function noema-sessions-agent-archive "noema-sessions" (&optional buffer))
(declare-function noema-sessions-agent-jump "noema-sessions" (&optional buffer))
(declare-function noema-sessions-agent-list "noema-sessions" (&optional buffer))
(defvar shell-maker--busy)
(defvar agent-shell-confirm-interrupt)
(defvar shell-maker--config)
(defvar comint-last-prompt)
(defvar noema-agent-render--pending)
(declare-function agent-shell--live-input-prompt-p "agent-shell" (prompt))

(defun noema-agent-acp--state (&optional buffer)
  "Return embedded agent-shell state for BUFFER or the current buffer."
  (with-current-buffer (or buffer (current-buffer))
    agent-shell--state))

(defun noema-agent-acp-state-value (buffer path &optional default)
  "Read PATH from BUFFER's agent-shell state, returning DEFAULT if absent."
  (or (map-nested-elt (noema-agent-acp--state buffer) path) default))

(defvar noema-agent-acp-model-preferences-file
  (locate-user-emacs-file "var/noema/agent-models.json")
  "Local, non-project storage for the last successfully selected model per agent.")

(defun noema-agent-acp--read-models ()
  "Read model preferences as data, never as executable Lisp."
  (condition-case nil
      (with-temp-buffer
        (insert-file-contents noema-agent-acp-model-preferences-file)
        (let ((models (json-parse-buffer :object-type 'hash-table)))
          (if (hash-table-p models) models (make-hash-table :test #'equal))))
    (error (make-hash-table :test #'equal))))

(defun noema-agent-acp--remember-model (identifier model)
  "Remember a successfully selected MODEL for agent IDENTIFIER."
  (when (and identifier (stringp model) (not (string-empty-p model)))
    (condition-case err
        (let ((models (noema-agent-acp--read-models)))
          (puthash (format "%s" identifier) model models)
          (make-directory (file-name-directory noema-agent-acp-model-preferences-file) t)
          (with-temp-file noema-agent-acp-model-preferences-file
            (insert (json-serialize models))))
      (error (message "Could not save agent model preference: %s" (error-message-string err))))))

(defun noema-agent-acp--model-config (args)
  "Apply remembered defaults through upstream's normal startup pipeline in ARGS."
  (let* ((config (copy-tree (plist-get args :config)))
         (identifier (map-elt config :identifier))
         (saved (gethash (format "%s" identifier) (noema-agent-acp--read-models)))
         (fallback (map-elt config :default-model-id)))
    (when (and config (stringp saved))
      (setf (alist-get :default-model-id config)
            (lambda ()
              ;; Providers may remove a model. Do not block startup on a stale ID.
              (if (seq-some (lambda (model) (equal (map-elt model :model-id) saved))
                            (agent-shell--get-available-models (agent-shell--state)))
                  saved
                (when (functionp fallback) (funcall fallback)))))
      (setq args (plist-put (copy-sequence args) :config config)))
    args))

(defun noema-agent-acp--select-model (original &optional on-success)
  "Remember interactive model selection after ORIGINAL succeeds; reject busy edits."
  (when (or (map-elt (agent-shell--state) :active-requests)
            (and (fboundp 'noema-agent-worker-buffer-busy-p)
                 (noema-agent-worker-buffer-busy-p (current-buffer))))
    (user-error "Agent is starting or running; finish/cancel the current turn before changing model"))
  (let ((buffer (current-buffer))
        (identifier (map-nested-elt (agent-shell--state) '(:agent-config :identifier))))
    (funcall original
             (lambda ()
               (when (buffer-live-p buffer)
                 (with-current-buffer buffer
                   (noema-agent-acp--remember-model identifier (agent-shell--current-model-id (agent-shell--state)))))
               (when on-success (funcall on-success))))))

(advice-add 'agent-shell--start :filter-args #'noema-agent-acp--model-config)
(advice-add 'agent-shell-set-session-model :around #'noema-agent-acp--select-model)

(defun noema-agent-acp--set-model (original &rest args)
  "Remember successful model changes from upstream's keyboard and mouse UI."
  (let ((buffer (current-buffer))
        (identifier (map-nested-elt (agent-shell--state) '(:agent-config :identifier)))
        (success (plist-get args :on-success)))
    (apply original
           (plist-put (copy-sequence args) :on-success
                      (lambda ()
                        (when (buffer-live-p buffer)
                          (with-current-buffer buffer
                            (noema-agent-acp--remember-model
                             identifier (agent-shell--current-model-id (agent-shell--state)))))
                        (when success (funcall success)))))))

(advice-add 'agent-shell--config-option-set-model-id :around #'noema-agent-acp--set-model)

(defun noema-agent-acp-agent-buffer-p (buffer)
  "Return non-nil when BUFFER is an embedded agent-shell session."
  (and (buffer-live-p buffer)
       (with-current-buffer buffer (derived-mode-p 'agent-shell-mode))))

(defvar-local noema-agent-acp-session-name nil
  "D-031 session name served by this agent-shell buffer, or nil.")
(put 'noema-agent-acp-session-name 'permanent-local t)

(defvar-local noema-agent-acp-session-agent nil
  "Agent id of the session served by this agent-shell buffer.")
(put 'noema-agent-acp-session-agent 'permanent-local t)

(defvar-local noema-agent-acp-session-root nil
  "Project root of the session served by this agent-shell buffer.")
(put 'noema-agent-acp-session-root 'permanent-local t)

(defvar-local noema-agent-acp-session-origin nil
  "How this agent-shell buffer was started.
One of `run', `popup', `manual', `foreign', `pi', `takeover', `probe' or
`side' (an ephemeral side chat, see `noema-agent-acp-ephemeral-origins').
Every entry point records it through `noema-agent-acp-adopt' so one project
view can list and manage sessions whatever opened them.")
(put 'noema-agent-acp-session-origin 'permanent-local t)

(defvar-local noema-agent-acp-display-buffer-function nil
  "Optional Emacs-owned display function for this agent buffer.
The popup pool uses this boundary instead of changing agent-shell internals.
The function receives the live agent buffer and owns only its presentation.")
(put 'noema-agent-acp-display-buffer-function 'permanent-local t)

(defvar-local noema-agent-acp-last-used-at nil
  "Time this Noema-owned physical Session was last used or displayed.")
(put 'noema-agent-acp-last-used-at 'permanent-local t)

(defvar-local noema-agent-acp-context-warning-level 0
  "Highest Noema context pressure warning emitted for this physical Session.")
(put 'noema-agent-acp-context-warning-level 'permanent-local t)

;; D-033: every physical agent-shell buffer stays out of the global tab-line
;; and tab-bar.  A project's sessions are tabs of one bottom-right Agent
;; window; each tab is the session's own interactive agent-shell buffer.

(defvar noema-agent-acp-tabs-mode-map (make-sparse-keymap)
  "Keymap for managing sessions inside the Noema Agent window.")

;; Bound at top level, not in the `defvar' initial value: reloading this file
;; must update the keymap that live Agent buffers already use.
(dolist (binding '(("C-c C-a" . noema-agent-acp-switch-session)
                   ("C-c C-n" . noema-agent-acp-next-session)
                   ("C-c C-p" . noema-agent-acp-previous-session)
                   ("C-c C-e" . noema-agent-acp-focus-input)
                   ("C-c C-v" . agent-shell-set-session-model)
                   ("C-c C-x" . noema-agent-acp-stop)
                   ("C-c C-r" . noema-sessions-agent-restart)
                   ("C-c C-k" . noema-agent-acp-close)
                   ("C-c M-k" . noema-agent-acp-close-others)
                   ("C-c C-w" . noema-sessions-agent-rename)
                   ("C-c C-f" . noema-sessions-agent-fork)
                   ("C-c C-q" . noema-sessions-agent-side-chat)
                   ("C-c C-d" . noema-sessions-agent-archive)
                   ("C-c C-j" . noema-sessions-agent-jump)
                   ("C-c C-l" . noema-sessions-agent-list)
                   ("C-c C-z" . noema-agent-acp-menu)
                   ("C-c ?" . noema-agent-acp-help)
                   ("?" . noema-agent-acp-help-or-insert)))
  (define-key noema-agent-acp-tabs-mode-map (kbd (car binding)) (cdr binding)))

(define-minor-mode noema-agent-acp-tabs-mode
  "Show this agent-shell buffer as one tab of its project Agent window.

The buffer remains the real, interactive agent-shell session.  Its tab line
lists every live session of the same project; choosing a tab shows that
session's own buffer in the Agent window instead of copying a transcript.
Right-click a tab, or press \\[noema-agent-acp-menu], for session management;
\\[noema-agent-acp-help] describes every key.

\\{noema-agent-acp-tabs-mode-map}"
  :lighter nil
  :keymap noema-agent-acp-tabs-mode-map
  (if noema-agent-acp-tabs-mode
      (setq-local tab-line-format '(:eval (noema-agent-acp--tab-line)))
    (kill-local-variable 'tab-line-format)))

(with-eval-after-load 'evil
  ;; Normal state owns `?' for search; in an Agent window it is help.
  (when (fboundp 'evil-define-minor-mode-key)
    (evil-define-minor-mode-key 'normal 'noema-agent-acp-tabs-mode
      (kbd "?") #'noema-agent-acp-help)
    (dolist (state '(normal insert visual motion))
      (evil-define-minor-mode-key state 'noema-agent-acp-tabs-mode
        (kbd "C-c C-e") #'noema-agent-acp-focus-input
        (kbd "C-c C-x") #'noema-agent-acp-stop
        (kbd "C-c C-v") #'agent-shell-set-session-model))))

(defun noema-agent-acp--sync-shell-buffer-name (buffer)
  "Keep shell-maker's native input/output target attached to BUFFER.
Noema gives sessions stable display names.  Shell-maker resolves its
process through this buffer-local name, so it must follow every rename."
  (with-current-buffer buffer
    (setq-local shell-maker--buffer-name-override (buffer-name))))

(defun noema-agent-acp--workspace-root (root)
  "Normalize project ROOT for workspace identity.
A logical /fs: spelling and the native one name the same project, so both
normalize to the native path the Noema host uses."
  (let ((root (file-name-as-directory (expand-file-name (or root default-directory)))))
    (or (and (fboundp 'noema-project-client-path)
             (noema-project-client-path root))
        root)))

(defun noema-agent-acp--tab-key (buffer)
  "Return agent BUFFER's stable tab key: coordinator, named, then retired."
  (let ((name (buffer-local-value 'noema-agent-acp-session-name buffer)))
    (cons (cond ((equal name "pi") 0) (name 1) (t 2))
          (or name (buffer-name buffer)))))

(defun noema-agent-acp--project-buffers (&optional root)
  "Return live agent buffers of project ROOT in stable tab order.
The coordinator comes first and sessions follow by name, so selecting a tab
never moves the others."
  (let ((root (noema-agent-acp--workspace-root
               (or root noema-agent-acp-session-root))))
    (sort
     (seq-filter
      (lambda (buffer)
        (and (noema-agent-acp-agent-buffer-p buffer)
             (not (buffer-local-value 'noema-agent-acp-display-buffer-function buffer))
             (equal (buffer-local-value 'noema-agent-acp-session-root buffer) root)))
      (buffer-list))
     (lambda (left right)
       (let ((left (noema-agent-acp--tab-key left))
             (right (noema-agent-acp--tab-key right)))
         (if (= (car left) (car right))
             (string-lessp (cdr left) (cdr right))
           (< (car left) (car right))))))))

(defun noema-agent-acp--tab-label (buffer)
  "Return the tab label of agent BUFFER."
  (with-current-buffer buffer
    (cond
     (noema-agent-acp-session-name
      (format "%s · %s" noema-agent-acp-session-name
              (or noema-agent-acp-session-agent "agent")))
     ;; A retired buffer gave its name to a newer physical session.
     ((string-match "\\*Noema Agent · \\(.+\\) @ [^*]*\\*" (buffer-name))
      (format "%s (retired)" (match-string 1 (buffer-name))))
     (t (string-trim (buffer-name))))))

(defun noema-agent-acp--tab-line ()
  "Return the session tab line of the current agent buffer's project."
  (let ((current (current-buffer)))
    (mapconcat
     (lambda (buffer)
       (let ((selected (eq buffer current))
             (map (make-sparse-keymap)))
         (define-key map [tab-line mouse-1]
                     (lambda (event)
                       (interactive "e")
                       (select-window (posn-window (event-start event)))
                       (noema-agent-acp-show-buffer buffer)))
         ;; tab-line binds the press globally to its own tab menu, so the
         ;; session menu must own the press and swallow the release.
         (define-key map [tab-line down-mouse-3]
                     (lambda (event)
                       (interactive "e")
                       (noema-agent-acp-menu buffer event)))
         (define-key map [tab-line mouse-3] #'ignore)
         (propertize (concat " " (noema-agent-acp--tab-label buffer) " ")
                     'face (if selected 'tab-line-tab-current 'tab-line-tab-inactive)
                     'mouse-face 'tab-line-highlight
                     'help-echo (if selected
                                    "mouse-3: manage this agent session"
                                  "mouse-1: show this agent session\nmouse-3: manage it")
                     'keymap map)))
     (noema-agent-acp--project-buffers noema-agent-acp-session-root)
     " ")))

(defun noema-agent-acp--refresh-tabs (&rest _)
  "Redraw Agent window tab lines after a project's session set changed."
  (run-at-time 0 nil #'tab-line-force-update t))

(defun noema-agent-acp--install-workspace-tabs (buffer)
  "Make agent BUFFER a tab of its project Agent window.
The buffer stays out of the global tab-line and tab-bar (D-033) and is still
the real agent-shell buffer, so it accepts input and interrupts directly."
  (when (and (buffer-live-p buffer)
             (not (buffer-local-value 'noema-agent-acp-display-buffer-function buffer)))
    (with-current-buffer buffer
      (noema-agent-acp--sync-shell-buffer-name buffer)
      (setq-local tab-line-exclude t)
      ;; Hooks installed by the transcript-copy workspace of an older load.
      (remove-hook 'after-change-functions 'noema-agent-acp--workspace-source-changed t)
      (remove-hook 'kill-buffer-hook 'noema-agent-acp--workspace-source-killed t)
      (unless noema-agent-acp-tabs-mode
        (noema-agent-acp-tabs-mode 1))
      (add-hook 'kill-buffer-hook #'noema-agent-acp--refresh-tabs nil t))
    (noema-agent-acp--refresh-tabs)))

(defun noema-agent-acp-switch-session ()
  "Show another live agent session of this project in the Agent window."
  (interactive)
  (let ((choices (mapcar (lambda (buffer)
                           (cons (noema-agent-acp--tab-label buffer) buffer))
                         (noema-agent-acp--project-buffers noema-agent-acp-session-root))))
    (unless choices
      (user-error "No live Noema agent session in this project"))
    (noema-agent-acp-show-buffer
     (cdr (assoc (completing-read "Agent session: " choices nil t) choices)))))

(defun noema-agent-acp-next-session (&optional count)
  "Show the COUNTth next session tab of this project in the Agent window."
  (interactive "p")
  (let* ((buffers (noema-agent-acp--project-buffers noema-agent-acp-session-root))
         (index (seq-position buffers (current-buffer))))
    (unless buffers
      (user-error "No live Noema agent session in this project"))
    (noema-agent-acp-show-buffer
     (nth (mod (+ (or index 0) (or count 1)) (length buffers)) buffers))))

(defun noema-agent-acp-previous-session (&optional count)
  "Show the COUNTth previous session tab of this project in the Agent window."
  (interactive "p")
  (noema-agent-acp-next-session (- (or count 1))))

(defvar noema-agent-acp-busy-functions nil
  "Abnormal hook called with an agent buffer; non-nil while a Run uses it.")

(defvar noema-agent-acp-stop-functions nil
  "Abnormal hook called with an agent buffer; non-nil after one stopped its Run.")

(defvar-local noema-agent-acp--prompt-owed nil
  "Non-nil when a Noema-driven turn ended without a live input prompt yet.")

(defun noema-agent-acp--default-buffer ()
  "Return the agent buffer a command should act on from the current context."
  (or (and (noema-agent-acp-agent-buffer-p (current-buffer)) (current-buffer))
      (when-let* ((window (noema-agent-acp--workspace-window))
                  ((noema-agent-acp-agent-buffer-p (window-buffer window))))
        (window-buffer window))
      (let ((directory (expand-file-name default-directory)))
        (seq-find (lambda (buffer)
                    (and (noema-agent-acp-agent-buffer-p buffer)
                         (when-let* ((root (buffer-local-value 'noema-agent-acp-session-root buffer)))
                           (string-prefix-p root directory))))
                  (buffer-list)))))

(defun noema-agent-acp-command-buffer (&optional buffer)
  "Return BUFFER or the agent buffer of the current context, or signal."
  (let ((candidate (or buffer (noema-agent-acp--default-buffer))))
    (unless (noema-agent-acp-agent-buffer-p candidate)
      (user-error "No Noema agent session here"))
    candidate))

(defun noema-agent-acp-busy-p (buffer)
  "Return non-nil while agent BUFFER answers a prompt or serves a Noema Run."
  (or (buffer-local-value 'shell-maker--busy buffer)
      (run-hook-with-args-until-success 'noema-agent-acp-busy-functions buffer)))

(defun noema-agent-acp-pending-prompt-count (buffer)
  "Return how many prompts the person queued in agent BUFFER.
agent-shell owns the queue (`agent-shell-prompt-queue', steering and
removal); Noema only reads its length so lists can show queued intent."
  (if (buffer-live-p buffer)
      (length (ignore-errors
                (map-elt (buffer-local-value 'agent-shell--state buffer) :pending-prompts)))
    0))

(declare-function agent-shell-get-model-name "agent-shell" (state))

(defvar-local noema-agent-acp--context-last 0
  "Context tokens this session's agent reported last.")
(put 'noema-agent-acp--context-last 'permanent-local t)

(defvar-local noema-agent-acp--context-peak 0
  "Most context tokens this session's agent has reported.")
(put 'noema-agent-acp--context-peak 'permanent-local t)

(defvar-local noema-agent-acp--compactions 0
  "Context compactions seen in this session, see `noema-agent-acp--note-context'.")
(put 'noema-agent-acp--compactions 'permanent-local t)

(defconst noema-agent-acp--compaction-ratio 0.7
  "A context report below this share of the previous one counts as a compaction.")

(defconst noema-agent-acp--compaction-floor 10000
  "Context below this many tokens is too small for a drop to mean compaction.")

(defvar noema-agent-acp-rate-limits-file
  (locate-user-emacs-file "var/noema/agent-rate-limits.json")
  "Last subscription rate limits the agents reported, kept across restarts.")

(defvar noema-agent-acp--rate-limits nil
  "Table \"AGENT/WINDOW\" -> plist, loaded from the file on first use.")

(defun noema-agent-acp-rate-limits ()
  "Return the latest subscription rate limit per agent and window.
A table from \"AGENT/WINDOW\" to a plist with :agent, :window, :utilization
\(0.0-1.0 or nil), :status, :resets-at (epoch seconds or nil) and
:updated-at.  Filled from the `_claude/rateLimit' metadata claude-agent-acp
attaches to `usage_update', and kept in `noema-agent-acp-rate-limits-file'
so the last value survives a restart; :updated-at shows its age."
  (or noema-agent-acp--rate-limits
      (setq noema-agent-acp--rate-limits
            (let ((table (make-hash-table :test #'equal)))
              (dolist (limit (condition-case nil
                                 (with-temp-buffer
                                   (insert-file-contents noema-agent-acp-rate-limits-file)
                                   (json-parse-buffer :object-type 'plist :array-type 'list
                                                      :null-object nil))
                               (error nil)))
                (when (and (plist-get limit :agent) (plist-get limit :window))
                  (puthash (format "%s/%s" (plist-get limit :agent) (plist-get limit :window))
                           limit table)))
              table))))

(defun noema-agent-acp--save-rate-limits ()
  "Write the rate-limit table as data."
  (condition-case err
      (let (limits)
        (maphash (lambda (_key limit)
                   (push (cl-loop for (key value) on limit by #'cddr
                                  when value append (list key value))
                         limits))
                 (noema-agent-acp-rate-limits))
        (make-directory (file-name-directory noema-agent-acp-rate-limits-file) t)
        (with-temp-file noema-agent-acp-rate-limits-file
          (insert (json-serialize (vconcat limits)))))
    (error (message "Could not save agent rate limits: %s" (error-message-string err)))))

(defvar noema-agent-acp-changed-functions nil
  "Abnormal hook run with an agent buffer after its visible state changed.
It runs after agent-shell stores reported usage, after every full header
update (session start, model or mode change, turn start and end) -- not
after the busy animation's cached ticks -- and when the buffer is killed.
Listeners should coalesce; several changes arrive together.")

(defun noema-agent-acp--changed ()
  "Tell `noema-agent-acp-changed-functions' the current agent buffer changed."
  (run-hook-with-args 'noema-agent-acp-changed-functions (current-buffer)))

(defun noema-agent-acp--header-updated-a (&rest args)
  "Report a full agent-shell header update; ARGS are its keyword arguments."
  (unless (plist-get args :cache-enabled)
    (noema-agent-acp--changed)))

(advice-add 'agent-shell--update-header-and-mode-line :after
            #'noema-agent-acp--header-updated-a)

(defun noema-agent-acp--note-context (used)
  "Record the context size USED just reported by the current agent buffer.
The agent computes USED itself, so a sharp drop from a sizeable context is a
compaction or a cleared conversation rather than cache variance (abtop
additionally checks cache reads because it derives context from them)."
  (when (and (numberp used) (> used 0))
    (when (and (>= noema-agent-acp--context-last noema-agent-acp--compaction-floor)
               (< used (* noema-agent-acp--compaction-ratio noema-agent-acp--context-last)))
      (cl-incf noema-agent-acp--compactions))
    (setq noema-agent-acp--context-last used
          noema-agent-acp--context-peak (max noema-agent-acp--context-peak used))))

(defvar noema-agent-acp--rate-limits-saved-at 0
  "When the rate-limit file was last written.")

(defconst noema-agent-acp--rate-limits-save-interval 300
  "Seconds after which an unchanged rate limit is rewritten, to keep its age.")

(defun noema-agent-acp-put-rate-limit (agent window utilization &rest properties)
  "Record that AGENT's WINDOW is UTILIZATION used, a fraction 0.0-1.0 or nil.
PROPERTIES may give :status and :resets-at (epoch seconds).  The file is
written only when a value changed, or after
`noema-agent-acp--rate-limits-save-interval' to keep its age true."
  (let* ((key (format "%s/%s" agent window))
         (utilization (and (numberp utilization) utilization))
         (limit (list :agent agent :window window :utilization utilization
                      :status (plist-get properties :status)
                      :resets-at (let ((value (plist-get properties :resets-at)))
                                   (and (numberp value) value))
                      :updated-at (float-time)))
         (old (gethash key (noema-agent-acp-rate-limits))))
    (puthash key limit (noema-agent-acp-rate-limits))
    (when (or (not (equal (plist-get old :utilization) utilization))
              (not (equal (plist-get old :resets-at) (plist-get limit :resets-at)))
              (not (equal (plist-get old :status) (plist-get limit :status)))
              (> (- (float-time) noema-agent-acp--rate-limits-saved-at)
                 noema-agent-acp--rate-limits-save-interval))
      (setq noema-agent-acp--rate-limits-saved-at (float-time))
      (noema-agent-acp--save-rate-limits))))

(defun noema-agent-acp--note-rate-limit (agent info)
  "Record claude-agent-acp rate-limit INFO reported by AGENT.
INFO names the window it concerns; newer Claude Code versions also attach
`unifiedWindows' with every window's utilization at once."
  (when-let* ((window (map-elt info 'rateLimitType)))
    (noema-agent-acp-put-rate-limit agent window (map-elt info 'utilization)
                                    :status (map-elt info 'status)
                                    :resets-at (map-elt info 'resetsAt)))
  (pcase-dolist (`(,window . ,value) (map-elt info 'unifiedWindows))
    (when (consp value)
      (noema-agent-acp-put-rate-limit agent (symbol-name window) (map-elt value 'utilization)
                                      :resets-at (map-elt value 'resetsAt)))))

(defun noema-agent-acp--usage-updated-a (&rest args)
  "After agent-shell stores reported usage, record what Noema tracks with it.
ARGS are agent-shell's keyword arguments; the notification form carries the
context size and, from claude-agent-acp, rate-limit metadata."
  (let* ((state (plist-get args :state))
         (buffer (map-elt state :buffer)))
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (when-let* ((update (plist-get args :acp-update)))
          (noema-agent-acp--note-context (map-elt update 'used))
          (when-let* ((info (map-nested-elt update '(_meta _claude/rateLimit))))
            (noema-agent-acp--note-rate-limit
             (or noema-agent-acp-session-agent "agent") info))))
      (with-current-buffer buffer (noema-agent-acp--changed)))))

(advice-add 'agent-shell--update-usage-from-notification :after
            #'noema-agent-acp--usage-updated-a)
(advice-add 'agent-shell--save-usage :after #'noema-agent-acp--usage-updated-a)

(defun noema-agent-acp-usage (buffer)
  "Return what agent BUFFER's ACP connection reported about its usage.
A plist with :model, :model-id, :context-used, :context-size, :context-peak,
:compactions, :input, :output, :thought, :cached-read, :cached-write, :total,
:cost, :currency and :turns.  Counts are non-negative integers, zero when
never reported; :cost is nil until the agent reports one.

agent-shell already records these from `usage_update' notifications and
PromptResponse usage, so this only reads that state: no process scan, no
request, no timer.  It is the one place Noema reads agent-shell's usage."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (let* ((state (buffer-local-value 'agent-shell--state buffer))
           (usage (map-elt state :usage))
           (count (lambda (key)
                    (let ((value (map-elt usage key)))
                      (if (numberp value) (max 0 (truncate value)) 0)))))
      (list :model (ignore-errors (agent-shell-get-model-name state))
            :model-id (map-nested-elt state '(:session :model-id))
            :context-used (funcall count :context-used)
            :context-size (funcall count :context-size)
            :context-peak (buffer-local-value 'noema-agent-acp--context-peak buffer)
            :compactions (buffer-local-value 'noema-agent-acp--compactions buffer)
            :input (funcall count :input-tokens)
            :output (funcall count :output-tokens)
            :thought (funcall count :thought-tokens)
            :cached-read (funcall count :cached-read-tokens)
            :cached-write (funcall count :cached-write-tokens)
            :total (funcall count :total-tokens)
            ;; agent-shell starts every session at 0, so zero means unreported.
            :cost (let ((amount (map-elt usage :cost-amount)))
                    (and (numberp amount) (> amount 0) amount))
            :currency (map-elt usage :cost-currency)
            :turns (let ((turns (map-elt state :request-count)))
                     (if (natnump turns) turns 0))))))

(defcustom noema-agent-acp-ephemeral-origins '(side)
  "Session origins that never enter a project's durable session registry.
A side chat asks a quick question beside a session without becoming one of
the project's conversations; it is listed while it lives and then goes.
Adopted from Pisper's temporary side chat."
  :type '(repeat symbol)
  :group 'noema-agent-session)

(defvar-local noema-agent-acp-side-parent nil
  "Name of the session this ephemeral side chat was opened beside.")
(put 'noema-agent-acp-side-parent 'permanent-local t)

(defcustom noema-agent-acp-auto-stop-origins '(run probe pi side)
  "Session origins whose idle, hidden agents may be stopped automatically.
Automatic stops are the periodic warm-buffer sweep and closing a project when
its last `.noema' document goes.  Sessions a person opened -- `manual',
`takeover', `foreign' (a bare `M-x agent-shell') -- are never stopped behind
their back; close them with \\[noema-agent-acp-close] instead."
  :type '(repeat symbol)
  :group 'noema-agent-session)

(defun noema-agent-acp-note-activity (&rest _)
  "Record that the current agent buffer changed: input, output or a prompt.
Idle time is measured from real activity, not from when the session was
last shown, so a conversation typed directly into the buffer stays warm."
  (setq noema-agent-acp-last-used-at (float-time)))

(defun noema-agent-acp--track-activity-h ()
  "Measure this agent buffer's idle time and report when it goes."
  (add-hook 'after-change-functions #'noema-agent-acp-note-activity nil t)
  (add-hook 'kill-buffer-hook #'noema-agent-acp--changed nil t)
  (unless noema-agent-acp-last-used-at
    (noema-agent-acp-note-activity)))

(add-hook 'agent-shell-mode-hook #'noema-agent-acp--track-activity-h)
(dolist (buffer (buffer-list))
  (when (noema-agent-acp-agent-buffer-p buffer)
    (with-current-buffer buffer (noema-agent-acp--track-activity-h))))

(defun noema-agent-acp-auto-stoppable-p (buffer)
  "Return non-nil when an automatic lifecycle may stop agent BUFFER.
It must be idle, hold no queued prompt, shown in no window of any frame, and
started by an origin in
`noema-agent-acp-auto-stop-origins'.  Every automatic stop path asks this."
  (and (noema-agent-acp-agent-buffer-p buffer)
       (memq (buffer-local-value 'noema-agent-acp-session-origin buffer)
             noema-agent-acp-auto-stop-origins)
       (not (noema-agent-acp-busy-p buffer))
       ;; Queued prompts are the person's intent still waiting to be sent.
       (zerop (noema-agent-acp-pending-prompt-count buffer))
       (not (get-buffer-window buffer t))))

(defun noema-agent-acp-confirm-stop (buffer action)
  "Return non-nil when ACTION may stop agent BUFFER, asking while it is busy."
  (or (not (noema-agent-acp-busy-p buffer))
      (yes-or-no-p (format "%s is still working; %s it anyway? "
                           (noema-agent-acp--tab-label buffer) action))))

(defun noema-agent-acp-stop (&optional buffer)
  "Stop agent BUFFER's work: cancel its Noema Run, else interrupt the turn."
  (interactive)
  (let ((buffer (noema-agent-acp-command-buffer buffer)))
    (unless (run-hook-with-args-until-success 'noema-agent-acp-stop-functions buffer)
      (noema-agent-acp-interrupt buffer t))))

(defun noema-agent-acp-kill (buffer)
  "Kill agent BUFFER, showing another session of its project in its windows."
  (let* ((root (buffer-local-value 'noema-agent-acp-session-root buffer))
         (next (car (delq buffer (noema-agent-acp--project-buffers root)))))
    (dolist (window (get-buffer-window-list buffer nil t))
      (cond (next (set-window-buffer window next))
            ((window-parameter window 'noema-agent-workspace)
             (ignore-errors (delete-window window)))))
    (let ((kill-buffer-query-functions nil))
      (kill-buffer buffer))))

(defun noema-agent-acp-close (&optional buffer)
  "Close agent BUFFER's tab.  Its process stops; its name and history remain."
  (interactive)
  (let ((buffer (noema-agent-acp-command-buffer buffer)))
    (when (noema-agent-acp-confirm-stop buffer "close")
      (noema-agent-acp-kill buffer))))

(defun noema-agent-acp--close-where (buffer predicate)
  "Close the tabs of BUFFER's project whose buffer satisfies PREDICATE."
  (dolist (other (noema-agent-acp--project-buffers
                  (buffer-local-value 'noema-agent-acp-session-root buffer)))
    (when (and (funcall predicate other)
               (noema-agent-acp-confirm-stop other "close"))
      (noema-agent-acp-kill other))))

(defun noema-agent-acp-close-others (&optional buffer)
  "Close every other session tab of agent BUFFER's project."
  (interactive)
  (let ((buffer (noema-agent-acp-command-buffer buffer)))
    (noema-agent-acp--close-where buffer (lambda (other) (not (eq other buffer))))
    (noema-agent-acp-show-buffer buffer)))

(defun noema-agent-acp-close-retired (&optional buffer)
  "Close the retired session tabs of agent BUFFER's project."
  (interactive)
  (let ((buffer (noema-agent-acp-command-buffer buffer)))
    (noema-agent-acp--close-where
     buffer (lambda (other)
              (null (buffer-local-value 'noema-agent-acp-session-name other))))))

(defun noema-agent-acp--input-start (buffer)
  "Return where the input after BUFFER's last prompt begins, or nil."
  (with-current-buffer buffer
    (when-let* ((prompt (bound-and-true-p comint-last-prompt))
                ((markerp (cdr prompt))))
      (marker-position (cdr prompt)))))

(defun noema-agent-acp--live-input-p ()
  "Return non-nil when the last native prompt still owns editable input.
Plain agent-shell replies carry `agent-shell-ui-state' and `read-only',
but can lack `field=output' after a programmatic Noema submission."
  (and comint-last-prompt
       (agent-shell--live-input-prompt-p comint-last-prompt)
       (not (text-property-not-all
             (cdr comint-last-prompt) (point-max) 'agent-shell-ui-state nil))))

(defun noema-agent-acp--settle-prompt (buffer)
  "Write BUFFER's owed input prompt once its turn output is on screen.
Return non-nil when a prompt was written."
  (with-current-buffer buffer
    (noema-agent-acp--sync-shell-buffer-name buffer)
    (when (and noema-agent-acp--prompt-owed
               ;; A hidden buffer defers its output (render policy `visible');
               ;; the prompt must follow that output, not precede it.
               (not noema-agent-render--pending)
               (not (map-elt agent-shell--state :active-requests))
               (bound-and-true-p shell-maker--config))
      (agent-shell-heartbeat-stop :heartbeat (map-elt agent-shell--state :heartbeat))
      (agent-shell--collapse-expanded-activity-group agent-shell--state)
      (let ((written
             (unless (noema-agent-acp--live-input-p)
               (shell-maker-finish-output :config shell-maker--config :success t)
               t)))
        ;; Keep the retry flag if native prompt creation failed.  Never leave
        ;; a stale busy flag after a confirmed terminal response.
        (setq shell-maker--busy nil
              noema-agent-acp--prompt-owed nil)
        written))))

(defun noema-agent-acp-restore-prompt (buffer)
  "Give agent BUFFER a live input prompt after a Noema-driven turn.
Noema prompts through the ACP request API, bypassing shell-maker's input
flow, so nothing writes the next prompt when that turn ends.  Write it the
way agent-shell ends its own turns.  When the turn's output is still deferred
because the buffer is hidden, the prompt is written right after that output
renders.  Return non-nil when a prompt was written now."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (with-current-buffer buffer
      (unless (map-elt agent-shell--state :active-requests)
        (agent-shell-heartbeat-stop :heartbeat (map-elt agent-shell--state :heartbeat))
        (setq shell-maker--busy nil))
      (setq-local noema-agent-acp--prompt-owed t))
    (noema-agent-acp--settle-prompt buffer)))

(defun noema-agent-acp--settle-after-flush-a (&optional buffer)
  "Write the prompt owed by BUFFER after its deferred output rendered."
  (let ((buffer (or buffer (current-buffer))))
    (when (and (buffer-live-p buffer)
               (buffer-local-value 'noema-agent-acp--prompt-owed buffer))
      (noema-agent-acp--settle-prompt buffer))))

(unless (advice-member-p #'noema-agent-acp--settle-after-flush-a
                         'noema-agent-render-flush)
  (advice-add 'noema-agent-render-flush :after
              #'noema-agent-acp--settle-after-flush-a))

;;;###autoload
(defun noema-agent-acp-focus-input (&optional buffer)
  "Show agent BUFFER in the Agent window with point at its input prompt."
  (interactive)
  (let ((buffer (noema-agent-acp-command-buffer buffer)))
    (with-current-buffer buffer
      (when (or (map-elt agent-shell--state :active-requests)
                (run-hook-with-args-until-success 'noema-agent-acp-busy-functions buffer))
        (user-error "Agent is still working; stop it with C-c C-x before editing")))
    ;; Showing renders deferred output first; the owed prompt follows it.
    (noema-agent-acp-show-buffer buffer)
    (with-current-buffer buffer
      ;; Also repair sessions that completed before this code was loaded.
      (noema-agent-acp-restore-prompt buffer))
    (when-let* ((window (get-buffer-window buffer (selected-frame))))
      (select-window window)
      (goto-char (point-max))
      (when (and (bound-and-true-p evil-local-mode) (fboundp 'evil-insert-state))
        (evil-insert-state))
      (set-window-point window (point))
      (recenter -3))
    buffer))

(defun noema-agent-acp--menu-items (buffer)
  "Return the easy-menu items managing agent BUFFER."
  (let ((named (and (buffer-local-value 'noema-agent-acp-session-name buffer) t)))
    `(["Show" (noema-agent-acp-show-buffer ,buffer)]
      ["Focus input" (noema-agent-acp-focus-input ,buffer)]
      ["Choose model..." (with-current-buffer ,buffer (call-interactively #'agent-shell-set-session-model))]
      ["Stop current work" (noema-agent-acp-stop ,buffer)]
      "--"
      ["Restart session" (noema-sessions-agent-restart ,buffer) :active ,named]
      ["Rename session..." (noema-sessions-agent-rename ,buffer) :active ,named]
      ["Fork session..." (noema-sessions-agent-fork ,buffer) :active ,named]
      ["Side chat beside it" (noema-sessions-agent-side-chat ,buffer) :active ,named]
      ["Jump to latest work block" (noema-sessions-agent-jump ,buffer) :active ,named]
      ["Archive session" (noema-sessions-agent-archive ,buffer) :active ,named]
      "--"
      ["Close tab" (noema-agent-acp-close ,buffer)]
      ["Close other tabs" (noema-agent-acp-close-others ,buffer)]
      ["Close retired tabs" (noema-agent-acp-close-retired ,buffer)]
      "--"
      ["Session list" (noema-sessions-agent-list ,buffer)]
      ["Help" noema-agent-acp-help])))

(defun noema-agent-acp-menu (&optional buffer event)
  "Pop up the session management menu of agent BUFFER at EVENT or point."
  (interactive (list nil last-nonmenu-event))
  (let ((buffer (noema-agent-acp-command-buffer buffer)))
    (popup-menu (easy-menu-create-menu (noema-agent-acp--tab-label buffer)
                                       (noema-agent-acp--menu-items buffer))
                (if (mouse-event-p event) event (posn-at-point)))))

(defun noema-agent-acp-help ()
  "Describe the Noema Agent window, its session tabs and their keys."
  (interactive)
  (with-help-window "*Noema Agent Help*"
    (princ
     (substitute-command-keys
      "Noema Agent window

Each tab is one live agent session of this project.  The buffer is the real
agent-shell: type at its prompt and press RET to send.

Mouse
  mouse-1 on a tab\tshow that session
  mouse-3 on a tab\tsession menu

\\<noema-agent-acp-tabs-mode-map>Sessions
  \\[noema-agent-acp-focus-input]\tjump to the input prompt
  \\[noema-agent-acp-switch-session]\tpick a session
  \\[noema-agent-acp-next-session] / \\[noema-agent-acp-previous-session]\tnext / previous tab
  \\[noema-agent-acp-stop]\tstop the current Run or turn
  \\[noema-sessions-agent-restart]\trestart the session and resume its conversation
  \\[noema-agent-acp-close]\tclose this tab (name and history remain)
  \\[noema-agent-acp-close-others]\tclose the other tabs
  \\[noema-sessions-agent-rename]\trename the session
  \\[noema-sessions-agent-fork]\tfork the session
  \\[noema-sessions-agent-side-chat]\tside chat: ask beside it without interrupting
  \\[noema-sessions-agent-archive]\tarchive the session and close its tab
  \\[noema-sessions-agent-jump]\tjump to its latest work block
  \\[noema-sessions-agent-list]\tsession list
  \\[noema-agent-acp-menu]\tsession menu
  ?\tthis help, outside the prompt input

\\<agent-shell-mode-map>Agent shell
  \\[agent-shell-interrupt]\tinterrupt the current turn
  \\[agent-shell-set-session-mode]\tsession mode
  \\[agent-shell-set-session-model]\tmodel
"))))

(defun noema-agent-acp-help-or-insert ()
  "Insert `?' in the prompt input; elsewhere describe the Agent window."
  (interactive)
  (let ((start (noema-agent-acp--input-start (current-buffer))))
    (if (and start (>= (point) start))
        (call-interactively #'self-insert-command)
      (noema-agent-acp-help))))

(defun noema-agent-acp--workspace-window (&optional frame)
  "Return FRAME's one Noema Agent window, if it is live."
  (seq-find (lambda (window)
              (window-parameter window 'noema-agent-workspace))
            (window-list (or frame (selected-frame)) 'nomini)))

(defun noema-agent-acp--right-pane-p (window)
  "Return non-nil when WINDOW already occupies a right-hand pane."
  (let ((edges (window-edges window)))
    (>= (car edges) (/ (frame-width (window-frame window)) 2))))

(defun noema-agent-acp--bottom-right-window (buffer frame)
  "Return a new bottom-right window in FRAME for agent BUFFER."
  (let* ((windows (seq-remove #'window-minibuffer-p (window-list frame 'nomini)))
         (right-pane (seq-find #'noema-agent-acp--right-pane-p
                               (sort (copy-sequence windows)
                                     (lambda (left right)
                                       (> (car (window-edges left))
                                          (car (window-edges right)))))))
         (base (or right-pane (selected-window)))
         (bottom (condition-case nil
                     (if (noema-agent-acp--right-pane-p base)
                         (split-window base nil 'below)
                       (let ((right (split-window base nil 'right)))
                         (split-window right nil 'below)))
                   (error nil))))
    (or bottom
        (display-buffer-in-side-window
         buffer
         `((side . right)
           (slot . 0)
           (window-width . 0.38)
           (window-parameters . ((noema-agent-workspace . t))))))))

(defun noema-agent-acp--display-workspace-buffer (buffer)
  "Show agent BUFFER itself in its frame's one bottom-right Agent window."
  (let* ((frame (selected-frame))
         (root (buffer-local-value 'noema-agent-acp-session-root buffer))
         (existing (noema-agent-acp--workspace-window frame)))
    ;; A previous version placed the window across the whole bottom edge.
    ;; Do not reuse that stale geometry; a reload repairs the layout.
    (when (and (window-live-p existing)
               (not (noema-agent-acp--right-pane-p existing)))
      (ignore-errors (delete-window existing))
      (setq existing nil))
    (let ((window (or existing
                      (noema-agent-acp--bottom-right-window buffer frame))))
      (unless (window-live-p window)
        (user-error "Unable to create the Noema Agent window"))
      (set-window-dedicated-p window nil)
      (set-window-buffer window buffer)
      (set-window-parameter window 'noema-agent-workspace t)
      (set-window-parameter window 'noema-agent-workspace-root root)
      (window-preserve-size window nil t)
      ;; Sessions are tabs of this one window; retire any other window that
      ;; still shows an agent buffer.
      (dolist (other (window-list frame 'nomini))
        (when (and (not (eq other window))
                   (noema-agent-acp-agent-buffer-p (window-buffer other)))
          (ignore-errors (quit-window nil other))))
      (select-window window)
      window)))

(defun noema-agent-acp--retire-transcript-workspace ()
  "Replace transcript-copy Agent Workspace buffers left by an older load.
Every live agent buffer becomes a tab, and each window that showed an old
workspace shows a real agent buffer of the same project instead."
  (dolist (buffer (buffer-list))
    (when (noema-agent-acp-agent-buffer-p buffer)
      (noema-agent-acp--install-workspace-tabs buffer)))
  (dolist (buffer (buffer-list))
    (when (string-prefix-p "*Noema Agent Workspace · " (buffer-name buffer))
      (let* ((root (ignore-errors
                     (buffer-local-value 'noema-agent-acp-workspace-root buffer)))
             (timer (ignore-errors
                      (buffer-local-value 'noema-agent-acp-workspace-refresh-timer buffer)))
             (agent (car (noema-agent-acp--project-buffers root))))
        (when (timerp timer)
          (cancel-timer timer))
        (with-current-buffer buffer
          (remove-hook 'kill-buffer-hook 'noema-agent-acp--workspace-killed t))
        (dolist (window (get-buffer-window-list buffer nil t))
          (if agent
              (set-window-buffer window agent)
            (ignore-errors (delete-window window))))
        (kill-buffer buffer)))))

(defun noema-agent-acp-touch (buffer)
  "Record recent use of Noema agent BUFFER."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq-local noema-agent-acp-last-used-at (float-time)))))

(defun noema-agent-acp-trim-buffer (buffer max-bytes)
  "Trim durable old output in BUFFER to approximately MAX-BYTES.

Call this only after the corresponding Run output is durable.  The current
input prompt and its editable tail are retained."
  (when (and (buffer-live-p buffer) (> max-bytes 0))
    (with-current-buffer buffer
      (when (and (derived-mode-p 'agent-shell-mode)
                 (> (string-bytes (buffer-substring-no-properties
                                   (point-min) (point-max))) max-bytes))
        (let ((low 0)
              (high (buffer-size)))
          (while (< low high)
            (let ((middle (/ (+ low high 1) 2)))
              (if (<= (string-bytes
                       (buffer-substring-no-properties
                        (- (point-max) middle) (point-max)))
                      max-bytes)
                  (setq low middle)
                (setq high (1- middle)))))
          (let ((cut (- (point-max) low)))
          (goto-char cut)
          (forward-line 1)
          (let ((inhibit-read-only t)
                (buffer-undo-list t))
              (delete-region (point-min) (point)))))))))

(defun noema-agent-acp-mark-session-buffer (buffer name agent directory)
  "Mark BUFFER as the private ACP transport for session NAME in DIRECTORY.
D-033: physical ACP buffers are hidden implementation details rendered into
one project Agent Workspace.  Stable local identity lets the session manager
and OutputArea find the exact transport without creating another UI buffer.
D-035: another live buffer still holding NAME in the same project served an
older physical session; it gives the name up so lookups stay unambiguous."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (noema-agent-acp--install-workspace-tabs buffer)
      (noema-agent-acp-touch buffer)
      (noema-agent-acp-hide-client-stderr buffer)
      (when directory
        (setq-local noema-agent-acp-session-root
                    (file-name-as-directory (expand-file-name directory))))
      (when (and (stringp name) (not (string-empty-p name)))
        (let ((root noema-agent-acp-session-root))
          (dolist (other (buffer-list))
            (when (and (not (eq other buffer))
                       (noema-agent-acp-agent-buffer-p other)
                       (equal (buffer-local-value 'noema-agent-acp-session-name other) name)
                       (equal (buffer-local-value 'noema-agent-acp-session-root other) root))
              (with-current-buffer other
                (setq-local noema-agent-acp-session-name nil)
                (when (boundp 'noema-agent-promote--session-id)
                  (setq-local noema-agent-promote--session-id nil))
                (unless (string-suffix-p " (retired)" (buffer-name))
                  (rename-buffer (concat (buffer-name) " (retired)") t))
                (noema-agent-acp--sync-shell-buffer-name other))
              ;; An idle retired buffer only duplicates a tab; its conversation
              ;; stays in the Run history.  A busy one stays until it finishes.
              (let ((retired other))
                (run-at-time 0 nil
                             (lambda ()
                               (when (and (buffer-live-p retired)
                                          (not (noema-agent-acp-busy-p retired)))
                                 (noema-agent-acp-kill retired))))))))
        (setq-local noema-agent-acp-session-name name
                    noema-agent-acp-session-agent agent)
        (let ((wanted (format " *Noema Agent · %s · %s @ %s*"
                              name (or agent "agent")
                              (file-name-nondirectory
                               (directory-file-name (or noema-agent-acp-session-root
                                                        default-directory))))))
          (unless (string-prefix-p wanted (buffer-name))
            (rename-buffer wanted t)))
        (noema-agent-acp--sync-shell-buffer-name buffer)))
    (noema-agent-acp--refresh-tabs)
    buffer))

(defun noema-agent-acp-session-buffer (name root)
  "Return the live agent buffer serving session NAME in project ROOT."
  (let ((root (and root (file-name-as-directory (expand-file-name root)))))
    (seq-find (lambda (buffer)
                (and (noema-agent-acp-agent-buffer-p buffer)
                     (equal (buffer-local-value 'noema-agent-acp-session-name buffer) name)
                     (or (null root)
                         (equal (buffer-local-value 'noema-agent-acp-session-root buffer) root))))
              (buffer-list))))


;;; ── One project-wide registry of live agent sessions ──────────────────────
;;
;; A `.noema' Run, the popup pool, `noema-agent-start' and a bare
;; `M-x agent-shell' all produce the same kind of resource, so they are all
;; registered the same way: one project root, one session name, one origin.
;; Buffer-local identity stays the source of truth — this adds the single
;; entry point and the merged view over it.  Registration only ever reads the
;; project: opening an agent never creates a `noema.toml'.

(defgroup noema-agent-session nil
  "Noema's project-wide registry of live agent sessions."
  :group 'applications)

(defcustom noema-agent-acp-adopt-foreign-sessions t
  "Whether agent-shell buffers Noema did not start join its session registry.
When non-nil, a bare `M-x agent-shell' session is given a project root and a
session name like every other session, so one view lists them all.  Set this
to nil to leave such buffers exactly as upstream created them."
  :type 'boolean
  :group 'noema-agent-session)

(declare-function noema-project-root "noema-research" (&optional directory))
(declare-function noema-project-client-path "noema-research" (path))
(declare-function noema-project-workspace "noema-research" (root))
(declare-function noema-agent-promote-bind-session-name "noema-agent-promote"
                  (buffer name &optional callback))
(declare-function projectile-project-root "projectile" (&optional directory))
(defvar noema-agent-promote--session-id)

(defun noema-agent-acp-project-root (&optional directory)
  "Return the project root agent sessions of DIRECTORY are registered under.
The nearest `noema.toml' wins, then the ordinary project of that directory,
then the directory itself.  This is a query: it never enables a project."
  (let ((directory (file-name-as-directory
                    (expand-file-name (or directory default-directory)))))
    (noema-agent-acp--workspace-root
     (or (and (require 'noema-research nil t) (noema-project-root directory))
         (and (fboundp 'projectile-project-root)
              (ignore-errors (projectile-project-root directory)))
         (when-let* ((project (project-current nil directory)))
           (project-root project))
         directory))))

(defun noema-agent-acp--claimed-names (root)
  "Return the session names live agent buffers of ROOT already hold."
  (delq nil (mapcar (lambda (buffer)
                      (and (noema-agent-acp-agent-buffer-p buffer)
                           (equal (buffer-local-value 'noema-agent-acp-session-root buffer)
                                  root)
                           (buffer-local-value 'noema-agent-acp-session-name buffer)))
                    (buffer-list))))

(defun noema-agent-acp--unique-name (base root)
  "Return BASE, or BASE plus a counter, unclaimed by a live session of ROOT.
The coordinator name \"pi\" is reserved and is never generated here."
  (let ((taken (cons "pi" (noema-agent-acp--claimed-names root)))
        (candidate base)
        (index 1))
    (while (member candidate taken)
      (setq index (1+ index)
            candidate (format "%s-%d" base index)))
    candidate))

(defun noema-agent-acp--buffer-agent-id (buffer)
  "Return the agent id agent-shell configured BUFFER with, as a string."
  (let ((identifier (noema-agent-acp-state-value buffer '(:agent-config :identifier))))
    (cond ((stringp identifier) identifier)
          ((and identifier (symbolp identifier)) (symbol-name identifier)))))

(defun noema-agent-acp--register-durable (buffer name root)
  "Bind NAME to BUFFER's conversation in ROOT's durable registry, if it has one.
Only a directory that already is a Noema project has one.  The work waits for
ACP initialization and then runs asynchronously; failing to reach the host
leaves the session registered on the Emacs side alone."
  (when (and (require 'noema-research nil t)
             (noema-project-root root)
             (require 'noema-agent-promote nil t))
    (if (noema-agent-acp-state-value buffer '(:session :id))
        (noema-agent-promote-bind-session-name buffer name)
      (let (subscription)
        (setq subscription
              (noema-agent-acp-subscribe
               :buffer buffer :event 'init-finished
               :callback
               (lambda (_event)
                 (ignore-errors
                   (noema-agent-acp-unsubscribe :buffer buffer :subscription subscription))
                 (when (buffer-live-p buffer)
                   (noema-agent-promote-bind-session-name buffer name)))))))))

(cl-defun noema-agent-acp-adopt (buffer &key agent origin name root)
  "Register agent BUFFER as a named session of its project, and return it.
ORIGIN records which entry point started it.  NAME defaults to a unique local
name built from ORIGIN and the agent id; ROOT defaults to
`noema-agent-acp-project-root' of the buffer's own directory.

When ROOT already is a Noema project and its host is running, the session is
also promoted and bound in the durable registry, asynchronously."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (let* ((origin (or origin
                       (buffer-local-value 'noema-agent-acp-session-origin buffer)
                       'manual))
           (root (noema-agent-acp--workspace-root
                  (or root
                      (noema-agent-acp-project-root
                       (or (buffer-local-value 'noema-agent-acp-session-root buffer)
                           (buffer-local-value 'default-directory buffer))))))
           (agent (or (and agent (format "%s" agent))
                      (buffer-local-value 'noema-agent-acp-session-agent buffer)
                      (noema-agent-acp--buffer-agent-id buffer)
                      "agent"))
           (name (or name
                     (buffer-local-value 'noema-agent-acp-session-name buffer)
                     (noema-agent-acp--unique-name (format "%s/%s" origin agent) root))))
      (with-current-buffer buffer
        (setq-local noema-agent-acp-session-origin origin))
      (noema-agent-acp-mark-session-buffer buffer name agent root)
      (unless (memq origin noema-agent-acp-ephemeral-origins)
        (noema-agent-acp--register-durable buffer name root))
      buffer)))

(defun noema-agent-acp-sessions (&optional root)
  "Return one plist per live agent session, restricted to ROOT when given.
Keys are :buffer, :name, :agent, :origin, :root, :native-session-id,
:session-id, :busy and :last-used.  Popup sessions are included; they are
presented in their own window but are the same managed resource."
  (let ((root (and root (noema-agent-acp--workspace-root root))))
    (delq nil
          (mapcar
           (lambda (buffer)
             (when (and (noema-agent-acp-agent-buffer-p buffer)
                        (or (null root)
                            (equal (buffer-local-value 'noema-agent-acp-session-root buffer)
                                   root)))
               (list :buffer buffer
                     :name (buffer-local-value 'noema-agent-acp-session-name buffer)
                     :agent (buffer-local-value 'noema-agent-acp-session-agent buffer)
                     :origin (buffer-local-value 'noema-agent-acp-session-origin buffer)
                     :root (buffer-local-value 'noema-agent-acp-session-root buffer)
                     :native-session-id (noema-agent-acp-state-value buffer '(:session :id))
                     :session-id (and (boundp 'noema-agent-promote--session-id)
                                      (buffer-local-value 'noema-agent-promote--session-id buffer))
                     :busy (and (noema-agent-acp-busy-p buffer) t)
                     :last-used (buffer-local-value 'noema-agent-acp-last-used-at buffer))))
           (buffer-list)))))

(defun noema-agent-acp--adopt-foreign-h ()
  "Register an agent-shell session Noema itself did not start.
Every Noema entry point sets `noema-agent-acp-session-origin' as it starts the
buffer, so a buffer without one came from upstream.  The work waits one
command, because upstream returns the buffer before its caller can name it."
  (when noema-agent-acp-adopt-foreign-sessions
    (let ((buffer (current-buffer)))
      (run-at-time
       0 nil
       (lambda ()
         (when (and (buffer-live-p buffer)
                    (noema-agent-acp-agent-buffer-p buffer)
                    (not (buffer-local-value 'noema-agent-acp-session-origin buffer))
                    (not (buffer-local-value 'noema-agent-acp-session-name buffer)))
           (condition-case error-object
               (noema-agent-acp-adopt buffer :origin 'foreign)
             (error (message "Noema could not register this agent session: %s"
                             (error-message-string error-object))))))))))

(add-hook 'agent-shell-mode-hook #'noema-agent-acp--adopt-foreign-h)

(defun noema-agent-acp-resolve-config (identifier)
  "Resolve embedded agent-shell configuration IDENTIFIER."
  (copy-tree (agent-shell--resolve-config-designator identifier)))

(defun noema-agent-acp-config-for (agent)
  "Resolve Noema AGENT id to an agent-shell configuration, or nil."
  (let ((identifier (pcase (downcase (format "%s" (or agent "codex")))
                      ((or "claude" "claude-code") 'claude-code)
                      ((or "open-code" "opencode") 'opencode)
                      (name (intern name)))))
    (ignore-errors (noema-agent-acp-resolve-config identifier))))

(defvar agent-shell-pi-environment)
(declare-function agent-shell-pi-make-client "agent-shell-pi" (&rest args))

(defun noema-agent-acp-pi-config (environment)
  "Return a Pi agent-shell configuration whose client runs with ENVIRONMENT.
ENVIRONMENT is a list of \"NAME=VALUE\" strings.  They are added every time
agent-shell builds the client, so a restart or resume keeps them (D-035).
Return nil when Pi is not available."
  (require 'agent-shell-pi nil t)
  (when-let* ((config (noema-agent-acp-config-for "pi"))
              ((fboundp 'agent-shell-pi-make-client)))
    (setf (alist-get :client-maker config)
          (lambda (buffer)
            (let ((agent-shell-pi-environment
                   (append environment (bound-and-true-p agent-shell-pi-environment))))
              (agent-shell-pi-make-client :buffer buffer))))
    config))

(defun noema-agent-acp-known-agents ()
  "Return agent ids for work-directive completion.
Resolution remains inside this adapter so JuText never depends on
agent-shell's private configuration representation."
  (let ((candidates '(("codex" . codex)
                      ("claude" . claude-code)
                      ("opencode" . open-code)
                      ("pi" . pi)))
        available)
    (dolist (candidate candidates (or (nreverse available)
                                      (mapcar #'car candidates)))
      (when (ignore-errors
              (noema-agent-acp-resolve-config (cdr candidate)))
        (push (car candidate) available)))))

(defun noema-agent-acp-hide-client-stderr (buffer)
  "Hide the stderr buffer of agent BUFFER's ACP client process.
acp.el names it `acp-client-stderr(...)' without a leading space, so it
would appear in buffer lists beside the hidden D-033 agent buffers.  Emacs
attaches that buffer to a pipe process named after the client process.
Renaming keeps acp.el's cleanup working, since it holds the buffer object.
Return the stderr buffer when it was renamed."
  (when-let* (((noema-agent-acp-agent-buffer-p buffer))
              (process (map-elt (map-elt (noema-agent-acp--state buffer) :client) :process))
              ((processp process))
              (pipe (get-process (concat (process-name process) " stderr")))
              (stderr (process-buffer pipe))
              ((buffer-live-p stderr))
              ((not (string-prefix-p " " (buffer-name stderr)))))
    (with-current-buffer stderr
      (rename-buffer (concat " " (buffer-name)) t))
    stderr))

(defvar noema-agent-acp-process-directory-function nil
  "Function mapping a session directory to its agent process directory.
It receives an expanded directory and returns the directory the agent process
starts in, or nil when no process can run there.  A host with its own file
routing, such as a logical /fs: layer, sets this so Noema and a bare
`agent-shell' agree on placement.  nil uses Emacs's own file handlers.")

(defun noema-agent-acp--default-process-directory (directory)
  "Return DIRECTORY for an agent process through Emacs file handlers.
A logical /fs: name becomes its client-accessible spelling when there is one;
a remote name stays, and `make-process' routes the agent to that host."
  (let ((client (and (string-prefix-p "/fs:" directory)
                     (fboundp 'remote-client-file-name)
                     (remote-client-file-name directory))))
    (cond (client client)
          ((file-remote-p directory) directory)
          ((not (string-prefix-p "/fs:" directory)) directory))))

(defvar noema-agent-acp-agent-file-function nil
  "Function mapping (FILE SESSION) to the path the SESSION's agent opens.
FILE is an expanded Emacs file name; SESSION is an agent buffer or nil for an
agent on this machine.  Return nil when that agent's machine cannot reach
FILE.  A host with its own file routing sets this alongside
`noema-agent-acp-process-directory-function'.  nil uses Emacs's own handlers.")

(defun noema-agent-acp--default-agent-file (file session)
  "Return FILE as SESSION's agent sees it, through Emacs file handlers."
  (let ((agent-host (and session
                         (file-remote-p
                          (buffer-local-value 'default-directory session))))
        (client (if (string-prefix-p "/fs:" file)
                    (and (fboundp 'remote-client-file-name)
                         (remote-client-file-name file))
                  file)))
    (cond ((and agent-host (equal agent-host (file-remote-p file)))
           (file-local-name file))
          ((and (not agent-host) client (not (file-remote-p client))
                (not (string-prefix-p "/fs:" client)))
           client))))

(defun noema-agent-acp-agent-file (file &optional session)
  "Return FILE as the path the agent of SESSION opens, or nil.
SESSION nil means an agent running on this machine.  nil means the agent's
machine cannot reach FILE, such as a local file for an agent on a server."
  (funcall (or noema-agent-acp-agent-file-function
               #'noema-agent-acp--default-agent-file)
           (expand-file-name file) session))

(defun noema-agent-acp--client-directory (directory)
  "Return the directory an agent process for DIRECTORY starts in.
Never hand an unresolved identity to a process: signal when neither this
machine nor a routed host can run the agent there."
  (let* ((expanded (expand-file-name directory))
         (process (funcall (or noema-agent-acp-process-directory-function
                               #'noema-agent-acp--default-process-directory)
                           expanded)))
    (unless process
      (user-error "No machine can run an agent in: %s" directory))
    (unless (condition-case error-object
                (file-directory-p process)
              (error (user-error "Agent directory is unreachable: %s (%s)"
                                 process (error-message-string error-object))))
      (user-error "Agent directory does not exist: %s" process))
    (file-name-as-directory process)))

(cl-defun noema-agent-acp-start (&key config directory session-id fork-session-id focus
                                      (origin 'manual) (render-policy 'visible))
  "Start CONFIG in DIRECTORY, optionally resuming or forking a native session.
The buffer is displayed only when FOCUS is non-nil (D-033): a document Run
never pops its agent buffer; the person opens it on purpose.

ORIGIN records which entry point owns the session, so the project-wide
registry can list it and `noema-agent-acp--adopt-foreign-h' leaves it alone.

Noema disables agent-shell's duplicate Markdown transcript and defaults to a
visible-only render policy.  Neither setting affects ACP transport or events."
  (let* ((directory (noema-agent-acp--client-directory directory))
        (default-directory directory)
        ;; Project discovery can return a logical /fs: root again. Pin the
        ;; actual process directory through the asynchronous ACP handshake.
        (agent-shell-cwd-function (lambda () directory))
        (agent-shell-transcript-file-path-function nil)
        (noema-agent-render-policy render-policy))
    (let ((buffer
           (agent-shell--start :config config :no-focus t :new-session t
                               :session-strategy 'new :session-id session-id
                               :fork-session-id fork-session-id)))
      (with-current-buffer buffer
        (setq-local agent-shell-transcript-file-path-function nil
                    agent-shell-cwd-function (lambda () directory)
                    agent-shell--transcript-file nil
                    ;; Interrupting a Noema session stops at once; the Run
                    ;; record and the conversation both survive it.
                    agent-shell-confirm-interrupt nil
                    noema-agent-render-policy render-policy
                    noema-agent-acp-session-origin origin
                    noema-agent-acp-session-root
                    (file-name-as-directory (expand-file-name directory)))
        (noema-agent-acp--install-workspace-tabs buffer))
      ;; acp.el starts the client process for the asynchronous handshake.
      (noema-agent-acp-subscribe
       :buffer buffer :event 'init-handshake
       :callback (lambda (_event) (noema-agent-acp-hide-client-stderr buffer)))
      (noema-agent-acp-hide-client-stderr buffer)
      (when focus
        (noema-agent-acp-show-buffer buffer))
      buffer)))

(cl-defun noema-agent-acp-subscribe (&key buffer event callback)
  "Subscribe CALLBACK to EVENT in agent-shell BUFFER."
  (agent-shell-subscribe-to :shell-buffer buffer :event event :on-event callback))

(cl-defun noema-agent-acp-unsubscribe (&key buffer subscription)
  "Remove SUBSCRIPTION from agent-shell BUFFER when both are still live."
  (when (and subscription (buffer-live-p buffer))
    (with-current-buffer buffer
      (when (derived-mode-p 'agent-shell-mode)
        (agent-shell-unsubscribe :subscription subscription)))))

(defun noema-agent-acp-show-buffer (buffer)
  "Show agent BUFFER in its project Agent window and hydrate deferred output."
  (unless (noema-agent-acp-agent-buffer-p buffer)
    (user-error "No live Noema agent buffer"))
  (if-let* ((display (buffer-local-value 'noema-agent-acp-display-buffer-function buffer)))
      (funcall display buffer)
    (noema-agent-acp--install-workspace-tabs buffer)
    (noema-agent-acp--display-workspace-buffer buffer))
  (noema-agent-acp-touch buffer)
  (noema-agent-render-flush buffer)
  buffer)

(defun noema-agent-acp--display-buffer-a (orig buffer &rest args)
  "Route every interactive agent-shell display through the shared workspace.

The Noema worker path already calls `noema-agent-acp-show-buffer', but direct
Codex/Claude/OpenCode/Pi and Magent entry points call upstream
`agent-shell--display-buffer' themselves.  Without this narrow advice those
entry points recreate the per-agent visible buffers that the project
workspace is meant to replace."
  (if (noema-agent-acp-agent-buffer-p buffer)
      (progn
        (with-current-buffer buffer
          (unless noema-agent-acp-session-root
            (setq-local noema-agent-acp-session-root
                        (file-name-as-directory (expand-file-name default-directory))))
          (unless noema-agent-acp-session-agent
            (setq-local noema-agent-acp-session-agent
                        (format "%s"
                                (or (map-nested-elt agent-shell--state
                                                      '(:agent-config :identifier))
                                    "agent"))))
          (noema-agent-acp--install-workspace-tabs buffer))
        (noema-agent-acp-show-buffer buffer))
    (apply orig buffer args)))

(unless (advice-member-p #'noema-agent-acp--display-buffer-a
                         'agent-shell--display-buffer)
  (advice-add 'agent-shell--display-buffer :around
              #'noema-agent-acp--display-buffer-a))

(defun noema-agent-acp-set-permission-responder (buffer responder)
  "Install RESPONDER for structured permission requests in BUFFER."
  (with-current-buffer buffer
    (setq-local agent-shell-permission-responder-function responder)))

(defun noema-agent-acp-draft (buffer text)
  "Put TEXT in BUFFER's native input for review; do not submit it."
  (agent-shell-insert :text text :submit nil :shell-buffer buffer))

(defvar-local noema-agent-acp--prompt-receipt nil
  "Completion fact for the exact Noema prompt, independent of UI callbacks.")

(defun noema-agent-acp-prompt-receipt (buffer run-id)
  "Return BUFFER's completion receipt only when it belongs to RUN-ID.
No buffer text, elapsed time or absence of activity is evidence of success."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (equal (plist-get noema-agent-acp--prompt-receipt :run-id) run-id)
        noema-agent-acp--prompt-receipt))))

(defun noema-agent-acp--display-submitted-content (state content run-id)
  "Show Noema's submitted CONTENT using the upstream conversation renderer.
ACP servers need not echo live user messages.  This display is separate
from transport and preserves any draft at the native input prompt."
  (when (seq-some (lambda (block) (equal (map-elt block 'type) "text")) content)
    (agent-shell--update-fragment
     :state state :namespace-id (format "noema-run-%s" (or run-id (map-elt state :request-count)))
     :block-id "submitted-input" :label-left "You"
     :body (mapconcat
            (lambda (block)
              (if (equal (map-elt block 'type) "text")
                  (or (map-elt block 'text) "")
                (format "[Context: %s]"
                        (or (map-nested-elt block '(resource uri))
                            ;; A `resource_link' carries its uri at top level.
                            (map-elt block 'uri)
                            (map-elt block 'type)))))
            content "\n\n")
     :expanded t :above-last-prompt t)))

(defun noema-agent-acp--finish-prompt (buffer receipt)
  "Restore native input for RECEIPT, unless BUFFER has begun another turn."
  (when (and (noema-agent-acp-agent-buffer-p buffer)
             (eq receipt (buffer-local-value 'noema-agent-acp--prompt-receipt buffer)))
    (with-current-buffer buffer
      (unwind-protect
          (agent-shell--update-fragment
           :state agent-shell--state
           :namespace-id (format "noema-run-%s" (or (plist-get receipt :run-id)
                                                   (map-elt agent-shell--state :request-count)))
           :block-id "turn-status"
           :label-left (cond ((eq (plist-get receipt :status) 'failed) "Failed")
                             ((equal (map-elt (plist-get receipt :response) 'stopReason) "cancelled")
                              "Stopped")
                             (t "Completed"))
           :above-last-prompt (and (not noema-agent-render--pending)
                                   (noema-agent-acp--live-input-p)))
        (noema-agent-acp-restore-prompt buffer)))))

(cl-defun noema-agent-acp-prompt (&key buffer content run-id on-success on-failure)
  "Send structured CONTENT through BUFFER's initialized ACP session."
  (with-current-buffer buffer
    ;; A new turn is running; do not write a prompt into its output.
    (setq-local noema-agent-acp--prompt-owed nil)
    (let ((state agent-shell--state)
          (receipt (list :run-id run-id :status 'pending :response nil :error nil)))
      (setq-local noema-agent-acp--prompt-receipt receipt)
      ;; `agent-shell--handle' normally advances the turn before dispatch.
      ;; Frozen structured prompts bypass that input parser, not turn identity.
      (shell-maker--increment-request-id)
      (setf (alist-get :request-count state) (shell-maker--current-request-id)
            (alist-get :last-entry-type state) nil
            (alist-get :last-activity-time state) (current-time))
      (setq agent-shell--state state)
      ;; Keep this before transport so even immediately streamed replies follow
      ;; their input.  The hidden renderer queues both in the same FIFO.
      (condition-case err
          (noema-agent-acp--display-submitted-content state content run-id)
        (error (message "Noema input display: %s" (error-message-string err))))
      (agent-shell--send-request
       :state state :client (map-elt state :client)
       :request (acp-make-session-prompt-request
                 :session-id (map-nested-elt state '(:session :id))
                 :prompt content)
       :buffer buffer
       :on-success (lambda (response)
                     ;; Record the protocol fact before any consumer/UI runs.
                     (setf (plist-get receipt :status) 'completed
                           (plist-get receipt :response) response)
                     (unwind-protect
                         (when on-success (funcall on-success response))
                       (noema-agent-acp--finish-prompt buffer receipt)))
       :on-failure (lambda (error raw)
                     (setf (plist-get receipt :status) 'failed
                           (plist-get receipt :error) raw)
                     (unwind-protect
                         (when on-failure (funcall on-failure error raw))
                       (noema-agent-acp--finish-prompt buffer receipt)))))))

(defun noema-agent-acp-file-uri (file &optional session)
  "Return FILE as the `file://' uri agent-shell would put in a content block.
With SESSION, the path is the one that session's agent opens (see
`noema-agent-acp-agent-file'), so a remote agent gets its own machine's path.
Otherwise path resolution honours `agent-shell-path-resolver-function'."
  (concat "file://"
          (or (and session (noema-agent-acp-agent-file file session))
              (agent-shell--resolve-path (expand-file-name file)))))

(defun noema-agent-acp-file-metadata (file)
  "Return (:mime-type MIME :size BYTES) for FILE, or nil when unreadable.
Only metadata is read; the file contents are never loaded."
  (when-let* ((file (expand-file-name file))
              ((file-readable-p file))
              (meta (ignore-errors
                      (agent-shell--read-file-content :file-path file :shallow t))))
    (list :mime-type (map-elt meta :mime-type)
          :size (map-elt meta :size))))

(defun noema-agent-acp-enqueue (buffer text)
  "Queue TEXT as BUFFER's next turn through agent-shell's pending queue.
Used when a session is mid-turn: upstream sends the queued prompt itself once
the running turn finishes."
  (with-current-buffer buffer
    (agent-shell--prompt-queue-enqueue :prompt text)))

(defun noema-agent-acp-interrupt (buffer &optional force)
  "Interrupt the active request in BUFFER; FORCE skips confirmation."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (with-current-buffer buffer (agent-shell-interrupt force))))

(defun noema-agent-acp-shutdown (buffer)
  "Shut down BUFFER's physical ACP client."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (with-current-buffer buffer (agent-shell--shutdown))))

(defun noema-agent-acp-available-modes (buffer)
  "Return BUFFER's native ACP session modes."
  (with-current-buffer buffer
    (when (fboundp 'agent-shell--get-available-modes)
      (agent-shell--get-available-modes agent-shell--state))))

(cl-defun noema-agent-acp-set-mode (buffer mode-id on-success on-failure)
  "Set BUFFER to native MODE-ID and invoke completion callbacks."
  (with-current-buffer buffer
    (agent-shell--config-option-set-mode-id
     :mode-id mode-id :on-success on-success :on-failure on-failure)))

;;;###autoload
(defun noema-agent-start (&optional agent)
  "Open an embedded structured AGENT session.
Interactively select Magent, Codex, Claude Code, OpenCode or Pi.

The session joins its project's registry like a Run's or the popup pool's,
so it can be listed, switched to and given buffer context by name."
  (interactive
   (list (intern
          (completing-read "Noema agent: "
                           '("magent" "codex" "claude" "opencode" "pi")
                           nil t nil nil "magent"))))
  (let* ((agent (or agent 'magent))
         (root (noema-agent-acp-project-root))
         (config (and (memq agent '(codex claude opencode))
                      (noema-agent-acp-config-for agent)))
         (buffer
          (pcase agent
            ;; Magent and Pi own extra client setup in their own starters.
            ('magent
             (require 'magent-agent-shell)
             (magent-start))
            ('pi
             (require 'agent-shell-pi)
             (agent-shell-pi-start-agent))
            ((or 'codex 'claude 'opencode)
             (unless config
               (user-error "No agent-shell configuration for %s" agent))
             (noema-agent-acp-start :config config
                                    :directory (if (and root (require 'noema-research nil t))
                                                   (noema-project-workspace root)
                                                 root)
                                    :origin 'manual :focus t))
            (_ (user-error "Unsupported Noema agent: %s" agent)))))
    (when (noema-agent-acp-agent-buffer-p buffer)
      (noema-agent-acp-adopt buffer :agent agent :origin 'manual
                             :root (and (memq agent '(codex claude opencode)) root)))
    buffer))

(noema-agent-acp--retire-transcript-workspace)

(provide 'noema-agent-acp)
;;; noema-agent-acp.el ends here
