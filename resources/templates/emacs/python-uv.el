;; Python project managed by uv
((nil . ((my/project-local-settings
          . (:env (("PYTHONPATH" . "src"))
             :test "uv run pytest -x"
             :task (("sync" . "uv sync")
                    ("lock" . "uv lock"))))))
 (python-ts-mode
  . ((python-shell-interpreter . "uv")
     (python-shell-interpreter-args . "run python3")
     (eglot-workspace-configuration
      . (:python (:pythonPath ".venv/bin/python3")))))
 (python-mode
  . ((python-shell-interpreter . "uv")
     (python-shell-interpreter-args . "run python3"))))
