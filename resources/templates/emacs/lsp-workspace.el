;; Custom LSP/Eglot workspace configuration
;; This generic profile works for modes without an automatic provider.
((nil . ((my/project-local-settings
          . (:language-server eglot
             :toolchain ((example . project-sdk))
             :toolchain-profiles
             ((project-sdk . (:label "Project SDK"
                              :family example
                              :modes (example-mode)
                              :path-prepend ("tools/bin")
                              :env (("SDK_ROOT" . "tools/sdk"))
                              :server-program ("tools/bin/example-ls" "--stdio")
                              :workspace (:example (:feature t))))))))))
