;;; agent-shell-command-prefix-tests.el --- Tests for agent-shell command prefix functionality -*- lexical-binding: t; -*-

(require 'ert)
(require 'agent-shell)

;;; Code:

(ert-deftest agent-shell--build-command-for-execution-test ()
  "Test `agent-shell--build-command-for-execution' function."

  ;; No command prefix configured (nil)
  (let ((agent-shell-command-prefix nil))
    (should (equal (agent-shell--build-command-for-execution
                    '("claude-agent-acp"))
                   '("claude-agent-acp"))))

  ;; Static list
  (let ((agent-shell-command-prefix
         '("devcontainer" "exec" "--workspace-folder" ".")))
    (should (equal (agent-shell--build-command-for-execution
                    '("claude-agent-acp"))
                   '("devcontainer" "exec" "--workspace-folder" "." "claude-agent-acp"))))

  ;; Function
  (let ((agent-shell-command-prefix
         (lambda (buffer)
           '("devcontainer" "exec" "--workspace-folder" "."))))
    (should (equal (agent-shell--build-command-for-execution
                    '("claude-agent-acp"))
                   '("devcontainer" "exec" "--workspace-folder" "." "claude-agent-acp")))))

(provide 'agent-shell-command-prefix-tests)
;;; agent-shell-command-prefix-tests.el ends here
