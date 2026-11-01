;;; noema-project-graph.el --- A Project's Agent cache on one page -*- lexical-binding: t; -*-

;;; Commentary:
;; Agents keep a Project's task graph in `.agent/tasks/', and its cache and
;; memory have their own owners.  This page parses them on request: open it to
;; look, close it and nothing keeps running.  It holds no state and draws what
;; `agent:project:status', `agent:project:graph' and `agent:pi:watch' answer, so
;; a person and an Agent read one answer.  The writes are the conservative
;; maintenance Agents call and a person's stop on Pi's watches.
;; Contract: docs/noema/design/project-graph.md, docs/design/pi-watches.md.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'noema-api)

(declare-function +noema-api-call "noema/bridge/config" (channel args callback &optional timeout))
(declare-function +noema--ensure-server "noema/bridge/config" (&optional callback))

(defconst noema-project-graph--journal-length 20
  "How many journal events the page shows.")

(defconst noema-project-graph--glyphs
  '(("ready" "○" success) ("waiting" "·" shadow) ("claimed" "◐" warning)
    ("stale_claim" "◌" error) ("awaiting_review" "◑" warning) ("blocked" "✕" error)
    ("blocked_by_dependency" "✕" error) ("cycle" "!" error) ("done" "●" shadow)
    ("dropped" "–" shadow))
  "Glyph and face of each task phase.")

(defvar-local noema-project-graph--root nil "Path this page reads.")
(defvar-local noema-project-graph--generation 0 "Latest refresh; older answers are dropped.")
(defvar-local noema-project-graph--responses nil "Answers of the latest refresh.")
(defvar noema-project-graph--serial 0 "Monotonic refresh id across buffers.")

(defun noema-project-graph--bytes (value)
  "Format byte count VALUE."
  (if (numberp value) (file-size-human-readable value) "?"))

(defun noema-project-graph--heading (text)
  "Insert section heading TEXT."
  (insert (propertize text 'face 'bold) "\n"))

(defun noema-project-graph--render-resources (status)
  "Insert the cache and memory part of STATUS."
  (noema-project-graph--heading "Cache and memory")
  (let ((cache (noema--value status "cache"))
        (memory (noema--value status "memory")))
    (if cache
        (insert (format "  Cache   %s%s\n"
                        (noema-project-graph--bytes (noema--value cache "totalBytes"))
                        (if (eq (noema--value cache "pressure") t)
                            (propertize "  under pressure; m maintains" 'face 'warning) "")))
      (insert "  Cache   nothing has run here\n"))
    (insert (format "  Memory  %s\n\n" (or (noema--value memory "state") "unknown")))))

