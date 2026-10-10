;;; noema-interaction-adapter-claude.el --- Claude CLI through Ghostel -*- lexical-binding: t; -*-

;;; Code:

(require 'subr-x)
(require 'noema-interaction-cli)

(defgroup noema-interaction-claude nil
  "Claude terminal integration for noema-interaction."
  :group 'noema-interaction)

(defcustom noema-interaction-claude-executable "claude"
  "Path to the Claude CLI."
  :type 'string
  :group 'noema-interaction-claude)

(defcustom noema-interaction-claude-extra-args nil
  "Additional arguments for interactive Claude sessions."
  :type '(repeat string)
  :group 'noema-interaction-claude)

(define-minor-mode noema-interaction-claude-mode
  "Mark a Noema Claude Ghostel buffer."
  :init-value nil
  :lighter " AI-Claude")

(noema-interaction-cli-register-tool 'claude
  :name "CC – Claude Code"
  :executable-var 'noema-interaction-claude-executable
  :extra-args-var 'noema-interaction-claude-extra-args
  :env-vars '("TERM_PROGRAM=emacs")
  :buffer-prefix "claude"
  :popup-kind 'ai-claude
  :minor-mode 'noema-interaction-claude-mode
  :exec-args-fn
  (lambda (prompt _output-file _root)
    (list noema-interaction-claude-executable
          "-p" "--output-format" "text" prompt))
  :exec-output 'stdout)

(defun noema-interaction-claude-available-p ()
  "Return non-nil when the Claude CLI is available."
  (noema-interaction-cli-available-p 'claude))

(defun noema-interaction-load-claude ()
  "Validate the Claude CLI and Ghostel backend."
  (unless (noema-interaction-claude-available-p)
    (user-error "Claude executable not found: %s" noema-interaction-claude-executable))
  (noema-interaction-cli--ensure-terminal-backend 'claude))

(defun noema-interaction-claude-buffer (&optional project-root)
  "Return the Claude session buffer for PROJECT-ROOT."
  (noema-interaction-cli-buffer 'claude project-root))

(defun noema-interaction-claude-open-buffer ()
  "Open the current project's Claude session."
  (interactive)
  (noema-interaction-cli-open-buffer 'claude (noema-interaction-project-root)))

(defun noema-interaction-claude-stop (&optional project-root)
  "Stop the Claude session for PROJECT-ROOT."
  (interactive)
  (noema-interaction-cli-stop 'claude project-root))

(defun noema-interaction-claude-session-live-p (&optional project-root)
  "Return non-nil when Claude is running for PROJECT-ROOT."
  (noema-interaction-cli-session-live-p 'claude project-root))

(defun noema-interaction-claude-ensure-session (&optional project-root)
  "Ensure Claude is running for PROJECT-ROOT."
  (noema-interaction-cli-ensure-session 'claude project-root))

(defun noema-interaction-claude-prime-session (&optional project-root)
  "Send the project profile to Claude for PROJECT-ROOT."
  (noema-interaction-cli-prime-session 'claude project-root))

(defun noema-interaction-claude-send-prompt (prompt &optional project-root)
  "Send PROMPT to Claude for PROJECT-ROOT."
  (noema-interaction-cli-send-prompt 'claude prompt project-root))

(defun noema-interaction-claude-draft-prompt (prompt &optional project-root)
  "Insert PROMPT into Claude for PROJECT-ROOT without submitting."
  (noema-interaction-cli-draft-prompt 'claude prompt project-root))

(provide 'noema-interaction-adapter-claude)
;;; noema-interaction-adapter-claude.el ends here
