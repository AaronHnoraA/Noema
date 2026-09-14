;;; noema-agent-acp.el --- Noema boundary for embedded agent-shell/ACP -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; The complete embedded agent-shell and acp.el implementations own physical
;; agent sessions.  Noema owns durable work/session identity.  All coupling to
;; agent-shell implementation details is isolated here so document workers do
;; not serialize agent-shell buffers or private state as canonical data.

;;; Code:

(require 'map)
(require 'seq)
(require 'noema-upstream)
(require 'agent-shell)
(require 'acp)

(declare-function magent-start "magent-agent-shell" ())

(defun noema-agent-acp--state (&optional buffer)
  "Return embedded agent-shell state for BUFFER or the current buffer."
  (with-current-buffer (or buffer (current-buffer))
    agent-shell--state))

(defun noema-agent-acp-state-value (buffer path &optional default)
  "Read PATH from BUFFER's agent-shell state, returning DEFAULT if absent."
  (or (map-nested-elt (noema-agent-acp--state buffer) path) default))

(defun noema-agent-acp-agent-buffer-p (buffer)
  "Return non-nil when BUFFER is an embedded agent-shell session."
  (and (buffer-live-p buffer)
       (with-current-buffer buffer (derived-mode-p 'agent-shell-mode))))

(defun noema-agent-acp-resolve-config (identifier)
  "Resolve embedded agent-shell configuration IDENTIFIER."
  (copy-tree (agent-shell--resolve-config-designator identifier)))

(cl-defun noema-agent-acp-start (&key config directory session-id fork-session-id)
  "Start CONFIG in DIRECTORY, optionally resuming or forking a native session."
  (let ((default-directory (file-name-as-directory directory)))
    (agent-shell--start :config config :no-focus nil :new-session t
                        :session-strategy 'new :session-id session-id
                        :fork-session-id fork-session-id)))

(cl-defun noema-agent-acp-subscribe (&key buffer event callback)
  "Subscribe CALLBACK to EVENT in agent-shell BUFFER."
  (agent-shell-subscribe-to :shell-buffer buffer :event event :on-event callback))

(defun noema-agent-acp-set-permission-responder (buffer responder)
  "Install RESPONDER for structured permission requests in BUFFER."
  (with-current-buffer buffer
    (setq-local agent-shell-permission-responder-function responder)))

(cl-defun noema-agent-acp-prompt (&key buffer content on-success on-failure)
  "Send structured CONTENT through BUFFER's initialized ACP session."
  (with-current-buffer buffer
    (let ((state agent-shell--state))
      (agent-shell--send-request
       :state state :client (map-elt state :client)
       :request (acp-make-session-prompt-request
                 :session-id (map-nested-elt state '(:session :id))
                 :prompt content)
       :buffer buffer :on-success on-success :on-failure on-failure))))

(defun noema-agent-acp-interrupt (buffer &optional force)
  "Interrupt the active request in BUFFER; FORCE skips confirmation."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (with-current-buffer buffer (agent-shell-interrupt force))))

(defun noema-agent-acp-shutdown (buffer)
  "Shut down BUFFER's physical ACP client."
  (when (noema-agent-acp-agent-buffer-p buffer)
    (with-current-buffer buffer (agent-shell--shutdown))))

(defun noema-agent-acp-available-modes (buffer)
  "Return BUFFER's native ACP session modes."
  (with-current-buffer buffer
    (when (fboundp 'agent-shell--get-available-modes)
      (agent-shell--get-available-modes agent-shell--state))))

(cl-defun noema-agent-acp-set-mode (buffer mode-id on-success on-failure)
  "Set BUFFER to native MODE-ID and invoke completion callbacks."
  (with-current-buffer buffer
    (agent-shell--config-option-set-mode-id
     :mode-id mode-id :on-success on-success :on-failure on-failure)))

;;;###autoload
(defun noema-agent-start (&optional agent)
  "Open an embedded structured AGENT session.
Interactively select Magent, Codex, Claude Code, OpenCode or Pi."
  (interactive
   (list (intern
          (completing-read "Noema agent: "
                           '("magent" "codex" "claude" "opencode" "pi")
                           nil t nil nil "magent"))))
  (pcase (or agent 'magent)
    ('magent
     (require 'magent-agent-shell)
     (magent-start))
    ('codex
     (require 'agent-shell-openai)
     (agent-shell-openai-start-codex))
    ('claude
     (require 'agent-shell-anthropic)
     (agent-shell-anthropic-start-claude-code))
    ('opencode
     (require 'agent-shell-opencode)
     (agent-shell-opencode-start-agent))
    ('pi
     (require 'agent-shell-pi)
     (agent-shell-pi-start-agent))
    (_ (user-error "Unsupported Noema agent: %s" agent))))

(provide 'noema-agent-acp)
;;; noema-agent-acp.el ends here
