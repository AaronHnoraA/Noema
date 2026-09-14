;;; noema-interaction-hub.el --- Management hub for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; A management dashboard for the noema-interaction system using the aaron-ui-board
;; toolkit.  Shows registered CLI agent backends (CC, Codex, OpenCode) and
;; provides actions for lifecycle, profile, and session management.
;;
;; HTTP model backends have been removed.  CLI agents are the only backends.
;; Use `noema-interaction' (C-c A W) to pick and open an interactive vterm session.

;;; Code:

(require 'aaron-ui-board)
(require 'cl-lib)
(require 'subr-x)
(require 'noema-interaction-session)
(require 'noema-interaction-profile)

(declare-function noema-interaction-open              "noema-interaction" ())
(declare-function noema-interaction-open-backend-buffer "noema-interaction" ())
(declare-function noema-interaction-cycle-backend     "noema-interaction" ())
(declare-function noema-interaction-switch-profile    "noema-interaction" (&optional profile))
(declare-function noema-interaction-preview-profile   "noema-interaction" (&optional profile))
(declare-function noema-interaction-create-profile    "noema-interaction" (name &optional base-profile))
(declare-function noema-interaction-edit-shared-snippet "noema-interaction" (&optional name))
(declare-function noema-interaction-edit-template     "noema-interaction" (&optional name))
(declare-function noema-interaction-stop              "noema-interaction" ())
(declare-function noema-interaction-kill              "noema-interaction" ())
(declare-function noema-interaction-output-open       "noema-interaction-output" ())
(declare-function noema-interaction-result-open       "noema-interaction-result" ())
(declare-function noema-interaction-claude-session-live-p   "noema-interaction-adapter-claude"   (&optional project-root))
(declare-function noema-interaction-codex-session-live-p    "noema-interaction-adapter-codex"    (&optional project-root))
(declare-function noema-interaction-opencode-session-live-p "noema-interaction-adapter-opencode" (&optional project-root))
(declare-function noema-interaction-engine-cli-activate-backend "noema-interaction-engine-cli" (tool-id))

(defconst noema-interaction-hub-buffer-name "*AI Workbench Hub*"
  "Buffer name for the noema-interaction management hub.")

(defvar noema-interaction-hub-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map aaron-ui-board-mode-map)
    (define-key map (kbd "b") #'noema-interaction-hub-cycle-backend)
    (define-key map (kbd "B") #'noema-interaction-hub-open-backend-buffer)
    (define-key map (kbd "p") #'noema-interaction-hub-switch-profile)
    (define-key map (kbd "v") #'noema-interaction-hub-preview-profile)
    (define-key map (kbd "+") #'noema-interaction-hub-create-profile)
    (define-key map (kbd "e") #'noema-interaction-hub-edit-profile)
    (define-key map (kbd "s") #'noema-interaction-hub-edit-snippet)
    (define-key map (kbd "t") #'noema-interaction-hub-edit-template)
    (define-key map (kbd "o") #'noema-interaction-hub-open-output)
    (define-key map (kbd "r") #'noema-interaction-hub-open-result)
    (define-key map (kbd "x") #'noema-interaction-hub-stop)
    (define-key map (kbd "k") #'noema-interaction-hub-kill)
    (define-key map (kbd "q") #'quit-window)
    map)
  "Keymap for `noema-interaction-hub-mode'.")

(define-derived-mode noema-interaction-hub-mode aaron-ui-board-mode "AI-Hub"
  "Major mode for the noema-interaction management hub."
  (setq-local truncate-lines t))

;; ── Backend helpers ───────────────────────────────────────────────────────────

(defun noema-interaction-hub--cli-session-live-p (backend &optional project-root)
  "Return non-nil when CLI BACKEND has a live session for PROJECT-ROOT."
  (pcase backend
    ('claude   (and (fboundp 'noema-interaction-claude-session-live-p)
                    (noema-interaction-claude-session-live-p project-root)))
    ('codex    (and (fboundp 'noema-interaction-codex-session-live-p)
                    (noema-interaction-codex-session-live-p project-root)))
    ('opencode (and (fboundp 'noema-interaction-opencode-session-live-p)
                    (noema-interaction-opencode-session-live-p project-root)))
    (_ nil)))

(defun noema-interaction-hub--backend-tone (live)
  "Return the badge tone for LIVE status."
  (if live 'success 'muted))

