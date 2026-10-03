;;; noema-sessions.el --- Named agent sessions: list, switch, manage -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; D-033.  Physical agent buffers are internal tabs in one project Agent
;; workspace and a Run never displays one, so this is also how a person finds
;; and manages conversations without opening another workspace pane.  Rows are
;; D-031 session names of one project; the scope is either the whole project
;; or the `.noema' file the list was opened from (names its Runs used and names
;; its `@@session' lines pin).  Every action is a deterministic registry
;; operation; nothing here asks a model.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-research)
(require 'noema-agent-acp)
(require 'noema-agent-promote)
(require 'noema-agent-worktree)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--api-call-sync "init-aaronnote" (channel args &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function noema-pi-router-open "noema-pi-router" (&optional directory))
(declare-function noema-research-pin-session "noema-research-mode" (name))
(declare-function noema-research-rename-session-directives "noema-research-mode" (old new))
(declare-function noema-research-goto-cell "noema-research-mode" (id))
(defvar noema-research--document)
(defvar my/noema--ready)

(defvar-local noema-sessions--root nil "Project root listed in this buffer.")
(defvar-local noema-sessions--scope 'project "Either `project' or `file'.")
(defvar-local noema-sessions--source nil "JuText buffer the list was opened from.")
(defvar-local noema-sessions--names nil "Session name objects currently shown.")
(defvar-local noema-sessions--local nil
  "Live agent sessions of this project with no durable registry record.
A popup, manual or foreign session is registered on the Emacs side even when
its project is not a Noema project, so it is listed here beside the rest.")

(defun noema-sessions--get (object key &optional default)
  "Read string KEY from JSON-like OBJECT, returning DEFAULT when absent."
  (let ((value (cond ((hash-table-p object) (gethash key object default))
                     ((and (listp object) (consp (car-safe object)))
                      (let ((cell (or (assoc key object) (assq (intern key) object))))
                        (if cell (cdr cell) default)))
                     (t default))))
    (if (memq value '(:null :false)) default value)))

(defun noema-sessions--string (object key)
  "Read a non-empty string KEY from OBJECT, or nil."
  (let ((value (noema-sessions--get object key)))
    (and (stringp value) (not (string-empty-p value)) value)))

(defun noema-sessions--list (value)
  "Return JSON array VALUE as a list."
  (cond ((vectorp value) (append value nil))
        ((listp value) value)))

(defun noema-sessions--project-root (&optional directory)
  "Return the project root (nearest `noema.toml') of DIRECTORY."
  (noema-project-scope (or directory default-directory)))

(defun noema-sessions--api (channel body callback)
  "Call Noema CHANNEL with BODY asynchronously; CALLBACK gets (RESULT ERROR)."
  (unless (fboundp 'my/noema-api-call)
    (user-error "Noema host integration is unavailable"))
  (my/noema-api-call channel (vector body) callback 30))

(defun noema-sessions--ensure-host (callback)
  "Call CALLBACK once the Noema host is ready."
  (if (fboundp 'my/noema--ensure-server)
      (my/noema--ensure-server callback)
    (funcall callback)))

(defun noema-sessions--error (error-object)
  "Return a readable message from ERROR-OBJECT."
  (or (noema-sessions--string error-object "message")
      (and (stringp error-object) error-object)
      "request failed"))

(defun noema-sessions--live-buffer (entry root)
  "Return the live agent buffer of session ENTRY in ROOT, or nil."
  (let ((name (noema-sessions--string entry "name"))
        (session-id (noema-sessions--string entry "sessionId")))
    (or (and name
             (let ((buffer (noema-agent-acp-session-buffer name root)))
               (and (noema-sessions--execution-live-p buffer) buffer)))
        (and session-id
             (seq-find (lambda (buffer)
                         (and (noema-sessions--execution-live-p buffer)
                              (equal (buffer-local-value 'noema-agent-acp-session-root buffer)
                                     (file-name-as-directory (expand-file-name root)))
                              (local-variable-p 'noema-agent-promote--session-id buffer)
                              (equal (buffer-local-value 'noema-agent-promote--session-id buffer)
                                     session-id)))
                       (buffer-list))))))

(defun noema-sessions--execution-live-p (buffer)
  "Return non-nil if BUFFER has an ACP client process still running."
  (and (noema-agent-acp-agent-buffer-p buffer)
       (let ((process (noema-agent-acp-state-value buffer '(:client :process))))
         (and (processp process) (process-live-p process)))))

(defun noema-sessions--local-sessions (names root)
  "Return live agent sessions of ROOT that no durable entry in NAMES covers."
  (let ((covered (make-hash-table :test #'eq)))
    (dolist (entry names)
      (when-let* ((buffer (noema-sessions--live-buffer entry root)))
        (puthash buffer t covered)))
    (seq-remove (lambda (session) (gethash (plist-get session :buffer) covered))
                (noema-agent-acp-sessions root))))

(defun noema-sessions--local-label (session)
  "Return the row id and display name of local SESSION."
  (or (plist-get session :name)
      (string-trim (buffer-name (plist-get session :buffer)))))

(defun noema-sessions--local-row (session)
  "Return the `tabulated-list-entries' row for local SESSION."
  (let ((name (noema-sessions--local-label session)))
    (list name
          (vector (or (noema-agent-acp-attention-mark (plist-get session :buffer)) "")
                  name
                  (or (plist-get session :agent) "")
                  "local"
                  ""
                  (noema-sessions--buffer-cell (plist-get session :buffer))
                  ""
                  (format "%s" (or (plist-get session :origin) ""))
                  ""))))

(defcustom noema-sessions-idle-threshold 30
  "Seconds without agent activity after which a running session shows idle.
A running session that has gone quiet is how a stuck agent looks; the list
says so instead of letting \"running\" hide it.  Adopted from Pisper."
  :type 'natnum
  :group 'noema-agent-session)

(defun noema-sessions--running-status (buffer)
  "Return \"running\", with how long live BUFFER has been quiet if long."
  (let* ((last (and buffer (buffer-local-value 'noema-agent-acp-last-used-at buffer)))
         (idle (and last (- (float-time) last))))
    (if (and idle (>= idle noema-sessions-idle-threshold))
        (format "running, idle %s"
                (if (< idle 120) (format "%ds" idle) (format "%dm" (/ idle 60))))
      "running")))

(defun noema-sessions--status (entry root)
  "Return the display status of session ENTRY in ROOT."
  (cond ((equal (noema-sessions--string entry "state") "archived") "archived")
        ((noema-sessions--get entry "openRun")
         (noema-sessions--running-status (noema-sessions--live-buffer entry root)))
        ((noema-sessions--live-buffer entry root) "live")
        ((not (noema-sessions--string entry "sessionId")) "declared")
        ((member (noema-sessions--string entry "sessionState") '("active" "warm")) "resumable")
        (t "lost")))

(defun noema-sessions--true-p (value)
  "Return non-nil when JSON VALUE is true."
  (and value (not (eq value :false)) (not (eq value :json-false))))

(defun noema-sessions--attention (entry)
  "Return the attention mark of session ENTRY.
The kernel derives it from the latest Run: a pending permission or input
request, then a failure, then an unread settled Run.  Reading clears only
the last; a failure stays until a later Run succeeds."
  (pcase (noema-sessions--string entry "attentionReason")
    ("permission" "!approve")
    ("input" "!input")
    ("failed" (if (noema-sessions--true-p (noema-sessions--get entry "unread")) "!failed" "failed"))
    (_ (if (noema-sessions--true-p (noema-sessions--get entry "unread")) "new" ""))))

(defun noema-sessions--attention-rank (entry)
  "Return ENTRY's sort rank: 0 needs the person now, 1 is unread, 2 is quiet."
  (cond ((noema-sessions--true-p (noema-sessions--get entry "needsAttention")) 0)
        ((noema-sessions--true-p (noema-sessions--get entry "unread")) 1)
        (t 2)))

(defun noema-sessions--time (timestamp)
  "Return a compact local rendering of RFC 3339 TIMESTAMP."
  (or (ignore-errors (format-time-string "%m-%d %H:%M" (date-to-time timestamp)))
      ""))

(defun noema-sessions--tokens (count)
  "Return token COUNT in a compact human form."
  (cond ((>= count 1000000) (format "%.1fM" (/ count 1000000.0)))
        ((>= count 1000) (format "%.1fk" (/ count 1000.0)))
        (t (format "%d" count))))

(defun noema-sessions--usage (entry)
  "Return ENTRY's context-window use and token total, or an empty string.
The kernel keeps the latest usage the agent reported for the bound Session."
  (let* ((usage (noema-sessions--get entry "usage"))
         (used (and usage (noema-sessions--get usage "contextUsed")))
         (size (and usage (noema-sessions--get usage "contextSize")))
         (total (and usage (noema-sessions--get usage "totalTokens"))))
    (string-join
     (delq nil (list (and (numberp used) (numberp size) (> size 0)
                          (format "%d%%" (round (* 100.0 (/ (float used) size)))))
                     (and (numberp total) (> total 0) (noema-sessions--tokens total))))
     " ")))

(defun noema-sessions--buffer-cell (buffer)
  "Return the Buffer cell for live agent BUFFER, with its queued prompts."
  (cond ((not buffer) "")
        ((zerop (noema-agent-acp-pending-prompt-count buffer)) "yes")
        (t (format "yes +%dq" (noema-agent-acp-pending-prompt-count buffer)))))

(defun noema-sessions--last-run (run)
  "Return the Last Run cell for RUN: its time, status and failure kind.
A retryable kind (rate limit, network, lost lease) ends in \"retry\": the
same Run may succeed later unchanged.  Auth, quota and context failures need
the person first."
  (let ((kind (noema-sessions--string run "failureKind")))
    (concat (noema-sessions--time (noema-sessions--string run "createdAt")) " "
            (or (noema-sessions--string run "status") "")
            (if kind
                (format " (%s%s)" (string-replace "_" " " kind)
                        (if (noema-sessions--true-p (noema-sessions--get run "retryable")) ", retry" ""))
              ""))))

(defun noema-sessions--row (entry root)
  "Return the `tabulated-list-entries' row for session ENTRY in ROOT."
  (let* ((name (noema-sessions--string entry "name"))
         (last (noema-sessions--get entry "lastRun"))
         (aliases (noema-sessions--list (noema-sessions--get entry "aliases"))))
    (list name
          (vector (let ((mark (noema-sessions--attention entry)))
                    (if (string-empty-p mark)
                        (or (noema-agent-acp-attention-mark
                             (noema-sessions--live-buffer entry root))
                            "")
                      mark))
                  (if aliases (format "%s (was %s)" name (string-join aliases ", ")) name)
                  (or (noema-sessions--string entry "agent") "")
                  (noema-sessions--status entry root)
                  (noema-sessions--usage entry)
                  (noema-sessions--buffer-cell (noema-sessions--live-buffer entry root))
                  (if last (noema-sessions--last-run last) "")
                  (or (noema-sessions--string entry "origin") "")
                  (or (noema-sessions--string entry "parentName") "")))))

(defun noema-sessions--pinned-names (source)
  "Return session names written in `@@session' lines of JuText SOURCE."
  (when (buffer-live-p source)
    (with-current-buffer source
      (save-excursion
        (goto-char (point-min))
        (let (names)
          (while (re-search-forward "^@@session(\\([^)\n]*\\))[ \t]*$" nil t)
            (dolist (part (split-string (match-string-no-properties 1) ":" t "[ \t]+"))
              (push part names)))
          names)))))

(defun noema-sessions--in-file (names runs source)
  "Return NAMES used by RUNS of SOURCE's document or pinned in its text."
  (let ((wanted (make-hash-table :test #'equal))
        (notebook-id (and (buffer-live-p source)
                          (buffer-local-value 'noema-research--document source)
                          (noema-research--get
                           (noema-research-notebook-meta
                            (buffer-local-value 'noema-research--document source))
                           "notebook_id"))))
    (dolist (run runs)
      (when-let* (((and notebook-id (equal (noema-sessions--string run "notebookId") notebook-id)))
                  (name (noema-sessions--string run "sessionName")))
        (puthash name t wanted)))
    (dolist (name (noema-sessions--pinned-names source))
      (puthash name t wanted))
    (seq-filter (lambda (entry)
                  (or (gethash (noema-sessions--string entry "name") wanted)
                      (seq-some (lambda (alias) (gethash alias wanted))
                                (noema-sessions--list (noema-sessions--get entry "aliases")))))
                names)))

(defun noema-sessions--render (buffer names runs)
  "Render NAMES (filtered by RUNS in file scope) into sessions BUFFER."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (let* ((visible (if (eq noema-sessions--scope 'file)
                          (noema-sessions--in-file names runs noema-sessions--source)
                        names))
             ;; A file-scoped list answers "which conversations does this
             ;; document use", which a local session never does.
             (local (unless (eq noema-sessions--scope 'file)
                      (noema-sessions--local-sessions names noema-sessions--root)))
             ;; What needs the person comes first; the kernel's recency
             ;; order is kept inside each rank.
             (visible (seq-sort-by #'noema-sessions--attention-rank #'< visible)))
        (setq noema-sessions--names visible
              noema-sessions--local local
              tabulated-list-entries
              (append (mapcar (lambda (entry) (noema-sessions--row entry noema-sessions--root))
                              visible)
                      (mapcar #'noema-sessions--local-row local))
              mode-name (format "Noema-Sessions[%s]" noema-sessions--scope))
        (tabulated-list-print t)))))

(defun noema-sessions-refresh ()
  "Reload the session names of this list."
  (interactive)
  (let ((buffer (current-buffer))
        (root noema-sessions--root))
    (noema-sessions--api
     "aaronnote:api:research:session:names" `((cwd . ,root) (includeArchived . t))
     (lambda (result error-object)
       (if error-object
           (message "Noema sessions: %s" (noema-sessions--error error-object))
         (let ((names (noema-sessions--list (noema-sessions--get result "names"))))
           (if (and (buffer-live-p buffer)
                    (eq (buffer-local-value 'noema-sessions--scope buffer) 'file))
               (noema-sessions--api
                "aaronnote:api:research:run:list" `((cwd . ,root) (limit . 1000))
                (lambda (runs runs-error)
                  (noema-sessions--render
                   buffer names
                   (unless runs-error (noema-sessions--list (noema-sessions--get runs "runs"))))))
             (noema-sessions--render buffer names nil))))))))

(defun noema-sessions--entry (name)
  "Return the shown session object called NAME."
  (seq-find (lambda (entry) (equal (noema-sessions--string entry "name") name))
            noema-sessions--names))

(defun noema-sessions--name-at-point ()
  "Return the session name on the current row."
  (or (tabulated-list-get-id) (user-error "No session on this line")))

(defun noema-sessions--local (name)
  "Return the shown local session called NAME, or nil."
  (seq-find (lambda (session) (equal (noema-sessions--local-label session) name))
            noema-sessions--local))

(defun noema-sessions--durable (name)
  "Return the durable session object called NAME, or refuse a local-only row."
  (or (noema-sessions--entry name)
      (if (noema-sessions--local name)
          (user-error "“%s” is a live local session with no project record yet" name)
        (user-error "No session called “%s”" name))))

(defun noema-sessions--resume (entry root)
  "Open ENTRY's recorded conversation in a hidden agent buffer, without a Run."
  (let* ((name (noema-sessions--string entry "name"))
         (agent (noema-sessions--string entry "agent"))
         (config (or (noema-agent-acp-config-for agent)
                     (user-error "No agent-shell configuration for %s" agent)))
         ;; An agent finds a native conversation by the directory it ran in.
         (target (noema-sessions--string entry "executionTarget"))
         (directory (if (and target (file-directory-p target))
                        target
                      (noema-project-workspace root)))
         (buffer (noema-agent-acp-start :config config :directory directory :focus t
                                        :origin 'run
                                        :session-id (noema-sessions--string entry "nativeSessionId"))))
    (noema-agent-acp-mark-session-buffer buffer name agent root)
    (with-current-buffer buffer
      (setq-local noema-agent-promote--session-id (noema-sessions--string entry "sessionId")))
    buffer))

(defun noema-sessions--mark-read (root name &optional done)
  "Record that the person has seen session NAME of ROOT, then call DONE."
  (noema-sessions--api
   "aaronnote:api:research:session:name:read"
   `((cwd . ,root) (name . ,name))
   (lambda (_result error-object)
     (when error-object
       (message "Noema: %s" (noema-sessions--error error-object)))
     (when done (funcall done (not error-object))))))

(defun noema-sessions--note-read (entry root)
  "Mark ENTRY of ROOT read when it has unread news, refreshing open lists."
  (when (noema-sessions--true-p (noema-sessions--get entry "unread"))
    (noema-sessions--mark-read root (noema-sessions--string entry "name")
                               (lambda (_ok) (noema-sessions--refresh-lists root)))))

(defun noema-sessions-mark-read (name)
  "Mark session NAME read.  A failure stays until a later Run succeeds."
  (interactive (list (noema-sessions--name-at-point)))
  (let ((entry (noema-sessions--entry name)))
    (noema-agent-acp-clear-attention
     (or (plist-get (noema-sessions--local name) :buffer)
         (and entry (noema-sessions--live-buffer entry noema-sessions--root)))))
  (noema-sessions--durable name)
  (noema-sessions--mark-read noema-sessions--root name
                             (noema-sessions--refresher (current-buffer))))

(defun noema-sessions-next-attention ()
  "Move to the next session that needs the person or has unread news."
  (interactive)
  (let ((start (point)) found)
    (forward-line 1)
    (while (and (not found) (not (eobp)))
      (if (equal (aref (or (tabulated-list-get-entry) [""]) 0) "")
          (forward-line 1)
        (setq found t)))
    (unless found
      (goto-char start)
      (message "No other session needs attention"))))

(defun noema-sessions--visit-entry (entry root)
  "Show session ENTRY of ROOT, resuming its conversation when needed.
Showing it is reading it."
  (let ((live (noema-sessions--live-buffer entry root))
        (name (noema-sessions--string entry "name")))
    (noema-sessions--note-read entry root)
    (cond
     (live (noema-agent-acp-show-buffer live))
     ((equal name "pi") (noema-pi-router-open root))
     ((and (noema-sessions--string entry "nativeSessionId")
           (member (noema-sessions--string entry "sessionState") '("active" "warm")))
      (noema-sessions--resume entry root))
     (t (user-error "“%s” has no conversation yet; run a work block in it" name)))))

(defun noema-sessions-open-reference (root &optional name session-id)
  "Open ROOT’s existing agent conversation identified by NAME or SESSION-ID.

Prefer an already-live internal tab.  Otherwise resolve the durable registry
and resume the native conversation into the same project Agent workspace."
  (let ((root (noema-sessions--project-root root)))
    (noema-sessions--ensure-host
     (lambda ()
       (noema-sessions--api
        "aaronnote:api:research:session:names"
        `((cwd . ,root) (includeArchived . t))
        (lambda (result error-object)
          (if error-object
              (message "Open Agent failed: %s" (noema-sessions--error error-object))
            (let* ((names (noema-sessions--list (noema-sessions--get result "names")))
                   ;; Session id is generation-exact; a reused name is only a
                   ;; fallback for older OutputArea payloads.
                   (entry (or (and session-id
                                   (seq-find
                                    (lambda (candidate)
                                      (equal session-id
                                             (noema-sessions--string candidate "sessionId")))
                                    names))
                              (and name
                                   (seq-find
                                    (lambda (candidate)
                                      (or (equal name (noema-sessions--string candidate "name"))
                                          (member name (noema-sessions--list
                                                        (noema-sessions--get candidate "aliases")))))
                                    names)))))
              (if entry
                  (condition-case open-error
                      (noema-sessions--visit-entry entry root)
                    (error (message "Open Agent failed: %s"
                                    (error-message-string open-error))))
                (message "Open Agent: the requested Session is no longer resumable"))))))))))

(defun noema-sessions--side-buffer (root parent)
  "Return the live side chat of session PARENT in ROOT, or nil."
  (seq-find (lambda (buffer)
              (and (noema-agent-acp-agent-buffer-p buffer)
                   (equal (buffer-local-value 'noema-agent-acp-side-parent buffer) parent)
                   (equal (buffer-local-value 'noema-agent-acp-session-root buffer) root)))
            (buffer-list)))

(defun noema-sessions--open-side-chat (root parent agent directory)
  "Show the side chat beside session PARENT of ROOT, starting AGENT in DIRECTORY.
One side chat per session: opening it again returns to the same one.  It
starts empty -- the parent's history is not copied and its Runs are not
touched -- and never enters the durable registry.  Once idle and hidden it is
stopped by the same sweep as a Run's warm session."
  (let ((buffer (noema-sessions--side-buffer root parent)))
    (unless buffer
      (let ((config (or (noema-agent-acp-config-for agent)
                        (user-error "No agent-shell configuration for %s" agent))))
        (setq buffer (noema-agent-acp-start :config config :directory directory :origin 'side))
        (with-current-buffer buffer
          (setq-local noema-agent-acp-side-parent parent))
        (noema-agent-acp-adopt buffer :agent agent :origin 'side :root root
                               :name (noema-agent-acp--unique-name (format "side/%s" parent) root))))
    (noema-agent-acp-show-buffer buffer)
    buffer))

(defun noema-sessions-side-chat (name)
  "Open a side chat beside session NAME to ask without interrupting it.
It uses the same agent and working directory, starts without NAME's
history, and goes away on its own once idle and hidden."
  (interactive (list (noema-sessions--name-at-point)))
  (let* ((entry (noema-sessions--durable name))
         (target (noema-sessions--string entry "executionTarget")))
    (noema-sessions--open-side-chat
     noema-sessions--root name (noema-sessions--string entry "agent")
     (if (and target (file-directory-p target)) target (noema-project-workspace noema-sessions--root)))))

(defun noema-sessions-agent-side-chat (&optional buffer)
  "Open a side chat beside the session of agent BUFFER."
  (interactive)
  (pcase-let ((`(,buffer ,root ,name) (noema-sessions--agent-target buffer)))
    (noema-sessions--open-side-chat
     root name (buffer-local-value 'noema-agent-acp-session-agent buffer)
     (buffer-local-value 'default-directory buffer))))

(defun noema-sessions-visit ()
  "Switch to the agent buffer of the session on this line."
  (interactive)
  (let* ((name (noema-sessions--name-at-point))
         (local (noema-sessions--local name)))
    (if local
        (noema-agent-acp-show-buffer (plist-get local :buffer))
      (noema-sessions--visit-entry (noema-sessions--durable name) noema-sessions--root))))

(defun noema-sessions-conversation-tree ()
  "Open the conversation tree for the session on this line.
Resume a recorded conversation first when its agent buffer is closed."
  (interactive)
  (let* ((name (noema-sessions--name-at-point))
         (local (noema-sessions--local name))
         (buffer (if local
                     (plist-get local :buffer)
                   (noema-sessions--entry-buffer
                    (noema-sessions--durable name) noema-sessions--root))))
    (if (noema-agent-acp-state-value buffer '(:session :id))
        (noema-agent-acp-conversation-tree buffer)
      (let (subscription opened)
        (cl-labels ((open-tree ()
                      (unless opened
                        (setq opened t)
                        (noema-agent-acp-unsubscribe
                         :buffer buffer :subscription subscription)
                        (when (buffer-live-p buffer)
                          (condition-case err
                              (noema-agent-acp-conversation-tree buffer)
                            (error (message "Noema conversation tree: %s"
                                            (error-message-string err))))))))
          (setq subscription
                (noema-agent-acp-subscribe
                 :buffer buffer :event 'init-finished
                 :callback (lambda (_event) (open-tree))))
          ;; Initialization can finish between the first state check and
          ;; subscription.  Check once more so the tree never waits forever.
          (when (noema-agent-acp-state-value buffer '(:session :id))
            (open-tree))
          (unless opened
            (message "Opening %s's conversation tree after the agent connects" name)))))))

(defun noema-sessions--project-jutext-buffers (root)
  "Return live JuText buffers of files under ROOT."
  (seq-filter (lambda (buffer)
                (with-current-buffer buffer
                  (and (derived-mode-p 'noema-research-mode)
                       buffer-file-name
                       (file-in-directory-p buffer-file-name root))))
              (buffer-list)))

(defun noema-sessions--refresher (list-buffer)
  "Return a callback that refreshes session LIST-BUFFER while it is live."
  (lambda (&rest _)
    (when (buffer-live-p list-buffer)
      (with-current-buffer list-buffer (noema-sessions-refresh)))))

(defun noema-sessions--rename (root name new-name &optional done)
  "Rename session NAME of ROOT to NEW-NAME; the old name stays as an alias.
`@@session' lines in open JuText buffers of the project are rewritten as
ordinary, undoable edits.  DONE is called with non-nil on success."
  (noema-sessions--api
   "aaronnote:api:research:session:name:rename"
   `((cwd . ,root) (name . ,name) (newName . ,new-name) (actor . "emacs"))
   (lambda (_result error-object)
     (if error-object
         (message "Noema rename failed: %s" (noema-sessions--error error-object))
       (let ((edited 0))
         (dolist (buffer (noema-sessions--project-jutext-buffers root))
           (with-current-buffer buffer
             (setq edited (+ edited (noema-research-rename-session-directives name new-name)))))
         (when-let* ((agent-buffer (noema-agent-acp-session-buffer name root)))
           (noema-agent-acp-mark-session-buffer
            agent-buffer new-name (buffer-local-value 'noema-agent-acp-session-agent agent-buffer) root))
         (message "Renamed %s to %s%s" name new-name
                  (if (> edited 0) (format "; %d @@session line(s) updated (unsaved)" edited) ""))))
     (when done (funcall done (not error-object))))))

(defun noema-sessions-rename (name new-name)
  "Rename session NAME to NEW-NAME; the old name stays as an alias.
`@@session' lines in open JuText buffers of the project are rewritten as
ordinary, undoable edits."
  (interactive
   (let ((name (noema-sessions--name-at-point)))
     (noema-sessions--durable name)
     (list name (read-string (format "Rename %s to: " name) name))))
  (noema-sessions--rename noema-sessions--root name new-name
                          (noema-sessions--refresher (current-buffer))))

(defun noema-sessions--fork (root parent child agent &optional done)
  "Declare session CHILD of AGENT in ROOT as a hand-over from PARENT.
DONE is called with non-nil on success."
  (noema-sessions--api
   "aaronnote:api:research:session:name:declare"
   `((cwd . ,root) (name . ,child) (agent . ,agent) (parentName . ,parent))
   (lambda (_result error-object)
     (if error-object
         (message "Noema fork failed: %s" (noema-sessions--error error-object))
       (message "Declared %s from %s; write @@session(%s) to use it" child parent child))
     (when done (funcall done (not error-object))))))

(defun noema-sessions-fork (parent child)
  "Declare session CHILD as a hand-over from PARENT.
Its conversation starts on the first Run that uses it."
  (interactive
   (let ((name (noema-sessions--name-at-point)))
     (noema-sessions--durable name)
     (list name (read-string (format "Fork %s as: " name) (concat name "/")))))
  (noema-sessions--fork noema-sessions--root parent child
                        (noema-sessions--string (noema-sessions--durable parent) "agent")
                        (noema-sessions--refresher (current-buffer))))

(defun noema-sessions--archive (root name archived &optional done)
  "Set whether session NAME of ROOT is ARCHIVED; DONE gets non-nil on success."
  (noema-sessions--api
   "aaronnote:api:research:session:name:archive"
   `((cwd . ,root) (name . ,name) (archived . ,(if archived t :false)) (actor . "emacs"))
   (lambda (_result error-object)
     (when error-object
       (message "Noema archive failed: %s" (noema-sessions--error error-object)))
     (when done (funcall done (not error-object))))))

(defun noema-sessions-toggle-archive (name)
  "Archive session NAME, or restore it when already archived."
  (interactive (list (noema-sessions--name-at-point)))
  (noema-sessions--archive
   noema-sessions--root name
   (not (equal (noema-sessions--string (noema-sessions--durable name) "state") "archived"))
   (noema-sessions--refresher (current-buffer))))

(defun noema-sessions-kill-buffer (name)
  "Kill the agent buffer of session NAME; the name and history remain."
  (interactive (list (noema-sessions--name-at-point)))
  (let* ((local (noema-sessions--local name))
         (entry (unless local (noema-sessions--durable name)))
         (buffer (or (and local (plist-get local :buffer))
                     (noema-sessions--live-buffer entry noema-sessions--root)
                     (user-error "“%s” has no live buffer" name))))
    (when (or (not (noema-sessions--get entry "openRun"))
              (yes-or-no-p (format "“%s” is running a Run; interrupt it by killing the buffer? " name)))
      (kill-buffer buffer)
      (noema-sessions-refresh))))

(defun noema-sessions-pin (name)
  "Write `@@session(NAME)' into the work block at point of the source JuText."
  (interactive (list (noema-sessions--name-at-point)))
  (noema-sessions--durable name)
  (let ((source noema-sessions--source))
    (unless (buffer-live-p source)
      (user-error "Open the session list from a .noema buffer to pin a session"))
    (pop-to-buffer source)
    (noema-research-pin-session name)))

(defun noema-sessions--jump-to-run (root name last &optional then)
  "Visit the work block of LAST, the latest Run of session NAME in ROOT.
THEN, when non-nil, is called with point on that work block."
  (unless last
    (user-error "“%s” has not run yet" name))
  (let ((notebook-id (noema-sessions--string last "notebookId"))
        (cell-id (noema-sessions--string last "cellId")))
    (unless (and notebook-id cell-id)
      (user-error "The latest Run of “%s” did not come from a work block" name))
    (noema-sessions--api
     "aaronnote:api:research:cell:resolve"
     `((cwd . ,root) (notebookId . ,notebook-id) (cellId . ,cell-id))
     (lambda (result error-object)
       (if error-object
           (message "Noema: %s" (noema-sessions--error error-object))
         ;; Never replace the Agent window's session with the document.
         (when-let* (((window-parameter (selected-window) 'noema-agent-workspace))
                     (other (seq-find (lambda (window)
                                        (not (window-parameter window 'noema-agent-workspace)))
                                      (window-list nil 'nomini))))
           (select-window other))
         (find-file (noema-sessions--string result "file"))
         (noema-research-goto-cell cell-id)
         (when then (funcall then)))))))

(declare-function noema-research-execute-current "noema-research-mode" ())

(defun noema-sessions-retry (name)
  "Run again the work block of session NAME's latest Run, which failed.
The kernel says whether the failure is retryable; for one that is not --
authentication, quota, context -- this asks first, since the same Run will
most likely fail the same way."
  (interactive (list (noema-sessions--name-at-point)))
  (let* ((entry (noema-sessions--durable name))
         (last (noema-sessions--get entry "lastRun")))
    (unless (and last (member (noema-sessions--string last "status") '("failed" "interrupted")))
      (user-error "The latest Run of “%s” did not fail" name))
    (when (or (noema-sessions--true-p (noema-sessions--get last "retryable"))
              (yes-or-no-p (format "“%s” failed with %s, which retrying rarely fixes; run it again? "
                                   name (or (noema-sessions--string last "failureKind") "an error"))))
      (noema-sessions--jump-to-run noema-sessions--root name last #'noema-research-execute-current)
      (noema-sessions--note-read entry noema-sessions--root))))

(defun noema-sessions-jump (name)
  "Visit the work block of session NAME's latest Run."
  (interactive (list (noema-sessions--name-at-point)))
  (let ((entry (noema-sessions--durable name)))
    (noema-sessions--jump-to-run noema-sessions--root name (noema-sessions--get entry "lastRun"))
    (noema-sessions--note-read entry noema-sessions--root)))

;;; Reviewing a session's checkout

(defun noema-sessions--checkout-directory (name)
  "Return the directory session NAME's agent works in."
  (let* ((local (noema-sessions--local name))
         (entry (noema-sessions--entry name))
         (buffer (or (plist-get local :buffer)
                     (and entry (noema-sessions--live-buffer entry noema-sessions--root)))))
    (or (and (buffer-live-p buffer) (buffer-local-value 'default-directory buffer))
        (and entry (noema-sessions--string entry "executionTarget"))
        (user-error "Session “%s” has no recorded directory" name))))

(defun noema-sessions-magit-status (name)
  "Open Magit status for the checkout session NAME works in."
  (interactive (list (noema-sessions--name-at-point)))
  (noema-agent-worktree-magit-status (noema-sessions--checkout-directory name)))

(defun noema-sessions-magit-diff (name)
  "Show what session NAME changed; see `noema-agent-worktree-magit-diff'."
  (interactive (list (noema-sessions--name-at-point)))
  (noema-agent-worktree-magit-diff (noema-sessions--checkout-directory name)))

;;; Agent window tab commands

(defun noema-sessions--agent-target (buffer)
  "Return (BUFFER ROOT NAME) for the named session of agent BUFFER."
  (let* ((buffer (noema-agent-acp-command-buffer buffer))
         (name (buffer-local-value 'noema-agent-acp-session-name buffer))
         (root (buffer-local-value 'noema-agent-acp-session-root buffer)))
    (unless name
      (user-error "This agent buffer was retired by a newer session; close it instead"))
    (list buffer (noema-sessions--project-root root) name)))

(defun noema-sessions--refresh-lists (root)
  "Refresh every open session list of project ROOT."
  (dolist (buffer (buffer-list))
    (when (and (eq (buffer-local-value 'major-mode buffer) 'noema-sessions-mode)
               (equal (buffer-local-value 'noema-sessions--root buffer) root))
      (with-current-buffer buffer (noema-sessions-refresh)))))

(defun noema-sessions-agent-rename (&optional buffer new-name)
  "Rename the session of agent BUFFER to NEW-NAME."
  (interactive)
  (pcase-let* ((`(,_buffer ,root ,name) (noema-sessions--agent-target buffer))
               (new-name (or new-name (read-string (format "Rename %s to: " name) name))))
    (noema-sessions--rename root name new-name
                            (lambda (_ok) (noema-sessions--refresh-lists root)))))

(defun noema-sessions-agent-fork (&optional buffer child)
  "Declare CHILD as a hand-over from the session of agent BUFFER."
  (interactive)
  (pcase-let* ((`(,buffer ,root ,name) (noema-sessions--agent-target buffer))
               (child (or child (read-string (format "Fork %s as: " name) (concat name "/")))))
    (noema-sessions--fork root name child
                          (buffer-local-value 'noema-agent-acp-session-agent buffer)
                          (lambda (_ok) (noema-sessions--refresh-lists root)))))

(defun noema-sessions-agent-archive (&optional buffer)
  "Archive the session of agent BUFFER and close its tab."
  (interactive)
  (pcase-let ((`(,buffer ,root ,name) (noema-sessions--agent-target buffer)))
    (when (and (yes-or-no-p (format "Archive session %s and close its tab? " name))
               (noema-agent-acp-confirm-stop buffer "archive"))
      (noema-sessions--archive
       root name t
       (lambda (ok)
         (when (and ok (buffer-live-p buffer))
           (noema-agent-acp-kill buffer))
         (noema-sessions--refresh-lists root))))))

(defun noema-sessions-agent-restart (&optional buffer)
  "Restart the session of agent BUFFER: stop its process, resume its conversation."
  (interactive)
  (pcase-let ((`(,buffer ,root ,name) (noema-sessions--agent-target buffer)))
    (when (noema-agent-acp-confirm-stop buffer "restart")
      (noema-agent-acp-kill buffer)
      (noema-sessions-open-reference root name))))

(defun noema-sessions-agent-jump (&optional buffer)
  "Visit the work block of the latest Run in the session of agent BUFFER."
  (interactive)
  (pcase-let ((`(,_buffer ,root ,name) (noema-sessions--agent-target buffer)))
    (noema-sessions--api
     "aaronnote:api:research:session:names"
     `((cwd . ,root) (includeArchived . t))
     (lambda (result error-object)
       (if error-object
           (message "Noema: %s" (noema-sessions--error error-object))
         (let ((entry (seq-find (lambda (candidate)
                                  (equal (noema-sessions--string candidate "name") name))
                                (noema-sessions--list (noema-sessions--get result "names")))))
           (condition-case jump-error
               (noema-sessions--jump-to-run root name (and entry (noema-sessions--get entry "lastRun")))
             (user-error (message "%s" (error-message-string jump-error))))))))))

(defun noema-sessions-agent-list (&optional buffer)
  "Open the session list of agent BUFFER's project."
  (interactive)
  (let* ((buffer (noema-agent-acp-command-buffer buffer))
         (default-directory (buffer-local-value 'noema-agent-acp-session-root buffer)))
    (noema-sessions 'project)))

(defun noema-sessions-toggle-scope ()
  "Toggle between this file's sessions and all project sessions."
  (interactive)
  (setq noema-sessions--scope
        (if (and (eq noema-sessions--scope 'project) (buffer-live-p noema-sessions--source))
            'file
          'project))
  (noema-sessions-refresh))

(defun noema-sessions-open-pi ()
  "Open this project's Pi coordinator."
  (interactive)
  (noema-pi-router-open noema-sessions--root))

(defvar noema-sessions-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'noema-sessions-visit)
    (define-key map (kbd "r") #'noema-sessions-rename)
    (define-key map (kbd "F") #'noema-sessions-fork)
    (define-key map (kbd "a") #'noema-sessions-toggle-archive)
    (define-key map (kbd "k") #'noema-sessions-kill-buffer)
    (define-key map (kbd "i") #'noema-sessions-pin)
    (define-key map (kbd "j") #'noema-sessions-jump)
    (define-key map (kbd "t") #'noema-sessions-toggle-scope)
    (define-key map (kbd "P") #'noema-sessions-open-pi)
    (define-key map (kbd "c") #'noema-sessions-compact)
    (define-key map (kbd "u") #'noema-sessions-mark-read)
    (define-key map (kbd "s") #'noema-sessions-side-chat)
    (define-key map (kbd "T") #'noema-sessions-conversation-tree)
    (define-key map (kbd "R") #'noema-sessions-retry)
    (define-key map (kbd "!") #'noema-sessions-next-attention)
    (define-key map (kbd "m") #'noema-sessions-magit-status)
    (define-key map (kbd "d") #'noema-sessions-magit-diff)
    map)
  "Keymap for `noema-sessions-mode'.")

(defun noema-sessions-compact ()
  "Roll the session on this line over to its latest Handoff at its next Run.
The name, history and Handoffs stay; the next Run starts a new conversation
from the durable Handoff, freeing a context window before it fills up."
  (interactive)
  (let* ((name (noema-sessions--name-at-point))
         (entry (noema-sessions--durable name))
         (session-id (and entry (noema-sessions--string entry "sessionId"))))
    (unless session-id
      (user-error "Session %s has no conversation to compact yet" name))
    (noema-sessions--api
     "aaronnote:api:research:session:compact"
     `((cwd . ,noema-sessions--root) (sessionId . ,session-id))
     (lambda (_result error-object)
       (if error-object
           (message "Noema sessions: %s" (noema-sessions--error error-object))
         (message "Session %s rolls over to its latest Handoff at its next Run" name))))))

(define-derived-mode noema-sessions-mode tabulated-list-mode "Noema-Sessions"
  "List the named agent sessions of a Noema project.

RET switch to (or resume) the session's buffer   r rename   F fork
a archive/restore   k kill buffer   i pin into the source work block
j jump to latest work block   t file/project scope   c compact context
u mark read   ! next session needing attention   s side chat beside it
T native conversation tree for this session
R rerun the work block of a failed latest Run
P Pi   g refresh

The first column is attention: !approve and !input wait on you now,
failed means the latest Run failed (reading does not clear it), new marks a
settled Run you have not opened.  Rows needing you sort first.

\\{noema-sessions-mode-map}"
  (setq tabulated-list-format [("Attn" 8 t) ("Name" 30 t) ("Agent" 9 t) ("State" 17 t) ("Context" 11 t) ("Buffer" 9 t)
                               ("Last Run" 32 t) ("Origin" 8 t) ("Parent" 20 t)])
  (setq-local revert-buffer-function (lambda (&rest _) (noema-sessions-refresh)))
  (tabulated-list-init-header))

;;;###autoload
(defun noema-sessions (&optional scope)
  "List the named agent sessions of the current project.
From a `.noema' buffer the list starts scoped to that file; SCOPE may be
`file' or `project'."
  (interactive)
  (let* ((source (and (derived-mode-p 'noema-research-mode) (current-buffer)))
         (root (noema-sessions--project-root
                (if (and source buffer-file-name) (file-name-directory buffer-file-name) default-directory)))
         (buffer (get-buffer-create
                  (format "*Noema Sessions: %s*" (file-name-nondirectory (directory-file-name root))))))
    (with-current-buffer buffer
      (noema-sessions-mode)
      (setq noema-sessions--root root
            noema-sessions--source source
            noema-sessions--scope (or scope (if source 'file 'project))))
    (pop-to-buffer buffer)
    (noema-sessions--ensure-host
     (lambda () (when (buffer-live-p buffer) (with-current-buffer buffer (noema-sessions-refresh)))))
    buffer))

(defun noema-sessions--unique-choices (choices)
  "Return CHOICES with duplicate labels disambiguated for `completing-read'."
  (let ((seen (make-hash-table :test #'equal))
        result)
    (dolist (choice choices (nreverse result))
      (let* ((label (car choice))
             (count (gethash label seen 0)))
        (puthash label (1+ count) seen)
        (push (cons (if (zerop count) label (format "%s <%d>" label (1+ count)))
                    (cdr choice))
              result)))))

(defun noema-sessions--switch-candidates (names root &optional live-only)
  "Return (LABEL . (ENTRY . BUFFER)) choices for project ROOT.
Durable session names come first, then ROOT's live sessions that have no
durable record yet, then live sessions of other projects.  A popup, manual or
foreign session is registered like any other, so one prompt reaches them all.
With LIVE-ONLY, include only buffers with a running ACP process, putting ROOT
first; a context send must never revive a recorded conversation."
  (noema-sessions--unique-choices
   (if live-only
       (let* ((sessions (seq-filter
                         (lambda (session)
                           (and (not (noema-agent-acp-export-session-p session))
                                (noema-sessions--execution-live-p
                                 (plist-get session :buffer))))
                         (noema-agent-acp-sessions)))
              (local (seq-filter (lambda (session)
                                   (equal (plist-get session :root) root))
                                 sessions))
              (other (seq-remove (lambda (session)
                                   (equal (plist-get session :root) root))
                                 sessions)))
         (mapcar (lambda (session)
                   (cons (format "%s  %s · %s"
                                 (noema-sessions--local-label session)
                                 (or (plist-get session :agent) "")
                                 (if (equal (plist-get session :root) root)
                                     "current project"
                                   (format "in %s"
                                           (file-name-nondirectory
                                            (directory-file-name
                                             (or (plist-get session :root) "/"))))))
                         (cons nil (plist-get session :buffer))))
                 (append local other)))
     (append
    (mapcar (lambda (entry)
              (cons (format "%s  %s · %s" (noema-sessions--string entry "name")
                            (or (noema-sessions--string entry "agent") "")
                            (noema-sessions--status entry root))
                    (cons entry nil)))
            (seq-remove (lambda (entry)
                          (equal (noema-sessions--string entry "state") "archived"))
                        names))
    (mapcar (lambda (session)
              (cons (format "%s  %s · local (%s)"
                            (noema-sessions--local-label session)
                            (or (plist-get session :agent) "")
                            (or (plist-get session :origin) "session"))
                    (cons nil (plist-get session :buffer))))
            (noema-sessions--local-sessions names root))
    (delq nil
          (mapcar (lambda (session)
                    (unless (equal (plist-get session :root) root)
                      (cons (format "%s  %s · in %s"
                                    (noema-sessions--local-label session)
                                    (or (plist-get session :agent) "")
                                    (file-name-nondirectory
                                     (directory-file-name (or (plist-get session :root) "/"))))
                            (cons nil (plist-get session :buffer)))))
                  (noema-agent-acp-sessions)))))))

(defun noema-sessions--entry-buffer (entry root)
  "Return a live agent buffer for durable ENTRY of ROOT, resuming when needed."
  (noema-sessions--visit-entry entry root)
  (or (noema-sessions--live-buffer entry root)
      (user-error "“%s” has no live conversation"
                  (noema-sessions--string entry "name"))))

(defun noema-sessions--native-entry (native-id root)
  "Return ROOT's durable entry for NATIVE-ID, if registered."
  (when-let* ((root (and root (noema-project-root root)))
              ((bound-and-true-p my/noema--ready))
              ((fboundp 'my/noema--api-call-sync))
              (result (ignore-errors
                        (my/noema--api-call-sync
                         "aaronnote:api:research:session:names"
                         (vector `((cwd . ,root))) 2)))
              (entry (seq-find
                      (lambda (candidate)
                        (equal (noema-sessions--string candidate "nativeSessionId")
                               native-id))
                      (noema-sessions--list (noema-sessions--get result "names")))))
    entry))

(defun noema-sessions-native-binding (native-id root)
  "Return Noema name and logical ID for NATIVE-ID in ROOT, if registered."
  (when-let* ((entry (noema-sessions--native-entry native-id root)))
    (list :name (noema-sessions--string entry "name")
          :session-id (noema-sessions--string entry "sessionId"))))

(defun noema-sessions-resume-native-id (native-id root)
  "Resume NATIVE-ID under its existing Noema name in ROOT, if registered.
Return the agent buffer, or nil when this native conversation has no name here.
The ACP agent remains the authority for the actual conversation history."
  (when-let* ((entry (noema-sessions--native-entry native-id root)))
    (noema-sessions--visit-entry entry (noema-project-root root))))

(defun noema-sessions--start-new (root)
  "Start a new agent session in ROOT, register it and return its buffer."
  (let* ((agent (completing-read "Agent: " (noema-agent-acp-known-agents) nil t))
         (config (or (noema-agent-acp-config-for agent)
                     (user-error "No agent-shell configuration for %s" agent)))
         (buffer (noema-agent-acp-start :config config
                                        :directory (noema-project-workspace root)
                                        :origin 'manual)))
    (noema-agent-acp-adopt buffer :agent agent :origin 'manual :root root)
    buffer))

;;;###autoload
(defvar noema-sessions-last-label nil
  "Label of the session most recently chosen in `noema-sessions-read'.")

(defun noema-sessions--choice-label (choices default)
  "Return the label in CHOICES that DEFAULT names, or nil.
DEFAULT is a live agent buffer or a label remembered from an earlier read.  A
buffer matches the live choice that owns it and the durable entry it serves."
  (cond
   ((stringp default)
    (car (assoc default choices)))
   ((buffer-live-p default)
    (car (seq-find
          (lambda (choice)
            (let ((value (cdr choice)))
              (and (consp value)
                   (or (eq (cdr value) default)
                       (and (car value)
                            (when-let* ((name (buffer-local-value
                                               'noema-agent-acp-session-name default)))
                              (equal (noema-sessions--string (car value) "name")
                                     name)))))))
          choices)))))

(cl-defun noema-sessions-read (&key prompt root allow-new default live-only
                                   copy-to-clipboard)
  "Read one agent session of ROOT and return its live agent buffer.
PROMPT overrides the minibuffer prompt.  With ALLOW-NEW the choices also
include starting a new session.  DEFAULT, a live agent buffer or a label from
`noema-sessions-last-label', is listed first and preselected.  Resuming a
recorded conversation or starting a new one happens here, so a session choice
always returns a live buffer.  LIVE-ONLY restricts choices to running ACP processes
and never queries or resumes the durable registry.  With COPY-TO-CLIPBOARD,
append a clipboard choice after every session and return `clipboard' for it."
  (let* ((root (noema-sessions--project-root root))
         (result (and (not live-only)
                      (bound-and-true-p my/noema--ready)
                      (fboundp 'my/noema--api-call-sync)
                      (ignore-errors
                        (my/noema--api-call-sync "aaronnote:api:research:session:names"
                                                 (vector `((cwd . ,root))) 2))))
         (choices (noema-sessions--switch-candidates
                   (noema-sessions--list (noema-sessions--get result "names"))
                   root live-only))
         (new-label "+ Start a new session"))
    (when allow-new
      (setq choices (append choices (list (cons new-label 'new)))))
    (when copy-to-clipboard
      (setq choices (append choices
                            (list (cons "Copy prompt to clipboard"
                                        'clipboard)))))
    (unless choices
      (user-error (if live-only
                      "No open agent sessions; start an agent in this project first"
                    "No Noema agent sessions or buffers")))
    (let* ((default-label (noema-sessions--choice-label choices default))
           (choices (if default-label
                        (cons (assoc default-label choices)
                              (seq-remove (lambda (choice)
                                            (equal (car choice) default-label))
                                          choices))
                      choices))
           (label (completing-read (or prompt "Noema session: ")
                                   ;; Keep the preselected session first even
                                   ;; for completion UIs that re-sort.
                                   (lambda (string predicate action)
                                     (if (eq action 'metadata)
                                         '(metadata (display-sort-function . identity)
                                                    (cycle-sort-function . identity))
                                       (complete-with-action action choices
                                                             string predicate)))
                                   nil t nil nil default-label))
           (choice (cdr (assoc label choices))))
      (unless (eq choice 'clipboard)
        (setq noema-sessions-last-label label))
      (cond ((eq choice 'new) (noema-sessions--start-new root))
            ((eq choice 'clipboard) 'clipboard)
            ((cdr choice) (cdr choice))
            (t (noema-sessions--entry-buffer (car choice) root))))))

;;;###autoload
(defun noema-sessions-switch ()
  "Switch to any live agent session, named by its project or by this one."
  (interactive)
  (noema-agent-acp-show-buffer (noema-sessions-read)))

(provide 'noema-sessions)
;;; noema-sessions.el ends here
