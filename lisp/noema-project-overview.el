;;; noema-project-overview.el --- One project entry point for Noema -*- lexical-binding: t; -*-

;;; Commentary:
;; This is a read-only Emacs projection of the existing research and capability
;; APIs.  The objects remain owned by their existing services and commands.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'button)
(require 'noema-api)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function noema-sessions "noema-sessions" (&optional scope))
(declare-function noema-agent-inbox "noema-agent-inbox" ())
(declare-function noema-sessions-open-reference "noema-sessions" (root &optional name session-id))
(declare-function noema-orchestration "noema-orchestration" (&optional directory))
(declare-function noema-capability-manager "noema-capability-ui" (&optional project type))
(declare-function noema-research-attention "noema-research-inspector" (&optional origin))
(declare-function my/noema-agenda "init-aaronnote" (&optional query))
(declare-function my/noema-workspace-graph "init-aaronnote" ())
(declare-function noema-research-goto-cell "noema-research-mode" (id))
(declare-function noema-research-workflow-preview "noema-research-workflow" (kind file title))
(declare-function noema-history-search "noema-history-search" (&optional directory query))
(declare-function noema-findings "noema-findings" (&optional directory))

(autoload 'noema-research-workflow-preview "noema-research-workflow" nil t)
(autoload 'noema-history-search "noema-history-search" nil t)
(autoload 'noema-findings "noema-findings" nil t)

(defvar-local noema-project-overview--root nil)
(defvar-local noema-project-overview--responses nil)
(defvar-local noema-project-overview--pending nil)
(defvar-local noema-project-overview--generation 0)
(defvar noema-project-overview--request-serial 0
  "Monotonic request id across buffer mode resets and projects.")

(defconst noema-project-overview--queries
  '((tasks . "task:list") (runs . "run:list") (sessions . "session:names")
    (attention . "attention:list") (capabilities . "capability:list")))

(defun noema-project-overview--list (value)
  "Return VALUE as a list of records."
  (noema--sequence value))

(defun noema-project-overview--field (record field &optional fallback)
  "Return FIELD in RECORD, or FALLBACK."
  (or (noema--value record field) fallback))

(defun noema-project-overview--button (label function &optional help)
  "Insert LABEL as a button invoking FUNCTION."
  (insert-text-button label 'follow-link t 'help-echo help
                      'action (lambda (_button) (funcall function))))

(defun noema-project-overview--open (function)
  "Run FUNCTION with the overview's project selected."
  (let ((default-directory noema-project-overview--root))
    (funcall function)))

(defun noema-project-overview--open-run (root run)
  "Open RUN's source cell in ROOT, using the durable identity resolver."
  (let ((notebook-id (noema-project-overview--field run "notebookId"))
        (cell-id (noema-project-overview--field run "cellId")))
    (unless (and notebook-id cell-id)
      (user-error "This Run has no source work block"))
    (my/noema-api-call
     "aaronnote:api:research:cell:resolve"
     (vector `((cwd . ,root) (notebookId . ,notebook-id) (cellId . ,cell-id)))
     (lambda (result error-object)
       (if error-object
           (message "Noema: %s" (noema-project-overview--field error-object "message" "Unable to resolve Run"))
         (when-let* ((file (noema-project-overview--field result "file")))
           (find-file file)
           (noema-research-goto-cell cell-id)))))))

(defun noema-project-overview--render-summary (responses)
  "Insert the project summary from RESPONSES."
  (let* ((tasks (noema-project-overview--list
                 (noema-project-overview--field (gethash 'tasks responses) "tasks")))
         (runs (noema-project-overview--list
                (noema-project-overview--field (gethash 'runs responses) "runs")))
         (sessions (noema-project-overview--list
                    (noema-project-overview--field (gethash 'sessions responses) "names")))
         (attention (gethash 'attention responses))
         (waiting (+ (length (noema-project-overview--list
                             (noema-project-overview--field attention "permissions")))
                     (length (noema-project-overview--list
                              (noema-project-overview--field attention "inputRequests")))
                     (length (noema-project-overview--list
                              (noema-project-overview--field attention "proposals")))))
         (open (seq-count (lambda (task)
                            (equal (noema-project-overview--field task "state") "open")) tasks))
         (blocked (seq-count (lambda (task)
                               (equal (noema-project-overview--field task "state") "blocked")) tasks))
         (failed (seq-count (lambda (run)
                              (member (noema-project-overview--field run "status")
                                      '("failed" "interrupted"))) runs)))
    (insert (format "Tasks %d (%d open, %d blocked)   Runs %d (%d failed/interrupted)   Sessions %d   Attention %d\n\n"
                    (length tasks) open blocked (length runs) failed (length sessions) waiting))))

(defun noema-project-overview--render ()
  "Draw the current project snapshot in this buffer."
  (let ((inhibit-read-only t)
        (root noema-project-overview--root)
        (responses noema-project-overview--responses)
        (pending noema-project-overview--pending))
    (erase-buffer)
    (insert (propertize (format "Noema · %s\n"
                                (file-name-nondirectory (directory-file-name root)))
                        'face '(:height 1.35 :weight bold))
            root "\n\n")
    (noema-project-overview--button "Sessions" (lambda () (noema-project-overview--open
                                                              (lambda () (require 'noema-sessions) (noema-sessions 'project)))))
    (insert "   ")
    (noema-project-overview--button "All agents" (lambda () (require 'noema-agent-inbox)
                                                   (noema-agent-inbox)))
    (insert "   ")
    (noema-project-overview--button "Skills / MCP" (lambda () (noema-project-overview--open
                                                                  (lambda () (require 'noema-capability-ui)
                                                                    (noema-capability-manager root nil)))))
    (insert "   ")
    (noema-project-overview--button "Work queue" (lambda () (noema-project-overview--open
                                                                (lambda () (require 'noema-orchestration)
                                                                  (noema-orchestration root)))))
    (insert "   ")
    (noema-project-overview--button "Attention" (lambda () (noema-project-overview--open
                                                               (lambda () (require 'noema-research-inspector)
                                                                 (noema-research-attention root)))))
    (insert "   ")
    (noema-project-overview--button "Agenda" (lambda () (noema-project-overview--open
                                                            (lambda () (my/noema-agenda)))))
    (insert "   ")
    (noema-project-overview--button "New workflow" (lambda ()
                                                        (noema-project-overview--open
                                                         (lambda () (call-interactively
                                                                     #'noema-research-workflow-preview)))))
    (insert "   ")
    (noema-project-overview--button "History search" (lambda ()
                                                          (noema-project-overview--open
                                                           (lambda () (call-interactively
                                                                       #'noema-history-search)))))
    (insert "   ")
    (noema-project-overview--button "Findings" (lambda ()
                                                   (noema-project-overview--open
                                                    (lambda () (noema-findings root)))))
    (insert "\n\n")
    (if pending
        (insert (format "Loading %s…\n\n" (mapconcat #'symbol-name pending ", ")))
      (noema-project-overview--render-summary responses))
    (let ((attention (gethash 'attention responses)))
      (when attention
        (insert (propertize "Needs your decision\n" 'face 'bold))
        (dolist (item (seq-take (noema-project-overview--list
                                 (noema-project-overview--field attention "proposals")) 5))
          (insert (format "  Proposal %s · %s\n"
                          (noema-project-overview--field item "kind" "review")
                          (noema-project-overview--field item "id" ""))))
        (when (or (noema-project-overview--list (noema-project-overview--field attention "permissions"))
                  (noema-project-overview--list (noema-project-overview--field attention "inputRequests")))
          (insert "  Agent permission or input is waiting; open Attention.\n"))
        (insert "\n")))
    (let ((tasks (noema-project-overview--list
                  (noema-project-overview--field (gethash 'tasks responses) "tasks"))))
      (when tasks
        (insert (propertize "Recent work\n" 'face 'bold))
        (dolist (item (seq-take tasks 8))
          (let ((title (noema-project-overview--field item "title" "Untitled")))
            (insert (format "  %-12s " (noema-project-overview--field item "state" "open")))
            (noema-project-overview--button
             title
             (lambda () (noema-project-overview--open
                           (lambda () (require 'noema-orchestration) (noema-orchestration root)))))
            (insert "\n")))
        (insert "\n")))
    (let ((runs (noema-project-overview--list
                 (noema-project-overview--field (gethash 'runs responses) "runs"))))
      (when runs
        (insert (propertize "Recent runs\n" 'face 'bold))
        (dolist (run (seq-take runs 8))
          (let ((selected-run run))
            (insert (format "  %-18s " (noema-project-overview--field run "status" "unknown")))
            (noema-project-overview--button
             (noema-project-overview--field run "id" "")
             (lambda () (noema-project-overview--open-run root selected-run))
             "Open source work block")
            (insert "\n")))
        (insert "\n")))
    (let ((sessions (noema-project-overview--list
                     (noema-project-overview--field (gethash 'sessions responses) "names"))))
      (when sessions
        (insert (propertize "Reusable agents / sessions\n" 'face 'bold))
        (dolist (entry (seq-take sessions 8))
          (let ((name (noema-project-overview--field entry "name"))
                (agent (noema-project-overview--field entry "agent" "agent"))
                (session-id (noema-project-overview--field entry "sessionId")))
            (insert (format "  %-14s " agent))
            (noema-project-overview--button
             (or name session-id "Unnamed session")
             (lambda () (require 'noema-sessions)
               (noema-sessions-open-reference root name session-id))
             "Reuse the existing conversation")
            (insert "\n")))
        (insert "\n")))
    (let* ((capabilities (noema-project-overview--field
                          (gethash 'capabilities responses) "capabilities"))
           (active (noema-project-overview--field capabilities "active")))
      (when active
        (insert (propertize "Active capabilities\n" 'face 'bold))
        (insert (format "  Skills: %s\n  MCP: %s\n\n"
                        (or (string-join (noema-project-overview--list
                                          (noema-project-overview--field active "skills")) ", ") "")
                        (or (string-join (noema-project-overview--list
                                          (noema-project-overview--field active "mcps")) ", ") "")))))
    (dolist (query noema-project-overview--queries)
      (when-let* ((error-object (gethash (intern (format "%s-error" (car query))) responses)))
        (insert (propertize
                 (format "%s: %s\n" (car query)
                         (noema-project-overview--field error-object "message" "unavailable"))
                 'face 'error))))
    (goto-char (point-min))))

(defun noema-project-overview-refresh ()
  "Refresh this project's overview from the existing Noema APIs."
  (interactive)
  (unless (and noema-project-overview--root (fboundp 'my/noema-api-call))
    (user-error "Noema project host is unavailable"))
  (setq noema-project-overview--generation
        (cl-incf noema-project-overview--request-serial))
  (let ((buffer (current-buffer))
        (root noema-project-overview--root)
        (generation noema-project-overview--generation))
    (setq noema-project-overview--responses (make-hash-table :test 'eq)
          noema-project-overview--pending (mapcar #'car noema-project-overview--queries))
    (noema-project-overview--render)
    (dolist (query noema-project-overview--queries)
      (let ((name (car query))
            (channel (cdr query)))
        (my/noema-api-call
         (format "aaronnote:api:research:%s" channel)
         (vector `((cwd . ,root) (limit . 50)))
         (lambda (result error-object)
           (when (and (buffer-live-p buffer)
                      (equal generation (buffer-local-value 'noema-project-overview--generation buffer))
                      (equal root (buffer-local-value 'noema-project-overview--root buffer)))
             (with-current-buffer buffer
               (puthash (if error-object (intern (format "%s-error" name)) name)
                        (or error-object result) noema-project-overview--responses)
               (setq noema-project-overview--pending (delq name noema-project-overview--pending))
               (noema-project-overview--render))))
         30)))))

(defvar noema-project-overview-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-project-overview-refresh)
    map))

(define-derived-mode noema-project-overview-mode special-mode "Noema-Project"
  "Browse one Noema project's work, agents and capabilities."
  (setq-local revert-buffer-function (lambda (&rest _) (noema-project-overview-refresh))))

;;;###autoload
(defun noema-project-overview (&optional directory)
  "Open the unified Noema project entry point for DIRECTORY."
  (interactive)
  (let* ((root (or (noema-current-project (or directory default-directory))
                   (user-error "No Noema project here")))
         (buffer (get-buffer-create (format "*Noema Project: %s <%s>*"
                                            (file-name-nondirectory (directory-file-name root))
                                            (substring (secure-hash 'sha256 root) 0 8)))))
    (with-current-buffer buffer
      (noema-project-overview-mode)
      (setq noema-project-overview--root root
            default-directory root))
    (pop-to-buffer buffer)
    (if (fboundp 'my/noema--ensure-server)
        (my/noema--ensure-server
         (lambda () (when (buffer-live-p buffer)
                      (with-current-buffer buffer (noema-project-overview-refresh)))))
      (with-current-buffer buffer (noema-project-overview-refresh)))
    buffer))

(provide 'noema-project-overview)
;;; noema-project-overview.el ends here
