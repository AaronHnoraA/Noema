;;; noema-interaction-magent.el --- Magent runtime integration -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This is the noema-interaction control plane.  The embedded Magent runtime owns
;; queueing, durable sessions, cancellation, lifecycle events, and API agent
;; execution.  Structured external CLI samplers plug into the same runtime.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'noema-interaction-backend)
(require 'noema-interaction-output)
(require 'noema-interaction-session)

(declare-function magent-runtime-ensure-initialized "magent-runtime" ())
(declare-function magent-runtime-session-current "magent-runtime-api" (&optional scope))
(declare-function magent-runtime-submit "magent-runtime-api" (runtime-session prompt &rest args))
(declare-function magent-runtime-cancel "magent-runtime-api" (runtime-session))
(declare-function magent-runtime-session-clear "magent-runtime-api" (runtime-session))
(declare-function magent-runtime-pending-count "magent-runtime-api" (&optional runtime-session))
(declare-function magent-runtime-queue-session-busy-p "magent-runtime-queue" (session))
(declare-function magent-runtime-session-magent-session "magent-runtime-api" (runtime-session))
(declare-function magent-agent-result-content-string "magent-protocol" (result))
(declare-function noema-interaction-magent-cli-sampler "noema-interaction-magent-cli"
                  (engine root runtime-session))
(declare-function magent-start "magent-agent-shell" ())

(defvar noema-interaction-magent--runtime-sessions (make-hash-table :test #'equal)
  "Magent runtime sessions keyed by canonical project roots.")

(defcustom noema-interaction-magent-max-prompt-bytes (* 2 1024 1024)
  "Maximum user/profile prompt size accepted by the Magent bridge."
  :type 'integer
  :group 'noema-interaction)

(defcustom noema-interaction-magent-max-pending-per-project 32
  "Maximum queued turns retained for one project runtime session."
  :type 'integer
  :group 'noema-interaction)

(defun noema-interaction-magent--root (root)
  "Return canonical directory form of ROOT."
  (file-name-as-directory (file-truename (expand-file-name root))))

(defun noema-interaction-magent--load ()
  "Load the embedded Magent runtime and initialize it once."
  (require 'magent)
  (require 'magent-runtime-api)
  (require 'magent-runtime-queue)
  (require 'magent-protocol)
  (magent-runtime-ensure-initialized))

(defun noema-interaction-magent-runtime-session (&optional project-root)
  "Return the Magent runtime session for PROJECT-ROOT, creating it lazily."
  (noema-interaction-magent--load)
  (let* ((root (noema-interaction-magent--root
                (or project-root (noema-interaction-project-root))))
         (cached (gethash root noema-interaction-magent--runtime-sessions)))
    (or cached
        (let ((runtime (magent-runtime-session-current root)))
          (puthash root runtime noema-interaction-magent--runtime-sessions)
          runtime))))

(defun noema-interaction-magent-session-live-p (&optional project-root)
  "Return non-nil when PROJECT-ROOT has a Magent-owned runtime session."
  (let* ((root (noema-interaction-magent--root
                (or project-root (noema-interaction-project-root))))
         (runtime (gethash root noema-interaction-magent--runtime-sessions)))
    (and runtime t)))

(defun noema-interaction-magent-busy-p (&optional project-root)
  "Return non-nil when PROJECT-ROOT is active or queued in Magent."
  (when-let* ((runtime (gethash
                        (noema-interaction-magent--root
                         (or project-root (noema-interaction-project-root)))
                        noema-interaction-magent--runtime-sessions)))
    (or (> (magent-runtime-pending-count runtime) 0)
        (magent-runtime-queue-session-busy-p
         (magent-runtime-session-magent-session runtime)))))

(defun noema-interaction-magent--observer (backend root)
  "Return a bounded UI observer for BACKEND at ROOT."
  (let ((stream-marker nil)
        (reasoning-active nil))
    (lambda (event)
      (pcase (plist-get event :type)
        ('turn-start
         (setq stream-marker
               (noema-interaction-output-stream-start
                'answer
                (format "backend: %s\nproject: %s"
                        backend (abbreviate-file-name root))
                root)))
        ('assistant-delta
         (unless stream-marker
           (setq stream-marker
                 (noema-interaction-output-stream-start 'answer nil root)))
         (setq reasoning-active nil)
         (noema-interaction-output-stream-append stream-marker
                                            (or (plist-get event :text) "")))
        ('reasoning-delta
         ;; Keep reasoning out of the transcript, but retain an inexpensive
         ;; state signal instead of appending every private reasoning token.
         (unless reasoning-active
           (setq reasoning-active t)
           (noema-interaction-session-set-last-status
            (format "%s reasoning" backend) root)))
        ('tool-call-start
         (noema-interaction-output-append
          'tool
          (format "%s: %s"
                  (or (plist-get event :name) "tool")
                  (or (plist-get event :summary) "running"))
          root))
        ((or 'turn-complete 'turn-failed 'turn-cancelled)
         (when stream-marker
           (noema-interaction-output-stream-finish stream-marker)
           (setq stream-marker nil)))))))

(cl-defun noema-interaction-magent-submit
    (backend prompt &optional project-root on-success on-error)
  "Submit PROMPT through Magent using BACKEND for PROJECT-ROOT.
API uses Magent's native gptel sampler.  CLI backends use their structured
native protocols while retaining their own tools and permissions."
  (let* ((root (noema-interaction-magent--root
                (or project-root (noema-interaction-project-root))))
         (runtime (noema-interaction-magent-runtime-session root))
         (sampler (unless (eq backend 'api)
                    (require 'noema-interaction-magent-cli)
                    (noema-interaction-magent-cli-sampler backend root runtime)))
         (observer (noema-interaction-magent--observer backend root)))
    (when (> (string-bytes prompt) noema-interaction-magent-max-prompt-bytes)
      (user-error "Prompt exceeds noema-interaction's %d-byte limit"
                  noema-interaction-magent-max-prompt-bytes))
    (when (>= (magent-runtime-pending-count runtime)
              noema-interaction-magent-max-pending-per-project)
      (user-error "Magent queue is full for %s" (abbreviate-file-name root)))
    (magent-runtime-submit
     runtime prompt
     :sampler sampler
     :observer observer
     :turn-metadata (list :noema-interaction-backend backend)
     :on-complete
     (lambda (status result)
       (pcase status
         ('completed
          (noema-interaction-session-mark-profile-bootstrap-sent backend root)
          (noema-interaction-session-mark-profile-injected backend root)
          (noema-interaction-session-set-last-status
           (format "%s turn completed" backend) root)
          (noema-interaction-output-append 'status
                                      (format "%s turn completed" backend) root)
          (when on-success (funcall on-success)))
         ('cancelled
          (noema-interaction-session-set-last-status
           (format "%s turn cancelled" backend) root))
         (_
          (let ((message (magent-agent-result-content-string result)))
            (noema-interaction-session-set-last-error message root)
            (noema-interaction-session-set-last-status
             (format "%s turn failed" backend) root)
            (noema-interaction-output-append 'error message root)
            (when on-error (funcall on-error message)))))))
    runtime))

(defun noema-interaction-magent-cancel (&optional project-root)
  "Cancel active and queued Magent work for PROJECT-ROOT."
  (interactive)
  (when-let* ((runtime (gethash
                        (noema-interaction-magent--root
                         (or project-root (noema-interaction-project-root)))
                        noema-interaction-magent--runtime-sessions)))
    (magent-runtime-cancel runtime)))

(defun noema-interaction-magent-clear (&optional project-root)
  "Cancel and clear Magent state for PROJECT-ROOT."
  (interactive)
  (let* ((root (noema-interaction-magent--root
                (or project-root (noema-interaction-project-root))))
         (runtime (gethash root noema-interaction-magent--runtime-sessions)))
    (when runtime
      (magent-runtime-session-clear runtime)
      (remhash root noema-interaction-magent--runtime-sessions))
    t))

(defun noema-interaction-magent-open (&optional backend project-root)
  "Open the Magent UI for BACKEND at PROJECT-ROOT."
  (interactive)
  (let* ((root (noema-interaction-magent--root
                (or project-root (noema-interaction-project-root))))
         (engine (or backend (noema-interaction-session-backend root))))
    (noema-interaction-magent-runtime-session root)
    (let ((default-directory root))
      (if (eq engine 'api)
          (magent-start)
        (pop-to-buffer (noema-interaction-output-buffer root))))))

(defun noema-interaction-magent--api-available-p ()
  "Return non-nil when the embedded API runtime dependencies are visible."
  (and (locate-library "magent") (locate-library "gptel")))

(noema-interaction-register-backend
 'api
 :label "API · Magent/gptel"
 :generation 'noema-interaction-magent-api-v1
 :capabilities '(:session :send :draft :stop :cancel :headless)
 :authority '(:kind magent-native :sandboxed t)
 :operations
 (list
  :available-p #'noema-interaction-magent--api-available-p
  :live-p #'noema-interaction-magent-session-live-p
  :ensure #'noema-interaction-magent-runtime-session
  :open (lambda (root) (noema-interaction-magent-open 'api root))
  :send (lambda (prompt root on-success on-error)
          (noema-interaction-magent-submit 'api prompt root on-success on-error))
  :draft (lambda (_prompt _root _on-success _on-error) t)
  :stop #'noema-interaction-magent-cancel
  :cancel #'noema-interaction-magent-cancel))

(provide 'noema-interaction-magent)
;;; noema-interaction-magent.el ends here
