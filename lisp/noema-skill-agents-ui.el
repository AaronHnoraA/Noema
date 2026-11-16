;;; noema-skill-agents-ui.el --- The agent catalog in every Agent's library -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; One row per native Agent library (a global capability source with
;; `export: true'): which catalog Skills it already reads, which links a sync
;; would add or remove, and what the Agent owns itself.  The Skills come from
;; the Skill Manager's agent catalog, so every Agent, started by Noema or not,
;; sees the same ones.  The Agent's own entries (official Skills, ones the
;; person installed) are listed and never touched; only links the manager made
;; change.  Rendering and confirming only: the host does the work.
;; Contract: docs/noema/design/capabilities.md, "Agent libraries".

;;; Code:

(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-api)
(declare-function evil-set-initial-state "evil-core" (mode state))
(declare-function evil-define-key* "evil-core" (state keymap key def &rest bindings))

(defvar-local noema-skill-agents--report nil "The last report from the host.")

(defun noema-skill-agents--count (row key)
  "Length of ROW's KEY list as a string, blank when zero."
  (let ((n (length (noema--sequence (noema--value row key)))))
    (if (zerop n) "" (number-to-string n))))

(defun noema-skill-agents--entry (row)
  "Tabulated entry for library ROW."
  (let ((conflicts (noema-skill-agents--count row "conflicts"))
        (state (noema--value row "state")))
    (list (noema--value row "id")
          (vector (noema--value row "id")
                  (propertize state 'face (pcase state ("ready" 'success) ("new" 'warning) (_ 'shadow)))
                  (noema-skill-agents--count row "linked")
                  (propertize (noema-skill-agents--count row "created") 'face 'warning)
                  (propertize (noema-skill-agents--count row "updated") 'face 'warning)
                  (propertize (noema-skill-agents--count row "removed") 'face 'warning)
                  (noema-skill-agents--count row "native")
                  (propertize conflicts 'face 'error)
                  (abbreviate-file-name (noema--value row "directory"))))))

(defun noema-skill-agents--render (report)
  "Show REPORT."
  (setq noema-skill-agents--report report
        tabulated-list-entries (mapcar #'noema-skill-agents--entry
                                       (noema--sequence (noema--value report "libraries"))))
  (let* ((rows (noema--sequence (noema--value report "libraries")))
         (pending (seq-some (lambda (row) (seq-some (lambda (key) (noema--sequence (noema--value row key)))
                                                     '("created" "updated" "removed")))
                            rows)))
    (setq header-line-format
          (format " %d catalog Skills → %d Agent libraries%s · C-c s sync · RET details · C-c g refresh"
                  (length (noema--sequence (noema--value report "skills"))) (length rows)
                  (if pending (propertize " · sync pending" 'face 'warning) " · in sync"))))
  (tabulated-list-print t))

(defun noema-skill-agents--call (channel callback)
  "Ask the host CHANNEL for a report and call CALLBACK with it."
  (let ((buffer (current-buffer)))
    (noema--host-call
     channel (vector '())
     (lambda (result error-object)
       (if error-object
           (message "Agent libraries: %s" (or (noema--value error-object "message") error-object))
         (let ((report (noema--value result "agentLibraries")))
           (when (buffer-live-p buffer)
             (with-current-buffer buffer (noema-skill-agents--render report)))
           (when callback (funcall callback report))))))))

(defun noema-skill-agents-refresh ()
  "Compare every Agent library with the agent catalog again."
  (interactive)
  (noema-skill-agents--call "noema:api:research:capability:global:agents:status" nil))

(defun noema-skill-agents--summary (report)
  "One line of what REPORT changed or would change."
  (let ((total (lambda (key) (apply #'+ (mapcar (lambda (row) (length (noema--sequence (noema--value row key))))
                                                (noema--sequence (noema--value report "libraries")))))))
    (format "%d added, %d updated, %d removed, %d conflicts"
            (funcall total "created") (funcall total "updated") (funcall total "removed") (funcall total "conflicts"))))

;;;###autoload
(defun noema-skill-agents-sync (&optional quiet)
  "Link the agent catalog into every Agent library; with QUIET, ask nothing.
Only links the Skill Manager made are changed; the Agents' own Skills stay."
  (interactive)
  (when (or quiet (null noema-skill-agents--report)
            (y-or-n-p (format "Sync Agent libraries (%s)? " (noema-skill-agents--summary noema-skill-agents--report))))
    (if (derived-mode-p 'noema-skill-agents-mode)
        (noema-skill-agents--call "noema:api:research:capability:global:agents:sync"
                                  (lambda (report) (message "Agent libraries synced: %s" (noema-skill-agents--summary report))))
      (noema--host-call "noema:api:research:capability:global:agents:sync" (vector '())
                        (lambda (result error-object)
                          (message "Agent libraries: %s"
                                   (if error-object (or (noema--value error-object "message") error-object)
                                     (noema-skill-agents--summary (noema--value result "agentLibraries")))))))))

(defun noema-skill-agents-details ()
  "Show what the library on this line links, owns itself and could not link."
  (interactive)
  (let* ((id (or (tabulated-list-get-id) (user-error "No library on this line")))
         (row (seq-find (lambda (item) (equal (noema--value item "id") id))
                        (noema--sequence (noema--value noema-skill-agents--report "libraries"))))
         (list-of (lambda (key) (string-join (noema--sequence (noema--value row key)) ", "))))
    (with-help-window (format "*Agent library: %s*" id)
      (princ (format "%s\n%s\n\n" id (noema--value row "directory")))
      (dolist (pair '(("Linked (catalog Skills it reads)" . "linked") ("Would add" . "created")
                      ("Would update" . "updated") ("Would remove" . "removed")
                      ("The Agent's own, never touched" . "native")))
        (princ (format "%s:\n  %s\n\n" (car pair) (let ((text (funcall list-of (cdr pair)))) (if (string-empty-p text) "—" text)))))
      (princ "Conflicts (left untouched):\n")
      (dolist (conflict (noema--sequence (noema--value row "conflicts")))
        (princ (format "  %s: %s\n" (noema--value conflict "id") (noema--value conflict "reason")))))))

(defun noema-skill-agents-open ()
  "Open the library on this line in Dired."
  (interactive)
  (let* ((id (or (tabulated-list-get-id) (user-error "No library on this line")))
         (row (seq-find (lambda (item) (equal (noema--value item "id") id))
                        (noema--sequence (noema--value noema-skill-agents--report "libraries")))))
    (dired (noema--value row "directory"))))

(defvar noema-skill-agents-mode-map
  (let ((map (make-sparse-keymap))
        (commands (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key commands (kbd "s") #'noema-skill-agents-sync)
    (define-key commands (kbd "g") #'noema-skill-agents-refresh)
    (define-key commands (kbd "o") #'noema-skill-agents-open)
    (define-key commands (kbd "q") #'quit-window)
    (define-key map (kbd "C-c") commands)
    (define-key map (kbd "RET") #'noema-skill-agents-details)
    map))

(with-eval-after-load 'evil
  (evil-set-initial-state 'noema-skill-agents-mode 'normal)
  (evil-define-key* '(normal motion) noema-skill-agents-mode-map
    (kbd "RET") #'noema-skill-agents-details))

(define-derived-mode noema-skill-agents-mode tabulated-list-mode "Noema-Agent-Libraries"
  "The agent catalog in every native Agent library.
RET: details.  C-c s: sync.  C-c o: open the library.  C-c g: refresh."
  (setq tabulated-list-format
        [("Agent" 12 t) ("State" 8 t) ("Linked" 7 t) ("Add" 5 t) ("Update" 7 t)
         ("Remove" 7 t) ("Own" 5 t) ("Conflicts" 10 t) ("Library" 40 t)]
        tabulated-list-padding 2)
  (setq-local revert-buffer-function (lambda (&rest _) (noema-skill-agents-refresh)))
  (tabulated-list-init-header))

;;;###autoload
(defun noema-skill-agents ()
  "Show how the agent catalog reaches every native Agent library."
  (interactive)
  (let ((buffer (get-buffer-create "*Noema Agent Libraries*")))
    (with-current-buffer buffer
      (noema-skill-agents-mode)
      (noema-skill-agents-refresh))
    (pop-to-buffer buffer)))

(provide 'noema-skill-agents-ui)
;;; noema-skill-agents-ui.el ends here
