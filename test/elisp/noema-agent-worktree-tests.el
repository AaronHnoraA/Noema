;;; noema-agent-worktree-tests.el --- Tests for worktree sessions -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Each test builds a real repository in a temporary directory and drives Git
;; through the same `process-file' path a session uses.  No agent starts:
;; an agent session is stood in for by a buffer whose directory is the
;; worktree, which is all the redirect and removal guards read.

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-agent-worktree)
(require 'noema-context)

(defmacro noema-agent-worktree-tests--with-repo (&rest body)
  "Run BODY with `repo' bound to a fresh repository with one commit.
`parent' is the directory holding it, removed afterwards with its worktrees."
  (declare (indent 0) (debug t))
  `(let* ((parent (file-name-as-directory
                   (file-truename (make-temp-file "noema-worktree-" t))))
          (repo (file-name-as-directory (expand-file-name "repo" parent)))
          (process-environment
           (append '("GIT_CONFIG_GLOBAL=/dev/null" "GIT_CONFIG_NOSYSTEM=1"
                     "GIT_AUTHOR_NAME=Noema" "GIT_AUTHOR_EMAIL=noema@example.invalid"
                     "GIT_COMMITTER_NAME=Noema" "GIT_COMMITTER_EMAIL=noema@example.invalid")
                   process-environment))
          (sessions '()))
     (unwind-protect
         (progn
           (make-directory (expand-file-name "src" repo) t)
           (with-temp-file (expand-file-name "src/a.el" repo) (insert "one\ntwo\n"))
           (noema-agent-worktree--git-ok repo "init" "-q" "-b" "main")
           (noema-agent-worktree--git-ok repo "add" ".")
           (noema-agent-worktree--git-ok repo "commit" "-q" "-m" "init")
           ,@body)
       (dolist (buffer sessions) (when (buffer-live-p buffer) (kill-buffer buffer)))
       (delete-directory parent t))))

(defun noema-agent-worktree-tests--session (directory)
  "Return a stand-in agent buffer working in DIRECTORY."
  (let ((buffer (generate-new-buffer " *noema-worktree-session*")))
    (with-current-buffer buffer (setq default-directory directory))
    buffer))

