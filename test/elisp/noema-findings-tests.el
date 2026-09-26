;;; noema-findings-tests.el --- Evidence board checks -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'noema-findings)

(ert-deftest noema-findings-project-query-and-evidence ()
  "The board requests local project claims and retains evidence metadata."
  (with-temp-buffer
    (noema-findings-mode)
    (setq noema-findings--root "/tmp/noema-findings-test/"
          noema-findings--query "signal")
    (let (body callback)
      (cl-letf (((symbol-function 'my/noema-api-call)
                 (lambda (channel args done &optional _timeout)
                   (should (equal channel "aaronnote:api:research:finding:list"))
                   (setq body (aref args 0) callback done))))
        (noema-findings-refresh)
        (should (equal (alist-get 'cwd body) "/tmp/noema-findings-test/"))
        (should (equal (alist-get 'query body) "signal"))
        (should (eq (alist-get 'includeLocal body) t))
        (funcall callback
                 '((findings . [((id . "finding-1") (kind . "claim")
                                (statement . "A signal exists")
                                (verificationLevel . "agent_checked")
                                (evidence . [((artifactId . "artifact-1")
                                              (relation . "supports"))]))])) nil)
        (should (= 1 (length noema-findings--records)))
        (should (equal (aref (cadr (car tabulated-list-entries)) 3) "1"))))))

(provide 'noema-findings-tests)
;;; noema-findings-tests.el ends here
