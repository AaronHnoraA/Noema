;; Emacs Lisp package project (single or multi-file library)
((nil . ((my/project-local-settings
          . (:test "emacs --batch -Q -L . -f ert-run-tests-batch-and-exit"
             :task (("byte-compile" . "emacs --batch -Q -L . --eval '(byte-recompile-directory \".\" 0)'")
                   ("lint"         . "emacs --batch -Q -L . -f package-lint-batch-and-exit")
                   ("checkdoc"     . "emacs --batch -Q -L . --eval '(checkdoc-file \"*.el\")'"))))))
 (emacs-lisp-mode
  . ((indent-tabs-mode . nil)
     (fill-column . 80)
     (tab-width . 8))))
