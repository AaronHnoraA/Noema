;;; check-agenda-source-gateway.el --- Disposable real gateway -*- lexical-binding: t; -*-
;; The parent owns this process and its temporary discovery directory.
(setq user-emacs-directory (file-name-as-directory (getenv "NOEMA_AGENDA_EMACS_ROOT")))
(require 'package)
(setq package-user-dir (expand-file-name "elpa" user-emacs-directory))
(package-initialize)
(dolist (directory '("lisp/remote" "lisp/remote/backend" "lisp/roam"))
  (add-to-list 'load-path (expand-file-name directory user-emacs-directory)))
(require 'remote-framework)
(require 'remote-gateway)
(require 'init-aaronnote-agenda-source)
(setq remote-gateway-discovery-directory (getenv "NOEMA_AGENDA_GATEWAY_TEST_STATE"))

;; This isolated process owns no editing buffers. Actual dirty-buffer
;; protection is covered by init-aaronnote-agenda-source-tests.el.
(defun my/noema--agenda-protected-sources (_params _client) '((files . [])))
(remote-gateway-register-method "aaronnote.agenda.protected-sources" #'my/noema--agenda-protected-sources)
(remote-gateway-register-method "aaronnote.agenda.source" #'my/noema--agenda-source-request)
(remote-gateway-register-method "aaronnote.event" (lambda (&rest _) '((ok . t))))
;; Disposable EventKit protocol peer for host integration. This process never
;; loads the production Apple bridge or requests personal-data permissions.
(defvar agenda-smoke-apple-items (make-hash-table :test #'equal))
(defvar agenda-smoke-apple-revision 0)
(defun agenda-smoke-apple-edit (token patch)
  (let* ((item (copy-tree (gethash token agenda-smoke-apple-items)))
         (fields (alist-get 'fields item)))
    (unless item (error "Missing disposable Apple item"))
    (dolist (field patch) (setf (alist-get (car field) fields) (cdr field)))
    (setf (alist-get 'fields item) fields
          (alist-get 'revision item) (number-to-string (cl-incf agenda-smoke-apple-revision)))
    (puthash token item agenda-smoke-apple-items)
    (when-let* ((client (remote-gateway-find-client "aaronnote")))
      (remote-gateway-notify client "aaronnote.agenda.apple-event" '((event . "changed"))))
    t))
(remote-gateway-register-method
 "aaronnote.agenda.apple"
 (lambda (body _client)
   (let* ((op (alist-get 'op body)) (token (alist-get 'token body))
          (item (gethash token agenda-smoke-apple-items)))
     (pcase op
       ("status" '((protocol . 1)))
       ("collections" '((collections . [((id . "disposable") (title . "Disposable test list") (sourceTitle . "Test only") (writable . t))])))
       ("get" (or item '((missing . t) (scopeLimited . t))))
       ("put"
        (cond
         ((and item (equal (alist-get 'fields item) (alist-get 'fields body))) item)
         ((and item (not (equal (alist-get 'revision item) (alist-get 'expectedRevision body))))
          '((error . ((code . "ECONFLICT") (message . "Disposable Apple revision changed")))))
         ((and (not item) (not (eq (alist-get 'allowCreate body) t)))
          '((error . ((code . "EUNCONFIRMED") (message . "Refusing duplicate creation")))))
         (t
          (let ((value `((itemId . ,token) (externalId . ,token)
                         (fields . ,(alist-get 'fields body))
                         (revision . ,(number-to-string (cl-incf agenda-smoke-apple-revision))))))
            (puthash token value agenda-smoke-apple-items) value))))
       ("remove" (remhash token agenda-smoke-apple-items) '((removed . t)))
       (_ (error "Unknown disposable Apple operation"))))))
(let ((binding (remote-gateway-prepare-client "aaronnote" default-directory :placement 'client
                                               :provides '("aaronnote.command" "aaronnote.api"))))
  (message "AGENDA_GATEWAY_READY %s"
           (json-encode `((url . ,(plist-get binding :websocket-url))
                          (binding . ,(plist-get binding :binding-id))))))
;; Test event loop only: production source services use OS file notifications.
(while t (accept-process-output nil 1))
