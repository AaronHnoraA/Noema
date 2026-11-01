;;; noema-project-graph-tests.el --- Agent cache page checks -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'noema-project-graph)

(defconst noema-project-graph-tests--graph
  '((root . "/tmp/demo/") (advice . "Run next, then claim one of 1 ready tasks.")
    (rows . [((id . "a") (prefix . "") (title . "First") (phase . "done") (holder . "") (on . [])
              (file . "/tmp/demo/.agent/tasks/a.md"))
             ((id . "b") (prefix . "└─ ") (title . "Second") (phase . "waiting") (holder . "")
              (on . ["c"]) (file . "/tmp/demo/.agent/tasks/b.md"))])))

(defmacro noema-project-graph-tests--with-page (calls &rest body)
  "Run BODY in a page recording api calls into CALLS."
  (declare (indent 1))
  `(with-temp-buffer
     (noema-project-graph-mode)
     (setq noema-project-graph--root "/tmp/demo/")
     (let (,calls)
       (cl-letf (((symbol-function '+noema-api-call)
                  (lambda (channel args callback &optional _timeout)
                    (setq ,calls (append ,calls (list (list channel args callback)))))))
         ,@body))))

(defun noema-project-graph-tests--answer (call result &optional failure)
  "Answer recorded CALL with RESULT or FAILURE."
  (funcall (nth 2 call) result failure))

(ert-deftest noema-project-graph-draws-resources-graph-findings-and-journal ()
  (noema-project-graph-tests--with-page calls
    (noema-project-graph-refresh)
    (should (equal (mapcar #'car calls)
                   '("noema:api:agent:project:status" "noema:api:agent:project:graph"
                     "noema:api:agent:project:graph")))
    (noema-project-graph-tests--answer
     (nth 0 calls)
     '((cache (totalBytes . 2048) (pressure . t)) (memory (state . "ok"))
       (graph (check (errors . []) (warnings . [((code . "quiet") (task . "a") (fix . "Ask."))])))))
    (noema-project-graph-tests--answer (nth 1 calls) noema-project-graph-tests--graph)
    (noema-project-graph-tests--answer
     (nth 2 calls)
     '((events . [((at . 1000) (kind . "decision") (agent . "codex") (task . "a") (text . "Why"))])))
    (let ((page (buffer-string)))
      (should (string-match-p "2k.*under pressure" page))
      (should (string-match-p "Memory  ok" page))
      (should (string-match-p "└─ · b  Second  waiting · on c" page))
      (should (string-match-p "quiet a  Ask\\." page))
      (should (string-match-p "decision +codex +a Why" page)))))

(ert-deftest noema-project-graph-journal-shows-refs-when-text-is-empty ()
  (noema-project-graph-tests--with-page calls
    (noema-project-graph-refresh)
    (noema-project-graph-tests--answer
     (nth 2 calls) '((events . [((at . 1000) (kind . "commit") (agent . "a") (text . "") (refs . ["abc123"]))])))
    (should (string-match-p "abc123" (buffer-string)))))

(ert-deftest noema-project-graph-opens-the-task-on-the-line ()
  (noema-project-graph-tests--with-page calls
    (noema-project-graph-refresh)
    (noema-project-graph-tests--answer (nth 1 calls) noema-project-graph-tests--graph)
    (goto-char (point-min))
    (search-forward "Second")
    (let (opened)
      (cl-letf (((symbol-function 'find-file-other-window) (lambda (file) (setq opened file))))
        (noema-project-graph-open))
      (should (equal opened "/tmp/demo/.agent/tasks/b.md")))
    (goto-char (point-min))
    (should-error (noema-project-graph-open) :type 'user-error)))

(ert-deftest noema-project-graph-says-when-there-is-no-graph ()
  (noema-project-graph-tests--with-page calls
    (noema-project-graph-refresh)
    (noema-project-graph-tests--answer (nth 1 calls) '((root . "/tmp/demo/") (store . :json-false)))
    (should (string-match-p "No task graph yet" (buffer-string)))))

(ert-deftest noema-project-graph-drops-a-stale-answer-and-shows-failures ()
  (noema-project-graph-tests--with-page calls
    (noema-project-graph-refresh)
    (let ((old (nth 1 calls)))
      (setq calls nil)
      (noema-project-graph-refresh)
      (noema-project-graph-tests--answer old noema-project-graph-tests--graph)
      (should-not (string-match-p "Second" (buffer-string))))
    (noema-project-graph-tests--answer (nth 1 calls) nil '((message . "host is down")))
    (should (string-match-p "graph: host is down" (buffer-string)))))

(ert-deftest noema-project-graph-maintains-then-refreshes ()
  (noema-project-graph-tests--with-page calls
    (noema-project-graph-maintain)
    (should (equal (caar calls) "noema:api:agent:project:maintain"))
    (noema-project-graph-tests--answer (car calls) '((root . "/tmp/demo/")))
    (should (= (length calls) 4))))

;;; noema-project-graph-tests.el ends here
