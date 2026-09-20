;;; noema-orchestration.el --- Board for the Task/Job/Delegation model -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; The kernel has owned a Task/Job/Invocation/Worker/Delegation model for a
;; long time, and `orchestration:snapshot' has always returned all of it at
;; once.  Nothing consumed it: the desktop Orchestration Lab was retired with
;; D-016/D-017 and nothing replaced it, so the richer of Noema's two flow
;; models had no surface at all.  This is that surface.
;;
;; It is deliberately a reader.  The Graph Board is where work is authored and
;; Runs are started; this answers the questions that board cannot: what has
;; been decomposed, what is queued behind what, which worker holds a claim,
;; and which agent delegated to which.  One snapshot feeds every view, so
;; switching views costs nothing and the whole board is one consistent moment
;; rather than five independent reads.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function noema-project-root "noema-research" (&optional directory))
(defvar my/noema--ready)

(defgroup noema-orchestration nil
  "Reading Noema's Task/Job/Invocation/Worker/Delegation model."
  :group 'applications)

(defcustom noema-orchestration-event-limit 200
  "How many of the most recent events the Events view shows."
  :type 'integer
  :group 'noema-orchestration)

(defconst noema-orchestration-views '("tasks" "jobs" "workers" "delegations" "events")
  "Views this board can show, in cycling order.")

(defvar-local noema-orchestration--root nil "Project root this board reads.")
(defvar-local noema-orchestration--workstream nil "Workstream filter, or nil.")
(defvar-local noema-orchestration--view "tasks" "View currently shown.")
(defvar-local noema-orchestration--snapshot nil "Latest orchestration snapshot.")


;;;; JSON-ish accessors

(defun noema-orchestration--get (object key &optional default)
  "Read string KEY from JSON-like OBJECT, returning DEFAULT when absent."
  (let ((value (cond ((hash-table-p object) (gethash key object default))
                     ((and (listp object) (consp (car-safe object)))
                      (let ((cell (or (assoc key object) (assq (intern key) object))))
                        (if cell (cdr cell) default)))
                     (t default))))
    (if (memq value '(:null :false)) default value)))

(defun noema-orchestration--string (object key &optional default)
  "Read a non-empty string KEY from OBJECT, or DEFAULT."
  (let ((value (noema-orchestration--get object key)))
    (if (and (stringp value) (not (string-empty-p value))) value default)))

(defun noema-orchestration--list (value)
  "Return JSON array VALUE as a list."
  (cond ((vectorp value) (append value nil))
        ((listp value) value)))

(defun noema-orchestration--time (timestamp)
  "Return a compact local rendering of RFC 3339 TIMESTAMP."
  (or (and (stringp timestamp)
           (ignore-errors (format-time-string "%m-%d %H:%M" (date-to-time timestamp))))
      ""))

(defun noema-orchestration--count (value)
  "Return how many entries JSON array VALUE holds, as a string."
  (let ((items (noema-orchestration--list value)))
    (if items (number-to-string (length items)) "")))


;;;; Views
;;
;; Each view is (COLUMNS ROW-FUNCTION RECORDS-KEY).  A row's id is the whole
;; record, so RET can show it without looking anything up again.

(defun noema-orchestration--task-row (task)
  "Return the tabulated row for TASK."
  (list task
        (vector (noema-orchestration--string task "title"
                                             (noema-orchestration--string task "id" ""))
                (noema-orchestration--string task "state" "")
                (format "%s" (or (noema-orchestration--get task "priority") ""))
                (noema-orchestration--count (noema-orchestration--get task "dependsOn"))
                (if (noema-orchestration--string task "parentTaskId") "sub" "")
                (noema-orchestration--string task "createdBy" "")
                (noema-orchestration--time (noema-orchestration--string task "updatedAt")))))

(defun noema-orchestration--job-row (job)
  "Return the tabulated row for JOB."
  (let ((effects (noema-orchestration--get job "effects"))
        (retry (noema-orchestration--get job "retry")))
    (list job
          (vector (noema-orchestration--string job "id" "")
                  (noema-orchestration--string job "kind" "")
                  (noema-orchestration--string job "state" "")
                  (noema-orchestration--count (noema-orchestration--get job "dependsOn"))
                  (format "%s" (or (noema-orchestration--get job "attemptsStarted") 0))
                  (noema-orchestration--string effects "class" "")
                  (noema-orchestration--string retry "policy" "")
                  (noema-orchestration--string job "taskId" "")))))

(defun noema-orchestration--worker-row (worker)
  "Return the tabulated row for WORKER."
  (list worker
        (vector (noema-orchestration--string worker "id" "")
                (noema-orchestration--string worker "kind" "")
                (noema-orchestration--string worker "state" "")
                (noema-orchestration--string worker "transport" "")
                (if (noema-orchestration--get worker "inferenceCapable") "yes" "")
                (string-join (noema-orchestration--list
                              (noema-orchestration--get worker "capabilities"))
                             " ")
                (noema-orchestration--time (noema-orchestration--string worker "lastSeenAt")))))

(defun noema-orchestration--delegation-row (delegation)
  "Return the tabulated row for DELEGATION.
The parent and child task read left to right, which is the one thing the
Graph Board cannot show: an agent handing work to another agent."
  (let ((requested-by (noema-orchestration--get delegation "requestedBy")))
    (list delegation
          (vector (noema-orchestration--string delegation "parentTaskId" "")
                  "→"
                  (noema-orchestration--string delegation "childTaskId" "")
                  (noema-orchestration--count (noema-orchestration--get delegation "childJobIds"))
                  (format "%s%s"
                          (noema-orchestration--string requested-by "type" "")
                          (if-let* ((id (noema-orchestration--string requested-by "id")))
                              (concat ":" id) ""))
                  (noema-orchestration--time
                   (noema-orchestration--string delegation "createdAt"))))))

(defun noema-orchestration--event-row (event)
  "Return the tabulated row for EVENT."
  (list event
        (vector (format "%s" (or (noema-orchestration--get event "seq") ""))
                (noema-orchestration--string event "type" "")
                (noema-orchestration--time (noema-orchestration--string event "ts"))
                (or (noema-orchestration--string event "workNodeId")
                    (noema-orchestration--string event "runId")
                    (noema-orchestration--string event "sessionId")
                    ""))))

(defconst noema-orchestration--view-specs
  `(("tasks" "tasks"
     [("Task" 38 t) ("State" 10 t) ("Prio" 5 t) ("Deps" 5 t)
      ("Sub" 4 t) ("By" 14 t) ("Updated" 12 t)]
     noema-orchestration--task-row)
    ("jobs" "jobs"
     [("Job" 22 t) ("Kind" 14 t) ("State" 20 t) ("Deps" 5 t)
      ("Try" 4 t) ("Effect" 20 t) ("Retry" 10 t) ("Task" 22 t)]
     noema-orchestration--job-row)
    ("workers" "workers"
     [("Worker" 22 t) ("Kind" 16 t) ("State" 10 t) ("Transport" 12 t)
      ("Infer" 6 t) ("Capabilities" 30 t) ("Last seen" 12 t)]
     noema-orchestration--worker-row)
    ("delegations" "delegations"
     [("Parent task" 24 t) ("" 2 nil) ("Child task" 24 t) ("Jobs" 5 t)
      ("Requested by" 22 t) ("Created" 12 t)]
     noema-orchestration--delegation-row)
    ("events" "events"
     [("Seq" 8 t) ("Event" 32 t) ("When" 12 t) ("Subject" 30 t)]
     noema-orchestration--event-row))
  "View name to (SNAPSHOT-KEY COLUMNS ROW-FUNCTION).")

