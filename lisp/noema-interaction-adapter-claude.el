;;; noema-interaction-adapter-claude.el --- Claude adapter for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This module integrates Claude Code workflows into noema-interaction.

;;; Code:

(require 'subr-x)
(require 'noema-interaction-session)
(require 'noema-interaction-profile)
(require 'noema-upstream)
(require 'noema-interaction-cli)

(defvar my/terminal-startup-cd-inhibited)
(defvar claude-code-ide-use-ide-diff)
(defvar claude-code-ide-terminal-backend)
(defvar claude-code-ide-cli-path)
(defvar eat-terminal)

(defcustom noema-interaction-claude-executable
  (if (and (boundp 'claude-code-ide-cli-path)
           (stringp claude-code-ide-cli-path)
           (not (string-empty-p claude-code-ide-cli-path)))
      claude-code-ide-cli-path
    "claude")
  "Path to the Claude CLI used for headless (engine-cli bridge) requests.
The interactive vterm session is still driven by `claude-code-ide';
this executable is only used for one-shot `claude -p' chat requests."
  :type 'string
  :group 'noema-interaction)

;; ── Headless tool spec (engine-cli bridge / one-shot exec) ─────────────────────────
;; The interactive Claude session uses claude-code-ide and is not registered
;; with noema-interaction-cli.  This spec only provides the headless `claude -p'
;; path used by the CLI→engine-cli bridge.
(noema-interaction-cli-register-tool 'claude
  :name "CC – Claude Code"
  :executable-var 'noema-interaction-claude-executable
  :buffer-prefix "claude"
  :exec-args-fn
  (lambda (prompt _output-file _root)
    (list (if (and (boundp 'noema-interaction-claude-executable)
                   (stringp noema-interaction-claude-executable)
                   (not (string-empty-p noema-interaction-claude-executable)))
              noema-interaction-claude-executable
            "claude")
          "-p" "--output-format" "text"
          prompt))
  :exec-output 'stdout)

(declare-function my/vterm-popup-display-buffer "init-vterm-popup" (buffer))
(declare-function claude-code-ide "claude-code-ide" ())
(declare-function claude-code-ide-send-prompt "claude-code-ide" (&optional prompt))
(declare-function claude-code-ide--terminal-send-string "claude-code-ide" (string))
(declare-function claude-code-ide-emacs-tools-setup "claude-code-ide-emacs-tools" ())
(declare-function claude-code-ide--get-buffer-name "claude-code-ide" (&optional directory))
(declare-function turn-off-evil-mode "evil" ())
(declare-function evil-emacs-state "evil" ())
(declare-function vterm-send-string "vterm" (string &optional paste-p))
(declare-function vterm-send-return "vterm" ())
(declare-function eat-term-send-string "eat" (terminal string))

(defun noema-interaction-claude-available-p ()
  "Return non-nil when the vendored Claude package directory is present."
  (locate-library "claude-code-ide"))

(defun noema-interaction-load-claude ()
  "Load the vendored Claude Code integration package."
  (unless (noema-interaction-claude-available-p)
    (error "Vendored package not present: claude-code-ide"))
  (require 'claude-code-ide)
  (require 'claude-code-ide-emacs-tools)
  (setq claude-code-ide-use-ide-diff nil)
  (claude-code-ide-emacs-tools-setup))

(defun noema-interaction-claude-buffer (&optional project-root)
  "Return the Claude session buffer for PROJECT-ROOT."
  (noema-interaction-load-claude)
  (get-buffer (claude-code-ide--get-buffer-name project-root)))

(defun noema-interaction-claude-open-buffer ()
  "Open the current project's Claude session buffer."
  (interactive)
  (if-let* ((buffer (noema-interaction-claude-buffer (noema-interaction-project-root))))
      (progn
        (with-current-buffer buffer
          (setq-local my/vterm-popup-kind 'ai-claude)
          (setq-local my/vterm-popup-title
                      (format "Claude  %s"
                              (abbreviate-file-name
                               default-directory)))
          (when (fboundp 'evil-emacs-state)
            (evil-emacs-state))
          (when (bound-and-true-p evil-local-mode)
            (turn-off-evil-mode)))
        (my/vterm-popup-display-buffer buffer))
    (user-error "No Claude Code session for this project")))

(declare-function claude-code-ide-stop "claude-code-ide" ())

(defun noema-interaction-claude-stop (&optional project-root)
  "Stop the Claude session for PROJECT-ROOT."
  (interactive)
  (noema-interaction-load-claude)
  (let ((default-directory (or project-root default-directory)))
    (claude-code-ide-stop)))

(defun noema-interaction-claude-session-live-p (&optional project-root)
  "Return non-nil when the Claude session for PROJECT-ROOT is live."
  (when-let* ((buffer (noema-interaction-claude-buffer project-root)))
    (let ((process (get-buffer-process buffer)))
      (and process (process-live-p process)))))

(defun noema-interaction-claude-ensure-session (&optional project-root)
  "Ensure a Claude session exists for PROJECT-ROOT without stealing focus."
  (noema-interaction-load-claude)
  (let ((default-directory (or project-root default-directory)))
    (unless (noema-interaction-claude-buffer project-root)
      (let ((my/terminal-startup-cd-inhibited t))
        (save-window-excursion
          (claude-code-ide))))
    (when-let* ((buffer (noema-interaction-claude-buffer project-root)))
      (with-current-buffer buffer
        (when (fboundp 'evil-emacs-state)
          (evil-emacs-state))
        (when (bound-and-true-p evil-local-mode)
          (turn-off-evil-mode))))
    (noema-interaction-claude-buffer project-root)))

(defun noema-interaction-claude--profile-prompt (&optional project-root)
  "Return the Claude profile prompt for PROJECT-ROOT."
  (noema-interaction-profile-build-prompt project-root))

(defun noema-interaction-claude--cd-prompt (project-root)
  "Return the cd line sent to Claude before the profile for PROJECT-ROOT."
  (format "cd %s"
          (shell-quote-argument
           (directory-file-name (expand-file-name project-root)))))

(defun noema-interaction-claude--send-line-text (line)
  "Send LINE (no embedded newlines) to the current Claude buffer."
  (pcase claude-code-ide-terminal-backend
    ('vterm
     (vterm-send-string line))
    ('eat
     (when eat-terminal
       (eat-term-send-string eat-terminal line)))
    (_
     (claude-code-ide--terminal-send-string line))))

(defun noema-interaction-claude--submit-return ()
  "Press return in the current Claude buffer."
  (pcase claude-code-ide-terminal-backend
    ('vterm
     (vterm-send-return))
    ('eat
     (when eat-terminal
       (eat-term-send-string eat-terminal "\r")))
    (_
     (claude-code-ide--terminal-send-string "\r"))))

(defun noema-interaction-claude--paste-string (string)
  "Insert multi-line STRING into the current Claude buffer without submitting.
Uses Claude's `\\' + Enter convention for in-input newlines so embedded
newlines stay inside one user message instead of submitting partial
input."
  (let ((lines (split-string string "\n")))
    (while lines
      (let ((line (pop lines)))
        (unless (string-empty-p line)
          (noema-interaction-claude--send-line-text line))
        (when lines
          (sit-for 0.03)
          (noema-interaction-claude--send-line-text "\\")
          (sit-for 0.03)
          (noema-interaction-claude--submit-return))))))

(defun noema-interaction-claude--paste-and-submit (prompt)
  "Insert PROMPT then press return in the current Claude buffer."
  (noema-interaction-claude--paste-string prompt)
  (sit-for 0.1)
  (noema-interaction-claude--submit-return))

(defun noema-interaction-claude--bootstrap-prompt (project-root)
  "Return the combined cd+profile bootstrap prompt for PROJECT-ROOT.
Sent as a single message so Claude does not need to finish processing
the cd line before the profile body arrives."
  (concat (noema-interaction-claude--cd-prompt project-root)
          "\n\n"
          (noema-interaction-claude--profile-prompt project-root)))

(defun noema-interaction-claude-prime-session (&optional project-root)
  "Inject the working directory and profile into Claude for PROJECT-ROOT.
The cd line and profile body are sent as a single auto-submitted
message via bracketed paste so embedded newlines are preserved and
Claude does not need to round-trip the cd line before the profile
arrives."
  (let ((root (or project-root default-directory)))
    (unless (noema-interaction-session-profile-injected-p 'claude root)
      (noema-interaction-claude-send-prompt
       (noema-interaction-claude--bootstrap-prompt root)
       root)
      (noema-interaction-session-mark-profile-bootstrap-sent 'claude root)
      (noema-interaction-session-mark-profile-injected 'claude root)
      (noema-interaction-session-set-last-status "Claude profile injected" root))))

(defun noema-interaction-claude--send-prompt-retry (prompt project-root attempts)
  "Send PROMPT for PROJECT-ROOT, retrying up to ATTEMPTS times."
  (let ((default-directory (or project-root default-directory)))
    (if-let* ((buffer (noema-interaction-claude-buffer project-root))
              (process (get-buffer-process buffer))
              ((process-live-p process)))
        (condition-case err
            (with-current-buffer buffer
              (noema-interaction-claude--paste-and-submit prompt))
          (error
           (if (> attempts 0)
               (run-with-timer 0.3 nil
                               #'noema-interaction-claude--send-prompt-retry
                               prompt project-root (1- attempts))
             (signal (car err) (cdr err)))))
      (if (> attempts 0)
          (run-with-timer 0.3 nil
                          #'noema-interaction-claude--send-prompt-retry
                          prompt project-root (1- attempts))
        (error "Claude session did not become ready")))))

(defun noema-interaction-claude-send-prompt (prompt &optional project-root)
  "Send PROMPT to Claude, starting a session for PROJECT-ROOT when needed."
  (noema-interaction-load-claude)
  (let ((default-directory (or project-root default-directory)))
    (noema-interaction-claude-ensure-session project-root)
    (run-with-timer 0.3 nil
                    #'noema-interaction-claude--send-prompt-retry
                    prompt project-root 8)))

(defun noema-interaction-claude--draft-prompt-retry (prompt project-root attempts)
  "Insert PROMPT into Claude for PROJECT-ROOT without pressing return."
  (let ((default-directory (or project-root default-directory)))
    (if-let* ((buffer (noema-interaction-claude-buffer project-root))
              (process (get-buffer-process buffer))
              ((process-live-p process)))
        (with-current-buffer buffer
          (noema-interaction-claude--paste-string prompt))
      (if (> attempts 0)
          (run-with-timer 0.3 nil
                          #'noema-interaction-claude--draft-prompt-retry
                          prompt project-root (1- attempts))
        (error "Claude session did not become ready")))))

(defun noema-interaction-claude-draft-prompt (prompt &optional project-root)
  "Insert PROMPT into Claude, starting a session for PROJECT-ROOT when needed.
The prompt is inserted but not submitted."
  (noema-interaction-load-claude)
  (let ((default-directory (or project-root default-directory)))
    (noema-interaction-claude-ensure-session project-root)
    (run-with-timer 0.3 nil
                    #'noema-interaction-claude--draft-prompt-retry
                    prompt project-root 8)))

(provide 'noema-interaction-adapter-claude)
;;; noema-interaction-adapter-claude.el ends here
