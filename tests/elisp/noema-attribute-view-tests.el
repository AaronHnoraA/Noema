;;; noema-attribute-view-tests.el --- Native attribute view checks -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'noema-attribute-view)

(defconst noema-attribute-view-tests--note
  "# Plan

```markdown
#+begin av Example only
source: todo
#+end av
```

#+begin av Open work
source: todo
columns: text, status, prio
#+end av

#+begin av Unclosed
source: todo
")

(defconst noema-attribute-view-tests--result
  '((title . "Open work") (source . "todo") (total . 3) (truncated . t)
    (columns . [((key . "text") (label . "Text"))
                ((key . "prio") (label . "Prio") (type . "number"))])
    (rows . [((id . "t1") (kind . "todo") (file . "/tmp/n.md") (index . 0) (line . 4)
              (cells . [((key . "text") (value . "Write")) ((key . "prio") (value . "2"))]))
             ((id . "t2") (kind . "todo") (file . "/tmp/n.md") (index . 1) (line . 5)
              (cells . [((key . "text") (value . "Read")) ((key . "prio") (value . "1"))]))])
    (diagnostics . [((line . 3) (message . "Unknown key"))])
    (calculations . [((key . "prio") (operator . "sum") (value . 3))])))

(defmacro noema-attribute-view-tests--with-view (calls &rest body)
  "Run BODY in a view buffer recording host calls into CALLS."
  (declare (indent 1))
  `(with-temp-buffer
     (noema-attribute-view-mode)
     (setq noema-attribute-view--spec
           (list :file "/tmp/n.md" :title "Open work" :source "source: todo" :line 9))
     (let (,calls)
       (cl-letf (((symbol-function '+noema--ensure-server) (lambda (callback) (funcall callback)))
                 ((symbol-function '+noema-api-call)
                  (lambda (channel args callback &optional _timeout)
                    (setq ,calls (append ,calls (list (list channel args callback)))))))
         ,@body))))

(ert-deftest noema-attribute-view-finds-closed-blocks-outside-fences ()
  (let ((blocks (noema-attribute-view-blocks noema-attribute-view-tests--note)))
    (should (= 1 (length blocks)))
    (should (equal "Open work" (plist-get (car blocks) :title)))
    (should (= 9 (plist-get (car blocks) :line)))
    (should (equal "source: todo\ncolumns: text, status, prio"
                   (plist-get (car blocks) :source)))))

(ert-deftest noema-attribute-view-sends-the-spec-unchanged ()
  (noema-attribute-view-tests--with-view calls
    (noema-attribute-view-refresh)
    (should (equal "noema:api:notes:attribute-view" (car (car calls))))
    (let ((body (aref (nth 1 (car calls)) 0)))
      (should (equal "source: todo" (alist-get 'source body)))
      (should (equal "/tmp/n.md" (alist-get 'file body))))))

(ert-deftest noema-attribute-view-draws-rows-diagnostics-and-calculations ()
  (noema-attribute-view-tests--with-view calls
    (noema-attribute-view-refresh)
    (funcall (nth 2 (car calls)) noema-attribute-view-tests--result nil)
    (let ((text (buffer-string)))
      (should (string-match-p "2 of 3 rows (limit)" text))
      (should (string-match-p "line 3: Unknown key" text))
      (should (string-match-p "Write" text))
      (should (string-match-p "Read" text))
      (should (string-match-p "prio sum +3" text)))))

(ert-deftest noema-attribute-view-drops-stale-answers ()
  (noema-attribute-view-tests--with-view calls
    (noema-attribute-view-refresh)
    (noema-attribute-view-refresh)
    (funcall (nth 2 (car calls)) noema-attribute-view-tests--result nil)
    (should-not (string-match-p "Write" (buffer-string)))))

(ert-deftest noema-attribute-view-groups-kanban-rows ()
  (let ((groups (noema-attribute-view--groups
                 (list '((group . "todo") (id . "a")) '((group . "done") (id . "b"))
                       '((group . "todo") (id . "c"))))))
    (should (equal '("todo" "done") (mapcar #'car groups)))
    (should (equal '("a" "c") (mapcar (lambda (row) (alist-get 'id row)) (cdr (car groups)))))))

(ert-deftest noema-attribute-view-edit-writes-through-the-host ()
  (noema-attribute-view-tests--with-view calls
    (noema-attribute-view-refresh)
    (funcall (nth 2 (car calls)) noema-attribute-view-tests--result nil)
    (cl-letf (((symbol-function 'noema-attribute-view--row)
               (lambda () (aref (alist-get 'rows noema-attribute-view-tests--result) 0)))
              ((symbol-function 'noema-attribute-view--column-key) (lambda () "prio"))
              ((symbol-function 'read-string) (lambda (&rest _) "5")))
      (noema-attribute-view-edit))
    (let ((patch (nth 1 calls)))
      (should (equal "noema:api:notes:attribute-view-cell-patch" (car patch)))
      (should (equal "5" (alist-get 'value (aref (nth 1 patch) 0))))
      (should (equal "t1" (alist-get 'id (aref (nth 1 patch) 0))))
      ;; A successful write asks for the view again.
      (funcall (nth 2 patch) '((changed . t)) nil)
      (should (equal "noema:api:notes:attribute-view" (car (nth 2 calls)))))))

;;; noema-attribute-view-tests.el ends here
