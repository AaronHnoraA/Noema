;;; noema-interaction-cli.el --- Shared CLI-session core for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Unified CLI-session core for noema-interaction terminal backends.
;; Provides parametric terminal session management (interactive vterm/eat)
;; and headless exec (one-shot process) for CLI AI tools.
;;
;; Tools are registered via `noema-interaction-cli-register-tool'.
;; Adapters (codex, opencode, etc.) register their spec here and expose
;; thin public wrappers that delegate to the generic functions.
;;
;; Session principle:
;;   Interactive vterm sessions: CLI keeps its own session (process + buffer).
;;   Headless exec path: one-shot process, no persistent session needed.

;;; Code:

(require 'cl-lib)
(require 'project)
(require 'subr-x)
(require 'noema-interaction-session)
(require 'noema-interaction-profile)
(require 'noema-interaction-backend)

(defvar my/terminal-startup-cd-inhibited)
(defvar my/vterm-popup-kind nil)
(defvar my/vterm-popup-title nil)
(defvar vterm-shell)
(defvar vterm-environment)
(defvar eat-terminal)
(defvar eat-term-name)

(declare-function my/vterm-popup-display-buffer "init-vterm-popup" (buffer))
(declare-function turn-off-evil-mode "evil" ())
(declare-function evil-emacs-state "evil" ())
(declare-function vterm "vterm" (&optional arg))
(declare-function vterm-send-string "vterm" (string &optional paste-p))
(declare-function vterm-send-return "vterm" ())
(declare-function eat-mode "eat" ())
(declare-function eat-exec "eat" (buffer name command startfile &rest switches))
(declare-function eat-term-send-string "eat" (terminal string))

;; ── Tool registry ─────────────────────────────────────────────────────────────

(defvar noema-interaction-cli--tools nil
  "Alist mapping tool-id symbols to their spec plists.
Each entry is (ID . SPEC) where SPEC is a plist with:
  :name                Display name string
  :executable-var      Symbol of defcustom holding the executable path
  :extra-args-var      Symbol of defcustom holding extra arg list (or nil)
  :terminal-backend-var Symbol of defcustom holding terminal backend (vterm/eat)
  :env-vars            List of environment variable strings for the session
  :buffer-prefix       String prefix for buffer names (e.g. \"codex\")
  :popup-kind          Symbol for the vterm popup kind
  :minor-mode          Minor mode function symbol to activate in terminal buffers
  :exec-args-fn        Function (prompt output-file root) → command string list
  :exec-output         Symbol: \\='file or \\='stdout")

(defun noema-interaction-cli-register-tool (id &rest spec)
  "Register a CLI tool with ID and SPEC plist.
See `noema-interaction-cli--tools' for the expected plist keys."
  (setf (alist-get id noema-interaction-cli--tools) spec)
  (noema-interaction-register-backend
   id
   :label (or (plist-get spec :name) (symbol-name id))
   :generation (gensym (format "%s-" id))
   :capabilities '(:session :send :draft :stop :cancel :headless)
   :authority '(:kind host-cli :sandboxed nil)
   :operations
   (list
    :available-p (lambda () (noema-interaction-cli-available-p id))
    :live-p (lambda (root) (noema-interaction-cli-session-live-p id root))
    :ensure (lambda (root) (noema-interaction-cli-ensure-session id root))
    :open (lambda (root) (noema-interaction-cli-open-buffer id root))
    :send (lambda (prompt root on-success on-error)
            (noema-interaction-cli-send-prompt id prompt root on-success on-error))
    :draft (lambda (prompt root on-success on-error)
             (noema-interaction-cli-draft-prompt id prompt root on-success on-error))
    :stop (lambda (root) (noema-interaction-cli-stop id root))
    :cancel (lambda (root)
              (when-let* ((buf (noema-interaction-cli-buffer id root))
                          (proc (get-buffer-process buf)))
                (interrupt-process proc)))))
  id)

