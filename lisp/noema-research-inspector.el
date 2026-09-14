;;; noema-research-inspector.el --- Runtime Attention for Noema -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Attention is a projection, not another inbox database.  Opening it reads
;; pending Permissions, structured InputRequests and model-authored Proposals
;; from the Go authority. Every decision goes through the same versioned
;; channel used by agent-shell and web clients, so competing clicks have one
;; winner.

;;; Code:

(require 'button)
(require 'json)
(require 'map)
(require 'seq)
(require 'subr-x)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))

(defvar-local noema-research-attention--origin nil
  "Directory used to resolve the current Noema project.")

(defun noema-research-attention--value (object key &optional default)
  "Read KEY from JSON-like OBJECT, preserving false values and DEFAULT."
  (let* ((name (if (symbolp key) (symbol-name key) key))
         (symbol (and (stringp name) (intern-soft name)))
         (missing (make-symbol "noema-missing"))
         (value
          (cond
           ((hash-table-p object) (gethash name object missing))
           ((listp object)
            (let ((found (assoc name object)))
              (unless found (setq found (and symbol (assq symbol object))))
              (if found (cdr found) missing)))
           (t missing))))
    (if (eq value missing) default value)))

(defun noema-research-attention--list (value)
  "Return sequence VALUE as a list."
  (cond ((vectorp value) (append value nil))
        ((listp value) value)
        (t nil)))

(defun noema-research-attention--string (object key &optional default)
  "Return OBJECT's string KEY or DEFAULT."
  (let ((value (noema-research-attention--value object key default)))
    (if (stringp value) value default)))

(defun noema-research-attention--error (error-object)
  "Return readable text for ERROR-OBJECT."
  (or (noema-research-attention--string error-object "message")
      (and (stringp error-object) error-object)
      "request failed"))

(defun noema-research-attention--decide (permission option)
  "Resolve PERMISSION with offered OPTION through the shared bridge."
  (let ((permission-id (noema-research-attention--string permission "id"))
        (option-id (noema-research-attention--string option "optionId"))
        (version (noema-research-attention--value permission "version" 0))
        (origin noema-research-attention--origin)
        (buffer (current-buffer)))
    (my/noema-api-call
     "aaronnote:api:research:permission:decide"
     (vector `((cwd . ,origin) (permissionId . ,permission-id)
               (optionId . ,option-id) (expectedVersion . ,version)
               (decidedBy . "emacs-attention")))
     (lambda (_result error-object)
       (if error-object
           (message "Noema Attention decision lost/conflicted: %s"
                    (noema-research-attention--error error-object))
         (message "Noema permission %s resolved with %s" permission-id option-id))
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-research-attention-refresh)))))))

(defun noema-research-attention--insert-permission (permission)
  "Insert one pending PERMISSION and its versioned decision buttons."
  (let* ((id (noema-research-attention--string permission "id" "unknown"))
         (action (noema-research-attention--value permission "action"))
         (kind (noema-research-attention--string action "kind" "other"))
         (paths (noema-research-attention--list
                 (noema-research-attention--value action "paths")))
         (argv (noema-research-attention--list
                (noema-research-attention--value action "argv"))))
    (insert (propertize (format "%s · %s" kind id) 'face 'bold) "\n")
    (when paths (insert "  paths: " (mapconcat (lambda (value) (format "%s" value)) paths ", ") "\n"))
    (when argv (insert "  command: " (mapconcat (lambda (value) (format "%s" value)) argv " ") "\n"))
    (insert "  ")
    (dolist (option (noema-research-attention--list
                     (noema-research-attention--value permission "options")))
      (let ((label (or (noema-research-attention--string option "label")
                       (noema-research-attention--string option "optionId" "decide"))))
        (insert-text-button
         label
         'follow-link t
         'help-echo "Submit this versioned decision to Noema"
         'action (lambda (_button)
                   (noema-research-attention--decide permission option)))
        (insert "  ")))
    (insert "\n\n")))

(defun noema-research-attention--input-option-value (option)
  "Return the wire value represented by input OPTION."
  (or (noema-research-attention--string option "value")
      (noema-research-attention--string option "id")
      (noema-research-attention--string option "optionId")
      ""))

(defun noema-research-attention--read-answer (request)
  "Read one structured answer for REQUEST."
  (let ((kind (noema-research-attention--string request "inputKind" "text"))
        (options (noema-research-attention--list
                  (noema-research-attention--value request "options"))))
    (pcase kind
      ("confirm" (if (yes-or-no-p "Answer yes? ") t :false))
      ("select"
       (let* ((pairs (mapcar
                      (lambda (option)
                        (cons (or (noema-research-attention--string option "label")
                                  (noema-research-attention--input-option-value option))
                              (noema-research-attention--input-option-value option)))
                      options))
              (label (completing-read "Answer: " pairs nil t)))
         (cdr (assoc label pairs))))
      ("json"
       (json-parse-string (read-string "JSON answer: ")
                          :object-type 'hash-table :array-type 'vector
                          :null-object :null :false-object :false))
      (_ (read-string "Answer: ")))))

(defun noema-research-attention--answer (request)
  "Answer one pending structured input REQUEST through Noema."
  (let ((request-id (noema-research-attention--string request "id"))
        (run-id (noema-research-attention--string request "runId"))
        (origin noema-research-attention--origin)
        (buffer (current-buffer))
        (answer (noema-research-attention--read-answer request)))
    (my/noema-api-call
     "aaronnote:api:research:input:respond"
     (vector `((cwd . ,origin) (runId . ,run-id) (requestId . ,request-id)
               (answer . ,answer) (answeredBy . "emacs-attention")))
     (lambda (_result error-object)
       (if error-object
           (message "Noema Attention answer lost/conflicted: %s"
                    (noema-research-attention--error error-object))
         (message "Noema input %s answered" request-id))
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-research-attention-refresh)))))))

(defun noema-research-attention--insert-input (request)
  "Insert one pending structured input REQUEST and its answer button."
  (insert (propertize (noema-research-attention--string request "prompt" "Input required") 'face 'bold) "\n")
  (insert "  " (noema-research-attention--string request "runId" "unknown")
          " · " (noema-research-attention--string request "inputKind" "text") "\n  ")
  (insert-text-button
   "Answer"
   'follow-link t
   'help-echo "Send one durable answer through Noema"
   'action (lambda (_button) (noema-research-attention--answer request)))
  (insert "\n\n"))

(defun noema-research-attention--proposal-summary (proposal)
  "Return a bounded one-line payload summary for PROPOSAL."
  (let* ((payload (noema-research-attention--value
                   proposal "reviewedPayload"
                   (noema-research-attention--value proposal "payload")))
         (text (condition-case nil
                   (json-serialize payload :null-object :null :false-object :false)
                 (error "<invalid payload>"))))
    (truncate-string-to-width (replace-regexp-in-string "[\n\r]+" " " text)
                              240 nil nil "…")))

(defun noema-research-attention--review-proposal (proposal decision)
  "Submit human DECISION for versioned PROPOSAL."
  (let* ((proposal-id (noema-research-attention--string proposal "id"))
         (version (noema-research-attention--value proposal "version" 0))
         (reason (if (equal decision "reject")
                     (string-trim (read-string "Rejection reason: "))
                   ""))
         (origin noema-research-attention--origin)
         (buffer (current-buffer)))
    (when (and (equal decision "reject") (string-empty-p reason))
      (user-error "A rejection reason is required"))
    (my/noema-api-call
     "aaronnote:api:research:proposal:review"
     (vector `((cwd . ,origin) (proposalId . ,proposal-id)
               (decision . ,decision) (expectedVersion . ,version)
               (reviewedBy . "human:emacs") (reason . ,reason)))
     (lambda (_result error-object)
       (if error-object
           (message "Noema Proposal review lost/conflicted: %s"
                    (noema-research-attention--error error-object))
         (message "Noema Proposal %s %s" proposal-id
                  (if (equal decision "accept") "accepted" "rejected")))
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-research-attention-refresh)))))))

(defun noema-research-attention--insert-proposal (proposal)
  "Insert one pending or recoverable PROPOSAL with human review buttons."
  (let ((id (noema-research-attention--string proposal "id" "unknown"))
        (kind (noema-research-attention--string proposal "kind" "unknown"))
        (status (noema-research-attention--string proposal "status" "pending"))
        (proposed-by (noema-research-attention--string proposal "proposedBy" "unknown")))
    (insert (propertize (format "%s · %s" kind id) 'face 'bold) "\n")
    (insert "  " status " · " proposed-by "\n")
    (insert "  " (noema-research-attention--proposal-summary proposal) "\n  ")
    (insert-text-button
     (if (equal status "accepting") "Resume acceptance" "Accept")
     'follow-link t
     'help-echo "Materialize this Proposal through Noema's versioned review path"
     'action (lambda (_button)
               (noema-research-attention--review-proposal proposal "accept")))
    (unless (equal status "accepting")
      (insert "  ")
      (insert-text-button
       "Reject"
       'follow-link t
       'help-echo "Reject this Proposal with a recorded reason"
       'action (lambda (_button)
                 (noema-research-attention--review-proposal proposal "reject"))))
    (insert "\n\n")))

(defun noema-research-attention--render (result error-object)
  "Render Attention RESULT or ERROR-OBJECT in the current buffer."
  (let ((inhibit-read-only t))
    (erase-buffer)
    (insert (propertize "Noema Attention" 'face '(:height 1.25 :weight bold)) "\n\n")
    (if error-object
        (insert (propertize (noema-research-attention--error error-object) 'face 'error) "\n")
      (let ((permissions (noema-research-attention--list
                          (noema-research-attention--value result "permissions")))
	    (input-requests (noema-research-attention--list
			     (noema-research-attention--value result "inputRequests")))
            (input-runs (noema-research-attention--list
                         (noema-research-attention--value result "inputRuns")))
            (proposals (noema-research-attention--list
                        (noema-research-attention--value result "proposals"))))
        (insert (format "Permissions (%d)\n\n" (length permissions)))
        (dolist (permission permissions)
          (noema-research-attention--insert-permission permission))
	(insert (format "Input required (%d)\n\n" (length input-requests)))
	(dolist (request input-requests)
	  (noema-research-attention--insert-input request))
	;; Old stores projected only waiting Runs. Preserve a diagnostic row so an
	;; upgrade cannot make a genuinely blocked Run invisible.
	(when (and input-runs (null input-requests))
	  (dolist (run input-runs)
	    (insert (format "%s · session %s (request details unavailable)\n"
			    (noema-research-attention--string run "id" "unknown")
			    (noema-research-attention--string run "sessionId" "unknown")))))
	(insert (format "\nProposals (%d)\n\n" (length proposals)))
	(dolist (proposal proposals)
	  (noema-research-attention--insert-proposal proposal))
	(when (and (null permissions) (null input-runs) (null input-requests)
                   (null proposals))
          (insert "Nothing requires attention.\n"))))
    (goto-char (point-min))))

(defun noema-research-attention-refresh ()
  "Refresh the current Attention projection from Go."
  (interactive)
  (unless (fboundp 'my/noema-api-call)
    (user-error "Noema web-host integration is unavailable"))
  (let ((buffer (current-buffer))
        (origin (or noema-research-attention--origin default-directory)))
    (my/noema-api-call
     "aaronnote:api:research:attention:list"
     (vector `((cwd . ,origin)))
     (lambda (result error-object)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (noema-research-attention--render result error-object)))))))

(defvar noema-research-attention-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-research-attention-refresh)
    (define-key map (kbd "q") #'quit-window)
    map)
  "Keymap for `noema-research-attention-mode'.")

(define-derived-mode noema-research-attention-mode special-mode "Noema-Attention"
  "Review pending Noema runtime decisions."
  (setq-local truncate-lines nil))

;;;###autoload
(defun noema-research-attention (&optional origin)
  "Open the unified Attention projection for project at ORIGIN."
  (interactive)
  (let ((directory (file-name-as-directory
                    (expand-file-name (or origin default-directory))))
        (buffer (get-buffer-create "*Noema Attention*")))
    (with-current-buffer buffer
      (noema-research-attention-mode)
      (setq noema-research-attention--origin directory)
      (noema-research-attention-refresh))
    (display-buffer buffer)))

(provide 'noema-research-inspector)
;;; noema-research-inspector.el ends here
