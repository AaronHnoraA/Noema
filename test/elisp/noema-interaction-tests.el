;;; noema-interaction-tests.el --- Tests for noema-interaction -*- lexical-binding: t; -*-

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-interaction-session)
(require 'noema-interaction-backend)
(require 'noema-interaction-profile)
(require 'noema-interaction-tools)
(require 'noema-interaction-status)
(require 'noema-interaction-answer)

;; ── backend registry tests ────────────────────────────────────────────────────

(ert-deftest noema-interaction-backend-registers-and-retracts ()
  "Backend contributions should be visible until their retractor runs."
  (let ((noema-interaction-backend--registry (make-hash-table :test 'eq)))
    (let ((retract
           (noema-interaction-register-backend
            'fake
            :label "Fake"
            :generation 'test
            :capabilities '(:session :send :draft :stop :cancel)
            :operations
            (list :available-p (lambda () t)
                  :live-p (lambda (_root) t)
                  :ensure (lambda (_root) t)
                  :open (lambda (_root) t)
                  :send (lambda (&rest _args) t)
                  :draft (lambda (&rest _args) t)
                  :stop (lambda (_root) t)
                  :cancel (lambda (_root) t)))))
      (should (memq 'fake (noema-interaction-backend-ids :session)))
      (should (noema-interaction-backend-live-p 'fake "/tmp/project/"))
      (funcall retract)
      (should-not (noema-interaction-backend-spec 'fake)))))

(ert-deftest noema-interaction-backend-rejects-incomplete-spec ()
  "Backend contributions must declare required operations."
  (let ((noema-interaction-backend--registry (make-hash-table :test 'eq)))
    (should-error
     (noema-interaction-register-backend
      'bad
      :label "Bad"
      :capabilities '(:session)
      :operations (list :available-p (lambda () t)))
     :type 'error)))

;; ── noema-interaction-answer tests ─────────────────────────────────────────────────

(ert-deftest noema-interaction-answer-parse-single-block ()
  "Parser should extract content from a single answer block."
  (let ((output "Some preamble.\n#+begin answer\nHello world\n#+end answer\nTrailing."))
    (should (equal (noema-interaction-parse-answer-block output)
                   '(:ok . "Hello world")))))

(ert-deftest noema-interaction-answer-parse-last-of-multiple-blocks ()
  "Parser should return the last complete answer block when multiple exist."
  (let ((output "#+begin answer\nfirst\n#+end answer\n#+begin answer\nsecond\n#+end answer"))
    (should (equal (noema-interaction-parse-answer-block output)
                   '(:ok . "second")))))

(ert-deftest noema-interaction-answer-parse-no-block-returns-error ()
  "Parser should return :error with original output when no complete block exists."
  (let ((output "No block here at all."))
    (let ((result (noema-interaction-parse-answer-block output)))
      (should (eq (car result) :error))
      (should (string= (cdr result) output)))))

(ert-deftest noema-interaction-answer-parse-partial-block-returns-error ()
  "Parser should not extract content from an incomplete block."
  (let ((output "#+begin answer\nincomplete without end marker"))
    (let ((result (noema-interaction-parse-answer-block output)))
      (should (eq (car result) :error)))))

(ert-deftest noema-interaction-answer-parse-noisy-output-with-ansi ()
  "Parser should find the answer block even amid ANSI noise and spinner output."
  (let ((output "\033[1mSpinner…\033[0m\nProcessing…\n#+begin answer\nThe answer\n#+end answer\n\033[K"))
    (should (equal (noema-interaction-parse-answer-block output)
                   '(:ok . "The answer")))))

(ert-deftest noema-interaction-answer-parse-empty-block ()
  "Parser should return an empty string for an empty answer block."
  (let ((output "#+begin answer\n#+end answer"))
    (should (equal (noema-interaction-parse-answer-block output)
                   '(:ok . "")))))

(ert-deftest noema-interaction-answer-parse-tolerates-extra-whitespace ()
  "Parser should tolerate leading whitespace on begin/end lines."
  (let ((output "  #+begin answer  \nIndented answer\n  #+end answer  "))
    (should (equal (noema-interaction-parse-answer-block output)
                   '(:ok . "Indented answer")))))

(ert-deftest noema-interaction-answer-wrap-prompt-includes-contract ()
  "Wrapped prompt should include both user task and output contract."
  (let ((wrapped (noema-interaction-wrap-prompt-with-output-contract "Fix bug")))
    (should (string-match-p "Fix bug" wrapped))
    (should (string-search "#+begin answer" wrapped))
    (should (string-match-p "输出要求" wrapped))))

(ert-deftest noema-interaction-profile-names-prefers-all-search-paths ()
  "Profile names should be collected across configured directories."
  (let* ((dir-a (make-temp-file "aiw-profiles-a" t))
         (dir-b (make-temp-file "aiw-profiles-b" t))
         (noema-interaction-profile-search-path (list dir-a dir-b)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "default.txt" dir-a)
            (insert "default a"))
          (with-temp-file (expand-file-name "review.txt" dir-b)
            (insert "review b"))
          (should (equal '("default" "review")
                         (sort (noema-interaction-profile-names) #'string<))))
      (delete-directory dir-a t)
      (delete-directory dir-b t))))

(ert-deftest noema-interaction-profile-read-uses-first-readable-match ()
  "Profile contents should come from the earliest readable search path."
  (let* ((dir-a (make-temp-file "aiw-profile-first" t))
         (dir-b (make-temp-file "aiw-profile-second" t))
         (noema-interaction-profile-search-path (list dir-a dir-b)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "review.txt" dir-a)
            (insert "first"))
          (with-temp-file (expand-file-name "review.txt" dir-b)
            (insert "second"))
          (should (string= "first" (noema-interaction-profile-read "review"))))
      (delete-directory dir-a t)
      (delete-directory dir-b t))))

(ert-deftest noema-interaction-profile-summary-uses-first-line ()
  "Profile summary should use the first non-empty line."
  (let* ((dir-a (make-temp-file "aiw-profile-summary" t))
         (noema-interaction-profile-search-path (list dir-a)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "debug.txt" dir-a)
            (insert "\nFirst summary line\nSecond line\n"))
          (should (string-match-p "First summary line"
                                  (noema-interaction-profile-summary "debug"))))
      (delete-directory dir-a t))))

(ert-deftest noema-interaction-profile-build-prompt-includes-standard-policies ()
  "Built profile prompts should include Git policy and activation reply protocol."
  (let* ((dir-a (make-temp-file "aiw-profile-prompt" t))
         (project-root "/tmp/noema-interaction-tests/")
         (noema-interaction-profile-search-path (list dir-a)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "default.txt" dir-a)
            (insert "Project-specific behavior."))
          (noema-interaction-session-set-profile "default" project-root)
          (let ((prompt (noema-interaction-profile-build-prompt project-root)))
            (should (string-match-p "Git usage rules:" prompt))
            (should (string-match-p "Write approval rules:" prompt))
            (should (string-match-p "已开启 Emacs 特调模式" prompt))
            (should (string-match-p "Project-specific behavior\\." prompt))))
      (delete-directory dir-a t))))

(ert-deftest noema-interaction-profile-build-prompt-prefers-snippet-files ()
  "Built profile prompts should prefer shared snippet files from search path."
  (let* ((profile-dir (make-temp-file "aiw-profile-dir" t))
         (snippet-dir (make-temp-file "aiw-snippet-dir" t))
         (project-root "/tmp/noema-interaction-tests/")
         (noema-interaction-profile-search-path (list profile-dir))
         (noema-interaction-profile-snippet-search-path (list snippet-dir)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "default.txt" profile-dir)
            (insert "Project-specific behavior."))
          (with-temp-file (expand-file-name "git-policy.txt" snippet-dir)
            (insert "Custom git rule."))
          (with-temp-file (expand-file-name "write-policy.txt" snippet-dir)
            (insert "Custom write rule."))
          (with-temp-file (expand-file-name "activation-policy.txt" snippet-dir)
            (insert "Custom activation rule."))
          (noema-interaction-session-set-profile "default" project-root)
          (let ((prompt (noema-interaction-profile-build-prompt project-root)))
            (should (string-match-p "Custom git rule\\." prompt))
            (should (string-match-p "Custom write rule\\." prompt))
            (should (string-match-p "Custom activation rule\\." prompt))
            (should-not (string-match-p "Git usage rules:" prompt))))
      (delete-directory profile-dir t)
      (delete-directory snippet-dir t))))

(ert-deftest noema-interaction-profile-wrap-user-prompt-adds_profile_context ()
  "Wrapped user prompts should prepend the shared profile context."
  (let* ((profile-dir (make-temp-file "aiw-profile-dir" t))
         (snippet-dir (make-temp-file "aiw-snippet-dir" t))
         (project-root "/tmp/noema-interaction-tests/")
         (noema-interaction-profile-search-path (list profile-dir))
         (noema-interaction-profile-snippet-search-path (list snippet-dir)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "default.txt" profile-dir)
            (insert "Project-specific behavior."))
          (with-temp-file (expand-file-name "activation-policy.txt" snippet-dir)
            (insert "Ack first."))
          (noema-interaction-session-set-profile "default" project-root)
          (let ((prompt (noema-interaction-profile-wrap-user-prompt "Fix bug" project-root)))
            (should (string-match-p "Ack first\\." prompt))
            (should (string-match-p "User task:" prompt))
            (should (string-match-p "Fix bug" prompt))))
      (delete-directory profile-dir t)
      (delete-directory snippet-dir t))))

(ert-deftest noema-interaction-profile-uses-editable-template-files ()
  "Profile wrappers should be controlled by editable template files."
  (let* ((profile-dir (make-temp-file "aiw-profile-dir" t))
         (snippet-dir (make-temp-file "aiw-snippet-dir" t))
         (template-dir (make-temp-file "aiw-template-dir" t))
         (project-root "/tmp/noema-interaction-tests/")
         (noema-interaction-profile-search-path (list profile-dir))
         (noema-interaction-profile-snippet-search-path (list snippet-dir))
         (noema-interaction-profile-template-search-path (list template-dir)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "default.txt" profile-dir)
            (insert "Profile body."))
          (with-temp-file (expand-file-name "git-policy.txt" snippet-dir)
            (insert "Git body."))
          (with-temp-file (expand-file-name "write-policy.txt" snippet-dir)
            (insert "Write body."))
          (with-temp-file (expand-file-name "activation-policy.txt" snippet-dir)
            (insert "Activation body."))
          (with-temp-file (expand-file-name "profile-prompt.txt" template-dir)
            (insert "TPL {{profile}} {{working-directory}} {{git-policy}} {{write-policy}} {{activation-policy}} {{profile-text}}"))
          (with-temp-file (expand-file-name "user-prompt-wrapper.txt" template-dir)
            (insert "WRAP\n{{profile-prompt}}\nTASK\n{{user-prompt}}"))
          (noema-interaction-session-set-profile "default" project-root)
          (let ((prompt (noema-interaction-profile-wrap-user-prompt "Fix bug" project-root)))
            (should (string-match-p "\\`WRAP" prompt))
            (should (string-match-p "TPL default" prompt))
            (should (string-match-p "Git body" prompt))
            (should (string-match-p "TASK\nFix bug" prompt))))
      (delete-directory profile-dir t)
      (delete-directory snippet-dir t)
      (delete-directory template-dir t))))

(ert-deftest noema-interaction-profile-rejects-unsafe-etc-names ()
  "Profile and snippet names should not escape their etc directories."
  (should-error (noema-interaction-profile-file "../escape") :type 'user-error)
  (should-error (noema-interaction-profile-snippet-file "bad/name") :type 'user-error)
  (should-error (noema-interaction-profile-template-file "..") :type 'user-error))

(ert-deftest noema-interaction-tools-relative-path-does-not-match-siblings ()
  "Relative path helpers should not treat sibling prefixes as project files."
  (should-not
   (string= "ile/a.el"
            (noema-interaction-tools--relative-path
             "/tmp/projectile/a.el"
             "/tmp/project/"))))

(ert-deftest noema-interaction-tools-range-reference-uses-line-columns ()
  "Range references should point to file, line, and column locations."
  (with-temp-buffer
    (insert "alpha\nbeta\n")
    (let ((start (point-min))
          end)
      (goto-char (point-min))
      (search-forward "be")
      (setq end (point))
      (should (string= "@range note.el:1:0-2:2 selection"
                       (noema-interaction-tools--format-range
                        "note.el" start end "selection"))))))

(ert-deftest noema-interaction-tools-writing-prompt-uses-editable-template ()
  "Writing prompts should be rendered from editable template files."
  (let* ((template-dir (make-temp-file "aiw-writing-template-dir" t))
         (noema-interaction-profile-template-search-path (list template-dir)))
    (unwind-protect
        (progn
          (with-temp-file (expand-file-name "writing-prompt.txt" template-dir)
            (insert "WRITE {{mode}}\n{{task}}\n{{context}}\n{{text}}"))
          (let ((prompt (noema-interaction-tools--writing-prompt
                         "润色" "make it concise" "hello" "source: note.org")))
            (should (string-match-p "\\`WRITE 润色" prompt))
            (should (string-match-p "make it concise" prompt))
            (should (string-match-p "source: note\\.org" prompt))
            (should (string-match-p "hello" prompt))))
      (delete-directory template-dir t))))

(ert-deftest noema-interaction-tools-writing-text-refuses-code-buffers ()
  "Writing prompts should not copy source code from programming buffers."
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(message \"hi\")")
    (should-error (noema-interaction-tools--writing-text) :type 'user-error)))

(ert-deftest noema-interaction-session-reset-profile-injected-clears-all-backends ()
  "Resetting injected profile state should clear every backend marker."
  (let ((project-root "/tmp/noema-interaction-tests/"))
    (noema-interaction-session-mark-profile-injected 'claude project-root)
    (noema-interaction-session-mark-profile-injected 'codex project-root)
    (noema-interaction-session-reset-profile-injected project-root)
    (should-not (noema-interaction-session-profile-injected-p 'claude project-root))
    (should-not (noema-interaction-session-profile-injected-p 'codex project-root))))

(ert-deftest noema-interaction-status-render-includes-core-fields ()
  "Status rendering should surface the main project fields."
  (let* ((project-root "/tmp/noema-interaction-tests/")
         (noema-interaction-profile-search-path nil))
    (noema-interaction-session-set-backend 'codex project-root)
    (noema-interaction-session-set-profile "default" project-root)
    (noema-interaction-session-set-initialized t project-root)
    (noema-interaction-session-set-last-status "Ready" project-root)
    (noema-interaction-session-set-last-prompt "Fix tests" project-root)
    (let ((text (noema-interaction-status--render project-root)))
      (should (string-match-p "Backend[[:space:]]+codex" text))
      (should (string-match-p "Profile[[:space:]]+default" text))
      (should (string-match-p "Profile summary" text))
      (should (string-match-p "Last status[[:space:]]+Ready" text))
      (should (string-match-p "Fix tests" text)))))

(ert-deftest noema-interaction-tools-project-file-summary-limits-output ()
  "Project file summaries should truncate long file lists."
  (cl-letf (((symbol-function 'project-current)
             (lambda (&rest _) 'dummy-project))
            ((symbol-function 'project-files)
             (lambda (&rest _)
               (mapcar (lambda (name)
                         (expand-file-name name "/tmp/project/"))
                       '("a.el" "b.el" "c.el")))))
    (let ((noema-interaction-tools-project-files-limit 2))
      (should (string-match-p
               "\\.\\.\\. 1 more file"
               (noema-interaction-tools--project-file-summary "/tmp/project/"))))))

(ert-deftest noema-interaction-tools-test-failure-summary-reads-compilation-buffer ()
  "Test failure summaries should extract failure lines from active buffers."
  (let ((buffer (get-buffer-create "*compilation*")))
    (unwind-protect
        (with-current-buffer buffer
          (insert "ok\nFAIL test_example\nAssertionError: boom\n")
          (compilation-mode)
          (let ((summary (noema-interaction-tools--test-failure-summary)))
            (should (string-match-p "FAIL test_example" summary))
            (should (string-match-p "AssertionError: boom" summary))))
      (when (buffer-live-p buffer)
        (kill-buffer buffer)))))

(provide 'noema-interaction-tests)
;;; noema-interaction-tests.el ends here
