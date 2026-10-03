;;; noema-agent-worktree.el --- Agent sessions in their own Git worktree -*- lexical-binding: t; -*-

;;; Commentary:
;; Several coding sessions of one Project otherwise share a single checkout and
;; overwrite each other's edits.  A worktree session gets its own linked Git
;; worktree and branch, beside the repository rather than in it, and is still
;; registered under the Project it was started from: a worktree is a place to
;; work, not a Project (D-038).  The durable Session already records where its
;; agent ran (`executionTarget'), so a resumed conversation reopens there.
;;
;; Every Git call runs through `process-file' in an Emacs directory, so the
;; same code serves a local checkout and one on a remote target.  Paths handed
;; to Git are relative to the checkout; target-native paths Git prints are only
;; compared with the native paths agents see, never turned into Emacs names.
;;
;; The branch remembers its base in `branch.<name>.noemaBase', which is also
;; what marks a worktree as Noema's: removal only offers those, refuses a
;; checkout with uncommitted changes unless forced, and always keeps the
;; branch, so committed work survives cleanup.
;;
;; Design source: Agent Fleet's per-agent worktrees and Magit review
;; (docs/agent-fleet-noema-audit-2026-10.md in the Emacs configuration).

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)

(declare-function noema-agent-acp-adopt "noema-agent-acp" (buffer &rest args))
(declare-function noema-agent-acp-agent-buffer-p "noema-agent-acp" (buffer))
(declare-function noema-agent-acp-config-for "noema-agent-acp" (agent))
(declare-function noema-agent-acp-project-root "noema-agent-acp" (&optional directory))
(declare-function noema-agent-acp-start "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp--unique-name "noema-agent-acp" (base root))
(declare-function noema-project-workspace "noema-research" (root))
(declare-function magit-status-setup-buffer "magit-status" (&optional directory))
(declare-function magit-diff-working-tree "magit-diff" (&optional rev args files))

(defgroup noema-agent-worktree nil
  "Noema agent sessions in their own Git worktree."
  :group 'applications)

(defcustom noema-agent-worktree-branch-prefix "noema/"
  "Prefix of the branch each worktree session works on."
  :type 'string
  :group 'noema-agent-worktree)

(defcustom noema-agent-worktree-directory-suffix ".noema-worktrees"
  "Suffix of the directory beside a repository that holds its worktrees.
For a repository at PARENT/REPO, worktrees live in PARENT/REPO<suffix>/NAME,
outside the checkout so they never appear in its status or searches."
  :type 'string
  :group 'noema-agent-worktree)

(defconst noema-agent-worktree-agents '("codex" "claude" "opencode")
  "Agents whose sessions can start in a chosen directory.")

(defvar-local noema-agent-worktree--checkout nil
  "Cached (DIRECTORY . CHECKOUT) for an agent buffer; see the checkout reader.")


;;;; ── Git ──────────────────────────────────────────────────────────────────

(defun noema-agent-worktree--git (directory &rest args)
  "Run Git with ARGS in Emacs DIRECTORY; return (STATUS . OUTPUT).
The caller's environment and `exec-path' are carried into the temporary
buffer, where a workspace's buffer-local environment would otherwise be lost."
  (let ((environment process-environment)
        (path exec-path)
        (directory (file-name-as-directory directory)))
    (with-temp-buffer
      (let* ((process-environment environment)
             (exec-path path)
             (default-directory directory)
             (status (apply #'process-file "git" nil t nil args)))
        (cons status (buffer-string))))))

(defun noema-agent-worktree--git-ok (directory &rest args)
  "Run Git with ARGS in DIRECTORY and return its trimmed output, or signal."
  (let ((result (apply #'noema-agent-worktree--git directory args)))
    (unless (eq (car result) 0)
      (user-error "git %s failed: %s" (string-join args " ")
                  (string-trim (cdr result))))
    (string-trim (cdr result))))

(defun noema-agent-worktree-checkout (directory)
  "Describe the Git checkout containing Emacs DIRECTORY, or return nil.
The plist has :toplevel and :primary (Emacs names of this checkout and of
the repository's main one), :native-toplevel and :native-primary (their
target-native paths), :linked (non-nil in a linked worktree), :branch and
:base."
  (let ((result (noema-agent-worktree--git
                 directory "rev-parse" "--path-format=absolute"
                 "--show-toplevel" "--git-common-dir" "--show-cdup"
                 "--abbrev-ref" "HEAD")))
    (when (eq (car result) 0)
      (pcase-let* ((`(,native-top ,common ,cdup ,branch)
                    (split-string (cdr result) "\n"))
                   (primary (and (equal (file-name-nondirectory
                                         (directory-file-name common))
                                        ".git")
                                 (file-name-directory
                                  (directory-file-name common))))
                   (native-top (file-name-as-directory native-top))
                   (branch (and (not (member branch '("" "HEAD"))) branch)))
        (let ((toplevel (file-name-as-directory
                         (expand-file-name cdup (file-name-as-directory directory)))))
          (list :toplevel toplevel
                ;; Git prints both natives resolved, so their relation carries
                ;; over to the Emacs spelling of whichever target this is.
                :primary (and primary
                              (file-name-as-directory
                               (expand-file-name (file-relative-name primary native-top)
                                                 toplevel)))
                :native-toplevel native-top
                :native-primary primary
                :linked (and primary (not (equal primary native-top)))
                :branch branch
                :base (and branch
                           (let ((base (noema-agent-worktree--git
                                        directory "config" "--get"
                                        (format "branch.%s.noemaBase" branch))))
                             (and (eq (car base) 0)
                                  (string-trim (cdr base)))))))))))

(defun noema-agent-worktree--session-checkout (session)
  "Return the checkout of agent buffer SESSION, cached for its directory."
  (let ((directory (buffer-local-value 'default-directory session)))
    (with-current-buffer session
      (unless (equal (car noema-agent-worktree--checkout) directory)
        (setq noema-agent-worktree--checkout
              (cons directory (noema-agent-worktree-checkout directory))))
      (cdr noema-agent-worktree--checkout))))


;;;; ── Context sent to a worktree session ───────────────────────────────────

(defun noema-agent-worktree-redirect (file session)
  "Return (AGENT-FILE . RELATIVE) for FILE inside SESSION's worktree, or nil.
FILE is an Emacs name.  A file of the repository's main checkout, sent to a
session working in a linked worktree, means that worktree's copy: the agent
must edit its own checkout, not the one it was isolated from.  AGENT-FILE is
the copy's target-native path and RELATIVE its path in the checkout.  Signal
when the worktree has no such file rather than fall back to the main
checkout.  nil means no redirection."
  (when-let* (((buffer-live-p session))
              (checkout (noema-agent-worktree--session-checkout session))
              ((plist-get checkout :linked))
              (primary (plist-get checkout :primary))
              (top (plist-get checkout :toplevel))
              ;; Both tests resolve symbolic links, which Git already has.
              ((file-in-directory-p file primary))
              ;; A worktree kept inside the main checkout already holds it.
              ((not (file-in-directory-p file top))))
    (let ((relative (file-relative-name (file-truename file) (file-truename primary))))
      (unless (file-exists-p (expand-file-name relative top))
        (user-error "%s does not exist in worktree %s" relative top))
      (cons (concat (plist-get checkout :native-toplevel) relative) relative))))


;; A region names lines of the buffer the person selected in.  The worktree's
;; copy may have moved on, and the same numbers would then point the agent at
;; other code; refuse such a reference rather than send it.
(defun noema-agent-worktree--lines (first last)
  "Return lines FIRST to LAST of the current buffer, or nil when it is shorter."
  (save-restriction
    (widen)
    (save-excursion
      (goto-char (point-min))
      (when (zerop (forward-line (1- first)))
        (let ((start (point)))
          (when (zerop (forward-line (- last first)))
            (buffer-substring-no-properties start (line-end-position))))))))

(defun noema-agent-worktree-check-region (buffer first last relative session)
  "Signal unless lines FIRST to LAST of BUFFER read the same in SESSION's copy.
RELATIVE is the file's path in SESSION's checkout."
  (let ((copy (expand-file-name
               relative
               (plist-get (noema-agent-worktree--session-checkout session) :toplevel)))
        (text (with-current-buffer buffer (noema-agent-worktree--lines first last))))
    (unless (equal text (with-temp-buffer
                          (insert-file-contents copy)
                          (noema-agent-worktree--lines first last)))
      (user-error "Lines %d-%d of %s differ in worktree %s; select them in its copy"
                  first last relative
                  (plist-get (noema-agent-worktree--session-checkout session) :toplevel)))))

;;;; ── Creating, reviewing and removing worktrees ───────────────────────────

(defun noema-agent-worktree--slug (name)
  "Return NAME as a branch- and directory-safe component."
  (let ((slug (replace-regexp-in-string
               "-+" "-"
               (replace-regexp-in-string "[^a-z0-9._-]" "-" (downcase name)))))
    (setq slug (string-trim slug "[-.]+" "[-.]+"))
    (when (string-empty-p slug)
      (user-error "Worktree name has no usable characters: %S" name))
    slug))

(defun noema-agent-worktree-create (directory name &optional base)
  "Create a linked worktree named NAME for the repository at DIRECTORY.
BASE is the commit-ish to branch from, defaulting to the current branch (or
commit when detached).  Return a plist with :path (the worktree, an Emacs
name), :branch and :base."
  (let* ((checkout (or (noema-agent-worktree-checkout directory)
                       (user-error "Not in a Git repository: %s" directory)))
         (top (plist-get checkout :toplevel))
         (slug (noema-agent-worktree--slug name))
         (branch (concat noema-agent-worktree-branch-prefix slug))
         (base (or base (plist-get checkout :branch)
                   (noema-agent-worktree--git-ok top "rev-parse" "HEAD")))
         (relative (format "../%s%s/%s"
                           (file-name-nondirectory (directory-file-name top))
                           noema-agent-worktree-directory-suffix slug))
         (path (file-name-as-directory (expand-file-name relative top))))
    (when (eq 0 (car (noema-agent-worktree--git
                      top "rev-parse" "--verify" "--quiet"
                      (concat "refs/heads/" branch))))
      (user-error "Branch %s already exists" branch))
    (when (file-exists-p path)
      (user-error "Worktree directory already exists: %s" path))
    (noema-agent-worktree--git-ok top "worktree" "add" "-b" branch relative base)
    (noema-agent-worktree--git-ok top "config" (format "branch.%s.noemaBase" branch) base)
    (list :path path :branch branch :base base)))

;;;###autoload
(defun noema-agent-worktree-start (agent name)
  "Start AGENT in a new Git worktree named NAME of the current Project.
The worktree branches from the workspace's current branch.  The session is
registered under the Project like any other and starts in the worktree's
counterpart of the Project workspace."
  (interactive
   (list (intern (completing-read "Agent in a new worktree: "
                                  noema-agent-worktree-agents nil t nil nil "codex"))
         (read-string "Worktree name: ")))
  (let ((started (noema-agent-worktree--start agent name :focus t)))
    (message "Noema: %s works on branch %s in %s"
             agent (plist-get started :branch) (plist-get started :path))
    (plist-get started :buffer)))

(defun noema-agent-worktree--workspace ()
  "Return (ROOT . WORKSPACE) of the current Project."
  (require 'noema-agent-acp)
  (let ((root (noema-agent-acp-project-root)))
    (cons root (if (require 'noema-research nil t)
                   (noema-project-workspace root)
                 root))))

(cl-defun noema-agent-worktree--start (agent name &key focus group)
  "Start AGENT in a new worktree NAME of the current Project; return a plist.
FOCUS shows the session.  GROUP, a slug, records the worktree as one attempt
of that parallel group.  The plist is the worktree's plus :buffer."
  (pcase-let* ((`(,root . ,workspace) (noema-agent-worktree--workspace))
               (config (or (noema-agent-acp-config-for agent)
                           (user-error "No agent-shell configuration for %s" agent)))
               (checkout (or (noema-agent-worktree-checkout workspace)
                             (user-error "The Project workspace is not a Git repository: %s"
                                         workspace)))
               (offset (file-relative-name workspace (plist-get checkout :toplevel)))
               (worktree (noema-agent-worktree-create workspace name))
               (branch (plist-get worktree :branch)))
    (noema-agent-worktree--set worktree "noemaAgent" (format "%s" agent))
    (when group
      (noema-agent-worktree--set worktree "noemaGroup" group))
    (let ((buffer (noema-agent-acp-start
                   :config config :origin 'manual :focus focus
                   :directory (file-name-as-directory
                               (expand-file-name offset (plist-get worktree :path))))))
      (noema-agent-acp-adopt
       buffer :agent agent :origin 'manual :root root
       :name (noema-agent-acp--unique-name
              (format "worktree/%s" (substring branch (length noema-agent-worktree-branch-prefix)))
              root))
      (append (list :buffer buffer :agent (format "%s" agent) :group group) worktree))))

(defun noema-agent-worktree--set (worktree key value)
  "Record VALUE under KEY in the branch configuration of WORKTREE."
  (noema-agent-worktree--git-ok (plist-get worktree :path) "config"
                                (format "branch.%s.%s" (plist-get worktree :branch) key)
                                value))

(defun noema-agent-worktree--require-magit ()
  "Load Magit or explain that the review commands need it."
  (unless (require 'magit nil t)
    (user-error "Reviewing a session's checkout needs Magit")))

;;;###autoload
(defun noema-agent-worktree-magit-status (directory)
  "Open Magit status for the checkout containing DIRECTORY."
  (interactive (list default-directory))
  (noema-agent-worktree--require-magit)
  (let ((checkout (or (noema-agent-worktree-checkout directory)
                      (user-error "Not in a Git repository: %s" directory))))
    (magit-status-setup-buffer (plist-get checkout :toplevel))))

;;;###autoload
(defun noema-agent-worktree-magit-diff (directory)
  "Show everything changed in the checkout containing DIRECTORY.
For a worktree session that is its commits and uncommitted edits together,
against the point it branched from; otherwise the uncommitted edits."
  (interactive (list default-directory))
  (noema-agent-worktree--require-magit)
  (let* ((checkout (or (noema-agent-worktree-checkout directory)
                       (user-error "Not in a Git repository: %s" directory)))
         (top (plist-get checkout :toplevel))
         (base (plist-get checkout :base))
         (default-directory top))
    (magit-diff-working-tree
     (and base (noema-agent-worktree--git-ok top "merge-base" base "HEAD")))))

(defun noema-agent-worktree--branch-config (top)
  "Return Noema's branch settings in repository TOP as an alist.
Each entry is (BRANCH . PLIST) with :base, :agent and :group, read in one
Git call however many worktrees there are."
  (let ((result (noema-agent-worktree--git
                 top "config" "--get-regexp" "^branch\\..*\\.noema"))
        branches)
    (when (eq (car result) 0)
      (dolist (line (split-string (cdr result) "\n" t))
        ;; branch.<name>.<key> <value>; a branch name may hold dots, a key not.
        (when (string-match "\\`branch\\.\\(.+\\)\\.\\(noema[a-z]+\\) \\(.*\\)\\'" line)
          (let* ((branch (match-string 1 line))
                 (key (pcase (match-string 2 line)
                        ("noemabase" :base) ("noemaagent" :agent) ("noemagroup" :group)))
                 (cell (or (assoc branch branches)
                           (car (push (list branch) branches)))))
            (when key
              (setcdr cell (plist-put (cdr cell) key (match-string 3 line))))))))
    branches))

(defun noema-agent-worktree-list (directory)
  "Return Noema's worktrees of the repository at DIRECTORY.
Each is a plist with :path (an Emacs name), :branch, :base, :agent, :group
and :repo, the checkout DIRECTORY belongs to, from which Git removes it."
  (let* ((checkout (or (noema-agent-worktree-checkout directory)
                       (user-error "Not in a Git repository: %s" directory)))
         (top (plist-get checkout :toplevel))
         (native-top (plist-get checkout :native-toplevel))
         (settings (noema-agent-worktree--branch-config top))
         (porcelain (noema-agent-worktree--git-ok top "worktree" "list" "--porcelain"))
         result path)
    (dolist (line (split-string porcelain "\n"))
      (cond
       ((string-prefix-p "worktree " line)
        (setq path (substring line (length "worktree "))))
       ((and path (string-prefix-p "branch refs/heads/" line))
        (let* ((branch (substring line (length "branch refs/heads/")))
               (setting (cdr (assoc branch settings))))
          (when (plist-get setting :base)
            (push (append (list :path (file-name-as-directory
                                       (expand-file-name
                                        (file-relative-name path native-top) top))
                                :branch branch :repo top)
                          setting)
                  result))))))
    (nreverse result)))

(defun noema-agent-worktree--sessions-in (path)
  "Return the live agent buffers working inside worktree PATH."
  (seq-filter (lambda (buffer)
                (and (noema-agent-acp-agent-buffer-p buffer)
                     (file-in-directory-p
                      (buffer-local-value 'default-directory buffer) path)))
              (buffer-list)))

;;;###autoload
(defun noema-agent-worktree-remove (worktree &optional force)
  "Remove Noema WORKTREE, keeping its branch.
WORKTREE is a plist from `noema-agent-worktree-list'.  A worktree with
uncommitted changes is refused unless FORCE (the prefix argument) is given;
one an open agent session still works in is always refused."
  (interactive
   (progn
     (require 'noema-agent-acp)
     (let* ((root (noema-agent-acp-project-root))
            (workspace (if (require 'noema-research nil t)
                           (noema-project-workspace root)
                         root))
            (worktrees (or (noema-agent-worktree-list workspace)
                           (user-error "This Project has no Noema worktrees")))
            (choices (mapcar (lambda (worktree)
                               (cons (format "%s  %s" (plist-get worktree :branch)
                                             (plist-get worktree :path))
                                     worktree))
                             worktrees)))
       (list (cdr (assoc (completing-read "Remove worktree: " choices nil t)
                         choices))
             current-prefix-arg))))
  (let* ((path (plist-get worktree :path))
         (branch (plist-get worktree :branch))
         (sessions (noema-agent-worktree--sessions-in path))
         (dirty (not (string-empty-p
                      (noema-agent-worktree--git-ok path "status" "--porcelain")))))
    (when sessions
      (user-error "Close the session working there first: %s"
                  (mapconcat #'buffer-name sessions ", ")))
    (when (and dirty (not force))
      (user-error "%s has uncommitted changes; commit them, or use a prefix argument to discard them"
                  path))
    (when (yes-or-no-p (format "%s worktree %s (branch %s is kept)? "
                               (if dirty "Discard changes and remove" "Remove")
                               path branch))
      (noema-agent-worktree--remove worktree dirty)
      (message "Noema: removed %s; branch %s is kept" path branch))))

(defun noema-agent-worktree--remove (worktree force)
  "Remove WORKTREE without asking; FORCE discards its uncommitted edits.
The branch is kept.  Callers check for open sessions and edits first."
  (let ((repo (plist-get worktree :repo)))
    (apply #'noema-agent-worktree--git-ok repo "worktree" "remove"
           (append (and force '("--force"))
                   (list (directory-file-name
                          (file-relative-name (plist-get worktree :path) repo)))))))

(provide 'noema-agent-worktree)
;;; noema-agent-worktree.el ends here
