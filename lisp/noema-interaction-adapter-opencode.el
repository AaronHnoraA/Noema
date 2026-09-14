;;; noema-interaction-adapter-opencode.el --- OpenCode adapter for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Registers the OpenCode CLI tool spec with `noema-interaction-cli' and exposes
;; thin public wrappers that the rest of noema-interaction calls by name.
;; All session logic lives in noema-interaction-cli.el.

;;; Code:

(require 'noema-interaction-cli)

(defgroup noema-interaction-opencode nil
  "OpenCode terminal integration for noema-interaction."
  :group 'noema-interaction
  :prefix "noema-interaction-opencode-")

(defcustom noema-interaction-opencode-executable "opencode"
  "Path to the OpenCode executable."
  :type 'string
  :group 'noema-interaction-opencode)

(defcustom noema-interaction-opencode-extra-args nil
  "Additional command line arguments passed to OpenCode."
  :type '(repeat string)
  :group 'noema-interaction-opencode)

(defcustom noema-interaction-opencode-terminal-backend 'vterm
  "Terminal backend used for OpenCode sessions."
  :type '(choice (const vterm) (const eat))
  :group 'noema-interaction-opencode)

(define-minor-mode noema-interaction-opencode-mode
  "Minor mode marker for noema-interaction OpenCode terminal buffers."
  :init-value nil
  :lighter " AI-OpenCode")

;; ── Tool spec registration ────────────────────────────────────────────────────

(noema-interaction-cli-register-tool 'opencode
  :name "OpenCode"
  :executable-var 'noema-interaction-opencode-executable
  :extra-args-var 'noema-interaction-opencode-extra-args
  :terminal-backend-var 'noema-interaction-opencode-terminal-backend
  :env-vars '("TERM_PROGRAM=emacs")
  :buffer-prefix "opencode"
  :popup-kind 'ai-opencode
  :minor-mode 'noema-interaction-opencode-mode
  :exec-args-fn
  (lambda (prompt _output-file _root)
    ;; `opencode run <message>' runs non-interactively and exits.
    (let ((exe (if (and (boundp 'noema-interaction-opencode-executable)
                        (stringp noema-interaction-opencode-executable)
                        (not (string-empty-p noema-interaction-opencode-executable)))
                   noema-interaction-opencode-executable
                 "opencode")))
      (list exe "run" prompt)))
  :exec-output 'stdout)

;; ── Public wrappers ───────────────────────────────────────────────────────────

(defun noema-interaction-opencode-available-p ()
  "Return non-nil when the OpenCode executable is available."
  (noema-interaction-cli-available-p 'opencode))

(defun noema-interaction-opencode-load ()
  "Validate the OpenCode executable and terminal backend."
  (unless (noema-interaction-opencode-available-p)
    (error "OpenCode executable not found: %s" noema-interaction-opencode-executable))
  (noema-interaction-cli--ensure-terminal-backend 'opencode))

(defun noema-interaction-opencode-buffer (&optional project-root)
  "Return the OpenCode session buffer for PROJECT-ROOT, or nil."
  (noema-interaction-cli-buffer 'opencode project-root))

(defun noema-interaction-opencode-session-live-p (&optional project-root)
  "Return non-nil when the OpenCode session for PROJECT-ROOT is live."
  (noema-interaction-cli-session-live-p 'opencode project-root))

(defun noema-interaction-opencode-ensure-session (&optional project-root)
  "Ensure a live OpenCode session exists for PROJECT-ROOT."
  (noema-interaction-cli-ensure-session 'opencode project-root))

(defun noema-interaction-opencode-open-buffer ()
  "Open the current project's OpenCode session buffer via popup."
  (interactive)
  (noema-interaction-cli-open-buffer 'opencode (noema-interaction-project-root)))

(defun noema-interaction-opencode-prime-session (&optional project-root)
  "Inject the working directory and profile into OpenCode for PROJECT-ROOT."
  (noema-interaction-cli-prime-session 'opencode project-root))

(defun noema-interaction-opencode-send-prompt (prompt &optional project-root)
  "Send PROMPT to OpenCode, starting a session for PROJECT-ROOT when needed."
  (noema-interaction-cli-send-prompt 'opencode prompt project-root))

(defun noema-interaction-opencode-draft-prompt (prompt &optional project-root)
  "Insert PROMPT into OpenCode without submitting for PROJECT-ROOT."
  (noema-interaction-cli-draft-prompt 'opencode prompt project-root))

(defun noema-interaction-opencode-stop (&optional project-root)
  "Stop the active OpenCode session for PROJECT-ROOT."
  (interactive)
  (noema-interaction-cli-stop 'opencode project-root))

(provide 'noema-interaction-adapter-opencode)
;;; noema-interaction-adapter-opencode.el ends here
