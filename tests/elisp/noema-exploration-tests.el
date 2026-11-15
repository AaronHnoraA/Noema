;;; noema-exploration-tests.el --- Explorations page checks -*- lexical-binding: t; -*-

;; Contract: docs/noema/design/math-exploration.md E13.

(require 'ert)
(require 'cl-lib)
(require 'noema-exploration)

(defconst noema-exploration-tests--status
  '((id . "20261116-squares") (title . "Sum of squares") (state . "running") (minutesLeft . 42)
    (dir . "/tmp/demo/explorations/20261116-squares/")
    (advice . "Reports wait for a verdict: read them, then decide with verdict.")
    (members . [((name . "m1") (state . "waiting") (direction . "d1") (idle . :json-false) (lost . :json-false)
                 (notebook . "/tmp/demo/explorations/20261116-squares/m1.md"))
                ((name . "m2") (state . "holding") (direction . "d2") (idle . t) (lost . :json-false)
                 (notebook . "/tmp/demo/explorations/20261116-squares/m2.md"))])
    (directions . [((id . "d1") (member . "m1") (text . "Gaussian integers") (state . "waiting") (stalled . :json-false)
                    (reports . [((report . "n is a sum of two squares iff …"))]))
                   ((id . "d2") (member . "m2") (text . "Descent") (state . "open") (stalled . t) (reports . []))])))

(defmacro noema-exploration-tests--with-page (calls &rest body)
  "Run BODY in a page recording API calls into CALLS."
  (declare (indent 1))
  `(with-temp-buffer
     (noema-exploration-mode)
     (setq noema-exploration--root "/tmp/demo/")
     (let (,calls)
       (cl-letf (((symbol-function '+noema-api-call)
                  (lambda (channel args callback &optional _timeout)
                    (setq ,calls (append ,calls (list (list channel (aref args 0) callback)))))))
         ,@body))))

(defun noema-exploration-tests--answer (call result &optional failure)
  "Answer recorded CALL with RESULT or FAILURE."
  (funcall (nth 2 call) result failure))

(defmacro noema-exploration-tests--draw (calls)
  "Answer the list, then the status it asks for, in CALLS: one exploration drawn."
  `(progn
     (noema-exploration-tests--answer (nth 0 ,calls) '((explorations . [((id . "20261116-squares"))])))
     (noema-exploration-tests--answer (nth 1 ,calls) noema-exploration-tests--status)))

(ert-deftest noema-exploration-draws-members-directions-and-waiting-reports ()
  (noema-exploration-tests--with-page calls
    (noema-exploration-refresh)
    (should (equal (alist-get 'op (nth 1 (car calls))) "list"))
    (noema-exploration-tests--draw calls)
    (should (equal (alist-get 'op (nth 1 (nth 1 calls))) "status"))
    (let ((page (buffer-string)))
      (should (string-match-p "Sum of squares  20261116-squares · 42 min left" page))
      (should (string-match-p "m2  holding  d2  (run ended)" page))
      (should (string-match-p "◑ d1 Gaussian integers  m1" page))
      (should (string-match-p "n is a sum of two squares iff …  — a accept, r reject" page))
      (should (string-match-p "d2 Descent  m2 · stalled" page)))))

(ert-deftest noema-exploration-opens-the-notebook-of-a-direction ()
  (noema-exploration-tests--with-page calls
    (noema-exploration-refresh)
    (noema-exploration-tests--draw calls)
    (goto-char (point-min))
    (search-forward "d2 Descent")
    (should (equal (get-text-property (point) 'noema-exploration-file)
                   "/tmp/demo/explorations/20261116-squares/m2.md"))
    (goto-char (point-min))
    (search-forward "Sum of squares")
    (should (equal (get-text-property (point) 'noema-exploration-file)
                   "/tmp/demo/explorations/20261116-squares/problem.md"))))

(ert-deftest noema-exploration-records-the-person-s-verdict ()
  (noema-exploration-tests--with-page calls
    (noema-exploration-refresh)
    (noema-exploration-tests--draw calls)
    (goto-char (point-min))
    (search-forward "d2 Descent")
    (should-error (noema-exploration-reject) :type 'user-error)
    (goto-char (point-min))
    (search-forward "d1 Gaussian")
    (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "Step 2 needs n squarefree")))
      (noema-exploration-reject))
    (let ((body (nth 1 (car (last calls)))))
      (should (equal (alist-get 'op body) "verdict"))
      (should (equal (alist-get 'member body) "m1"))
      (should (eq (alist-get 'accept body) :json-false))
      (should (equal (alist-get 'by body) "person"))
      (should (equal (alist-get 'reason body) "Step 2 needs n squarefree")))
    (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "  ")))
      (should-error (noema-exploration-reject) :type 'user-error))))

(ert-deftest noema-exploration-start-and-page-are-input-slash-commands ()
  (require 'tools/agent/actions)
  (should (eq (cadr (assoc "explore" (+agent-actions-slash-commands))) 'noema-exploration-start))
  (should (eq (cadr (assoc "explorations" (+agent-actions-slash-commands))) 'noema-exploration)))

(provide 'noema-exploration-tests)
;;; noema-exploration-tests.el ends here
