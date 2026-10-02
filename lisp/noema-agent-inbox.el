;;; noema-agent-inbox.el --- Agent attention across Noema Projects -*- lexical-binding: t; -*-

;;; Commentary:
;; A read-only Emacs view over existing Project Session registries and live
;; agent-shell buffers.  Noema Projects remain defined by noema.toml, and the
;; host remains the authority for Run and attention state.

;;; Code:

(require 'cl-lib)
(require 'project)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-research)
(require 'noema-sessions)

(declare-function my/noema-workspace-root "init-aaronnote" ())
(declare-function remote-file-name-target "remote-fs" (file-name))

(defvar-local noema-agent-inbox--roots nil)
(defvar-local noema-agent-inbox--results nil)
(defvar-local noema-agent-inbox--pending nil)
(defvar-local noema-agent-inbox--generation 0)
(defvar-local noema-agent-inbox--actions nil)
(defvar-local noema-agent-inbox--refresh-timer nil)
(defvar-local noema-agent-inbox--needs-host-refresh nil)
(defvar-local noema-agent-inbox--dirty-roots nil)
(defvar-local noema-agent-inbox--request-serials nil)
(defvar noema-agent-inbox--serial 0)

(defconst noema-agent-inbox--buffer-name "*Noema Agents*")
(defconst noema-agent-inbox--refresh-delay 0.4
  "Seconds to combine bursts of agent events into one Inbox update.")

(defconst noema-agent-inbox--skip-directories
  '(".git" ".noema" ".agent" "node_modules" "vendor" "dist" "build")
  "Generated or internal directories omitted during explicit note-root discovery.")

(defun noema-agent-inbox--note-root ()
  "Return the configured local Noema note root, if available."
  (let ((root (if (fboundp 'my/noema-workspace-root)
                  (my/noema-workspace-root)
                (or (getenv "NOEMA_ROOT") "~/Documents/Noema"))))
    (when (and (stringp root) (file-directory-p root)
               (not (file-remote-p root)))
      (file-name-as-directory (expand-file-name root)))))

(defun noema-agent-inbox--note-projects ()
  "Discover Project manifests under the local note root, without opening them.
This runs only when the inbox opens or the person requests a rescan.  It does
not descend into Noema's disposable worktrees or generated directories."
  (when-let* ((root (noema-agent-inbox--note-root)))
    (let ((pending (list root)) found)
      (while pending
        (let ((directory (pop pending)))
          (condition-case nil
              (dolist (path (directory-files directory t directory-files-no-dot-files-regexp))
                (cond
                 ((equal (file-name-nondirectory path) noema-project-manifest)
                  (when (equal (noema-project-root directory)
                               (file-name-as-directory directory))
                    (push (file-name-as-directory directory) found)))
                 ((and (file-directory-p path)
                       (not (file-symlink-p path))
                       (not (member (file-name-nondirectory path)
                                    noema-agent-inbox--skip-directories)))
                  (push path pending))))
            (file-error nil))))
      found)))

(defun noema-agent-inbox--project-root (path)
  "Resolve PATH through Noema's Project rule, without creating a Project."
  (when (stringp path)
    (ignore-errors (noema-project-root path))))

(defun noema-agent-inbox--known-roots ()
  "Return Projects known from notes, Emacs projects, buffers and live agents."
  (let ((candidates (noema-agent-inbox--note-projects)))
    (dolist (root (project-known-project-roots))
      (push root candidates))
    (dolist (buffer (buffer-list))
      (when-let* ((file (buffer-local-value 'buffer-file-name buffer)))
        (push file candidates)))
    (dolist (session (noema-agent-acp-sessions))
      (push (plist-get session :root) candidates))
    (push default-directory candidates)
    (sort (delete-dups (delq nil (mapcar #'noema-agent-inbox--project-root candidates)))
          #'string-lessp)))

(defun noema-agent-inbox--target (path)
  "Return the Remote target of PATH, or local for a native path."
  (or (and (stringp path) (fboundp 'remote-file-name-target)
           (ignore-errors (remote-file-name-target path)))
      "local"))

(defun noema-agent-inbox--attention-rank (entry)
  "Sort ENTRY by the host's attention result before quieter sessions."
  (pcase (noema-sessions--string entry "attentionReason")
    ((or "permission" "input") 0)
    ("failed" 1)
    (_ (cond ((noema-sessions--true-p (noema-sessions--get entry "unread")) 2)
             ((noema-sessions--get entry "openRun") 3)
             (t 4)))))

(defun noema-agent-inbox--project-label (root)
  "Return a compact but unambiguous label for ROOT."
  (abbreviate-file-name (directory-file-name root)))

(defun noema-agent-inbox--durable-row (root entry)
  "Return a display row and its action for ENTRY in Project ROOT."
  (let* ((name (noema-sessions--string entry "name"))
         (session-id (noema-sessions--string entry "sessionId"))
         (buffer (noema-sessions--live-buffer entry root))
         (run (noema-sessions--get entry "lastRun"))
         (target (noema-agent-inbox--target
                  (if buffer (buffer-local-value 'default-directory buffer)
                    (noema-sessions--string entry "executionTarget"))))
         (rank (if (and buffer (noema-agent-acp-busy-p buffer))
                   (min 3 (noema-agent-inbox--attention-rank entry))
                 (noema-agent-inbox--attention-rank entry)))
         (id (list 'durable root (or session-id name))))
    (list rank id
          (vector (noema-sessions--attention entry)
                  (noema-agent-inbox--project-label root)
                  target
                  (or name "")
                  (or (noema-sessions--string entry "agent") "")
                  (if (and buffer (not (noema-sessions--get entry "openRun")))
                      (if (noema-agent-acp-busy-p buffer) "working" "live")
                    (noema-sessions--status entry root))
                  (if run (noema-sessions--last-run run) ""))
          (list :kind 'durable :root root :name name :session-id session-id
                :entry entry :last-run run))))

(defun noema-agent-inbox--local-row (session)
  "Return a display row and action for a live SESSION without a host row."
  (let* ((buffer (plist-get session :buffer))
         (root (or (plist-get session :root) default-directory))
         (busy (plist-get session :busy))
         (id (list 'local buffer)))
    (list (if busy 3 4) id
          (vector "" (noema-agent-inbox--project-label root)
                  (noema-agent-inbox--target
                   (buffer-local-value 'default-directory buffer))
                  (or (plist-get session :name) (buffer-name buffer))
                  (or (plist-get session :agent) "")
                  (if busy "working" "live") "")
          (list :kind 'local :root root :buffer buffer))))

(defun noema-agent-inbox--make-rows ()
  "Return the current unified rows, deduplicating live and durable sessions."
  (let ((bound (make-hash-table :test #'equal)) rows)
    (dolist (root noema-agent-inbox--roots)
      (when-let* ((error-object (plist-get (gethash root noema-agent-inbox--results)
                                           :error)))
        (push (list 0 (list 'error root)
                    (vector "!error" (noema-agent-inbox--project-label root) ""
                            "" "" "error" (noema-sessions--error error-object))
                    (list :kind 'error :root root :error error-object))
              rows))
      (dolist (entry (noema-sessions--list
                      (noema-sessions--get (gethash root noema-agent-inbox--results)
                                           "names")))
        (when-let* ((buffer (noema-sessions--live-buffer entry root)))
          (puthash buffer t bound))
        (push (noema-agent-inbox--durable-row root entry) rows)))
    (dolist (session (noema-agent-acp-sessions))
      (unless (gethash (plist-get session :buffer) bound)
        (push (noema-agent-inbox--local-row session) rows)))
    (sort rows (lambda (a b)
                 (cond ((/= (car a) (car b)) (< (car a) (car b)))
                       ((not (equal (aref (nth 2 a) 1) (aref (nth 2 b) 1)))
                        (string-lessp (aref (nth 2 a) 1) (aref (nth 2 b) 1)))
                       (t (string-lessp (aref (nth 2 a) 3) (aref (nth 2 b) 3))))))))

(defun noema-agent-inbox--render ()
  "Display the latest received Project rows."
  (let ((rows (noema-agent-inbox--make-rows))
        (errors 0))
    (setq noema-agent-inbox--actions (make-hash-table :test #'equal))
    (setq tabulated-list-entries
          (mapcar (lambda (row)
                    (puthash (nth 1 row) (nth 3 row) noema-agent-inbox--actions)
                    (list (nth 1 row) (nth 2 row)))
                  rows))
    (maphash (lambda (_root response)
               (when (plist-get response :error) (cl-incf errors)))
             noema-agent-inbox--results)
    (setq header-line-format
          (format "Noema agents · %d Projects · %d Sessions · %d loading · %d errors  |  RET open  ! next alert  u read  j WorkNode  p Project  s Sessions  g refresh  G rescan"
                  (length noema-agent-inbox--roots) (- (length rows) errors)
                  (length noema-agent-inbox--pending) errors))
    (tabulated-list-print t)))

(defun noema-agent-inbox--request (buffer generation root)
  "Fetch ROOT's named sessions for BUFFER at GENERATION."
  (let ((serial (cl-incf noema-agent-inbox--serial)))
    (puthash root serial noema-agent-inbox--request-serials)
    (noema-sessions--api
     "aaronnote:api:research:session:names" `((root . ,root))
     (lambda (result error-object)
       (when (and (buffer-live-p buffer)
                  (= generation (buffer-local-value 'noema-agent-inbox--generation buffer)))
         (with-current-buffer buffer
           (when (equal serial (gethash root noema-agent-inbox--request-serials))
             (puthash root (if error-object (list :error error-object) result)
                      noema-agent-inbox--results)
             (setq noema-agent-inbox--pending
                   (delete root noema-agent-inbox--pending))
             (noema-agent-inbox--render))))))))

(defun noema-agent-inbox-refresh (&optional rescan)
  "Refresh the global inbox.  With RESCAN, discover Project roots again."
  (interactive "P")
  (when (timerp noema-agent-inbox--refresh-timer)
    (cancel-timer noema-agent-inbox--refresh-timer))
  (setq noema-agent-inbox--refresh-timer nil
        noema-agent-inbox--needs-host-refresh nil
        noema-agent-inbox--dirty-roots nil)
  (when (or rescan (null noema-agent-inbox--roots))
    (setq noema-agent-inbox--roots (noema-agent-inbox--known-roots)))
  (setq noema-agent-inbox--generation (cl-incf noema-agent-inbox--serial)
        noema-agent-inbox--results (make-hash-table :test #'equal)
        noema-agent-inbox--request-serials (make-hash-table :test #'equal)
        noema-agent-inbox--pending (copy-sequence noema-agent-inbox--roots))
  (noema-agent-inbox--render)
  (let ((buffer (current-buffer))
        (generation noema-agent-inbox--generation))
    (dolist (root noema-agent-inbox--roots)
      (noema-agent-inbox--request buffer generation root))))

(defun noema-agent-inbox--refresh-roots (roots)
  "Fetch only ROOTS, preserving cached rows from other Projects."
  (let ((buffer (current-buffer))
        (generation noema-agent-inbox--generation))
    (dolist (root roots)
      (cl-pushnew root noema-agent-inbox--pending :test #'equal))
    (noema-agent-inbox--render)
    (dolist (root roots)
      (noema-agent-inbox--request buffer generation root))))

(defun noema-agent-inbox--visible-window (buffer)
  "Return a visible window displaying BUFFER."
  (get-buffer-window buffer 'visible))

(defun noema-agent-inbox--unsubscribe ()
  "Stop listening while the Inbox is hidden or closed."
  (remove-hook 'noema-agent-acp-changed-functions
               #'noema-agent-inbox--session-changed)
  (remove-hook 'noema-agent-worker-run-finished-functions
               #'noema-agent-inbox--worker-changed)
  (remove-hook 'noema-agent-worker-attention-changed-functions
               #'noema-agent-inbox--worker-changed))

(defun noema-agent-inbox--subscribe ()
  "Listen for changes to live agents and recorded Runs."
  (add-hook 'noema-agent-acp-changed-functions
            #'noema-agent-inbox--session-changed)
  (add-hook 'noema-agent-worker-run-finished-functions
            #'noema-agent-inbox--worker-changed)
  (add-hook 'noema-agent-worker-attention-changed-functions
            #'noema-agent-inbox--worker-changed))

(defun noema-agent-inbox--queue-update (host-refresh &optional root)
  "Schedule an Inbox update for ROOT, or all Projects if HOST-REFRESH."
  (when-let* ((buffer (get-buffer noema-agent-inbox--buffer-name)))
    (with-current-buffer buffer
      (when (and root (hash-table-p noema-agent-inbox--results))
        (unless (member root noema-agent-inbox--roots)
          (setq noema-agent-inbox--roots
                (sort (cons root noema-agent-inbox--roots) #'string-lessp)))
        (cl-pushnew root noema-agent-inbox--dirty-roots :test #'equal))
      (if (not (noema-agent-inbox--visible-window buffer))
          (noema-agent-inbox--unsubscribe)
        (setq noema-agent-inbox--needs-host-refresh
              (or host-refresh (null noema-agent-inbox--results)
                  noema-agent-inbox--needs-host-refresh))
        (unless (timerp noema-agent-inbox--refresh-timer)
          (setq noema-agent-inbox--refresh-timer
                (run-with-timer noema-agent-inbox--refresh-delay nil
                                #'noema-agent-inbox--timer-fire buffer)))))))

(defun noema-agent-inbox--session-changed (_buffer)
  "Update live agent state without querying the host."
  (noema-agent-inbox--queue-update nil))

(defun noema-agent-inbox--worker-changed (worker &rest _event)
  "Refresh WORKER's Project after a Run or attention event."
  (let* ((path (and (fboundp 'noema-agent-worker-p)
                    (noema-agent-worker-p worker)
                    (noema-agent-worker-root worker)))
         (root (and path (noema-agent-inbox--project-root path))))
    (noema-agent-inbox--queue-update (not root) root)))

(defun noema-agent-inbox--timer-fire (buffer)
  "Update visible Inbox BUFFER after combining recent agent events."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq noema-agent-inbox--refresh-timer nil)
      (if-let* ((window (noema-agent-inbox--visible-window buffer)))
          (let ((host-refresh noema-agent-inbox--needs-host-refresh)
                (roots (nreverse noema-agent-inbox--dirty-roots)))
            (setq noema-agent-inbox--needs-host-refresh nil
                  noema-agent-inbox--dirty-roots nil)
            (with-selected-window window
              (cond (host-refresh (noema-agent-inbox-refresh
                                   (null noema-agent-inbox--results)))
                    (roots (noema-agent-inbox--refresh-roots roots))
                    (t (noema-agent-inbox--render)))))
        (noema-agent-inbox--unsubscribe)))))

(defun noema-agent-inbox--shown (_window)
  "Catch up on agent and host changes when the Inbox becomes visible."
  (when (and (noema-agent-inbox--visible-window (current-buffer))
             (not (memq #'noema-agent-inbox--session-changed
                        noema-agent-acp-changed-functions)))
    (noema-agent-inbox--subscribe)
    (noema-agent-inbox--queue-update t)))

(defun noema-agent-inbox--teardown ()
  "Cancel a pending Inbox update and detach global listeners."
  (when (timerp noema-agent-inbox--refresh-timer)
    (cancel-timer noema-agent-inbox--refresh-timer))
  (setq noema-agent-inbox--refresh-timer nil)
  (setq noema-agent-inbox--dirty-roots nil)
  (noema-agent-inbox--unsubscribe))

(defun noema-agent-inbox--selected ()
  "Return the selected row action, or signal when point is off a row."
  (or (gethash (tabulated-list-get-id) noema-agent-inbox--actions)
      (user-error "No agent session on this line")))

(defun noema-agent-inbox-visit ()
  "Open the selected live buffer or durable conversation."
  (interactive)
  (let ((row (noema-agent-inbox--selected)))
    (pcase (plist-get row :kind)
      ('local (if (buffer-live-p (plist-get row :buffer))
                  (noema-agent-acp-show-buffer (plist-get row :buffer))
                (user-error "Agent buffer has closed; press g to refresh")))
      ('durable (noema-sessions-open-reference
                 (plist-get row :root) (plist-get row :name)
                 (plist-get row :session-id)))
      ('error (user-error "Project session query failed: %s"
                          (noema-sessions--error (plist-get row :error)))))))

(defun noema-agent-inbox-next-attention ()
  "Move to the next Session needing attention, wrapping across Projects."
  (interactive)
  (let ((origin (line-beginning-position)) positions)
    (save-excursion
      (goto-char (point-min))
      (while (not (eobp))
        (let ((row (and (hash-table-p noema-agent-inbox--actions)
                        (gethash (tabulated-list-get-id) noema-agent-inbox--actions))))
          (when (and (eq (plist-get row :kind) 'durable)
                     (not (string-empty-p
                           (noema-sessions--attention (plist-get row :entry)))))
            (push (line-beginning-position) positions)))
        (forward-line 1)))
    (setq positions (nreverse positions))
    (if-let* ((next (or (seq-find (lambda (position) (> position origin)) positions)
                        (car positions))))
        (goto-char next)
      (message "No agent session needs attention"))))

(defun noema-agent-inbox-mark-read ()
  "Mark the selected durable Session read, keeping failures actionable."
  (interactive)
  (let* ((row (noema-agent-inbox--selected))
         (root (plist-get row :root))
         (buffer (current-buffer)))
    (unless (eq (plist-get row :kind) 'durable)
      (user-error "Only a recorded Noema Session can be marked read"))
    (noema-sessions--mark-read
     root (plist-get row :name)
     (lambda (ok)
       (when (and ok (buffer-live-p buffer))
         (with-current-buffer buffer
           (noema-agent-inbox--queue-update nil root)))))))

(defun noema-agent-inbox-project ()
  "Open the selected session's Project overview."
  (interactive)
  (let ((root (plist-get (noema-agent-inbox--selected) :root)))
    (unless (and root (noema-project-root root))
      (user-error "This live agent has no Noema Project"))
    (require 'noema-project-overview)
    (noema-project-overview root)))

(defun noema-agent-inbox-jump ()
  "Visit the selected session's latest work block by durable Cell identity."
  (interactive)
  (let ((row (noema-agent-inbox--selected)))
    (unless (eq (plist-get row :kind) 'durable)
      (user-error "This row has no recorded Noema Run"))
    (noema-sessions--jump-to-run
     (plist-get row :root) (plist-get row :name) (plist-get row :last-run))
    (noema-sessions--note-read (plist-get row :entry) (plist-get row :root))))

(defun noema-agent-inbox-sessions ()
  "Open the selected session's Project session list."
  (interactive)
  (let ((root (plist-get (noema-agent-inbox--selected) :root)))
    (unless (and root (noema-project-root root))
      (user-error "This live agent has no Noema Project"))
    (let ((default-directory root))
      (noema-sessions 'project))))

(defvar noema-agent-inbox-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'noema-agent-inbox-visit)
    (define-key map (kbd "!") #'noema-agent-inbox-next-attention)
    (define-key map (kbd "u") #'noema-agent-inbox-mark-read)
    (define-key map (kbd "j") #'noema-agent-inbox-jump)
    (define-key map (kbd "p") #'noema-agent-inbox-project)
    (define-key map (kbd "s") #'noema-agent-inbox-sessions)
    (define-key map (kbd "g") #'noema-agent-inbox-refresh)
    (define-key map (kbd "G") (lambda () (interactive) (noema-agent-inbox-refresh t)))
    map))

(define-derived-mode noema-agent-inbox-mode tabulated-list-mode "Noema-Agents"
  "Browse agent sessions across known Noema Projects.
RET opens a conversation, ! moves to the next alert, u marks it read,
j visits its latest work block,
p opens its Project, s opens its Session list.
g refreshes status; G rescans the note root and Emacs' known projects."
  (setq tabulated-list-format
        [("Need" 9 t) ("Project" 38 t) ("Target" 12 t)
         ("Session" 26 t) ("Agent" 12 t) ("State" 12 t)
         ("Last Run" 32 t)])
  (setq-local revert-buffer-function (lambda (&rest _) (noema-agent-inbox-refresh)))
  (add-hook 'window-buffer-change-functions #'noema-agent-inbox--shown nil t)
  (add-hook 'kill-buffer-hook #'noema-agent-inbox--teardown nil t)
  (tabulated-list-init-header))

;;;###autoload
(defun noema-agent-inbox ()
  "Open the Emacs-native agent inbox for known Noema Projects."
  (interactive)
  (let ((buffer (get-buffer-create noema-agent-inbox--buffer-name)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-agent-inbox-mode)
        (noema-agent-inbox-mode))
      (setq default-directory (or (noema-agent-inbox--note-root) default-directory))
      (noema-agent-inbox--subscribe))
    (pop-to-buffer buffer)
    (noema-sessions--ensure-host
     (lambda ()
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-agent-inbox-refresh t)))))
    buffer))

(provide 'noema-agent-inbox)
;;; noema-agent-inbox.el ends here