(defun noema-interaction-hub--cli-label (backend)
  "Return a display label for CLI BACKEND."
  (pcase backend
    ('claude   "CC – Claude Code")
    ('codex    "Codex CLI")
    ('opencode "OpenCode")
    (_ (format "%s" backend))))

;; ── Actions ───────────────────────────────────────────────────────────────────

(defun noema-interaction-hub--default-directory ()
  "Return the project root tracked by the hub buffer."
  (or (and (derived-mode-p 'noema-interaction-hub-mode)
           (bound-and-true-p default-directory))
      default-directory))

(defun noema-interaction-hub-cycle-backend ()
  "Cycle the active noema-interaction backend."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-cycle-backend)
    (noema-interaction-hub-refresh)))

(defun noema-interaction-hub-open-backend-buffer ()
  "Open the active backend's session buffer."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (noema-interaction-open)
    (noema-interaction-open-backend-buffer)
    (noema-interaction-hub-refresh)))

(defun noema-interaction-hub-switch-profile ()
  "Switch the active profile."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-switch-profile)
    (noema-interaction-hub-refresh)))

(defun noema-interaction-hub-preview-profile ()
  "Preview the active profile."
  (interactive)
  (let* ((root (noema-interaction-hub--default-directory))
         (profile (noema-interaction-session-profile root)))
    (noema-interaction-preview-profile profile)))

(defun noema-interaction-hub-create-profile ()
  "Create a new profile."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-create-profile)
    (noema-interaction-hub-refresh)))

(defun noema-interaction-hub-edit-profile ()
  "Edit the active profile."
  (interactive)
  (let* ((root (noema-interaction-hub--default-directory))
         (profile (noema-interaction-session-profile root)))
    (noema-interaction-profile-open profile)
    (noema-interaction-hub-refresh)))

(defun noema-interaction-hub-edit-snippet ()
  "Edit a shared snippet."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-edit-shared-snippet)))

(defun noema-interaction-hub-edit-template ()
  "Edit a prompt template."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-edit-template)))

(defun noema-interaction-hub-open-output ()
  "Open the noema-interaction output log."
  (interactive)
  (noema-interaction-output-open))

(defun noema-interaction-hub-open-result ()
  "Open the noema-interaction result buffer."
  (interactive)
  (noema-interaction-result-open))

(defun noema-interaction-hub-stop ()
  "Stop the active backend run."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-stop)
    (noema-interaction-hub-refresh)))

