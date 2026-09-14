;;; noema-pi-router.el --- Deterministic per-directory Pi buffer routing -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; D-008 fixed Pi's position: in v1 it is `pi-acp', an ordinary ACP agent
;; with no special permissions, and any privileged "orchestrator" role stays
;; deferred to Phase F.  This file does not revisit that.  It solves a
;; narrower, purely mechanical problem the audit found genuinely missing:
;; nothing remembers which agent-shell buffer (or resumable native ACP
;; session) belongs to which directory, so invoking Pi again in the same
;; place always opens another buffer instead of reusing the one already
;; there, and once Emacs restarts even the same-session illusion is lost.
;;
;; `noema-pi-router' is that missing piece and nothing more: a deterministic
;; lookup table from directory to Pi buffer/session, kept in memory for the
;; life of the Emacs session and mirrored to `<root>/.agent/pi.json' so a
;; restart can still resume the same native ACP session.  It never inspects
;; agent output, never decides anything about permissions or routing
;; semantics, and is not itself an agent identity -- `pi-acp' keeps that.
;; The buffer switcher here also covers any other live Noema agent-shell
;; buffer, since "which buffer did I open earlier" is not Pi-specific.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'noema-research)
(require 'noema-agent-acp)

(defvar noema-pi-router--buffers (make-hash-table :test #'equal)
  "Directory root to live Pi agent-shell buffer, for this Emacs session only.")

(defun noema-pi-router--root (directory)
  "Return the normalized directory root that owns Pi state for DIRECTORY.
Like `noema-research-repository-root', the nearest `noema.toml' wins;
otherwise DIRECTORY itself is the root."
  (let* ((directory (file-name-as-directory (expand-file-name directory)))
         (root (locate-dominating-file directory "noema.toml")))
    (file-name-as-directory (expand-file-name (or root directory)))))

(defun noema-pi-router--state-directory (root)
  "Return ROOT's `.agent/' directory, creating it if necessary."
  (let ((directory (expand-file-name noema-research-state-directory root)))
    (make-directory directory t)
    directory))

(defun noema-pi-router--registry-file (root)
  "Return the path of ROOT's persisted Pi directory registry."
  (expand-file-name "pi.json" (noema-pi-router--state-directory root)))

(defun noema-pi-router--read-registry (root)
  "Return ROOT's persisted Pi registry as a hash table."
  (let ((path (noema-pi-router--registry-file root)))
    (or (and (file-readable-p path)
             (ignore-errors
               (with-temp-buffer
                 (insert-file-contents path)
                 (noema-research-parse-json (buffer-string)))))
        (noema-research--table))))

(defun noema-pi-router--write-registry (root registry)
  "Persist REGISTRY as ROOT's Pi directory registry."
  (let ((coding-system-for-write 'utf-8-unix))
    (write-region (noema-research-serialize registry) nil
                  (noema-pi-router--registry-file root) nil 'silent)))

(defun noema-pi-router--native-session-id (root)
  "Return ROOT's last-known native ACP session id for Pi, or nil."
  (noema-research--string (noema-research--get (noema-pi-router--read-registry root)
                                                "nativeSessionId")))

(defun noema-pi-router--remember-session (root buffer)
  "Persist BUFFER's native ACP session id as ROOT's Pi session, if known."
  (when-let* (((buffer-live-p buffer))
              (native (noema-agent-acp-state-value buffer '(:session :id))))
    (noema-pi-router--write-registry
     root (noema-research--table "nativeSessionId" (format "%s" native)
                                 "updatedAt" (format-time-string "%FT%TZ" nil t)))))

;;;###autoload
(defun noema-pi-router-buffer (&optional directory)
  "Return the live Pi agent-shell buffer bound to DIRECTORY, or nil.
Only ever returns a buffer this session has already started; it never
starts one -- use `noema-pi-router-open' for that."
  (let ((buffer (gethash (noema-pi-router--root (or directory default-directory))
                         noema-pi-router--buffers)))
    (and (buffer-live-p buffer) buffer)))

;;;###autoload
(defun noema-pi-router-open (&optional directory)
  "Open or resume the one Pi agent bound to DIRECTORY (default: here).
A live buffer for this directory is reused as-is.  Otherwise, if a native
ACP session was remembered for this directory from an earlier Emacs
session, Pi resumes it; if the agent does not support resuming, or none
was remembered, Pi starts a fresh session.  Either way the resulting
buffer is bound to this directory going forward and kept out of
tab-line/tab-bar."
  (interactive (list default-directory))
  (let* ((root (noema-pi-router--root (or directory default-directory)))
         (cached (noema-pi-router-buffer root)))
    (if cached
        (pop-to-buffer cached)
      (let* ((config (noema-agent-acp-resolve-config 'pi))
             (native (noema-pi-router--native-session-id root))
             (buffer (noema-agent-acp-start
                      :config config :directory root
                      :session-id (and native (not (string-empty-p native)) native))))
        (with-current-buffer buffer
          (setq-local tab-line-exclude t))
        (puthash root buffer noema-pi-router--buffers)
        (noema-agent-acp-subscribe
         :buffer buffer :event 'init-session
         :callback (lambda (_event) (noema-pi-router--remember-session root buffer)))
        (pop-to-buffer buffer)))))

;;;###autoload
(defun noema-pi-router-switch ()
  "Switch to a live Noema agent-shell buffer, choosing by name.
This is the plain switcher the audited workflow lacked: every agent-shell
buffer this Emacs session actually has open, so one opened earlier -- Pi or
otherwise -- is never simply lost among ordinary buffers."
  (interactive)
  (let* ((live (seq-filter #'noema-agent-acp-agent-buffer-p (buffer-list)))
         (choices (mapcar (lambda (buffer) (cons (buffer-name buffer) buffer)) live)))
    (unless choices (user-error "No live Noema agent buffers"))
    (pop-to-buffer
     (cdr (assoc (completing-read "Noema agent buffer: " choices nil t) choices)))))

(provide 'noema-pi-router)
;;; noema-pi-router.el ends here
