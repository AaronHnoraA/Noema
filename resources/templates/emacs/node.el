;; Node.js project (npm/yarn/pnpm)
((nil . ((my/project-local-settings
          . (:env (("NODE_ENV" . "development"))
             :test "npm test"
             :task (("build" . "npm run build")
                   ("dev"   . "npm run dev")
                   ("lint"  . "npm run lint"))))))
 (js-ts-mode
  . ((js-indent-level . 2)
     (eglot-workspace-configuration
      . (:typescript (:tsdk "node_modules/typescript/lib")))))
 (typescript-ts-mode
  . ((typescript-indent-level . 2)
     (eglot-workspace-configuration
      . (:typescript (:tsdk "node_modules/typescript/lib")))))
 (tsx-ts-mode
  . ((typescript-indent-level . 2)
     (eglot-workspace-configuration
      . (:typescript (:tsdk "node_modules/typescript/lib"))))))
