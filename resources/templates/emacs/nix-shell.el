;; Project with a nix shell environment (shell.nix or flake.nix at root)
;; Direnv handles env injection automatically when .envrc uses nix.
;; This template adds task/run stubs using nix-shell explicitly.
((nil . ((my/project-local-settings
          . (:task (("build"   . "nix-shell --run 'make'")
                   ("develop" . "nix-shell"))
             :run  (("run" . "nix-shell --run './result/bin/app'")))))))