(defun noema-orchestration--spec (view)
  "Return the view spec for VIEW."
  (or (assoc view noema-orchestration--view-specs)
      (user-error "Unknown orchestration view: %s" view)))


;;;; Rendering

(defun noema-orchestration--records (view)
  "Return the snapshot records VIEW shows, newest first where that helps."
  (pcase-let ((`(,_name ,key ,_columns ,_row) (noema-orchestration--spec view)))
    (let ((records (noema-orchestration--list
                    (noema-orchestration--get noema-orchestration--snapshot key))))
      (if (equal view "events")
          ;; Events are append-only and can be long; the tail is the part
          ;; anybody wants to see.
          (last records (min (length records) noema-orchestration-event-limit))
        records))))

(defun noema-orchestration--render ()
  "Draw the current view from the cached snapshot."
  (pcase-let ((`(,_name ,_key ,columns ,row) (noema-orchestration--spec
                                              noema-orchestration--view)))
    (let ((records (noema-orchestration--records noema-orchestration--view)))
      (setq tabulated-list-format columns
            tabulated-list-entries (mapcar row records)
            mode-name (format "Noema-Orchestration[%s]" noema-orchestration--view))
      (tabulated-list-init-header)
      (tabulated-list-print t)
      (when (null records)
        (let ((inhibit-read-only t))
          (save-excursion
            (goto-char (point-max))
            (insert (format "\n  No %s in this project yet.\n"
                            noema-orchestration--view))))))))

