;; Project with a local nix flake (flake.nix at root)
;; Uses `nix develop` as the dev shell; direnv + `use flake` handles env injection.
;; If direnv is active the tasks below are redundant but left as explicit fallbacks.
((nil . ((my/project-local-settings
          . (:task (("develop" . "nix develop")
                   ("build"   . "nix build")
                   ("run"     . "nix run .")
                   ("check"   . "nix flake check")
                   ("update"  . "nix flake update"))
             :run  (("result" . "./result/bin/app")))))))
