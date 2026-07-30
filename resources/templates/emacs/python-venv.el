;; Python project using a local .venv virtualenv
((nil . ((my/project-local-settings
          . (:toolchain ((python . "venv:.venv"))
             :env (("PYTHONPATH" . "src"))
             :test "pytest -x"))))
 )
