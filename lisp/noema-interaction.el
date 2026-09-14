;;; noema-interaction.el --- Unified AI workbench entry -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Unified entry points for AI coding sessions.  The embedded Magent runtime
;; owns queueing, durable sessions, lifecycle, and audit state.  API requests
;; use Magent/gptel; CLI requests retain each coding agent's native tools and
;; permissions behind a structured Magent sampler.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'noema-upstream)
(require 'noema-interaction-backend)
(require 'noema-interaction-session)
(require 'noema-interaction-answer)
(require 'noema-interaction-output)
(require 'noema-interaction-result)
(require 'noema-interaction-profile)
(require 'noema-interaction-status)
(require 'noema-interaction-adapter-claude)
(require 'noema-interaction-adapter-codex)
(require 'noema-interaction-adapter-opencode)
(require 'noema-interaction-tools)
(require 'noema-interaction-magent)

(declare-function noema-interaction-status-open           "noema-interaction-status" ())

(defgroup noema-interaction nil
  "Unified AI workbench."
  :group 'tools
  :prefix "noema-interaction-")

(defcustom noema-interaction-save-before-dispatch t
  "When non-nil, save relevant file buffers before dispatching AI prompts."
  :type 'boolean
  :group 'noema-interaction)

;; ── Backend selection ─────────────────────────────────────────────────────────
;; `noema-interaction' is the interactive vterm agent launcher.  Its picker offers
;; the three CLI engines (CC, Codex, OpenCode); selecting one opens that tool's
;; interactive vterm session.

(defun noema-interaction--available-backends ()
  "Return available Magent API and CLI engine identifiers."
  (cl-remove-if-not
   (lambda (id)
     (ignore-errors (noema-interaction-backend-call id :available-p)))
   (noema-interaction-backend-ids :session)))

(defun noema-interaction--select-backend (_project-root)
  "Prompt for an available Magent API or CLI engine and return its symbol."
  (let* ((ids (noema-interaction--available-backends))
         (candidates (mapcar (lambda (id)
                               (cons (noema-interaction-backend-label id) id))
                             ids))
         (current-backend (noema-interaction-session-backend))
         (default (car (rassq current-backend candidates))))
    (unless candidates
      (user-error "No available noema-interaction backends"))
    (let ((chosen (completing-read "AI engine: " (mapcar #'car candidates)
                                   nil t nil nil default)))
      (cdr (assoc chosen candidates)))))

(defun noema-interaction--ensure-initialized (project-root)
  "Ensure PROJECT-ROOT has an initialized noema-interaction session."
  (unless (noema-interaction-session-initialized-p project-root)
    (noema-interaction-session-set-backend
     (noema-interaction--select-backend project-root)
     project-root)
    (noema-interaction-session-set-profile "default" project-root)
    (noema-interaction-session-set-initialized t project-root)))

;; ── Backend liveness ──────────────────────────────────────────────────────────

(defun noema-interaction--backend-session-live-p (project-root)
  "Return non-nil when the selected backend session is live for PROJECT-ROOT."
  (or (noema-interaction-magent-session-live-p project-root)
      (noema-interaction-backend-live-p (noema-interaction-session-backend project-root)
                                   project-root)))

(defun noema-interaction--reset-selection (project-root)
  "Reset backend selection state for PROJECT-ROOT."
  (noema-interaction-session-set-initialized nil project-root)
  (noema-interaction-session-reset-profile-injected project-root)
  (noema-interaction-session-set-last-status "Backend selection reset" project-root))

;; ── Backend preparation ───────────────────────────────────────────────────────

(defun noema-interaction--prepare-backend (project-root)
  "Prepare the current backend for PROJECT-ROOT."
  (let ((backend (noema-interaction-session-backend project-root)))
    (noema-interaction-magent-runtime-session project-root)
    (noema-interaction-session-set-last-status
     (format "%s Magent session ready" (noema-interaction-backend-label backend))
     project-root)))

;; ── Context helpers ───────────────────────────────────────────────────────────

(defun noema-interaction--context-relative-path (file project-root)
  "Return FILE relative to PROJECT-ROOT when possible."
  (if (and file project-root (file-in-directory-p file project-root))
      (file-relative-name file project-root)
    (abbreviate-file-name file)))

(defun noema-interaction--context-block (label body &optional metadata)
  "Return a labeled context block with LABEL, BODY, and optional METADATA."
  (concat (format "### %s\n" label)
          (if (and metadata (not (string-empty-p metadata)))
              (concat metadata "\n")
            "")
          body
          "\n"))

(defun noema-interaction--position-line-column (position)
  "Return POSITION as a (line . column) cons cell."
  (save-excursion
    (goto-char position)
    (cons (line-number-at-pos) (current-column))))

(defun noema-interaction--range-reference (file start end project-root &optional label)
  "Return a reference to FILE from START to END under PROJECT-ROOT."
  (let ((relative-file (noema-interaction--context-relative-path file project-root))
        (start-lc (noema-interaction--position-line-column start))
        (end-lc   (noema-interaction--position-line-column end)))
    (string-join
     (delq nil
           (list
            (format "@range %s:%d:%d-%d:%d"
                    relative-file
                    (car start-lc) (cdr start-lc)
                    (car end-lc)   (cdr end-lc))
            label))
     " ")))

;; ── Save helpers ──────────────────────────────────────────────────────────────

(defun noema-interaction--save-buffer-if-needed (buffer)
  "Save BUFFER when it is a modified local file-visiting buffer."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (and noema-interaction-save-before-dispatch
                 buffer-file-name
                 (buffer-modified-p)
                 (not buffer-read-only)
                 (not (file-remote-p buffer-file-name)))
        (save-buffer)))))

(defun noema-interaction--save-current-file-buffer ()
  "Save the current buffer before switching to an AI backend."
  (noema-interaction--save-buffer-if-needed (current-buffer)))

(defun noema-interaction--save-file-buffer-if-open (file)
  "Save FILE's live buffer when it has unsaved edits."
  (when-let* ((buffer (find-buffer-visiting file)))
    (noema-interaction--save-buffer-if-needed buffer)))

;; ── Public: open / cycle / switch ────────────────────────────────────────────

(defun noema-interaction-open ()
  "Select a backend, prepare its Magent runtime, and open its conversation UI."
  (interactive)
  (let ((project-root (noema-interaction-project-root)))
    (noema-interaction--ensure-initialized project-root)
    (noema-interaction--prepare-backend project-root)
    (noema-interaction-open-backend-buffer)))

(defalias 'noema-interaction #'noema-interaction-open)

(defun noema-interaction-cycle-backend ()
  "Cycle the current project vterm engine."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (ids (noema-interaction--available-backends))
         (current (noema-interaction-session-backend project-root))
         (tail (cdr (memq current ids)))
         (next (or (car tail) (car ids))))
    (unless next
      (user-error "No noema-interaction backends are registered"))
    (noema-interaction-session-set-backend next project-root)
    (noema-interaction-session-reset-profile-injected project-root)
    (message "noema-interaction backend: %s" next)
    (noema-interaction-open)))

(defun noema-interaction-switch-profile (&optional profile)
  "Switch the active project profile to PROFILE."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (current (noema-interaction-session-profile project-root))
         (selected (or profile
                       (noema-interaction-profile-read-name-with-summary
                        "AI profile: "
                        current))))
    (noema-interaction-session-set-profile selected project-root)
    (noema-interaction-session-reset-profile-injected project-root)
    (noema-interaction-session-set-last-status
     (format "Profile switched to %s" selected)
     project-root)
    (noema-interaction-output-append
     'status
     (format "Profile switched to %s" selected)
     project-root)
    (message "noema-interaction profile: %s" selected)))

(defun noema-interaction-edit-profile (&optional profile)
  "Open PROFILE for editing."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (selected (or profile
                       (noema-interaction-session-profile project-root)
                       noema-interaction-profile-default-name)))
    (noema-interaction-profile-open selected)))

(defun noema-interaction-preview-profile (&optional profile)
  "Preview PROFILE in a read-only buffer."
  (interactive)
  (noema-interaction-profile-preview
   (or profile
       (noema-interaction-session-profile (noema-interaction-project-root))
       noema-interaction-profile-default-name)))

(defun noema-interaction-create-profile (name &optional base-profile)
  "Create NAME using BASE-PROFILE as a starting point."
  (interactive
   (list (read-string "New profile name: ")
         (noema-interaction-profile-read-name-with-summary
          "Base profile: "
          (noema-interaction-session-profile (noema-interaction-project-root)))))
  (noema-interaction-profile-create name base-profile))

(defun noema-interaction-edit-shared-snippet (&optional name)
  "Edit shared snippet NAME used by all profiles."
  (interactive)
  (noema-interaction-profile-edit-snippet
   (or name
       (completing-read "Shared snippet: "
                        (noema-interaction-profile-snippet-names)
                        nil t nil nil "git-policy"))))

(defun noema-interaction-edit-template (&optional name)
  "Edit prompt template NAME."
  (interactive)
  (noema-interaction-profile-edit-template
   (or name
       (completing-read "Prompt template: "
                        (noema-interaction-profile-template-names)
                        nil t nil nil "context-prompt"))))

(defun noema-interaction-status ()
  "Open the current project's noema-interaction status buffer."
  (interactive)
  (noema-interaction-status-open))

;; ── Public: buffer display ────────────────────────────────────────────────────

(defun noema-interaction-open-backend-buffer ()
  "Open the current backend's Magent-owned conversation buffer."
  (interactive)
  (let ((project-root (noema-interaction-project-root)))
    (noema-interaction-magent-open
     (noema-interaction-session-backend project-root) project-root)))

(defun noema-interaction-open-direct-terminal ()
  "Open the selected CLI's legacy direct terminal session.
This explicit escape hatch bypasses Magent orchestration for interactive use."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root)))
    (when (eq backend 'api)
      (user-error "The API backend has no direct terminal"))
    (noema-interaction-backend-call backend :ensure project-root)
    (noema-interaction-backend-call backend :open project-root)))

(defun noema-interaction-toggle-codex-mode ()
  "Toggle the interactive Codex execution mode (kept for compatibility)."
  (interactive)
  (noema-interaction-codex-toggle-execution-mode)
  (noema-interaction-session-reset-profile-injected (noema-interaction-project-root))
  (message "noema-interaction Codex mode: %s" (noema-interaction-codex-execution-mode)))

;; ── Public: stop / kill ───────────────────────────────────────────────────────

(defun noema-interaction-stop ()
  "Stop active and queued Magent work for the current project."
  (interactive)
  (noema-interaction-magent-cancel (noema-interaction-project-root)))

(defun noema-interaction-cancel ()
  "Cancel the current AI operation in the active backend session."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root)))
    (noema-interaction-magent-cancel project-root)
    (noema-interaction-session-set-last-status (format "Canceled %s operation" backend) project-root)
    (message "noema-interaction canceled %s operation" backend)))

(defun noema-interaction-kill ()
  "Kill the current backend session and reset backend selection."
  (interactive)
  (let ((project-root (noema-interaction-project-root)))
    (noema-interaction-magent-clear project-root)
    (noema-interaction--reset-selection project-root)
    (message "noema-interaction killed current backend session")))

;; ── Compose buffer ────────────────────────────────────────────────────────────

(defvar-keymap noema-interaction-compose-mode-map
  :doc "Keymap for `noema-interaction-compose-mode'."
  "C-c C-c" #'noema-interaction-compose-submit
  "C-c C-k" #'noema-interaction-compose-cancel)

(define-derived-mode noema-interaction-compose-mode text-mode "AI-Compose"
  "Major mode for editing an AI prompt before sending to the backend session.
Type your message, then press \\[noema-interaction-compose-submit] to send."
  (setq-local header-line-format
              "  C-c C-c send · C-c C-k cancel"))

(defvar-local noema-interaction-compose-backend nil
  "Backend symbol for the current compose buffer.")
(defvar-local noema-interaction-compose-root nil
  "Project root for the current compose buffer.")

(defun noema-interaction-compose-submit ()
  "Submit the compose buffer content to the AI backend session."
  (interactive)
  (let* ((buf (current-buffer))
         (backend noema-interaction-compose-backend)
         (root noema-interaction-compose-root)
         (content (string-trim (buffer-substring-no-properties (point-min) (point-max)))))
    (unless (and backend root)
      (user-error "Not an noema-interaction compose buffer"))
    (unless content
      (user-error "Nothing to send"))
    (unless (noema-interaction-magent-session-live-p root)
      (user-error "Session went away. Reopen with `noema-interaction-open' (C-c A W)"))
    (kill-buffer buf)
    (noema-interaction-send-string backend content root)))

(defun noema-interaction-compose-cancel ()
  "Cancel the compose buffer."
  (interactive)
  (when (y-or-n-p "Discard this draft?")
    (kill-buffer (current-buffer))))

;; ── Public: send / draft ──────────────────────────────────────────────────────

(defun noema-interaction-send-string (backend prompt &optional project-root)
  "Send PROMPT for PROJECT-ROOT through BACKEND."
  (noema-interaction--save-current-file-buffer)
  (let* ((root (or project-root (noema-interaction-project-root)))
         (effective-prompt
          (if (noema-interaction-session-profile-injected-p backend root)
              prompt
            (noema-interaction-profile-wrap-user-prompt prompt root))))
    (noema-interaction-session-set-last-prompt prompt root)
    (noema-interaction-session-set-last-error nil root)
    (noema-interaction-session-set-last-status (format "Sending prompt to %s" backend) root)
    (noema-interaction-output-append
     'prompt
     (format "backend: %s\nproject: %s\n\n%s"
             backend
             (abbreviate-file-name root)
             effective-prompt)
     root)
    (let ((default-directory root))
      (noema-interaction-magent-submit
       backend effective-prompt root
       (lambda ()
         (noema-interaction-session-set-last-status
          (format "Completed prompt with %s" backend) root)
         (message "noema-interaction completed prompt with %s" backend))
       (lambda (message)
         (noema-interaction-session-set-last-error message root)
         (noema-interaction-session-set-last-status
          (format "Failed sending prompt to %s" backend) root))))))

(defun noema-interaction--draft-string-now (backend prompt project-root)
  "Insert PROMPT into BACKEND for PROJECT-ROOT without submitting."
  (noema-interaction-backend-call backend :draft prompt project-root nil nil))

(defun noema-interaction--effective-prompt (backend prompt project-root)
  "Return PROMPT or a profile-wrapped version for BACKEND and PROJECT-ROOT."
  (if (noema-interaction-session-profile-injected-p backend project-root)
      prompt
    (noema-interaction-profile-wrap-user-prompt prompt project-root)))

(defun noema-interaction-draft-string (backend prompt &optional project-root)
  "Open a compose buffer with PROMPT for editing before sending to BACKEND.
The Magent session is created lazily when needed."
  (noema-interaction--save-current-file-buffer)
  (let* ((root (or project-root (noema-interaction-project-root))))
    (noema-interaction-magent-runtime-session root)
    (unless (noema-interaction-session-profile-injected-p backend root)
      (noema-interaction--prepare-backend root))
    (noema-interaction-session-set-last-prompt prompt root)
    (noema-interaction-session-set-last-error nil root)
    (noema-interaction-output-append
     'prompt
     (format "draft backend: %s\nproject: %s\n\n%s"
             backend
             (abbreviate-file-name root)
             prompt)
     root)
    (let ((buf (get-buffer-create "*noema-interaction-compose*")))
      (with-current-buffer buf
        (erase-buffer)
        (insert prompt)
        (goto-char (point-max))
        (noema-interaction-compose-mode)
        (setq-local noema-interaction-compose-backend backend)
        (setq-local noema-interaction-compose-root root))
      (display-buffer buf)
      (pop-to-buffer (noema-interaction-output-buffer root))
      (message "Compose: edit then press C-c C-c to send to %s" backend))))

(defun noema-interaction-resend-last-prompt ()
  "Resend the last prompt for the current project."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root))
         (prompt (noema-interaction-session-last-prompt project-root)))
    (unless prompt
      (user-error "No previous prompt for this project"))
    (unless (noema-interaction--backend-session-live-p project-root)
      (user-error "No active session. Start one first with `noema-interaction-open'"))
    (noema-interaction-send-string backend prompt project-root)))

(defun noema-interaction-clear-session ()
  "Clear transient runtime state for the current project."
  (interactive)
  (let ((project-root (noema-interaction-project-root)))
    (noema-interaction-magent-clear project-root)
    (noema-interaction-session-clear-runtime project-root)
    (noema-interaction-output-append 'status "Cleared runtime session state" project-root)
    (message "noema-interaction cleared runtime state")))

;; ── Public: context senders ───────────────────────────────────────────────────

(defun noema-interaction-send-region (start end)
  "Send a reference to the active region to the current backend as a draft."
  (interactive "r")
  (unless (use-region-p)
    (user-error "No active region"))
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root))
         (source-file (or (buffer-file-name)
                          (user-error "Current buffer is not visiting a file")))
         (prompt (noema-interaction--context-block
                  "Reference: region"
                  (noema-interaction--range-reference
                   source-file start end project-root "selection"))))
    (noema-interaction-draft-string backend prompt project-root)))

(defun noema-interaction-send-current-buffer ()
  "Send a reference to the current buffer to the current backend as a draft."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root))
         (source-file (or (buffer-file-name)
                          (user-error "Current buffer is not visiting a file")))
         (prompt (noema-interaction--context-block
                  "Reference: current buffer"
                  (format "@file %s"
                          (noema-interaction--context-relative-path
                           source-file project-root)))))
    (noema-interaction-draft-string backend prompt project-root)))

(defun noema-interaction-send-file (file)
  "Send a reference to FILE to the current backend as a draft."
  (interactive
   (list (read-file-name "Send file: " (noema-interaction-project-root) nil t)))
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root))
         (expanded (expand-file-name file))
         (prompt (noema-interaction--context-block
                  "Reference: file"
                  (format "@file %s"
                          (noema-interaction--context-relative-path
                           expanded project-root)))))
    (noema-interaction--save-file-buffer-if-open expanded)
    (noema-interaction-draft-string backend prompt project-root)))

(provide 'noema-interaction)
;;; noema-interaction.el ends here
