;; Python project using a conda environment
;; Replace "myenv" with your actual conda environment name.
((nil . ((my/project-local-settings
          . (:toolchain ((python . "conda:myenv"))
             :env (("PYTHONPATH" . "src"))
             :test "conda run -n myenv pytest -x"
             :task (("activate" . "conda activate myenv"))))))
 )
