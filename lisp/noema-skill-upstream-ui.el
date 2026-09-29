;;; noema-skill-upstream-ui.el --- Upstream versions of global Skills -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; A tabulated view of `etc/noema/skills.lock.json': where each global Skill
;; came from, the commit it is pinned to, whether its files were edited since,
;; and — only when asked — whether its upstream has moved.  Install, update,
;; preview and rollback all go through the Noema host; this file only renders
;; and confirms.  Network work never happens on redisplay: `C-c g' is the
;; explicit check.

;;; Code:

(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'cl-lib)
(require 'diff-mode)
(require 'vc)
(require 'noema-api)
(declare-function evil-set-initial-state "evil-core" (mode state))
(declare-function evil-define-key* "evil-core" (state keymap key def &rest bindings))

(defvar-local noema-skill-upstream--status nil
  "The last status object reported by the host.")

(defun noema-skill-upstream--short (commit)
  "Return a 12-character COMMIT, or a dash."
  (if (and (stringp commit) (> (length commit) 0)) (substring commit 0 (min 12 (length commit))) "—"))

(defun noema-skill-upstream--entry (skill)
  "Build the tabulated row for locked SKILL."
  (let* ((local (or (noema--value skill "local") "missing"))
         (latest (noema--value skill "latest"))
         (check-error (noema--value skill "checkError")))
    (list
     (noema--value skill "id")
     (vector
      (noema--value skill "id")
      (propertize local 'face (pcase local ("clean" 'success) ("modified" 'warning) (_ 'error)))
      (noema-skill-upstream--short (noema--value skill "commit"))
      (cond (check-error (propertize "check failed" 'face 'error 'help-echo check-error))
            ((eq t (noema--value skill "updateAvailable"))
             (propertize (noema-skill-upstream--short latest) 'face 'warning 'help-echo "Update available"))
            (latest (propertize "current" 'face 'shadow))
            (t "—"))
      (or (noema--value skill "ref") "HEAD")
      (number-to-string (length (noema--sequence (noema--value skill "history"))))
      (format "%s:%s" (or (noema--value skill "repository") "") (or (noema--value skill "path") "."))))))

(defun noema-skill-upstream--button (label command)
  "Build a header-line mouse button running COMMAND."
  (let ((map (make-sparse-keymap)))
    (define-key map [header-line mouse-1]
                (lambda (event)
                  (interactive "e")
                  (with-selected-window (posn-window (event-start event))
                    (call-interactively command))))
    (propertize (format " [%s] " label) 'local-map map 'mouse-face 'highlight
                'help-echo (symbol-name command))))

(defun noema-skill-upstream--render (status)
  "Render host STATUS in the current buffer."
  (setq noema-skill-upstream--status status
        tabulated-list-entries (mapcar #'noema-skill-upstream--entry
                                       (noema--sequence (noema--value status "skills"))))
  (let* ((skills (noema--sequence (noema--value status "skills")))
         (updates (seq-count (lambda (skill) (eq t (noema--value skill "updateAvailable"))) skills))
         (modified (seq-count (lambda (skill) (equal (noema--value skill "local") "modified")) skills)))
    (setq header-line-format
          (list (format " %s | %d locked · %s · %d edited locally "
                        (abbreviate-file-name (or (noema--value status "lockFile") "skills.lock.json"))
                        (length skills)
                        (if (eq t (noema--value status "checked"))
                            (format "%d updates" updates)
                          "not checked")
                        modified)
                (noema-skill-upstream--button "Check" #'noema-skill-upstream-ui-check)
                (noema-skill-upstream--button "Diff" #'noema-skill-upstream-ui-preview)
                (noema-skill-upstream--button "Update" #'noema-skill-upstream-ui-update)
                (noema-skill-upstream--button "Rollback" #'noema-skill-upstream-ui-rollback)
                (noema-skill-upstream--button "Install" #'noema-skill-upstream-ui-install)
                (noema-skill-upstream--button "Log" #'noema-skill-upstream-ui-log))))
  (tabulated-list-print t)
  (when (and tabulated-list-entries (not (tabulated-list-get-id)))
    (goto-char (point-min))))

(defun noema-skill-upstream--load (buffer check)
  "Ask the host for BUFFER's status, querying upstreams when CHECK."
  (with-current-buffer buffer
    (setq header-line-format (if check " Checking upstreams…" " Reading skills.lock.json…")))
  (noema-skill-upstream-status
   :check check
   :callback (lambda (status error-object)
               (if error-object
                   (message "Noema: %s" (or (noema--value error-object "message") "upstream status failed"))
                 (when (buffer-live-p buffer)
                   (with-current-buffer buffer (noema-skill-upstream--render status)))))))

(defun noema-skill-upstream-ui-refresh ()
  "Re-read local lock state without network access."
  (interactive)
  (noema-skill-upstream--load (current-buffer) nil))

(defun noema-skill-upstream-ui-check ()
  "Ask every upstream whether a newer commit exists."
  (interactive)
  (noema-skill-upstream--load (current-buffer) t))

(defun noema-skill-upstream--record ()
  "Return the locked Skill on the current row."
  (let ((id (or (tabulated-list-get-id) (user-error "No Skill on this row"))))
    (seq-find (lambda (skill) (equal (noema--value skill "id") id))
              (noema--sequence (noema--value noema-skill-upstream--status "skills")))))

(defun noema-skill-upstream--show-diff (update)
  "Display the dry-run UPDATE in a diff buffer."
  (with-current-buffer (get-buffer-create (format "*Noema Skill upstream: %s*" (noema--value update "id")))
    (let ((inhibit-read-only t)
          (files (noema--value update "files")))
      (erase-buffer)
      (insert (format "# Skill %s: %s -> %s (local copy: %s)\n"
                      (noema--value update "id")
                      (noema-skill-upstream--short (noema--value update "from"))
                      (noema-skill-upstream--short (noema--value update "to"))
                      (noema--value update "local")))
      (dolist (kind '("added" "removed" "changed"))
        (when-let* ((names (noema--sequence (noema--value files kind))))
          (insert (format "# %s: %s\n" kind (string-join names ", ")))))
      (dolist (warning (noema--sequence (noema--value update "warnings")))
        (insert "# warning: " warning "\n"))
      (insert "\n" (let ((diff (noema--value update "diff")))
                     (if (and (stringp diff) (not (string-empty-p diff))) diff "SKILL.md is unchanged.\n")))
      (goto-char (point-min))
      (diff-mode)
      (setq buffer-read-only t))
    (display-buffer (current-buffer))))

(defun noema-skill-upstream-ui-preview (&optional commit)
  "Show what updating the selected Skill (to COMMIT) would change."
  (interactive)
  (let ((id (noema--value (noema-skill-upstream--record) "id")))
    (message "Noema: fetching %s…" id)
    (noema-skill-upstream-update
     id :commit commit :dry-run t
     :callback (lambda (result error-object)
                 (if error-object
                     (message "Noema: %s" (or (noema--value error-object "message") "preview failed"))
                   (let ((update (noema--value result "update")))
                     (if (equal (noema--value update "state") "current")
                         (message "Noema: %s is already at its upstream commit" id)
                       (noema-skill-upstream--show-diff update))))))))

(defun noema-skill-upstream--apply (id commit)
  "Update locked Skill ID to COMMIT (nil: upstream head) after confirmation."
  (let ((buffer (current-buffer)))
    (cl-labels
        ((run (force)
           (message "Noema: updating %s…" id)
           (noema-skill-upstream-update
            id :commit commit :force force
            :callback
            (lambda (result error-object)
              (cond
               ((and error-object (equal (noema--value error-object "code") "ERR_NOEMA_SKILL_MODIFIED")
                     (not force))
                (when (yes-or-no-p (format "%s Discard the local edit? " (noema--value error-object "message")))
                  (run t)))
               (error-object
                (message "Noema: %s" (or (noema--value error-object "message") "update failed")))
               (t
                (let ((update (noema--value result "update")))
                  (message "Noema: %s %s" id
                           (if (eq t (noema--value update "updated"))
                               (format "now at %s" (noema-skill-upstream--short (noema--value update "to")))
                             "is already current"))
                  (when (buffer-live-p buffer) (noema-skill-upstream--load buffer nil)))))))))
      (run nil))))

(defun noema-skill-upstream-ui-update ()
  "Update the selected Skill to its upstream head after confirmation."
  (interactive)
  (let ((record (noema-skill-upstream--record)))
    (when (yes-or-no-p (format "Replace global Skill %s with the upstream head of %s? "
                               (noema--value record "id") (noema--value record "repository")))
      (noema-skill-upstream--apply (noema--value record "id") nil))))

(defun noema-skill-upstream-ui-rollback ()
  "Pin the selected Skill to an earlier locked commit or one you enter."
  (interactive)
  (let* ((record (noema-skill-upstream--record))
         (history (reverse (noema--sequence (noema--value record "history"))))
         (choices (mapcar (lambda (entry)
                            (cons (format "%s  replaced %s"
                                          (noema-skill-upstream--short (noema--value entry "commit"))
                                          (or (noema--value entry "replaced_at") ""))
                                  (noema--value entry "commit")))
                          history))
         (answer (completing-read "Pin to commit (or enter a full SHA): " (mapcar #'car choices)))
         (commit (or (cdr (assoc answer choices)) (string-trim answer))))
    (unless (string-match-p "\\`[0-9a-f]\\{40\\}\\'" commit)
      (user-error "Enter a full 40-character commit"))
    (when (yes-or-no-p (format "Pin %s to %s? " (noema--value record "id") (noema-skill-upstream--short commit)))
      (noema-skill-upstream--apply (noema--value record "id") commit))))

(defun noema-skill-upstream-ui-install ()
  "Install a new global Skill from a git upstream and lock its commit."
  (interactive)
  (let* ((buffer (current-buffer))
         (repository (string-trim (read-string "Repository (owner/repo or git URL): ")))
         (path (string-trim (read-string "Skill directory in the repository: " ".")))
         (ref (string-trim (read-string "Track ref: " "HEAD")))
         (license (string-trim (read-string "License (optional): "))))
    (when (string-empty-p repository) (user-error "A repository is required"))
    (message "Noema: fetching %s…" repository)
    (noema-skill-upstream-install
     repository :path path :ref ref :license license
     :callback (lambda (result error-object)
                 (if error-object
                     (message "Noema: %s" (or (noema--value error-object "message") "install failed"))
                   (message "Noema: installed %s" (noema--value (noema--value result "skill") "id"))
                   (when (buffer-live-p buffer) (noema-skill-upstream--load buffer nil)))))))

(defun noema-skill-upstream-ui-log ()
  "Show the version-control log of the selected Skill's local directory."
  (interactive)
  (let* ((directory (file-name-as-directory (noema--value (noema-skill-upstream--record) "directory")))
         (backend (vc-responsible-backend directory t)))
    (unless backend (user-error "%s is not under version control" (abbreviate-file-name directory)))
    (vc-print-log-internal backend (list directory) nil nil vc-log-show-limit)))

(defun noema-skill-upstream-ui-open ()
  "Open the selected Skill's SKILL.md."
  (interactive)
  (find-file-other-window (expand-file-name "SKILL.md" (noema--value (noema-skill-upstream--record) "directory"))))

(defvar noema-skill-upstream-command-map
  (let ((map (make-sparse-keymap)))
    (dolist (binding '(("g" . noema-skill-upstream-ui-check) ("r" . noema-skill-upstream-ui-refresh)
                       ("=" . noema-skill-upstream-ui-preview) ("u" . noema-skill-upstream-ui-update)
                       ("R" . noema-skill-upstream-ui-rollback) ("i" . noema-skill-upstream-ui-install)
                       ("l" . noema-skill-upstream-ui-log) ("f" . noema-skill-upstream-ui-open)
                       ("q" . quit-window)))
      (define-key map (kbd (car binding)) (cdr binding)))
    map)
  "Commands under C-c, leaving Evil's movement keys alone.")

(defvar noema-skill-upstream-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "C-c") noema-skill-upstream-command-map)
    (define-key map (kbd "RET") #'noema-skill-upstream-ui-preview)
    map))

(with-eval-after-load 'evil
  (evil-set-initial-state 'noema-skill-upstream-mode 'normal)
  (evil-define-key* '(normal motion) noema-skill-upstream-mode-map
    (kbd "C-c") noema-skill-upstream-command-map
    (kbd "RET") #'noema-skill-upstream-ui-preview))

(define-derived-mode noema-skill-upstream-mode tabulated-list-mode "Noema-Upstream"
  "Upstream versions of the global Skill library.
C-c g asks each upstream for its head (network).  RET or C-c = previews the
change, C-c u updates, C-c R pins an earlier or given commit, C-c i installs
a new Skill, C-c l shows the local version-control log, C-c f opens SKILL.md.
A Skill edited in place is never replaced without confirmation; keep local
refinements in project patches instead."
  (setq tabulated-list-format
        [("Skill" 20 t) ("Local" 9 t) ("Commit" 13 nil) ("Upstream" 13 nil)
         ("Ref" 8 nil) ("History" 8 nil) ("Source" 50 nil)])
  (setq tabulated-list-padding 2
        tabulated-list-sort-key '("Skill" . nil)
        revert-buffer-function (lambda (&rest _) (noema-skill-upstream-ui-refresh)))
  (tabulated-list-init-header))

;;;###autoload
(defun noema-skill-upstream ()
  "Show where each global Skill came from and manage its upstream version."
  (interactive)
  (let ((buffer (get-buffer-create "*Noema Skill upstream*")))
    (with-current-buffer buffer
      (unless (derived-mode-p 'noema-skill-upstream-mode) (noema-skill-upstream-mode)))
    (pop-to-buffer buffer)
    (noema-skill-upstream--load buffer nil)))

(provide 'noema-skill-upstream-ui)
;;; noema-skill-upstream-ui.el ends here