(defun noema-interaction-hub-kill ()
  "Kill the active backend session."
  (interactive)
  (let ((default-directory (noema-interaction-hub--default-directory)))
    (call-interactively #'noema-interaction-kill)
    (noema-interaction-hub-refresh)))

;; ── Render helpers ────────────────────────────────────────────────────────────

(defun noema-interaction-hub--render-section-overview (project-root)
  "Render the overview section for PROJECT-ROOT."
  (aaron-ui-board-insert-section "Overview")
  (aaron-ui-board-insert-field
   "Project"
   (abbreviate-file-name project-root)
   'aaron-ui-board-path)
  (let* ((backend (noema-interaction-session-backend project-root))
         (label (pcase backend
                  ('claude   "CC – Claude Code")
                  ('codex    "Codex CLI")
                  ('opencode "OpenCode")
                  ('chat     "Chat (engine frontend)")
                  (_ (symbol-name backend)))))
    (aaron-ui-board-insert-field "Active Backend" label))
  (let ((profile (noema-interaction-session-profile project-root)))
    (aaron-ui-board-insert-field "Profile" (or profile "default")))
  (aaron-ui-board-insert-field
   "Initialized"
   (if (noema-interaction-session-initialized-p project-root) "yes" "no"))
  (aaron-ui-board-insert-field
   "Run State"
   (format "%s" (noema-interaction-session-run-state project-root)))
  (aaron-ui-board-insert-field
   "Last Status"
   (or (noema-interaction-session-last-status project-root) "-"))
  (insert "\n"))

(defun noema-interaction-hub--render-section-cli-backends (project-root)
  "Render the CLI engine status section for PROJECT-ROOT."
  (aaron-ui-board-insert-section "CLI Engines" 3)
  (dolist (backend '(claude codex opencode))
    (let* ((live   (noema-interaction-hub--cli-session-live-p backend project-root))
           (tone   (noema-interaction-hub--backend-tone live))
           (label  (noema-interaction-hub--cli-label backend))
           (active (eq backend (noema-interaction-session-backend project-root))))
      (aaron-ui-board-insert-row
       :id backend
       :icon 'terminal
       :badge (if live "live" "idle")
       :badge-tone tone
       :title (if active (concat label "  ●active") label)
       :title-face (if active 'aaron-ui-board-badge-info nil)
       :meta (if live "session running" "no session")
       :action (lambda (_)
                 (let ((default-directory project-root))
                   (noema-interaction-session-set-backend backend)
                   (noema-interaction-session-set-initialized t project-root)
                   ;; Sync the engine's noema-interaction-backend var and persist.
                   (when (fboundp 'noema-interaction-engine-cli-activate-backend)
                     (noema-interaction-engine-cli-activate-backend backend))
                   (message "noema-interaction default backend: %s" label)
                   (noema-interaction-hub-refresh)))
       :help (format "RET: set default backend to %s" label))))
  (insert "\n"))

(defun noema-interaction-hub--render-section-profiles (project-root)
  "Render the profile management section for PROJECT-ROOT."
  (let* ((active (noema-interaction-session-profile project-root)))
    (aaron-ui-board-insert-section "Profiles")
    (dolist (profile (noema-interaction-profile-names))
      (let* ((summary (noema-interaction-profile-summary profile))
             (current (string= profile active)))
        (aaron-ui-board-insert-row
         :id (intern profile)
         :icon 'template
         :badge (if current "active" nil)
         :badge-tone (if current 'info 'muted)
         :title profile
         :title-face (if current 'aaron-ui-board-badge-info nil)
         :meta summary
         :action (lambda (_)
                   (let ((default-directory project-root))
                     (noema-interaction-session-set-profile profile)
                     (noema-interaction-session-reset-profile-injected project-root)
                     (noema-interaction-hub-refresh)))
         :help "RET: switch to this profile")))
    (insert "\n")))

(defun noema-interaction-hub--render-section-actions (&optional _project-root)
  "Render the action toolbar."
  (aaron-ui-board-insert-section "Actions")
  (aaron-ui-board-insert-actions
   `((:label "Open Backend" :command noema-interaction-hub-open-backend-buffer
      :help "Launch & open the default backend's session" :primary t)
     (:label "Cycle" :command noema-interaction-hub-cycle-backend
      :help "Cycle default backend: cc → codex → opencode")
     (:label "Stop" :command noema-interaction-hub-stop
      :help "Stop the active backend run")
     (:label "Kill" :command noema-interaction-hub-kill
      :help "Kill the active backend session")))
  (insert "\n")
  (aaron-ui-board-insert-actions
   `((:label "Switch Profile" :command noema-interaction-hub-switch-profile
      :help "Choose a different profile")
     (:label "Create Profile" :command noema-interaction-hub-create-profile
      :help "Create a new profile")
     (:label "Edit Profile" :command noema-interaction-hub-edit-profile
      :help "Edit the active profile")
     (:label "Edit Snippet" :command noema-interaction-hub-edit-snippet
      :help "Edit a shared snippet")
     (:label "Edit Template" :command noema-interaction-hub-edit-template
      :help "Edit a prompt template")))
  (insert "\n")
  (aaron-ui-board-insert-actions
   `((:label "Output Log" :command noema-interaction-hub-open-output
      :help "View the output log")
     (:label "Result" :command noema-interaction-hub-open-result
      :help "View the last result")))
  (insert "\n"))

;; ── Public API ────────────────────────────────────────────────────────────────

(defun noema-interaction-hub-refresh ()
  "Refresh the noema-interaction management hub."
  (interactive)
  (let ((project-root (or (and (derived-mode-p 'noema-interaction-hub-mode)
                               (bound-and-true-p default-directory))
                          (noema-interaction-project-root)))
        (inhibit-read-only t))
    (aaron-ui-board-render
     (lambda ()
       (aaron-ui-board-insert-page-header
        "AI Workbench Hub"
        :icon 'management
        :subtitle (format "Project: %s" (abbreviate-file-name project-root))
        :stats '(("CLI Engines" . info))
        :actions '((:label "Open Backend" :command noema-interaction-hub-open-backend-buffer :primary t)
                   (:label "Cycle" :command noema-interaction-hub-cycle-backend)
                   (:label "Refresh" :command noema-interaction-hub-refresh)))
       (noema-interaction-hub--render-section-overview project-root)
       (noema-interaction-hub--render-section-cli-backends project-root)
       (noema-interaction-hub--render-section-profiles project-root)
       (noema-interaction-hub--render-section-actions project-root)
       (aaron-ui-board-insert-key-hints
        "RET set default  b cycle  B launch open  p profile  v preview  + new profile  e edit  s snippet  t template  o output  r result  x stop  k kill  g refresh  q quit")))))

(defun noema-interaction-hub ()
  "Open the noema-interaction management hub."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (buffer (get-buffer-create noema-interaction-hub-buffer-name)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-hub-mode)
        (noema-interaction-hub-mode))
      (setq default-directory project-root)
      (aaron-ui-board-set-header "AI Workbench Hub" 'management
                                 (abbreviate-file-name project-root))
      (setq-local aaron-ui-board-refresh-function #'noema-interaction-hub-refresh))
    (pop-to-buffer buffer)
    (noema-interaction-hub-refresh)))

(provide 'noema-interaction-hub)
;;; noema-interaction-hub.el ends here
