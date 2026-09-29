;;; noema-agent-abtop.el --- Live agent sessions at a glance, btop-style -*- lexical-binding: t; -*-

;;; Commentary:
;; A btop-style board over every live agent session: subscription quota,
;; one row per session (state, model, context fill, tokens, cost, turns,
;; compactions, idle time) and a detail panel for the session at point, with
;; the lifecycle actions the Agent window already offers.
;;
;; Everything comes from state Emacs already holds: `noema-agent-acp-usage'
;; (what agent-shell recorded from the ACP connection), the Claude rate limits
;; `noema-agent-acp' records from `usage_update' metadata, and the Codex rate
;; limits in the newest Codex session file.  Nothing scans processes or polls:
;; the board renders when it opens, on `g', and -- while it is visible -- once
;; shortly after a session changes (`noema-agent-acp-changed-functions').
;;
;; Ideas taken from abtop (github.com/graykode/abtop): context-drop
;; compaction counting, Codex `token_count' rate limits, and quota windows
;; named by their length rather than by their position.

;;; Code:

(require 'cl-lib)
(require 'map)
(require 'subr-x)
(require 'aaron-ui-board)
(require 'url)
(require 'noema-agent-acp)

(declare-function noema-sessions-agent-restart "noema-sessions" (&optional buffer))
(declare-function noema-sessions-agent-rename "noema-sessions" (&optional buffer new-name))
(declare-function noema-sessions-agent-list "noema-sessions" (&optional buffer))
(declare-function noema-agent-worker-compact-session "noema-agent-worker" (&optional buffer))

(defconst noema-agent-abtop--buffer-name "*Noema Agent Top*")

(defvar-local noema-agent-abtop--root nil
  "Project root the board is restricted to, or nil for every live session.")

(defvar-local noema-agent-abtop--shown-id nil
  "Session whose detail panel is rendered, to re-render only when it changes.")

(defvar noema-agent-abtop--refresh-timer nil
  "One-shot timer coalescing usage reports into one render.")

(defconst noema-agent-abtop--refresh-delay 1.0
  "Seconds to coalesce session changes before re-rendering a visible board.")

(defvar-local noema-agent-abtop--folded nil
  "Panels (`quota', `sessions', `session') currently folded.")

;;; Faces
;;
;; The board is a character grid, so its faces carry colour only: the scaled
;; heights of `aaron-ui-board-meta' and friends would break column alignment.

