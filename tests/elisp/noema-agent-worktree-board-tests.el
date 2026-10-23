;;; noema-agent-worktree-board-tests.el --- Tests for parallel attempts -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Real repositories, stand-in agent buffers: starting an agent is replaced by
;; a buffer whose directory is the attempt's worktree.

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-agent-worktree-board)
(require 'noema-agent-worktree-tests)

(defmacro noema-agent-worktree-board-tests--with-agents (&rest body)
  "Run BODY in a repository where starting an agent makes a stand-in buffer.
`prompts' collects (BUFFER . TEXT) sent; the agent `broken' cannot start."
  (declare (indent 0) (debug t))
  `(noema-agent-worktree-tests--with-repo
     (let ((prompts '())
           (default-directory repo))
       (cl-letf (((symbol-function 'noema-agent-acp-project-root) (lambda (&rest _) repo))
                 ((symbol-function 'noema-project-workspace) (lambda (root) root))
                 ((symbol-function 'noema-agent-acp-config-for)
                  (lambda (agent) (unless (eq agent 'broken) (list :identifier agent))))
                 ((symbol-function 'noema-agent-acp-start)
                  (cl-function
                   (lambda (&key directory &allow-other-keys)
                     (let ((buffer (noema-agent-worktree-tests--session directory)))
                       (push buffer sessions)
                       buffer))))
                 ((symbol-function 'noema-agent-acp-adopt) #'ignore)
                 ((symbol-function 'noema-agent-acp--unique-name) (lambda (base _) base))
                 ((symbol-function 'noema-agent-acp-agent-buffer-p)
                  (lambda (buffer) (memq buffer sessions)))
                 ((symbol-function 'noema-agent-acp-state-value) (lambda (&rest _) "sid"))
                 ((symbol-function 'noema-agent-acp-prompt)
                  (cl-function (lambda (&key buffer content &allow-other-keys)
                                 (push (cons buffer (alist-get 'text (car content)))
                                       prompts))))
                 ((symbol-function 'pop-to-buffer) #'ignore))
         ,@body))))

(ert-deftest noema-agent-worktree-parallel-starts-every-attempt ()
  (noema-agent-worktree-board-tests--with-agents
    (let* ((started (noema-agent-worktree-parallel
                     "Fix parser" '((codex . "fix it") (codex . "fix it")
                                    (broken . "fix it") (claude . "fix it"))))
           (members (seq-filter (lambda (w) (plist-get w :group))
                                (noema-agent-worktree-list repo))))
      ;; The broken agent is reported; the others still start.
      (should (= (length started) 3))
      (should (equal (sort (mapcar (lambda (w) (plist-get w :branch)) members) #'string<)
                     '("noema/fix-parser-1-codex" "noema/fix-parser-2-codex"
                       "noema/fix-parser-4-claude")))
      (should (seq-every-p (lambda (w) (equal (plist-get w :group) "fix-parser")) members))
      (should (equal (plist-get (seq-find (lambda (w) (string-suffix-p "claude" (plist-get w :branch)))
                                          members)
                                :agent)
                     "claude"))
      ;; Each attempt got the prompt in its own session.
      (should (= (length prompts) 3))
      (should (equal (delete-dups (mapcar #'cdr prompts)) '("fix it")))
      (should (equal (length (delete-dups (mapcar #'car prompts))) 3))
      ;; The same group cannot be started twice.
      (should-error (noema-agent-worktree-parallel "fix parser" '((codex . "again")))
                    :type 'user-error)
      (kill-buffer noema-agent-worktree-board-buffer-name))))

(ert-deftest noema-agent-worktree-group-state-follows-members ()
  (noema-agent-worktree-board-tests--with-agents
    (noema-agent-worktree-parallel "race" '((codex . "") (claude . "")))
    (let* ((members (seq-filter (lambda (w) (plist-get w :group))
                                (noema-agent-worktree-list repo)))
           (busy '()) (marks '()))
      (cl-letf (((symbol-function 'noema-agent-acp-busy-p) (lambda (b) (memq b busy)))
                ((symbol-function 'noema-agent-acp-attention-mark)
                 (lambda (b) (cdr (assq b marks)))))
        (let ((first (noema-agent-worktree-board--session (car members)))
              (second (noema-agent-worktree-board--session (cadr members))))
          (should (and first second (not (eq first second))))
          (setq busy (list first))
          (should (eq (noema-agent-worktree-member-state (car members)) 'working))
          (should (eq (noema-agent-worktree-member-state (cadr members)) 'idle))
          (should (eq (noema-agent-worktree-group-state members) 'working))
          ;; One attempt waiting holds up the whole group.
          (setq marks (list (cons second "!approve")))
          (should (eq (noema-agent-worktree-group-state members) 'waiting))
          ;; Finishing one stops nothing; the group settles when none is left.
          (setq busy nil marks (list (cons first "done")))
          (should (eq (noema-agent-worktree-member-state (car members)) 'done))
          (should (eq (noema-agent-worktree-group-state members) 'settled))
          (kill-buffer second)
          (should (eq (noema-agent-worktree-member-state (cadr members)) 'closed))
          (should (eq (noema-agent-worktree-group-state members) 'settled))))
      (kill-buffer noema-agent-worktree-board-buffer-name))))

(ert-deftest noema-agent-worktree-member-stat-counts-commits-edits-and-new-files ()
  (noema-agent-worktree-tests--with-repo
    (let* ((path (plist-get (noema-agent-worktree-create repo "stat") :path))
           (member (car (noema-agent-worktree-list repo))))
      (should (equal (noema-agent-worktree-member-stat member) "0 commits"))
      (with-temp-file (expand-file-name "src/a.el" path) (insert "one\nagent\n"))
      (noema-agent-worktree--git-ok path "commit" "-q" "-am" "agent")
      (with-temp-file (expand-file-name "src/a.el" path) (insert "one\nagent\nmore\n"))
      (with-temp-file (expand-file-name "src/new.el" path) (insert "x\n"))
      (should (equal (noema-agent-worktree-member-stat member)
                     "1 commit, 1 file +2 -1, 1 new")))))

(ert-deftest noema-agent-worktree-board-lists-and-removes-groups ()
  (noema-agent-worktree-board-tests--with-agents
    (noema-agent-worktree-parallel "one" '((codex . "")))
    (noema-agent-worktree-parallel "two" '((codex . "") (claude . "")))
    (noema-agent-worktree-create repo "solo")
    (with-current-buffer noema-agent-worktree-board-buffer-name
      (cl-letf (((symbol-function 'noema-agent-acp-busy-p) #'ignore)
                ((symbol-function 'noema-agent-acp-attention-mark) #'ignore)
                ((symbol-function 'yes-or-no-p) (lambda (&rest _) t)))
        (noema-agent-worktree-board-refresh)
        ;; Only grouped attempts appear, the plain worktree does not.
        (should (equal (mapcar #'car tabulated-list-entries)
                       '("noema/one-1-codex" "noema/two-1-codex" "noema/two-2-claude")))
        (should (equal (aref (cadr (nth 1 tabulated-list-entries)) 0) "two (settled)"))
        (goto-char (point-min))
        (forward-line 1)
        ;; Sessions still open block the group's removal.
        (should-error (noema-agent-worktree-board-remove-group) :type 'user-error)
        (dolist (buffer sessions) (kill-buffer buffer))
        ;; So do uncommitted edits, until forced.
        (let ((path (plist-get (noema-agent-worktree-board--member) :path)))
          (with-temp-file (expand-file-name "src/a.el" path) (insert "edit\n")))
        (should-error (noema-agent-worktree-board-remove-group) :type 'user-error)
        (noema-agent-worktree-board-remove-group t)
        (should (equal (mapcar #'car tabulated-list-entries) '("noema/one-1-codex")))
        ;; Branches survive removal.
        (should (eq 0 (car (noema-agent-worktree--git
                            repo "rev-parse" "--verify" "--quiet"
                            "refs/heads/noema/two-2-claude"))))))
    (kill-buffer noema-agent-worktree-board-buffer-name)
    ;; Killing the board stops it following sessions.
    (should-not (memq #'noema-agent-worktree-board--session-changed
                      noema-agent-acp-changed-functions))))

(provide 'noema-agent-worktree-board-tests)
;;; noema-agent-worktree-board-tests.el ends here