(ert-deftest noema-agent-worktree-create-beside-repository ()
  (noema-agent-worktree-tests--with-repo
    (let* ((worktree (noema-agent-worktree-create repo "Fix Parser!"))
           (path (plist-get worktree :path))
           (checkout (noema-agent-worktree-checkout path)))
      (should (equal path (expand-file-name "repo.noema-worktrees/fix-parser/" parent)))
      (should (equal (plist-get worktree :branch) "noema/fix-parser"))
      (should (equal (plist-get worktree :base) "main"))
      (should (file-exists-p (expand-file-name "src/a.el" path)))
      (should (plist-get checkout :linked))
      (should (equal (plist-get checkout :toplevel) path))
      (should (equal (plist-get checkout :native-primary) repo))
      (should (equal (plist-get checkout :base) "main"))
      ;; The main checkout is not linked and has no recorded base.
      (should-not (plist-get (noema-agent-worktree-checkout repo) :linked))
      (should-not (plist-get (noema-agent-worktree-checkout repo) :base))
      (should-error (noema-agent-worktree-create repo "fix parser") :type 'user-error))))

(ert-deftest noema-agent-worktree-checkout-from-subdirectory ()
  (noema-agent-worktree-tests--with-repo
    (should (equal (plist-get (noema-agent-worktree-checkout
                               (expand-file-name "src/" repo))
                              :toplevel)
                   repo))
    (should-not (noema-agent-worktree-checkout parent))))

(ert-deftest noema-agent-worktree-redirects-main-checkout-files ()
  (noema-agent-worktree-tests--with-repo
    (let* ((path (plist-get (noema-agent-worktree-create repo "w") :path))
           (session (noema-agent-worktree-tests--session path))
           (main (noema-agent-worktree-tests--session repo)))
      (setq sessions (list session main))
      (should (equal (noema-agent-worktree-redirect
                      (expand-file-name "src/a.el" repo) session)
                     (cons (expand-file-name "src/a.el" path) "src/a.el")))
      ;; Already the worktree's own file, or a session on the main checkout.
      (should-not (noema-agent-worktree-redirect (expand-file-name "src/a.el" path) session))
      (should-not (noema-agent-worktree-redirect (expand-file-name "src/a.el" repo) main))
      ;; A file outside the repository is left alone.
      (should-not (noema-agent-worktree-redirect (expand-file-name "other" parent) session))
      ;; A file only the main checkout has is an error, never a fallback.
      (with-temp-file (expand-file-name "src/new.el" repo) (insert "x"))
      (should-error (noema-agent-worktree-redirect
                     (expand-file-name "src/new.el" repo) session)
                    :type 'user-error))))

(ert-deftest noema-agent-worktree-redirects-through-symbolic-links ()
  ;; Git prints resolved paths; a buffer may name the file through a link.
  (noema-agent-worktree-tests--with-repo
    (let* ((path (plist-get (noema-agent-worktree-create repo "link") :path))
           (link (expand-file-name "repo-link" parent))
           (session (noema-agent-worktree-tests--session path)))
      (setq sessions (list session))
      (make-symbolic-link (directory-file-name repo) link)
      (should (equal (noema-agent-worktree-redirect
                      (expand-file-name "repo-link/src/a.el" parent) session)
                     (cons (expand-file-name "src/a.el" path) "src/a.el"))))))

(ert-deftest noema-agent-worktree-git-keeps-caller-environment ()
  ;; A workspace capsule is buffer-local; Git must still see it.
  (noema-agent-worktree-tests--with-repo
    (with-temp-buffer
      (setq-local process-environment
                  (cons "NOEMA_WORKTREE_PROBE=capsule" process-environment))
      (should (equal (noema-agent-worktree--git-ok
                      repo "-c" "alias.probe=!printf %s \"$NOEMA_WORKTREE_PROBE\"" "probe")
                     "capsule")))))

(ert-deftest noema-agent-worktree-context-reference-names-worktree-copy ()
  (noema-agent-worktree-tests--with-repo
    (let* ((path (plist-get (noema-agent-worktree-create repo "ctx") :path))
           (session (noema-agent-worktree-tests--session path))
           (reference (noema-context--reference
                       (expand-file-name "src/a.el" repo) repo nil nil session)))
      (setq sessions (list session))
      (should (equal (plist-get reference :agent-file) (expand-file-name "src/a.el" path)))
      (should (equal (plist-get reference :relative) "src/a.el"))
      ;; The reference still names the buffer the person selected in.
      (should (equal (plist-get reference :file) (expand-file-name "src/a.el" repo))))))

(ert-deftest noema-agent-worktree-list-and-remove ()
  (noema-agent-worktree-tests--with-repo
    (let* ((worktree (progn (noema-agent-worktree-create repo "keep")
                            (noema-agent-worktree-create repo "gone")
                            (seq-find (lambda (w) (equal (plist-get w :branch) "noema/gone"))
                                      (noema-agent-worktree-list repo))))
           (path (plist-get worktree :path)))
      ;; Only Noema's worktrees are listed, never the main checkout.
      (should (equal (sort (mapcar (lambda (w) (plist-get w :branch))
                                   (noema-agent-worktree-list repo))
                           #'string<)
                     '("noema/gone" "noema/keep")))
      (should (equal (plist-get worktree :repo) repo))
      (with-temp-file (expand-file-name "src/a.el" path) (insert "changed\n"))
      (cl-letf (((symbol-function 'yes-or-no-p) (lambda (&rest _) t))
                ((symbol-function 'noema-agent-acp-agent-buffer-p) #'bufferp))
        ;; A session still working there blocks removal, even when forced.
        (let ((session (noema-agent-worktree-tests--session path)))
          (setq sessions (list session))
          (should-error (noema-agent-worktree-remove worktree t) :type 'user-error)
          (kill-buffer session))
        ;; Uncommitted changes need the force argument.
        (should-error (noema-agent-worktree-remove worktree) :type 'user-error)
        (should (file-exists-p path))
        (noema-agent-worktree-remove worktree t))
      (should-not (file-exists-p path))
      ;; The branch, and so any committed work, survives.
      (should (eq 0 (car (noema-agent-worktree--git
                          repo "rev-parse" "--verify" "--quiet" "refs/heads/noema/gone"))))
      (should (equal (mapcar (lambda (w) (plist-get w :branch))
                             (noema-agent-worktree-list repo))
                     '("noema/keep"))))))

(ert-deftest noema-agent-worktree-diff-starts-at-branch-point ()
  (noema-agent-worktree-tests--with-repo
    (let* ((path (plist-get (noema-agent-worktree-create repo "diff") :path))
           (branch-point (noema-agent-worktree--git-ok repo "rev-parse" "main"))
           requested)
      ;; Both checkouts move on; the review still starts where the branch began.
      (with-temp-file (expand-file-name "src/a.el" path) (insert "agent\n"))
      (noema-agent-worktree--git-ok path "commit" "-q" "-am" "agent work")
      (with-temp-file (expand-file-name "src/a.el" repo) (insert "main\n"))
      (noema-agent-worktree--git-ok repo "commit" "-q" "-am" "main work")
      (cl-letf (((symbol-function 'noema-agent-worktree--require-magit) #'ignore)
                ((symbol-function 'magit-diff-working-tree)
                 (lambda (&optional rev &rest _)
                   (setq requested (list rev default-directory)))))
        (noema-agent-worktree-magit-diff (expand-file-name "src/" path))
        (should (equal requested (list branch-point path)))
        ;; Outside a worktree session it is the uncommitted edits.
        (noema-agent-worktree-magit-diff repo)
        (should (equal requested (list nil repo)))))))

(ert-deftest noema-agent-worktree-slug ()
  (should (equal (noema-agent-worktree--slug "  Try: the NEW idea  ") "try-the-new-idea"))
  (should-error (noema-agent-worktree--slug "!!!") :type 'user-error))

(provide 'noema-agent-worktree-tests)
;;; noema-agent-worktree-tests.el ends here
