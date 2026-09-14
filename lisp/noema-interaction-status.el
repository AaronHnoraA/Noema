;;; noema-interaction-status.el --- Status buffer for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This module provides a lightweight project-scoped status buffer.

;;; Code:

(require 'subr-x)
(require 'noema-interaction-session)
(require 'noema-interaction-profile)

(declare-function noema-interaction-open "noema-interaction" ())
(declare-function noema-interaction-kill "noema-interaction" ())
(declare-function noema-interaction-open-backend-buffer "noema-interaction" ())
(declare-function noema-interaction-switch-profile "noema-interaction" (&optional profile))
(declare-function noema-interaction-preview-profile "noema-interaction" (&optional profile))
(declare-function noema-interaction-create-profile "noema-interaction" (name &optional base-profile))
(declare-function noema-interaction-edit-shared-snippet "noema-interaction" (&optional name))
(declare-function noema-interaction-edit-template "noema-interaction" (&optional name))
(declare-function noema-interaction-cycle-backend "noema-interaction" ())
(declare-function noema-interaction-output-open "noema-interaction-output" ())
(declare-function noema-interaction-result-open "noema-interaction-result" ())
(declare-function noema-interaction-claude-session-live-p "noema-interaction-adapter-claude" (&optional project-root))
(declare-function noema-interaction-codex-session-live-p "noema-interaction-adapter-codex" (&optional project-root))

(defvar noema-interaction-status-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-interaction-status-refresh)
    (define-key map (kbd "RET") #'noema-interaction-status-open-backend)
    (define-key map (kbd "b") #'noema-interaction-status-cycle-backend)
    (define-key map (kbd "p") #'noema-interaction-status-switch-profile)
    (define-key map (kbd "v") #'noema-interaction-status-preview-profile)
    (define-key map (kbd "+") #'noema-interaction-status-create-profile)
    (define-key map (kbd "e") #'noema-interaction-status-edit-profile)
    (define-key map (kbd "s") #'noema-interaction-status-edit-shared-snippet)
    (define-key map (kbd "t") #'noema-interaction-status-edit-template)
    (define-key map (kbd "o") #'noema-interaction-status-open-output)
    (define-key map (kbd "r") #'noema-interaction-status-open-result)
    (define-key map (kbd "k") #'noema-interaction-status-kill-session)
    map)
  "Keymap for `noema-interaction-status-mode'.")

(defvar-local noema-interaction-status-project-root nil
  "Project root shown in the current status buffer.")

(define-derived-mode noema-interaction-status-mode special-mode "AI-Status"
  "Major mode for noema-interaction status buffers."
  (setq-local truncate-lines nil))

(defun noema-interaction-status-buffer-name (&optional project-root)
  "Return the status buffer name for PROJECT-ROOT."
  (format "*AI Status: %s*" (noema-interaction-project-name project-root)))

(defun noema-interaction-status--session-live-p (backend project-root)
  "Return non-nil when BACKEND has a live session for PROJECT-ROOT."
  (pcase backend
    ('claude (and (fboundp 'noema-interaction-claude-session-live-p)
                  (noema-interaction-claude-session-live-p project-root)))
    ('codex (and (fboundp 'noema-interaction-codex-session-live-p)
                 (noema-interaction-codex-session-live-p project-root)))
    (_ nil)))

(defun noema-interaction-status--format-value (label value)
  "Return a human-readable status line from LABEL and VALUE."
  (format "%-18s %s\n" label (or value "-")))

(defun noema-interaction-status--profile-catalog (active-profile)
  "Return a compact profile catalog with ACTIVE-PROFILE marked."
  (string-join
   (mapcar
    (lambda (profile)
      (format "%s %-18s %s"
              (if (string= profile active-profile) "*" " ")
              profile
              (noema-interaction-profile-summary profile)))
    (noema-interaction-profile-names))
   "\n"))

(defun noema-interaction-status--template-catalog ()
  "Return a compact template catalog."
  (string-join
   (mapcar
    (lambda (name)
      (let ((file (or (noema-interaction-profile-locate-template-file name)
                      (noema-interaction-profile-template-file name))))
        (format "  %-22s %s" name (abbreviate-file-name file))))
    (noema-interaction-profile-template-names))
   "\n"))

(defun noema-interaction-status--render (project-root)
  "Render the status view for PROJECT-ROOT."
  (let* ((backend (noema-interaction-session-backend project-root))
         (profile (noema-interaction-session-profile project-root))
         (profile-summary (noema-interaction-profile-summary profile))
         (session-live (if (noema-interaction-status--session-live-p backend project-root) "yes" "no"))
         (profile-injected (if (noema-interaction-session-profile-injected-p backend project-root) "yes" "no"))
         (last-status (noema-interaction-session-last-status project-root))
         (last-error (noema-interaction-session-last-error project-root))
         (last-prompt (noema-interaction-session-last-prompt project-root))
         (profile-file (or (noema-interaction-profile-locate-file profile)
                           (noema-interaction-profile-file profile))))
    (concat
     "AI Workbench\n\n"
     (noema-interaction-status--format-value "Project" (abbreviate-file-name project-root))
     (noema-interaction-status--format-value "Backend" (symbol-name backend))
     (noema-interaction-status--format-value "Profile" profile)
     (noema-interaction-status--format-value "Profile summary" profile-summary)
     (noema-interaction-status--format-value "Profile file" (abbreviate-file-name profile-file))
     (noema-interaction-status--format-value "Initialized" (if (noema-interaction-session-initialized-p project-root) "yes" "no"))
     (noema-interaction-status--format-value "Session live" session-live)
     (noema-interaction-status--format-value "Profile injected" profile-injected)
     (noema-interaction-status--format-value "Run state" (format "%s" (noema-interaction-session-run-state project-root)))
     (noema-interaction-status--format-value "Last status" last-status)
     (noema-interaction-status--format-value "Last error" last-error)
     "\nLast prompt preview\n"
     (make-string 72 ?-)
     "\n"
     (if (string-empty-p (or last-prompt ""))
         "(empty)\n"
       (format "%s\n" (truncate-string-to-width last-prompt 200 nil nil t)))
     "\nWriting profiles\n"
     (make-string 72 ?-)
     "\n"
     (noema-interaction-status--profile-catalog profile)
     "\n\nPrompt templates\n"
     (make-string 72 ?-)
     "\n"
     (noema-interaction-status--template-catalog)
     "\nKeys\n"
     (make-string 72 ?-)
     "\n"
     "RET open backend  b switch backend  p switch profile  v preview profile\n"
     "+ create profile  e edit profile  s edit snippet  t edit template\n"
     "o output log  r result  k kill session  g refresh\n"
     "Writing: use C-c A w from an Org/Markdown/text buffer\n")))

(defun noema-interaction-status-buffer (&optional project-root)
  "Return the status buffer for PROJECT-ROOT."
  (let* ((root (or project-root (noema-interaction-project-root)))
         (buffer (get-buffer-create (noema-interaction-status-buffer-name root))))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-interaction-status-mode)
        (noema-interaction-status-mode))
      (setq default-directory root)
      (setq-local noema-interaction-status-project-root root))
    buffer))

(defun noema-interaction-status-open ()
  "Open the noema-interaction status buffer for the current project."
  (interactive)
  (let ((buffer (noema-interaction-status-buffer)))
    (pop-to-buffer buffer)
    (with-current-buffer buffer
      (noema-interaction-status-refresh))))

(defun noema-interaction-status-refresh ()
  "Refresh the current noema-interaction status buffer."
  (interactive)
  (let ((project-root (or noema-interaction-status-project-root
                          (noema-interaction-project-root))))
    (setq noema-interaction-status-project-root project-root)
    (let ((inhibit-read-only t))
      (erase-buffer)
      (insert (noema-interaction-status--render project-root))
      (goto-char (point-min)))))

(defun noema-interaction-status-open-backend ()
  "Open the backend buffer tracked by the current status buffer."
  (interactive)
  (let ((default-directory (or noema-interaction-status-project-root default-directory)))
    (noema-interaction-open)
    (noema-interaction-open-backend-buffer)
    (noema-interaction-status-refresh)))

(defun noema-interaction-status-cycle-backend ()
  "Cycle backend from the current status buffer."
  (interactive)
  (let ((default-directory (or noema-interaction-status-project-root default-directory)))
    (noema-interaction-cycle-backend)
    (noema-interaction-status-refresh)))

(defun noema-interaction-status-switch-profile ()
  "Switch profile from the current status buffer."
  (interactive)
  (let ((default-directory (or noema-interaction-status-project-root default-directory)))
    (call-interactively #'noema-interaction-switch-profile)
    (noema-interaction-status-refresh)))

(defun noema-interaction-status-edit-profile ()
  "Edit the active profile from the current status buffer."
  (interactive)
  (let* ((project-root (or noema-interaction-status-project-root
                           (noema-interaction-project-root)))
         (profile (noema-interaction-session-profile project-root)))
    (noema-interaction-profile-open profile)
    (noema-interaction-status-refresh)))

(defun noema-interaction-status-preview-profile ()
  "Preview the active profile from the current status buffer."
  (interactive)
  (let* ((project-root (or noema-interaction-status-project-root
                           (noema-interaction-project-root)))
         (profile (noema-interaction-session-profile project-root)))
    (noema-interaction-preview-profile profile)))

(defun noema-interaction-status-create-profile ()
  "Create a new profile from the current status buffer."
  (interactive)
  (call-interactively #'noema-interaction-create-profile)
  (noema-interaction-status-refresh))

(defun noema-interaction-status-edit-shared-snippet ()
  "Edit a shared snippet from the current status buffer."
  (interactive)
  (call-interactively #'noema-interaction-edit-shared-snippet)
  (noema-interaction-status-refresh))

(defun noema-interaction-status-edit-template ()
  "Edit a prompt template from the current status buffer."
  (interactive)
  (call-interactively #'noema-interaction-edit-template)
  (noema-interaction-status-refresh))

(defun noema-interaction-status-open-output ()
  "Open output buffer from the current status buffer."
  (interactive)
  (let ((default-directory (or noema-interaction-status-project-root default-directory)))
    (noema-interaction-output-open)))

(defun noema-interaction-status-open-result ()
  "Open result buffer from the current status buffer."
  (interactive)
  (let ((default-directory (or noema-interaction-status-project-root default-directory)))
    (noema-interaction-result-open)))

(defun noema-interaction-status-kill-session ()
  "Kill the active session from the current status buffer."
  (interactive)
  (let ((default-directory (or noema-interaction-status-project-root default-directory)))
    (noema-interaction-kill)
    (noema-interaction-status-refresh)))

(provide 'noema-interaction-status)
;;; noema-interaction-status.el ends here
