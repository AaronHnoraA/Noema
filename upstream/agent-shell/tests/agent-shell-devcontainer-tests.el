;;; agent-shell-devcontainer-tests.el --- Tests for agent-shell Devcontainer support -*- lexical-binding: t; -*-

(require 'ert)
(require 'agent-shell)

;;; Code:

(ert-deftest agent-shell-devcontainer-resolve-path-test ()
  "Test `agent-shell-devcontainer-resolve-path' function."
  ;; Mock agent-shell-devcontainer--get-workspace-path
  (cl-letf (((symbol-function 'agent-shell-devcontainer--get-workspace-path)
             (lambda (_) "/workspace")))

    ;; Need to run in an existing directory (requirement of `file-in-directory-p')
    (let ((default-directory "/tmp"))
      ;; With text file capabilities enabled
      (let ((agent-shell-text-file-capabilities t))

        ;; Resolves container paths to local filesystem paths
        (should (equal (agent-shell-devcontainer-resolve-path "/workspace/d/f.el") "/tmp/d/f.el"))
        (should (equal (agent-shell-devcontainer-resolve-path "/workspace/f.el") "/tmp/f.el"))
        (should (equal (agent-shell-devcontainer-resolve-path "/workspace") "/tmp"))

        ;; Prevents attempts to leave local working directory
        (should-error (agent-shell-devcontainer-resolve-path "/workspace/..") :type 'error)

        ;; Resolves local filesystem paths to container paths
        (should (equal (agent-shell-devcontainer-resolve-path "/tmp/d/f.el") "/workspace/d/f.el"))
        (should (equal (agent-shell-devcontainer-resolve-path "/tmp/f.el") "/workspace/f.el"))
        (should (equal (agent-shell-devcontainer-resolve-path "/tmp") "/workspace"))

        ;; Does not resolve unexpected paths
        (should-error (agent-shell-devcontainer-resolve-path "/unexpected") :type 'error))

      ;; With text file capabilities disabled (ie. never resolve to local filesystem)
      (let ((agent-shell-text-file-capabilities nil))

        ;; Does not resolve container paths to local filesystem paths
        (should-error (agent-shell-devcontainer-resolve-path "/workspace/d/f.el") :type 'error)
        (should-error (agent-shell-devcontainer-resolve-path "/workspace/f.el.") :type 'error)
        (should-error (agent-shell-devcontainer-resolve-path "/workspace") :type 'error)
        (should-error (agent-shell-devcontainer-resolve-path "/workspace/..") :type 'error)

        ;; Resolves local filesystem paths to container paths
        (should (equal (agent-shell-devcontainer-resolve-path "/tmp/d/f.el") "/workspace/d/f.el"))
        (should (equal (agent-shell-devcontainer-resolve-path "/tmp/f.el") "/workspace/f.el"))
        (should (equal (agent-shell-devcontainer-resolve-path "/tmp") "/workspace"))

        ;; Does not resolve unexpected paths
        (should-error (agent-shell-devcontainer-resolve-path "/unexpected") :type 'error)))))

(provide 'agent-shell-devcontainer-tests)
;;; agent-shell-devcontainer-tests.el ends here