(defun noema-interaction-cli--spec (id key)
  "Return the KEY value from the registered spec for tool ID."
  (plist-get (alist-get id noema-interaction-cli--tools) key))

(defun noema-interaction-cli--executable (id)
  "Return the resolved executable path for tool ID."
  (let ((var (noema-interaction-cli--spec id :executable-var)))
    (or (and var (boundp var) (stringp (symbol-value var))
             (not (string-empty-p (symbol-value var)))
             (symbol-value var))
        (symbol-name id))))

(defun noema-interaction-cli--extra-args (id)
  "Return the extra arg list for tool ID, or nil."
  (let ((var (noema-interaction-cli--spec id :extra-args-var)))
    (and var (boundp var) (symbol-value var))))

(defun noema-interaction-cli--terminal-backend (id)
  "Return the terminal backend symbol (vterm or eat) for tool ID."
  (let ((var (noema-interaction-cli--spec id :terminal-backend-var)))
    (or (and var (boundp var) (symbol-value var)) 'vterm)))

;; ── Process registry ──────────────────────────────────────────────────────────

(defvar noema-interaction-cli--processes (make-hash-table :test 'equal)
  "Hash-table mapping (ID . ROOT) cons cells to live process objects.")

(defun noema-interaction-cli--proc-key (id root)
  "Return the hash-table key for tool ID and ROOT."
  (cons id root))

(defun noema-interaction-cli--get-process (id root)
  "Return the tracked process for tool ID and ROOT, or nil."
  (gethash (noema-interaction-cli--proc-key id root) noema-interaction-cli--processes))

(defun noema-interaction-cli--set-process (id root process)
  "Track PROCESS for tool ID and ROOT."
  (puthash (noema-interaction-cli--proc-key id root) process noema-interaction-cli--processes))

(defun noema-interaction-cli--remove-process (id root)
  "Remove process tracking for tool ID and ROOT."
  (remhash (noema-interaction-cli--proc-key id root) noema-interaction-cli--processes))

(defun noema-interaction-cli--cleanup-dead-processes (id)
  "Remove dead process entries for tool ID from the registry."
  (maphash
   (lambda (key process)
     (when (and (equal (car key) id)
                (not (process-live-p process)))
       (remhash key noema-interaction-cli--processes)))
   noema-interaction-cli--processes))

(add-hook 'kill-emacs-hook
          (lambda ()
            (maphash
             (lambda (_key process)
               (when (process-live-p process)
                 (delete-process process)))
             noema-interaction-cli--processes)))

;; ── Working directory ─────────────────────────────────────────────────────────

(defun noema-interaction-cli--working-directory (&optional directory)
  "Return DIRECTORY, or infer the current project root."
  (or directory
      (if-let* ((project (project-current nil default-directory)))
          (expand-file-name (project-root project))
        (expand-file-name default-directory))))

;; ── Buffer names ──────────────────────────────────────────────────────────────

(defun noema-interaction-cli--buffer-name (id root)
  "Return the session buffer name for tool ID and ROOT."
  (let ((prefix (or (noema-interaction-cli--spec id :buffer-prefix) (symbol-name id))))
    (format "*%s[%s]*" prefix (file-name-nondirectory (directory-file-name root)))))

(defun noema-interaction-cli-buffer (id &optional project-root)
  "Return the live session buffer for tool ID and PROJECT-ROOT, or nil."
  (let ((root (noema-interaction-cli--working-directory project-root)))
    (get-buffer (noema-interaction-cli--buffer-name id root))))

;; ── Terminal helpers ──────────────────────────────────────────────────────────

(defun noema-interaction-cli--ensure-terminal-backend (id)
  "Ensure the configured terminal backend for tool ID is available."
  (pcase (noema-interaction-cli--terminal-backend id)
    ('vterm
     (unless (featurep 'vterm) (require 'vterm nil t))
     (unless (featurep 'vterm)
       (user-error "The package vterm is not installed")))
    ('eat
     (unless (featurep 'eat) (require 'eat nil t))
     (unless (featurep 'eat)
       (user-error "The package eat is not installed")))
    (tb (user-error "Unsupported terminal backend for %s: %s" id tb))))

(defun noema-interaction-cli--terminal-paste-string (id string)
  "Send STRING using bracketed paste to the current buffer for tool ID."
  (pcase (noema-interaction-cli--terminal-backend id)
    ('vterm (vterm-send-string string t))
    ('eat
     (when eat-terminal
       (eat-term-send-string eat-terminal "\e[200~")
       (eat-term-send-string eat-terminal string)
       (eat-term-send-string eat-terminal "\e[201~")))
    (tb (error "Unsupported terminal backend for %s: %s" id tb))))

(defun noema-interaction-cli--terminal-send-return (id)
  "Send return to the current buffer for tool ID."
  (pcase (noema-interaction-cli--terminal-backend id)
    ('vterm (vterm-send-return))
    ('eat (when eat-terminal (eat-term-send-string eat-terminal "\r")))
    (tb (error "Unsupported terminal backend for %s: %s" id tb))))

;; ── Buffer configuration ──────────────────────────────────────────────────────

(defun noema-interaction-cli--configure-buffer (id buffer project-root)
  "Apply noema-interaction local UI and session state to BUFFER for tool ID."
  (with-current-buffer buffer
    (setq default-directory project-root)
    (let ((kind (noema-interaction-cli--spec id :popup-kind)))
      (when kind (setq-local my/vterm-popup-kind kind)))
    (setq-local my/vterm-popup-title
                (format "%s  %s"
                        (or (noema-interaction-cli--spec id :name) (symbol-name id))
                        (abbreviate-file-name project-root)))
    (when (fboundp 'evil-emacs-state) (evil-emacs-state))
    (when (bound-and-true-p evil-local-mode) (turn-off-evil-mode))
    (let ((mode (noema-interaction-cli--spec id :minor-mode)))
      (when (and mode (fboundp mode)) (funcall mode 1)))))

;; ── Session creation ──────────────────────────────────────────────────────────

(defun noema-interaction-cli--build-command (id)
  "Return the shell command string used to launch tool ID interactively."
  (string-join
   (cons (shell-quote-argument (noema-interaction-cli--executable id))
         (mapcar #'shell-quote-argument (or (noema-interaction-cli--extra-args id) nil)))
   " "))

(defun noema-interaction-cli--create-terminal-session (id buffer-name project-root)
  "Create a terminal session in BUFFER-NAME for tool ID and PROJECT-ROOT.
Returns a (BUFFER . PROCESS) cons cell."
  (noema-interaction-cli--ensure-terminal-backend id)
  (let* ((command-string (noema-interaction-cli--build-command id))
         (default-directory project-root)
         (env-vars (or (noema-interaction-cli--spec id :env-vars)
                       (list "TERM_PROGRAM=emacs"))))
    (pcase (noema-interaction-cli--terminal-backend id)
      ('vterm
       (let* ((vterm-buffer-name buffer-name)
              (vterm-shell command-string)
              (vterm-environment (append env-vars vterm-environment))
              (buffer (let ((my/terminal-startup-cd-inhibited t))
                        (save-window-excursion
                          (vterm vterm-buffer-name)))))
         (unless buffer (error "Failed to create %s vterm buffer" id))
         (noema-interaction-cli--configure-buffer id buffer project-root)
         (let ((process (get-buffer-process buffer)))
           (unless process (error "Failed to get %s vterm process" id))
           (cons buffer process))))
      ('eat
       (let* ((buffer (get-buffer-create buffer-name))
              (eat-term-name "xterm-256color")
              (parts (split-string-shell-command command-string))
              (program (car parts))
              (args (cdr parts)))
         (with-current-buffer buffer
           (unless (eq major-mode 'eat-mode) (eat-mode))
           (setq-local process-environment (append env-vars process-environment))
           (let ((my/terminal-startup-cd-inhibited t))
             (apply #'eat-exec buffer buffer-name program nil args))
           (noema-interaction-cli--configure-buffer id buffer project-root)
           (let ((process (get-buffer-process buffer)))
             (unless process (error "Failed to create %s eat process" id))
             (cons buffer process)))))
      (tb (error "Unsupported terminal backend for %s: %s" id tb)))))

;; ── Session cleanup ───────────────────────────────────────────────────────────

(defun noema-interaction-cli--cleanup-on-exit (id root)
  "Clean up session state for tool ID and ROOT."
  (noema-interaction-cli--remove-process id root)
  (noema-interaction-session-clear-profile-injected id root)
  (let ((buffer (get-buffer (noema-interaction-cli--buffer-name id root))))
    (when (buffer-live-p buffer)
      (let ((kill-buffer-hook nil)
            (kill-buffer-query-functions nil))
        (kill-buffer buffer)))))

;; ── Public: session lifecycle ─────────────────────────────────────────────────

(defun noema-interaction-cli-available-p (id)
  "Return non-nil when the executable for tool ID is findable."
  (let ((exe (noema-interaction-cli--executable id)))
    (or (file-executable-p exe) (not (null (executable-find exe))))))

(defun noema-interaction-cli-session-live-p (id &optional project-root)
  "Return non-nil when a live session exists for tool ID and PROJECT-ROOT."
  (let* ((root (noema-interaction-cli--working-directory project-root))
         (tracked (noema-interaction-cli--get-process id root))
         (buf-proc (when-let* ((buf (noema-interaction-cli-buffer id root)))
                     (get-buffer-process buf)))
         (live (cond
                ((and tracked (process-live-p tracked)) tracked)
                ((and buf-proc (process-live-p buf-proc)) buf-proc))))
    (when live
      (unless (eq live tracked)
        (noema-interaction-cli--set-process id root live))
      t)))

(defun noema-interaction-cli-ensure-session (id &optional project-root)
  "Ensure a live terminal session exists for tool ID and PROJECT-ROOT.
Returns the session buffer."
  (unless (noema-interaction-cli-available-p id)
    (error "%s executable not found: %s" id (noema-interaction-cli--executable id)))
  (noema-interaction-cli--ensure-terminal-backend id)
  (let* ((root (noema-interaction-cli--working-directory project-root))
         (buffer-name (noema-interaction-cli--buffer-name id root)))
    (noema-interaction-cli--cleanup-dead-processes id)
    (unless (noema-interaction-cli-session-live-p id root)
      (let* ((buf-and-proc
              (noema-interaction-cli--create-terminal-session id buffer-name root))
             (buffer (car buf-and-proc))
             (process (cdr buf-and-proc)))
        (noema-interaction-cli--set-process id root process)
        (set-process-sentinel
         process
         (lambda (_proc event)
           (when (string-match-p "\\(finished\\|exited\\|killed\\|terminated\\)" event)
             (noema-interaction-cli--cleanup-on-exit id root))))
        (with-current-buffer buffer
          (add-hook 'kill-buffer-hook
                    (lambda () (noema-interaction-cli--cleanup-on-exit id root))
                    nil t))))
    (noema-interaction-cli-buffer id root)))

(defun noema-interaction-cli-open-buffer (id &optional project-root)
  "Open the terminal buffer for tool ID via the popup window system."
  (if-let* ((buf (noema-interaction-cli-buffer
                  id (noema-interaction-cli--working-directory project-root))))
      (my/vterm-popup-display-buffer buf)
    (user-error "No %s session for this project" id)))

(defun noema-interaction-cli-stop (id &optional project-root)
  "Stop the terminal session for tool ID and PROJECT-ROOT."
  (let ((root (noema-interaction-cli--working-directory project-root)))
    (when-let* ((process (noema-interaction-cli--get-process id root)))
      (when (process-live-p process)
        (delete-process process)))
    (noema-interaction-cli--cleanup-on-exit id root)
    (noema-interaction-session-set-last-status (format "Stopped %s session" id) root)
    (message "noema-interaction stopped %s session" id)))

;; ── Public: prompt dispatch ───────────────────────────────────────────────────

(defun noema-interaction-cli--send-prompt-retry (id prompt root attempts on-success on-error)
  "Send PROMPT to tool ID session in ROOT, retrying up to ATTEMPTS times."
  (if-let* ((buffer (noema-interaction-cli-buffer id root))
            (process (get-buffer-process buffer))
            ((process-live-p process)))
      (condition-case err
          (with-current-buffer buffer
            (noema-interaction-cli--terminal-paste-string id prompt)
            (sit-for 0.1)
            (noema-interaction-cli--terminal-send-return id)
            (when on-success (funcall on-success)))
        (error
         (when on-error (funcall on-error (error-message-string err)))
         (signal (car err) (cdr err))))
    (if (> attempts 0)
        (run-with-timer 0.3 nil #'noema-interaction-cli--send-prompt-retry
                        id prompt root (1- attempts) on-success on-error)
      (let ((message (format "%s session did not become ready" id)))
        (when on-error (funcall on-error message))
        (error "%s" message)))))

(defun noema-interaction-cli-send-prompt (id prompt &optional project-root on-success on-error)
  "Send PROMPT to the terminal session for tool ID and PROJECT-ROOT."
  (let ((root (noema-interaction-cli--working-directory project-root)))
    (noema-interaction-cli-ensure-session id root)
    (run-with-timer 0.3 nil #'noema-interaction-cli--send-prompt-retry
                    id prompt root 8 on-success on-error)))

(defun noema-interaction-cli--draft-prompt-retry (id prompt root attempts on-success on-error)
  "Insert PROMPT into the tool ID session in ROOT without submitting."
  (if-let* ((buffer (noema-interaction-cli-buffer id root))
            (process (get-buffer-process buffer))
            ((process-live-p process)))
      (condition-case err
          (with-current-buffer buffer
            (noema-interaction-cli--terminal-paste-string id prompt)
            (when on-success (funcall on-success)))
        (error
         (when on-error (funcall on-error (error-message-string err)))
         (signal (car err) (cdr err))))
    (if (> attempts 0)
        (run-with-timer 0.3 nil #'noema-interaction-cli--draft-prompt-retry
                        id prompt root (1- attempts) on-success on-error)
      (let ((message (format "%s session did not become ready" id)))
        (when on-error (funcall on-error message))
        (error "%s" message)))))

(defun noema-interaction-cli-draft-prompt (id prompt &optional project-root on-success on-error)
  "Insert PROMPT into the terminal session for tool ID without submitting."
  (let ((root (noema-interaction-cli--working-directory project-root)))
    (noema-interaction-cli-ensure-session id root)
    (run-with-timer 0.3 nil #'noema-interaction-cli--draft-prompt-retry
                    id prompt root 8 on-success on-error)))

;; ── Public: profile bootstrap ─────────────────────────────────────────────────

(defun noema-interaction-cli--cd-prompt (root)
  "Return the cd line prepended to the profile bootstrap for ROOT."
  (format "cd %s"
          (shell-quote-argument (directory-file-name (expand-file-name root)))))

(defun noema-interaction-cli-prime-session (id &optional project-root)
  "Inject the working directory and profile into the tool ID session.
Sends a combined cd+profile bootstrap prompt via bracketed paste so
embedded newlines are preserved and the tool does not round-trip the
cd line before the profile body arrives."
  (let ((root (or project-root default-directory)))
    (unless (noema-interaction-session-profile-injected-p id root)
      (let ((bootstrap (concat (noema-interaction-cli--cd-prompt root)
                               "\n\n"
                               (noema-interaction-profile-build-prompt root))))
        (noema-interaction-cli-send-prompt
         id bootstrap root
         (lambda ()
           (noema-interaction-session-mark-profile-bootstrap-sent id root)
           (noema-interaction-session-mark-profile-injected id root)
           (noema-interaction-session-set-last-status
            (format "%s profile injected" id) root)))))))

;; ── Public: headless exec ─────────────────────────────────────────────────────

(defun noema-interaction-cli-exec (id prompt &rest opts)
  "Run a one-shot headless request for tool ID with PROMPT.
OPTS is a plist:
  :root      Working directory (defaults to current project root)
  :callback  Function (result-string) called on success
  :on-error  Function (event-string details-string) called on failure/timeout
  :timeout   Seconds before aborting (default: 180)
Returns the process object so callers can check liveness."
  (let* ((root (or (plist-get opts :root) (noema-interaction-cli--working-directory)))
         (callback (plist-get opts :callback))
         (on-error (plist-get opts :on-error))
         (timeout (or (plist-get opts :timeout) 180))
         (exec-args-fn (noema-interaction-cli--spec id :exec-args-fn))
         (exec-output (or (noema-interaction-cli--spec id :exec-output) 'stdout))
         (output-file (when (eq exec-output 'file)
                        (make-temp-file "noema-interaction-cli-" nil ".txt")))
         (log-buf (generate-new-buffer (format " *noema-interaction-cli-%s*" id)))
         (default-directory root))
    (unless exec-args-fn
      (error "No :exec-args-fn registered for tool %s" id))
    (let* ((command (funcall exec-args-fn prompt output-file root))
           (timer nil)
           (process
            (make-process
             :name (format "noema-interaction-cli-%s" id)
             :buffer log-buf
             :command command
             :coding 'utf-8
             :noquery t
             :sentinel
             (lambda (proc event)
               (when (memq (process-status proc) '(exit signal))
                 (when (timerp timer) (cancel-timer timer))
                 (unwind-protect
                     (if (and (eq (process-status proc) 'exit)
                              (zerop (process-exit-status proc)))
                         (let ((result
                                (noema-interaction-cli--strip-ansi
                                 (pcase exec-output
                                   ('file
                                    (if (and output-file (file-exists-p output-file))
                                        (with-temp-buffer
                                          (insert-file-contents output-file)
                                          (string-trim (buffer-string)))
                                      (error "No output file produced by %s" id)))
                                   ('stdout
                                    (if (buffer-live-p log-buf)
                                        (with-current-buffer log-buf
                                          (string-trim (buffer-string)))
                                      ""))))))
                           (when callback (funcall callback result)))
                       (let ((details (noema-interaction-cli--strip-ansi
                                       (if (buffer-live-p log-buf)
                                           (with-current-buffer log-buf
                                             (string-trim (buffer-string)))
                                         ""))))
                         (when on-error (funcall on-error event details))))
                   (when (and output-file (file-exists-p output-file))
                     (ignore-errors (delete-file output-file)))
                   (when (buffer-live-p log-buf)
                     (kill-buffer log-buf))))))))
      (setq timer
            (run-at-time timeout nil
                         (lambda ()
                           (when (process-live-p process)
                             (delete-process process))
                           (when on-error
                             (funcall on-error
                                      (format "timed out after %ss" timeout)
                                      ""))
                           (when (and output-file (file-exists-p output-file))
                             (ignore-errors (delete-file output-file)))
                           (when (buffer-live-p log-buf)
                             (kill-buffer log-buf)))))
      process)))

;; ── ANSI stripping ────────────────────────────────────────────────────────────

(defun noema-interaction-cli--strip-ansi (str)
  "Remove ANSI/VT100 escape sequences from STR.
CLI tools emit terminal control codes that must be stripped before
the output is shown in an Emacs buffer or passed to the engine."
  (when (stringp str)
    (let ((s str))
      (setq s (replace-regexp-in-string "\033\\][^\007]*\007" "" s))
      (setq s (replace-regexp-in-string "\033\\][^\033]*\033\\\\" "" s))
      (setq s (replace-regexp-in-string "\033\\[[?!>]?[0-9;]*[A-Za-z]" "" s))
      (setq s (replace-regexp-in-string "\033O[A-Za-z]" "" s))
      (setq s (replace-regexp-in-string "\033." "" s))
      s)))

(provide 'noema-interaction-cli)
;;; noema-interaction-cli.el ends here