(defface noema-agent-abtop-border '((t :inherit shadow))
  "Panel borders and empty bar cells."
  :group 'noema-agent-session)
(defface noema-agent-abtop-title '((t :inherit bold))
  "Panel titles."
  :group 'noema-agent-session)
(defface noema-agent-abtop-dim '((t :inherit shadow))
  "Labels and secondary values."
  :group 'noema-agent-session)
(defface noema-agent-abtop-faint '((t :inherit shadow))
  "Identifiers, paths and data ages."
  :group 'noema-agent-session)
(defface noema-agent-abtop-key '((t :inherit bold))
  "Keys in the key-hint line."
  :group 'noema-agent-session)

(defvar noema-agent-abtop--theme-signature nil
  "Theme the board faces were last coloured for.")

(defun noema-agent-abtop--apply-faces ()
  "Colour the board faces from the active `aaron-ui' palette, once per theme."
  (let ((signature (list custom-enabled-themes
                         (face-attribute 'default :background nil t))))
    (unless (equal signature noema-agent-abtop--theme-signature)
      (setq noema-agent-abtop--theme-signature signature)
      (aaron-ui-set-face 'noema-agent-abtop-border :foreground 'border-muted)
      (aaron-ui-set-face 'noema-agent-abtop-title :foreground 'accent-cyan :weight 'bold)
      (aaron-ui-set-face 'noema-agent-abtop-dim :foreground 'fg-muted)
      (aaron-ui-set-face 'noema-agent-abtop-faint :foreground 'fg-faint)
      (aaron-ui-set-face 'noema-agent-abtop-key :foreground 'accent-cyan :weight 'bold))))

;;; Formatting

(defun noema-agent-abtop--tokens (number)
  "Format NUMBER of tokens compactly, or \"-\" when it is zero."
  (cond ((or (null number) (<= number 0)) "-")
        ((>= number 1000000) (format "%.1fM" (/ number 1e6)))
        ((>= number 1000) (format "%.1fk" (/ number 1e3)))
        (t (number-to-string number))))

(defun noema-agent-abtop--cost (amount currency)
  "Format AMOUNT in CURRENCY, or \"-\" when no cost was reported."
  (if (not amount)
      "-"
    (concat (if (member currency '(nil "USD")) "$" (concat currency " "))
            (format "%.2f" amount))))

(defun noema-agent-abtop--duration (seconds)
  "Format SECONDS compactly, as abtop does."
  (let ((seconds (max 0 (truncate seconds))))
    (cond ((< seconds 60) (format "%ds" seconds))
          ((< seconds 3600) (format "%dm" (/ seconds 60)))
          ((< seconds 86400) (format "%dh%02dm" (/ seconds 3600) (/ (% seconds 3600) 60)))
          (t (format "%dd%02dh" (/ seconds 86400) (/ (% seconds 86400) 3600))))))

(defun noema-agent-abtop--window-name (minutes)
  "Name a quota window of MINUTES by its length: 5h, 7d, 30d."
  (cond ((not (numberp minutes)) "?")
        ((zerop (% minutes 1440)) (format "%dd" (/ minutes 1440)))
        ((zerop (% minutes 60)) (format "%dh" (/ minutes 60)))
        (t (format "%dm" minutes))))

(defun noema-agent-abtop--level (ratio)
  "Return the good/warn/bad face for RATIO of a limit used."
  (cond ((>= ratio 0.9) 'aaron-ui-board-bad)
        ((>= ratio 0.7) 'aaron-ui-board-warn)
        (t 'aaron-ui-board-good)))

(defun noema-agent-abtop--bar (ratio width)
  "Return a WIDTH-column bar filled to RATIO, coloured by level."
  (let* ((ratio (max 0.0 (min 1.0 ratio)))
         (filled (round (* ratio width))))
    (concat (propertize (make-string filled ?█) 'face (noema-agent-abtop--level ratio))
            (propertize (make-string (- width filled) ?░) 'face 'noema-agent-abtop-border))))

(defun noema-agent-abtop--cell (text width &optional face right)
  "Return TEXT fitted to WIDTH columns, in FACE, right-aligned when RIGHT."
  (let* ((text (truncate-string-to-width (format "%s" text) width nil nil "…"))
         (pad (make-string (max 0 (- width (string-width text))) ?\s))
         (text (if face (propertize text 'face face) text)))
    (if right (concat pad text) (concat text pad))))

;;; Panels

(defun noema-agent-abtop--width ()
  "Return the column width to draw panels in."
  (let ((window (get-buffer-window (current-buffer))))
    (max 60 (- (if window (window-body-width window) 100) 1))))

(defun noema-agent-abtop--panel-open (panel title &optional note)
  "Insert the top border of PANEL named TITLE, with an optional NOTE.
Return non-nil when PANEL is open; a folded panel is this one line only."
  (let* ((open (not (memq panel noema-agent-abtop--folded)))
         (width (noema-agent-abtop--width))
         (label (concat (if open " ▾ " " ▸ ") title " "))
         (note (and note (concat " " note " ")))
         (fill (- width 4 (string-width label) (if note (string-width note) 0)))
         (start (point)))
    (insert (propertize (if open "╭─" "╶─") 'face 'noema-agent-abtop-border)
            (propertize label 'face 'noema-agent-abtop-title)
            (propertize (make-string (max 1 fill) ?─) 'face 'noema-agent-abtop-border)
            (if note (propertize note 'face 'noema-agent-abtop-dim) "")
            (propertize (if open "─╮" "─╴") 'face 'noema-agent-abtop-border)
            "\n")
    (add-text-properties start (point)
                         `(noema-agent-abtop--panel ,panel
                           mouse-face aaron-ui-board-row-highlight
                           help-echo "TAB: fold or unfold"))
    open))

(defun noema-agent-abtop--panel-line (&rest parts)
  "Insert one panel line made of PARTS between the side borders."
  (let ((width (noema-agent-abtop--width)))
    (insert (propertize "│ " 'face 'noema-agent-abtop-border)
            (apply #'concat parts)
            (propertize " " 'display `(space :align-to ,(- width 1)))
            (propertize "│" 'face 'noema-agent-abtop-border)
            "\n")))

(defun noema-agent-abtop--panel-close ()
  "Insert the bottom border of a panel."
  (insert (propertize (concat "╰" (make-string (- (noema-agent-abtop--width) 2) ?─) "╯")
                      'face 'noema-agent-abtop-border)
          "\n"))

;;; Codex quota, from Codex's own session files

(defvar noema-agent-abtop--codex-cache nil
  "(FILE MTIME . LIMITS) for the Codex session file read last.")

(defun noema-agent-abtop--codex-home ()
  "Return the client's Codex home.
The quota belongs to the account, so the newest session file of any Codex
client on this machine -- the TUI or a codex-acp session -- holds its latest
value; each window shows how old that value is."
  (file-name-as-directory (or (getenv "CODEX_HOME") (expand-file-name "~/.codex"))))

(defun noema-agent-abtop--newest-child (directory &optional regexp)
  "Return the lexically greatest entry of DIRECTORY matching REGEXP."
  (car (last (ignore-errors (directory-files directory t (or regexp "\\`[0-9]+\\'"))))))

(defun noema-agent-abtop--codex-file ()
  "Return the most recently written Codex session file, or nil.
Session files live under sessions/YYYY/MM/DD/, so only the newest day is
listed rather than the whole tree."
  (when-let* ((year (noema-agent-abtop--newest-child
                     (expand-file-name "sessions" (noema-agent-abtop--codex-home))))
              (month (noema-agent-abtop--newest-child year))
              (day (noema-agent-abtop--newest-child month))
              (files (ignore-errors
                       (directory-files day t "\\`rollout-.*\\.jsonl\\'"))))
    (car (sort files #'file-newer-than-file-p))))

(defconst noema-agent-abtop--codex-tail-bytes 131072
  "Bytes read from the end of a Codex session file to find its last quota.")

(defun noema-agent-abtop--codex-parse (text)
  "Return rate-limit plists from the last `token_count' with limits in TEXT."
  (with-temp-buffer
    (insert text)
    (goto-char (point-max))
    (catch 'found
      (while (search-backward "\"rate_limits\":{" nil t)
        (let* ((line (buffer-substring-no-properties (line-beginning-position)
                                                     (line-end-position)))
               (event (ignore-errors
                        (json-parse-string line :object-type 'alist :null-object nil)))
               (limits (map-nested-elt event '(payload rate_limits))))
          (when limits
            (let ((updated (ignore-errors
                             (float-time (date-to-time (map-elt event 'timestamp))))))
              (throw 'found
                     (delq nil
                           (mapcar
                            (lambda (key)
                              (when-let* ((window (map-elt limits key))
                                          (used (map-elt window 'used_percent)))
                                (list :agent "codex"
                                      :window (noema-agent-abtop--window-name
                                               (map-elt window 'window_minutes))
                                      :utilization (/ used 100.0)
                                      :resets-at (map-elt window 'resets_at)
                                      :updated-at updated)))
                            '(primary secondary)))))))
        (beginning-of-line)))))

(defun noema-agent-abtop--codex-limits ()
  "Return Codex rate-limit plists, re-reading only a changed session file."
  (when-let* ((file (noema-agent-abtop--codex-file)))
    (let* ((attributes (file-attributes file))
           (stamp (list file (file-attribute-modification-time attributes)
                        (file-attribute-size attributes))))
      (unless (equal (car noema-agent-abtop--codex-cache) stamp)
        (let ((size (file-attribute-size attributes)))
          (setq noema-agent-abtop--codex-cache
                (cons stamp
                      (noema-agent-abtop--codex-parse
                       (with-temp-buffer
                         (insert-file-contents-literally
                          file nil (max 0 (- size noema-agent-abtop--codex-tail-bytes)) size)
                         (decode-coding-region (point-min) (point-max) 'utf-8)
                         (buffer-string)))))))
      (cdr noema-agent-abtop--codex-cache))))

(defun noema-agent-abtop--claude-window-name (type)
  "Name claude-agent-acp rate-limit TYPE like abtop does."
  (pcase type
    ("five_hour" "5h") ("seven_day" "7d")
    ("seven_day_opus" "7d opus") ("seven_day_sonnet" "7d sonnet")
    (_ (replace-regexp-in-string "_" " " (format "%s" type)))))

;;; Claude quota, from Claude's usage endpoint (explicit refresh only)
;;
;; claude-agent-acp only reports a window during a turn.  On an explicit
;; request -- opening the board or `g' -- and at most every
;; `noema-agent-abtop-claude-usage-interval', ask the endpoint Claude Code's
;; /usage uses.  The OAuth token is read from where Claude Code keeps it, used
;; for this one request and not retained.  It is never refreshed here: that
;; would rotate Claude Code's refresh token and log it out.  This is a
;; client-side account query, so it runs on the client, not on a target.

(defcustom noema-agent-abtop-claude-usage t
  "Whether the board asks Claude's usage endpoint for the Claude quota."
  :type 'boolean
  :group 'noema-agent-session)

(defcustom noema-agent-abtop-claude-usage-interval 300
  "Seconds a fetched Claude quota stays fresh; a refresh sooner reuses it."
  :type 'integer
  :group 'noema-agent-session)

(defconst noema-agent-abtop--claude-usage-url "https://api.anthropic.com/api/oauth/usage")

(defconst noema-agent-abtop--claude-usage-timeout 10
  "Seconds before an unanswered usage request is abandoned.")

(defvar noema-agent-abtop--claude-fetch nil
  "Plist describing the last Claude usage fetch: :running, :at and :error.")

(defun noema-agent-abtop--claude-credentials-file ()
  "Return Claude Code's credential file, used where there is no Keychain."
  (expand-file-name ".credentials.json"
                    (or (getenv "CLAUDE_CONFIG_DIR") (expand-file-name "~/.claude"))))

(defun noema-agent-abtop--claude-token (json)
  "Return the OAuth access token in credential JSON, or signal why not."
  (let* ((oauth (map-elt (json-parse-string json :object-type 'alist) 'claudeAiOauth))
         (token (map-elt oauth 'accessToken))
         (expires (map-elt oauth 'expiresAt)))
    (cond ((not (stringp token)) (error "no Claude login found"))
          ((and (numberp expires) (< (/ expires 1000.0) (float-time)))
           (error "Claude login expired; open Claude Code to renew it"))
          (t token))))

(defun noema-agent-abtop--claude-read-token (callback)
  "Call CALLBACK with the Claude OAuth token, or with nil and a reason.
The macOS Keychain is read by an asynchronous `security' process; elsewhere
Claude Code's credential file is read."
  (let ((default-directory temporary-file-directory))
    (if (not (executable-find "security"))
        (condition-case err
            (funcall callback
                     (noema-agent-abtop--claude-token
                      (with-temp-buffer
                        (insert-file-contents (noema-agent-abtop--claude-credentials-file))
                        (buffer-string))))
          (error (funcall callback nil (error-message-string err))))
      (let ((output (generate-new-buffer " *noema-claude-token*"))
            (errors (generate-new-buffer " *noema-claude-token-stderr*")))
        (condition-case err
            (make-process
             :name "noema-claude-token"
             :buffer output
             :command '("security" "find-generic-password"
                        "-s" "Claude Code-credentials" "-w")
             :connection-type 'pipe
             :noquery t
             :stderr errors
             :sentinel
             (lambda (process _event)
               (unless (process-live-p process)
                 (let ((json (and (buffer-live-p output)
                                  (with-current-buffer output (buffer-string)))))
                   (kill-buffer output)
                   (when (buffer-live-p errors)
                     (let ((kill-buffer-query-functions nil)) (kill-buffer errors)))
                   (if (and (zerop (process-exit-status process)) json)
                       (condition-case err
                           (funcall callback (noema-agent-abtop--claude-token json))
                         (error (funcall callback nil (error-message-string err))))
                     (funcall callback nil "no Claude login in the Keychain"))))))
          (error (kill-buffer output)
                 (kill-buffer errors)
                 (funcall callback nil (error-message-string err))))))))

(defun noema-agent-abtop--claude-record-usage (response)
  "Record the windows in usage endpoint RESPONSE; utilization there is 0-100."
  (dolist (window '(five_hour seven_day seven_day_opus seven_day_sonnet))
    (when-let* ((value (map-elt response window))
                (utilization (map-elt value 'utilization))
                ((numberp utilization)))
      (noema-agent-acp-put-rate-limit
       "claude" (symbol-name window) (/ utilization 100.0)
       :resets-at (let ((resets (map-elt value 'resets_at)))
                    (and (stringp resets)
                         (ignore-errors (float-time (date-to-time resets)))))))))

(defun noema-agent-abtop--claude-fetch-done (error-message)
  "Finish a Claude usage fetch, noting ERROR-MESSAGE, and redraw the board."
  (setq noema-agent-abtop--claude-fetch
        (list :at (float-time) :error error-message))
  (noema-agent-abtop--session-changed nil))

(defun noema-agent-abtop--claude-request (token)
  "Ask the usage endpoint with TOKEN; the token lives only in this request."
  (let* ((url-request-method "GET")
         (url-request-extra-headers
          `(("Authorization" . ,(concat "Bearer " token))
            ("anthropic-beta" . "oauth-2025-04-20")
            ("Content-Type" . "application/json")))
         (finished nil)
         (timer nil)
         (buffer nil))
    (setq buffer
          (condition-case err
              (url-retrieve
               noema-agent-abtop--claude-usage-url
               (lambda (status)
                 (unwind-protect
                     (unless finished
                       (setq finished t)
                       (when (timerp timer) (cancel-timer timer))
                       (condition-case err
                           (if-let* ((problem (plist-get status :error)))
                               (noema-agent-abtop--claude-fetch-done
                                (format "usage request failed: %s" (cadr problem)))
                             (goto-char (point-min))
                             (re-search-forward "\r?\n\r?\n" nil 'move)
                             (noema-agent-abtop--claude-record-usage
                              (json-parse-buffer :object-type 'alist :null-object nil))
                             (noema-agent-abtop--claude-fetch-done nil))
                         (error (noema-agent-abtop--claude-fetch-done
                                 (format "usage reply unreadable: %s" (error-message-string err))))))
                   (kill-buffer (current-buffer))))
               nil t t)
            (error (setq finished t)
                   (noema-agent-abtop--claude-fetch-done
                    (format "usage request failed: %s" (error-message-string err)))
                   nil)))
    (when buffer
      (setq timer
            (run-with-timer
             noema-agent-abtop--claude-usage-timeout nil
             (lambda ()
               (unless finished
                 (setq finished t)
                 (when (buffer-live-p buffer)
                   (let ((process (get-buffer-process buffer)))
                     (when process (delete-process process)))
                   (kill-buffer buffer))
                 (noema-agent-abtop--claude-fetch-done "usage request timed out"))))))))

(defun noema-agent-abtop--claude-fetch (&optional force)
  "Fetch the Claude quota unless a fetch is running or recent; FORCE ignores age."
  (when (and noema-agent-abtop-claude-usage
             (not (plist-get noema-agent-abtop--claude-fetch :running))
             (or force
                 (> (- (float-time) (or (plist-get noema-agent-abtop--claude-fetch :at) 0))
                    noema-agent-abtop-claude-usage-interval)))
    (setq noema-agent-abtop--claude-fetch
          (plist-put (copy-sequence noema-agent-abtop--claude-fetch) :running t))
    (noema-agent-abtop--claude-read-token
     (lambda (token &optional reason)
       (if token
           (noema-agent-abtop--claude-request token)
         (noema-agent-abtop--claude-fetch-done reason))))))

(defun noema-agent-abtop--opencode-auth-file ()
  "Return OpenCode's credential file on this machine."
  (expand-file-name "opencode/auth.json"
                    (or (getenv "XDG_DATA_HOME") (expand-file-name "~/.local/share"))))

(defvar noema-agent-abtop--opencode-cache nil
  "(MTIME . PROVIDERS) for the OpenCode credential file read last.")

(defun noema-agent-abtop--opencode-providers ()
  "Return the provider ids OpenCode is signed in to.
Only the ids are kept; the credentials in the file are never retained."
  (let* ((file (noema-agent-abtop--opencode-auth-file))
         (mtime (file-attribute-modification-time (file-attributes file))))
    (when mtime
      (unless (equal (car noema-agent-abtop--opencode-cache) mtime)
        (setq noema-agent-abtop--opencode-cache
              (cons mtime
                    (ignore-errors
                      (with-temp-buffer
                        (insert-file-contents file)
                        (sort (mapcar (lambda (entry) (symbol-name (car entry)))
                                      (json-parse-buffer :object-type 'alist))
                              #'string<))))))
      (cdr noema-agent-abtop--opencode-cache))))

(defconst noema-agent-abtop--opencode-notes
  '(("openai" . "ChatGPT login: shares the codex quota above")
    ("github-copilot" . "premium requests are only reported by GitHub's API")
    ("anthropic" . "Claude login: shares the claude quota above"))
  "What the quota panel says about each OpenCode provider.")

(defun noema-agent-abtop--quota-group (tool expected limits missing)
  "Return TOOL's quota rows: EXPECTED windows in order, then other LIMITS.
An expected window absent from LIMITS becomes a row noting MISSING."
  (let ((window-of (lambda (limit) (plist-get limit :window))))
    (cons tool
          (append
           (mapcar (lambda (window)
                     (or (cl-find window limits :key window-of :test #'equal)
                         (list :window window :note missing)))
                   expected)
           (sort (cl-remove-if (lambda (limit) (member (funcall window-of limit) expected))
                               limits)
                 (lambda (a b) (string< (funcall window-of a) (funcall window-of b))))))))

(defun noema-agent-abtop--quotas ()
  "Return (TOOL . ROWS) for Claude, Codex and OpenCode, in that order.
Every tool is listed with the windows it is expected to have, so a quota
nobody has reported yet shows as such rather than disappearing."
  (let ((acp (make-hash-table :test #'equal)))
    (maphash (lambda (_key limit)
               (push (plist-put (copy-sequence limit) :window
                                (noema-agent-abtop--claude-window-name
                                 (plist-get limit :window)))
                     (gethash (plist-get limit :agent) acp)))
             (noema-agent-acp-rate-limits))
    (append
     (list (noema-agent-abtop--quota-group
            "claude" '("5h" "7d") (gethash "claude" acp)
            (cond ((plist-get noema-agent-abtop--claude-fetch :running) "asking Claude…")
                  ((plist-get noema-agent-abtop--claude-fetch :error))
                  (t "reported during a turn, or on g")))
           (noema-agent-abtop--quota-group
            "codex" '("5h" "7d") (ignore-errors (noema-agent-abtop--codex-limits))
            "absent from the latest Codex report")
           (cons "opencode"
                 (or (mapcar (lambda (provider)
                               (list :window provider
                                     :note (or (cdr (assoc provider noema-agent-abtop--opencode-notes))
                                               "no local quota source")))
                             (noema-agent-abtop--opencode-providers))
                     (list (list :window "-" :note "not signed in")))))
     ;; An agent reporting limits that this list does not know yet.
     (let (others)
       (maphash (lambda (agent limits)
                  (unless (member agent '("claude" "codex" "opencode"))
                    (push (noema-agent-abtop--quota-group agent nil limits nil) others)))
                acp)
       others))))

;;; Rendering

(defun noema-agent-abtop--sessions ()
  "Return (SESSION . USAGE) for every live session in the board's scope."
  (delq nil
        (mapcar (lambda (session)
                  (when-let* ((usage (noema-agent-acp-usage (plist-get session :buffer))))
                    (cons session usage)))
                (noema-agent-acp-sessions noema-agent-abtop--root))))

(defun noema-agent-abtop--state (buffer)
  "Return (LABEL . FACE) describing what agent BUFFER is doing."
  (let ((queued (noema-agent-acp-pending-prompt-count buffer)))
    (cond ((noema-agent-acp-busy-p buffer)
           (cons (if (> queued 0) (format "● work+%d" queued) "● work")
                 'aaron-ui-board-good))
          ((> queued 0) (cons (format "◐ wait+%d" queued) 'aaron-ui-board-warn))
          (t (cons "○ idle" 'noema-agent-abtop-dim)))))

(defun noema-agent-abtop--quota-line (tool quota now)
  "Insert one quota panel line for QUOTA of TOOL (nil after its first line)."
  (let ((tool (noema-agent-abtop--cell (or tool "") 9 'aaron-ui-board-row-title))
        (window (noema-agent-abtop--cell (plist-get quota :window) 15 'noema-agent-abtop-dim)))
    (if-let* ((note (plist-get quota :note)))
        (noema-agent-abtop--panel-line
         tool window
         (propertize (make-string 20 ?·) 'face 'noema-agent-abtop-border) "      "
         (propertize note 'face 'noema-agent-abtop-faint))
      (let* ((ratio (or (plist-get quota :utilization) 0.0))
             (resets (plist-get quota :resets-at))
             (updated (plist-get quota :updated-at)))
        (noema-agent-abtop--panel-line
         tool window
         (noema-agent-abtop--bar ratio 20) " "
         (noema-agent-abtop--cell (if (plist-get quota :utilization)
                                      (format "%.0f%%" (* 100 ratio))
                                    (format "%s" (or (plist-get quota :status) "?")))
                                  5 (noema-agent-abtop--level ratio) t)
         (propertize (if (and resets (> resets now))
                         (format "  resets %s" (noema-agent-abtop--duration (- resets now)))
                       "")
                     'face 'noema-agent-abtop-dim)
         (propertize (if updated
                         (format "  · %s ago" (noema-agent-abtop--duration (- now updated)))
                       "")
                     'face 'noema-agent-abtop-faint))))))

(defun noema-agent-abtop--insert-quota ()
  "Insert the Quota panel: every tool, every window it should have."
  (when (noema-agent-abtop--panel-open 'quota "quota")
    (let ((now (float-time)))
      (pcase-dolist (`(,tool . ,rows) (noema-agent-abtop--quotas))
        (let ((first t))
          (dolist (quota rows)
            (noema-agent-abtop--quota-line (and first tool) quota now)
            (setq first nil)))))
    (noema-agent-abtop--panel-close)))

(defconst noema-agent-abtop--columns
  '(("" 8) ("Session" 18) ("Project" 12) ("Agent" 8) ("Model" 14)
    ("Context" 16) ("In" 7 t) ("Out" 7 t) ("Cost" 7 t) ("Turn" 5 t)
    ("Cmp" 4 t) ("Idle" 6 t))
  "Sessions table columns: (TITLE WIDTH RIGHT-ALIGNED).")

(defconst noema-agent-abtop--drop-order '(10 3 2 9 11 7 8)
  "Column indexes dropped, in this order, when the window is too narrow.")

(defun noema-agent-abtop--layout ()
  "Return (INDEX WIDTH RIGHT) for the columns that fit the panel.
Columns go in `noema-agent-abtop--drop-order' until the rest fit; spare
width then widens Session and Model."
  (let* ((available (- (noema-agent-abtop--width) 4))
         (columns (cl-loop for (_title width right) in noema-agent-abtop--columns
                           for index from 0
                           collect (list index width right)))
         (used (lambda () (cl-loop for (_ width) in columns sum (1+ width))))
         (drop noema-agent-abtop--drop-order))
    (while (and drop (> (funcall used) available))
      (setq columns (cl-remove (pop drop) columns :key #'car)))
    (let ((spare (- available (funcall used))))
      (dolist (index '(1 4))
        (when-let* ((column (assq index columns))
                    ((> spare 0)))
          (let ((extra (min spare (if (= index 1) 12 8))))
            (cl-incf (nth 1 column) extra)
            (cl-decf spare extra)))))
    columns))

(defun noema-agent-abtop--row-cells (session usage)
  "Return the table cells for SESSION with USAGE."
  (let* ((buffer (plist-get session :buffer))
         (root (plist-get session :root))
         (state (noema-agent-abtop--state buffer))
         (used (plist-get usage :context-used))
         (size (plist-get usage :context-size))
         (ratio (if (> size 0) (/ (float used) size) 0.0))
         (last-used (plist-get session :last-used)))
    (list (cons (car state) (cdr state))
          (cons (or (plist-get session :name) (buffer-name buffer)) 'aaron-ui-board-row-title)
          (cons (if root (file-name-nondirectory (directory-file-name root)) "-")
                'noema-agent-abtop-dim)
          (cons (format "%s" (or (plist-get session :agent) "-")) 'noema-agent-abtop-dim)
          (cons (or (plist-get usage :model) (plist-get usage :model-id) "-") nil)
          (if (> size 0)
              (concat (noema-agent-abtop--bar ratio 10)
                      (propertize (format " %3.0f%%" (* 100 ratio))
                                  'face (noema-agent-abtop--level ratio)))
            (cons (noema-agent-abtop--tokens used) 'noema-agent-abtop-dim))
          (cons (noema-agent-abtop--tokens (plist-get usage :input)) nil)
          (cons (noema-agent-abtop--tokens (plist-get usage :output)) nil)
          (cons (noema-agent-abtop--cost (plist-get usage :cost) (plist-get usage :currency)) nil)
          (cons (number-to-string (plist-get usage :turns)) 'noema-agent-abtop-dim)
          (let ((count (plist-get usage :compactions)))
            (cons (if (> count 0) (number-to-string count) "-")
                  (if (> count 0) 'aaron-ui-board-warn 'noema-agent-abtop-dim)))
          (cons (if (numberp last-used)
                    (noema-agent-abtop--duration (- (float-time) last-used))
                  "-")
                'noema-agent-abtop-dim))))

(defun noema-agent-abtop--format-row (cells layout)
  "Lay out CELLS in the columns of LAYOUT, from `noema-agent-abtop--layout'."
  (mapconcat
   (pcase-lambda (`(,index ,width ,right))
     (let ((cell (nth index cells)))
       (if (stringp cell)
           ;; A pre-rendered cell (the context bar) is exact width.
           (concat cell (make-string (max 0 (- width (string-width cell))) ?\s))
         (noema-agent-abtop--cell (car cell) width (cdr cell) right))))
   layout " "))

(defun noema-agent-abtop--insert-sessions (rows)
  "Insert the Sessions panel for ROWS."
  (when (noema-agent-abtop--panel-open
         'sessions (format "sessions %d" (length rows))
         (if noema-agent-abtop--root
             (abbreviate-file-name noema-agent-abtop--root)
           "all projects"))
  (let ((layout (noema-agent-abtop--layout)))
    (noema-agent-abtop--panel-line
     (noema-agent-abtop--format-row
      (mapcar (lambda (column) (cons (car column) 'noema-agent-abtop-dim))
              noema-agent-abtop--columns)
      layout))
    (if (null rows)
        (noema-agent-abtop--panel-line
         (propertize "No live agent sessions" 'face 'aaron-ui-board-empty))
      (pcase-dolist (`(,session . ,usage) rows)
        (let ((start (point))
              (buffer (plist-get session :buffer)))
          (noema-agent-abtop--panel-line
           (noema-agent-abtop--format-row
            (noema-agent-abtop--row-cells session usage) layout))
          (add-text-properties
           start (point)
           `(aaron-ui-board--item-id ,buffer
             aaron-ui-board--row-action ,(lambda (_) (noema-agent-abtop--visit buffer))
             mouse-face aaron-ui-board-row-highlight
             help-echo "RET: open session"
             keymap ,aaron-ui-board-row-map))))))
  (let ((input 0) (output 0) (costs nil))
    (pcase-dolist (`(,_ . ,usage) rows)
      (cl-incf input (plist-get usage :input))
      (cl-incf output (plist-get usage :output))
      (when-let* ((amount (plist-get usage :cost)))
        (let ((cell (assoc (plist-get usage :currency) costs)))
          (if cell (cl-incf (cdr cell) amount)
            (push (cons (plist-get usage :currency) amount) costs)))))
    (noema-agent-abtop--panel-line
     (propertize (format "total  in %s · out %s%s"
                         (noema-agent-abtop--tokens input)
                         (noema-agent-abtop--tokens output)
                         (mapconcat (lambda (cell)
                                      (concat " · " (noema-agent-abtop--cost (cdr cell) (car cell))))
                                    costs ""))
                 'face 'noema-agent-abtop-dim)))
  (noema-agent-abtop--panel-close)))

(defun noema-agent-abtop--field (label value &optional face)
  "Return a detail field LABEL: VALUE."
  (concat (propertize (format "%-9s" label) 'face 'noema-agent-abtop-dim)
          (propertize (format "%s" value) 'face (or face 'aaron-ui-board-row-title))))

(defun noema-agent-abtop--insert-detail (row)
  "Insert the Detail panel for ROW, a (SESSION . USAGE), or nothing."
  (when row
    (pcase-let* ((`(,session . ,usage) row)
                 (buffer (plist-get session :buffer))
                 (used (plist-get usage :context-used))
                 (size (plist-get usage :context-size))
                 (ratio (if (> size 0) (/ (float used) size) 0.0)))
      (when (noema-agent-abtop--panel-open
             'session
             (format "session %s" (or (plist-get session :name) (buffer-name buffer)))
             (format "%s · %s" (or (plist-get session :origin) "-")
                     (or (plist-get session :native-session-id) "no session id")))
      (noema-agent-abtop--panel-line
       (noema-agent-abtop--field "model" (or (plist-get usage :model)
                                             (plist-get usage :model-id) "-"))
       "   "
       (noema-agent-abtop--field "state" (car (noema-agent-abtop--state buffer))
                                 (cdr (noema-agent-abtop--state buffer))))
      (noema-agent-abtop--panel-line
       (noema-agent-abtop--field "root" (abbreviate-file-name
                                         (or (plist-get session :root) "-"))
                                 'noema-agent-abtop-faint))
      (noema-agent-abtop--panel-line
       (noema-agent-abtop--field "context" "")
       (noema-agent-abtop--bar ratio 30)
       (propertize (format " %s / %s" (noema-agent-abtop--tokens used)
                           (if (> size 0) (noema-agent-abtop--tokens size) "?"))
                   'face (noema-agent-abtop--level ratio))
       (propertize (format "   peak %s · %d compaction%s"
                           (noema-agent-abtop--tokens (plist-get usage :context-peak))
                           (plist-get usage :compactions)
                           (if (= 1 (plist-get usage :compactions)) "" "s"))
                   'face 'noema-agent-abtop-dim))
      (noema-agent-abtop--panel-line
       (noema-agent-abtop--field
        "tokens"
        (format "in %s · out %s · thought %s · cache r %s w %s · total %s"
                (noema-agent-abtop--tokens (plist-get usage :input))
                (noema-agent-abtop--tokens (plist-get usage :output))
                (noema-agent-abtop--tokens (plist-get usage :thought))
                (noema-agent-abtop--tokens (plist-get usage :cached-read))
                (noema-agent-abtop--tokens (plist-get usage :cached-write))
                (noema-agent-abtop--tokens (plist-get usage :total)))))
      (noema-agent-abtop--panel-line
       (noema-agent-abtop--field "cost" (noema-agent-abtop--cost (plist-get usage :cost)
                                                                 (plist-get usage :currency)))
       "   "
       (noema-agent-abtop--field "turns" (plist-get usage :turns))
       "   "
       (noema-agent-abtop--field "queued" (noema-agent-acp-pending-prompt-count buffer)))
      (noema-agent-abtop--panel-close)))))

(defconst noema-agent-abtop--key-hints
  '(("RET" . "open") ("s" . "stop") ("K" . "kill") ("x" . "close")
    ("R" . "restart") ("r" . "rename") ("C" . "compact") ("l" . "sessions")
    ("TAB" . "fold") ("t" . "scope") ("g" . "refresh"))
  "Keys shown under the board.")

(defun noema-agent-abtop--insert-key-hints ()
  "Insert the key-hint line."
  (insert " "
          (mapconcat (pcase-lambda (`(,key . ,label))
                       (concat (propertize key 'face 'noema-agent-abtop-key) " "
                               (propertize label 'face 'noema-agent-abtop-dim)))
                     noema-agent-abtop--key-hints "  ")
          "\n"))

(defun noema-agent-abtop--render ()
  "Render the whole board into the current buffer."
  (noema-agent-abtop--apply-faces)
  (let* ((rows (noema-agent-abtop--sessions))
         (id (get-text-property (point) 'aaron-ui-board--item-id))
         (current (or (assq id (mapcar (lambda (row) (cons (plist-get (car row) :buffer) row))
                                       rows))
                      (and rows (cons nil (car rows))))))
    (setq noema-agent-abtop--shown-id (and current (plist-get (cadr current) :buffer)))
    (aaron-ui-board-set-header
     "Agent Top" 'process
     (format "%d session%s · %d busy · %s"
             (length rows) (if (= 1 (length rows)) "" "s")
             (cl-count-if (lambda (row) (plist-get (car row) :busy)) rows)
             (format-time-string "%H:%M:%S")))
    (aaron-ui-board-render
     (lambda ()
       (noema-agent-abtop--insert-quota)
       (noema-agent-abtop--insert-sessions rows)
       (noema-agent-abtop--insert-detail (cdr current))
       (noema-agent-abtop--insert-key-hints)))
    (unless (get-text-property (point) 'aaron-ui-board--item-id)
      (aaron-ui-board--goto-item-id noema-agent-abtop--shown-id))))

(defun noema-agent-abtop-refresh ()
  "Re-render the board."
  (interactive)
  (when (derived-mode-p 'noema-agent-abtop-mode)
    (noema-agent-abtop--render)))

(defun noema-agent-abtop-reload ()
  "Re-render the board, first asking for the Claude quota if it is stale."
  (interactive)
  (noema-agent-abtop--claude-fetch)
  (noema-agent-abtop-refresh))

(defun noema-agent-abtop--follow-point ()
  "Re-render when point moves to another session, so the detail follows it."
  (let ((id (get-text-property (point) 'aaron-ui-board--item-id)))
    (when (and id (not (eq id noema-agent-abtop--shown-id)))
      (noema-agent-abtop--render))))

;;; Event-driven refresh

(defun noema-agent-abtop--visible-window (board)
  "Return a window on a visible frame showing BOARD, or nil."
  (get-buffer-window board 'visible))

(defun noema-agent-abtop--session-changed (_buffer)
  "Schedule one render of the board after a session changed.
A board nobody can see stops listening until it is shown again (see
`noema-agent-abtop--shown'), so a hidden board costs nothing."
  (let ((board (get-buffer noema-agent-abtop--buffer-name)))
    (cond ((not (and board (noema-agent-abtop--visible-window board)))
           (remove-hook 'noema-agent-acp-changed-functions
                        #'noema-agent-abtop--session-changed))
          ((not noema-agent-abtop--refresh-timer)
           (setq noema-agent-abtop--refresh-timer
                 (run-with-timer noema-agent-abtop--refresh-delay nil
                                 #'noema-agent-abtop--timer-fire))))))

(defun noema-agent-abtop--shown (_window)
  "The board appeared in a window: listen again and catch up once."
  (unless (memq #'noema-agent-abtop--session-changed noema-agent-acp-changed-functions)
    (add-hook 'noema-agent-acp-changed-functions #'noema-agent-abtop--session-changed)
    (noema-agent-abtop--session-changed nil)))

(defun noema-agent-abtop--timer-fire ()
  "Render the board once for the usage reports gathered since scheduling."
  (setq noema-agent-abtop--refresh-timer nil)
  (when-let* ((board (get-buffer noema-agent-abtop--buffer-name)))
    ;; Render in the board's window so point and window point agree and
    ;; the row under the cursor survives the redraw.
    (if-let* ((window (noema-agent-abtop--visible-window board)))
        (with-selected-window window (noema-agent-abtop-refresh))
      (with-current-buffer board (noema-agent-abtop-refresh)))))

(defun noema-agent-abtop--teardown ()
  "Stop listening for session changes when the board buffer goes."
  (remove-hook 'noema-agent-acp-changed-functions #'noema-agent-abtop--session-changed)
  (when (timerp noema-agent-abtop--refresh-timer)
    (cancel-timer noema-agent-abtop--refresh-timer))
  (setq noema-agent-abtop--refresh-timer nil))

;;; Actions

(defun noema-agent-abtop--session-at-point ()
  "Return the session on this line, else the one in the detail panel."
  (let ((buffer (or (get-text-property (point) 'aaron-ui-board--item-id)
                    noema-agent-abtop--shown-id)))
    (unless (buffer-live-p buffer)
      (user-error "No live agent session; press g to refresh"))
    buffer))

(defmacro noema-agent-abtop--define-action (name doc &rest body)
  "Define board command NAME with DOC running BODY with `buffer' bound."
  (declare (indent 2) (doc-string 2))
  `(defun ,name ()
     ,doc
     (interactive)
     (let ((buffer (noema-agent-abtop--session-at-point)))
       ,@body
       (noema-agent-abtop-refresh))))

(defun noema-agent-abtop--visit (buffer)
  "Show agent BUFFER."
  (unless (buffer-live-p buffer)
    (user-error "That session has ended; press g to refresh"))
  (noema-agent-acp-show-buffer buffer))

(defun noema-agent-abtop-visit ()
  "Show the session on this line."
  (interactive)
  (noema-agent-abtop--visit (noema-agent-abtop--session-at-point)))

(noema-agent-abtop--define-action noema-agent-abtop-stop
    "Stop the session's current work: cancel its Run, else interrupt its turn."
  (noema-agent-acp-stop buffer))

(noema-agent-abtop--define-action noema-agent-abtop-kill
    "Force-terminate the session on this line: its process and buffer go."
  (when (yes-or-no-p (format "Kill agent session %s%s? "
                             (buffer-name buffer)
                             (if (noema-agent-acp-busy-p buffer) " (busy)" "")))
    (noema-agent-acp-kill buffer)))

(noema-agent-abtop--define-action noema-agent-abtop-close
    "Close the session on this line; its name and history remain."
  (noema-agent-acp-close buffer))

(noema-agent-abtop--define-action noema-agent-abtop-restart
    "Restart the session on this line."
  (require 'noema-sessions)
  (noema-sessions-agent-restart buffer))

(noema-agent-abtop--define-action noema-agent-abtop-rename
    "Rename the session on this line."
  (require 'noema-sessions)
  (noema-sessions-agent-rename buffer))

(noema-agent-abtop--define-action noema-agent-abtop-compact
    "Roll the session on this line over to its latest handoff at its next Run."
  (require 'noema-agent-worker)
  (noema-agent-worker-compact-session buffer))

(defun noema-agent-abtop-sessions ()
  "Open the session list of the project of the session on this line."
  (interactive)
  (require 'noema-sessions)
  (noema-sessions-agent-list (noema-agent-abtop--session-at-point)))

(defun noema-agent-abtop-toggle-scope ()
  "Toggle between every live session and those of one project."
  (interactive)
  (setq noema-agent-abtop--root
        (unless noema-agent-abtop--root
          (let ((buffer (get-text-property (point) 'aaron-ui-board--item-id)))
            (or (and (buffer-live-p buffer)
                     (buffer-local-value 'noema-agent-acp-session-root buffer))
                (noema-agent-acp-project-root default-directory)))))
  (noema-agent-abtop-refresh))

(defun noema-agent-abtop-toggle-panel (&optional panel)
  "Fold or unfold PANEL, by default the one whose title is on this line.
Elsewhere, move to the next session row."
  (interactive)
  (if-let* ((panel (or panel (get-text-property (point) 'noema-agent-abtop--panel))))
      (progn
        (setq noema-agent-abtop--folded
              (if (memq panel noema-agent-abtop--folded)
                  (delq panel noema-agent-abtop--folded)
                (cons panel noema-agent-abtop--folded)))
        (noema-agent-abtop-refresh))
    (noema-agent-abtop-next-session)))

(defun noema-agent-abtop-next-session ()
  "Move to the next session row, wrapping to the first."
  (interactive)
  (let* ((here (get-text-property (point) 'aaron-ui-board--item-id))
         (next (or (text-property-not-all
                    (or (next-single-property-change (point) 'aaron-ui-board--item-id)
                        (point-max))
                    (point-max) 'aaron-ui-board--item-id nil)
                   (text-property-not-all (point-min) (point-max)
                                          'aaron-ui-board--item-id nil))))
    (when (and next (not (eq here (get-text-property next 'aaron-ui-board--item-id))))
      (goto-char next))))

(defvar-keymap noema-agent-abtop-mode-map
  :parent aaron-ui-board-mode-map
  "RET" #'noema-agent-abtop-visit
  "<return>" #'noema-agent-abtop-visit
  "o" #'noema-agent-abtop-visit
  "s" #'noema-agent-abtop-stop
  "K" #'noema-agent-abtop-kill
  "x" #'noema-agent-abtop-close
  "R" #'noema-agent-abtop-restart
  "r" #'noema-agent-abtop-rename
  "C" #'noema-agent-abtop-compact
  "l" #'noema-agent-abtop-sessions
  "t" #'noema-agent-abtop-toggle-scope
  "TAB" #'noema-agent-abtop-toggle-panel
  "<tab>" #'noema-agent-abtop-toggle-panel
  "1" (lambda () (interactive) (noema-agent-abtop-toggle-panel 'quota))
  "2" (lambda () (interactive) (noema-agent-abtop-toggle-panel 'sessions))
  "3" (lambda () (interactive) (noema-agent-abtop-toggle-panel 'session)))

(define-derived-mode noema-agent-abtop-mode aaron-ui-board-mode "Agent-Top"
  "Live agent sessions: quota, model, state, context, tokens, cost.
\\{noema-agent-abtop-mode-map}"
  (setq-local aaron-ui-board-refresh-function #'noema-agent-abtop-reload)
  (add-hook 'window-buffer-change-functions #'noema-agent-abtop--shown nil t)
  (setq-local truncate-lines t)
  (add-hook 'post-command-hook #'noema-agent-abtop--follow-point nil t)
  (add-hook 'kill-buffer-hook #'noema-agent-abtop--teardown nil t)
  (add-hook 'noema-agent-acp-changed-functions #'noema-agent-abtop--session-changed))

;;;###autoload
(defun noema-agent-abtop (&optional project)
  "Show every live agent session: quota, model, context, tokens and cost.
With prefix argument PROJECT, show only the current project's sessions."
  (interactive "P")
  (let ((root (and project (noema-agent-acp-project-root default-directory)))
        (buffer (get-buffer-create noema-agent-abtop--buffer-name)))
    (pop-to-buffer buffer)
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-agent-abtop-mode)
        (noema-agent-abtop-mode))
      (setq noema-agent-abtop--root root)
      (noema-agent-abtop--claude-fetch)
      (noema-agent-abtop--render)
      (aaron-ui-board--goto-item-id noema-agent-abtop--shown-id))))

(provide 'noema-agent-abtop)
;;; noema-agent-abtop.el ends here
