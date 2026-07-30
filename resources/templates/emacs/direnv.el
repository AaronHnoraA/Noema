;; Project using direnv for environment management
;; direnv-mode runs automatically; this template documents the hook points and
;; lets you pin task commands to whatever the .envrc activates.
((nil . ((my/project-local-settings
          . (:task (("build" . "make")
                   ("test"  . "make test"))
             :run  (("run"  . "./run.sh")))))))
