;;; noema-agent-abtop-tests.el --- Tests for the live agent board -*- lexical-binding: t; -*-

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'agent-shell)
(require 'noema-agent-abtop)

(defmacro noema-agent-abtop-tests--with-session (usage &rest body)
  "Run BODY with `session' bound to a fake agent buffer reporting USAGE."
  (declare (indent 1))
  `(let ((session (generate-new-buffer " *abtop-test*")))
     (unwind-protect
         (progn
           (with-current-buffer session
             (setq-local agent-shell--state (agent-shell--make-state :buffer session))
             (setf (alist-get :model-id (alist-get :session agent-shell--state)) "opus")
             (setf (alist-get :request-count agent-shell--state) 3)
             (pcase-dolist (`(,key . ,value) ,usage)
               (setf (alist-get key (alist-get :usage agent-shell--state)) value))
             (setq-local noema-agent-acp-session-name "research"
                         noema-agent-acp-session-agent "claude"
                         noema-agent-acp-session-root "/tmp/proj/"))
           (cl-letf (((symbol-function 'noema-agent-acp-agent-buffer-p)
                      (lambda (buffer) (eq buffer session)))
                     ((symbol-function 'noema-agent-acp-busy-p) #'ignore))
             ,@body))
       (kill-buffer session))))

(ert-deftest noema-agent-abtop-reads-agent-shell-state ()
  "Usage comes from agent-shell's recorded ACP state, normalized."
  (noema-agent-abtop-tests--with-session
      '((:context-used . 144000) (:context-size . 200000)
        (:input-tokens . 5200) (:output-tokens . 2800.0)
        (:cached-read-tokens . 320000) (:cost-amount . 0.42))
    (let ((usage (noema-agent-acp-usage session)))
      (should (equal (plist-get usage :model) "opus"))
      (should (= (plist-get usage :context-used) 144000))
      (should (= (plist-get usage :output) 2800))
      (should (= (plist-get usage :thought) 0))
      (should (= (plist-get usage :turns) 3))
      (should (= (plist-get usage :compactions) 0))
      (should (= (plist-get usage :cost) 0.42)))
    (should-not (noema-agent-acp-usage (current-buffer)))))

