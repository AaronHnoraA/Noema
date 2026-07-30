;; SageMath project — paths and versions are resolved by the Sage provider.
((nil . ((my/project-local-settings
          . (:toolchain ((python . sage))
             :test "sage -tp ."
             :task (("doctest"    . "sage -tp .")
                   ("build-dist" . "sage setup.py build_dist")
                   ("notebook"   . "sage --notebook=jupyter"))
             :run  (("sage" . "sage"))))))
 )
