;;; noema-history-search-tests.el --- Search UI checks -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'noema-history-search)

(ert-deftest noema-history-search-project-filters-and-stale-responses ()
  "Queries stay project-scoped and late responses cannot replace new results."
  (with-temp-buffer
    (noema-history-search-mode)
    (setq noema-history-search--root "/tmp/noema-history-test/"
          noema-history-search--query "spectral"
          noema-history-search--source "codex")
    (let (calls)
      (cl-letf (((symbol-function 'my/noema-api-call)
                 (lambda (channel args callback &optional _timeout)
                   (push (list channel args callback) calls))))
        (noema-history-search-refresh)
        (let ((old (nth 2 (car calls))))
          (setq noema-history-search--query "eigenvalue")
          (noema-history-search-refresh)
          (let ((body (aref (nth 1 (car calls)) 0)))
            (should (equal (alist-get 'cwd body) "/tmp/noema-history-test/"))
            (should (equal (alist-get 'projectRoot body) "/tmp/noema-history-test/"))
            (should (equal (alist-get 'source body) "codex"))
            (should (equal (alist-get 'query body) "eigenvalue")))
          (funcall (nth 2 (car calls))
                   '((hits . [((id . "current") (source . "codex")
                               (excerpt . "<mark>eigenvalue</mark> theorem"))])) nil)
          (funcall old '((hits . [((id . "stale") (excerpt . "old"))])) nil)
          (should (equal (length noema-history-search--hits) 1))
          (should (equal (noema-history-search--get (car noema-history-search--hits) "id")
                         "current"))
          (should (equal (noema-history-search--excerpt (car noema-history-search--hits))
                         "eigenvalue theorem")))))))

(provide 'noema-history-search-tests)
;;; noema-history-search-tests.el ends here