(ert-deftest noema-agent-abtop-counts-compactions-and-rate-limits ()
  "Usage reports feed compaction counting and Claude rate limits."
  (let ((noema-agent-acp--rate-limits (make-hash-table :test #'equal))
        (noema-agent-acp-rate-limits-file (make-temp-file "abtop-limits" nil ".json"))
        reported)
    (noema-agent-abtop-tests--with-session nil
      (let ((noema-agent-acp-changed-functions
             (list (lambda (buffer) (push buffer reported))))
            (state (buffer-local-value 'agent-shell--state session)))
        (dolist (used '(50000 120000 30000 36000 5000))
          (agent-shell--update-usage-from-notification
           :state state :acp-update `((used . ,used) (size . 200000))))
        ;; 120k -> 30k is a compaction; 36k -> 5k is too.  50k -> 120k is growth.
        (should (= 2 (plist-get (noema-agent-acp-usage session) :compactions)))
        (should (= 120000 (plist-get (noema-agent-acp-usage session) :context-peak)))
        (should (= 5 (length reported)))
        (agent-shell--update-usage-from-notification
         :state state
         :acp-update '((used . 6000) (size . 200000)
                       (_meta (_claude/rateLimit (status . "allowed")
                                                 (rateLimitType . "five_hour")
                                                 (utilization . 0.42)
                                                 (resetsAt . 1791090463))))))
      (let ((limit (gethash "claude/five_hour" (noema-agent-acp-rate-limits))))
        (should (= 0.42 (plist-get limit :utilization)))
        (should (= 1791090463 (plist-get limit :resets-at))))
      ;; The last limits survive a restart.
      (setq noema-agent-acp--rate-limits nil)
      (should (= 0.42 (plist-get (gethash "claude/five_hour" (noema-agent-acp-rate-limits))
                                 :utilization))))))

(ert-deftest noema-agent-abtop-reads-codex-rate-limits ()
  "The last token_count with limits wins; windows are named by length."
  (let ((limits
         (noema-agent-abtop--codex-parse
          (concat
           "{\"timestamp\":\"2026-09-28T05:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"primary\":{\"used_percent\":1.0,\"window_minutes\":300}}}}\n"
           "{\"timestamp\":\"2026-09-28T05:36:54Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":7.0,\"window_minutes\":10080,\"resets_at\":1791090463},\"secondary\":null}}}\n"
           "{\"type\":\"response_item\"}\n"))))
    (should (= 1 (length limits)))
    (should (equal (plist-get (car limits) :window) "7d"))
    (should (= 0.07 (plist-get (car limits) :utilization)))
    (should (numberp (plist-get (car limits) :updated-at)))))

(ert-deftest noema-agent-abtop-selects-newest-codex-file ()
  "Select by modification time even when the filename order differs."
  (let* ((root (make-temp-file "abtop-codex-" t))
         (day (expand-file-name "sessions/2026/09/30" root))
         (earlier (expand-file-name "rollout-z.jsonl" day))
         (latest (expand-file-name "rollout-a.jsonl" day)))
    (unwind-protect
        (progn
          (make-directory day t)
          (with-temp-file earlier (insert "old\n"))
          (with-temp-file latest (insert "new\n"))
          (set-file-times earlier (seconds-to-time 100))
          (set-file-times latest (seconds-to-time 200))
          (cl-letf (((symbol-function 'noema-agent-abtop--codex-home)
                     (lambda () root)))
            (should (equal (noema-agent-abtop--codex-file) latest))))
      (delete-directory root t))))

(ert-deftest noema-agent-abtop-renders-sessions-and-detail ()
  "The board lists the session with a context bar and shows its detail."
  (let ((noema-agent-acp--rate-limits (make-hash-table :test #'equal))
        (noema-agent-acp-rate-limits-file (make-temp-file "abtop-limits" nil ".json")))
    (noema-agent-abtop-tests--with-session
        '((:context-used . 144000) (:context-size . 200000)
          (:input-tokens . 5200) (:output-tokens . 2800) (:cost-amount . 0.42))
      (cl-letf (((symbol-function 'noema-agent-abtop--codex-limits) #'ignore)
                ((symbol-function 'noema-agent-abtop--opencode-providers)
                 (lambda () '("github-copilot" "openai"))))
        (with-temp-buffer
          (noema-agent-abtop-mode)
          (noema-agent-abtop--render)
          (let ((text (buffer-string)))
            (should (string-match-p "╭─ ▾ quota " text))
            (should (string-match-p "claude +5h +·+ +reported during a turn, or on g" text))
            (should (string-match-p "codex +5h .*\n.* 7d +·+ +absent" text))
            (should (string-match-p "opencode +github-copilot .*GitHub's API" text))
            (should (string-match-p "openai +·+ +ChatGPT login" text))
            (should (string-match-p "○ idle +research +opus" text))
            (should (string-match-p " 72%" text))
            (should (string-match-p "\\$0\\.42" text))
            (should (string-match-p "╭─ ▾ remote control " text))
            (should (string-match-p "╭─ ▾ prompt cache " text))
            (should (string-match-p "╭─ ▾ session research " text))
            (should (string-match-p "144\\.0k / 200\\.0k" text)))
          (should (eq noema-agent-abtop--shown-id session))
          (should (eq (get-text-property (point) 'aaron-ui-board--item-id) session))
          (noema-agent-abtop--teardown))))))

(ert-deftest noema-agent-abtop-cache-reuse-is-a-reported-category-share ()
  "The board compares reads with fresh input and writes across sessions."
  (let ((rows (list (cons nil '(:input 100 :cached-read 300 :cached-write 100))
                    (cons nil '(:input 100 :cached-read 100 :cached-write 0)))))
    (pcase-let ((`(,fresh ,read ,write ,share)
                 (noema-agent-abtop--cache-summary rows)))
      (should (= fresh 200))
      (should (= read 400))
      (should (= write 100))
      (should (< (abs (- share (/ 4.0 7))) 0.0001)))
    (should (equal (noema-agent-abtop--cache-description
                    (noema-agent-abtop--cache-metrics
                     '(:input 100 :cached-read 300 :cached-write 100)))
                   "read 300 · fresh 100 · write 100 · reuse 60% · read/write 3.0x"))))

(ert-deftest noema-agent-abtop-claude-remote-requires-connection-confirmation ()
  "A live process is only connecting until Claude prints Connected."
  (let* ((connecting (noema-agent-abtop--claude-remote-scan
                      "" "· Connecting · project"))
         (connected (noema-agent-abtop--claude-remote-scan
                     (plist-get connecting :tail)
                     (concat "\e[1A· Connected · project\n"
                             "https://claude.ai/code?environment=env_test123")))
         (lost (noema-agent-abtop--claude-remote-scan
                (plist-get connected :tail) "\n· Reconnecting · project")))
    (should (eq (plist-get connecting :state) 'connecting))
    (should (eq (plist-get connected :state) 'connected))
    (should (equal (plist-get connected :url)
                   "https://claude.ai/code?environment=env_test123"))
    (should (eq (plist-get lost :state) 'connecting))))

(ert-deftest noema-agent-abtop-codex-toggle-preserves-app-server ()
  "Codex Remote actions must not stop the app-server daemon."
  (let (requested)
    (cl-letf (((symbol-function 'noema-agent-abtop--codex-remote-run)
               (lambda (action) (setq requested action))))
      (dolist (case '((on . disable) (error . retry) (off . enable)))
        (let ((noema-agent-abtop--codex-remote-state (car case)))
          (noema-agent-abtop-codex-remote-toggle)
          (should (eq requested (cdr case))))))))

(ert-deftest noema-agent-abtop-codex-status-distinguishes-enabled-from-connected ()
  "The daemon can remain enabled while the phone cannot reach it."
  (should (eq (noema-agent-abtop--codex-remote-classify
               "{\"status\":\"connected\"}" 0) 'on))
  (should (eq (noema-agent-abtop--codex-remote-classify
               "Error: Remote control is enabled on Mac but the connection is errored" 1)
              'error))
  (should (eq (noema-agent-abtop--codex-remote-classify
               "{\"status\":\"connecting\"}" 0) 'connecting))
  (should (eq (noema-agent-abtop--codex-remote-classify
               "Remote control is not enabled" 1) 'off)))

(ert-deftest noema-agent-abtop-codex-remembers-enabled-but-errored-baseline ()
  "A connection error still counts as an originally enabled remote."
  (should (eq (noema-agent-abtop--codex-remote-enabled-state
               'error "Remote control is enabled on Mac but the connection is errored")
              'enabled))
  (should (eq (noema-agent-abtop--codex-remote-enabled-state
               'off "Remote control is not enabled") 'disabled))
  (should (eq (noema-agent-abtop--codex-remote-enabled-state
               'error "unrelated CLI failure") 'unknown))
  (let ((noema-agent-abtop--codex-remote-baseline 'unknown)
        (noema-agent-abtop--codex-remote-state 'error)
        (noema-agent-abtop--codex-remote-note "unrelated CLI failure"))
    (should-error (noema-agent-abtop--codex-remote-prepare-action 'enable)
                  :type 'user-error)))

(ert-deftest noema-agent-abtop-codex-exit-restores-only-abtop-changes ()
  "Exiting restores the original global flag after an abtop toggle."
  (let ((noema-agent-abtop--codex-remote-process nil)
        (noema-agent-abtop--codex-remote-owned t)
        (noema-agent-abtop--codex-remote-baseline 'enabled)
        (noema-agent-abtop--codex-remote-last-requested 'disabled)
        requested)
    (cl-letf (((symbol-function 'noema-agent-abtop--run-before-exit)
               (lambda (command) (setq requested command) t))
              ((symbol-function 'executable-find) (lambda (name) name)))
      (noema-agent-abtop--restore-codex-on-exit)
      (should (equal (last requested) '("enable-remote-control")))
      (setq requested nil
            noema-agent-abtop--codex-remote-baseline 'disabled
            noema-agent-abtop--codex-remote-last-requested 'enabled)
      (noema-agent-abtop--restore-codex-on-exit)
      (should (equal (last requested) '("disable-remote-control")))
      (setq requested nil
            noema-agent-abtop--codex-remote-last-requested 'disabled)
      (noema-agent-abtop--restore-codex-on-exit)
      (should-not requested)
      (setq noema-agent-abtop--codex-remote-owned nil
            noema-agent-abtop--codex-remote-last-requested 'enabled)
      (noema-agent-abtop--restore-codex-on-exit)
      (should-not requested))))

(ert-deftest noema-agent-abtop-emacs-exit-stops-owned-claude ()
  "The exit hook stops Claude processes launched by abtop."
  (let* ((noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
         (process (make-process :name "abtop-exit-test"
                                :command (list (expand-file-name invocation-name
                                                                 invocation-directory)
                                               "-Q" "--batch" "--eval" "(sleep-for 30)")
                                :connection-type 'pty :noquery t)))
    (unwind-protect
        (progn
          (puthash "/tmp/project/" process noema-agent-abtop--claude-remotes)
          (noema-agent-abtop--stop-claude-on-exit)
          (should-not (process-live-p process))
          (should (= (hash-table-count noema-agent-abtop--claude-remotes) 0))
          (should (memq #'noema-agent-abtop--shutdown kill-emacs-hook)))
      (when (process-live-p process) (delete-process process)))))

(ert-deftest noema-agent-abtop-exit-command-waits-for-completion ()
  "Codex restoration uses a bounded command that observes its exit status."
  (should (noema-agent-abtop--run-before-exit
           (list (expand-file-name invocation-name invocation-directory)
                 "-Q" "--batch"))))

(ert-deftest noema-agent-abtop-remote-panel-shows-confirmed-state-and-web-entry ()
  "The panel separates a live Claude process from a confirmed connection."
  (let* ((process (make-pipe-process :name "abtop-remote-test" :noquery t))
         (noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
         (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal))
         (noema-agent-abtop--codex-remote-state 'error)
         (noema-agent-abtop--codex-remote-note "enabled, but connection errored"))
    (unwind-protect
        (progn
          (puthash "/tmp/project/" process noema-agent-abtop--claude-remotes)
          (process-put process 'noema-agent-abtop--state 'connected)
          (process-put process 'noema-agent-abtop--url
                       "https://claude.ai/code?environment=env_test")
          (with-temp-buffer
            (noema-agent-abtop-mode)
            (let ((inhibit-read-only t)) (noema-agent-abtop--insert-remote))
            (let ((rendered (buffer-string)))
              (should (string-match-p "codex +enabled · connection error" rendered))
              (should (string-match-p "\\[E retry\\]" rendered))
              (should (string-match-p "state +connected" rendered))
              (should (string-match-p "\\[open Claude\\]" rendered)))))
      (delete-process process))))

(ert-deftest noema-agent-abtop-claude-stop-clears-closed-project ()
  "D removes a closed Claude project and its retained console."
  (let ((noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
        (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal))
        (buffer (generate-new-buffer " *abtop-closed-remote*")))
    (puthash "/tmp/project/" (list :reason "exit 1" :buffer buffer)
             noema-agent-abtop--claude-remote-errors)
    (noema-agent-abtop-claude-remote-stop "/tmp/project/")
    (should-not (gethash "/tmp/project/" noema-agent-abtop--claude-remote-errors))
    (should-not (buffer-live-p buffer))))

(ert-deftest noema-agent-abtop-claude-exit-shows-real-error ()
  "A failed Remote launch shows the CLI reason on the board."
  (let* ((buffer (generate-new-buffer " *abtop-remote-error-test*"))
         (noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
         (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal))
         (noema-agent-abtop--codex-remote-state 'off))
    (unwind-protect
        (progn
          (with-current-buffer buffer
            (insert "Error: This folder is already served by a terminal `claude remote-control` on this device. Stop it first.\n"))
          (let ((reason (noema-agent-abtop--claude-remote-failure buffer 1)))
            (puthash "/tmp/project/" (list :reason reason :buffer buffer)
                     noema-agent-abtop--claude-remote-errors)
            (with-temp-buffer
              (noema-agent-abtop-mode)
              (let ((inhibit-read-only t)) (noema-agent-abtop--insert-remote))
              (should (string-match-p "already served by a terminal"
                                      (buffer-string))))))
      (kill-buffer buffer))))

(ert-deftest noema-agent-abtop-d-clears-only-claude-project ()
  "D can clear the sole project from anywhere on the board."
  (let ((noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
        (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal)))
    (puthash "/tmp/project/" (list :reason "exit 1")
             noema-agent-abtop--claude-remote-errors)
    (with-temp-buffer
      (noema-agent-abtop-mode)
      (call-interactively (key-binding (kbd "D"))))
    (should (= (hash-table-count noema-agent-abtop--claude-remote-errors) 0))))

(ert-deftest noema-agent-abtop-d-uses-selected-claude-project ()
  "D on a project row clears that project when several are listed."
  (let ((noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
        (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal)))
    (puthash "/tmp/a/" (list :reason "exit 1") noema-agent-abtop--claude-remote-errors)
    (puthash "/tmp/b/" (list :reason "exit 1") noema-agent-abtop--claude-remote-errors)
    (with-temp-buffer
      (noema-agent-abtop-mode)
      (let ((inhibit-read-only t)) (noema-agent-abtop--insert-remote))
      (goto-char (point-min))
      (search-forward "/tmp/b/")
      (goto-char (match-beginning 0))
      (call-interactively (key-binding (kbd "D"))))
    (should (gethash "/tmp/a/" noema-agent-abtop--claude-remote-errors))
    (should-not (gethash "/tmp/b/" noema-agent-abtop--claude-remote-errors))))

(ert-deftest noema-agent-abtop-remote-row-opens-console-not-agent ()
  "RET on a Remote row must not fall back to the selected agent session."
  (let* ((directory "/tmp/project/")
         (console (generate-new-buffer " *abtop-remote-console-test*"))
         (board (generate-new-buffer " *abtop-remote-board-test*"))
         (process (make-pipe-process :name "abtop-remote-visit-test"
                                     :buffer console :noquery t))
         (noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
         (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal)))
    (unwind-protect
        (save-window-excursion
          (puthash directory process noema-agent-abtop--claude-remotes)
          (switch-to-buffer board)
          (noema-agent-abtop-mode)
          (let ((inhibit-read-only t)) (noema-agent-abtop--insert-remote))
          (goto-char (point-min))
          (search-forward "/tmp/project/")
          (goto-char (match-beginning 0))
          (should (eq (key-binding [mouse-1])
                      'noema-agent-abtop-mouse-visit))
          (should-error (noema-agent-abtop--session-at-point) :type 'user-error)
          (call-interactively (key-binding (kbd "RET")))
          (should (eq (window-buffer (selected-window)) console)))
      (delete-process process)
      (kill-buffer board)
      (kill-buffer console))))

(ert-deftest noema-agent-abtop-refresh-keeps-remote-row-selected ()
  "A changing quota panel must not send the cursor back to the agent row."
  (let* ((directory "/tmp/project/")
         (process (make-pipe-process :name "abtop-remote-refresh-test" :noquery t))
         (noema-agent-abtop--claude-remotes (make-hash-table :test #'equal))
         (noema-agent-abtop--claude-remote-errors (make-hash-table :test #'equal))
         (noema-agent-abtop--codex-remote-state 'off)
         (quota-lines 1))
    (unwind-protect
        (progn
          (puthash directory process noema-agent-abtop--claude-remotes)
          (with-temp-buffer
            (noema-agent-abtop-mode)
            (cl-letf (((symbol-function 'noema-agent-abtop--sessions) (lambda () nil))
                      ((symbol-function 'noema-agent-abtop--insert-quota)
                       (lambda () (dotimes (_ quota-lines) (insert "quota\n"))))
                      ((symbol-function 'noema-agent-abtop--insert-cache) #'ignore)
                      ((symbol-function 'noema-agent-abtop--insert-sessions) #'ignore)
                      ((symbol-function 'noema-agent-abtop--insert-detail) #'ignore)
                      ((symbol-function 'noema-agent-abtop--insert-key-hints) #'ignore))
              (noema-agent-abtop--render)
              (goto-char (point-min))
              (search-forward "/tmp/project/")
              (goto-char (match-beginning 0))
              (setq quota-lines 3)
              (noema-agent-abtop--render)
              (should (equal (get-text-property
                              (point) 'noema-agent-abtop--remote-root)
                             directory)))))
      (delete-process process))))

;; A full header update or a kill reports a change; busy animation ticks do not.
(ert-deftest noema-agent-abtop-hears-session-changes ()
  (let* ((buffer (generate-new-buffer " *abtop-change*"))
         (reported nil)
         (noema-agent-acp-changed-functions (list (lambda (b) (push b reported)))))
    (with-current-buffer buffer
      (noema-agent-acp--header-updated-a :cache-enabled t)
      (should-not reported)
      (noema-agent-acp--header-updated-a)
      (should (equal reported (list buffer)))
      (noema-agent-acp--track-activity-h))
    (kill-buffer buffer)
    (should (= 2 (length reported)))))

;; Claude's usage endpoint reports 0-100 and ISO times; the ACP event may
;; carry every window at once in unifiedWindows (fractions, epoch seconds).
(ert-deftest noema-agent-abtop-records-claude-quota-sources ()
  (let ((noema-agent-acp--rate-limits (make-hash-table :test #'equal))
        (noema-agent-acp-rate-limits-file (make-temp-file "abtop-limits" nil ".json")))
    (noema-agent-abtop--claude-record-usage
     '((five_hour (utilization . 42.0) (resets_at . "2026-09-29T02:00:00Z"))
       (seven_day (utilization . 0.5) (resets_at))
       (seven_day_opus)))
    (let ((five (gethash "claude/five_hour" (noema-agent-acp-rate-limits)))
          (seven (gethash "claude/seven_day" (noema-agent-acp-rate-limits))))
      (should (= 0.42 (plist-get five :utilization)))
      (should (= (plist-get five :resets-at)
                 (float-time (date-to-time "2026-09-29T02:00:00Z"))))
      (should (= 0.005 (plist-get seven :utilization)))
      (should-not (gethash "claude/seven_day_opus" (noema-agent-acp-rate-limits))))
    (noema-agent-acp--note-rate-limit
     "claude" '((status . "allowed")
                (unifiedWindows (five_hour (utilization . 0.6) (resetsAt . 1791090463))
                                (seven_day (utilization . 0.1) (resetsAt . 1791500000)))))
    (should (= 0.6 (plist-get (gethash "claude/five_hour" (noema-agent-acp-rate-limits))
                              :utilization)))
    (should (= 0.1 (plist-get (gethash "claude/seven_day" (noema-agent-acp-rate-limits))
                              :utilization)))))

(ert-deftest noema-agent-abtop-claude-token-is-never-refreshed ()
  "An expired or missing login is reported, not renewed."
  (should (equal (noema-agent-abtop--claude-token
                  (json-serialize `((claudeAiOauth . ((accessToken . "t")
                                                      (expiresAt . ,(* 1000 (+ (float-time) 60))))))))
                 "t"))
  (should-error (noema-agent-abtop--claude-token
                 (json-serialize '((claudeAiOauth . ((accessToken . "t") (expiresAt . 1)))))))
  (should-error (noema-agent-abtop--claude-token "{}")))

(ert-deftest noema-agent-abtop-claude-fetch-sends-token-and-records ()
  "One request with the bearer token; the reply lands in the rate limits."
  (let ((noema-agent-acp--rate-limits (make-hash-table :test #'equal))
        (noema-agent-acp-rate-limits-file (make-temp-file "abtop-limits" nil ".json"))
        (noema-agent-abtop--claude-fetch nil)
        (noema-agent-abtop-claude-usage t)
        headers)
    (cl-letf (((symbol-function 'noema-agent-abtop--claude-read-token)
               (lambda (callback) (funcall callback "secret-token")))
              ((symbol-function 'url-retrieve)
               (lambda (_url callback &rest _)
                 (setq headers url-request-extra-headers)
                 (with-current-buffer (generate-new-buffer " *usage-reply*")
                   (insert "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"
                           "{\"five_hour\":{\"utilization\":12,\"resets_at\":null}}")
                   (funcall callback nil)
                   nil))))
      (noema-agent-abtop--claude-fetch)
      (should (equal (cdr (assoc "Authorization" headers)) "Bearer secret-token"))
      (should (equal (cdr (assoc "anthropic-beta" headers)) "oauth-2025-04-20"))
      (should (= 0.12 (plist-get (gethash "claude/five_hour" (noema-agent-acp-rate-limits))
                                 :utilization)))
      (should-not (plist-get noema-agent-abtop--claude-fetch :running))
      (should-not (plist-get noema-agent-abtop--claude-fetch :error))
      ;; A second explicit refresh inside the interval does not ask again.
      (setq headers nil)
      (noema-agent-abtop--claude-fetch)
      (should-not headers))))

(ert-deftest noema-agent-abtop-hidden-board-stops-listening ()
  "A board nobody sees unsubscribes; showing it subscribes again."
  (let ((noema-agent-acp-changed-functions nil)
        (board (get-buffer-create noema-agent-abtop--buffer-name))
        (visible nil))
    (unwind-protect
        (cl-letf (((symbol-function 'noema-agent-abtop--visible-window)
                   (lambda (_) visible))
                  ((symbol-function 'noema-agent-abtop--timer-fire) #'ignore))
          (add-hook 'noema-agent-acp-changed-functions #'noema-agent-abtop--session-changed)
          (noema-agent-abtop--session-changed nil)
          (should-not noema-agent-acp-changed-functions)
          (should-not noema-agent-abtop--refresh-timer)
          (setq visible t)
          (noema-agent-abtop--shown nil)
          (should (memq #'noema-agent-abtop--session-changed noema-agent-acp-changed-functions))
          (should (timerp noema-agent-abtop--refresh-timer)))
      (noema-agent-abtop--teardown)
      (kill-buffer board))))

(provide 'noema-agent-abtop-tests)
;;; noema-agent-abtop-tests.el ends here