(defun noema-orchestration-refresh ()
  "Reload this project's orchestration snapshot."
  (interactive)
  (let ((buffer (current-buffer))
        (root noema-orchestration--root)
        (workstream noema-orchestration--workstream))
    (unless (fboundp 'my/noema-api-call)
      (user-error "Noema host integration is unavailable"))
    (my/noema-api-call
     "aaronnote:api:research:orchestration:snapshot"
     (vector `((cwd . ,root)
               ,@(when workstream `((workstreamId . ,workstream)))))
     (lambda (result error-object)
       (if error-object
           (message "Noema orchestration: %s"
                    (or (noema-orchestration--string error-object "message")
                        "request failed"))
         (when (buffer-live-p buffer)
           (with-current-buffer buffer
             (setq noema-orchestration--snapshot result)
             (noema-orchestration--render)))))
     30)))


;;;; Commands

(defun noema-orchestration-set-view (view)
  "Show VIEW in this board, without refetching."
  (interactive (list (completing-read "View: " noema-orchestration-views nil t)))
  (setq noema-orchestration--view view)
  (noema-orchestration--render))

(defun noema-orchestration-cycle-view (&optional backward)
  "Show the next view, or the previous one when BACKWARD is non-nil."
  (interactive "P")
  (let* ((index (or (seq-position noema-orchestration-views noema-orchestration--view) 0))
         (step (if backward -1 1))
         (next (nth (mod (+ index step) (length noema-orchestration-views))
                    noema-orchestration-views)))
    (noema-orchestration-set-view next)))

(defun noema-orchestration-show-record ()
  "Show the complete record on this line.
The board shows what fits in a column; budgets, requirements, acceptance
criteria and event payloads are the reason to look at the whole thing."
  (interactive)
  (let ((record (or (tabulated-list-get-id) (user-error "No record on this line")))
        (buffer (get-buffer-create "*Noema Orchestration Record*")))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (pp-to-string record))
        (goto-char (point-min)))
      (special-mode))
    (display-buffer buffer)))

(defvar noema-orchestration-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'noema-orchestration-show-record)
    (define-key map (kbd "TAB") #'noema-orchestration-cycle-view)
    (define-key map (kbd "<backtab>")
                (lambda () (interactive) (noema-orchestration-cycle-view t)))
    (define-key map (kbd "v") #'noema-orchestration-set-view)
    (define-key map (kbd "t") (lambda () (interactive) (noema-orchestration-set-view "tasks")))
    (define-key map (kbd "j") (lambda () (interactive) (noema-orchestration-set-view "jobs")))
    (define-key map (kbd "w") (lambda () (interactive) (noema-orchestration-set-view "workers")))
    (define-key map (kbd "d") (lambda () (interactive) (noema-orchestration-set-view "delegations")))
    (define-key map (kbd "e") (lambda () (interactive) (noema-orchestration-set-view "events")))
    map)
  "Keymap for `noema-orchestration-mode'.")

(define-derived-mode noema-orchestration-mode tabulated-list-mode "Noema-Orchestration"
  "Read a Noema project's Task/Job/Invocation/Worker/Delegation model.

This board reads; it does not start or stop work.  Author work and start Runs
on the Graph Board.

RET show the whole record   TAB / S-TAB cycle views   v choose a view
t tasks   j jobs   w workers   d delegations   e events   g refresh

\\{noema-orchestration-mode-map}"
  (setq-local revert-buffer-function (lambda (&rest _) (noema-orchestration-refresh))))

;;;###autoload
(defun noema-orchestration (&optional directory)
  "Open the orchestration board of DIRECTORY's project."
  (interactive)
  (let* ((directory (or directory default-directory))
         (root (or (and (require 'noema-research nil t) (noema-project-root directory))
                   (file-name-as-directory (expand-file-name directory))))
         (buffer (get-buffer-create
                  (format "*Noema Orchestration: %s*"
                          (file-name-nondirectory (directory-file-name root))))))
    (with-current-buffer buffer
      (noema-orchestration-mode)
      (setq noema-orchestration--root root))
    (pop-to-buffer buffer)
    (if (fboundp 'my/noema--ensure-server)
        (my/noema--ensure-server
         (lambda ()
           (when (buffer-live-p buffer)
             (with-current-buffer buffer (noema-orchestration-refresh)))))
      (with-current-buffer buffer (noema-orchestration-refresh)))
    buffer))

(provide 'noema-orchestration)
;;; noema-orchestration.el ends here
