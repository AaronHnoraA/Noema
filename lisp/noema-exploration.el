;;; noema-exploration.el --- A Project's explorations on one page -*- lexical-binding: t; -*-

;;; Commentary:
;; An exploration puts several background Agents on one mathematical problem,
;; each on its own direction, and the session that started it judges their
;; reports (`noema:api:agent:exploration').  Its thinking is Markdown in the
;; Project's `explorations/<id>/': problem.md, one notebook per member and
;; summary.md, so every page here opens as an ordinary Noema note.
;;
;; This page draws what the API answers and holds no state: open it to look,
;; close it and nothing keeps running (the host keeps each exploration's clock).
;; A person may decide a waiting report here; the verdict is recorded as the
;; person's.  `noema-exploration-start' starts one judged by an agent-shell
;; session.  Contract: docs/noema/design/math-exploration.md.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'noema-api)

(declare-function +noema-api-call "noema/bridge/config" (channel args callback &optional timeout))
(declare-function +noema--ensure-server "noema/bridge/config" (&optional callback))
(declare-function +agent-acp-agent-buffer-p "tools/agent/acp" (buffer))
(declare-function +agent-pool-buffers "tools/agent/acp" (&optional root target kind))
(declare-function +agent-session-snapshot "tools/agent/acp" (buffer))
(declare-function +agent/api "tools/agent/api" (body))

(defconst noema-exploration--glyphs
  '(("open" "○" success) ("waiting" "◑" warning) ("succeeded" "●" success)
    ("dead" "✕" error) ("abandoned" "–" shadow))
  "Glyph and face of each direction state.")

(defvar-local noema-exploration--root nil "Project this page reads.")
(defvar-local noema-exploration--generation 0 "Latest refresh; older answers are dropped.")
(defvar-local noema-exploration--rows nil "Explorations of the latest refresh, with their status.")
(defvar noema-exploration--serial 0 "Monotonic refresh id across buffers.")

(defun noema-exploration--call (body callback &optional timeout)
  "Send BODY to the exploration API and call CALLBACK with (RESULT FAILURE)."
  (+noema-api-call "noema:api:agent:exploration" (vector body) callback (or timeout 60)))

(defun noema-exploration--minutes (row)
  "Describe ROW's time left or its outcome."
  (let ((state (noema--value row "state")))
    (pcase state
      ("running" (format "%s min left" (or (noema--value row "minutesLeft") "?")))
      ("ended" (format "ended %s" (or (noema--value row "outcome") "")))
      (_ state))))

(defun noema-exploration--put (start property value)
  "Give the text from START to point PROPERTY VALUE."
  (put-text-property start (point) property value))

(defun noema-exploration--render-one (status)
  "Insert one exploration's STATUS: its files, members and directions."
  (let* ((id (noema--value status "id"))
         (dir (noema--value status "dir"))
         (start (point)))
    (insert (propertize (noema--value status "title") 'face 'bold) "  "
            (propertize (format "%s · %s" id (noema-exploration--minutes status)) 'face 'shadow) "\n")
    (noema-exploration--put start 'noema-exploration-file (expand-file-name "problem.md" dir))
    (noema-exploration--put start 'noema-exploration-id id)
    (when (equal (noema--value status "state") "ended")
      (let ((line (point)))
        (insert "  summary.md\n")
        (noema-exploration--put line 'noema-exploration-file (expand-file-name "summary.md" dir))
        (noema-exploration--put line 'noema-exploration-id id)))
    (when-let* ((advice (noema--value status "advice")))
      (insert "  " (propertize advice 'face 'warning) "\n"))
    (dolist (member (noema--sequence (noema--value status "members")))
      (let ((line (point))
            (name (noema--value member "name")))
        (insert (format "  %-3s %-8s %s%s\n" name (noema--value member "state")
                        (or (noema--value member "direction") "")
                        (cond ((eq (noema--value member "lost") t) "  (session gone)")
                              ((eq (noema--value member "idle") t) "  (run ended)")
                              (t ""))))
        (noema-exploration--put line 'noema-exploration-file (noema--value member "notebook"))
        (noema-exploration--put line 'noema-exploration-id id)
        (noema-exploration--put line 'noema-exploration-member name)))
    (dolist (direction (noema--sequence (noema--value status "directions")))
      (let* ((state (noema--value direction "state"))
             (look (or (cdr (assoc state noema-exploration--glyphs)) '("?" default)))
             (member (noema--value direction "member"))
             (line (point)))
        (insert "  " (propertize (car look) 'face (cadr look)) " "
                (propertize (noema--value direction "id") 'face 'font-lock-constant-face) " "
                (truncate-string-to-width (replace-regexp-in-string "\n" " " (noema--value direction "text")) 72 nil nil "…")
                (propertize (format "  %s%s" member (if (eq (noema--value direction "stalled") t) " · stalled" ""))
                            'face 'shadow)
                "\n")
        (when (equal state "waiting")
          (let ((report (noema--value (car (last (noema--sequence (noema--value direction "reports")))) "report")))
            (insert (propertize (concat "      " (truncate-string-to-width (replace-regexp-in-string "\n" " " (or report "")) 100 nil nil "…")
                                        "  — a accept, r reject\n")
                                'face 'warning))))
        (noema-exploration--put line 'noema-exploration-file
                                (expand-file-name (concat member ".md") dir))
        (noema-exploration--put line 'noema-exploration-id id)
        (noema-exploration--put line 'noema-exploration-member member)
        (noema-exploration--put line 'noema-exploration-waiting (equal state "waiting"))))
    (insert "\n")))

(defun noema-exploration--render (&optional failure)
  "Draw the latest rows, keeping point's line; FAILURE says why there are none."
  (let ((inhibit-read-only t)
        (line (line-number-at-pos)))
    (erase-buffer)
    (insert (propertize (format "Explorations · %s\n"
                                (file-name-nondirectory (directory-file-name noema-exploration--root)))
                        'face '(:height 1.2 :weight bold))
            (propertize "RET open · a/r decide a report · s stop · R resume · n start · g refresh\n\n" 'face 'shadow))
    (cond (failure (insert (propertize (or (noema--value failure "message") "unavailable") 'face 'error) "\n"))
          ((null noema-exploration--rows)
           (insert "No exploration yet.  `n' (or /explore in a chat) starts one judged by an agent session.\n"))
          (t (mapc #'noema-exploration--render-one noema-exploration--rows)))
    (goto-char (point-min))
    (forward-line (1- line))))

(defun noema-exploration-refresh ()
  "Read the Project's explorations again."
  (interactive)
  (let ((buffer (current-buffer))
        (generation (cl-incf noema-exploration--serial)))
    (setq noema-exploration--generation generation)
    (cl-flet ((current-p () (and (buffer-live-p buffer)
                                 (eql generation (buffer-local-value 'noema-exploration--generation buffer)))))
      (noema-exploration--call
       `((op . "list") (root . ,noema-exploration--root))
       (lambda (result failure)
         (when (current-p)
           (with-current-buffer buffer
             (if failure (noema-exploration--render failure)
               (let* ((ids (mapcar (lambda (row) (noema--value row "id"))
                                   (noema--sequence (noema--value result "explorations"))))
                      (answers (make-hash-table :test 'equal))
                      (remaining (length ids)))
                 (if (null ids) (progn (setq noema-exploration--rows nil) (noema-exploration--render))
                   (dolist (id ids)
                     (noema-exploration--call
                      `((op . "status") (root . ,noema-exploration--root) (id . ,id))
                      (lambda (status _failure)
                        (when (current-p)
                          (with-current-buffer buffer
                            (when status (puthash id status answers))
                            (when (zerop (cl-decf remaining))
                              (setq noema-exploration--rows
                                    (delq nil (mapcar (lambda (id) (gethash id answers)) ids)))
                              (noema-exploration--render)))))))))))))))))

(defun noema-exploration--at (property)
  "PROPERTY at point, or an error naming what is missing."
  (or (get-text-property (point) property)
      (user-error "Nothing here; move to an exploration's line")))

(defun noema-exploration-open ()
  "Open the Markdown file on this line: the problem, a notebook or the summary."
  (interactive)
  (let ((file (noema-exploration--at 'noema-exploration-file)))
    (unless (file-exists-p file) (user-error "%s does not exist yet" file))
    (find-file-other-window file)))

(defun noema-exploration--after (what)
  "A callback reporting WHAT, then refreshing the page it was called from."
  (let ((buffer (current-buffer)))
    (lambda (_result failure)
      (message "%s" (if failure (format "%s: %s" what (noema--value failure "message")) (concat what ": done")))
      (when (buffer-live-p buffer)
        (with-current-buffer buffer (noema-exploration-refresh))))))

(defun noema-exploration--decide (accept)
  "Record the person's verdict ACCEPT on the waiting report at point."
  (unless (get-text-property (point) 'noema-exploration-waiting)
    (user-error "No report waits on this line"))
  (let* ((id (noema-exploration--at 'noema-exploration-id))
         (member (noema-exploration--at 'noema-exploration-member))
         (reason (if accept (read-string "Why (optional): ")
                   (read-string "Where is the gap? ")))
         (finish (and accept (y-or-n-p "Stop the other members and end it solved? "))))
    (when (and (not accept) (string-empty-p (string-trim reason)))
      (user-error "A rejection says where the gap is"))
    (noema-exploration--call
     `((op . "verdict") (root . ,noema-exploration--root) (id . ,id) (member . ,member)
       (accept . ,(if accept t :json-false)) (finish . ,(if finish t :json-false)) (by . "person")
       ,@(unless (string-empty-p (string-trim reason)) `((reason . ,reason))))
     (noema-exploration--after (format "Verdict on %s" member)))))

(defun noema-exploration-accept ()
  "Accept the waiting report on this line, as the person."
  (interactive)
  (noema-exploration--decide t))

(defun noema-exploration-reject ()
  "Reject the waiting report on this line, as the person, saying where the gap is."
  (interactive)
  (noema-exploration--decide nil))

(defun noema-exploration-stop ()
  "Stop the exploration on this line; it ends solved if any report was accepted."
  (interactive)
  (let ((id (noema-exploration--at 'noema-exploration-id)))
    (when (yes-or-no-p (format "Stop exploration %s? " id))
      (noema-exploration--call `((op . "stop") (root . ,noema-exploration--root) (id . ,id) (by . "person"))
                               (noema-exploration--after (format "Stop %s" id))))))

(defun noema-exploration-resume (minutes)
  "Resume the interrupted exploration on this line.
MINUTES gives it new time when its deadline has passed."
  (interactive (list (let ((text (read-string "Minutes (empty keeps its deadline): ")))
                       (and (not (string-empty-p text)) (string-to-number text)))))
  (let ((id (noema-exploration--at 'noema-exploration-id)))
    (noema-exploration--call `((op . "resume") (root . ,noema-exploration--root) (id . ,id)
                               ,@(when minutes `((minutes . ,minutes))))
                             (noema-exploration--after (format "Resume %s" id)) 180)))

(defun noema-exploration--project (&optional directory)
  "The Project root around DIRECTORY."
  (expand-file-name (or (noema-current-project (or directory default-directory))
                        directory default-directory)))

(defun noema-exploration--coordinator (root)
  "The agent session that judges: this chat, or one chosen from ROOT's pool."
  (let ((buffer (if (and (fboundp '+agent-acp-agent-buffer-p) (+agent-acp-agent-buffer-p (current-buffer)))
                    (current-buffer)
                  (let ((names (mapcar #'buffer-name (+agent-pool-buffers root nil 'agent))))
                    (unless names (user-error "No agent session in this Project to judge; start one first"))
                    (get-buffer (completing-read "Judging session: " names nil t))))))
    (let ((snapshot (+agent-session-snapshot buffer)))
      (unless (plist-get snapshot :native-session-id)
        (user-error "%s has no native session yet; wait for it to connect" (buffer-name buffer)))
      (list :buffer buffer :native (plist-get snapshot :native-session-id)
            :root (or (plist-get snapshot :root) root)))))

(defun noema-exploration--default-note ()
  "The Markdown note most recently shown, as the default problem."
  (seq-some (lambda (buffer)
              (let ((file (buffer-file-name buffer)))
                (and file (string-match-p "\\.md\\'" file) file)))
            (buffer-list)))

;;;###autoload
(defun noema-exploration-start (note title members minutes lean)
  "Start an exploration of the problem in NOTE named TITLE.
MEMBERS agents work for MINUTES; LEAN, when non-empty, is a frozen Lean
statement that then decides every proof.  The current chat (or a chosen
session) judges the reports and is told how."
  (interactive
   (let* ((note (read-file-name "Problem note: " nil (noema-exploration--default-note) t
                                (noema-exploration--default-note)))
          (title (read-string "Title: " (file-name-base note)))
          (members (read-number "Members: " 4))
          (minutes (read-number "Minutes: " 120))
          (lean (read-file-name "Lean statement (RET for none): " nil "" nil)))
     (list note title members minutes lean)))
  (require 'tools/agent/api)
  (let* ((coordinator (noema-exploration--coordinator (noema-exploration--project (file-name-directory note))))
         (buffer (plist-get coordinator :buffer)))
    (noema-exploration--call
     `((op . "start") (root . ,(plist-get coordinator :root)) (title . ,title)
       (note . ,(expand-file-name note)) (members . ,members) (minutes . ,minutes)
       (coordinator . ((buffer . ,(buffer-name buffer)) (nativeSessionId . ,(plist-get coordinator :native))))
       ,@(when (and lean (not (string-empty-p lean)) (not (file-directory-p lean)))
           `((lean . ,(expand-file-name lean)))))
     (lambda (result failure)
       (if failure
           (message "Exploration refused: %s" (noema--value failure "message"))
         ;; The person started it, so the judging session hears its instructions.
         (when (buffer-live-p buffer)
           (+agent/api `(("action" . "send") ("buffer" . ,(buffer-name buffer))
                         ("nativeSessionId" . ,(plist-get coordinator :native))
                         ("prompt" . ,(concat "[From Emacs: the person started this exploration and asks you to judge it]\n\n"
                                              (noema--value result "instructions"))))))
         (message "Exploration %s started: %s" (noema--value result "id") (noema--value result "problem"))))
     120)))

(defvar noema-exploration-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-exploration-refresh)
    (define-key map (kbd "RET") #'noema-exploration-open)
    (define-key map (kbd "a") #'noema-exploration-accept)
    (define-key map (kbd "r") #'noema-exploration-reject)
    (define-key map (kbd "s") #'noema-exploration-stop)
    (define-key map (kbd "R") #'noema-exploration-resume)
    (define-key map (kbd "n") #'noema-exploration-start)
    map))

(define-derived-mode noema-exploration-mode special-mode "Noema-Explorations"
  "One Project's explorations: problems, members, directions and waiting reports."
  (setq-local revert-buffer-function (lambda (&rest _) (noema-exploration-refresh))))

;;;###autoload
(defun noema-exploration (&optional directory)
  "Show the explorations of the Project around DIRECTORY."
  (interactive)
  (let* ((root (noema-exploration--project directory))
         (buffer (get-buffer-create
                  (format "*Noema Explorations: %s <%s>*"
                          (file-name-nondirectory (directory-file-name root))
                          (substring (secure-hash 'sha256 root) 0 8)))))
    (with-current-buffer buffer
      (noema-exploration-mode)
      (setq noema-exploration--root root
            default-directory root))
    (pop-to-buffer buffer)
    (let ((refresh (lambda () (when (buffer-live-p buffer)
                                (with-current-buffer buffer (noema-exploration-refresh))))))
      (if (fboundp '+noema--ensure-server) (+noema--ensure-server refresh) (funcall refresh)))
    buffer))

(provide 'noema-exploration)
;;; noema-exploration.el ends here
