;;; noema-agenda-attention.el --- Explicit global attention -*- lexical-binding: t; -*-
(require 'noema-agenda)
(defvar-local noema-agenda-attention--pending nil)
(defvar-local noema-agenda-attention--dirty nil)

(defun noema-agenda-attention--item ()
  (or (get-text-property (point) 'noema-attention-item)
      (user-error "No global attention item on this line")))

(defun noema-agenda-attention--render (snapshot)
  (let ((inhibit-read-only t) (position (point)))
    (erase-buffer)
    (insert (propertize "Noema Global Attention\n" 'face 'org-agenda-structure))
    (insert "Only explicitly promoted items. Inactive projects stay closed.\n\n")
    (when-let* ((connection (noema-agenda--get snapshot 'connection))
                ((not (equal (noema-agenda--get connection 'state) "connected"))))
      (insert (propertize
               (format "Showing saved receipts · %s\n\n"
                       (noema-agenda--literal (noema-agenda--get connection 'message))) 'face 'warning)))
    (let ((items (noema-agenda--list (noema-agenda--get snapshot 'items))))
      (unless items (insert "No promoted items. Use P on an Agenda task.\n"))
      (dolist (item items)
        (let* ((start (point))
               (fields (noema-agenda--get item 'fields))
               (reference (noema-agenda--get item 'ref))
               (status (noema-agenda--get item 'status))
               (active (eq (noema-agenda--get item 'active) t)))
          (insert (format "%-9s %-16s %s\n"
                          (noema-agenda--get item 'kind) status
                          (noema-agenda--literal (noema-agenda--get fields 'title))))
          (insert (format "  %s · %s\n" (if active "Active source" "Inactive source")
                          (noema-agenda--literal (noema-agenda--get reference 'root))))
          (when-let* ((message (noema-agenda--get item 'message))
                      ((not (string-empty-p message))))
            (insert (propertize (concat "  " (noema-agenda--literal message) "\n") 'face 'warning)))
          (dolist (key (noema-agenda--list (noema-agenda--get item 'conflicts)))
            (let ((symbol (intern key)))
              (insert (format "  %s — source (last observed): %s; Apple: %s\n" key
                              (noema-agenda--literal (noema-agenda--get (noema-agenda--get (noema-agenda--get item 'sourceCurrent) 'fields) symbol))
                              (noema-agenda--literal (noema-agenda--get fields symbol))))))
          (add-text-properties start (point) `(noema-attention-item ,item))
          (insert "\n"))))
    (goto-char (min position (point-max)))))

(defun noema-agenda-attention-refresh ()
  "Read the binding journal; this command does not scan source projects."
  (interactive)
  (if noema-agenda-attention--pending (setq noema-agenda-attention--dirty t)
    (let ((buffer (current-buffer)) (token (make-symbol "attention-request")))
      (setq noema-agenda-attention--pending token noema-agenda-attention--dirty nil)
      (noema-agenda--call
       "attention" nil
       (lambda (result error-object)
         (when (buffer-live-p buffer)
           (with-current-buffer buffer
             (when (and (derived-mode-p 'noema-agenda-attention-mode)
                        (eq token noema-agenda-attention--pending))
               (setq noema-agenda-attention--pending nil)
               (if error-object (noema-agenda--error error-object)
                 (noema-agenda-attention--render result))
               (noema-agenda-attention--visible)))))))))

(defun noema-agenda-attention--visible ()
  (when (and noema-agenda-attention--dirty (get-buffer-window (current-buffer) t))
    (noema-agenda-attention-refresh)))
(defun noema-agenda-attention-handle-change (_payload)
  (dolist (buffer (buffer-list))
    (with-current-buffer buffer
      (when (derived-mode-p 'noema-agenda-attention-mode)
        (setq noema-agenda-attention--dirty t)
        (noema-agenda-attention--visible)))))

(defun noema-agenda-attention--action (operation &optional extra)
  (let ((buffer (current-buffer))
        (id (noema-agenda--get (noema-agenda-attention--item) 'id)))
    (noema-agenda--call operation (cons (cons 'id id) extra)
                       (lambda (_result error-object)
                         (when error-object (noema-agenda--error error-object))
                         (when (buffer-live-p buffer)
                           (with-current-buffer buffer
                             (when (derived-mode-p 'noema-agenda-attention-mode)
                               (setq noema-agenda-attention--dirty t)
                               (noema-agenda-attention--visible))))))))
(defun noema-agenda-attention-sync ()
  "Refetch the selected Apple binding and retry its pending source receipt."
  (interactive) (noema-agenda-attention--action "attention-sync"))
(defun noema-agenda-attention-remove ()
  "Cancel the selected Apple promotion, preserving its source task."
  (interactive) (noema-agenda-attention--action "attention-remove"))
(defun noema-agenda-attention-forget ()
  "Forget a binding locally, leaving both Apple and the source untouched."
  (interactive) (noema-agenda-attention--action "attention-remove" '((forget . t))))
(defun noema-agenda-attention-keep-source ()
  (interactive) (noema-agenda-attention--action "attention-resolve" '((choice . "source"))))
(defun noema-agenda-attention-use-apple ()
  (interactive) (noema-agenda-attention--action "attention-resolve" '((choice . "apple"))))
(defun noema-agenda-attention-visit ()
  "Explicitly enter the source project and open the bound task."
  (interactive) (noema-agenda-attention--action "attention-visit"))

;;;###autoload
(defun noema-agenda-promote (kind)
  "Promote the current native task to an explicitly selected Apple collection."
  (interactive (list (completing-read "Global attention: " '("reminder" "event") nil t)))
  (let* ((todo (noema-agenda-item-at-point))
         (body (append (noema-agenda--locator todo) `((kind . ,kind))))
         (buffer (current-buffer)))
    (noema-agenda--call
     "attention-collections" `((kind . ,kind))
     (lambda (result error-object)
       (if error-object (noema-agenda--error error-object)
         (when (buffer-live-p buffer)
           (with-current-buffer buffer
             (let ((number 0) choices)
               (dolist (collection (noema-agenda--list (noema-agenda--get result 'collections)))
                 (when (eq (noema-agenda--get collection 'writable) t)
                   (push (cons (format "%d. %s (%s)" (cl-incf number)
                                       (noema-agenda--literal (noema-agenda--get collection 'title))
                                       (noema-agenda--literal (noema-agenda--get collection 'sourceTitle)))
                               (noema-agenda--get collection 'id)) choices)))
               (unless choices (user-error "No writable Apple collection; enable access first"))
               (setq choices (nreverse choices))
               (let ((collection (cdr (assoc (completing-read "Apple destination: " choices nil t) choices))))
                 (noema-agenda--write
                  "attention-promote"
                  (append body `((calendarId . ,collection)
                                 (timeZone . ,(noema-agenda--get result 'timeZone))
                                 (dateField . ,(if (string-empty-p (or (noema-agenda--get (noema-agenda--get todo 'canon) 'ddl) "")) "sche" "ddl"))))
                  (list (noema-agenda--get todo 'file))
                  (lambda (_reply problem)
                    (unless problem (noema-agenda-attention)))))))))))))

(defvar noema-agenda-attention-mode-map
  (let ((map (make-sparse-keymap)))
    (dolist (binding '(("g" . noema-agenda-attention-refresh) ("R" . noema-agenda-attention-sync)
                      ("d" . noema-agenda-attention-remove) ("F" . noema-agenda-attention-forget)
                      ("s" . noema-agenda-attention-keep-source) ("a" . noema-agenda-attention-use-apple)
                      ("RET" . noema-agenda-attention-visit) ("q" . quit-window)))
      (define-key map (kbd (car binding)) (cdr binding))) map))
(define-derived-mode noema-agenda-attention-mode special-mode "Noema Attention"
  "Global attention over lightweight durable bindings."
  (setq-local header-line-format " g refresh · R sync/retry · s keep source · a use Apple · d cancel · F forget · RET source project")
  (add-hook 'window-configuration-change-hook #'noema-agenda-attention--visible nil t))
;;;###autoload
(defun noema-agenda-attention ()
  (interactive)
  (pop-to-buffer (get-buffer-create "*Noema Global Attention*"))
  (unless (derived-mode-p 'noema-agenda-attention-mode) (noema-agenda-attention-mode))
  (noema-agenda-attention-refresh))
(provide 'noema-agenda-attention)
