;;; noema-agenda-poc-tests.el --- Native Agenda bridge experiments -*- lexical-binding: t; -*-
(require 'ert)
(require 'noema-agenda-poc)

(defun noema-agenda-poc-test-snapshot ()
  (noema-agenda-poc-read-sources
   (mapcar (lambda (name) (expand-file-name name noema-agenda-poc--directory))
           '("example.md" "example.noema"))))

(defmacro noema-agenda-poc-test-with-view (&rest body)
  `(let ((buffer (noema-agenda-poc-open (noema-agenda-poc-test-snapshot))))
     (unwind-protect (with-current-buffer buffer ,@body)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-agenda-poc-close))))))

(defun noema-agenda-poc-test-find (text)
  (goto-char (point-min))
  (search-forward text)
  (beginning-of-line))

(ert-deftest noema-agenda-poc-native-view-mixes-markdown-and-dag ()
  (noema-agenda-poc-test-with-view
   (should (derived-mode-p 'org-agenda-mode))
   (should (equal (buffer-name) "*Noema Agenda Prototype*"))
   (noema-agenda-poc-test-find "Check the theorem assumptions")
   (should (equal (alist-get 'id (noema-agenda-poc-item-at-point)) "#proof1"))
   (noema-agenda-poc-test-find "Explore a coupling argument")
   (should (equal (alist-get 'id (noema-agenda-poc-item-at-point)) "wn_alternative"))))

(ert-deftest noema-agenda-poc-completion-is-an-intent-not-a-shadow-write ()
  (noema-agenda-poc-test-with-view
   (noema-agenda-poc-test-find "Check the theorem assumptions")
   (let* ((before (buffer-string))
          (request (noema-agenda-poc-completion-intent)))
     (should (equal (alist-get 'operation request) "aaronnote:api:notes:patch-todo"))
     (should (equal (alist-get 'selectorId (alist-get 'body request)) "#proof1"))
     (should (equal (alist-get 'op (alist-get 'body request)) "complete"))
     (should (equal before (buffer-string))))
   (noema-agenda-poc-test-find "Explore a coupling argument")
   (should (equal (alist-get 'workNodeId (noema-agenda-poc-completion-intent)) "wn_alternative"))))

(ert-deftest noema-agenda-poc-blocks-original-org-todo-write-through ()
  (noema-agenda-poc-test-with-view
   (noema-agenda-poc-test-find "Explore a coupling argument")
   (let* ((source (marker-buffer (org-get-at-bol 'org-hd-marker)))
          (before (with-current-buffer source (buffer-string))))
     (should-error (org-agenda-todo "DONE") :type 'user-error)
     (should (equal before (with-current-buffer source (buffer-string)))))))

(ert-deftest noema-agenda-poc-labels-cannot-introduce-org-control-syntax ()
  (let* ((snapshot (noema-agenda-poc-test-snapshot))
         (item (car (alist-get 'items snapshot))))
    (setf (alist-get 'title item) "Claim\n* DONE Injected <%%(error \"bad\")> [[elisp:bad]]")
    (let ((source (noema-agenda-poc--org snapshot)))
      (should-not (string-match-p "\n\\* DONE Injected" source))
      (should-not (string-match-p "<%%(" source))
      (should-not (string-match-p (regexp-quote "[[elisp:") source)))))

(ert-deftest noema-agenda-poc-keeps-user-agenda-files ()
  (let ((org-agenda-files '("/user/private/agenda.org")))
    (noema-agenda-poc-test-with-view (should (derived-mode-p 'org-agenda-mode)))
    (should (equal org-agenda-files '("/user/private/agenda.org")))))

(ert-deftest noema-agenda-poc-native-redo-keeps-the-adapter ()
  (noema-agenda-poc-test-with-view
   (org-agenda-redo)
   (should (equal (buffer-name) "*Noema Agenda Prototype*"))
   (noema-agenda-poc-test-find "Explore a coupling argument")
   (should (equal (alist-get 'id (noema-agenda-poc-item-at-point)) "wn_alternative"))
   (should (eq (key-binding (kbd "t")) #'noema-agenda-poc-completion-intent))
   (should noema-agenda-poc--projection)))
