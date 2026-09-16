;;; noema-agenda.el --- Native Markdown and work Agenda -*- lexical-binding: t; -*-

;; Org supplies presentation primitives. No Org source buffers, markers,
;; temporary files, scanners or source-mutating commands are used here.
(require 'org-agenda)
(require 'cl-lib)
(require 'seq)
(require 'subr-x)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (callback))
(declare-function noema-open-node "noema-api" (node))
(declare-function noema-research-graph-buffer "noema-research-graph" (&optional source))
(declare-function noema-research-graph-pop-buffer "noema-research-graph" (graph))
(declare-function noema-research-graph-select "noema-research-graph" (id))
(defvar org-time-was-given) ; dynamically scoped output of org-read-date
(defvar org-read-date-minibuffer-local-map)
(autoload 'noema-agenda-capture-menu "noema-agenda-capture" nil t)
(autoload 'noema-agenda-promote "noema-agenda-attention" nil t)
(autoload 'noema-agenda-attention "noema-agenda-attention" nil t)

(defgroup noema-agenda nil "Native Noema task planning." :group 'applications)
(defcustom noema-agenda-custom-views
  '(("a" "Agenda and tasks" ((agenda) (todo)))
    ("w" "Waiting" ((todo :states ("blocked" "waiting"))))
    ("p" "Priorities" ((todo :priorities ("A" "B")))))
  "Named block views. Each block is (agenda|todo :states LIST :tags LIST
:priorities LIST :query STRING). Block kinds are agenda, todo, log, clock
and projects. This is data, never evaluated Lisp."
  :type 'sexp :group 'noema-agenda)

(defvar noema-agenda--project-scope nil)
(defvar noema-agenda--project-root nil)
(defvar noema-agenda--project-lease nil)
(defvar noema-agenda--project-request 0)
(defvar noema-agenda--project-callbacks nil)
(defvar noema-agenda--reconnect nil)
(defvar noema-agenda-project-root-function #'identity
  "Host adapter mapping a project identity to a supported source root.
The Emacs host supplies Remote placement here; unsupported placement signals
an error before any host request or project scan.")
(defvar-local noema-agenda--snapshot nil)
(defvar-local noema-agenda--from nil)
(defvar-local noema-agenda--days 7)
(defvar-local noema-agenda--scopes '("knowledge"))
(defvar-local noema-agenda--knowledge-visible t)
(defvar-local noema-agenda--show-completed nil)
(defvar-local noema-agenda--blocks '((agenda) (todo)))
(defvar-local noema-agenda--query "")
(defvar-local noema-agenda--tag nil)
(defvar-local noema-agenda--pending nil)
(defvar-local noema-agenda--dirty nil)
(defvar-local noema-agenda--marks nil)
(defvar-local noema-agenda--preferred-uid nil)
(defvar-local noema-agenda--categories nil)

(defun noema-agenda--get (object key &optional default)
  "Read KEY from a gateway OBJECT or test alist."
  (if (hash-table-p object) (gethash (symbol-name key) object default)
    (if (and (listp object) (keywordp (car object)))
        (or (plist-get object (intern (concat ":" (symbol-name key)))) default)
    (if (listp object) (or (alist-get key object)
                         (alist-get (symbol-name key) object nil nil #'equal) default)
      default))))
(defun noema-agenda--list (value) (if (vectorp value) (append value nil) value))
(defun noema-agenda--literal (value)
  (replace-regexp-in-string "[\n\r\t]" " " (format "%s" (or value ""))))
(defun noema-agenda--scope-labels (snapshot)
  (or (mapconcat (lambda (scope)
                   (if (equal (noema-agenda--get scope 'kind) "knowledge") "Knowledge"
                     (file-name-nondirectory (directory-file-name (noema-agenda--get scope 'root "Project")))))
                 (noema-agenda--list (noema-agenda--get snapshot 'scopes)) " + ")
      "Knowledge"))
(defun noema-agenda--call (operation body callback)
  "Use the existing long-lived host gateway, without spawning a reader."
  (unless (fboundp 'my/noema-api-call) (require 'init-aaronnote))
  (let ((protected (delq nil (mapcar (lambda (buffer)
                                      (with-current-buffer buffer
                                        (when (buffer-modified-p) buffer-file-name))) (buffer-list)))))
    (my/noema--ensure-server
     (lambda () (my/noema-api-call
                 (concat "aaronnote:api:agenda:" operation)
                 (vector (cons (cons 'protectedFiles (vconcat protected)) body))
                 (lambda (result error-object)
                   (noema-agenda--reconcile-files (noema-agenda--list (noema-agenda--get result 'changedPaths)))
                   (funcall callback result error-object))
                 (if (equal operation "batch") 300 30))))))

(defun noema-agenda--reconcile-files (files)
  "Refresh clean visited FILES actually changed by the source service."
  (dolist (file files)
    (when-let* ((buffer (get-file-buffer file)))
      (with-current-buffer buffer
        (when (and (not (buffer-modified-p)) (file-exists-p file)
                   (not (verify-visited-file-modtime buffer)))
          (revert-buffer t t))))))
(defun noema-agenda--error (error-object)
  (message "Noema Agenda: %s" (noema-agenda--get error-object 'message error-object)))
(defun noema-agenda--iso-day (iso)
  (pcase-let ((`(,year ,month ,day) (mapcar #'string-to-number (split-string iso "-"))))
    (calendar-absolute-from-gregorian (list month day year))))
(defun noema-agenda--day-iso (day)
  (pcase-let ((`(,month ,date ,year) (calendar-gregorian-from-absolute day)))
    (format "%04d-%02d-%02d" year month date)))

(defun noema-agenda-item-at-point ()
  "Return the native task record on the current line."
  (or (get-text-property (line-beginning-position) 'noema-agenda-item)
      (user-error "No task on this line")))

(defun noema-agenda--tags (todo)
  (delete-dups
   (append (noema-agenda--list (noema-agenda--get todo 'tags))
           (split-string (noema-agenda--get (noema-agenda--get todo 'canon) 'tags "") "[,& :]+" t))))

(defun noema-agenda--matches (todo block)
  (let* ((options (cdr block))
         (state (noema-agenda--get todo 'effectiveStatus (noema-agenda--get todo 'status "todo")))
         (explicit-states (plist-get options :states))
         (priority (noema-agenda--get (noema-agenda--get todo 'canon) 'prio "D"))
         (tags (noema-agenda--tags todo))
         (text (mapconcat #'noema-agenda--literal
                          (list (noema-agenda--get todo 'text) (noema-agenda--get todo 'noteTitle)
                                state (string-join tags " ")) " ")))
    (and (or noema-agenda--show-completed
             (eq (car block) 'log)
             explicit-states
             (not (member state '("done" "cancelled"))))
         (or (not explicit-states) (member state explicit-states))
         (or (not (plist-get options :priorities)) (member priority (plist-get options :priorities)))
         (cl-every (lambda (tag) (member tag tags)) (plist-get options :tags))
         (or (not noema-agenda--tag) (member noema-agenda--tag tags))
         (let ((case-fold-search t))
           (and (string-match-p (regexp-quote noema-agenda--query) text)
                (string-match-p (regexp-quote (or (plist-get options :query) "")) text))))))

(defun noema-agenda--entry (todo occurrence day)
  (let* ((state (upcase (noema-agenda--get todo 'effectiveStatus (noema-agenda--get todo 'status "todo"))))
         (priority (noema-agenda--get (noema-agenda--get todo 'canon) 'prio "D"))
         (priority (if (string-match-p "\\`[A-Z]\\'" priority) priority "D"))
         (progress (noema-agenda--get (noema-agenda--get todo 'canon) 'progress ""))
         (entry (org-agenda-format-item
                 (concat (noema-agenda--literal (noema-agenda--get occurrence 'label "")) " ")
                 (format "%s [#%s] %s%s" state priority (noema-agenda--literal (noema-agenda--get todo 'text))
                         (if (string-empty-p progress) "" (format " [%s%%]" (noema-agenda--literal progress))))
                 nil (or (and noema-agenda--categories
                              (gethash (noema-agenda--get todo 'uid) noema-agenda--categories))
                         (file-name-base (noema-agenda--literal (noema-agenda--get todo 'file "task"))))
                 (mapcar #'noema-agenda--literal (noema-agenda--tags todo))
                 (when-let* ((time (noema-agenda--get occurrence 'time))) (concat time " ")))))
    (add-text-properties
     0 (length entry)
     (list 'noema-agenda-item todo 'noema-agenda-occurrence occurrence
           'day day 'type (noema-agenda--get occurrence 'kind "todo")
           'todo-state state 'priority (- 1000 (string-to-char priority))
           'org-todo-regexp (regexp-opt '("TODO" "DOING" "BLOCKED" "WAITING" "DONE" "CANCELLED") t)) entry)
    entry))

(defun noema-agenda--render (snapshot)
  "Render native SNAPSHOT records with Org's pure display functions."
  (let* ((old (get-text-property (line-beginning-position) 'noema-agenda-item))
         (uid (or noema-agenda--preferred-uid (noema-agenda--get old 'uid)))
         (old-day (get-text-property (line-beginning-position) 'day))
         (old-kind (noema-agenda--get (get-text-property (line-beginning-position) 'noema-agenda-occurrence) 'kind))
         (prefer-new noema-agenda--preferred-uid)
         (old-line (line-number-at-pos))
         (inhibit-read-only t)
         (org-agenda-prefix-format "  %-16:c %?-10t %s")
         (org-agenda-sorting-strategy-selected '(time-up priority-down alpha-up))
         (org-agenda-dim-blocked-tasks nil)
         (org-agenda-max-entries nil) (org-agenda-max-tags nil)
         (org-agenda-max-todos nil) (org-agenda-max-effort nil)
         (org-priority-highest ?A) (org-priority-lowest ?Z)
         (org-done-keywords '("DONE" "CANCELLED"))
         (org-todo-keyword-faces '(("DOING" . warning) ("BLOCKED" . error)))
         (todos (noema-agenda--list (noema-agenda--get snapshot 'todos)))
         (by-id (make-hash-table :test #'equal)))
    (setq noema-agenda--snapshot snapshot noema-agenda--preferred-uid nil
          noema-agenda--categories (make-hash-table :test #'equal))
    (let ((files-by-base (make-hash-table :test #'equal)))
      (dolist (todo todos)
        (let* ((file (noema-agenda--literal (noema-agenda--get todo 'file "task")))
               (base (file-name-base file)))
          (puthash base (cl-adjoin file (gethash base files-by-base) :test #'equal)
                   files-by-base)))
      (dolist (todo todos)
        (let* ((file (noema-agenda--literal (noema-agenda--get todo 'file "task")))
               (base (file-name-base file))
               (label (if (> (length (gethash base files-by-base)) 1)
                          (format "%s/%s" (file-name-nondirectory
                                           (directory-file-name (or (file-name-directory file) "."))) base)
                        base)))
          (puthash (noema-agenda--get todo 'uid)
                   (truncate-string-to-width label 16 nil nil "…")
                   noema-agenda--categories))))
    (dolist (todo todos) (puthash (noema-agenda--get todo 'uid) todo by-id))
    (setq noema-agenda--marks (seq-filter (lambda (marked) (gethash marked by-id)) noema-agenda--marks))
    (erase-buffer)
    (org-compile-prefix-format 'agenda)
    (insert (propertize (format "Noema Agenda   %s   %s\n" noema-agenda--from
                                (noema-agenda--scope-labels snapshot)) 'face 'org-agenda-structure))
    (when-let* ((pending (noema-agenda--list (noema-agenda--get (noema-agenda--get snapshot 'clocktable) 'pendingWrites))))
      (insert (propertize (format "%d clock stop(s) awaiting source write · v k details · v R retry active projects\n" (length pending)) 'face 'warning)))
    (dolist (error-item (noema-agenda--list (noema-agenda--get snapshot 'errors)))
      (insert (propertize (format "Source error: %s — %s\n"
                                  (noema-agenda--literal (noema-agenda--get error-item 'file))
                                  (noema-agenda--literal (noema-agenda--get error-item 'message))) 'face 'error)))
    (dolist (block noema-agenda--blocks)
      (pcase (car block)
        ((or 'agenda 'log)
         (when (eq (car block) 'log) (insert (propertize "Logbook\n" 'face 'org-agenda-structure)))
         (dolist (bucket (noema-agenda--list (noema-agenda--get snapshot 'days)))
           (let* ((day (noema-agenda--iso-day (noema-agenda--get bucket 'date)))
                  (date (calendar-gregorian-from-absolute day)) entries)
             (insert (propertize (org-agenda-format-date-aligned date) 'face 'org-agenda-date 'day day) "\n")
             (dolist (occurrence (noema-agenda--list (noema-agenda--get bucket 'entries)))
               (when-let* ((todo (gethash (noema-agenda--get occurrence 'todoId) by-id)))
                 (when (and (noema-agenda--matches todo block)
                            (or (not (eq (car block) 'log))
                                (equal (noema-agenda--get occurrence 'kind) "log")))
                   (push (noema-agenda--entry todo occurrence day) entries))))
             (when entries (insert (org-agenda-finalize-entries entries 'agenda) "\n")))))
        ('todo
         (insert (propertize "Tasks\n" 'face 'org-agenda-structure))
         (let (entries)
           (dolist (todo todos)
             (when (noema-agenda--matches todo block)
               (push (noema-agenda--entry todo nil nil) entries)))
           (when entries (insert (org-agenda-finalize-entries entries 'agenda) "\n"))))
        ('clock (noema-agenda--render-clock snapshot by-id block))
        ('projects (noema-agenda--render-projects snapshot by-id block))
        (_ (insert (format "Unsupported block: %s\n" (car block))))))
    (noema-agenda--redraw-marks)
    (goto-char (point-min))
    (let ((found (and uid (or (and (not prefer-new) (noema-agenda--find-row uid old-day old-kind t))
                              (noema-agenda--find-row uid nil nil nil)))))
      (if found (goto-char found) (forward-line (1- old-line))))
    (set-buffer-modified-p nil)))

(defun noema-agenda--find-row (uid day kind exact)
  "Find UID, optionally retaining its DAY and occurrence KIND."
  (save-excursion
    (goto-char (point-min))
    (catch 'found
      (while (< (point) (point-max))
        (when (and (equal uid (noema-agenda--get (get-text-property (point) 'noema-agenda-item) 'uid))
                   (or (not exact)
                       (and (equal day (get-text-property (point) 'day))
                            (equal kind (noema-agenda--get (get-text-property (point) 'noema-agenda-occurrence) 'kind)))))
          (throw 'found (point)))
        (forward-line 1))
      nil)))

(defun noema-agenda--query-body ()
  `((scopes . ,(vconcat noema-agenda--scopes))
    (from . ,noema-agenda--from) (days . ,noema-agenda--days) (includePlanning . t)))

;;;###autoload
(defun noema-agenda-dashboard-query (callback)
  "Call CALLBACK with the current seven-day native-scope snapshot and error.
This is an event-index query: it does not start polling or discover inactive
projects."
  (noema-agenda--call
   "query"
   `((scopes . ,(vconcat (noema-agenda--desired-scopes)))
     (from . ,(format-time-string "%F")) (days . 7) (includePlanning . t))
   callback))

(defun noema-agenda-refresh (&optional rescan)
  "Refresh the scoped snapshot. With RESCAN, explicitly rescan active sources."
  (interactive "P")
  (if noema-agenda--pending (setq noema-agenda--dirty t)
    (let ((buffer (current-buffer)))
      (setq noema-agenda--pending t noema-agenda--dirty nil)
      (cl-labels
          ((query ()
             (when (buffer-live-p buffer)
               (with-current-buffer buffer
                 (let ((body (noema-agenda--query-body))
                       (epoch noema-agenda--project-request))
                   (noema-agenda--call
                    "query" body
                    (lambda (result error-object)
                      (when (and (buffer-live-p buffer) (not noema-agenda--reconnect))
                        (with-current-buffer buffer
                          (setq noema-agenda--pending nil)
                          (cond
                           ((or (/= epoch noema-agenda--project-request)
                                (not (equal body (noema-agenda--query-body))))
                            (setq noema-agenda--dirty t))
                           (error-object (noema-agenda--error error-object))
                           (t (noema-agenda--render result)))
                          (when noema-agenda--dirty (noema-agenda-refresh)))))))))))
        (if rescan
            (noema-agenda--call
             "invalidate" nil
             (lambda (_result error-object)
               (if error-object
                   (progn
                     (when (buffer-live-p buffer)
                       (with-current-buffer buffer (setq noema-agenda--pending nil)))
                     (noema-agenda--error error-object))
                 (query))))
          (query))))))

(defun noema-agenda-handle-change (_payload)
  "Invalidate visible Agenda buffers after a host notification."
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when (derived-mode-p 'noema-agenda-mode)
        (setq noema-agenda--dirty t)
        (when (get-buffer-window buffer t) (noema-agenda-refresh))))))

(defun noema-agenda-host-stopped ()
  "Forget leases and pending calls when the host exits, without restarting it."
  (cl-incf noema-agenda--project-request)
  (setq noema-agenda--project-scope nil noema-agenda--project-lease nil
        noema-agenda--reconnect t)
  (noema-agenda--finish-project-requests nil '((message . "Noema host stopped")))
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when (derived-mode-p 'noema-agenda-mode)
        (setq noema-agenda--pending nil noema-agenda--dirty t
              noema-agenda--scopes (if noema-agenda--knowledge-visible '("knowledge") nil))))))

(defun noema-agenda-host-ready ()
  "Reacquire the current project after a host restart notification."
  (when noema-agenda--reconnect
    (let ((root noema-agenda--project-root))
      (setq noema-agenda--reconnect nil noema-agenda--project-root nil)
      (noema-agenda-activate-project root)
      (noema-agenda-handle-change nil))))

(defun noema-agenda--desired-scopes ()
  "Return the current native scopes in display order."
  (delq nil (list (and noema-agenda--knowledge-visible "knowledge")
                  noema-agenda--project-scope)))

(defun noema-agenda--update-scopes ()
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when (derived-mode-p 'noema-agenda-mode)
        (setq noema-agenda--scopes (noema-agenda--desired-scopes))
        (setq noema-agenda--dirty t)
        (when (get-buffer-window buffer t) (noema-agenda-refresh))))))

(defun noema-agenda--finish-project-requests (result error-object)
  "Resolve callbacks owned by the current project entry exactly once."
  (let ((callbacks (prog1 (nreverse noema-agenda--project-callbacks)
                     (setq noema-agenda--project-callbacks nil))))
    (dolist (callback callbacks)
      (condition-case problem (funcall callback result error-object)
        (error (noema-agenda--error (error-message-string problem)))))))

(defun noema-agenda-activate-project (root &optional callback)
  "Enter ROOT on a project activation event; release the previous lease.
ROOT nil leaves the project. This never enumerates known project history.
CALLBACK receives (SCOPE ERROR) once entry succeeds, fails or is superseded."
  (if (equal root noema-agenda--project-root)
      (when callback
        (if noema-agenda--project-scope
            (funcall callback `((id . ,noema-agenda--project-scope)) nil)
          (if root (push callback noema-agenda--project-callbacks)
            (funcall callback nil '((message . "No active project"))))))
    (let* ((request (cl-incf noema-agenda--project-request))
           (lease (format "emacs-agenda:%d" request))
           (previous noema-agenda--project-scope)
           (previous-lease noema-agenda--project-lease))
      (setq noema-agenda--project-root root noema-agenda--project-scope nil
            noema-agenda--project-lease nil)
      (noema-agenda--finish-project-requests nil '((message . "Project entry superseded")))
      (when callback (push callback noema-agenda--project-callbacks))
      (when previous
        (noema-agenda--call "leave" `((id . ,previous) (lease . ,previous-lease))
                            (lambda (_result error-object) (when error-object (noema-agenda--error error-object)))))
      (noema-agenda--update-scopes)
      (if (not root)
          (noema-agenda--finish-project-requests nil '((message . "No active project")))
        (condition-case error-object
            (noema-agenda--call
           "enter" `((root . ,(funcall noema-agenda-project-root-function root)) (lease . ,lease))
           (lambda (result error-object)
             (cond
              (error-object
               (when (= request noema-agenda--project-request)
                 (setq noema-agenda--project-root nil)
                 (noema-agenda--finish-project-requests nil error-object))
               (noema-agenda--error error-object))
              ((/= request noema-agenda--project-request)
               (noema-agenda--call "leave" `((id . ,(noema-agenda--get result 'id)) (lease . ,lease)) #'ignore))
              (t
               (setq noema-agenda--project-scope (noema-agenda--get result 'id)
                     noema-agenda--project-lease lease)
               (noema-agenda--update-scopes)
               (noema-agenda--finish-project-requests result nil)))))
          (error
           (when (= request noema-agenda--project-request)
             (setq noema-agenda--project-root nil)
             (noema-agenda--finish-project-requests nil error-object))
           (noema-agenda--error (error-message-string error-object))))))))

(with-eval-after-load 'init-project
  (add-hook 'my/project-activated-hook #'noema-agenda-activate-project))

(defun noema-agenda--visible ()
  (when (and noema-agenda--dirty (get-buffer-window (current-buffer) t))
    (noema-agenda-refresh)))

(defun noema-agenda--shift (direction)
  (setq noema-agenda--from
        (noema-agenda--day-iso (+ (noema-agenda--iso-day noema-agenda--from)
                                (* direction noema-agenda--days))))
  (noema-agenda-refresh))
(defun noema-agenda-next () (interactive) (noema-agenda--shift 1))
(defun noema-agenda-previous () (interactive) (noema-agenda--shift -1))
(defun noema-agenda-today () (interactive) (setq noema-agenda--from (format-time-string "%F")) (noema-agenda-refresh))
(defun noema-agenda-day () (interactive) (setq noema-agenda--days 1 noema-agenda--blocks '((agenda))) (noema-agenda-refresh))
(defun noema-agenda-week () (interactive) (setq noema-agenda--days 7 noema-agenda--blocks '((agenda))) (noema-agenda-refresh))
(defun noema-agenda-todos () (interactive) (setq noema-agenda--blocks '((todo))) (noema-agenda--render noema-agenda--snapshot))
(defun noema-agenda-toggle-knowledge ()
  "Toggle the resident Roam/knowledge scope in this Agenda buffer."
  (interactive)
  (when (and noema-agenda--knowledge-visible (not noema-agenda--project-scope))
    (user-error "Enter a project before hiding the Roam Agenda"))
  (setq noema-agenda--knowledge-visible (not noema-agenda--knowledge-visible)
        noema-agenda--scopes (noema-agenda--desired-scopes))
  (message "Roam Agenda %s" (if noema-agenda--knowledge-visible "shown" "hidden"))
  (noema-agenda-refresh))
(defun noema-agenda-toggle-completed ()
  "Show or hide completed and cancelled tasks without querying sources."
  (interactive)
  (setq noema-agenda--show-completed (not noema-agenda--show-completed))
  (message "Completed tasks %s" (if noema-agenda--show-completed "shown" "hidden"))
  (noema-agenda--render noema-agenda--snapshot))
(defun noema-agenda-filter (query)
  "Filter task title, source, state and tags using literal QUERY."
  (interactive (list (read-string "Filter (empty clears): " noema-agenda--query)))
  (setq noema-agenda--query query) (noema-agenda--render noema-agenda--snapshot))
(defun noema-agenda-filter-tag (tag)
  (interactive (list (completing-read "Tag (empty clears): "
                                     (delete-dups (mapcan #'noema-agenda--tags
                                                         (noema-agenda--list (noema-agenda--get noema-agenda--snapshot 'todos)))))))
  (setq noema-agenda--tag (unless (string-empty-p tag) tag))
  (noema-agenda--render noema-agenda--snapshot))
(defun noema-agenda-custom (key)
  (interactive (list (completing-read "View: " (mapcar (lambda (view) (cons (car view) (cadr view))) noema-agenda-custom-views) nil t)))
  (setq noema-agenda--blocks (copy-tree (nth 2 (assoc key noema-agenda-custom-views))))
  (noema-agenda--render noema-agenda--snapshot))

(defun noema-agenda--locator (record)
  "Return a versioned native locator for a task or running clock RECORD."
  `((scopeId . ,(noema-agenda--get record 'scopeId))
    (uid . ,(noema-agenda--get record 'uid))
    (revision . ,(or (noema-agenda--get record 'revision)
                     (noema-agenda--get (noema-agenda--get record 'sourceRef) 'revision)))))

(defun noema-agenda--write (operation body files &optional callback)
  "Write OPERATION using BODY; protect and reconcile source buffers for FILES."
  (let ((buffers (delq nil (mapcar #'get-file-buffer (delete-dups (delq nil files))))))
    (dolist (buffer buffers)
      (when (buffer-modified-p buffer)
        (user-error "Save the modified source buffer before editing: %s" (buffer-name buffer))))
    (noema-agenda--call
     operation body
     (lambda (result error-object)
       ;; A batch or dependency edit may partially succeed. Reconcile clean
       ;; buffers even on an error, while preserving edits typed in the meantime.
       (dolist (buffer buffers)
         (when (and (buffer-live-p buffer) (not (buffer-modified-p buffer)))
           (with-current-buffer buffer
             (when (and buffer-file-name (file-exists-p buffer-file-name)
                        (not (verify-visited-file-modtime buffer)))
               (revert-buffer t t)))))
       (when error-object (noema-agenda--error error-object))
       (when callback (funcall callback result error-object))
       (noema-agenda-handle-change nil)))))

(defun noema-agenda--patch (todo patch &optional callback)
  (noema-agenda--write "patch" (append (noema-agenda--locator todo) `((patch . ,patch)))
                       (list (noema-agenda--get todo 'file)) callback))
(defun noema-agenda-complete () (interactive) (noema-agenda--patch (noema-agenda-item-at-point) '((op . "complete"))))
(defun noema-agenda-state (state)
  (interactive (list (completing-read "State: " '("todo" "doing" "blocked" "done" "cancelled") nil t)))
  (noema-agenda--patch (noema-agenda-item-at-point) `((status . ,state))))
(defun noema-agenda--date-picker-map ()
  "Return the Org date prompt map with direct calendar navigation keys."
  (let ((map (copy-keymap org-read-date-minibuffer-local-map)))
    (define-key map (kbd "<left>") #'org-calendar-backward-day)
    (define-key map (kbd "<right>") #'org-calendar-forward-day)
    (define-key map (kbd "<up>") #'org-calendar-backward-week)
    (define-key map (kbd "<down>") #'org-calendar-forward-week)
    (define-key map (kbd "RET") #'exit-minibuffer)
    (define-key map (kbd "q") #'abort-recursive-edit)
    (define-key map (kbd "<escape>") #'abort-recursive-edit)
    map))
(defun noema-agenda--read-date (field prompt)
  "Read a native date with Org's calendar picker; prefix clears FIELD."
  (if current-prefix-arg ""
    (let* ((todo (get-text-property (line-beginning-position) 'noema-agenda-item))
           (value (noema-agenda--get (noema-agenda--get todo 'canon) field))
           (org-read-date-minibuffer-local-map (noema-agenda--date-picker-map))
           (org-time-was-given nil))
      (org-read-date nil nil nil prompt nil value))))
(defun noema-agenda-schedule (date)
  (interactive (list (noema-agenda--read-date 'sche "Schedule")))
  (noema-agenda--patch (noema-agenda-item-at-point) `((sche . ,date))))
(defun noema-agenda-deadline (date)
  (interactive (list (noema-agenda--read-date 'ddl "Deadline")))
  (noema-agenda--patch (noema-agenda-item-at-point) `((ddl . ,date))))
(defun noema-agenda-end (date)
  (interactive (list (noema-agenda--read-date 'end "End")))
  (noema-agenda--patch (noema-agenda-item-at-point) `((end . ,date))))
(defun noema-agenda-priority (priority)
  (interactive (list (completing-read "Priority: " '("A" "B" "C" "D" "E" "F" "") nil t)))
  (noema-agenda--patch (noema-agenda-item-at-point) `((prio . ,priority))))
(defun noema-agenda-repeat (repeat)
  (interactive (list (read-string "Repeat (+1w, ++1w, .+1w; empty clears): ")))
  (noema-agenda--patch (noema-agenda-item-at-point) `((repeat . ,repeat))))
(defun noema-agenda-effort (effort)
  (interactive (list (read-string "Effort (e.g. 1h): ")))
  (noema-agenda--patch (noema-agenda-item-at-point) `((effort . ,effort))))
(defun noema-agenda-progress (progress)
  "Set the current task's PROGRESS percentage; an empty string clears it."
  (interactive (list (read-string "Progress (0–100; empty clears): ")))
  (unless (or (equal progress "")
              (and (stringp progress)
                   (string-match-p "\\`[0-9]+\\(?:\\.[0-9]+\\)?\\'" progress)
                   (<= (string-to-number progress) 100)))
    (user-error "Progress must be between 0 and 100"))
  (noema-agenda--patch (noema-agenda-item-at-point) `((progress . ,progress))))

(defun noema-agenda--redraw-marks ()
  "Update mark indicators without formatting, sorting or querying tasks."
  (let ((inhibit-read-only t) (marked (make-hash-table :test #'equal)))
    (dolist (uid noema-agenda--marks) (puthash uid t marked))
    (save-excursion
      (goto-char (point-min))
      (while (< (point) (point-max))
        (when-let* ((todo (get-text-property (point) 'noema-agenda-item)))
          (put-text-property (point) (min (+ (point) 2) (line-end-position))
                             'display (if (gethash (noema-agenda--get todo 'uid) marked) "* " "  ")))
        (forward-line 1)))
    (set-buffer-modified-p nil)))

(defun noema-agenda-mark ()
  "Mark the task on this line; all its occurrences share one mark."
  (interactive)
  (cl-pushnew (noema-agenda--get (noema-agenda-item-at-point) 'uid) noema-agenda--marks :test #'equal)
  (noema-agenda--redraw-marks)
  (forward-line 1))

(defun noema-agenda-unmark ()
  (interactive)
  (setq noema-agenda--marks (delete (noema-agenda--get (noema-agenda-item-at-point) 'uid) noema-agenda--marks))
  (noema-agenda--redraw-marks)
  (forward-line 1))

(defun noema-agenda-unmark-all ()
  (interactive)
  (setq noema-agenda--marks nil)
  (noema-agenda--redraw-marks))

(defun noema-agenda-bulk (patch)
  "Apply PATCH once to each marked task, retaining marks for failed writes."
  (interactive
   (list (let ((action (completing-read "Bulk action: "
                                        '("complete" "state" "schedule" "deadline" "priority" "effort" "progress" "repeat") nil t)))
           (pcase action
             ("complete" '((op . "complete")))
             ("state" `((status . ,(completing-read "State: " '("todo" "doing" "blocked" "done" "cancelled") nil t))))
             (_ (list (cons (cdr (assoc action '(("schedule" . sche) ("deadline" . ddl) ("priority" . prio)
                                                ("effort" . effort) ("progress" . progress) ("repeat" . repeat))))
                            (if (member action '("schedule" "deadline"))
                                (noema-agenda--read-date (if (equal action "schedule") 'sche 'ddl) (capitalize action))
                              (read-string (format "%s (empty clears): " (capitalize action)))))))))))
  (unless noema-agenda--marks (user-error "Mark tasks with m first"))
  (let* ((buffer (current-buffer))
         (tasks (seq-filter (lambda (todo) (member (noema-agenda--get todo 'uid) noema-agenda--marks))
                            (noema-agenda--list (noema-agenda--get noema-agenda--snapshot 'todos)))))
    (unless tasks (user-error "Marked tasks are no longer in this scope; refresh Agenda"))
    (noema-agenda--write
     "batch" `((items . ,(vconcat (mapcar #'noema-agenda--locator tasks))) (patch . ,patch))
     (mapcar (lambda (todo) (noema-agenda--get todo 'file)) tasks)
     (lambda (result error-object)
       (when (and (not error-object) (buffer-live-p buffer))
         (with-current-buffer buffer
           (let (failures)
             (dolist (entry (noema-agenda--list (noema-agenda--get result 'results)))
               (if (eq (noema-agenda--get entry 'ok) t)
                   (setq noema-agenda--marks (delete (noema-agenda--get entry 'uid) noema-agenda--marks))
                 (push (noema-agenda--get entry 'message "Task update failed") failures)))
             (noema-agenda--redraw-marks)
             (message "Agenda: %s/%d updated%s" (noema-agenda--get result 'succeeded 0) (length tasks)
                      (if failures (concat "; " (string-join (delete-dups failures) "; ")) "")))))))))

(defun noema-agenda--capture-arguments (choose-file)
  (let* ((scopes (noema-agenda--list (noema-agenda--get noema-agenda--snapshot 'scopes)))
         (current (get-text-property (line-beginning-position) 'noema-agenda-item))
         (choices (mapcar (lambda (scope)
                            (cons (if (equal (noema-agenda--get scope 'kind) "knowledge") "Knowledge"
                                    (noema-agenda--get scope 'root)) scope)) scopes)))
    (unless choices (user-error "Wait for Agenda to load its scopes before capturing"))
    (let* ((default (or (car (rassq (seq-find (lambda (scope) (equal (noema-agenda--get scope 'id)
                                                                 (noema-agenda--get current 'scopeId))) scopes) choices))
                        (caar choices)))
           (scope (cdr (assoc (if (= (length choices) 1) (caar choices)
                               (completing-read "Capture scope: " choices nil t nil nil default)) choices)))
           (file (if choose-file
                     (read-file-name "Capture file: " (file-name-as-directory (noema-agenda--get scope 'root)) nil nil "inbox.md")
                   "inbox.md")))
      (list (read-string "Task: ") (noema-agenda--get scope 'id) file))))

(defun noema-agenda-capture (title scope-id &optional file)
  "Capture TITLE as a native task in SCOPE-ID and optional Markdown FILE.
With a prefix argument, choose a target file; otherwise use the scope inbox.md."
  (interactive (noema-agenda--capture-arguments current-prefix-arg))
  (when (string-empty-p (string-trim title)) (user-error "Task title is empty"))
  (let* ((buffer (current-buffer))
         (scope (seq-find (lambda (item) (equal scope-id (noema-agenda--get item 'id)))
                          (noema-agenda--list (noema-agenda--get noema-agenda--snapshot 'scopes))))
         (target (expand-file-name (or file "inbox.md") (noema-agenda--get scope 'root))))
    (unless scope (user-error "Capture scope is inactive"))
    (noema-agenda--write
     "capture" `((text . ,title) (scopeId . ,scope-id) (file . ,target)) (list target)
     (lambda (result error-object)
       (when (and (not error-object) (buffer-live-p buffer))
         (with-current-buffer buffer
           (setq noema-agenda--preferred-uid (noema-agenda--get (noema-agenda--get result 'todo) 'uid)))
         (message "Captured: %s" title))))))

(defun noema-agenda-dependency (target)
  "Make the current task depend on native TARGET."
  (interactive
   (let* ((todo (noema-agenda-item-at-point))
          (tasks (seq-filter
                  (lambda (item) (and (not (equal (noema-agenda--get item 'uid) (noema-agenda--get todo 'uid)))
                                      (equal (noema-agenda--get item 'scopeId) (noema-agenda--get todo 'scopeId))
                                      (equal (noema-agenda--get item 'sourceKind) (noema-agenda--get todo 'sourceKind))
                                      (or (not (equal (noema-agenda--get todo 'sourceKind) "work-node"))
                                          (equal (noema-agenda--get item 'file) (noema-agenda--get todo 'file)))))
                  (noema-agenda--list (noema-agenda--get noema-agenda--snapshot 'todos))))
          (choices (cl-loop for item in tasks for i from 1
                            collect (cons (format "%d. %s — %s" i (noema-agenda--get item 'text) (noema-agenda--get item 'noteTitle)) item))))
     (unless choices (user-error "No compatible dependency targets in this scope"))
     (list (cdr (assoc (completing-read "Depends on: " choices nil t) choices)))))
  (let ((todo (noema-agenda-item-at-point)))
    (noema-agenda--write
     "dependency" `((source . ,(noema-agenda--locator todo)) (target . ,(noema-agenda--locator target)))
     (list (noema-agenda--get todo 'file) (noema-agenda--get target 'file)))))

(defun noema-agenda--running-clocks ()
  (let ((model (noema-agenda--get noema-agenda--snapshot 'clocktable)))
    (or (noema-agenda--list (noema-agenda--get model 'runningClocks))
        (when-let* ((clock (noema-agenda--get model 'running))) (list clock)))))

(defun noema-agenda-clock-in ()
  "Start the current task's clock through the native scope service."
  (interactive)
  (let ((todo (noema-agenda-item-at-point)))
    (noema-agenda--write "clock-in" (noema-agenda--locator todo)
                         (cons (noema-agenda--get todo 'file)
                               (mapcar (lambda (clock) (unless (eq (noema-agenda--get clock 'inactive) t)
                                                        (noema-agenda--get clock 'file))) (noema-agenda--running-clocks))))))

(defun noema-agenda-clock-out (clock)
  "Stop the selected native CLOCK without a vault or project scan."
  (interactive
   (let* ((clocks (noema-agenda--running-clocks))
          (choices (cl-loop for clock in clocks for i from 1
                            collect (cons (format "%d. %s — %s — %s" i (noema-agenda--get clock 'text)
                                                   (noema-agenda--get clock 'from) (noema-agenda--get clock 'file)) clock))))
     (unless choices (user-error "No running clock in the active scopes"))
     (list (if (= (length choices) 1) (cdar choices)
             (cdr (assoc (completing-read "Stop clock: " choices nil t) choices))))))
  (noema-agenda--write "clock-out" (noema-agenda--locator clock)
                       (unless (eq (noema-agenda--get clock 'inactive) t) (list (noema-agenda--get clock 'file)))))

(defun noema-agenda-clock-retry ()
  "Apply pending clock stops in active projects after saving source buffers."
  (interactive)
  (let ((pending (seq-remove (lambda (clock) (eq (noema-agenda--get clock 'inactive) t))
                             (noema-agenda--list (noema-agenda--get (noema-agenda--get noema-agenda--snapshot 'clocktable) 'pendingWrites)))))
    (unless pending (user-error "No pending clock stops in active projects"))
    (noema-agenda--write "clock-retry" nil (mapcar (lambda (clock) (noema-agenda--get clock 'file)) pending))))

(defun noema-agenda-clock-keep-source (clock)
  "Discard pending CLOCK intent and retain its saved source file's state."
  (interactive
   (let* ((model (noema-agenda--get noema-agenda--snapshot 'clocktable))
          (records (append (noema-agenda--list (noema-agenda--get model 'pendingWrites))
                           (seq-filter (lambda (clock) (eq (noema-agenda--get clock 'pending) t)) (noema-agenda--running-clocks))))
          (choices (cl-loop for clock in records for i from 1
                            unless (eq (noema-agenda--get clock 'inactive) t)
                            collect (cons (format "%d. %s — %s — %s" i (noema-agenda--get clock 'text)
                                                   (noema-agenda--get clock 'file) (noema-agenda--get clock 'message)) clock))))
     (unless choices (user-error "No pending clock requests in active projects"))
     (list (cdr (assoc (completing-read "Keep saved source state, discard request: " choices nil t) choices)))))
  (noema-agenda--write "clock-keep-source" (noema-agenda--locator clock) (list (noema-agenda--get clock 'file))))

(defun noema-agenda-log () (interactive) (setq noema-agenda--blocks '((log))) (noema-agenda--render noema-agenda--snapshot))
(defun noema-agenda-clocktable () (interactive) (setq noema-agenda--blocks '((clock))) (noema-agenda--render noema-agenda--snapshot))
(defun noema-agenda-projects () (interactive) (setq noema-agenda--blocks '((projects))) (noema-agenda--render noema-agenda--snapshot))

(defun noema-agenda--render-clock (snapshot by-id block)
  (let* ((model (noema-agenda--get snapshot 'clocktable))
         (running (noema-agenda--list (noema-agenda--get model 'runningClocks))))
    (insert (propertize "Clock report · all recorded time (h:mm)\n" 'face 'org-agenda-structure))
    (dolist (clock running)
      (insert (propertize (format "Running: %s · since %s · %s min%s\n"
                                  (noema-agenda--literal (noema-agenda--get clock 'text))
                                  (noema-agenda--get clock 'from) (noema-agenda--get clock 'minutesSoFar 0)
                                  (if (eq (noema-agenda--get clock 'inactive) t) " · project inactive"
                                    (let ((message (noema-agenda--get clock 'message "")))
                                      (if (string-empty-p message) "" (concat " · " (noema-agenda--literal message)))))) 'face 'warning)))
    (dolist (clock (noema-agenda--list (noema-agenda--get model 'pendingWrites)))
      (insert (propertize (format "Stopped: %s · %s → %s · %s\n  Source: %s\n"
                                  (noema-agenda--literal (noema-agenda--get clock 'text))
                                  (noema-agenda--get clock 'from) (noema-agenda--get clock 'to)
                                  (if (eq (noema-agenda--get clock 'inactive) t) "waiting for project entry"
                                    (let ((message (noema-agenda--get clock 'message "")))
                                      (if (string-empty-p message) "v R to write source" (noema-agenda--literal message))))
                                  (noema-agenda--literal (noema-agenda--get clock 'file))) 'face 'warning)))
    (dolist (task (noema-agenda--list (noema-agenda--get model 'tasks)))
      (let ((todo (gethash (noema-agenda--get task 'todoId) by-id)))
        (when (or (null todo) (noema-agenda--matches todo block))
          (let ((start (point)))
            (let ((minutes (floor (noema-agenda--get task 'minutes 0))))
              (insert (format "  %5d:%02d  %s\n" (/ minutes 60) (% minutes 60)
                              (noema-agenda--literal (noema-agenda--get task 'text)))))
            (when todo (add-text-properties start (1- (point)) (list 'noema-agenda-item todo)))))))))

(defun noema-agenda--render-projects (snapshot by-id block)
  (dolist (project (noema-agenda--list (noema-agenda--get snapshot 'projectModel)))
    (insert (propertize (format "%s · %s/%s done · %s%%\n"
                                (noema-agenda--literal (noema-agenda--get project 'title))
                                (noema-agenda--get project 'done 0) (noema-agenda--get project 'total 0)
                                (noema-agenda--get project 'progress 0)) 'face 'org-agenda-structure))
    (let (entries)
      (dolist (id (noema-agenda--list (noema-agenda--get project 'childTodoIds)))
        (when-let* ((todo (gethash id by-id)))
          (when (noema-agenda--matches todo block) (push (noema-agenda--entry todo nil nil) entries))))
      (when entries (insert (org-agenda-finalize-entries entries 'agenda) "\n")))))

(defvar noema-agenda--visit-request 0
  "Generation of the latest native source navigation request.")

(defun noema-agenda--snapshot-task (snapshot record)
  "Resolve RECORD among live tasks in editor SNAPSHOT, never raw code text."
  (let* ((ref (noema-agenda--get record 'sourceRef))
         (id (or (noema-agenda--get ref 'id) (noema-agenda--get record 'id)))
         (stable-id (and (stringp id) (string-prefix-p "#" id) id))
         (source (noema-agenda--get record 'source))
         (tasks (seq-filter
                 (lambda (todo)
                   (if stable-id (equal stable-id (noema-agenda--get todo 'id))
                     (and (stringp source) (not (string-empty-p source))
                          (equal source (noema-agenda--get todo 'source)))))
                 (noema-agenda--list (noema-agenda--get snapshot 'todos)))))
    (when (and (> (length tasks) 1)
               (noema-agenda--get ref 'revision)
               (equal (noema-agenda--get ref 'revision) (noema-agenda--get snapshot 'contentRevision)))
      (setq tasks (seq-filter (lambda (todo)
                               (equal (noema-agenda--get todo 'index)
                                      (or (noema-agenda--get ref 'index) (noema-agenda--get record 'index)))) tasks)))
    (unless (= (length tasks) 1)
      (user-error (if tasks "Ambiguous task source; assign a stable task ID"
                    "Task is no longer live in this document; refresh Agenda")))
    (car tasks)))

(defun noema-agenda--goto-snapshot-task (task)
  "Visit TASK's UTF-16 offset in the already verified current buffer."
  (let ((index (noema-agenda--get task 'index)) (units 0)
        (source (noema-agenda--get task 'source)))
    (unless (and (integerp index) (>= index 0) (stringp source) (not (string-empty-p source)))
      (user-error "Invalid task source position"))
    (widen)
    (goto-char (point-min))
    (while (and (< units index) (not (eobp)))
      (cl-incf units (if (> (char-after) #xffff) 2 1))
      (forward-char 1))
    (unless (and (= units index) (looking-at-p (regexp-quote source)))
      (user-error "Task position does not match the editor; refresh Agenda"))
    (recenter)))

(defun noema-agenda-visit-record (record)
  "Visit a resolved native RECORD using live document or WorkNode identity."
  (unless record (user-error "Task moved or disappeared; refresh Agenda"))
  (let ((request (cl-incf noema-agenda--visit-request)))
    (pop-to-buffer (find-file-noselect (noema-agenda--get record 'file)))
    (if (equal (noema-agenda--get record 'sourceKind) "work-node")
        (if (noema-agenda--list (noema-agenda--get record 'cellIds))
            (progn (require 'noema-api)
                   (noema-open-node (noema-agenda--get record 'workNodeId)))
          (require 'noema-research-graph)
          (let ((graph (noema-research-graph-buffer (current-buffer))))
            (noema-research-graph-pop-buffer graph)
            (with-current-buffer graph
              (noema-research-graph-select (noema-agenda--get record 'workNodeId)))))
      (let ((buffer (current-buffer)) (window (selected-window))
            (file buffer-file-name) (tick (buffer-chars-modified-tick))
            (content (save-restriction (widen) (buffer-substring-no-properties (point-min) (point-max)))))
        (noema-agenda--call
         "document" `((file . ,file) (content . ,content))
         (lambda (snapshot error-object)
           (when (and (= request noema-agenda--visit-request) (buffer-live-p buffer))
             (with-current-buffer buffer
               (cond
                (error-object (noema-agenda--error error-object))
                ((or (/= tick (buffer-chars-modified-tick)) (not (equal file buffer-file-name)))
                 (message "Task source changed during navigation; retry from Agenda"))
                ((not (and (window-live-p window) (eq window (selected-window))
                           (eq buffer (window-buffer window))))
                 (message "Task navigation finished after switching buffers; retry from Agenda"))
                (t (noema-agenda--goto-snapshot-task (noema-agenda--snapshot-task snapshot record))))))))))))

(defun noema-agenda-visit ()
  "Resolve the current native record and visit its original source."
  (interactive)
  (let* ((todo (noema-agenda-item-at-point))
         (uid (noema-agenda--get todo 'uid))
         (buffer (current-buffer)) (window (selected-window))
         (request (cl-incf noema-agenda--visit-request)))
    (noema-agenda--call
     "query" `((scopes . ,(vector (noema-agenda--get todo 'scopeId))))
     (lambda (snapshot error-object)
       (when (and (= request noema-agenda--visit-request)
                  (buffer-live-p buffer) (window-live-p window)
                  (eq window (selected-window)) (eq buffer (window-buffer window)))
         (if error-object (noema-agenda--error error-object)
           (noema-agenda-visit-record
            (seq-find (lambda (item) (equal uid (noema-agenda--get item 'uid)))
                      (noema-agenda--list (noema-agenda--get snapshot 'todos))))))))))

(defun noema-agenda-help ()
  "Show Noema Agenda's native command reference."
  (interactive)
  (with-help-window "*Noema Agenda Help*"
    (princ "Noema Agenda\n\n")
    (princ "n/p or j/k  move       f/b  next/previous range       v .  today\n")
    (princ "v d/w/t      day/week/tasks    v l/k/p  log/clock/projects    v c  custom view\n")
    (princ "/  text filter    \\  tag filter    r  refresh    C-u r  rescan active scopes\n")
    (princ ".  show/hide completed    R  show/hide Roam Agenda    v r  Markdown repeat\n\n")
    (princ "c  capture template    C-u c  template with chosen file\n")
    (princ "t  complete    T  state    s/d  schedule/deadline (calendar picker)\n")
    (princ "E  event end    P  promote to Apple    v a  global attention\n")
    (princ "C-u s/d  clear date    #  priority    e  effort    %  progress\n")
    (princ "m  mark    u  unmark    U  clear marks    B  bulk action\n")
    (princ "D  add dependency    I/O  clock in/out    v R  retry pending clock stops\n")
    (princ "K  keep saved source clock state and discard a pending request\n")
    (princ "RET  visit source    q  quit\n\n")
    (princ "Save modified source buffers before Agenda writes. Clock totals refresh\n")
    (princ "on explicit refresh or source changes; no background polling runs.\n")))

(defvar noema-agenda-mode-map
  (let ((map (make-sparse-keymap)))
    (dolist (binding '(("n" . org-agenda-next-line) ("p" . org-agenda-previous-line)
                      ("j" . org-agenda-next-line) ("k" . org-agenda-previous-line)
                      ("r" . noema-agenda-refresh) ("g" . noema-agenda-refresh)
                      ("R" . noema-agenda-toggle-knowledge)
                      ("f" . noema-agenda-next) ("b" . noema-agenda-previous)
                      ("." . noema-agenda-toggle-completed) ("v ." . noema-agenda-today)
                      ("v d" . noema-agenda-day) ("v w" . noema-agenda-week)
                      ("v t" . noema-agenda-todos) ("v c" . noema-agenda-custom)
                      ("v a" . noema-agenda-attention) ("P" . noema-agenda-promote) ("E" . noema-agenda-end)
                      ("v l" . noema-agenda-log) ("v k" . noema-agenda-clocktable) ("v p" . noema-agenda-projects)
                      ("/" . noema-agenda-filter) ("\\" . noema-agenda-filter-tag)
                      ("t" . noema-agenda-complete) ("T" . noema-agenda-state)
                      ("s" . noema-agenda-schedule) ("d" . noema-agenda-deadline) ("#" . noema-agenda-priority)
                      ("v r" . noema-agenda-repeat) ("e" . noema-agenda-effort) ("%" . noema-agenda-progress)
                      ("m" . noema-agenda-mark) ("u" . noema-agenda-unmark) ("U" . noema-agenda-unmark-all)
                      ("B" . noema-agenda-bulk) ("c" . noema-agenda-capture-menu) ("D" . noema-agenda-dependency)
                      ("I" . noema-agenda-clock-in) ("O" . noema-agenda-clock-out) ("v R" . noema-agenda-clock-retry)
                      ("K" . noema-agenda-clock-keep-source)
                      ("RET" . noema-agenda-visit) ("?" . noema-agenda-help) ("q" . quit-window)))
      (define-key map (kbd (car binding)) (cdr binding))) map))

(define-derived-mode noema-agenda-mode org-agenda-mode "Noema Agenda"
  "Org Agenda presentation over native Noema records."
  ;; Deliberately sever the inherited Org source command map. All operations
  ;; exposed in this mode are backed by Noema's typed source references.
  (set-keymap-parent noema-agenda-mode-map special-mode-map)
  (setq-local org-agenda-follow-mode nil)
  (setq-local header-line-format " n/p · f/b · v views · / filter · . done · r refresh · R Roam · c capture · I/O clock · t complete · s/d dates · RET source")
  (add-hook 'window-configuration-change-hook #'noema-agenda--visible nil t))

;;;###autoload
(defun noema-agenda-open (&optional query)
  "Open the native knowledge Agenda and the explicitly active project."
  (interactive)
  (let ((buffer (get-buffer-create "*Noema Agenda*")))
    (pop-to-buffer buffer)
    (unless (derived-mode-p 'noema-agenda-mode)
      (noema-agenda-mode)
      (setq noema-agenda--from (format-time-string "%F")))
    ;; Opening Agenda establishes its default view again.  `R' is a local,
    ;; temporary way to focus only the entered project; it must not make the
    ;; resident Roam scope silently disappear on the next entry.
    (setq noema-agenda--knowledge-visible t
          noema-agenda--scopes (noema-agenda--desired-scopes)
          noema-agenda--blocks '((agenda) (todo)))
    (when query (setq noema-agenda--query query))
    (noema-agenda-refresh)
    buffer))

(provide 'noema-agenda)
;;; noema-agenda.el ends here
