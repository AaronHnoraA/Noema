;;; noema-agenda-poc.el --- Isolated native Org Agenda experiment -*- lexical-binding: t; -*-

;; Research only. No startup hooks, global advice, or production write APIs.
;; Org is used as a rendering/query engine over a disposable projection.
(require 'org-agenda)
(require 'json)
(require 'cl-lib)
(require 'subr-x)

(defvar noema-agenda-poc--directory
  (file-name-directory (or load-file-name buffer-file-name)))
(defvar noema-agenda-poc-node "node")
(defvar-local noema-agenda-poc--snapshot nil)
(defvar-local noema-agenda-poc--projection nil)
(put 'noema-agenda-poc--snapshot 'permanent-local t)
(put 'noema-agenda-poc--projection 'permanent-local t)

(defun noema-agenda-poc--attach ()
  "Reattach this buffer's adapter after Org regenerates its major mode."
  (when noema-agenda-poc--projection
    (setq-local org-agenda-files (list noema-agenda-poc--projection))
    (setq-local org-agenda-buffer-tmp-name "*Noema Agenda Prototype*")
    (use-local-map (copy-keymap org-agenda-mode-map))
    (local-set-key (kbd "RET") #'noema-agenda-poc-visit)
    (local-set-key (kbd "t") #'noema-agenda-poc-completion-intent)
    (local-set-key (kbd "q") #'noema-agenda-poc-close)
    (setq-local header-line-format " Noema research prototype · RET source · t request preview · q close")))
(put 'noema-agenda-poc--attach 'permanent-local-hook t)

(defun noema-agenda-poc--literal (value)
  "Flatten VALUE and prevent Org links/diary expressions in display labels."
  (let ((text (replace-regexp-in-string "[\n\r\t]" " " (format "%s" (or value "")))))
    (dolist (pair '(("[" . "［") ("]" . "］") ("<" . "‹") (">" . "›")))
      (setq text (string-replace (car pair) (cdr pair) text)))
    text))

(defun noema-agenda-poc--timestamp (value)
  "Render only a canonical Noema wall date/time as an Org timestamp."
  (when (and (stringp value)
             (string-match-p "\\`[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}\\(?: [0-9]\\{2\\}:[0-9]\\{2\\}\\)?\\'" value))
    (concat "<" value ">")))

(defun noema-agenda-poc--org (snapshot)
  "Project SNAPSHOT into Org without exposing an editable Org authority."
  (concat
   "#+TITLE: Noema Agenda research prototype\n"
   "#+TODO: TODO DOING BLOCKED | DONE CANCELLED\n"
   "#+PRIORITIES: A F D\n\n"
   (mapconcat
    (lambda (item)
      (let* ((status (upcase (or (alist-get 'status item) "todo")))
             (priority (alist-get 'priority item))
             (scheduled (noema-agenda-poc--timestamp (alist-get 'scheduled item)))
             (deadline (noema-agenda-poc--timestamp (alist-get 'deadline item))))
        (unless (member status '("TODO" "DOING" "BLOCKED" "DONE" "CANCELLED"))
          (error "Unknown prototype task status: %s" status))
        (unless (and (stringp priority) (string-match-p "\\`[A-F]\\'" priority))
          (error "Invalid prototype priority"))
        (concat "* " status " [#" priority "] "
                (noema-agenda-poc--literal (alist-get 'title item)) "\n"
                (if (or scheduled deadline)
                    (concat (if scheduled (concat "SCHEDULED: " scheduled " ") "")
                            (if deadline (concat "DEADLINE: " deadline) "") "\n") "")
                ":PROPERTIES:\n:NOEMA_UID: " (noema-agenda-poc--literal (alist-get 'uid item))
                "\n:CATEGORY: " (noema-agenda-poc--literal (alist-get 'project item))
                "\n:NOEMA_KIND: " (noema-agenda-poc--literal (alist-get 'kind item))
                "\n:END:\n")))
    (alist-get 'items snapshot) "\n")))

(defun noema-agenda-poc--deny-write (&rest _)
  "Reject writes even when an Org command binds `inhibit-read-only'."
  (user-error "Disposable Noema projection: source mutations require the Noema adapter"))

(defun noema-agenda-poc-item-at-point ()
  "Resolve the native agenda marker through its stable Noema UID."
  (let* ((marker (or (org-get-at-bol 'org-hd-marker) (org-get-at-bol 'org-marker)))
         (uid (and (markerp marker) (marker-buffer marker)
                   (org-with-point-at marker (org-entry-get nil "NOEMA_UID")))))
    (or (cl-find uid (alist-get 'items noema-agenda-poc--snapshot)
                 :key (lambda (item) (alist-get 'uid item)) :test #'equal)
        (user-error "No Noema item on this line"))))

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

(defun noema-agenda-poc-visit ()
  "Visit Markdown or a WorkNode from the agenda using source identity."
  (interactive)
  (let* ((item (noema-agenda-poc-item-at-point))
         (file (alist-get 'file item)))
    (if (equal (alist-get 'kind item) "work-node")
        (progn
          (unless (fboundp 'noema-open-node)
            (user-error "Load Noema's semantic API to navigate WorkNodes"))
          (find-file-other-window file)
          (noema-open-node (alist-get 'id item)))
      ;; Re-extract the file: a saved edit above this task must not misdirect RET.
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

(defun noema-agenda-poc-read-sources (files)
  "Read FILES through the existing Noema parser into a transient snapshot."
  (with-temp-buffer
    (let ((status (apply #'call-process noema-agenda-poc-node nil t nil
                         (expand-file-name "snapshot.mjs" noema-agenda-poc--directory) files)))
      (unless (equal status 0) (error "Noema snapshot failed: %s" (buffer-string))))
    (json-parse-string (buffer-string) :object-type 'alist :array-type 'list
                       :null-object nil :false-object nil)))

(defun noema-agenda-poc-open (snapshot &optional start-day)
  "Show SNAPSHOT in native Org Agenda, optionally beginning on START-DAY.
This prototype projects current dates only: repeat/dependency/clock parity
  is deliberately left to the production design and is not claimed here."
  (when-let* ((old (get-buffer "*Noema Agenda Prototype*")))
    (with-current-buffer old (noema-agenda-poc-close)))
  (let* ((file (make-temp-file "noema-agenda-poc-" nil ".org"))
         (org-agenda-files (list file))
         (org-agenda-buffer-name "*Noema Agenda Prototype*")
         (org-agenda-buffer-tmp-name "*Noema Agenda Prototype*")
         (org-agenda-window-setup 'current-window)
         (org-agenda-start-on-weekday nil)
         (org-agenda-include-diary nil)
         (org-agenda-entry-types '(:deadline :scheduled :timestamp))
         (org-agenda-inhibit-startup t)
         (org-agenda-use-time-grid nil)
         (org-agenda-show-all-dates t))
    (with-temp-file file (insert (noema-agenda-poc--org snapshot)))
    (org-agenda-list nil (or start-day "2026-09-15") 7)
    (setq-local noema-agenda-poc--snapshot snapshot)
    (setq-local noema-agenda-poc--projection file)
    ;; org-agenda-redo retains its own generating settings. Explicit local
    ;; files also scope native TODO/tags view switches to this projection.
    (add-hook 'org-agenda-mode-hook #'noema-agenda-poc--attach nil t)
    (noema-agenda-poc--attach)
    (with-current-buffer (find-buffer-visiting file)
      (setq buffer-read-only t)
      (add-hook 'before-change-functions #'noema-agenda-poc--deny-write nil t))
    (current-buffer)))

(defun noema-agenda-poc-close ()
  "Remove only this prototype's temporary projection and agenda buffer."
  (interactive)
  (let ((file noema-agenda-poc--projection))
    (when file
      (when-let* ((buffer (find-buffer-visiting file)))
        (with-current-buffer buffer (set-buffer-modified-p nil))
        (kill-buffer buffer))
      (delete-file file))
    (kill-buffer (current-buffer))))

;;;###autoload
(defun noema-agenda-poc-demo ()
  "Open the included Markdown and proposed DAG planning examples."
  (interactive)
  (noema-agenda-poc-open
   (noema-agenda-poc-read-sources
    (mapcar (lambda (name) (expand-file-name name noema-agenda-poc--directory))
            '("example.md" "example.noema")))))

(provide 'noema-agenda-poc)
