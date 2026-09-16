;;; noema-agenda-poc.el --- Native Noema data in Org Agenda UI -*- lexical-binding: t; -*-

;; Research only. No Org text, Org source buffers, startup hooks, global advice,
;; production mutations, or background polling.
(require 'org-agenda)
(require 'json)
(require 'cl-lib)
(require 'subr-x)

(defvar noema-agenda-poc--directory
  (file-name-directory (or load-file-name buffer-file-name)))
(defvar noema-agenda-poc-node "node")
(defvar-local noema-agenda-poc--snapshot nil)
(defvar-local noema-agenda-poc--start-day nil)

(defun noema-agenda-poc--literal (value)
  "Keep VALUE on one display line; never interpret it as source code."
  (replace-regexp-in-string "[\n\r\t]" " " (format "%s" (or value ""))))

(defun noema-agenda-poc--entry (item kind date absolute-day)
  "Format a native ITEM using upstream Org's item formatter."
  (let* ((state (upcase (or (alist-get 'status item) "todo")))
         (priority (or (alist-get 'priority item) "D"))
         (title (format "%s [#%s] %s" state priority
                        (noema-agenda-poc--literal (alist-get 'title item))))
         (time (and (stringp date) (> (length date) 10) (substring date 11)))
         (entry (org-agenda-format-item
                 (concat kind ": ") title nil
                 (noema-agenda-poc--literal (alist-get 'project item)) nil
                 (and time (concat time " ")))))
    (add-text-properties
     0 (length entry)
     (list 'noema-item item 'day absolute-day 'type kind
           'todo-state state 'priority (- 1000 (string-to-char priority))
           'org-todo-regexp (regexp-opt '("TODO" "DOING" "BLOCKED" "DONE" "CANCELLED") t))
     entry)
    entry))

(defun noema-agenda-poc-item-at-point ()
  "Return this line's typed Noema record, without Org source markers."
  (or (get-text-property (line-beginning-position) 'noema-item)
      (user-error "No Noema item on this line")))

(defun noema-agenda-poc-completion-intent ()
  "Return an inspectable completion request; do not execute a mutation."
  (interactive)
  (let* ((item (noema-agenda-poc-item-at-point))
         (request
          (if (equal (alist-get 'kind item) "work-node")
              `((operation . "proposed:work-node-complete")
                (file . ,(alist-get 'file item))
                (notebookId . ,(alist-get 'notebookId item))
                (workNodeId . ,(alist-get 'id item)))
            `((operation . "aaronnote:api:notes:patch-todo")
              (body . ((file . ,(alist-get 'file item))
                       (selectorId . ,(if (alist-get 'stable item) (alist-get 'id item) ""))
                       (index . ,(alist-get 'index item))
                       (source . ,(alist-get 'source item))
                       (op . "complete")))))))
    (when (called-interactively-p 'interactive)
      (with-current-buffer (get-buffer-create "*Noema Agenda Request Preview*")
        (let ((inhibit-read-only t))
          (erase-buffer)
          (insert "Request preview only — no task has been changed.\n\n"
                  (json-encode request))
          (special-mode))
        (display-buffer (current-buffer))))
    request))

(defun noema-agenda-poc-read-sources (files)
  "Read explicitly supplied FILES using the existing Noema parser.
Production will use the already running host's scoped API."
  (with-temp-buffer
    (let ((status (apply #'call-process noema-agenda-poc-node nil t nil
                         (expand-file-name "snapshot.mjs" noema-agenda-poc--directory) files)))
      (unless (equal status 0) (error "Noema snapshot failed: %s" (buffer-string))))
    (json-parse-string (buffer-string) :object-type 'alist :array-type 'list
                       :null-object nil :false-object nil)))

(defun noema-agenda-poc-visit ()
  "Visit Markdown or a WorkNode using native source identity."
  (interactive)
  (let* ((item (noema-agenda-poc-item-at-point))
         (file (alist-get 'file item)))
    (if (equal (alist-get 'kind item) "work-node")
        (progn
          (unless (fboundp 'noema-open-node)
            (user-error "Load Noema's semantic API to navigate WorkNodes"))
          (find-file-other-window file)
          (noema-open-node (alist-get 'id item)))
      (let* ((fresh (noema-agenda-poc-read-sources (list file)))
             (matches (cl-remove-if-not
                       (lambda (entry)
                         (if (alist-get 'stable item)
                             (equal (alist-get 'id entry) (alist-get 'id item))
                           (equal (alist-get 'source entry) (alist-get 'source item))))
                       (alist-get 'items fresh))))
        (unless (= (length matches) 1)
          (user-error "Source changed or is ambiguous; rebuild the prototype"))
        (let ((buffer (find-file-noselect file)))
          (when (buffer-modified-p buffer)
            (user-error "Save or reconcile the Markdown buffer before prototype navigation"))
          (pop-to-buffer buffer)
          (revert-buffer t t)
          (goto-char (point-min))
          (forward-line (1- (alist-get 'line (car matches)))))))))

(defun noema-agenda-poc-redraw ()
  "Redraw this snapshot without source reads or an Org scan."
  (interactive)
  (noema-agenda-poc-open noema-agenda-poc--snapshot noema-agenda-poc--start-day))

(defun noema-agenda-poc-next-week ()
  (interactive)
  (noema-agenda-poc-open noema-agenda-poc--snapshot (+ noema-agenda-poc--start-day 7)))

(defun noema-agenda-poc-previous-week ()
  (interactive)
  (noema-agenda-poc-open noema-agenda-poc--snapshot (- noema-agenda-poc--start-day 7)))

(defun noema-agenda-poc-filter (regexp)
  "Filter native rows with REGEXP using Org's text visibility properties."
  (interactive "sFilter regexp (empty clears): ")
  (let ((inhibit-read-only t))
    (remove-text-properties (point-min) (point-max) '(invisible nil org-filter-type nil)))
  (unless (string-empty-p regexp)
    (save-excursion
      (goto-char (point-min))
      (while (not (eobp))
        (when-let* ((item (get-text-property (point) 'noema-item)))
          (unless (string-match-p regexp (alist-get 'title item))
            (org-agenda-filter-hide-line 'regexp)))
        (forward-line 1)))))

(defun noema-agenda-poc-close ()
  "Close the display buffer; there is no temporary source file."
  (interactive)
  (kill-buffer (current-buffer)))

(defun noema-agenda-poc-open (snapshot &optional start-day)
  "Render native SNAPSHOT records directly in `org-agenda-mode'.
START-DAY is an ISO date or an absolute calendar day. No Org text is produced.
Only current scheduled/deadline occurrences are demonstrated in this prototype."
  (let* ((day (if (integerp start-day) start-day
                (time-to-days (org-read-date nil t (or start-day "2026-09-15")))))
         (buffer (get-buffer-create "*Noema Agenda Prototype*")))
    (pop-to-buffer buffer)
    (org-agenda-mode)
    (setq-local noema-agenda-poc--snapshot snapshot)
    (setq-local noema-agenda-poc--start-day day)
    (setq-local org-agenda-type 'agenda)
    (setq-local org-agenda-follow-mode nil)
    (let ((inhibit-read-only t)
          (org-agenda-prefix-format "  %-20:c %?-10t %s")
          (org-agenda-sorting-strategy-selected '(time-up priority-down alpha-up))
          (org-agenda-dim-blocked-tasks nil)
          (org-agenda-max-entries nil) (org-agenda-max-tags nil)
          (org-agenda-max-todos nil) (org-agenda-max-effort nil)
          (org-priority-highest ?A) (org-priority-lowest ?F)
          (org-done-keywords '("DONE" "CANCELLED"))
          (org-todo-keyword-faces '(("DOING" . warning) ("BLOCKED" . error))))
      (remove-overlays)
      (erase-buffer)
      (org-compile-prefix-format 'agenda)
      (insert (propertize "Noema Week Agenda\n" 'face 'org-agenda-structure))
      (dotimes (offset 7)
        (let* ((absolute (+ day offset))
               (date (calendar-gregorian-from-absolute absolute))
               (iso (format "%04d-%02d-%02d" (nth 2 date) (car date) (cadr date)))
               (entries nil))
          (insert (propertize (org-agenda-format-date-aligned date)
                              'face 'org-agenda-date 'day absolute) "\n")
          (dolist (item (alist-get 'items snapshot))
            (dolist (field '(scheduled deadline))
              (let ((value (alist-get field item)))
                (when (and (stringp value) (string-prefix-p iso value))
                  (push (noema-agenda-poc--entry item (symbol-name field) value absolute) entries)))))
          (when entries
            (insert (org-agenda-finalize-entries entries 'agenda) "\n"))))
      (goto-char (point-min)))
    ;; Audited subset: Org source-mutating commands must not touch an unrelated
    ;; org-clock or attempt to parse Markdown as Org. No fake source markers.
    (use-local-map (make-sparse-keymap))
    (dolist (binding '(("n" . org-agenda-next-line) ("p" . org-agenda-previous-line)
                       ("j" . org-agenda-next-line) ("k" . org-agenda-previous-line)
                       ("g" . noema-agenda-poc-redraw) ("f" . noema-agenda-poc-next-week)
                       ("b" . noema-agenda-poc-previous-week) ("/" . noema-agenda-poc-filter)
                       ("RET" . noema-agenda-poc-visit) ("t" . noema-agenda-poc-completion-intent)
                       ("q" . noema-agenda-poc-close)))
      (local-set-key (kbd (car binding)) (cdr binding)))
    (setq-local header-line-format " Native Noema data · n/p · f/b week · / filter · t request preview · RET source")
    (setq buffer-read-only t)
    buffer))

;;;###autoload
(defun noema-agenda-poc-demo ()
  "Show example Markdown and DAG records in native Org Agenda UI."
  (interactive)
  (noema-agenda-poc-open
   (noema-agenda-poc-read-sources
    (mapcar (lambda (name) (expand-file-name name noema-agenda-poc--directory))
            '("example.md" "example.noema")))))

(provide 'noema-agenda-poc)