(defun noema-project-graph--render-row (row)
  "Insert graph ROW, whose line opens its task file."
  (let* ((phase (noema--value row "phase"))
         (look (or (cdr (assoc phase noema-project-graph--glyphs)) '("?" default)))
         (detail (delq nil (list phase
                                 (let ((holder (noema--value row "holder")))
                                   (and holder (not (string-empty-p holder)) holder))
                                 (let ((on (noema--sequence (noema--value row "on"))))
                                   (and on (concat "on " (string-join on ", "))))
                                 (let ((also (noema--sequence (noema--value row "also"))))
                                   (and also (concat "also after " (string-join also ", ")))))))
         (start (point)))
    (insert "  " (noema--value row "prefix")
            (propertize (car look) 'face (cadr look)) " "
            (propertize (noema--value row "id") 'face 'font-lock-constant-face)
            "  " (noema--value row "title") "  "
            (propertize (string-join detail " · ") 'face 'shadow) "\n")
    (put-text-property start (point) 'noema-project-graph-file (noema--value row "file"))))

(defun noema-project-graph--render-graph (graph)
  "Insert the task GRAPH."
  (noema-project-graph--heading "Task graph")
  (if (or (null graph) (eq (noema--value graph "store") :json-false)
          (null (noema--sequence (noema--value graph "rows"))))
      (insert "  No task graph yet; Agents create it with the noema-project-graph pack.\n\n")
    (insert (format "  %s\n" (or (noema--value graph "advice") "")))
    (mapc #'noema-project-graph--render-row (noema--sequence (noema--value graph "rows")))
    (insert "\n")))

(defun noema-project-graph--render-findings (status)
  "Insert the graph findings carried by STATUS."
  (let* ((check (noema--value (noema--value status "graph") "check"))
         (errors (noema--sequence (noema--value check "errors")))
         (warnings (noema--sequence (noema--value check "warnings"))))
    (when (or errors warnings)
      (noema-project-graph--heading "Findings")
      (dolist (group `((,errors . error) (,warnings . warning)))
        (dolist (finding (car group))
          (insert "  " (propertize (noema--value finding "code") 'face (cdr group))
                  (let ((task (noema--value finding "task"))) (if task (concat " " task) ""))
                  "  " (or (noema--value finding "fix") "") "\n")))
      (insert "\n"))))

(defun noema-project-graph--render-journal (timeline)
  "Insert the newest events of TIMELINE."
  (when-let* ((events (noema--sequence (noema--value timeline "events"))))
    (noema-project-graph--heading "Journal")
    (dolist (event events)
      (insert (format "  %s  %-8s %-14s %s %s\n"
                      (format-time-string "%m-%d %H:%M"
                                          (/ (or (noema--value event "at") 0) 1000))
                      (or (noema--value event "kind") "")
                      (or (noema--value event "agent") "")
                      (or (noema--value event "task") "")
                      (let ((text (noema--value event "text")))
                        (if (and text (not (string-empty-p text))) text
                          (string-join (noema--sequence (noema--value event "refs")) " "))))))))

(defun noema-project-graph--render-watches (watches)
  "Insert Pi's armed WATCHES and their findings."
  (let ((armed (noema--sequence (noema--value watches "armed")))
        (findings (noema--sequence (noema--value watches "findings"))))
    (when (or armed findings)
      (noema-project-graph--heading "Watches")
      (when (eq (noema--value watches "paused") t)
        (insert (propertize "  Paused; p resumes\n" 'face 'warning)))
      (dolist (watch armed)
        (let ((start (point)) (next (noema--value watch "nextAt")))
          (insert "  " (propertize (noema--value watch "id") 'face 'font-lock-constant-face)
                  "  " (or (noema--value watch "why") "") "  "
                  (propertize (format "%s → %s%s" (noema--value watch "when") (noema--value watch "action")
                                      (if (numberp next)
                                          (format-time-string " · next %m-%d %H:%M" (/ next 1000)) ""))
                              'face 'shadow)
                  "\n")
          (put-text-property start (point) 'noema-project-graph-watch (noema--value watch "id"))))
      (dolist (finding findings)
        (insert "  " (propertize (noema--value finding "code") 'face 'warning)
                (let ((id (noema--value finding "id"))) (if id (concat " " id) ""))
                "  " (or (noema--value finding "fix") "") "\n"))
      (insert "\n"))))

(defun noema-project-graph--render ()
  "Draw the latest answers, keeping point's line."
  (let ((inhibit-read-only t)
        (line (line-number-at-pos))
        (responses noema-project-graph--responses))
    (erase-buffer)
    (let* ((status (gethash 'status responses))
           (graph (gethash 'graph responses))
           (root (or (noema--value graph "root") noema-project-graph--root)))
      (insert (propertize (format "Agent cache · %s\n"
                                  (file-name-nondirectory (directory-file-name root)))
                          'face '(:height 1.2 :weight bold))
              root "\n\n")
      (when status (noema-project-graph--render-resources status))
      (noema-project-graph--render-graph graph)
      (when status (noema-project-graph--render-findings status))
      (noema-project-graph--render-watches (gethash 'watches responses))
      (noema-project-graph--render-journal (gethash 'timeline responses))
      (dolist (name '(status graph timeline watches))
        (when-let* ((failure (gethash (intern (format "%s-error" name)) responses)))
          (insert (propertize (format "%s: %s\n" name (or (noema--value failure "message") "unavailable"))
                              'face 'error)))))
    (goto-char (point-min))
    (forward-line (1- line))))

(defun noema-project-graph-refresh ()
  "Parse the Project's cache again."
  (interactive)
  (let ((buffer (current-buffer))
        (root noema-project-graph--root)
        (generation (cl-incf noema-project-graph--serial)))
    (setq noema-project-graph--generation generation
          noema-project-graph--responses (make-hash-table :test 'eq))
    (pcase-dolist (`(,name ,channel . ,fields)
                   `((status "noema:api:agent:project:status")
                     (graph "noema:api:agent:project:graph" (op . "graph"))
                     (timeline "noema:api:agent:project:graph" (op . "timeline")
                               (limit . ,noema-project-graph--journal-length))
                     (watches "noema:api:agent:pi:watch" (op . "list"))))
      (+noema-api-call
       channel (vector `((root . ,root) ,@fields))
       (lambda (result failure)
         (when (and (buffer-live-p buffer)
                    (eql generation (buffer-local-value 'noema-project-graph--generation buffer)))
           (with-current-buffer buffer
             (puthash (if failure (intern (format "%s-error" name)) name)
                      (or failure result) noema-project-graph--responses)
             (noema-project-graph--render))))
       30))))

(defun noema-project-graph-open ()
  "Open the task file on this line."
  (interactive)
  (if-let* ((file (get-text-property (point) 'noema-project-graph-file)))
      (find-file-other-window file)
    (user-error "No task on this line")))

(defun noema-project-graph-maintain ()
  "Run the Project's conservative cache maintenance, then refresh."
  (interactive)
  (let ((buffer (current-buffer)))
    (+noema-api-call
     "noema:api:agent:project:maintain" (vector `((root . ,noema-project-graph--root)))
     (lambda (_result failure)
       (when failure (message "Maintenance failed: %s" (noema--value failure "message")))
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-project-graph-refresh))))
     60)))

(defun noema-project-graph--watch-call (body)
  "Change Pi's watches with BODY, then refresh."
  (let ((buffer (current-buffer)))
    (+noema-api-call
     "noema:api:agent:pi:watch" (vector `((root . ,noema-project-graph--root) ,@body))
     (lambda (_result failure)
       (when failure (message "Watches: %s" (noema--value failure "message")))
       (when (buffer-live-p buffer)
         (with-current-buffer buffer (noema-project-graph-refresh)))))))

(defun noema-project-graph-cancel-watch ()
  "Cancel Pi's watch on this line."
  (interactive)
  (if-let* ((id (get-text-property (point) 'noema-project-graph-watch)))
      (noema-project-graph--watch-call `((op . "cancel") (id . ,id) (agent . "person")))
    (user-error "No watch on this line")))

(defun noema-project-graph-toggle-watches ()
  "Pause this Project's watches, or resume them."
  (interactive)
  (let ((paused (noema--value (gethash 'watches noema-project-graph--responses) "paused")))
    (noema-project-graph--watch-call `((op . ,(if (eq paused t) "resume" "pause"))))))

(defvar noema-project-graph-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-project-graph-refresh)
    (define-key map (kbd "RET") #'noema-project-graph-open)
    (define-key map (kbd "m") #'noema-project-graph-maintain)
    (define-key map (kbd "x") #'noema-project-graph-cancel-watch)
    (define-key map (kbd "p") #'noema-project-graph-toggle-watches)
    map))

(define-derived-mode noema-project-graph-mode special-mode "Noema-Agent-Cache"
  "One Project's Agent cache, task graph and journal."
  (setq-local revert-buffer-function (lambda (&rest _) (noema-project-graph-refresh))))

;;;###autoload
(defun noema-project-graph (&optional directory)
  "Show the Agent cache of the Project around DIRECTORY."
  (interactive)
  (let* ((root (expand-file-name (or (noema-current-project (or directory default-directory))
                                     directory default-directory)))
         (buffer (get-buffer-create
                  (format "*Noema Agent Cache: %s <%s>*"
                          (file-name-nondirectory (directory-file-name root))
                          (substring (secure-hash 'sha256 root) 0 8)))))
    (with-current-buffer buffer
      (noema-project-graph-mode)
      (setq noema-project-graph--root root
            default-directory root))
    (pop-to-buffer buffer)
    (let ((refresh (lambda () (when (buffer-live-p buffer)
                                (with-current-buffer buffer (noema-project-graph-refresh))))))
      (if (fboundp '+noema--ensure-server) (+noema--ensure-server refresh) (funcall refresh)))
    buffer))

(provide 'noema-project-graph)
;;; noema-project-graph.el ends here
