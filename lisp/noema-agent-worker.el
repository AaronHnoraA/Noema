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
(declare-function noema-sessions-open-reference "noema-sessions" (root &optional name session-id))

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

(defcustom noema-agent-worker-buffer-max-bytes (* 4 1024 1024)
  "Maximum persisted conversation text retained in a Noema agent buffer."
  :type 'integer
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-warm-buffer-limit 8
  "Maximum number of idle resumable Noema agent buffers kept per project."
  :type 'integer
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-warm-idle-seconds (* 30 60)
  "Seconds an idle resumable agent buffer remains warm."
  :type 'integer
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-context-warning-ratio 0.70
  "Context-window ratio at which Noema warns once per physical Session."
  :type 'number
  :group 'noema-agent-worker)

(defcustom noema-agent-worker-context-rollover-ratio 0.85
  "Context-window ratio at which the next Run uses a checkpoint generation."
  :type 'number
  :group 'noema-agent-worker)

(defvar noema-agent-worker--warm-sweep-timer nil
  "Periodic timer that hibernates old resumable Session buffers.")

(defvar noema-agent-worker--attention-count 0
  "Number of permission/input requests currently awaiting a user decision.")

(defconst noema-agent-worker--mode-line-entry
  '(:eval (noema-agent-worker--attention-lighter))
  "The `global-mode-string' entry for pending Noema attention items.")

(defvar noema-agent-worker--runs)

(defcustom noema-agent-worker-busy-retry-seconds 15
  "Seconds before a Run waiting on a busy named session retries preparation.
A waiting Run is also retried as soon as a local Run finishes."
  :type 'number
  :group 'noema-agent-worker)

(defvar noema-agent-worker--busy-waiting nil
  "Queued workers whose named session had another open Run (D-031).")

(defun noema-agent-worker--attention-lighter ()
  "Return the mode-line fragment for running Runs and pending decisions.
D-034: this replaces per-Run echo-area messages."
  (let ((running (if (hash-table-p noema-agent-worker--runs)
                     (hash-table-count noema-agent-worker--runs)
                   0))
        (pending noema-agent-worker--attention-count))
    (when (or (> running 0) (> pending 0))
      (concat " Noema["
              (if (> running 0) (format "▶%d" running) "")
              (if (and (> running 0) (> pending 0)) " " "")
              (if (> pending 0) (format "!%d" pending) "")
              "]"))))

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
  renew-timer segment-timer cancel-timer segments result-parts result-bytes
  result-truncated subscriptions kill-hook pending-permissions pending-inputs started terminal
  l1-mode preflight-failure ledger ledger-turn-id ledger-message-item action-items
  submission-id prepare-body queue-state bootstrap-failing cleanup-timer
  terminal-status terminal-reason terminal-events terminal-acked terminal-reporting
  terminal-attempts completion-timer report-queue report-busy)

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

(defvar noema-agent-worker-run-finished-functions nil
  "Abnormal hook run with a worker and its final local queue state.
D-035: the Pi manager uses it to stop an agent that outlived its project.")

(defun noema-agent-worker--finish-queue (worker state)
  "Release WORKER's Magent arbiter ticket with terminal local STATE."
  (when (noema-agent-worker-submission-id worker)
    (setf (noema-agent-worker-queue-state worker) state)
    (remhash (noema-agent-worker-submission-id worker) noema-agent-worker--submissions)
    (magent-runtime-queue-arbiter-finish 'noema worker))
  (noema-agent-worker--wake-waiting)
  (run-hook-with-args 'noema-agent-worker-run-finished-functions worker state))

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
     ;; The worker body carries notebookFile, so Node persists the failure as
     ;; this Run's cell output instead of leaving OutputArea waiting for it.
     (noema-agent-worker--worker-body worker `(failureReason . ,reason))
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
                             (expand-file-name notebook-relative (noema-agent-worker-root worker))))
	 (session-spec (noema-agent-worker--value (noema-agent-worker-spec worker) "session"))
	 (compaction-id (noema-agent-worker--string session-spec "compaction_id"))
	 (usage (noema-agent-worker--session-usage worker)))
    (append `((root . ,(noema-agent-worker-root worker))
            (sessionId . ,(or (noema-agent-worker-session-id worker) ""))
            (owner . ,(format "emacs:%s" (emacs-pid)))
            (epoch . ,(or (noema-agent-worker-epoch worker) 0))
            (runId . ,(noema-agent-worker-run-id worker))
            ,@(when notebook-file `((notebookFile . ,notebook-file)))
			,@(when compaction-id `((compactionId . ,compaction-id)))
			,@(when usage `((sessionUsage . ,usage)))
            ,@(when-let* ((cell-id (noema-agent-worker--string source "cell_id")))
                `((cellId . ,cell-id))))
            entries)))

(defun noema-agent-worker--session-usage (worker)
  "Return normalized ACP usage for WORKER's physical Session, if known."
  (when-let* ((buffer (noema-agent-worker-buffer worker))
		  ((buffer-live-p buffer)))
    (with-current-buffer buffer
      (when-let* ((state (and (boundp 'agent-shell--state) agent-shell--state))
		      (usage (map-elt state :usage)))
	(let ((number (lambda (key) (let ((value (map-elt usage key)))
					 (if (numberp value) (max 0 (truncate value)) 0)))))
	  `((totalTokens . ,(funcall number :total-tokens))
	    (inputTokens . ,(funcall number :input-tokens))
	    (outputTokens . ,(funcall number :output-tokens))
	    (thoughtTokens . ,(funcall number :thought-tokens))
	    (cachedTokens . ,(+ (funcall number :cached-read-tokens)
				  (funcall number :cached-write-tokens)))
	    (contextUsed . ,(funcall number :context-used))
	    (contextSize . ,(funcall number :context-size))))))))

(defun noema-agent-worker--check-context-pressure (worker event)
  "Warn once when the ACP usage in turn-complete EVENT is near its limit."
  (when-let* ((buffer (noema-agent-worker-buffer worker))
		  ((buffer-live-p buffer))
		  (usage (map-elt (map-elt event :data) :usage))
		  (used (map-elt usage :context-used))
		  (size (map-elt usage :context-size))
		  ((numberp used)) ((numberp size)) ((> size 0)))
    (let* ((ratio (/ (float used) size))
	   (level (cond ((>= ratio noema-agent-worker-context-rollover-ratio) 2)
			((>= ratio noema-agent-worker-context-warning-ratio) 1)
			(t 0))))
      (with-current-buffer buffer
	(when (> level noema-agent-acp-context-warning-level)
	  (setq-local noema-agent-acp-context-warning-level level)
	  (message
	   (if (= level 2)
	       "Noema Session context is %.0f%%; its next Run will roll over from the latest durable handoff"
	     "Noema Session context is %.0f%%; consider M-x noema-agent-worker-compact-session")
	   (* ratio 100)))))))

(defun noema-agent-worker--result-text (worker)
  "Return bounded assistant output accumulated for WORKER."
  (concat
   (mapconcat #'identity
              (nreverse (copy-sequence (noema-agent-worker-result-parts worker))) "")
   (when (noema-agent-worker-result-truncated worker)
     "\n\n[Result truncated by Noema]")))

(defun noema-agent-worker--transcript-text (worker)
  "Return WORKER's bounded assistant stream.

Full content remains in durable Run events.  Keeping another unbounded copy in
Emacs made long-running sessions consume memory twice."
  (noema-agent-worker--result-text worker))

(defun noema-agent-worker--prefix-within-bytes (text limit)
  "Return the longest prefix of TEXT whose encoded size is at most LIMIT."
  (let ((low 0)
        (high (length text)))
    (while (< low high)
      (let ((middle (/ (+ low high 1) 2)))
        (if (<= (string-bytes (substring text 0 middle)) limit)
            (setq low middle)
          (setq high (1- middle)))))
    (substring text 0 low)))

(defun noema-agent-worker--cleanup-subscriptions (worker)
  "Detach per-Run callbacks owned by WORKER from its reusable shell buffer."
  (when-let* ((buffer (noema-agent-worker-buffer worker))
              ((buffer-live-p buffer)))
    (dolist (subscription (noema-agent-worker-subscriptions worker))
      (ignore-errors
        (noema-agent-acp-unsubscribe :buffer buffer :subscription subscription)))
    (when-let* ((hook (noema-agent-worker-kill-hook worker)))
      (with-current-buffer buffer
        (remove-hook 'kill-buffer-hook hook t)))
    (noema-agent-acp-set-permission-responder buffer nil))
  (setf (noema-agent-worker-subscriptions worker) nil
        (noema-agent-worker-kill-hook worker) nil))

(defun noema-agent-worker--report (worker events &optional callback)
  "Append normalized EVENTS for WORKER without blocking the ACP process."
  (when (and (noema-agent-worker-started worker)
             (noema-agent-worker-epoch worker)
             events)
    (setf (noema-agent-worker-report-queue worker)
          (nconc (noema-agent-worker-report-queue worker) (list (cons events callback))))
    (noema-agent-worker--drain-reports worker)))

(defun noema-agent-worker--drain-reports (worker)
  "Serialize event appends so a terminal batch cannot overtake its content."
  (when (and (not (noema-agent-worker-report-busy worker))
             (noema-agent-worker-report-queue worker))
    (let* ((job (pop (noema-agent-worker-report-queue worker)))
           (events (car job)) (callback (cdr job)) settled)
      (setf (noema-agent-worker-report-busy worker) t)
      (let ((finish
             (lambda (result error-object)
               (unless settled
                 (setq settled t)
                 (when error-object
                   (message "Noema Run %s event delivery failed: %s"
                            (noema-agent-worker-run-id worker)
                            (noema-agent-worker--error error-object)))
                 (when-let* ((result-error (and (not error-object)
                                               (noema-agent-worker--string result "resultError"))))
                   (message "Noema Run %s output writeback is pending: %s"
                            (noema-agent-worker-run-id worker) result-error))
                 (setf (noema-agent-worker-report-busy worker) nil)
                 (unwind-protect
                     (when callback (noema-agent-worker--best-effort callback result error-object))
                   (noema-agent-worker--drain-reports worker))))))
        (condition-case error-object
            (noema-agent-worker--api
             "aaronnote:api:research:worker:events"
             (noema-agent-worker--worker-body worker (cons 'events (vconcat events)))
             finish)
          (error (funcall finish nil (error-message-string error-object))))))))

(defun noema-agent-worker--best-effort (function &rest args)
  "Run optional presentation/cleanup FUNCTION without losing durable status."
  (condition-case error-object
      (apply function args)
    (error (message "Noema completion cleanup (%s): %s"
                    function (error-message-string error-object)) nil)))

(defun noema-agent-worker--completion-retry (worker)
  "Reconcile an unacknowledged terminal report; never resend the agent prompt."
  (unless (or (noema-agent-worker-terminal-acked worker)
              (timerp (noema-agent-worker-completion-timer worker)))
    (let ((attempt (or (noema-agent-worker-terminal-attempts worker) 0)))
      (when (< attempt 4)
        (setf (noema-agent-worker-completion-timer worker)
              (run-at-time (min 8 (expt 2 attempt)) nil
                           (lambda ()
                             (setf (noema-agent-worker-completion-timer worker) nil)
                             (noema-agent-worker-check-completion worker))))))))

(defun noema-agent-worker--ack-terminal (worker status)
  "Release WORKER only after its terminal state is acknowledged by the host."
  (unless (noema-agent-worker-terminal-acked worker)
    (setf (noema-agent-worker-terminal-acked worker) t)
    (noema-agent-worker--stop-renewal worker)
    (remhash (noema-agent-worker-run-id worker) noema-agent-worker--runs)
    (noema-agent-worker--best-effort #'force-mode-line-update t)
    (noema-agent-worker--best-effort #'noema-agent-worker--resync-source-buffer worker)
    (noema-agent-worker--best-effort #'noema-agent-worker--refresh-run-views worker)
    (when-let* ((buffer (noema-agent-worker-buffer worker)) ((buffer-live-p buffer)))
      (noema-agent-worker--best-effort #'noema-agent-acp-touch buffer)
      (noema-agent-worker--best-effort #'noema-agent-acp-trim-buffer buffer noema-agent-worker-buffer-max-bytes))
    (noema-agent-worker--best-effort #'noema-agent-worker--finish-queue worker (intern status))))

(defun noema-agent-worker--submit-terminal (worker)
  "Submit WORKER's frozen terminal facts once, retaining them until ACK."
  (unless (or (noema-agent-worker-terminal-acked worker)
              (noema-agent-worker-terminal-reporting worker))
    (setf (noema-agent-worker-terminal-reporting worker) t
          (noema-agent-worker-terminal-attempts worker)
          (1+ (or (noema-agent-worker-terminal-attempts worker) 0)))
    (noema-agent-worker--report
     worker (noema-agent-worker-terminal-events worker)
     (lambda (_result error-object)
       (setf (noema-agent-worker-terminal-reporting worker) nil)
       (if error-object
           (noema-agent-worker--completion-retry worker)
         (noema-agent-worker--ack-terminal worker (noema-agent-worker-terminal-status worker)))))))

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
              (file (expand-file-name relative (noema-agent-worker-root worker))))
    (noema-agent-worker--resync-file-buffer file)))

(defun noema-agent-worker--refresh-run-views (worker)
  "Refresh source and graph projections when WORKER changes durable state."
  (when-let* ((source (noema-agent-worker--value (noema-agent-worker-spec worker) "source"))
              (file (noema-agent-worker--string source "file"))
              (buffer (find-buffer-visiting (expand-file-name file (noema-agent-worker-root worker)))))
    (with-current-buffer buffer
      (when (fboundp 'noema-research--schedule-session-routes)
        (noema-research--schedule-session-routes)))
    (when-let* ((graph (get-buffer "*Noema DAG*"))
                ((eq (buffer-local-value 'noema-research-graph--source graph) buffer)))
      (with-current-buffer graph (noema-research-graph-refresh-runs)))))

(defun noema-agent-worker--resync-file-buffer (file)
  "Merge canonical outputs from FILE into its live research buffer, if any."
  (when-let* ((file (and (stringp file) (expand-file-name file)))
	      (buffer (find-buffer-visiting file)))
    (with-current-buffer buffer
      (when (and (derived-mode-p 'noema-research-mode)
                 (fboundp 'noema-research-merge-disk-outputs))
        (ignore-errors (noema-research-merge-disk-outputs))))))

(defun noema-agent-worker--terminal (worker status &optional reason stop-client)
  "Make the terminal STATUS transition for WORKER exactly once."
  (unless (noema-agent-worker-terminal worker)
    (setf (noema-agent-worker-terminal worker) t
          (noema-agent-worker-terminal-status worker) status
          (noema-agent-worker-terminal-reason worker) reason)
    ;; Freeze completion before presentation hooks, which may throw on a
    ;; package reload or a renderer failure. The receipt survives those errors.
    (let ((text (mapconcat #'identity (reverse (noema-agent-worker-segments worker)) "")))
      (setf (noema-agent-worker-terminal-events worker)
            `(,@(unless (string-empty-p text)
                  `(((type . "run.content.segment")
                     (payload . ((stream . "assistant") (text . ,text))))))
              ((type . "run.status.changed")
               (payload . ((status . ,status)
                           (result_text . ,(noema-agent-worker--result-text worker))
                           (transcript_text . ,(noema-agent-worker--transcript-text worker))
                           ,@(when (and reason (not (string-empty-p reason)))
                               `((failure_reason . ,reason)))))))))
    (setf (noema-agent-worker-segments worker) nil)
    (noema-agent-worker--best-effort #'noema-agent-worker--cleanup-subscriptions worker)
	(dolist (permission-id (noema-agent-worker-pending-permissions worker))
	  (remhash permission-id noema-agent-worker--permissions)
	  (noema-agent-worker--best-effort #'noema-agent-worker--attention-note -1))
	(dolist (request-id (noema-agent-worker-pending-inputs worker))
	  (remhash request-id noema-agent-worker--inputs)
	  (noema-agent-worker--best-effort #'noema-agent-worker--attention-note -1))
	(setf (noema-agent-worker-pending-permissions worker) nil
	      (noema-agent-worker-pending-inputs worker) nil)
    (when (timerp (noema-agent-worker-segment-timer worker))
      (cancel-timer (noema-agent-worker-segment-timer worker)))
    (setf (noema-agent-worker-segment-timer worker) nil)
    (when-let* ((buffer (noema-agent-worker-buffer worker)) ((buffer-live-p buffer)))
      (when stop-client
        (noema-agent-worker--best-effort #'noema-agent-acp-shutdown buffer))
      (noema-agent-worker--best-effort #'noema-agent-acp-restore-prompt buffer))
    (noema-agent-worker--best-effort #'noema-agent-worker--ledger-terminal worker status reason)
    (noema-agent-worker--submit-terminal worker)
    (when (equal status "failed")
      (message "Noema Run %s failed: %s" (noema-agent-worker-run-id worker) reason))))

(defun noema-agent-worker-check-completion (worker)
  "Reconcile WORKER from ACP receipts and durable status, never from prose."
  (let* ((receipt (noema-agent-acp-prompt-receipt
                   (noema-agent-worker-buffer worker) (noema-agent-worker-run-id worker)))
         (state (plist-get receipt :status)))
    (cond
     ((noema-agent-worker-terminal-acked worker) 'finished)
     ((and (noema-agent-worker-terminal worker)
           (noema-agent-worker-terminal-events worker))
      (unless (noema-agent-worker-terminal-reporting worker)
        (noema-agent-worker--api
         "aaronnote:api:research:run:get"
         `((root . ,(noema-agent-worker-root worker)) (runId . ,(noema-agent-worker-run-id worker)))
         (lambda (result error-object)
           (let ((status (noema-agent-worker--string (noema-agent-worker--value result "run") "status")))
             (cond (error-object
                    (cl-incf (noema-agent-worker-terminal-attempts worker))
                    (noema-agent-worker--completion-retry worker))
                   ((member status '("completed" "cancelled" "failed" "interrupted"))
                    (noema-agent-worker--ack-terminal worker status))
                   (t (noema-agent-worker--submit-terminal worker)))))))
      'reconciling)
     ((eq state 'completed)
      (let ((reason (format "%s" (or (map-elt (plist-get receipt :response) 'stopReason) ""))))
        (noema-agent-worker--terminal worker (if (equal reason "cancelled") "cancelled" "completed") reason))
      'finished)
     ((eq state 'failed)
      (noema-agent-worker--terminal worker "failed" (format "%s" (plist-get receipt :error)))
      'finished)
     (t 'pending))))

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
    (let* ((used (or (noema-agent-worker-result-bytes worker) 0))
           (remaining (max 0 (- noema-agent-worker-result-max-bytes used)))
           (kept (if (<= (string-bytes text) remaining)
                     text
                   (noema-agent-worker--prefix-within-bytes text remaining))))
      (unless (string-empty-p kept)
        (push kept (noema-agent-worker-result-parts worker))
        (setf (noema-agent-worker-result-bytes worker)
              (+ used (string-bytes kept))))
      (when (< (length kept) (length text))
        (setf (noema-agent-worker-result-truncated worker) t)))
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
                       (noema-agent-worker-cleanup-timer worker)
                       (noema-agent-worker-completion-timer worker)))
    (when (timerp timer) (cancel-timer timer)))
  (setf (noema-agent-worker-renew-timer worker) nil
        (noema-agent-worker-segment-timer worker) nil
        (noema-agent-worker-cancel-timer worker) nil
        (noema-agent-worker-cleanup-timer worker) nil
        (noema-agent-worker-completion-timer worker) nil))

(defun noema-agent-worker--renew (worker)
  "Renew WORKER's lease; never replay a Run when renewal has failed."
  (when (and (noema-agent-worker-started worker)
             (not (noema-agent-worker-terminal worker)))
    (noema-agent-worker-check-completion worker))
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
           ;; D-035: a finished Run releases its lease; a renewal that was
           ;; already in flight then fails, which is not a lost lease.
           (unless (noema-agent-worker-terminal worker)
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

(declare-function noema-research-attention "noema-research-inspector" (&optional origin))
(declare-function noema-research-attention-refresh "noema-research-inspector" ())

(defun noema-agent-worker--show-permission-request (worker)
  "Put WORKER's pending permission request in front of the person.
Work inside the project is approved by the kernel; a request that reaches
this point goes beyond the project, so Attention opens to decide it."
  (let ((root (noema-agent-worker-root worker)))
    (run-at-time
     0 nil
     (lambda ()
       (when (require 'noema-research-inspector nil t)
         (let ((buffer (get-buffer "*Noema Attention*")))
           (if (and (buffer-live-p buffer) (get-buffer-window buffer t))
               (with-current-buffer buffer (noema-research-attention-refresh))
             (noema-research-attention root))))))))

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
                    ;; The kernel omits an empty optionId: a pending request
                    ;; carries no decision at all, not an empty one.
                    (automatic (seq-find (lambda (value)
                                           (and (stringp value) (not (string-empty-p value))))
                                         (list (noema-agent-worker--string result "autoDecision")
                                               (noema-agent-worker--string stored "optionId")))))
               (if automatic
                   (funcall respond automatic)
                 (puthash permission-id (cons worker respond) noema-agent-worker--permissions)
                 (push permission-id (noema-agent-worker-pending-permissions worker))
                 (noema-agent-worker--attention-note 1)
                 (noema-agent-worker--show-permission-request worker))))))
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
	("notebook-writeback"
	 (when-let* ((file (noema-agent-worker--string command "file")))
	   (noema-agent-worker--resync-file-buffer file)))
    ("run-cancel"
     (when-let* ((run-id (noema-agent-worker--string command "runId"))
                 (worker (gethash run-id noema-agent-worker--runs)))
       (noema-agent-worker--cancel worker)))
    ("run-check-completion"
     (when-let* ((run-id (noema-agent-worker--string command "runId"))
                 (worker (gethash run-id noema-agent-worker--runs))
                 ((equal (noema-agent-worker-session-id worker)
                         (noema-agent-worker--string command "sessionId"))))
       (message "Noema completion check: %s" (noema-agent-worker-check-completion worker))))))

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
  ;; Completion may already have arrived but failed to reach the host.
  (noema-agent-worker--best-effort #'noema-agent-worker-check-completion worker)
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
                           (noema-agent-worker--terminal
                            worker "cancelled" "ACP cancellation grace period elapsed; worker stopped" t)))))))

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
    ;; A physical agent buffer is a Session resource.  Run callbacks are not:
    ;; tear down any stale bridge before installing the next sequential Run.
    (noema-agent-worker--cleanup-subscriptions worker)
    (noema-agent-acp-set-permission-responder
     buffer (lambda (permission) (noema-agent-worker--permission-responder worker permission)))
    (cl-labels
        ((subscribe (event callback)
           (push (noema-agent-acp-subscribe
                  :buffer buffer :event event :callback callback)
                 (noema-agent-worker-subscriptions worker))))
      (subscribe
       'agent-message-chunk
       (lambda (event)
         (noema-agent-worker--queue-segment
          worker (or (map-elt (map-elt event :data) :text-chunk) ""))))
      (subscribe
       'tool-call-update
       (lambda (event)
         (when (and (noema-agent-worker-started worker)
                    (not (noema-agent-worker-terminal worker)))
           (noema-agent-worker--ledger-action worker (or (map-elt event :data) '()))
           (noema-agent-worker--report
            worker (list `((type . "run.action.updated")
                           (payload . ,(or (map-elt event :data) '()))))))))
      (subscribe
       'turn-complete
       (lambda (event)
	 (noema-agent-worker--check-context-pressure worker event)
         (let ((reason (format "%s" (or (map-elt (map-elt event :data) :stop-reason) ""))))
           (noema-agent-worker--terminal
            worker (if (equal reason "cancelled") "cancelled" "completed") reason))))
      (subscribe
       'error
       (lambda (event)
         (when (noema-agent-worker-started worker)
           (noema-agent-worker--terminal
            worker "failed"
            (format "%s" (or (map-elt (map-elt event :data) :message) "ACP error")))))))
    (let ((hook (lambda ()
                  (when (noema-agent-worker-started worker)
                    (noema-agent-worker--terminal
                     worker "interrupted" "agent-shell buffer closed")))))
      (setf (noema-agent-worker-kill-hook worker) hook)
      (with-current-buffer buffer
        (add-hook 'kill-buffer-hook hook nil t)))))

(defun noema-agent-worker--context-text (item)
  "Return the text of frozen context ITEM as a multibyte string.
`base64-decode-string' yields raw UTF-8 bytes; a unibyte string holding
non-ASCII bytes (a Chinese title, say) is not a JSON value, so the ACP
request would fail to serialize."
  (decode-coding-string
   (base64-decode-string (noema-agent-worker--string item "contentBase64"))
   'utf-8))

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
                   (let ((text (noema-agent-worker--context-text item)))
                     `((type . "resource")
                       (resource . ((uri . ,(noema-agent-worker--string item "resolvedUri"))
                                    (text . ,text)
                                    (mimeType . ,(noema-agent-worker--string item "mediaType" "text/plain; charset=utf-8")))))))
                 items))
      (let ((fallback prompt))
        (dolist (item items)
          (setq fallback (concat fallback "\n\n[Noema context: "
                                 (noema-agent-worker--string item "ref") "]\n"
                                 (noema-agent-worker--context-text item))))
        (list `((type . "text") (text . ,fallback)))))))

(defun noema-agent-worker--capability (worker name &optional default)
  "Return normalized RunSpec capability NAME for WORKER."
  (let ((capabilities (noema-agent-worker--value (noema-agent-worker-spec worker) "capabilities")))
    (downcase (format "%s" (noema-agent-worker--value capabilities name (or default ""))))))

(defun noema-agent-worker--requires-l1-p (worker)
  "Return non-nil if WORKER's frozen capability envelope needs native L1.
A denied project capability needs the adapter's restrictive mode.  Network,
writes outside the project and credentials are enforced by the kernel broker
on every permission request, so they need L1 only when the adapter cannot
answer permission requests."
  (cl-flet ((denied (name) (equal (noema-agent-worker--capability worker name) "deny")))
    (or (seq-some #'denied '("read_project" "write_project" "execute"))
        (and (not (noema-agent-worker--permission-resolve-p worker))
             (seq-some #'denied '("network" "write_outside_project" "credentials"))))))

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
   :run-id (noema-agent-worker-run-id worker)
   :content (noema-agent-worker--content-blocks worker)
   :on-success (lambda (response)
                 (let ((reason (format "%s" (or (map-elt response 'stopReason) ""))))
                   (noema-agent-worker--terminal worker
                                                 (if (equal reason "cancelled") "cancelled" "completed")
                                                 reason)))
   :on-failure (lambda (_error raw)
                 (noema-agent-worker--terminal worker "failed" (format "%s" raw)))))

(defun noema-agent-worker--cancelled-before-start-p (error-object)
  "Return non-nil when ERROR-OBJECT says the Run was cancelled before it started."
  (string-match-p "cancelled before it started"
                  (format "%s" (or (noema-agent-worker--error error-object) ""))))

(defun noema-agent-worker--finish-cancelled-before-start (worker)
  "Finish WORKER locally: its Run was cancelled before any ACP prompt was sent.
The kernel already recorded the cancellation, so this is not a failure."
  (unless (noema-agent-worker-terminal worker)
    (setf (noema-agent-worker-terminal worker) t)
    (noema-agent-worker--cleanup-subscriptions worker)
    (noema-agent-worker--stop-renewal worker)
    (remhash (noema-agent-worker-run-id worker) noema-agent-worker--runs)
    (force-mode-line-update t)
    (noema-agent-worker--resync-source-buffer worker)
    (noema-agent-worker--finish-queue worker 'cancelled)))

(defun noema-agent-worker--start-run (worker)
  "Tell the kernel physical execution is starting, then prompt the ACP agent."
  (noema-agent-worker--api
   "aaronnote:api:research:worker:start"
   (noema-agent-worker--worker-body worker)
   (lambda (_result error-object)
     (if error-object
         (if (noema-agent-worker--cancelled-before-start-p error-object)
             (noema-agent-worker--finish-cancelled-before-start worker)
           (noema-agent-worker--fail-prepared
            worker (format "worker start failed: %s" (noema-agent-worker--error error-object))))
       (setf (noema-agent-worker-started worker) t)
       (setf (noema-agent-worker-queue-state worker) 'running)
       (noema-agent-worker--ledger-start worker)
       (noema-agent-worker--start-renewal worker)
       (noema-agent-worker--best-effort #'noema-agent-worker--refresh-run-views worker)
       (if (noema-agent-worker-preflight-failure worker)
           (noema-agent-worker--terminal worker "failed" (noema-agent-worker-preflight-failure worker))
         (condition-case err
             (noema-agent-worker--send-prompt worker)
           (error (noema-agent-worker--terminal worker "failed" (error-message-string err)))))))))

(defun noema-agent-worker--attach-and-start (worker)
  "Attach a pre-dispatch fresh Run to WORKER's new logical Session if needed."
  (if (string-empty-p (or (noema-agent-worker--string (noema-agent-worker-routing worker) "sessionId") ""))
      (noema-agent-worker--api
       "aaronnote:api:research:worker:attach"
       (noema-agent-worker--worker-body worker)
       (lambda (_result error-object)
         (if error-object
             (if (noema-agent-worker--cancelled-before-start-p error-object)
                 (noema-agent-worker--finish-cancelled-before-start worker)
               (noema-agent-worker--fail-prepared
                worker (format "session attachment failed: %s" (noema-agent-worker--error error-object))))
	   (noema-agent-acp-mark-session-buffer
	    (noema-agent-worker-buffer worker)
	    (noema-agent-worker--session-name worker)
	    (noema-agent-worker-agent worker)
	    (noema-agent-worker-root worker))
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
     (let* ((name (noema-agent-worker--string server "name" "noema"))
            (type (noema-agent-worker--string server "type"))
            (http-p (member type '("http" "sse"))))
       (if http-p
           `((name . ,name)
             (type . ,type)
             (url . ,(noema-agent-worker--string server "url"))
             (headers . ,(or (noema-agent-worker--value server "headers") [])))
         `((name . ,name)
           (command . ,(noema-agent-worker--string server "command"))
           (args . ,(or (noema-agent-worker--value server "args") []))
           (env . ,(or (noema-agent-worker--value server "env") []))))))
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
                     (bound-and-true-p noema-agent-acp-session-name)
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
    ;; Physical Session state stays isolated, while all Sessions of the
    ;; repository are exposed as tabs in its one Agent workspace.
	(noema-agent-acp-mark-session-buffer
	 buffer (unless fresh (noema-agent-worker--session-name worker))
	 (noema-agent-worker-agent worker) (noema-agent-worker-root worker))
    ;; A resumed buffer serves an existing logical Session.  Bind its id now,
    ;; as promotion does for a fresh one, so the next Run of that Session
    ;; reuses this live buffer instead of resuming a second, retiring copy.
    (unless (or fresh (string-empty-p (or (noema-agent-worker-session-id worker) "")))
      (with-current-buffer buffer
        (setq-local noema-agent-promote--session-id
                    (noema-agent-worker-session-id worker))))
    (let (subscription)
      (setq subscription
            (noema-agent-acp-subscribe
             ;; init-session precedes the upstream default model/mode RPCs.
             ;; Starting a prompt there races configuration and prompt cleanup.
             :buffer buffer :event 'init-finished
             :callback
             (lambda (_event)
               (ignore-errors
                 (noema-agent-acp-unsubscribe
                  :buffer buffer :subscription subscription))
               (setf (noema-agent-worker-subscriptions worker)
                     (delq subscription (noema-agent-worker-subscriptions worker)))
               (noema-agent-worker--on-session-ready worker fresh))))
      (push subscription (noema-agent-worker-subscriptions worker)))))

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
          (noema-agent-acp-touch buffer)
          (setf (noema-agent-worker-buffer worker) buffer
                (noema-agent-worker-session-id worker) logical)
          (noema-agent-acp-mark-session-buffer
           buffer (noema-agent-worker--session-name worker) (noema-agent-worker-agent worker)
           (noema-agent-worker-root worker))
          (noema-agent-worker--on-session-ready worker nil))
      (progn
        (setf (noema-agent-worker-session-id worker) logical)
        (noema-agent-worker--start-shell worker native fork-native)))))

(defun noema-agent-worker--accept-prepared (target result error-object &optional submission)
  "Dispatch a frozen RESULT rooted at TARGET, or report ERROR-OBJECT.
When SUBMISSION is non-nil, fill and dispatch that pre-freeze queue token."
  (if error-object
      (if (and submission (noema-agent-worker--busy-error-p error-object))
          ;; The named session is serving another Run: wait, never fork.
          (noema-agent-worker--wait-for-session submission)
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
            (noema-agent-worker-result-bytes worker) 0
            (noema-agent-worker-result-truncated worker) nil
            (noema-agent-worker-subscriptions worker) nil
            (noema-agent-worker-kill-hook worker) nil
            (noema-agent-worker-pending-permissions worker) nil
            (noema-agent-worker-pending-inputs worker) nil)
      (puthash (noema-agent-worker-run-id worker) worker noema-agent-worker--runs)
      (force-mode-line-update t)
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
             (runId . ,(noema-agent-worker-run-id worker))
             (sessionId . ,(or (noema-agent-worker-session-id worker) ""))
             (sessionName . ,(or (noema-agent-worker--session-name worker) ""))
             (agent . ,(or (noema-agent-worker-agent worker) ""))) nil)))
      (noema-agent-worker--ledger-init worker)
      (condition-case error-object
          (noema-agent-worker--dispatch worker)
        (error
         (noema-agent-worker--fail-prepared
          worker (format "ACP dispatch failed: %s" (error-message-string error-object))))))))

(defun noema-agent-worker--session-name (worker)
  "Return the D-031 session name WORKER's Run was routed to, or nil."
  (let ((intent (noema-agent-worker--value (noema-agent-worker-routing worker) "sessionName"))
        (session (noema-agent-worker--value (noema-agent-worker-spec worker) "session")))
    (or (noema-agent-worker--string intent "name")
        (noema-agent-worker--string session "name"))))

(defun noema-agent-worker--busy-error-p (error-object)
  "Return non-nil when ERROR-OBJECT says the named session has an open Run."
  (or (equal (noema-agent-worker--string error-object "code") "ERR_RESEARCH_SESSION_BUSY")
      (string-match-p "is busy with another Run" (noema-agent-worker--error error-object))))

(defun noema-agent-worker--wait-for-session (worker)
  "Put WORKER back in the queue until its busy session is free."
  (magent-runtime-queue-arbiter-finish 'noema worker)
  (setf (noema-agent-worker-queue-state worker) 'queued)
  (cl-pushnew worker noema-agent-worker--busy-waiting)
  (unless (timerp (noema-agent-worker-cleanup-timer worker))
    (setf (noema-agent-worker-cleanup-timer worker)
          (run-at-time noema-agent-worker-busy-retry-seconds nil
                       #'noema-agent-worker--retry-waiting worker))))

(defun noema-agent-worker--retry-waiting (worker)
  "Try again to prepare WORKER, which was waiting on a busy session."
  (setq noema-agent-worker--busy-waiting (delq worker noema-agent-worker--busy-waiting))
  (when (timerp (noema-agent-worker-cleanup-timer worker))
    (cancel-timer (noema-agent-worker-cleanup-timer worker)))
  (setf (noema-agent-worker-cleanup-timer worker) nil)
  (noema-agent-worker--begin-preparation worker))

(defun noema-agent-worker--wake-waiting ()
  "Retry every Run waiting on a busy session shortly after a Run ends."
  (dolist (worker noema-agent-worker--busy-waiting)
    (run-at-time 0.5 nil #'noema-agent-worker--retry-waiting worker)))

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
      (progn
             (magent-runtime-queue-arbitrate
              'noema worker id
              (lambda ()
                (setf (noema-agent-worker-queue-state worker) 'preparing)
                (noema-agent-worker--api
                 "aaronnote:api:research:run:prepare"
                 (noema-agent-worker-prepare-body worker)
                 (lambda (result error-object)
                   (if (eq (noema-agent-worker-queue-state worker) 'cancelling)
                       ;; Cancelled while its RunSpec was being frozen.
                       (noema-agent-worker--abandon-cancelled-preparation
                        worker (and (not error-object) result))
                     (noema-agent-worker--accept-prepared
                      target result error-object worker)))))
              (lambda (error-object)
                (setf (noema-agent-worker-queue-state worker) 'failed)
                (remhash id noema-agent-worker--submissions)
                (message "Noema queued Run could not start: %s"
                         (error-message-string error-object)))
              (lambda ()
                (memq (noema-agent-worker-queue-state worker)
                      '(queued preparing running))))
        ;; D-034: queue position is not echoed; the mode line counts Runs.
        nil))))

(defun noema-agent-worker--enqueue-preparation (target body)
  "Queue BODY for RunSpec freezing and dispatch at project TARGET."
  (let* ((id (noema-agent-worker--new-submission-id))
         (worker (noema-agent-worker--create
                  :submission-id id :prepare-body body :target target
                  :root target :queue-state 'queued)))
    (puthash id worker noema-agent-worker--submissions)
    (if (fboundp 'my/noema--ensure-server)
        (my/noema--ensure-server
         (lambda () (noema-agent-worker--begin-preparation worker)))
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
    (setq noema-agent-worker--busy-waiting (delq worker noema-agent-worker--busy-waiting))
    (when (timerp (noema-agent-worker-cleanup-timer worker))
      (cancel-timer (noema-agent-worker-cleanup-timer worker)))
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
(defun noema-agent-worker-run-work-cell (file cell-id &optional session-policy parent-session-id session-name)
  "Prepare and execute work CELL-ID in research notebook FILE.
SESSION-POLICY is a D-031 `@@session' value (continue, fork, fresh, a name
or parent:child); PARENT-SESSION-ID is the legacy explicit fork parent.
SESSION-NAME is a coordinator-requested name, used only when the block has
no `@@session' of its own.  Absent both, Noema derives the session from the
work DAG.  No ACP prompt is sent until its frozen RunSpec is stored."
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
       ,@(when (and session-name (not (string-empty-p session-name)))
           `((sessionName . ,session-name)))
       ,@(when (and session-policy (not (string-empty-p session-policy)))
           `((sessionPolicy . ,session-policy)))
       ,@(when (and parent-session-id (not (string-empty-p parent-session-id)))
           `((parentSessionId . ,parent-session-id)))))))

;;; Cancelling a work cell

(defun noema-agent-worker--run-cell-p (worker file cell-id)
  "Return non-nil when WORKER's Run executes work CELL-ID of FILE."
  (when-let* ((source (noema-agent-worker--value (noema-agent-worker-spec worker) "source"))
              (relative (noema-agent-worker--string source "file"))
              (root (noema-agent-worker-root worker)))
    (and (equal (noema-agent-worker--string source "cell_id") cell-id)
         (equal (expand-file-name relative root) file))))

(defun noema-agent-worker--submission-cell-p (worker file cell-id)
  "Return non-nil when queued WORKER was submitted for CELL-ID of FILE."
  (let ((body (noema-agent-worker-prepare-body worker)))
    (and (equal (noema-agent-worker--string body "cellId") cell-id)
         (equal (expand-file-name (or (noema-agent-worker--string body "file") "")) file))))

(defun noema-agent-worker--abandon-cancelled-preparation (worker result)
  "Finish WORKER, cancelled while preparing, without dispatching RESULT's Run.
When RESULT froze a Run, record its cancellation so the document shows it."
  (when-let* ((run-id (noema-agent-worker--string (noema-agent-worker--value result "run") "id")))
    (noema-agent-worker--api
     "aaronnote:api:research:run:cancel"
     `((root . ,(or (noema-agent-worker--string result "root") (noema-agent-worker-root worker)))
       (runId . ,run-id) (requestedBy . "emacs"))
     (lambda (_result error-object)
       (when error-object
         (message "Noema could not record the cancellation of %s: %s"
                  run-id (noema-agent-worker--error error-object))))))
  (noema-agent-worker--finish-queue worker 'cancelled))

;;;###autoload
(defun noema-agent-worker-cancel-cell (file cell-id)
  "Cancel the Noema execution of work CELL-ID in FILE, wherever it is.
A running Run is cancelled over ACP; a queued execution is dropped; one
whose RunSpec is being frozen is cancelled as soon as it exists.  Return
`run', `queued', `preparing', or nil when the cell has no execution."
  (let ((file (expand-file-name file)))
    (if-let* ((worker (seq-find (lambda (worker)
                                  (and (not (noema-agent-worker-terminal worker))
                                       (noema-agent-worker--run-cell-p worker file cell-id)))
                                (hash-table-values noema-agent-worker--runs))))
        (progn (noema-agent-worker--cancel worker) 'run)
      (when-let* ((worker (seq-find (lambda (worker)
                                      (noema-agent-worker--submission-cell-p worker file cell-id))
                                    (hash-table-values noema-agent-worker--submissions))))
        (pcase (noema-agent-worker-queue-state worker)
          ('queued
           (noema-agent-worker-cancel-queued (noema-agent-worker-submission-id worker))
           'queued)
          ('preparing
           (setf (noema-agent-worker-queue-state worker) 'cancelling)
           'preparing))))))

(defun noema-agent-worker-buffer-busy-p (buffer)
  "Return non-nil when a non-terminal Noema Run is using agent BUFFER."
  (seq-some (lambda (worker)
              (and (eq (noema-agent-worker-buffer worker) buffer)
                   (not (noema-agent-worker-terminal worker))))
            (hash-table-values noema-agent-worker--runs)))

(defun noema-agent-worker-cancel-buffer (buffer)
  "Cancel every active Noema Run using agent BUFFER."
  (dolist (worker (hash-table-values noema-agent-worker--runs))
    (when (and (eq (noema-agent-worker-buffer worker) buffer)
               (not (noema-agent-worker-terminal worker)))
      (noema-agent-worker--cancel worker))))

(defun noema-agent-worker-stop-buffer (buffer)
  "Stop agent BUFFER's process and kill it, unless a Run is using it.
Return non-nil when BUFFER was stopped.  Its session name and native id stay
in the registry, so the next Run or visit resumes the conversation (D-035)."
  (when (and (noema-agent-acp-agent-buffer-p buffer)
             (not (noema-agent-worker-buffer-busy-p buffer)))
    (ignore-errors (noema-agent-acp-shutdown buffer))
    (when (buffer-live-p buffer)
      (let ((kill-buffer-query-functions nil))
        (kill-buffer buffer)))
    t))

(defun noema-agent-worker--resumable-buffer-p (buffer)
  "Return non-nil when BUFFER has a native Session that can be reopened."
  (and (noema-agent-acp-agent-buffer-p buffer)
       (stringp (noema-agent-acp-state-value buffer '(:session :id)))
       (not (string-empty-p (noema-agent-acp-state-value buffer '(:session :id) "")))
       (or (noema-agent-acp-state-value buffer '(:supports-session-load))
           (noema-agent-acp-state-value buffer '(:supports-session-resume)))))

(defun noema-agent-worker-sweep-warm-buffers ()
  "Hibernate idle or excess resumable Noema Session buffers.

Only idle buffers with a verified native resume capability are stopped."
  (interactive)
  (let ((by-root (make-hash-table :test #'equal))
        (now (float-time)))
    (dolist (buffer (buffer-list))
      (when (and (noema-agent-worker--resumable-buffer-p buffer)
                 (not (noema-agent-worker-buffer-busy-p buffer)))
        (let ((root (buffer-local-value 'noema-agent-acp-session-root buffer)))
          (push buffer (gethash root by-root)))))
    (maphash
     (lambda (_root buffers)
       (let ((ordered
              (sort buffers
                    (lambda (left right)
                      (> (or (buffer-local-value 'noema-agent-acp-last-used-at left) 0)
                         (or (buffer-local-value 'noema-agent-acp-last-used-at right) 0))))))
         (cl-loop for buffer in ordered
                  for index from 0
                  for last-used = (or (buffer-local-value
                                       'noema-agent-acp-last-used-at buffer) 0)
                  when (or (>= index (max 0 noema-agent-worker-warm-buffer-limit))
                           (> (- now last-used) noema-agent-worker-warm-idle-seconds))
                  do (noema-agent-worker-stop-buffer buffer))))
     by-root)))

(unless (timerp noema-agent-worker--warm-sweep-timer)
  (setq noema-agent-worker--warm-sweep-timer
        (run-at-time 300 300 #'noema-agent-worker-sweep-warm-buffers)))

(defun noema-agent-worker--session-worker (payload)
  "Return the active worker that coordinator PAYLOAD names, or nil."
  (let ((run-id (noema-agent-worker--string payload "runId"))
        (session-id (noema-agent-worker--string payload "sessionId"))
        (name (noema-agent-worker--string payload "name")))
    ;; A supplied Run id is exact authority.  Never let a stale Run command
    ;; fall through to a newer worker merely because the Session name matches.
    (cond
     (run-id (gethash run-id noema-agent-worker--runs))
     (session-id
      (seq-find (lambda (worker)
                  (and (not (noema-agent-worker-terminal worker))
                       (equal session-id (noema-agent-worker-session-id worker))))
                (hash-table-values noema-agent-worker--runs)))
     (name
      (seq-find (lambda (worker)
                  (and (not (noema-agent-worker-terminal worker))
                       (equal name (noema-agent-worker--session-name worker))))
                (hash-table-values noema-agent-worker--runs))))))

(defun noema-agent-worker-open-session (payload)
  "Show the reusable agent buffer identified by browser PAYLOAD.

An exact active Run wins.  Otherwise resolve the logical Session id or its
project-scoped name without starting a second physical agent session."
  (let* ((root (noema-agent-worker--string payload "root"))
         (name (noema-agent-worker--string payload "name"))
         (session-id (noema-agent-worker--string payload "sessionId"))
         (worker (noema-agent-worker--session-worker payload))
         (buffer (or (and worker (noema-agent-worker-buffer worker))
                     (and session-id (noema-agent-worker--existing-buffer session-id))
                     (and name (noema-agent-acp-session-buffer name root)))))
    (if (buffer-live-p buffer)
        (noema-agent-acp-show-buffer buffer)
      (require 'noema-sessions)
      (noema-sessions-open-reference root name session-id))))

;;;###autoload
(defun noema-agent-worker-compact-session (&optional buffer)
  "Request checkpoint rollover for the logical Session served by BUFFER.

The current conversation remains interactive and unchanged.  Its next Run
creates a new physical generation with the same project-scoped name and the
latest durable handoff as explicit context."
  (interactive)
  (let* ((candidates
	  (seq-filter
	   (lambda (candidate)
	     (and (noema-agent-acp-agent-buffer-p candidate)
		  (buffer-local-value 'noema-agent-acp-session-name candidate)
		  (buffer-local-value 'noema-agent-promote--session-id candidate)))
	   (buffer-list)))
	 (buffer
	  (or buffer
	      (and (memq (current-buffer) candidates) (current-buffer))
	      (let* ((names (mapcar #'buffer-name candidates))
		     (selected (and names (completing-read "Compact Noema Session: " names nil t))))
		(and selected (get-buffer selected))))))
    (unless (buffer-live-p buffer)
      (user-error "No resumable Noema Session buffer"))
    (let ((root (buffer-local-value 'noema-agent-acp-session-root buffer))
	  (session-id (buffer-local-value 'noema-agent-promote--session-id buffer)))
      (noema-agent-worker--api
	"aaronnote:api:research:session:compact"
	`((cwd . ,root) (sessionId . ,session-id))
	(lambda (result error-object)
	  (if error-object
	      (message "Noema Session compaction request failed: %s"
		       (noema-agent-worker--error error-object))
	    (with-current-buffer buffer
	      (setq-local noema-agent-acp-context-warning-level 2))
	    (message "Noema Session rollover queued for its next Run (%s)"
		     (or (noema-agent-worker--string
			  (noema-agent-worker--value result "compaction") "id")
			 "checkpoint"))))))))

;;;###autoload
(defun noema-agent-worker-maintain-cache (&optional root)
  "Run conservative cache maintenance for Noema project ROOT.

Registered artifacts and durable session state are never deleted."
  (interactive)
  (let ((root (or root
		  (locate-dominating-file default-directory "noema.toml")
		  (user-error "No containing Noema project"))))
    (noema-agent-worker--api
     "aaronnote:api:research:cache:maintain"
     `((cwd . ,root))
     (lambda (result error-object)
       (if error-object
	   (message "Noema cache maintenance failed: %s"
		    (noema-agent-worker--error error-object))
	 (let* ((cache (noema-agent-worker--value result "cache"))
		(removed (or (noema-agent-worker--value cache "removedBytes") 0))
		(total (or (noema-agent-worker--value cache "totalBytes") 0)))
	   (message "Noema cache: removed %.1f MiB; %.1f MiB remain%s"
		    (/ removed 1048576.0) (/ total 1048576.0)
		    (if (noema-agent-worker--true-p
			 (noema-agent-worker--value cache "pressure"))
				" (durable data retained above threshold)" ""))))))))

(defun noema-agent-worker--claim-close (root payload)
  "Stop the idle agent process of the session coordinator PAYLOAD names in ROOT."
  (let* ((name (noema-agent-worker--string payload "name"))
         (session-id (noema-agent-worker--string payload "sessionId"))
         (buffer (or (and name (noema-agent-acp-session-buffer name root))
                     (and session-id (noema-agent-worker--existing-buffer session-id)))))
    (when (and buffer (not (noema-agent-worker-stop-buffer buffer)))
      (display-warning 'noema-agent-worker
                       (format "Pi asked to close %s while a Run is using it; it stays open"
                               (or name session-id))
                       :warning))))

(defun noema-agent-worker--ack-coordinator-request (root request state &optional reason)
  "Acknowledge coordinator REQUEST in ROOT with terminal STATE and REASON."
  (noema-agent-worker--api
   "aaronnote:api:research:coordinator:complete"
   `((cwd . ,root)
     (id . ,(noema-agent-worker--string request "id"))
     (owner . ,(format "emacs:%s" (emacs-pid)))
     (state . ,state)
     (reason . ,(or reason "")))
   (lambda (_result error-object)
     (when error-object
       (display-warning
        'noema-agent-worker
        (format "Noema coordinator acknowledgement failed: %s"
                (noema-agent-worker--error error-object))
        :warning)))))

;;;###autoload
(defun noema-agent-worker-claim-coordinator-requests (root)
  "Claim pending Pi manager requests for project ROOT and carry them out.
D-032/D-035: Pi only records requests.  A `run.start' becomes an ordinary
queued Run through the frozen RunSpec, lease and permission path;
`session.cancel' cancels that session's Run over ACP; `session.close' stops
an idle session's agent process and keeps its name and history."
  (interactive (list (expand-file-name default-directory)))
  (noema-agent-worker--api
   "aaronnote:api:research:coordinator:claim"
   `((cwd . ,root) (owner . ,(format "emacs:%s" (emacs-pid))))
   (lambda (result error-object)
     (if error-object
         (display-warning 'noema-agent-worker
                          (format "Noema coordinator requests could not be claimed: %s"
                                  (noema-agent-worker--error error-object))
                          :warning)
       (dolist (request (append (noema-agent-worker--value result "requests") nil))
         (let ((payload (noema-agent-worker--value request "payload")))
           (condition-case request-error
               (progn
                 (pcase (noema-agent-worker--string request "kind")
                   ("run.start"
                    (let ((file (noema-agent-worker--string payload "file"))
                          (cell-id (noema-agent-worker--string payload "cellId")))
                      (unless (and file cell-id)
                        (error "run.start lacks file or cellId"))
                      (let ((default-directory (file-name-as-directory root)))
                        (noema-agent-worker-run-work-cell
                         file cell-id nil nil
                         (noema-agent-worker--string payload "sessionName")))))
                   ("session.cancel"
                    (if-let* ((worker (noema-agent-worker--session-worker payload)))
                        (noema-agent-worker--cancel worker)
                      (error "the requested Session has no Run in this Emacs")))
                   ("session.close"
                    (noema-agent-worker--claim-close root payload)))
                 (noema-agent-worker--ack-coordinator-request root request "done"))
             (error
              (noema-agent-worker--ack-coordinator-request
               root request "failed" (error-message-string request-error))))))))))

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

(defun noema-agent-worker--buffer-worker (buffer)
  "Return the active worker whose Run uses agent BUFFER, or nil."
  (seq-find (lambda (worker)
              (and (eq (noema-agent-worker-buffer worker) buffer)
                   (not (noema-agent-worker-terminal worker))))
            (hash-table-values noema-agent-worker--runs)))

(defun noema-agent-worker--stop-buffer (buffer)
  "Cancel the Noema Run using agent BUFFER; return non-nil when one did."
  (when-let* ((worker (noema-agent-worker--buffer-worker buffer)))
    (noema-agent-worker--cancel worker)
    t))

;; The Agent window asks through these hooks, so the ACP boundary does not
;; depend on the worker.
(add-hook 'noema-agent-acp-busy-functions #'noema-agent-worker--buffer-worker)
(add-hook 'noema-agent-acp-stop-functions #'noema-agent-worker--stop-buffer)

(provide 'noema-agent-worker)
;;; noema-agent-worker.el ends here
