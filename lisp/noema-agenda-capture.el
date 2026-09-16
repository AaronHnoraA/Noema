;;; noema-agenda-capture.el --- Shared native capture profiles -*- lexical-binding: t; -*-
(require 'noema-agenda)

(defvar-local noema-agenda--capture-request 0)
(defvar-local noema-agenda--capture-draft nil
  "Last unsubmitted capture fields, retained until a successful write.")
(defvar-local noema-agenda--capture-saving nil)

(defun noema-agenda--capture-template-body (catalog choose-file)
  "Read a task from CATALOG and the current active scopes."
  (let* ((templates (noema-agenda--list (noema-agenda--get catalog 'templates)))
         (choices (mapcar (lambda (template)
                            (cons (format "%s  %s → %s" (noema-agenda--get template 'key)
                                          (noema-agenda--get template 'name) (noema-agenda--get template 'file)) template)) templates))
         (previous noema-agenda--capture-draft)
         (default-template (car (seq-find (lambda (choice)
                                           (equal (noema-agenda--get (cdr choice) 'id)
                                                  (alist-get 'templateId previous))) choices)))
         (template (cdr (assoc (completing-read "Capture template: " choices nil t nil nil (or default-template (caar choices))) choices)))
         (same-template (equal (noema-agenda--get template 'id) (alist-get 'templateId previous)))
         (scopes (seq-filter
                  (lambda (scope) (or (not (equal (noema-agenda--get template 'scope) "knowledge"))
                                      (equal (noema-agenda--get scope 'id) "knowledge")))
                  (noema-agenda--list (noema-agenda--get noema-agenda--snapshot 'scopes))))
         (scope-choices (mapcar (lambda (scope)
                                 (cons (if (equal (noema-agenda--get scope 'kind) "knowledge") "Knowledge"
                                         (noema-agenda--get scope 'root)) scope)) scopes)))
    (unless template (user-error "Choose a capture template"))
    (unless scopes (user-error "No active scope supports this capture template"))
    (let* ((current (get-text-property (line-beginning-position) 'noema-agenda-item))
           (default (or (car (seq-find (lambda (choice)
                                        (equal (noema-agenda--get (cdr choice) 'id) (alist-get 'scopeId previous))) scope-choices))
                        (car (seq-find (lambda (choice)
                                        (equal (noema-agenda--get (cdr choice) 'id) (noema-agenda--get current 'scopeId))) scope-choices))
                        (caar scope-choices)))
           (scope (cdr (assoc (if (= (length scopes) 1) (caar scope-choices)
                               (completing-read "Capture scope: " scope-choices nil t nil nil default)) scope-choices)))
           (file (expand-file-name (noema-agenda--get template 'file) (noema-agenda--get scope 'root)))
           (defaults (noema-agenda--get template 'defaults))
           (body `((templateId . ,(noema-agenda--get template 'id))
                   (templateRevision . ,(noema-agenda--get catalog 'revision))
                   (scopeId . ,(noema-agenda--get scope 'id)))))
      (when (and same-template (equal (alist-get 'scopeId previous) (noema-agenda--get scope 'id))
                 (alist-get 'file previous))
        (setq file (alist-get 'file previous)))
      (when choose-file
        (setq file (read-file-name "Capture file: " (file-name-directory file) file nil (file-name-nondirectory file))))
      (message "Capture → %s" file)
      (push (cons 'file file) body)
      (setq noema-agenda--capture-draft (copy-tree body))
      (dolist (field (noema-agenda--list (noema-agenda--get template 'fields)))
        (let* ((name (intern (noema-agenda--get field 'name)))
               (initial (if (and (or same-template (eq name 'text)) (assq name previous))
                            (alist-get name previous) (noema-agenda--get defaults name "")))
               (prompt (format "%s: " (noema-agenda--get field 'label)))
               (value (pcase (noema-agenda--get field 'kind)
                        ("choice" (completing-read prompt (noema-agenda--list (noema-agenda--get field 'choices)) nil t initial))
                        ("date" (if (eq (noema-agenda--get field 'required) t)
                                    (let ((org-time-was-given nil)) (org-read-date nil nil nil prompt nil initial))
                                  (read-string (concat prompt "(empty skips) ") initial)))
                        (_ (read-string prompt initial)))))
          (when (and (eq (noema-agenda--get field 'required) t) (string-empty-p (string-trim value)))
            (user-error "%s is required" (noema-agenda--get field 'label)))
          (push (cons name value) body)
          (setq noema-agenda--capture-draft (copy-tree body))))
      body)))

(defun noema-agenda-capture-menu (&optional choose-file)
  "Capture using profiles shared with Web Agenda.  Prefix chooses the file."
  (interactive "P")
  (when noema-agenda--capture-saving (user-error "Capture is still saving"))
  (let ((buffer (current-buffer)) (window (selected-window))
        (request (cl-incf noema-agenda--capture-request)))
    (noema-agenda--call
     "capture-templates" nil
     (lambda (catalog error-object)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (when (= request noema-agenda--capture-request)
             (cond
              (error-object (noema-agenda--error error-object))
              ((not (and (window-live-p window) (eq window (selected-window)) (eq buffer (window-buffer window))))
               (message "Capture request finished after switching buffers; reopen capture"))
              (t
               (let ((body (noema-agenda--capture-template-body catalog choose-file)))
                 (setq noema-agenda--capture-draft body noema-agenda--capture-saving t)
                 (condition-case err
                     (noema-agenda--write
                      "capture" body (list (alist-get 'file body))
                      (lambda (result error-object)
                        (when (buffer-live-p buffer)
                          (with-current-buffer buffer
                            (setq noema-agenda--capture-saving nil)
                            (unless error-object
                              (setq noema-agenda--capture-draft nil
                                    noema-agenda--preferred-uid (noema-agenda--get (noema-agenda--get result 'todo) 'uid)))))
                        (unless error-object (message "Captured: %s" (alist-get 'text body)))))
                   (error (setq noema-agenda--capture-saving nil)
                          (signal (car err) (cdr err))))))))))))))

(provide 'noema-agenda-capture)
