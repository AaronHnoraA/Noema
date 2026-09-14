;;; noema-agent-takeover.el --- Explicit agent-shell / PTY handoff -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; A takeover is only allowed for an idle, promoted ACP Session.  The Node and
;; Go authority choose and record the verified native resume argv before this
;; module shuts down agent-shell and starts vterm.  PTY bytes are deliberately
;; not projected as a document Run.

;;; Code:

(require 'map)
(require 'seq)
(require 'subr-x)
(require 'noema-agent-acp)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function vterm "vterm" (&optional buffer-name))
(defvar vterm-shell)
(defvar vterm-kill-buffer-on-exit)
(defvar my/noema--ready)
(defvar-local noema-agent-promote--session-id)

(defvar-local noema-agent-takeover--intervention-id nil)
(defvar-local noema-agent-takeover--intervention-version nil)
(defvar-local noema-agent-takeover--root nil)
(defvar-local noema-agent-takeover--native-session-id nil)
(defvar-local noema-agent-takeover--session-id nil)
(defvar-local noema-agent-takeover--agent-config nil)
(defvar-local noema-agent-takeover--handback-started nil)

(defun noema-agent-takeover--value (object key &optional default)
  "Read KEY from JSON-like OBJECT, returning DEFAULT when it is absent."
  (let* ((symbol (if (symbolp key) key (intern-soft key)))
         (entry (and (listp object)
                     (or (assoc key object) (and symbol (assq symbol object))))))
    (cond
     ((hash-table-p object) (gethash (if (symbolp key) (symbol-name key) key) object default))
     (entry (cdr entry))
     (t default))))

(defun noema-agent-takeover--error (error-object)
  "Return a readable message from ERROR-OBJECT."
  (format "%s" (or (noema-agent-takeover--value error-object "message") "request failed")))

(defun noema-agent-takeover--end (buffer restart reason)
  "End BUFFER's intervention and optionally RESTART agent-shell.
REASON is stored in the durable handback event."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (unless noema-agent-takeover--handback-started
        (setq noema-agent-takeover--handback-started t)
        (let ((root noema-agent-takeover--root)
              (intervention-id noema-agent-takeover--intervention-id)
              (version noema-agent-takeover--intervention-version)
              (native-id noema-agent-takeover--native-session-id)
	      (session-id noema-agent-takeover--session-id)
              (config noema-agent-takeover--agent-config))
	  (when (and restart (get-buffer-process buffer))
	    (delete-process (get-buffer-process buffer)))
          (my/noema-api-call
           "aaronnote:api:research:session:handback"
           (vector `((root . ,root) (interventionId . ,intervention-id)
                     (expectedVersion . ,version) (endedBy . "emacs") (reason . ,reason)))
           (lambda (_result error-object)
             (if error-object
                 (progn
                   (when (buffer-live-p buffer)
                     (with-current-buffer buffer (setq noema-agent-takeover--handback-started nil)))
                   (message "Noema PTY handback failed: %s" (noema-agent-takeover--error error-object)))
	       (when (buffer-live-p buffer)
		 (with-current-buffer buffer
		   (setq noema-agent-takeover--intervention-id nil)))
               (when (and restart config native-id)
                 (let* ((default-directory root)
		 (resumed
			 (noema-agent-acp-start
                          :config config :directory root :session-id native-id)))
		   (when (buffer-live-p resumed)
		     (with-current-buffer resumed
		       (setq-local noema-agent-promote--session-id session-id)))))
               (when (buffer-live-p buffer)
		 (kill-buffer buffer))
               (message "Noema Session returned to agent-shell%s"
			(if restart "" " (not reopened)"))))))))))

(defun noema-agent-takeover--on-kill ()
  "Close a durable intervention when its vterm buffer is killed."
  (when noema-agent-takeover--intervention-id
    (noema-agent-takeover--end (current-buffer) nil "PTY buffer closed")))

(defun noema-agent-takeover--abort-launch (result reason)
  "Close the intervention in RESULT after a local launch failure REASON."
  (let* ((intervention (noema-agent-takeover--value result "intervention"))
	 (id (noema-agent-takeover--value intervention "id"))
	 (version (noema-agent-takeover--value intervention "version"))
	 (root (noema-agent-takeover--value result "root")))
    (when (and id version root)
      (my/noema-api-call
       "aaronnote:api:research:session:handback"
       (vector `((root . ,root) (interventionId . ,id) (expectedVersion . ,version)
		 (endedBy . "emacs") (reason . ,reason)))
       (lambda (_result error-object)
	 (when error-object
	   (message "Noema failed to close aborted takeover: %s"
		    (noema-agent-takeover--error error-object))))))))

(defun noema-agent-takeover--launch (origin result)
  "Launch the authoritative takeover RESULT from agent-shell ORIGIN."
  (let* ((intervention (noema-agent-takeover--value result "intervention"))
         (command (append (noema-agent-takeover--value result "command") nil))
         (session (noema-agent-takeover--value result "session"))
         (id (noema-agent-takeover--value intervention "id"))
         (version (noema-agent-takeover--value intervention "version"))
         (root (noema-agent-takeover--value result "root"))
	 (session-id (noema-agent-takeover--value session "id"))
         (native-id (noema-agent-takeover--value session "nativeSessionId"))
         (config (and (buffer-live-p origin)
                      (copy-tree (noema-agent-acp-state-value origin '(:agent-config))))))
    (unless (and id version root session-id native-id config command
                 (seq-every-p (lambda (part) (and (stringp part) (not (string-empty-p part)))) command))
      (error "Noema takeover response is incomplete"))
    (unless (executable-find (car command))
      (user-error "Native TUI executable not found: %s" (car command)))
    (require 'vterm)
    (when (buffer-live-p origin)
      (noema-agent-acp-shutdown origin))
    (let* ((default-directory (file-name-as-directory root))
           (vterm-shell (mapconcat #'shell-quote-argument command " "))
           (vterm-kill-buffer-on-exit nil)
           (buffer (vterm (generate-new-buffer-name (format "*noema-takeover:%s*" id)))))
      (with-current-buffer buffer
        (setq-local noema-agent-takeover--intervention-id id
                    noema-agent-takeover--intervention-version version
                    noema-agent-takeover--root root
		    noema-agent-takeover--session-id session-id
                    noema-agent-takeover--native-session-id native-id
                    noema-agent-takeover--agent-config config
                    noema-agent-takeover--handback-started nil)
        (add-hook 'kill-buffer-hook #'noema-agent-takeover--on-kill nil t))
      (pop-to-buffer buffer)
      buffer)))

;;;###autoload
(defun noema-agent-takeover-session ()
  "Hand the current promoted, idle agent-shell Session to a native vterm TUI."
  (interactive)
  (unless (and (fboundp 'my/noema-api-call) (bound-and-true-p my/noema--ready))
    (user-error "Noema web-host is not ready"))
  (unless (and (derived-mode-p 'agent-shell-mode) noema-agent-promote--session-id)
    (user-error "Current agent-shell buffer is not attached to a Noema Session"))
  (let ((origin (current-buffer))
        (root (expand-file-name default-directory))
        (session-id noema-agent-promote--session-id))
    (my/noema-api-call
     "aaronnote:api:research:session:takeover"
     (vector `((root . ,root) (sessionId . ,session-id) (startedBy . "emacs")))
     (lambda (result error-object)
       (if error-object
           (message "Noema PTY takeover failed: %s" (noema-agent-takeover--error error-object))
         (condition-case launch-error
             (noema-agent-takeover--launch origin result)
	   (error
	    (let ((reason (format "PTY launch failed: %s" (error-message-string launch-error))))
	      (noema-agent-takeover--abort-launch result reason)
	      (message "Noema PTY takeover launch failed: %s" (error-message-string launch-error))))))))))

;;;###autoload
(defun noema-agent-handback-session ()
  "End the current Noema vterm intervention and reopen its ACP session."
  (interactive)
  (unless noema-agent-takeover--intervention-id
    (user-error "Current buffer is not an active Noema takeover"))
  (noema-agent-takeover--end (current-buffer) t "explicit handback"))

(provide 'noema-agent-takeover)
;;; noema-agent-takeover.el ends here
