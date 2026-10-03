;;; noema-agent-worktree-board.el --- Parallel attempts in worktrees -*- lexical-binding: t; -*-

;;; Commentary:
;; One task handed to several agents at once, each in its own worktree, so the
;; results can be compared before a person picks one.  A group is nothing but
;; `branch.<name>.noemaGroup' on each attempt's branch: membership survives
;; restarts with the worktrees themselves, and no second registry can drift
;; from Git.  A member's state is read live from its session -- working,
;; waiting for a permission, finished, or closed -- never stored.
;;
;; The group is settled only when no member works or waits; finishing one
;; attempt stops nothing else.  Choosing and merging an attempt is the
;; person's act, through Magit; removing the group keeps every branch.
;;
;; Design source: Agent Fleet's parallel tasks
;; (docs/agent-fleet-noema-audit-2026-10.md in the Emacs configuration),
;; with the grouping persisted, which Agent Fleet keeps only in memory.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-agent-worktree)

(declare-function noema-agent-acp-attention-mark "noema-agent-acp" (buffer))
(declare-function noema-agent-acp-busy-p "noema-agent-acp" (buffer))
(declare-function noema-agent-acp-prompt "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-show-buffer "noema-agent-acp" (buffer))
(declare-function noema-agent-acp-state-value "noema-agent-acp" (buffer path))
(declare-function noema-agent-acp-subscribe "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-unsubscribe "noema-agent-acp" (&rest args))
(defvar noema-agent-acp-changed-functions)

(defconst noema-agent-worktree-board-buffer-name "*Noema attempts*"
  "Name of the parallel attempts board.")

(defvar-local noema-agent-worktree-board--directory nil
  "A directory of the repository this board shows.")

(defvar-local noema-agent-worktree-board--members nil
  "Worktree plists last read from Git, each with its :stat.")


;;;; ── Starting attempts ────────────────────────────────────────────────────

(defun noema-agent-worktree--send-when-ready (buffer text)
  "Send TEXT as the first prompt of agent BUFFER once its session exists."
  (if (noema-agent-acp-state-value buffer '(:session :id))
      (noema-agent-acp-prompt :buffer buffer
                              :content (list (list (cons 'type "text")
                                                   (cons 'text text))))
    (let (subscription)
      (setq subscription
            (noema-agent-acp-subscribe
             :buffer buffer :event 'init-finished
             :callback (lambda (_event)
                         (ignore-errors
                           (noema-agent-acp-unsubscribe
                            :buffer buffer :subscription subscription))
                         (when (buffer-live-p buffer)
                           (noema-agent-worktree--send-when-ready buffer text))))))))

;;;###autoload
(defun noema-agent-worktree-parallel (title specs)
  "Start the parallel attempt group TITLE, one worktree session per SPECS.
SPECS is a list of (AGENT . PROMPT).  Interactively the same prompt goes to
every chosen agent, and an agent chosen twice gets two attempts.  Each attempt
branches from the workspace's current branch; one that cannot start is
reported and the others go on.  Return the started attempt plists."
  (interactive
   (let* ((title (read-string "Attempt group title: "))
          (agents (or (completing-read-multiple
                       "Agents (repeat one for several attempts): "
                       noema-agent-worktree-agents nil t)
                      (user-error "Choose at least one agent")))
          (prompt (read-string "Prompt for every attempt: ")))
     (list title (mapcar (lambda (agent) (cons (intern agent) prompt)) agents))))
  (when (string-empty-p (string-trim title))
    (user-error "An attempt group needs a title"))
  (let ((group (noema-agent-worktree--slug title))
        (workspace (cdr (noema-agent-worktree--workspace)))
        (index 0) started failed)
    (when (seq-find (lambda (worktree) (equal (plist-get worktree :group) group))
                    (noema-agent-worktree-list workspace))
      (user-error "Attempt group %s already exists" group))
    (dolist (spec specs)
      (cl-incf index)
      (condition-case error-object
          (let ((attempt (noema-agent-worktree--start
                          (car spec) (format "%s-%d-%s" group index (car spec))
                          :group group)))
            (unless (string-empty-p (string-trim (or (cdr spec) "")))
              (noema-agent-worktree--send-when-ready (plist-get attempt :buffer) (cdr spec)))
            (push attempt started))
        (error (push (format "%s: %s" (car spec) (error-message-string error-object))
                          failed))))
    (unless started
      (user-error "No attempt started: %s" (string-join (nreverse failed) "; ")))
    (noema-agent-worktree-board workspace)
    (message "Noema: %d attempt%s of %s started%s"
             (length started) (if (= (length started) 1) "" "s") group
             (if failed (format "; failed %s" (string-join (nreverse failed) "; ")) ""))
    (nreverse started)))


;;;; ── Member state ─────────────────────────────────────────────────────────

(defun noema-agent-worktree-board--session (member)
  "Return the live agent buffer working in MEMBER's worktree, or nil."
  (car (noema-agent-worktree--sessions-in (plist-get member :path))))

(defun noema-agent-worktree-member-state (member)
  "Return MEMBER's live state: `waiting', `working', `done', `idle' or `closed'."
  (let ((buffer (noema-agent-worktree-board--session member)))
    (cond ((null buffer) 'closed)
          ((equal (noema-agent-acp-attention-mark buffer) "!approve") 'waiting)
          ((noema-agent-acp-busy-p buffer) 'working)
          ((equal (noema-agent-acp-attention-mark buffer) "done") 'done)
          (t 'idle))))

(defun noema-agent-worktree-group-state (members)
  "Return the state of a group of MEMBERS: `waiting', `working' or `settled'.
One waiting member makes the group wait; otherwise one working member keeps
it working.  An attempt that finished, or whose session closed, has settled."
  (let ((states (mapcar #'noema-agent-worktree-member-state members)))
    (cond ((memq 'waiting states) 'waiting)
          ((memq 'working states) 'working)
          (t 'settled))))

(defun noema-agent-worktree-member-stat (member)
  "Return what MEMBER changed since it branched, as a short string.
Commits ahead, then lines and files changed in the working tree against the
branch point, then new untracked files -- an agent's new file is a change."
  (let* ((path (plist-get member :path))
         (base (plist-get member :base))
         (point (noema-agent-worktree--git-ok path "merge-base" base "HEAD"))
         (ahead (noema-agent-worktree--git-ok path "rev-list" "--count"
                                              (concat point "..HEAD")))
         (short (noema-agent-worktree--git-ok path "diff" "--shortstat" point))
         (untracked (length (seq-filter
                             (lambda (line) (string-prefix-p "??" line))
                             (split-string (noema-agent-worktree--git-ok
                                            path "status" "--porcelain")
                                           "\n" t)))))
    (string-join
     (delq nil (list (format "%s commit%s" ahead (if (equal ahead "1") "" "s"))
                     (and (string-match "\\([0-9]+\\) files? changed" short)
                          (let ((files (match-string 1 short))
                                (plus (and (string-match "\\([0-9]+\\) insertion" short)
                                           (match-string 1 short)))
                                (minus (and (string-match "\\([0-9]+\\) deletion" short)
                                            (match-string 1 short))))
                            (format "%s file%s +%s -%s" files
                                    (if (equal files "1") "" "s")
                                    (or plus "0") (or minus "0"))))
                     (and (> untracked 0) (format "%d new" untracked))))
     ", ")))


;;;; ── Board ────────────────────────────────────────────────────────────────

(defun noema-agent-worktree-board--groups ()
  "Return the board's members grouped as ((GROUP . MEMBERS) ...)."
  (let (groups)
    (dolist (member noema-agent-worktree-board--members)
      (let ((cell (assoc (plist-get member :group) groups)))
        (if cell
            (setcdr cell (append (cdr cell) (list member)))
          (push (list (plist-get member :group) member) groups))))
    (sort groups (lambda (a b) (string-lessp (car a) (car b))))))

(defun noema-agent-worktree-board--render ()
  "Redraw the board from the members last read, with live session states."
  (let (entries)
    (dolist (group (noema-agent-worktree-board--groups))
      (let ((state (noema-agent-worktree-group-state (cdr group))))
        (dolist (member (cdr group))
          (push (list (plist-get member :branch)
                      (vector (format "%s (%s)" (car group) state)
                              (plist-get member :branch)
                              (or (plist-get member :agent) "")
                              (symbol-name (noema-agent-worktree-member-state member))
                              (or (plist-get member :stat) "")))
                entries))))
    (setq tabulated-list-entries (nreverse entries))
    (tabulated-list-print t)))

(defun noema-agent-worktree-board-refresh ()
  "Read the groups and their changes from Git again, then redraw."
  (interactive)
  (setq noema-agent-worktree-board--members
        (mapcar (lambda (member)
                  (append member
                          (list :stat (condition-case error-object
                                          (noema-agent-worktree-member-stat member)
                                        (user-error (error-message-string error-object))))))
                (seq-filter (lambda (worktree) (plist-get worktree :group))
                            (noema-agent-worktree-list
                             noema-agent-worktree-board--directory))))
  (noema-agent-worktree-board--render))

(defun noema-agent-worktree-board--session-changed (_buffer)
  "Redraw a visible board when a session's state changed; Git is not asked."
  (when-let* ((board (get-buffer noema-agent-worktree-board-buffer-name))
              ((get-buffer-window board 'visible)))
    (with-current-buffer board
      (noema-agent-worktree-board--render))))

(defun noema-agent-worktree-board--teardown ()
  "Stop following sessions once the board is gone."
  (remove-hook 'noema-agent-acp-changed-functions
               #'noema-agent-worktree-board--session-changed))

(defun noema-agent-worktree-board--member ()
  "Return the member on the current line."
  (let ((branch (or (tabulated-list-get-id) (user-error "No attempt on this line"))))
    (or (seq-find (lambda (member) (equal (plist-get member :branch) branch))
                  noema-agent-worktree-board--members)
        (user-error "Attempt %s is gone; press g" branch))))

(defun noema-agent-worktree-board-visit ()
  "Show the live session of the attempt on this line."
  (interactive)
  (let ((member (noema-agent-worktree-board--member)))
    (noema-agent-acp-show-buffer
     (or (noema-agent-worktree-board--session member)
         (user-error "%s has no open session; resume it from C-c A S, or review it with m or d"
                     (plist-get member :branch))))))

(defun noema-agent-worktree-board-magit-status ()
  "Open Magit status for the attempt on this line."
  (interactive)
  (noema-agent-worktree-magit-status (plist-get (noema-agent-worktree-board--member) :path)))

(defun noema-agent-worktree-board-magit-diff ()
  "Show what the attempt on this line changed since it branched."
  (interactive)
  (noema-agent-worktree-magit-diff (plist-get (noema-agent-worktree-board--member) :path)))

(defun noema-agent-worktree-board-remove (&optional force)
  "Remove the attempt on this line, keeping its branch; FORCE discards edits."
  (interactive "P")
  (noema-agent-worktree-remove (noema-agent-worktree-board--member) force)
  (noema-agent-worktree-board-refresh))

(defun noema-agent-worktree-board-remove-group (&optional force)
  "Remove every attempt of this line's group, keeping their branches.
Each is checked as `noema-agent-worktree-remove' checks one; FORCE discards
uncommitted edits.  Nothing is removed unless every attempt can go."
  (interactive "P")
  (let* ((group (plist-get (noema-agent-worktree-board--member) :group))
         (members (cdr (assoc group (noema-agent-worktree-board--groups)))))
    (dolist (member members)
      (when-let* ((sessions (noema-agent-worktree--sessions-in (plist-get member :path))))
        (user-error "Close the session working in %s first" (plist-get member :branch)))
      (when (and (not force)
                 (not (string-empty-p (noema-agent-worktree--git-ok
                                       (plist-get member :path) "status" "--porcelain"))))
        (user-error "%s has uncommitted changes; use a prefix argument to discard them"
                    (plist-get member :branch))))
    (when (yes-or-no-p (format "Remove the %d attempts of %s (branches are kept)? "
                               (length members) group))
      (dolist (member members)
        (noema-agent-worktree--remove member force))
      (noema-agent-worktree-board-refresh))))

(defvar noema-agent-worktree-board-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'noema-agent-worktree-board-visit)
    (define-key map (kbd "m") #'noema-agent-worktree-board-magit-status)
    (define-key map (kbd "d") #'noema-agent-worktree-board-magit-diff)
    (define-key map (kbd "k") #'noema-agent-worktree-board-remove)
    (define-key map (kbd "K") #'noema-agent-worktree-board-remove-group)
    (define-key map (kbd "g") #'noema-agent-worktree-board-refresh)
    map)
  "Keymap for `noema-agent-worktree-board-mode'.")

(define-derived-mode noema-agent-worktree-board-mode tabulated-list-mode "Noema-Attempts"
  "Compare the parallel attempts of one repository."
  (setq tabulated-list-format [("Group" 28 t) ("Branch" 34 t) ("Agent" 9 t)
                               ("State" 8 t) ("Changes" 0 nil)]
        tabulated-list-padding 1
        header-line-format
        "Noema attempts  |  RET session  m Magit  d diff  k remove  K remove group  g refresh")
  (tabulated-list-init-header)
  (add-hook 'noema-agent-acp-changed-functions
            #'noema-agent-worktree-board--session-changed)
  (add-hook 'kill-buffer-hook #'noema-agent-worktree-board--teardown nil t))

;;;###autoload
(defun noema-agent-worktree-board (&optional directory)
  "Show the parallel attempts of the repository at DIRECTORY.
DIRECTORY defaults to the current Project's workspace."
  (interactive)
  (let ((directory (or directory (cdr (noema-agent-worktree--workspace))))
        (board (get-buffer-create noema-agent-worktree-board-buffer-name)))
    (with-current-buffer board
      (unless (derived-mode-p 'noema-agent-worktree-board-mode)
        (noema-agent-worktree-board-mode))
      (setq noema-agent-worktree-board--directory directory)
      (noema-agent-worktree-board-refresh))
    (pop-to-buffer board)))

(provide 'noema-agent-worktree-board)
;;; noema-agent-worktree-board.el ends here
