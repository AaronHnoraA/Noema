;;; noema-interaction-engine-cli.el --- Use CLI agents as embedded gptel backends -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Bridges the noema-interaction CLI agents (CC/Claude Code, Codex, OpenCode) into
;; noema-interaction-engine as first-class backends.  noema-interaction-engine is
;; natively HTTP-only; this module defines an `noema-interaction-cli' backend type
;; and a custom transport that drives the tool's headless one-shot exec
;; (`noema-interaction-cli-exec') instead of an HTTP request, then feeds the result
;; back through noema-interaction-engine's normal response pipeline.
;;
;; With this loaded, CC/Codex/OpenCode appear in `gptel--known-backends'
;; alongside any other registered backends, so they can be selected from the
;; noema-interaction Hub and used directly from any noema-interaction-engine buffer.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'noema-upstream)
(require 'gptel)
(require 'gptel-request)
(require 'gptel-openai)
(require 'noema-interaction-cli)
(require 'noema-interaction-answer)
;; Adapters register their tool specs (codex/opencode/claude exec args).
(require 'noema-interaction-adapter-claude)
(require 'noema-interaction-adapter-codex)
(require 'noema-interaction-adapter-opencode)

(declare-function gptel--insert-response "noema-interaction-engine" (response info &optional raw))
(declare-function gptel--process-models  "noema-interaction-request" (models))
(declare-function gptel--fsm-transition  "noema-interaction-request" (machine &optional new-state))
(declare-function gptel-fsm-info         "noema-interaction-request" (fsm))
(declare-function noema-interaction-project-root     "noema-interaction-session" ())
(declare-function noema-interaction-cli-session-live-p "noema-interaction-cli" (id &optional project-root))
(declare-function noema-interaction-cli-buffer          "noema-interaction-cli" (id &optional project-root))
(declare-function noema-interaction-cli-send-prompt     "noema-interaction-cli" (id prompt &optional project-root))
(defvar gptel--known-backends)
(defvar gptel--request-alist)

;; ── Backend type ──────────────────────────────────────────────────────────────
;; Include gptel-openai so the prompt-parsing / request-data machinery
;; (`gptel--parse-buffer', `gptel--request-data', …) is reused;
;; we only override the transport (`gptel--get-response') and read the
;; resulting :messages.
(cl-defstruct (noema-interaction-cli (:constructor noema-interaction--make-cli)
                                (:copier nil)
                                (:include gptel-openai))
  (tool-id nil :documentation "noema-interaction-cli tool id symbol (claude/codex/opencode)."))

(cl-defun noema-interaction-make-cli (name &key tool-id (models '(default)) (stream nil))
  "Register an noema-interaction-engine backend named NAME backed by CLI tool TOOL-ID.
MODELS is a list of model symbols (mostly cosmetic for CLI tools).
STREAM is accepted for interface symmetry but ignored; CLI exec is
one-shot and delivers the whole response at once."
  (let ((backend (noema-interaction--make-cli
                  :name name
                  :host "local"
                  :protocol "cli"
                  :endpoint ""
                  ;; Dummy key prevents the engine from querying auth-source.
                  ;; CLI backends never use HTTP authentication.
                  :key "cli-no-http-auth"
                  :stream stream
                  :models (gptel--process-models models)
                  :url "cli://local"
                  :tool-id tool-id)))
    (prog1 backend
      (setf (alist-get name gptel--known-backends nil nil #'equal) backend))))

;; ── Prompt assembly ───────────────────────────────────────────────────────────

(defun noema-interaction-cli--data->prompt (data)
  "Flatten the noema-interaction-engine request DATA (:messages list) into one text prompt.
System and assistant turns are labeled so the CLI tool has conversation
context; a lone user turn is passed through verbatim."
  (let ((messages (plist-get data :messages))
        (parts nil))
    (dolist (m (append messages nil))
      (let ((role (plist-get m :role))
            (content (plist-get m :content)))
        (when (and (stringp content) (not (string-empty-p content)))
          (push (if (and (stringp role) (not (equal role "user")))
                    (format "[%s]\n%s" role content)
                  content)
                parts))))
    (string-join (nreverse parts) "\n\n")))

(defun noema-interaction-cli--root (info)
  "Return the working directory for the request described by INFO."
  (let ((buf (plist-get info :buffer)))
    (with-current-buffer (if (buffer-live-p buf) buf (current-buffer))
      (or (ignore-errors (noema-interaction-project-root))
          default-directory))))

;; ── Transport ─────────────────────────────────────────────────────────────────

(defun noema-interaction-cli--finish (fsm proc callback result error)
  "Deliver RESULT (or ERROR) for FSM and advance the state machine.
PROC, when a live process, is unregistered from `gptel--request-alist'.
CALLBACK is noema-interaction-engine's response insertion callback."
  (when (processp proc)
    (setf (alist-get proc gptel--request-alist nil 'remove) nil))
  (let ((info (gptel-fsm-info fsm)))
    (if error
        (progn
          (plist-put info :http-status "500")
          (plist-put info :status (if (stringp error) error "error"))
          (plist-put info :error (list :message (format "%s" error))))
      (plist-put info :http-status "200")
      (plist-put info :status "OK"))
    (gptel--fsm-transition fsm)         ;WAIT -> TYPE
    (with-demoted-errors "noema-interaction cli callback error: %S"
      (funcall callback (and (not error) result) info))
    (gptel--fsm-transition fsm)))       ;TYPE -> DONE / ERRS

(defun noema-interaction-cli--extract-answer (raw-output tool-id)
  "Return the answer-block content from RAW-OUTPUT, or RAW-OUTPUT on failure.
Parse failures are logged as warnings; raw output is preserved for debug."
  (let ((result (noema-interaction-parse-answer-block raw-output)))
    (pcase result
      (`(:ok . ,content) content)
      (`(:error . ,_)
       (display-warning
        '(noema-interaction noema-interaction-cli)
        (format "noema-interaction [%s]: no #+begin answer block in CLI output.\nRaw:\n%s"
                tool-id raw-output)
        :warning)
       raw-output))))

;; ── ANSI stripping ─────────────────────────────────────────────────────────────

(defun noema-interaction--strip-ansi (text)
  "Strip ANSI escape sequences from TEXT.
Vterm buffers contain terminal escape codes that interfere with
answer-block regex matching; this makes session-mode parsing reliable."
  (replace-regexp-in-string "\033\\[[0-9;]*[A-Za-z]" "" text))

;; ── Session routing ───────────────────────────────────────────────────────────

(defvar noema-interaction-engine-cli--session-timeout 180
  "Seconds to wait for an answer block from a managed vterm session.")

(defvar noema-interaction-engine-cli--session-idle-cycles 3
  "Consecutive polls with no buffer growth to declare output stable.")

(defun noema-interaction-engine-cli--session-request (tool-id prompt root fsm callback)
  "Pipe PROMPT into the live TOOL-ID vterm session and poll for answer block.
Calls FSM/CALLBACK when the answer block appears or the timeout expires.

Detection strategy (in order):
1. Polling for a `.done` file created by the agent in `var/noema/`.
2. `#+end answer` block in the vterm buffer (primary, with ANSI stripping).
3. Output stability: buffer unchanged for `noema-interaction-engine-cli--session-idle-cycles`
   polls, meaning the agent has likely finished.
4. Hard timeout (`noema-interaction-engine-cli--session-timeout`)."
  (let* ((session-buf (noema-interaction-cli-buffer tool-id root))
         (start-pos (with-current-buffer session-buf (point-max)))
         (timeout noema-interaction-engine-cli--session-timeout)
         (poll-interval 2.0)
         (prev-size 0)
         (idle-count 0)
         (elapsed 0)
         (temp-dir (locate-user-emacs-file "var/noema/"))
         (output-file (make-temp-file (expand-file-name "session-out-" temp-dir) nil ".txt"))
         (done-file (concat output-file ".done"))
         timer)
    (unless (file-exists-p temp-dir)
      (make-directory temp-dir t))
    (ignore-errors (delete-file output-file))
    (ignore-errors (delete-file done-file))

    ;; Inject file-based completion instructions
    (let ((injected-prompt
           (concat prompt
                   (format "\n\n[SYSTEM: When you have finished your response, you MUST write your full final response (including the #+begin answer block) to the file %s and then create an empty file at %s to signal completion. Both files must be written. Do not ask for confirmation.]"
                           (shell-quote-argument output-file)
                           (shell-quote-argument done-file)))))
      (noema-interaction-cli-send-prompt tool-id injected-prompt root))

    (setq timer
          (run-with-timer
           poll-interval poll-interval
           (lambda ()
             (setq elapsed (+ elapsed poll-interval))
             (let (result raw-text)
               ;; 1. Check for the file-based completion signal
               (if (file-exists-p done-file)
                   (progn
                     (when (file-exists-p output-file)
                       (with-temp-buffer
                         (insert-file-contents output-file)
                         (setq raw-text (buffer-string)))
                       (let* ((clean (noema-interaction--strip-ansi raw-text))
                              (parsed (noema-interaction-parse-answer-block clean)))
                         (if (and parsed (eq (car parsed) :ok))
                             (setq result (cdr parsed))
                           (setq result raw-text))))
                     (ignore-errors (delete-file done-file))
                     (ignore-errors (delete-file output-file)))
                 ;; 2. Fallback to scraping the vterm buffer
                 (when (buffer-live-p session-buf)
                   (with-current-buffer session-buf
                     (let* ((end (point-max))
                            (size (- end start-pos))
                            (text (when (> size 0)
                                    (buffer-substring-no-properties start-pos end))))
                       (when text
                         (setq raw-text text)
                         (let ((clean (noema-interaction--strip-ansi text))
                               (parsed (noema-interaction-parse-answer-block clean)))
                           (when (and parsed (eq (car parsed) :ok))
                             (setq result (cdr parsed)))))

                       ;; Stability detection: buffer hasn't grown for N cycles
                       (if (and (> size 0) (= size prev-size))
                           (setq idle-count (1+ idle-count))
                         (setq idle-count 0))
                       (setq prev-size size)

                       ;; Fallback: stable output without answer block
                       (when (and (not result)
                                  (> size 0)
                                  (>= idle-count noema-interaction-engine-cli--session-idle-cycles))
                         (setq result raw-text))))))

               (cond
                (result
                 (cancel-timer timer)
                 (ignore-errors (delete-file done-file))
                 (ignore-errors (delete-file output-file))
                 (noema-interaction-cli--finish fsm nil callback result nil))
                ((>= elapsed timeout)
                 (cancel-timer timer)
                 (ignore-errors (delete-file done-file))
                 (ignore-errors (delete-file output-file))
                 ;; Last-resort: use whatever text we have
                 (if raw-text
                     (noema-interaction-cli--finish fsm nil callback raw-text nil)
                   (noema-interaction-cli--finish
                    fsm nil callback nil
                    (format "Session timeout after %ds - no output seen" timeout)))))))))))

(cl-defmethod gptel--get-response ((backend noema-interaction-cli) fsm)
  "Drive the request in FSM through BACKEND.
When a vterm session is live for this backend's tool-id, pipe the
prompt into it and poll the buffer for an answer block (session mode).
Otherwise fall back to a headless one-shot exec."
  (let* ((info (gptel-fsm-info fsm))
         (tool-id (noema-interaction-cli-tool-id backend))
         (raw-prompt (noema-interaction-cli--data->prompt (plist-get info :data)))
         (prompt (noema-interaction-wrap-prompt-with-output-contract raw-prompt))
         (callback (or (plist-get info :callback) #'gptel--insert-response))
         (root (noema-interaction-cli--root info)))
    (plist-put info :callback callback)
    (if (noema-interaction-cli-session-live-p tool-id root)
        ;; SESSION mode: reuse the running vterm, extract answer from buffer.
        (condition-case err
            (noema-interaction-engine-cli--session-request tool-id prompt root fsm callback)
          (error
           (noema-interaction-cli--finish fsm nil callback nil (error-message-string err))))
      ;; ONE-SHOT mode: headless subprocess, no interactive session needed.
      (let (proc)
        (condition-case err
            (setq proc
                  (noema-interaction-cli-exec
                   tool-id prompt
                   :root root
                   :callback
                   (lambda (result)
                     (noema-interaction-cli--finish
                      fsm proc callback
                      (noema-interaction-cli--extract-answer result tool-id)
                      nil))
                   :on-error
                   (lambda (event details)
                     (noema-interaction-cli--finish fsm proc callback nil
                                               (if (and details (not (string-empty-p details)))
                                                   details event)))))
          (error
           (noema-interaction-cli--finish fsm nil callback nil (error-message-string err))))
        (when (processp proc)
          (setf (alist-get proc gptel--request-alist)
                (cons fsm
                      (lambda ()
                        (plist-put info :callback #'ignore)
                        (when (process-live-p proc) (delete-process proc))))))))))

;; ── Registration ──────────────────────────────────────────────────────────────

(defconst noema-interaction-engine-cli-backends
  '(("CC – Claude Code (CLI)" . claude)
    ("Codex (CLI)"            . codex)
    ("OpenCode (CLI)"         . opencode))
  "Alist of noema-interaction-engine backend display name → noema-interaction-cli tool id.")

(defun noema-interaction-engine-cli-register ()
  "Register CLI agents as noema-interaction-engine backends and set CC as the default.
This replaces the built-in default (OpenAI HTTP) so that no API key
is needed and all requests go through CLI exec."
  (dolist (entry noema-interaction-engine-cli-backends)
    (noema-interaction-make-cli (car entry)
      :tool-id (cdr entry)
      :models (list (intern (format "%s-cli" (cdr entry))))))
  ;; Default to CC, then restore the last-selected backend from var/ if any.
  (when-let* ((cc (alist-get "CC – Claude Code (CLI)"
                             gptel--known-backends nil nil #'equal)))
    (setq-default noema-interaction-backend cc)
    (when-let* ((models (gptel-backend-models cc))
                (first  (car models)))
      (setq-default noema-interaction-model first)))
  (noema-interaction-engine-cli-restore-backend))

(defun noema-interaction-engine-cli-backend-p (name)
  "Return non-nil when the noema-interaction-engine backend named NAME is a CLI bridge backend."
  (let ((backend (alist-get name gptel--known-backends nil nil #'equal)))
    (and backend (noema-interaction-cli-p backend))))

;; ── Backend persistence ───────────────────────────────────────────────────────

(defconst noema-interaction-engine-cli--state-file
  (locate-user-emacs-file "var/noema/engine-backend.eld")
  "File persisting the last selected CLI engine backend tool-id.")

(defun noema-interaction-engine-cli--save-backend (tool-id)
  "Write TOOL-ID to the persistence file."
  (let ((dir (file-name-directory noema-interaction-engine-cli--state-file)))
    (unless (file-exists-p dir) (make-directory dir t)))
  (with-temp-file noema-interaction-engine-cli--state-file
    (prin1 tool-id (current-buffer))))

(defun noema-interaction-engine-cli--load-backend ()
  "Return the persisted tool-id, or nil."
  (when (file-exists-p noema-interaction-engine-cli--state-file)
    (ignore-errors
      (with-temp-buffer
        (insert-file-contents noema-interaction-engine-cli--state-file)
        (read (current-buffer))))))

(defun noema-interaction-engine-cli-activate-backend (tool-id)
  "Set `noema-interaction-backend' to the CLI backend for TOOL-ID and persist.
TOOL-ID is one of: claude, codex, opencode.
Also sets `noema-interaction-default-backend' so the Hub and new sessions
reflect the selection immediately."
  (let ((entry (cl-find tool-id noema-interaction-engine-cli-backends :key #'cdr)))
    (when-let* ((name (car entry))
                (backend (alist-get name gptel--known-backends nil nil #'equal)))
      (setq-default noema-interaction-backend backend)
      (when-let* ((models (gptel-backend-models backend))
                  (first  (car models)))
        (setq-default noema-interaction-model first))
      ;; Sync the session layer default so Hub shows the right ●active marker.
      (when (boundp 'noema-interaction-default-backend)
        (setq noema-interaction-default-backend tool-id))
      (noema-interaction-engine-cli--save-backend tool-id)
      backend)))

(defun noema-interaction-engine-cli-restore-backend ()
  "Restore the last-persisted CLI backend, or keep CC as default."
  (when-let* ((tool-id (noema-interaction-engine-cli--load-backend)))
    (noema-interaction-engine-cli-activate-backend tool-id)))

(provide 'noema-interaction-engine-cli)
;;; noema-interaction-engine-cli.el ends here
