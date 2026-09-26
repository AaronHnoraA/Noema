;;; noema-project-overview-tests.el --- Project overview checks -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'button)
(require 'noema-project-overview)
(require 'noema-sessions)

(ert-deftest noema-project-overview-ignores-stale-refresh ()
  "A slow previous response must not overwrite a newer project snapshot."
  (with-temp-buffer
    (noema-project-overview-mode)
    (setq noema-project-overview--root "/tmp/noema-overview-test/")
    (let (callbacks)
      (cl-letf (((symbol-function 'my/noema-api-call)
                 (lambda (channel _args callback &optional _timeout)
                   (push (cons channel callback) callbacks))))
        (noema-project-overview-refresh)
        (let ((old (cdr (assoc "aaronnote:api:research:task:list" callbacks))))
          (setq callbacks nil)
          (noema-project-overview-refresh)
          (funcall (cdr (assoc "aaronnote:api:research:task:list" callbacks))
                   '((tasks . [((title . "Current task") (state . "active"))])) nil)
          (funcall old '((tasks . [((title . "Stale task"))])) nil)
          (should (string-match-p "Current task" (buffer-string)))
          (should-not (string-match-p "Stale task" (buffer-string)))
          (setq noema-project-overview--root "/tmp/another-project/")
          (funcall (cdr (assoc "aaronnote:api:research:run:list" callbacks))
                   '((runs . [((id . "wrong-project"))])) nil)
          (should-not (string-match-p "wrong-project" (buffer-string)))
          (let ((prior (cdr (assoc "aaronnote:api:research:run:list" callbacks))))
            (setq callbacks nil)
            (noema-project-overview-mode)
            (setq noema-project-overview--root "/tmp/noema-overview-test/")
            (noema-project-overview-refresh)
            (funcall prior '((runs . [((id . "old-reopen"))])) nil)
            (should-not (string-match-p "old-reopen" (buffer-string)))))))))

(ert-deftest noema-project-overview-has-navigation ()
  "The overview exposes its constituent Emacs surfaces as buttons."
  (with-temp-buffer
    (noema-project-overview-mode)
    (setq noema-project-overview--root "/tmp/noema-overview-test/"
          noema-project-overview--responses (make-hash-table :test 'eq))
    (noema-project-overview--render)
    (dolist (label '("Sessions" "Skills / MCP" "Work queue" "Attention" "Agenda"
                     "New workflow" "History search" "Findings"))
      (goto-char (point-min))
      (search-forward label)
      (should (button-at (1- (point)))))))

(ert-deftest noema-project-overview-reuses-the-selected-session ()
  "Session buttons retain their own name and durable identity."
  (with-temp-buffer
    (noema-project-overview-mode)
    (setq noema-project-overview--root "/tmp/noema-overview-test/"
          noema-project-overview--responses (make-hash-table :test 'eq))
    (puthash 'sessions
             '((names . [((name . "first") (agent . "codex") (sessionId . "sid-1"))
                         ((name . "second") (agent . "claude") (sessionId . "sid-2"))]))
             noema-project-overview--responses)
    (noema-project-overview--render)
    (let (opened)
      (cl-letf (((symbol-function 'noema-sessions-open-reference)
                 (lambda (_root name session-id) (push (list name session-id) opened))))
        (goto-char (point-min))
        (search-forward "first")
        (button-activate (button-at (1- (point))))
        (goto-char (point-min))
        (search-forward "second")
        (button-activate (button-at (1- (point)))))
      (should (equal opened '(("second" "sid-2") ("first" "sid-1")))))))

(ert-deftest noema-project-overview-run-opens-durable-source ()
  "Run navigation resolves its notebook and cell identity before visiting."
  (let (requested visited cell)
    (cl-letf (((symbol-function 'my/noema-api-call)
               (lambda (channel args callback &optional _timeout)
                 (should (equal channel "aaronnote:api:research:cell:resolve"))
                 (setq requested (aref args 0))
                 (funcall callback '((file . "/tmp/source.noema")) nil)))
              ((symbol-function 'find-file) (lambda (file) (setq visited file)))
              ((symbol-function 'noema-research-goto-cell) (lambda (id) (setq cell id))))
      (noema-project-overview--open-run
       "/tmp/project/" '((notebookId . "nb-1") (cellId . "c-1")))
      (should (equal (alist-get 'notebookId requested) "nb-1"))
      (should (equal visited "/tmp/source.noema"))
      (should (equal cell "c-1")))))

(ert-deftest noema-project-overview-summary-uses-kernel-task-states ()
  "Open and blocked are the Task states; active is not a Task state."
  (with-temp-buffer
    (let ((responses (make-hash-table :test 'eq)))
      (puthash 'tasks '((tasks . [((state . "open")) ((state . "blocked"))])) responses)
      (puthash 'runs '((runs . [((status . "failed"))])) responses)
      (noema-project-overview--render-summary responses)
      (should (string-match-p "Tasks 2" (buffer-string)))
      (should (string-match-p "1 open, 1 blocked" (buffer-string)))
      (should (string-match-p "1 failed/interrupted" (buffer-string))))))

(provide 'noema-project-overview-tests)
;;; noema-project-overview-tests.el ends here
