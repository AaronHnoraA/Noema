;;; noema-interaction-adapter-codex.el --- Codex adapter for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Registers the Codex CLI tool spec with `noema-interaction-cli' and exposes
;; thin public wrappers that the rest of noema-interaction calls by name.
;; All session logic lives in noema-interaction-cli.el.

;;; Code:

(require 'noema-interaction-cli)

(defgroup noema-interaction-codex nil
  "Codex terminal integration for noema-interaction."
  :group 'noema-interaction
  :prefix "noema-interaction-codex-")

(defcustom noema-interaction-codex-executable "codex"
  "Path to the Codex CLI executable."
  :type 'string
  :group 'noema-interaction-codex)

(defcustom noema-interaction-codex-extra-args nil
  "Additional command line arguments passed to Codex."
  :type '(repeat string)
  :group 'noema-interaction-codex)

(defcustom noema-interaction-codex-terminal-backend 'vterm
  "Terminal backend used for Codex sessions."
  :type '(choice (const vterm) (const eat))
  :group 'noema-interaction-codex)

(defvar noema-interaction-codex-use-exec nil
  "Deprecated toggle kept for compatibility. Codex defaults to terminal mode.")

(define-minor-mode noema-interaction-codex-mode
  "Minor mode marker for noema-interaction Codex terminal buffers."
  :init-value nil
  :lighter " AI-Codex")

;; ── Tool spec registration ────────────────────────────────────────────────────

(noema-interaction-cli-register-tool 'codex
  :name "Codex CLI"
  :executable-var 'noema-interaction-codex-executable
  :extra-args-var 'noema-interaction-codex-extra-args
  :terminal-backend-var 'noema-interaction-codex-terminal-backend
  :env-vars '("TERM_PROGRAM=emacs" "FORCE_CODE_TERMINAL=true")
  :buffer-prefix "codex"
  :popup-kind 'ai-codex
  :minor-mode 'noema-interaction-codex-mode
  :exec-args-fn
  (lambda (prompt output-file root)
    (list (if (and (boundp 'noema-interaction-codex-executable)
                   (stringp noema-interaction-codex-executable)
                   (not (string-empty-p noema-interaction-codex-executable)))
              noema-interaction-codex-executable
            "codex")
          "exec"
          "--skip-git-repo-check"
          "--ephemeral"
          "--color" "never"
          "-C" root
          "-s" "workspace-write"
          "-o" output-file
          prompt))
  :exec-output 'file)

;; ── Public wrappers ───────────────────────────────────────────────────────────

(defun noema-interaction-codex-available-p ()
  "Return non-nil when the Codex executable is available."
  (noema-interaction-cli-available-p 'codex))

(defun noema-interaction-codex-load ()
  "Validate the Codex executable and terminal backend."
  (unless (noema-interaction-codex-available-p)
    (error "Codex executable not found: %s" noema-interaction-codex-executable))
  (noema-interaction-cli--ensure-terminal-backend 'codex))

(defun noema-interaction-codex-buffer (&optional project-root)
  "Return the Codex session buffer for PROJECT-ROOT, or nil."
  (noema-interaction-cli-buffer 'codex project-root))

(defun noema-interaction-codex-session-live-p (&optional project-root)
  "Return non-nil when the Codex session for PROJECT-ROOT is live."
  (noema-interaction-cli-session-live-p 'codex project-root))

(defun noema-interaction-codex-ensure-session (&optional project-root)
  "Ensure a live Codex session exists for PROJECT-ROOT."
  (noema-interaction-cli-ensure-session 'codex project-root))

(defun noema-interaction-codex-open-buffer ()
  "Open the current project's Codex session buffer via popup."
  (interactive)
  (noema-interaction-cli-open-buffer 'codex (noema-interaction-project-root)))

(defalias 'noema-interaction-codex-open-active-buffer #'noema-interaction-codex-open-buffer)

(defun noema-interaction-codex-prime-session (&optional project-root)
  "Inject the working directory and profile into Codex for PROJECT-ROOT."
  (noema-interaction-cli-prime-session 'codex project-root))

(defun noema-interaction-codex-send-prompt (prompt &optional project-root)
  "Send PROMPT to Codex, starting a session for PROJECT-ROOT when needed."
  (noema-interaction-cli-send-prompt 'codex prompt project-root))

(defun noema-interaction-codex-draft-prompt (prompt &optional project-root)
  "Insert PROMPT into Codex without submitting for PROJECT-ROOT."
  (noema-interaction-cli-draft-prompt 'codex prompt project-root))

(defun noema-interaction-codex-stop (&optional project-root)
  "Stop the active Codex session for PROJECT-ROOT."
  (interactive)
  (noema-interaction-cli-stop 'codex project-root))

;; ── Deprecated shims ──────────────────────────────────────────────────────────

(defun noema-interaction-codex-execution-mode ()
  "Return the current Codex execution mode (always terminal)."
  'terminal)

(defun noema-interaction-codex-toggle-execution-mode ()
  "No-op kept for compatibility. Codex always uses terminal mode."
  (interactive)
  (setq noema-interaction-codex-use-exec nil)
  (message "noema-interaction Codex mode: terminal"))

(provide 'noema-interaction-adapter-codex)
;;; noema-interaction-adapter-codex.el ends here
