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
            (should (string-match-p "╭─ ▾ session research " text))
            (should (string-match-p "144\\.0k / 200\\.0k" text)))
          (should (eq noema-agent-abtop--shown-id session))
          (should (eq (get-text-property (point) 'aaron-ui-board--item-id) session))
          (noema-agent-abtop--teardown))))))

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
