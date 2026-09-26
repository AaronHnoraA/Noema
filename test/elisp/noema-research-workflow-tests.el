;;; noema-research-workflow-tests.el --- Workflow template checks -*- lexical-binding: t; -*-

(require 'ert)
(require 'noema-research-workflow)

(ert-deftest noema-research-workflow-templates-roundtrip ()
  "Both templates are valid, whole documents with durable stage identities."
  (dolist (kind '("empirical" "theoretical"))
    (let* ((document (noema-research-workflow-build kind "Test project"))
           (parsed (noema-research-parse-json (noema-research-serialize document)))
           (stages (noema-research-workflow--stages parsed)))
      (should (= 9 (length stages)))
      (should (= 9 (length (noema-research-work-nodes parsed))))
      (should-not (plist-get (noema-research-validate parsed) :errors))
      (should (equal (noema-research--get
                      (noema-research--get (noema-research-notebook-meta parsed) "workflow")
                      "template") kind))
      (dolist (stage stages)
        (should (noema-research-primary-cell parsed (noema-research--get stage "node_id")))))))

(ert-deftest noema-research-workflow-gates-require-human-review ()
  "A completed literature stage cannot silently pass its review checkpoint."
  (let* ((document (noema-research-workflow-build "empirical" "Test project"))
         (stages (noema-research-workflow--stages document))
         (literature (noema-research--get (nth 1 stages) "node_id"))
         (gate (noema-research--get (nth 2 stages) "node_id")))
    (should (equal (noema-research--get (noema-research-workflow--next-stage document) "key")
                   "literature"))
    (let* ((design-id (noema-research--get (nth 3 stages) "node_id"))
           (design-cell (noema-research-primary-cell document design-id)))
      (should-error (noema-research-workflow-assert-ready document design-cell)
                    :type 'user-error))
    (should-not (noema-research-workflow-assert-ready
                 document (noema-research-primary-cell document literature)))
    (noema-research-set-state document literature "done")
    (should (equal (noema-research--get (noema-research-workflow--next-stage document) "node_id")
                   gate))
    (puthash "source" "Human review: approved by tester at 2026-09-25T09:00:00+1000"
             (noema-research-primary-cell document gate))
    (should (equal (noema-research--get (noema-research-workflow--next-stage document) "key")
                   "design"))))

(ert-deftest noema-research-workflow-public-run-api-respects-gate ()
  "The public Agent Run entry point cannot dispatch future template work."
  (let* ((document (noema-research-workflow-build "empirical" "Test project"))
         (design (nth 3 (noema-research-workflow--stages document)))
         (cell (noema-research-primary-cell document (noema-research--get design "node_id")))
         (dispatched nil))
    (cl-letf (((symbol-function 'noema-current-document) (lambda (&optional _buffer) document))
              ((symbol-function 'noema-agent-worker-run-work-cell)
               (lambda (&rest _args) (setq dispatched t))))
      (should-error (noema-run-cell cell) :type 'user-error)
      (should-not dispatched))))

(ert-deftest noema-research-workflow-approval-is-an-undoable-document-edit ()
  "Human approval persists in the canonical source and advances navigation."
  (let* ((document (noema-research-workflow-build "empirical" "Test project"))
         (stages (noema-research-workflow--stages document))
         (literature (noema-research--get (nth 1 stages) "node_id"))
         (gate (noema-research--get (nth 2 stages) "node_id")))
    (with-temp-buffer
      (insert (noema-research-serialize document))
      (noema-research-mode)
      (noema-research-structure-edit
       "finish literature"
       (lambda (current) (noema-research-set-state current literature "done")))
      (noema-research-goto-cell gate)
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (&rest _) t)))
        (noema-research-workflow-approve-gate))
      (should (noema-research-workflow--approved-p
               (noema-research-cell-source
                (noema-research-primary-cell noema-research--document gate))))
      (should (equal (noema-research--get
                      (noema-research-workflow--next-stage noema-research--document) "key")
                     "design")))))

(provide 'noema-research-workflow-tests)
;;; noema-research-workflow-tests.el ends here
