;;; check-roam-agenda-actions.el --- Real Roam/source contract -*- lexical-binding: t; -*-
;; Runs under the root configuration against a disposable host and project.
(require 'init-md-roam)
(require 'noema-agenda)
(require 'noema-agenda-capture)
(require 'url)
(require 'json)

(defun noema-roam-smoke--call (operation body callback)
  (let* ((url-request-method "POST")
         (url-request-extra-headers '(("Content-Type" . "application/json")))
         (url-proxy-services nil)
         (url-request-data (encode-coding-string
                            (json-encode `((channel . ,(concat "aaronnote:api:agenda:" operation))
                                           (args . ,(vector body)))) 'utf-8))
         (reply (url-retrieve-synchronously (concat (getenv "NOEMA_AGENDA_TEST_URL") "/api") t t 30))
         result)
    (unless reply (error "No reply for %s" operation))
    (unwind-protect
        (with-current-buffer reply
          (goto-char url-http-end-of-headers)
          (setq result (json-parse-buffer :object-type 'hash-table :array-type 'list
                                         :null-object nil :false-object :json-false))
          (unless (= url-http-response-status 200) (error "%s: %S" operation result)))
      (kill-buffer reply))
    (funcall callback result nil)))

(cl-letf (((symbol-function 'noema-agenda--call) #'noema-roam-smoke--call)
          ((symbol-function 'my/noema-roam--runtime-call) (lambda (&rest _) (error "CLI fallback")))
          ((symbol-function 'my/noema-roam--note-records) (lambda () (error "Roam source scan")))
          ((symbol-function 'my/noema-roam-ui-refresh) #'ignore))
  (with-temp-buffer
    (setq buffer-file-name "/fs:never-entered:/project/unsaved.md")
    (insert "😀\n```md\n@@todo [Example]\n```\n\n@@itodo(doing) [Read proof]{due: 2026-09-20}\n@@todo [Same]\n@@todo [Same]\n")
    (let ((source (buffer-string)) (tick (buffer-chars-modified-tick)) entries)
      (my/noema-roam--current-file-todos (lambda (todos) (setq entries todos)))
      (cl-assert (= 3 (length entries)))
      (cl-assert (equal "doing" (my/noema-roam--todo-status (car entries))))
      (cl-assert (equal "2026-09-20" (my/noema-roam--todo-agenda-date (car entries))))
      (cl-assert (= 8 (line-number-at-pos (my/noema-roam--todo-field (nth 2 entries) "bufferPoint"))))
      (cl-assert (= tick (buffer-chars-modified-tick)))
      (cl-assert (equal source (buffer-string)))))
  (noema-roam-smoke--call
   "capture" `((scopeId . ,(getenv "NOEMA_AGENDA_TEST_SCOPE")) (file . "roam-smoke.md")
                (text . "Roam repeat proof") (sche . "2026-09-15") (repeat . "+1w"))
   (lambda (_result _error) nil))
  (let (entry)
    (my/noema-roam--todos
     (lambda (todos) (setq entry (seq-find (lambda (todo) (equal "Roam repeat proof" (gethash "text" todo))) todos))))
    (cl-assert (gethash "sourceRef" entry))
    (my/noema-roam-update-todo-metadata "priority" "B" entry)
    (my/noema-roam--todos
     (lambda (todos) (setq entry (seq-find (lambda (todo) (equal "Roam repeat proof" (gethash "text" todo))) todos))))
    (cl-assert (equal "B" (gethash "prio" (gethash "canon" entry))))
    (my/noema-roam-update-todo-status "done" entry)
    (my/noema-roam--todos
     (lambda (todos) (setq entry (seq-find (lambda (todo) (equal "Roam repeat proof" (gethash "text" todo))) todos))))
    (cl-assert (equal "todo" (gethash "status" entry)))
    (cl-assert (equal "2026-09-22" (gethash "sche" (gethash "canon" entry)))))
  ;; The main Agenda must distinguish an actual task from its identical code example.
  (let (entry)
    (my/noema-roam--todos
     (lambda (todos) (setq entry (seq-find (lambda (todo) (equal "Roam repeat proof" (gethash "text" todo))) todos))))
    (let ((buffer (find-file-noselect (gethash "file" entry))))
      (unwind-protect
          (save-window-excursion
            (with-current-buffer buffer
              (goto-char (point-max))
              (insert "\n\n```md\n" (gethash "source" entry) "\n```\n"))
            (noema-agenda-visit-record entry)
            (cl-assert (looking-at-p (regexp-quote (gethash "source" entry))))
            (cl-assert (= (point) (save-excursion (goto-char (point-min)) (search-forward (gethash "source" entry)) (match-beginning 0))))
            (delete-region (point) (+ (point) (length (gethash "source" entry))))
            (let ((rejected nil))
              (condition-case nil (noema-agenda-visit-record entry) (user-error (setq rejected t)))
              (cl-assert rejected)))
        (with-current-buffer buffer (set-buffer-modified-p nil))
        (kill-buffer buffer))))
  (let ((buffer (generate-new-buffer " *native capture*")))
    (unwind-protect
        (save-window-excursion
          (switch-to-buffer buffer)
          (noema-agenda-mode)
          (noema-roam-smoke--call "query-active" nil (lambda (snapshot _error) (setq noema-agenda--snapshot snapshot)))
          (cl-letf (((symbol-function 'completing-read)
                     (lambda (prompt choices &rest _)
                       (cond ((equal prompt "Capture template: ") (car (seq-find (lambda (choice) (string-prefix-p "d  " (car choice))) choices)))
                             ((equal prompt "Capture scope: ") (car (seq-find (lambda (choice) (equal (noema-agenda--get (cdr choice) 'id) (getenv "NOEMA_AGENDA_TEST_SCOPE"))) choices)))
                             ((equal prompt "Priority: ") "B")
                             (t (error "Unexpected prompt: %s" prompt)))))
                    ((symbol-function 'read-string) (lambda (&rest _) "Native template capture"))
                    ((symbol-function 'org-read-date) (lambda (&rest _) "2026-09-25")))
            (noema-agenda-capture-menu)))
      (kill-buffer buffer)))
  (princ "Roam snapshot/native writes/repeat: passed\n"))
