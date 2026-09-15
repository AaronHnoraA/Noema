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
  (let* ((directory (file-name-as-directory (expand-file-name (or directory default-directory))))
         (root (locate-dominating-file directory "noema.toml")))
    (file-name-as-directory (expand-file-name (or root directory)))))

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
    (or (and name (noema-agent-acp-session-buffer name root))
        (and session-id
             (seq-find (lambda (buffer)
                         (and (noema-agent-acp-agent-buffer-p buffer)
                              (local-variable-p 'noema-agent-promote--session-id buffer)
                              (equal (buffer-local-value 'noema-agent-promote--session-id buffer)
                                     session-id)))
                       (buffer-list))))))

(defun noema-sessions--status (entry root)
  "Return the display status of session ENTRY in ROOT."
  (cond ((equal (noema-sessions--string entry "state") "archived") "archived")
        ((noema-sessions--get entry "openRun") "running")
        ((noema-sessions--live-buffer entry root) "live")
        ((not (noema-sessions--string entry "sessionId")) "declared")
        ((member (noema-sessions--string entry "sessionState") '("active" "warm")) "resumable")
        (t "lost")))

(defun noema-sessions--time (timestamp)
  "Return a compact local rendering of RFC 3339 TIMESTAMP."
  (or (ignore-errors (format-time-string "%m-%d %H:%M" (date-to-time timestamp)))
      ""))

(defun noema-sessions--row (entry root)
  "Return the `tabulated-list-entries' row for session ENTRY in ROOT."
  (let* ((name (noema-sessions--string entry "name"))
         (last (noema-sessions--get entry "lastRun"))
         (aliases (noema-sessions--list (noema-sessions--get entry "aliases"))))
    (list name
          (vector (if aliases (format "%s (was %s)" name (string-join aliases ", ")) name)
                  (or (noema-sessions--string entry "agent") "")
                  (noema-sessions--status entry root)
                  (if (noema-sessions--live-buffer entry root) "yes" "")
                  (if last
                      (format "%s %s" (noema-sessions--time (noema-sessions--string last "createdAt"))
                              (or (noema-sessions--string last "status") ""))
                    "")
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
      (let ((visible (if (eq noema-sessions--scope 'file)
                         (noema-sessions--in-file names runs noema-sessions--source)
                       names)))
        (setq noema-sessions--names visible
              tabulated-list-entries (mapcar (lambda (entry) (noema-sessions--row entry noema-sessions--root))
                                             visible)
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

(defun noema-sessions--resume (entry root)
  "Open ENTRY's recorded conversation in a hidden agent buffer, without a Run."
  (let* ((name (noema-sessions--string entry "name"))
         (agent (noema-sessions--string entry "agent"))
         (config (or (noema-agent-acp-config-for agent)
                     (user-error "No agent-shell configuration for %s" agent)))
         (buffer (noema-agent-acp-start :config config :directory root :focus t
                                        :session-id (noema-sessions--string entry "nativeSessionId"))))
    (noema-agent-acp-mark-session-buffer buffer name agent root)
    (with-current-buffer buffer
      (setq-local noema-agent-promote--session-id (noema-sessions--string entry "sessionId")))
    buffer))

(defun noema-sessions--visit-entry (entry root)
  "Show session ENTRY of ROOT, resuming its conversation when needed."
  (let ((live (noema-sessions--live-buffer entry root))
        (name (noema-sessions--string entry "name")))
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

(defun noema-sessions-visit ()
  "Switch to the agent buffer of the session on this line."
  (interactive)
  (noema-sessions--visit-entry (noema-sessions--entry (noema-sessions--name-at-point))
                               noema-sessions--root))

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
     (list name (read-string (format "Fork %s as: " name) (concat name "/")))))
  (noema-sessions--fork noema-sessions--root parent child
                        (noema-sessions--string (noema-sessions--entry parent) "agent")
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
   (not (equal (noema-sessions--string (noema-sessions--entry name) "state") "archived"))
   (noema-sessions--refresher (current-buffer))))

(defun noema-sessions-kill-buffer (name)
  "Kill the agent buffer of session NAME; the name and history remain."
  (interactive (list (noema-sessions--name-at-point)))
  (let* ((entry (noema-sessions--entry name))
         (buffer (or (noema-sessions--live-buffer entry noema-sessions--root)
                     (user-error "“%s” has no live buffer" name))))
    (when (or (not (noema-sessions--get entry "openRun"))
              (yes-or-no-p (format "“%s” is running a Run; interrupt it by killing the buffer? " name)))
      (kill-buffer buffer)
      (noema-sessions-refresh))))

(defun noema-sessions-pin (name)
  "Write `@@session(NAME)' into the work block at point of the source JuText."
  (interactive (list (noema-sessions--name-at-point)))
  (let ((source noema-sessions--source))
    (unless (buffer-live-p source)
      (user-error "Open the session list from a .noema buffer to pin a session"))
    (pop-to-buffer source)
    (noema-research-pin-session name)))

(defun noema-sessions--jump-to-run (root name last)
  "Visit the work block of LAST, the latest Run of session NAME in ROOT."
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
         (noema-research-goto-cell cell-id))))))

(defun noema-sessions-jump (name)
  "Visit the work block of session NAME's latest Run."
  (interactive (list (noema-sessions--name-at-point)))
  (noema-sessions--jump-to-run noema-sessions--root name
                               (noema-sessions--get (noema-sessions--entry name) "lastRun")))

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
    map)
  "Keymap for `noema-sessions-mode'.")

(define-derived-mode noema-sessions-mode tabulated-list-mode "Noema-Sessions"
  "List the named agent sessions of a Noema project.

RET switch to (or resume) the session's buffer   r rename   F fork
a archive/restore   k kill buffer   i pin into the source work block
j jump to latest work block   t file/project scope   P Pi   g refresh

\\{noema-sessions-mode-map}"
  (setq tabulated-list-format [("Name" 30 t) ("Agent" 9 t) ("State" 10 t) ("Buffer" 7 t)
                               ("Last Run" 22 t) ("Origin" 8 t) ("Parent" 20 t)])
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

(defun noema-sessions--switch-candidates (names root)
  "Return (LABEL . (ENTRY . BUFFER)) choices for NAMES and orphan agent buffers."
  (let ((choices (mapcar (lambda (entry)
                           (cons (format "%s  %s · %s" (noema-sessions--string entry "name")
                                         (or (noema-sessions--string entry "agent") "")
                                         (noema-sessions--status entry root))
                                 (cons entry nil)))
                         (seq-remove (lambda (entry)
                                       (equal (noema-sessions--string entry "state") "archived"))
                                     names))))
    (dolist (buffer (buffer-list))
      (when (and (noema-agent-acp-agent-buffer-p buffer)
                 (not (seq-some (lambda (choice)
                                  (eq (noema-sessions--live-buffer (cadr choice) root) buffer))
                                choices)))
        (push (cons (format "%s  (unnamed buffer)" (buffer-name buffer)) (cons nil buffer)) choices)))
    (nreverse choices)))

;;;###autoload
(defun noema-sessions-switch ()
  "Switch to a named agent session of this project, or any live agent buffer."
  (interactive)
  (let* ((root (noema-sessions--project-root))
         (result (and (bound-and-true-p my/noema--ready)
                      (fboundp 'my/noema--api-call-sync)
                      (ignore-errors
                        (my/noema--api-call-sync "aaronnote:api:research:session:names"
                                                 (vector `((cwd . ,root))) 2))))
         (choices (noema-sessions--switch-candidates
                   (noema-sessions--list (noema-sessions--get result "names")) root)))
    (unless choices (user-error "No Noema agent sessions or buffers"))
    (let* ((label (completing-read "Noema session: " choices nil t))
           (choice (cdr (assoc label choices))))
      (if (cdr choice)
          (noema-agent-acp-show-buffer (cdr choice))
        (noema-sessions--visit-entry (car choice) root)))))

(provide 'noema-sessions)
;;; noema-sessions.el ends here
