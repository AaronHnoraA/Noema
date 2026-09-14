;;; noema-agent-worker.el --- ACP document-execution worker for Noema -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This is deliberately not another agent loop.  agent-shell/acp.el own the
;; physical process and its native UI; this file only binds that process to a
;; CAS-backed Noema Run through a short-lived lease.  A killed Emacs therefore
;; leaves an interrupted Run rather than a plausible-but-false completion.

;;; Code:

(require 'cl-lib)
(require 'map)
(require 'seq)
(require 'subr-x)
(require 'noema-agent-acp)
(require 'magent-ledger)
(require 'magent-runtime-queue)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function my/noema--host-file "init-aaronnote" (file))
(declare-function my/noema-jupyter-output-open-document
                  "init-aaronnote" (payload &optional focus))
(declare-function noema-agent-promote--session-spec "noema-agent-promote" (&optional buffer title goal))

(defgroup noema-agent-worker nil
  "Noema document execution through ACP and agent-shell."
  :group 'applications)

(defcustom noema-agent-worker-lease-renew-seconds 10
  "Seconds between lease heartbeats.  The kernel grants at most 60 seconds."
  :type 'integer
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-segment-delay 0.15
  "Seconds to coalesce streamed agent content before writing an event."
  :type 'number
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-cancel-grace-seconds 3
  "Seconds to wait for ACP `session/cancel' before shutting down its client."
  :type 'number
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-result-max-bytes (* 256 1024)
  "Maximum assistant text copied into a work block's persisted outputs."
  :type 'integer
  :group 'noema-agent-worker)

(defvar noema-agent-worker--attention-count 0
  "Number of permission/input requests currently awaiting a user decision.")

(defconst noema-agent-worker--mode-line-entry
  '(:eval (noema-agent-worker--attention-lighter))
  "The `global-mode-string' entry for pending Noema attention items.")

(defun noema-agent-worker--attention-lighter ()
  "Return the mode-line fragment for pending Noema attention items."
  (when (> noema-agent-worker--attention-count 0)
    (format " Noema[%d]" noema-agent-worker--attention-count)))

(unless (member noema-agent-worker--mode-line-entry global-mode-string)
  (setq global-mode-string
        (append (or global-mode-string '(""))
                (list noema-agent-worker--mode-line-entry))))

(defun noema-agent-worker--attention-note (delta)
  "Adjust the pending-attention count by DELTA and update its indicator.
A single `message' fires only on the 0->positive transition, so a burst of
simultaneous requests does not spam the echo area; the running count lives
in the mode line until Attention (`C-c C-a') or a resolved decision brings
it back to zero."
  (let ((previous noema-agent-worker--attention-count))
    (setq noema-agent-worker--attention-count
          (max 0 (+ noema-agent-worker--attention-count delta)))
    (when (and (zerop previous) (> noema-agent-worker--attention-count 0))
      (message "Noema: agent awaiting a decision (C-c C-a for Attention)"))
    (force-mode-line-update t)))

(cl-defstruct (noema-agent-worker
               (:constructor noema-agent-worker--create))
  run-id session-id root target agent spec context-items routing buffer epoch
  renew-timer segment-timer cancel-timer segments result-parts pending-permissions pending-inputs started terminal
  l1-mode preflight-failure ledger ledger-turn-id ledger-message-item action-items
  submission-id prepare-body queue-state bootstrap-failing cleanup-timer)

(defvar noema-agent-worker--runs (make-hash-table :test #'equal)
  "Run id to `noema-agent-worker' mapping.")

(defvar noema-agent-worker--permissions (make-hash-table :test #'equal)
  "Permission id to (WORKER . ACP-RESPONDER) mapping.")

(defvar noema-agent-worker--inputs (make-hash-table :test #'equal)
  "Durable input request id to (WORKER . NATIVE-RESPONDER) mapping.")

(defvar noema-agent-worker--ledgers (make-hash-table :test #'equal)
  "Logical Session id to ephemeral Magent ledger projection.")

(defvar noema-agent-worker--submissions (make-hash-table :test #'equal)
  "Local submission id to queued or active Noema worker token.")

(defun noema-agent-worker--finish-queue (worker state)
  "Release WORKER's Magent arbiter ticket with terminal local STATE."
  (when (noema-agent-worker-submission-id worker)
    (setf (noema-agent-worker-queue-state worker) state)
    (remhash (noema-agent-worker-submission-id worker) noema-agent-worker--submissions)
    (magent-runtime-queue-arbiter-finish 'noema worker)))

(defun noema-agent-worker--finish-bootstrap-failure (worker reason)
  "Finish WORKER locally after the kernel accepted bootstrap failure REASON."
  (setf (noema-agent-worker-bootstrap-failing worker) nil
        (noema-agent-worker-terminal worker) t)
  (noema-agent-worker--stop-renewal worker)
  (remhash (noema-agent-worker-run-id worker) noema-agent-worker--runs)
  (noema-agent-worker--ledger-terminal worker "failed" reason)
  (noema-agent-worker--finish-queue worker 'failed))

(defun noema-agent-worker--retry-bootstrap-failure (worker reason)
  "Retry authoritative pre-dispatch cleanup for WORKER and REASON."
  (unless (or (noema-agent-worker-terminal worker)
              (timerp (noema-agent-worker-cleanup-timer worker)))
    (setf (noema-agent-worker-cleanup-timer worker)
          (run-at-time
           2 nil
           (lambda ()
             (setf (noema-agent-worker-cleanup-timer worker) nil
                   (noema-agent-worker-bootstrap-failing worker) nil)
             (noema-agent-worker--fail-prepared worker reason))))))

(defun noema-agent-worker--reconcile-bootstrap-failure (worker reason)
  "Resolve an ambiguous cleanup response for WORKER without replaying it."
  (noema-agent-worker--api
   "aaronnote:api:research:run:get"
   `((root . ,(noema-agent-worker-root worker))
     (runId . ,(noema-agent-worker-run-id worker)))
   (lambda (result error-object)
     (let* ((run (or (noema-agent-worker--value result "run") result))
            (status (and (not error-object) (noema-agent-worker--string run "status"))))
       (cond
        (error-object
         (setf (noema-agent-worker-bootstrap-failing worker) nil)
         (noema-agent-worker--retry-bootstrap-failure worker reason))
        ((equal status "preparing")
         (setf (noema-agent-worker-bootstrap-failing worker) nil)
         (noema-agent-worker--retry-bootstrap-failure worker reason))
        ((member status '("completed" "cancelled" "failed" "interrupted"))
         (noema-agent-worker--finish-bootstrap-failure worker reason))
        ((and (equal status "running") (noema-agent-worker-epoch worker))
         ;; The start commit succeeded but its response was lost. Report a
         ;; physical failure through the leased worker path; never re-prompt.
         (setf (noema-agent-worker-bootstrap-failing worker) nil
               (noema-agent-worker-started worker) t)
         (noema-agent-worker--terminal worker "failed" reason))
        (t
         (setf (noema-agent-worker-bootstrap-failing worker) nil)
         (noema-agent-worker--retry-bootstrap-failure worker reason)))))))

(defun noema-agent-worker--fail-prepared (worker reason)
  "Ask Noema to make WORKER's pre-dispatch failure durable before dequeueing."
  (unless (or (noema-agent-worker-terminal worker)
              (noema-agent-worker-bootstrap-failing worker))
    (setf (noema-agent-worker-bootstrap-failing worker) t)
    (noema-agent-worker--api
     "aaronnote:api:research:run:fail-preparing"
     `((root . ,(noema-agent-worker-root worker))
       (runId . ,(noema-agent-worker-run-id worker))
       (failureReason . ,reason))
     (lambda (_result error-object)
       (if error-object
           (progn
             (message "Noema Run %s bootstrap cleanup is being reconciled: %s"
                      (noema-agent-worker-run-id worker)
                      (noema-agent-worker--error error-object))
             (noema-agent-worker--reconcile-bootstrap-failure worker reason))
         (noema-agent-worker--finish-bootstrap-failure worker reason))))))

(defun noema-agent-worker--ledger-warn (label error-object)
  "Log a non-authoritative local-ledger LABEL failure without echo-area noise.
The Magent ledger is a UI projection only; its failures must never look
like a durable Run problem, so they go to `*Warnings*' instead of `message'."
  (display-warning
   'noema-agent-worker
   (format "Noema local ledger %s failed: %s" label (error-message-string error-object))
   :warning))

(defun noema-agent-worker--ledger-init (worker)
  "Create WORKER's queued Run turn in an ephemeral Magent projection."
  (condition-case error-object
      (let* ((session-id (or (noema-agent-worker-session-id worker)
                             (noema-agent-worker-run-id worker)))
             (thread (or (gethash session-id noema-agent-worker--ledgers)
                         (let ((created (magent-thread-create
                                         :id session-id :session-id session-id
                                         :scope (noema-agent-worker-root worker))))
                           (puthash session-id created noema-agent-worker--ledgers)
                           created)))
             (prompt (noema-agent-worker--string (noema-agent-worker-spec worker) "prompt" ""))
             (turn (magent-thread-queue-turn
                    thread prompt (noema-agent-worker-run-id worker)
                    `((run-id . ,(noema-agent-worker-run-id worker))))))
        (setf (noema-agent-worker-ledger worker) thread
              (noema-agent-worker-ledger-turn-id worker) (magent-thread-turn-id turn)
              (noema-agent-worker-action-items worker) (make-hash-table :test #'equal)))
    (error
     ;; The projection is intentionally non-authoritative.  A UI projection
     ;; failure must not invent or erase a durable Run transition.
     (noema-agent-worker--ledger-warn "projection" error-object))))

(defun noema-agent-worker--ledger-attach-session (worker)
  "Associate WORKER's projection with its now-known logical Session."
  (when-let* ((thread (noema-agent-worker-ledger worker))
              (session-id (noema-agent-worker-session-id worker)))
    (setf (magent-thread-session-id thread) session-id)
    (puthash session-id thread noema-agent-worker--ledgers)))

(defun noema-agent-worker--ledger-start (worker)
  "Project WORKER's durable start into its local ledger."
  (when (and (noema-agent-worker-ledger worker)
             (noema-agent-worker-ledger-turn-id worker))
    (condition-case error-object
        (magent-thread-start-turn (noema-agent-worker-ledger worker)
                                  (noema-agent-worker-ledger-turn-id worker))
      (error (noema-agent-worker--ledger-warn "start" error-object)))))

(defun noema-agent-worker--ledger-segment (worker text)
  "Append assistant TEXT to WORKER's local message item."
  (when (and (noema-agent-worker-ledger worker)
             (noema-agent-worker-ledger-turn-id worker)
             (stringp text) (not (string-empty-p text)))
    (condition-case error-object
        (let ((item (or (noema-agent-worker-ledger-message-item worker)
                        (magent-thread-ensure-message-item
                         (noema-agent-worker-ledger worker)
                         (noema-agent-worker-ledger-turn-id worker)
                         'assistant 'final))))
          (setf (noema-agent-worker-ledger-message-item worker) item)
          (magent-thread-append-item-content
           (noema-agent-worker-ledger worker) item text))
      (error (noema-agent-worker--ledger-warn "content" error-object)))))

(defun noema-agent-worker--ledger-action (worker payload)
  "Upsert one normalized tool action PAYLOAD in WORKER's local ledger."
  (when (and (noema-agent-worker-ledger worker)
             (noema-agent-worker-ledger-turn-id worker))
    (condition-case error-object
        (let* ((call-id (format "%s" (or (map-elt payload :tool-call-id)
                                          (map-elt payload 'toolCallId)
                                          (map-elt payload :id)
                                          (map-elt payload 'id)
                                          "unknown-action")))
               (items (noema-agent-worker-action-items worker))
               (item (or (gethash call-id items)
                         (magent-thread-start-item
                          (noema-agent-worker-ledger worker)
                          (noema-agent-worker-ledger-turn-id worker)
                          'tool :id call-id :call-id call-id :input (format "%S" payload))))
               (status (downcase (format "%s" (or (map-elt payload :status)
                                                    (map-elt payload 'status) "")))))
          (puthash call-id item items)
          (cond
           ((member status '("completed" "success" "succeeded"))
            (magent-thread-complete-item (noema-agent-worker-ledger worker) item :output (format "%S" payload)))
           ((member status '("failed" "error"))
            (magent-thread-fail-item (noema-agent-worker-ledger worker) item (format "%S" payload)))
           ((member status '("cancelled" "canceled"))
            (magent-thread-cancel-item (noema-agent-worker-ledger worker) item (format "%S" payload)))
           (t
            (magent-thread-append-event
             (noema-agent-worker-ledger worker)
             (magent-thread-event-create
              :type 'item-updated
              :thread-id (magent-thread-id (noema-agent-worker-ledger worker))
              :turn-id (noema-agent-worker-ledger-turn-id worker)
              :item-id call-id
              :payload (list :item (magent-thread-item-create
                                    :id call-id :turn-id (noema-agent-worker-ledger-turn-id worker)
                                    :type 'tool :status 'in-progress :input (format "%S" payload))))))))
      (error (noema-agent-worker--ledger-warn "action" error-object)))))

(defun noema-agent-worker--ledger-terminal (worker status reason)
  "Project terminal STATUS and REASON for WORKER into its local ledger."
  (when (and (noema-agent-worker-ledger worker)
             (noema-agent-worker-ledger-turn-id worker))
    (condition-case error-object
        (let ((thread (noema-agent-worker-ledger worker))
              (turn-id (noema-agent-worker-ledger-turn-id worker)))
          (when-let* ((item (noema-agent-worker-ledger-message-item worker)))
            (unless (magent-thread-terminal-item-p item)
              (magent-thread-complete-item
               thread item :content (magent-thread-item-content item))))
          (magent-thread-cancel-in-progress-items thread turn-id reason)
          (pcase status
            ("completed" (magent-thread-complete-turn thread turn-id))
            ("failed" (magent-thread-fail-turn thread turn-id reason))
            (_ (magent-thread-interrupt-turn thread turn-id reason))))
      (error (noema-agent-worker--ledger-warn "terminal" error-object)))))

(defun noema-agent-worker--value (object key &optional default)
  "Read string KEY from JSON-like OBJECT, returning DEFAULT when absent."
  (let* ((name (if (symbolp key) (symbol-name key) key))
         (symbol (and (stringp name) (intern-soft name)))
         (missing (make-symbol "noema-missing"))
         (value missing))
    (cond
     ((hash-table-p object) (setq value (gethash name object missing)))
     ((listp object)
      (let ((entry (or (assoc key object)
                       (and symbol (assq symbol object))
                       (assoc name object))))
        (when entry (setq value (cdr entry))))))
    (if (eq value missing) default value)))

(defun noema-agent-worker--string (object key &optional default)
  "Read a non-empty string KEY from OBJECT."
  (let ((value (noema-agent-worker--value object key default)))
    (if (stringp value) value default)))

(defun noema-agent-worker--true-p (value)
  "Return non-nil only for JSON/Elisp truth values in VALUE."
  (and value (not (memq value '(nil :false :null)))))

(defun noema-agent-worker--error (error-object)
  "Return a readable ERROR-OBJECT message from a Noema async callback."
  (or (noema-agent-worker--string error-object "message")
      (noema-agent-worker--string error-object 'message)
      (and (stringp error-object) error-object)
      "request failed"))

(defun noema-agent-worker--api (channel body callback &optional timeout)
  "Call CHANNEL with one BODY object and invoke CALLBACK with result/error."
  (unless (fboundp 'my/noema-api-call)
    (user-error "Noema web-host integration is unavailable"))
  (my/noema-api-call channel (vector body) callback (or timeout 30)))

(defun noema-agent-worker--worker-body (worker &rest entries)
  "Return a Node channel payload for WORKER extended by ENTRIES."
  (let* ((source (noema-agent-worker--value (noema-agent-worker-spec worker) "source"))
         (notebook-relative (and (equal (noema-agent-worker--string source "kind") "work-cell")
                                 (noema-agent-worker--string source "file")))
         (notebook-file (and notebook-relative (not (string-empty-p notebook-relative))
                             (expand-file-name notebook-relative (noema-agent-worker-root worker)))))
    (append `((root . ,(noema-agent-worker-root worker))
            (sessionId . ,(or (noema-agent-worker-session-id worker) ""))
            (owner . ,(format "emacs:%s" (emacs-pid)))
            (epoch . ,(or (noema-agent-worker-epoch worker) 0))
            (runId . ,(noema-agent-worker-run-id worker))
            ,@(when notebook-file `((notebookFile . ,notebook-file)))
            ,@(when-let* ((cell-id (noema-agent-worker--string source "cell_id")))
                `((cellId . ,cell-id))))
            entries)))

(defun noema-agent-worker--result-text (worker)
  "Return bounded assistant output accumulated for WORKER."
  (let ((text (mapconcat #'identity (nreverse (copy-sequence (noema-agent-worker-result-parts worker))) "")))
    (if (> (string-bytes text) noema-agent-worker-result-max-bytes)
        (let ((low 0)
              (high (length text)))
          (while (< low high)
            (let ((middle (/ (+ low high 1) 2)))
              (if (<= (string-bytes (substring text 0 middle))
                      noema-agent-worker-result-max-bytes)
                  (setq low middle)
                (setq high (1- middle)))))
          (concat (substring text 0 low)
                  "\n\n[Result truncated by Noema]"))
      text)))

(defun noema-agent-worker--transcript-text (worker)
  "Return the complete assistant stream accumulated for WORKER."
  (mapconcat #'identity
             (nreverse (copy-sequence (noema-agent-worker-result-parts worker))) ""))

(defun noema-agent-worker--report (worker events &optional callback)
  "Append normalized EVENTS for WORKER without blocking the ACP process."
  (when (and (noema-agent-worker-started worker)
             (noema-agent-worker-epoch worker)
             events)
    (noema-agent-worker--api
     "aaronnote:api:research:worker:events"
     (noema-agent-worker--worker-body worker (cons 'events (vconcat events)))
     (lambda (result error-object)
       (when error-object
         (message "Noema Run %s event delivery failed: %s"
                  (noema-agent-worker-run-id worker)
                  (noema-agent-worker--error error-object)))
       (when callback (funcall callback result error-object))))))

(defun noema-agent-worker--resync-source-buffer (worker)
  "Proactively merge disk outputs into WORKER's open source `.noema' buffer.
Once Node has durably written a work Cell's terminal outputs, an open
JuText buffer for that file is stale relative to disk until it is next
saved or reverted.  Left alone, that staleness is what makes Emacs treat
the file as externally changed the next time the buffer is touched.
Resyncing here, right after the terminal report succeeds, keeps the
visited-file modtime current so that never happens.  The merge syncs
unsaved JuText text first and never overwrites it, so a modified buffer is
resynced too; otherwise its next save would ask about an external change."
  (when-let* ((source (noema-agent-worker--value (noema-agent-worker-spec worker) "source"))
              ((equal (noema-agent-worker--string source "kind") "work-cell"))
              (relative (noema-agent-worker--string source "file"))
              (file (expand-file-name relative (noema-agent-worker-root worker)))
              (buffer (find-buffer-visiting file)))
    (with-current-buffer buffer
      (when (and (derived-mode-p 'noema-research-mode)
                 (fboundp 'noema-research-merge-disk-outputs))
        (ignore-errors (noema-research-merge-disk-outputs))))))

(defun noema-agent-worker--terminal (worker status &optional reason)
  "Make the terminal STATUS transition for WORKER exactly once."
  (unless (noema-agent-worker-terminal worker)
    (setf (noema-agent-worker-terminal worker) t)
	(dolist (permission-id (noema-agent-worker-pending-permissions worker))
	  (remhash permission-id noema-agent-worker--permissions)
	  (noema-agent-worker--attention-note -1))
	(dolist (request-id (noema-agent-worker-pending-inputs worker))
	  (remhash request-id noema-agent-worker--inputs)
	  (noema-agent-worker--attention-note -1))
	(setf (noema-agent-worker-pending-permissions worker) nil
	      (noema-agent-worker-pending-inputs worker) nil)
    (when (timerp (noema-agent-worker-segment-timer worker))
      (cancel-timer (noema-agent-worker-segment-timer worker)))
    (setf (noema-agent-worker-segment-timer worker) nil)
    (let* ((parts (nreverse (noema-agent-worker-segments worker)))
           (text (mapconcat #'identity parts ""))
           (events
            `(,@(when (not (string-empty-p text))
                  `(((type . "run.content.segment")
                     (payload . ((stream . "assistant") (text . ,text))))))
              ((type . "run.status.changed")
               (payload . ((status . ,status)
                           (result_text . ,(noema-agent-worker--result-text worker))
                           (transcript_text . ,(noema-agent-worker--transcript-text worker))
                           ,@(when (and reason (not (string-empty-p reason)))
                               `((failure_reason . ,reason)))))))))
      (setf (noema-agent-worker-segments worker) nil)
      (noema-agent-worker--report
       worker events
       (lambda (_result error-object)
         (noema-agent-worker--stop-renewal worker)
         (remhash (noema-agent-worker-run-id worker) noema-agent-worker--runs)
         (if error-object
             ;; The authoritative Run remains non-terminal until lease expiry.
             ;; Do not let a queued Run collide with it in the meantime.
             (run-at-time 31 nil
                          (lambda () (noema-agent-worker--finish-queue worker 'interrupted)))
           (noema-agent-worker--resync-source-buffer worker)
           (noema-agent-worker--finish-queue worker (intern status))))))
    (noema-agent-worker--ledger-terminal worker status reason)
    ))

(defun noema-agent-worker--flush-segments (worker)
  "Persist a coalesced assistant content segment for WORKER."
  (when-let* ((timer (noema-agent-worker-segment-timer worker))
              ((timerp timer)))
    (cancel-timer timer))
  (setf (noema-agent-worker-segment-timer worker) nil)
  (when-let* ((parts (nreverse (noema-agent-worker-segments worker)))
              (text (mapconcat #'identity parts ""))
              ((not (string-empty-p text))))
    (setf (noema-agent-worker-segments worker) nil)
    (noema-agent-worker--report
     worker (list `((type . "run.content.segment")
                    (payload . ((stream . "assistant") (text . ,text))))))))

(defun noema-agent-worker--queue-segment (worker text)
  "Coalesce streamed TEXT before durable event delivery."
  (when (and (noema-agent-worker-started worker) (not (noema-agent-worker-terminal worker))
             (stringp text) (not (string-empty-p text)))
    (push text (noema-agent-worker-segments worker))
    (push text (noema-agent-worker-result-parts worker))
    (noema-agent-worker--ledger-segment worker text)
    (unless (timerp (noema-agent-worker-segment-timer worker))
      (setf (noema-agent-worker-segment-timer worker)
            (run-at-time noema-agent-worker-segment-delay nil
                         (lambda () (noema-agent-worker--flush-segments worker)))))))

(defun noema-agent-worker--stop-renewal (worker)
  "Stop WORKER's lease and segment timers."
  (dolist (timer (list (noema-agent-worker-renew-timer worker)
                       (noema-agent-worker-segment-timer worker)
                       (noema-agent-worker-cancel-timer worker)
                       (noema-agent-worker-cleanup-timer worker)))
    (when (timerp timer) (cancel-timer timer)))
  (setf (noema-agent-worker-renew-timer worker) nil
        (noema-agent-worker-segment-timer worker) nil
        (noema-agent-worker-cancel-timer worker) nil
        (noema-agent-worker-cleanup-timer worker) nil))

(defun noema-agent-worker--renew (worker)
  "Renew WORKER's lease; never replay a Run when renewal has failed."
  (when (and (not (noema-agent-worker-terminal worker))
             (noema-agent-worker-epoch worker))
    (noema-agent-worker--api
     "aaronnote:api:research:worker:lease"
     (append (noema-agent-worker--worker-body worker)
             `((ttlMillis
                . ,(* 1000
                      (min 60
                           (max 30 (* 3 noema-agent-worker-lease-renew-seconds)))))))
     (lambda (result error-object)
       (if error-object
           (progn
             (message "Noema Run %s lost its worker lease: %s"
                      (noema-agent-worker-run-id worker)
                      (noema-agent-worker--error error-object))
             (noema-agent-worker--terminal worker "interrupted" "worker lease renewal failed"))
         (let* ((lease (or (noema-agent-worker--value result "lease") result))
                (epoch (noema-agent-worker--value lease "epoch")))
	           (when (numberp epoch) (setf (noema-agent-worker-epoch worker) epoch))))))))

(defun noema-agent-worker--start-renewal (worker)
  "Start periodic lease renewal after WORKER becomes physically active."
  (noema-agent-worker--stop-renewal worker)
  (setf (noema-agent-worker-renew-timer worker)
        (run-at-time noema-agent-worker-lease-renew-seconds
                     noema-agent-worker-lease-renew-seconds
                     (lambda () (noema-agent-worker--renew worker)))))

(defun noema-agent-worker--option-id (option)
  "Return ACP option identifier from OPTION."
  (or (map-elt option :option-id) (map-elt option 'optionId) (map-elt option 'id)))

(defun noema-agent-worker--action (tool-call)
  "Normalize agent-shell TOOL-CALL into Noema's narrow ActionIntent shape."
  (let* ((kind (or (map-elt tool-call :kind) "other"))
         (raw (map-elt tool-call :raw-input))
         (locations (or (map-elt tool-call :locations) '()))
         (paths (delq nil (mapcar (lambda (location)
                                    (or (map-elt location 'path)
                                        (map-elt location :path)))
                                  locations)))
         (command (and (listp raw) (or (map-elt raw 'command) (map-elt raw :command))))
         (argv (cond ((vectorp command) (append command nil))
                     ((listp command) command)
                     ((vectorp raw) (append raw nil))
                     (t nil))))
    (let ((action `((kind . ,(format "%s" kind))
                    (paths . ,(vconcat (mapcar (lambda (path) (format "%s" path)) paths))))))
      (when argv
        (setq action
              (append action
                      `((argv . ,(vconcat (mapcar (lambda (part) (format "%s" part)) argv)))))))
      action)))

(defun noema-agent-worker--permission-responder (worker permission)
  "Broker a native ACP PERMISSION callback through Noema's authority."
  (let* ((tool-call (map-elt permission :tool-call))
         (respond (map-elt permission :respond))
         (request-id (or (map-elt tool-call :permission-request-id)
                         (map-elt tool-call :tool-call-id)))
         (options (map-elt permission :options)))
    (if (or (not (functionp respond)) (not request-id) (not (noema-agent-worker-started worker)))
        nil
      (progn
        (noema-agent-worker--api
         "aaronnote:api:research:worker:permission"
         (append (noema-agent-worker--worker-body worker)
                 `((nativeRequestId . ,(format "%s" request-id))
                   (action . ,(noema-agent-worker--action tool-call))
                   (options . ,(vconcat
                                (mapcar (lambda (option)
                                          `((optionId . ,(format "%s" (noema-agent-worker--option-id option)))
                                            (kind . ,(format "%s" (or (map-elt option :kind) "")))
                                            (label . ,(format "%s" (or (map-elt option :label) "")))))
                                        options)))))
         (lambda (result error-object)
           (if error-object
               (let ((reject (seq-find
                              (lambda (option)
                                (string-prefix-p "reject" (format "%s" (or (map-elt option :kind) ""))))
                              options)))
                 ;; A failed broker is intentionally not delegated back to the
                 ;; agent-shell UI: that would bypass Noema's durable decision.
                 (message "Noema permission broker failed: %s" (noema-agent-worker--error error-object))
                 (if reject
                     (funcall respond (noema-agent-worker--option-id reject))
                   (when-let* ((buffer (noema-agent-worker-buffer worker))
                               ((buffer-live-p buffer)))
                     (ignore-errors (noema-agent-acp-shutdown buffer)))
                   (noema-agent-worker--terminal
                    worker "failed" "permission broker failed and ACP offered no reject option")))
             (let* ((stored (or (noema-agent-worker--value result "permission") result))
                    (permission-id (noema-agent-worker--string stored "id"))
                    (automatic (noema-agent-worker--string result "autoDecision"))
                    (automatic (if (string-empty-p automatic)
                                   (noema-agent-worker--string stored "optionId") automatic)))
               (if (not (string-empty-p automatic))
                   (funcall respond automatic)
                 (puthash permission-id (cons worker respond) noema-agent-worker--permissions)
                 (push permission-id (noema-agent-worker-pending-permissions worker))
                 (noema-agent-worker--attention-note 1))))))
        t))))

(defun noema-agent-worker-apply-command (command)
  "Apply a trusted Node-to-Emacs worker COMMAND delivered over the gateway."
  (pcase (noema-agent-worker--string command "type")
    ("permission-decision"
     (let* ((permission-id (noema-agent-worker--string command "permissionId"))
            (option-id (noema-agent-worker--string command "optionId"))
            (entry (gethash permission-id noema-agent-worker--permissions)))
	   (when (and entry (noema-agent-worker--command-current-p (car entry) command))
         (remhash permission-id noema-agent-worker--permissions)
         (setf (noema-agent-worker-pending-permissions (car entry))
               (delete permission-id (noema-agent-worker-pending-permissions (car entry))))
         (funcall (cdr entry) option-id)
         (noema-agent-worker--attention-note -1))))
	("input-response"
	 (let* ((request-id (noema-agent-worker--string command "requestId"))
	        (entry (gethash request-id noema-agent-worker--inputs)))
	   (when (and entry (noema-agent-worker--command-current-p (car entry) command))
	     (remhash request-id noema-agent-worker--inputs)
	     (setf (noema-agent-worker-pending-inputs (car entry))
	           (delete request-id (noema-agent-worker-pending-inputs (car entry))))
	     (funcall (cdr entry) (noema-agent-worker--value command "answer"))
	     (noema-agent-worker--attention-note -1))))
    ("run-cancel"
     (when-let* ((run-id (noema-agent-worker--string command "runId"))
                 (worker (gethash run-id noema-agent-worker--runs)))
       (noema-agent-worker--cancel worker)))))

(defun noema-agent-worker--command-current-p (worker command)
  "Return non-nil when COMMAND targets WORKER's exact leased execution."
  (let ((epoch (noema-agent-worker--value command "epoch"))
		(run-id (noema-agent-worker--string command "runId"))
		(session-id (noema-agent-worker--string command "sessionId")))
    (if (and (numberp epoch)
		     (= epoch (or (noema-agent-worker-epoch worker) 0))
		     (or (not run-id) (equal run-id (noema-agent-worker-run-id worker)))
		     (or (not session-id) (equal session-id (noema-agent-worker-session-id worker))))
		t
	  (message "Noema rejected stale worker command for Run %s (command epoch %s, worker epoch %s)"
		   (noema-agent-worker-run-id worker) epoch (noema-agent-worker-epoch worker))
	  nil)))

(defun noema-agent-worker-request-input (worker native-request-id prompt respond &optional input-kind options)
  "Broker a structured input request for WORKER through Noema.
NATIVE-REQUEST-ID is adapter-owned, PROMPT is displayed in Attention, and
RESPOND receives the eventual JSON answer. Return non-nil when accepted."
  (if (or (not (noema-agent-worker-started worker))
		  (noema-agent-worker-terminal worker)
		  (not (functionp respond))
		  (string-empty-p (format "%s" native-request-id))
		  (string-empty-p (format "%s" prompt)))
      nil
    (noema-agent-worker--api
     "aaronnote:api:research:worker:input"
     (append (noema-agent-worker--worker-body worker)
		     `((nativeRequestId . ,(format "%s" native-request-id))
		       (prompt . ,(format "%s" prompt))
		       (inputKind . ,(or input-kind "text"))
		       (options . ,(vconcat (or options '())))))
     (lambda (result error-object)
       (if error-object
	   (progn
	     (message "Noema input broker failed: %s" (noema-agent-worker--error error-object))
	     (noema-agent-worker--terminal worker "failed" "input broker failed"))
	 (let* ((stored (or (noema-agent-worker--value result "request") result))
		(request-id (noema-agent-worker--string stored "id")))
	   (if (not request-id)
	       (noema-agent-worker--terminal worker "failed" "input broker returned no request id")
	     (puthash request-id (cons worker respond) noema-agent-worker--inputs)
	     (push request-id (noema-agent-worker-pending-inputs worker))
	     (noema-agent-worker--attention-note 1))))))
    t))

(defun noema-agent-worker--cancel (worker)
  "Send ACP cancellation for WORKER, then terminate it after the grace period."
  (unless (noema-agent-worker-terminal worker)
    (when-let* ((buffer (noema-agent-worker-buffer worker))
                ((buffer-live-p buffer)))
      (ignore-errors (noema-agent-acp-interrupt buffer t)))
    (when (timerp (noema-agent-worker-cancel-timer worker))
      (cancel-timer (noema-agent-worker-cancel-timer worker)))
    (setf (noema-agent-worker-cancel-timer worker)
          (run-at-time noema-agent-worker-cancel-grace-seconds nil
                       (lambda ()
                         (unless (noema-agent-worker-terminal worker)
                           (when-let* ((buffer (noema-agent-worker-buffer worker))
                                       ((buffer-live-p buffer)))
                             (ignore-errors (noema-agent-acp-shutdown buffer)))
                           (noema-agent-worker--terminal
                            worker "cancelled" "ACP cancellation grace period elapsed; worker stopped")))))))

;;;###autoload
(defun noema-agent-worker-decide-permission (permission-id option-id)
  "Resolve pending PERMISSION-ID with one offered OPTION-ID through Noema."
  (interactive
   (list (completing-read "Permission: " (hash-table-keys noema-agent-worker--permissions) nil t)
         (read-string "Offered option id: ")))
  (let ((entry (gethash permission-id noema-agent-worker--permissions)))
    (unless entry (user-error "No pending Noema permission %s" permission-id))
    (let ((worker (car entry)))
      (noema-agent-worker--api
       "aaronnote:api:research:permission:decide"
       `((root . ,(noema-agent-worker-root worker))
         (permissionId . ,permission-id) (optionId . ,option-id)
         (expectedVersion . 1) (decidedBy . "emacs"))
       (lambda (_result error-object)
         (if error-object
             (message "Noema permission decision failed: %s" (noema-agent-worker--error error-object))
           ;; The host sends the authoritative downlink command.  This avoids
           ;; racing a web decision with a local direct callback.
           (message "Noema permission decision recorded")))))))

(defun noema-agent-worker--subscribe (worker)
  "Subscribe WORKER to agent-shell facts after a session is ready."
  (let ((buffer (noema-agent-worker-buffer worker)))
    (noema-agent-acp-set-permission-responder
     buffer (lambda (permission) (noema-agent-worker--permission-responder worker permission)))
    (noema-agent-acp-subscribe
     :buffer buffer :event 'agent-message-chunk
     :callback (lambda (event)
                 (noema-agent-worker--queue-segment worker
                                                    (or (map-elt (map-elt event :data) :text-chunk) ""))))
    (noema-agent-acp-subscribe
     :buffer buffer :event 'tool-call-update
     :callback (lambda (event)
                 (when (and (noema-agent-worker-started worker)
                            (not (noema-agent-worker-terminal worker)))
                   (noema-agent-worker--ledger-action
                    worker (or (map-elt event :data) '()))
                   (noema-agent-worker--report
                    worker (list `((type . "run.action.updated")
                                   (payload . ,(or (map-elt event :data) '()))))))))
    (noema-agent-acp-subscribe
     :buffer buffer :event 'turn-complete
     :callback (lambda (event)
                 (let ((reason (format "%s" (or (map-elt (map-elt event :data) :stop-reason) ""))))
                   (noema-agent-worker--terminal
                    worker (if (equal reason "cancelled") "cancelled" "completed") reason))))
    (noema-agent-acp-subscribe
     :buffer buffer :event 'error
     :callback (lambda (event)
                 (when (noema-agent-worker-started worker)
                   (noema-agent-worker--terminal worker "failed"
                                                 (format "%s" (or (map-elt (map-elt event :data) :message) "ACP error"))))))
    (with-current-buffer buffer
      (add-hook 'kill-buffer-hook
                (lambda ()
                  (when (noema-agent-worker-started worker)
                    (noema-agent-worker--terminal worker "interrupted" "agent-shell buffer closed"))) nil t))))

(defun noema-agent-worker--content-blocks (worker)
  "Return exact prompt blocks for WORKER, embedding frozen context if able."
  (let* ((prompt (noema-agent-worker--string (noema-agent-worker-spec worker) "prompt" ""))
         (embedded (noema-agent-acp-state-value
                    (noema-agent-worker-buffer worker)
                    '(:prompt-capabilities :embedded-context)))
         (items (noema-agent-worker-context-items worker)))
    (if (noema-agent-worker--true-p embedded)
        (append
         (list `((type . "text") (text . ,prompt)))
         (mapcar (lambda (item)
                   (let ((text (base64-decode-string (noema-agent-worker--string item "contentBase64"))))
                     `((type . "resource")
                       (resource . ((uri . ,(noema-agent-worker--string item "resolvedUri"))
                                    (text . ,text)
                                    (mimeType . ,(noema-agent-worker--string item "mediaType" "text/plain; charset=utf-8")))))))
                 items))
      (let ((fallback prompt))
        (dolist (item items)
          (setq fallback (concat fallback "\n\n[Noema context: "
                                 (noema-agent-worker--string item "ref") "]\n"
                                 (base64-decode-string (noema-agent-worker--string item "contentBase64")))))
        (list `((type . "text") (text . ,fallback)))))))

(defun noema-agent-worker--capability (worker name &optional default)
  "Return normalized RunSpec capability NAME for WORKER."
  (let ((capabilities (noema-agent-worker--value (noema-agent-worker-spec worker) "capabilities")))
    (downcase (format "%s" (noema-agent-worker--value capabilities name (or default ""))))))

(defun noema-agent-worker--requires-l1-p (worker)
  "Return non-nil if WORKER's frozen capability envelope contains a deny."
  (seq-some (lambda (name) (equal (noema-agent-worker--capability worker name) "deny"))
            '("read_project" "write_project" "execute" "network"
              "write_outside_project" "credentials")))

(defun noema-agent-worker--external-sandbox-p (worker)
  "Return non-nil if the RunSpec declares an independently enforced sandbox."
  (noema-agent-worker--true-p
   (noema-agent-worker--value (noema-agent-worker-spec worker) "external_sandbox")))

(defun noema-agent-worker--permission-resolve-p (worker)
  "Return whether WORKER's ACP adapter is known to support permission replies."
  ;; S-3 verified these ACP adapters.  Pi is only eligible for denied
  ;; capabilities when Node has recorded an external sandbox in the RunSpec.
  (or (not (equal (downcase (noema-agent-worker-agent worker)) "pi"))
      (noema-agent-worker--external-sandbox-p worker)))

(defun noema-agent-worker--restrictive-mode-id (buffer)
  "Return a native plan/read-only ACP mode id for BUFFER, if any."
  (when-let* ((modes (ignore-errors (noema-agent-acp-available-modes buffer))))
    (map-elt
     (seq-find (lambda (mode)
                 (string-match-p "\\(read[-_ ]?only\\|plan\\)"
                                 (downcase (format "%s %s" (or (map-elt mode :id) "")
                                                   (or (map-elt mode :name) "")))))
               modes)
     :id)))

(defun noema-agent-worker--enforce-l1 (worker continuation)
  "Apply native L1 restrictions for WORKER, then call CONTINUATION.
When an adapter has no restrictive mode, only a verified ACP permission
resolver can carry a denied capability forward to L2.  Otherwise the Run is
made durably failed without sending an ACP prompt."
  (cond
   ((not (noema-agent-worker--requires-l1-p worker))
    (setf (noema-agent-worker-l1-mode worker) "not-required")
    (funcall continuation))
   ((and (equal (downcase (noema-agent-worker-agent worker)) "pi")
         (not (noema-agent-worker--external-sandbox-p worker)))
    (setf (noema-agent-worker-preflight-failure worker)
          "Pi denied-capability Run lacks an external L1 sandbox")
    (funcall continuation))
   ((when-let* ((mode-id (noema-agent-worker--restrictive-mode-id
                          (noema-agent-worker-buffer worker))))
      (condition-case error-object
          (progn
            (noema-agent-acp-set-mode
             (noema-agent-worker-buffer worker) mode-id
             (lambda ()
               (setf (noema-agent-worker-l1-mode worker) mode-id)
               (funcall continuation))
             (lambda (_acp-error raw-message)
               (if (noema-agent-worker--permission-resolve-p worker)
                   (progn
                     (setf (noema-agent-worker-l1-mode worker) "l2-fallback")
                     (funcall continuation))
                 (setf (noema-agent-worker-preflight-failure worker)
                       (format "native L1 mode %s failed: %s" mode-id raw-message))
                 (funcall continuation))))
            t)
        (error
         (if (noema-agent-worker--permission-resolve-p worker)
             (progn
               (setf (noema-agent-worker-l1-mode worker) "l2-fallback")
               (funcall continuation))
           (setf (noema-agent-worker-preflight-failure worker)
                 (format "native L1 mode setup failed: %s" (error-message-string error-object)))
           (funcall continuation))
         t))))
   ((noema-agent-worker--permission-resolve-p worker)
    (setf (noema-agent-worker-l1-mode worker) "l2-fallback")
    (funcall continuation))
   (t
    (setf (noema-agent-worker-preflight-failure worker)
          "adapter cannot enforce denied capability and has no permission resolver")
    (funcall continuation))))

(defun noema-agent-worker--send-prompt (worker)
  "Send the frozen RunSpec prompt only after its lease/state transition." 
  (noema-agent-acp-prompt
   :buffer (noema-agent-worker-buffer worker)
   :content (noema-agent-worker--content-blocks worker)
   :on-success (lambda (response)
                 (let ((reason (format "%s" (or (map-elt response 'stopReason) ""))))
                   (noema-agent-worker--terminal worker
                                                 (if (equal reason "cancelled") "cancelled" "completed")
                                                 reason)))
   :on-failure (lambda (_error raw)
                 (noema-agent-worker--terminal worker "failed" (format "%s" raw)))))

(defun noema-agent-worker--start-run (worker)
  "Tell the kernel physical execution is starting, then prompt the ACP agent."
  (noema-agent-worker--api
   "aaronnote:api:research:worker:start"
   (noema-agent-worker--worker-body worker)
   (lambda (_result error-object)
     (if error-object
         (noema-agent-worker--fail-prepared
          worker (format "worker start failed: %s" (noema-agent-worker--error error-object)))
       (setf (noema-agent-worker-started worker) t)
       (setf (noema-agent-worker-queue-state worker) 'running)
       (noema-agent-worker--ledger-start worker)
       (noema-agent-worker--start-renewal worker)
       (if (noema-agent-worker-preflight-failure worker)
           (noema-agent-worker--terminal worker "failed" (noema-agent-worker-preflight-failure worker))
         (noema-agent-worker--send-prompt worker))))))

(defun noema-agent-worker--attach-and-start (worker)
  "Attach a pre-dispatch fresh Run to WORKER's new logical Session if needed."
  (if (string-empty-p (or (noema-agent-worker--string (noema-agent-worker-routing worker) "sessionId") ""))
      (noema-agent-worker--api
       "aaronnote:api:research:worker:attach"
       (noema-agent-worker--worker-body worker)
       (lambda (_result error-object)
         (if error-object
             (noema-agent-worker--fail-prepared
              worker (format "session attachment failed: %s" (noema-agent-worker--error error-object)))
           (noema-agent-worker--start-run worker))))
    (noema-agent-worker--start-run worker)))

(defun noema-agent-worker--acquire-lease (worker)
  "Acquire a fresh lease before changing any Run state."
  (noema-agent-worker--api
   "aaronnote:api:research:worker:lease"
   (append (noema-agent-worker--worker-body worker) '((ttlMillis . 30000)))
   (lambda (result error-object)
     (if error-object
         (noema-agent-worker--fail-prepared
          worker (format "worker lease acquisition failed: %s" (noema-agent-worker--error error-object)))
       (let* ((lease (or (noema-agent-worker--value result "lease") result))
              (epoch (noema-agent-worker--value lease "epoch")))
         (setf (noema-agent-worker-epoch worker) epoch)
         (noema-agent-worker--attach-and-start worker))))))

(defun noema-agent-worker--promote-new-session (worker)
  "Create a logical Noema Session for WORKER's newly-created ACP session."
  (let* ((buffer (noema-agent-worker-buffer worker))
         (native (noema-agent-acp-state-value buffer '(:session :id))))
    (unless (and (stringp native) (not (string-empty-p native)))
      (user-error "ACP session initialization produced no native session id"))
    (noema-agent-worker--api
     "aaronnote:api:research:session:promote"
     `((cwd . ,(noema-agent-worker-target worker))
       (executionTarget . ,(noema-agent-worker-target worker))
       (agent . ,(noema-agent-worker-agent worker))
       (transport . "acp") (nativeSessionId . ,native)
       (workstreamId . ,(noema-agent-worker--string (noema-agent-worker-spec worker) "workstream_id" ""))
       (title . ,(noema-agent-worker--string (noema-agent-worker-spec worker) "prompt" "Noema Run"))
       (parentSessionId . ,(noema-agent-worker--string (noema-agent-worker-routing worker) "parentSessionId" ""))
       (forkMode . ,(if (equal (noema-agent-worker--string (noema-agent-worker-routing worker) "mode") "fork") "native" ""))
       (capabilities . ((permissionResolve . ,(noema-agent-worker--permission-resolve-p worker))
                        (l1Mode . ,(or (noema-agent-worker-l1-mode worker) "unknown"))
                        (sessionList . ,(and (noema-agent-acp-state-value buffer '(:supports-session-list)) t))
                        (sessionLoad . ,(and (noema-agent-acp-state-value buffer '(:supports-session-load)) t))
                        (sessionResume . ,(and (noema-agent-acp-state-value buffer '(:supports-session-resume)) t))
                        (sessionFork . ,(and (noema-agent-acp-state-value buffer '(:supports-session-fork)) t)))))
     (lambda (result error-object)
       (if error-object
           (noema-agent-worker--fail-prepared
            worker (format "ACP session promotion failed: %s" (noema-agent-worker--error error-object)))
         (let* ((session (or (noema-agent-worker--value result "session") result))
                (id (noema-agent-worker--string session "id")))
           (setf (noema-agent-worker-session-id worker) id)
           (noema-agent-worker--ledger-attach-session worker)
           (with-current-buffer buffer
             (setq-local noema-agent-promote--session-id id))
           (noema-agent-worker--acquire-lease worker)))))))

(defun noema-agent-worker--mcp-servers (worker)
  "Return frozen RunSpec MCP servers in agent-shell's ACP shape."
  (mapcar
   (lambda (server)
     `((name . ,(noema-agent-worker--string server "name" "noema"))
       (type . ,(noema-agent-worker--string server "type" "http"))
       (url . ,(noema-agent-worker--string server "url"))
       (headers . ())))
   (append (noema-agent-worker--value (noema-agent-worker-spec worker) "mcp_servers" []) nil)))

(defun noema-agent-worker--config (worker)
  "Resolve WORKER to an installed agent-shell ACP configuration."
  (let* ((agent (noema-agent-worker-agent worker))
         (name (downcase (or agent "codex")))
         (identifier (pcase name
                       ((or "claude" "claude-code") 'claude-code)
                       ((or "open-code" "opencode") 'opencode)
                       (_ (intern name)))))
    (let ((config (copy-tree
                   (or (noema-agent-acp-resolve-config identifier)
                       (user-error "No agent-shell ACP configuration for %s" agent)))))
      (when-let* ((servers (noema-agent-worker--mcp-servers worker)))
        (setf (alist-get :mcp-servers config) servers))
      config)))

(defun noema-agent-worker--existing-buffer (session-id)
  "Find the live agent-shell buffer attached to logical SESSION-ID."
  (seq-find (lambda (buffer)
              (with-current-buffer buffer
                (and (derived-mode-p 'agent-shell-mode)
                     (boundp 'noema-agent-promote--session-id)
                     (equal noema-agent-promote--session-id session-id))))
            (buffer-list)))

(defun noema-agent-worker--on-session-ready (worker fresh)
  "Install bridge and bind WORKER after ACP session initialization."
  (unless (or (noema-agent-worker-terminal worker)
              (noema-agent-worker-bootstrap-failing worker))
    (condition-case error-object
        (progn
          (noema-agent-worker--subscribe worker)
          (noema-agent-worker--enforce-l1
           worker
           (lambda ()
             (if fresh
                 (noema-agent-worker--promote-new-session worker)
               (noema-agent-worker--acquire-lease worker)))))
      (error
       (noema-agent-worker--fail-prepared
        worker (format "ACP session initialization failed: %s"
                       (error-message-string error-object)))))))

(defun noema-agent-worker--start-shell (worker native-session-id &optional fork-session-id)
  "Start/resume agent-shell for WORKER and continue after ACP initialization."
  (let* ((target (noema-agent-worker-target worker))
         (config (noema-agent-worker--config worker))
         (fresh (not (and native-session-id (not (string-empty-p native-session-id)))))
         (buffer (noema-agent-acp-start
                  :config config :directory target :session-id native-session-id
                  :fork-session-id fork-session-id)))
    (setf (noema-agent-worker-buffer worker) buffer)
    ;; Agent-shell buffers back a document Run, not a document a user
    ;; browses to directly; keep them out of tab-line/tab-bar so they never
    ;; accumulate into a wall of tabs (they stay reachable through Attention,
    ;; the Graph Board Agent Run menu, or `switch-to-buffer').
    (with-current-buffer buffer
      (setq-local tab-line-exclude t))
    (noema-agent-acp-subscribe
     :buffer buffer :event 'init-session
     :callback (lambda (_event) (noema-agent-worker--on-session-ready worker fresh)))))

(defun noema-agent-worker--dispatch (worker)
  "Use a live shell, resume a logical session, or create a fresh ACP session."
  (let* ((routing (noema-agent-worker-routing worker))
         (logical (noema-agent-worker--string routing "sessionId"))
         (session (noema-agent-worker--value routing "session"))
         (native (noema-agent-worker--string session "nativeSessionId"))
         (mode (noema-agent-worker--string routing "mode"))
         (parent (noema-agent-worker--value routing "parent"))
         (fork-native (and (equal mode "fork")
                           (noema-agent-worker--string parent "nativeSessionId")))
         (buffer (and (not (string-empty-p logical)) (noema-agent-worker--existing-buffer logical))))
    (if buffer
        (progn
          (setf (noema-agent-worker-buffer worker) buffer
                (noema-agent-worker-session-id worker) logical)
          (noema-agent-worker--on-session-ready worker nil))
      (progn
        (setf (noema-agent-worker-session-id worker) logical)
        (noema-agent-worker--start-shell worker native fork-native)))))

(defun noema-agent-worker--accept-prepared (target result error-object &optional submission)
  "Dispatch a frozen RESULT rooted at TARGET, or report ERROR-OBJECT.
When SUBMISSION is non-nil, fill and dispatch that pre-freeze queue token."
  (if error-object
      (progn
        (message "Noema Run preparation failed: %s" (noema-agent-worker--error error-object))
        (when submission (noema-agent-worker--finish-queue submission 'failed)))
    (let* ((run (noema-agent-worker--value result "run"))
           (spec (noema-agent-worker--value result "spec"))
           (routing (noema-agent-worker--value result "routing"))
           (worker (or submission (noema-agent-worker--create))))
      (setf (noema-agent-worker-run-id worker) (noema-agent-worker--string run "id")
            (noema-agent-worker-session-id worker) (noema-agent-worker--string run "sessionId")
            (noema-agent-worker-root worker) (noema-agent-worker--string result "root")
            (noema-agent-worker-target worker) (noema-agent-worker--string spec "execution_target" target)
            (noema-agent-worker-agent worker)
            (let ((agent (noema-agent-worker--value spec "agent" "codex")))
              (if (stringp agent) agent (noema-agent-worker--string agent "id" "codex")))
            (noema-agent-worker-spec worker) spec
            (noema-agent-worker-context-items worker) (append (noema-agent-worker--value result "contextItems") nil)
            (noema-agent-worker-routing worker) routing
            (noema-agent-worker-segments worker) nil
            (noema-agent-worker-result-parts worker) nil
            (noema-agent-worker-pending-permissions worker) nil
            (noema-agent-worker-pending-inputs worker) nil)
      (puthash (noema-agent-worker-run-id worker) worker noema-agent-worker--runs)
      (when-let* ((source (noema-agent-worker--value spec "source"))
                  ((equal (noema-agent-worker--string source "kind") "work-cell"))
                  (relative (noema-agent-worker--string source "file"))
                  (cell-id (noema-agent-worker--string source "cell_id"))
                  ((fboundp 'my/noema-jupyter-output-open-document)))
        (let* ((file (expand-file-name relative (noema-agent-worker-root worker)))
               (root (noema-agent-worker-root worker))
               (host-file (if (fboundp 'my/noema--host-file)
                              (my/noema--host-file file) file))
               (host-root (if (fboundp 'my/noema--host-file)
                              (my/noema--host-file root) root)))
          ;; Open before ACP dispatch so the renderer receives the first live
          ;; snapshot and every durable segment for this exact Run.
          (my/noema-jupyter-output-open-document
           `((scriptFile . ,host-file)
             (sourceFile . ,host-file)
             (projectRoot . ,host-root)
             (cellId . ,cell-id)
             (runId . ,(noema-agent-worker-run-id worker))) nil)))
      (noema-agent-worker--ledger-init worker)
      (condition-case error-object
          (noema-agent-worker--dispatch worker)
        (error
         (noema-agent-worker--fail-prepared
          worker (format "ACP dispatch failed: %s" (error-message-string error-object))))))))

(defun noema-agent-worker--new-submission-id ()
  "Return a process-local identity for a pre-freeze queue entry."
  (concat "noema-submission:"
          (substring (secure-hash 'sha256
                                  (format "%s:%s:%s" (float-time) (random) (emacs-pid)))
                     0 16)))

(defun noema-agent-worker--begin-preparation (worker)
  "Start queued WORKER after the Noema web host is ready."
  (let ((id (noema-agent-worker-submission-id worker))
        (target (noema-agent-worker-target worker)))
    ;; A user can cancel while the host is starting.  In that case its
    ;; eventual ready callback must not resurrect the Run.
    (when (and (gethash id noema-agent-worker--submissions)
               (eq (noema-agent-worker-queue-state worker) 'queued))
      (let ((disposition
             (magent-runtime-queue-arbitrate
              'noema worker id
              (lambda ()
                (setf (noema-agent-worker-queue-state worker) 'preparing)
                (noema-agent-worker--api
                 "aaronnote:api:research:run:prepare"
                 (noema-agent-worker-prepare-body worker)
                 (lambda (result error-object)
                   (noema-agent-worker--accept-prepared
                    target result error-object worker))))
              (lambda (error-object)
                (setf (noema-agent-worker-queue-state worker) 'failed)
                (remhash id noema-agent-worker--submissions)
                (message "Noema queued Run could not start: %s"
                         (error-message-string error-object)))
              (lambda ()
                (memq (noema-agent-worker-queue-state worker)
                      '(queued preparing running))))))
        (message "Noema document execution %s (%s)" disposition id)))))

(defun noema-agent-worker--enqueue-preparation (target body)
  "Queue BODY for RunSpec freezing and dispatch at project TARGET."
  (let* ((id (noema-agent-worker--new-submission-id))
         (worker (noema-agent-worker--create
                  :submission-id id :prepare-body body :target target
                  :root target :queue-state 'queued)))
    (puthash id worker noema-agent-worker--submissions)
    (if (fboundp 'my/noema--ensure-server)
        (progn
          (message "Noema document execution waiting for web-host (%s)" id)
          (my/noema--ensure-server
           (lambda () (noema-agent-worker--begin-preparation worker))))
      (noema-agent-worker--begin-preparation worker))
    id))

;;;###autoload
(defun noema-agent-worker-cancel-queued (submission-id)
  "Cancel queued pre-freeze SUBMISSION-ID without creating a Run."
  (interactive
   (list (completing-read
          "Queued Noema execution: "
          (seq-filter
           (lambda (id)
             (eq (noema-agent-worker-queue-state
                  (gethash id noema-agent-worker--submissions))
                 'queued))
           (hash-table-keys noema-agent-worker--submissions))
          nil t)))
  (let ((worker (gethash submission-id noema-agent-worker--submissions)))
    (unless (and worker (eq (noema-agent-worker-queue-state worker) 'queued))
      (user-error "No queued Noema execution %s" submission-id))
    (magent-runtime-queue-arbiter-cancel 'noema worker)
    (setf (noema-agent-worker-queue-state worker) 'cancelled)
    (remhash submission-id noema-agent-worker--submissions)
    (message "Cancelled %s before RunSpec freezing" submission-id)))

;;;###autoload
(defun noema-agent-worker-cancel-run (run-id)
  "Cancel active durable Noema RUN-ID and its physical ACP work."
  (interactive
   (let ((ids (hash-table-keys noema-agent-worker--runs)))
     (unless ids (user-error "No active Noema Agent Run"))
     (list (if (= (length ids) 1)
               (car ids)
             (completing-read "Active Noema Run: " ids nil t)))))
  (let ((worker (gethash run-id noema-agent-worker--runs)))
    (unless worker (user-error "No active Noema Run %s" run-id))
    (noema-agent-worker--cancel worker)
    (message "Noema Agent Run %s cancellation requested" run-id)))

;;;###autoload
(defun noema-agent-worker-run-work-cell (file cell-id &optional session-policy parent-session-id)
  "Prepare and execute work CELL-ID in research notebook FILE.
SESSION-POLICY is one of continue, fork, or fresh; a fork needs
PARENT-SESSION-ID.  Absent policy uses the notebook declaration/default route.
No ACP prompt is sent until its frozen RunSpec is stored by the Go kernel."
  (interactive
   (let* ((file (read-file-name "Research notebook: " nil nil t nil
                                (lambda (path) (string-match-p "\\.noema\\'" path))))
          (cell-id (read-string "Work cell id: "))
          (policy (completing-read "Session policy (empty = default): " '("" "continue" "fork" "fresh") nil t)))
     (list file cell-id policy
           (when (equal policy "fork") (read-string "Parent Noema session id: ")))))
  (let ((target (expand-file-name default-directory)))
    (noema-agent-worker--enqueue-preparation
     target
     `((file . ,(expand-file-name file)) (cellId . ,cell-id) (cwd . ,target)
       ,@(when (and session-policy (not (string-empty-p session-policy)))
           `((sessionPolicy . ,session-policy)))
       ,@(when (and parent-session-id (not (string-empty-p parent-session-id)))
           `((parentSessionId . ,parent-session-id)))))))

;;;###autoload
(defun noema-agent-worker-run-prompt-file (file &optional session-policy parent-session-id)
  "Execute a strict four-directive .prompt FILE as a frozen Noema Run."
  (interactive
   (let* ((file (read-file-name "Noema prompt: " nil nil t nil
                                (lambda (path) (string-match-p "\\.prompt\\'" path))))
          (policy (completing-read "Session policy (empty = prompt/default): "
                                   '("" "continue" "fork" "fresh") nil t)))
     (list file policy
           (when (equal policy "fork") (read-string "Parent Noema session id: ")))))
  (let ((target (expand-file-name default-directory)))
    (noema-agent-worker--enqueue-preparation
     target
     `((promptFile . ,(expand-file-name file)) (cwd . ,target)
       ,@(when (and session-policy (not (string-empty-p session-policy)))
           `((sessionPolicy . ,session-policy)))
       ,@(when (and parent-session-id (not (string-empty-p parent-session-id)))
           `((parentSessionId . ,parent-session-id)))))))

(provide 'noema-agent-worker)
;;; noema-agent-worker.el ends here
