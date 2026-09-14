;;; noema-interaction-tools.el --- Reference tools for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Reference-oriented prompt helpers for noema-interaction.

;;; Code:

(require 'project)
(require 'thingatpt)
(require 'seq)
(require 'subr-x)
(require 'noema-interaction-session)
(require 'noema-interaction-profile)

(declare-function which-function "which-func" ())
(declare-function flymake-diagnostic-text "flymake" (diag))
(declare-function flycheck-error-level "flycheck" (err))
(declare-function noema-interaction-draft-string "noema-interaction" (backend prompt &optional project-root))
(declare-function noema-interaction-send-string "noema-interaction" (backend prompt &optional project-root))
(declare-function noema-interaction-open "noema-interaction" ())
(declare-function noema-interaction-claude-session-live-p "noema-interaction-adapter-claude" (&optional project-root))
(declare-function noema-interaction-codex-session-live-p  "noema-interaction-adapter-codex"  (&optional project-root))
(declare-function noema-interaction-opencode-session-live-p "noema-interaction-adapter-opencode" (&optional project-root))

(autoload 'noema-interaction-draft-string "noema-interaction")
(autoload 'noema-interaction-send-string "noema-interaction")
(autoload 'noema-interaction-open "noema-interaction" nil t)

(defvar flycheck-current-errors)

(defcustom noema-interaction-tools-project-files-limit 40
  "Maximum number of project files included in project file references."
  :type 'integer
  :group 'noema-interaction)

(defcustom noema-interaction-tools-test-failure-lines-limit 20
  "Maximum number of lines included in test failure references."
  :type 'integer
  :group 'noema-interaction)

(defconst noema-interaction-tools--context-template-fallback
  "{{task-section}}\n\n{{references}}"
  "Minimal fallback used only when editable context template is unavailable.")

(defconst noema-interaction-tools--writing-template-fallback
  "{{mode}}\n\n{{task}}\n\n{{context}}\n\n{{text}}"
  "Minimal fallback used only when editable writing template is unavailable.")

(defconst noema-interaction-writing-modes
  '(("润色" . polish)
    ("改写" . rewrite)
    ("总结" . summarize)
    ("翻译" . translate)
    ("提纲" . outline)
    ("续写" . continue)
    ("评论" . critique))
  "Writing modes exposed by `noema-interaction-writing-prompt'.")

(defconst noema-interaction-tool-choices
  '(("@本文件" . current-file)
    ("@本行" . current-line)
    ("@所选" . region)
    ("@符号" . current-symbol)
    ("@函数" . defun)
    ("@块" . block)
    ("@项目" . project-root)
    ("@项目文件" . project-files)
    ("@最近修改" . recent-changes)
    ("@Git状态" . git-status)
    ("@诊断" . diagnostics)
    ("@测试失败" . test-failures))
  "Choices exposed by `noema-interaction-context-prompt'.")

(defun noema-interaction-tools--relative-path (file project-root)
  "Return FILE relative to PROJECT-ROOT when possible."
  (if (and file project-root (file-in-directory-p file project-root))
      (file-relative-name file project-root)
    (abbreviate-file-name file)))

(defun noema-interaction-tools--current-file ()
  "Return the current file or signal an error."
  (or (buffer-file-name)
      (user-error "Current buffer is not visiting a file")))

(defun noema-interaction-tools--line-reference (file)
  "Return a reference string for FILE at point."
  (format "@line %s:%d:%d"
          file
          (line-number-at-pos)
          (current-column)))

(defun noema-interaction-tools--position-line-column (position)
  "Return POSITION as a cons cell of line and column."
  (save-excursion
    (goto-char position)
    (cons (line-number-at-pos) (current-column))))

(defun noema-interaction-tools--format-range (file start end &optional label)
  "Return a FILE reference from START to END with optional LABEL."
  (let ((start-lc (noema-interaction-tools--position-line-column start))
        (end-lc (noema-interaction-tools--position-line-column end)))
    (string-join
     (delq nil
           (list
            (format "@range %s:%d:%d-%d:%d"
                    file
                    (car start-lc)
                    (cdr start-lc)
                    (car end-lc)
                    (cdr end-lc))
            label))
     " ")))

(defun noema-interaction-tools--symbol-reference (file)
  "Return a reference string for the symbol at point in FILE."
  (let ((symbol (thing-at-point 'symbol t)))
    (unless symbol
      (user-error "No symbol at point"))
    (format "@symbol %s:%d:%d name=%s"
            file
            (line-number-at-pos)
            (current-column)
            symbol)))

(defun noema-interaction-tools--region-range ()
  "Return the current region range as a cons cell."
  (unless (use-region-p)
    (user-error "No active region"))
  (cons (region-beginning) (region-end)))

(defun noema-interaction-tools--defun-range ()
  "Return the current defun range as a plist."
  (or
   (ignore-errors
     (save-excursion
       (mark-defun)
       (let ((start (region-beginning))
             (end (region-end)))
         (deactivate-mark)
         (list :start-line (line-number-at-pos start)
               :end-line (line-number-at-pos end)
               :start start
               :end end
               :name (or (and (fboundp 'which-function) (which-function))
                         (thing-at-point 'symbol t)
                         "anonymous")))))
   (let ((range (noema-interaction-tools--block-range)))
     (plist-put range :name "context-block"))))

(defun noema-interaction-tools--block-range ()
  "Return the current block range as a plist."
  (save-excursion
    (let* ((ppss (syntax-ppss))
           (start (or (nth 1 ppss)
                      (save-excursion
                        (backward-paragraph)
                        (point))))
           (end (or (ignore-errors
                      (goto-char start)
                      (forward-sexp)
                      (point))
                    (save-excursion
                      (forward-paragraph)
                      (point)))))
      (list :start-line (line-number-at-pos start)
            :end-line (line-number-at-pos end)
            :start start
            :end end))))

(defun noema-interaction-tools--git-status-summary (project-root)
  "Return a concise Git status summary for PROJECT-ROOT."
  (when (and (executable-find "git")
             (eq 0 (let ((default-directory project-root))
                     (call-process "git" nil nil nil "rev-parse" "--is-inside-work-tree"))))
    (let ((default-directory project-root))
      (string-trim
       (with-temp-buffer
         (call-process "git" nil t nil "status" "--short" "--untracked-files=normal")
         (buffer-string))))))

(defun noema-interaction-tools--diagnostic-summary ()
  "Return a concise diagnostic summary for the current buffer."
  (cond
   ((bound-and-true-p flymake-mode)
    (let* ((diags (flymake-diagnostics (point-min) (point-max)))
           (count (length diags))
           (messages
            (seq-take
             (delq nil
                   (mapcar
                    (lambda (diag)
                      (when-let* ((text (flymake-diagnostic-text diag)))
                        (string-trim text)))
                    diags))
             5)))
      (string-join
       (append
        (list (format "%d flymake diagnostic(s)" count))
        messages)
       "\n")))
   ((bound-and-true-p flycheck-mode)
    (let ((messages
           (seq-take
            (delq nil
                  (mapcar
                   (lambda (err)
                     (when (fboundp 'flycheck-error-message)
                       (flycheck-error-message err)))
                   flycheck-current-errors))
            5)))
      (string-join
       (append
        (list (format "%d flycheck error(s), %d warning(s)"
                      (length flycheck-current-errors)
                      (length (seq-filter (lambda (err)
                                            (eq (flycheck-error-level err) 'warning))
                                          flycheck-current-errors))))
        messages)
       "\n")))
   (t
    "No active diagnostics backend")))

(defun noema-interaction-tools--project-file-summary (project-root)
  "Return a project file summary for PROJECT-ROOT."
  (let* ((default-directory project-root)
         (files (cond
                 ((and (fboundp 'project-current)
                       (project-current nil project-root)
                       (fboundp 'project-files))
                  (project-files (project-current nil project-root)))
                 (t nil)))
         (relative-files
          (mapcar (lambda (file)
                    (noema-interaction-tools--relative-path file project-root))
                  files))
         (shown (seq-take relative-files noema-interaction-tools-project-files-limit)))
    (unless relative-files
      (user-error "No project file list available"))
    (string-join
     (append
      shown
      (when (> (length relative-files) (length shown))
        (list (format "... %d more file(s)"
                      (- (length relative-files) (length shown))))))
     "\n")))

(defun noema-interaction-tools--recent-changes-summary (project-root)
  "Return recently changed files for PROJECT-ROOT."
  (unless (and (executable-find "git")
               (eq 0 (let ((default-directory project-root))
                       (call-process "git" nil nil nil "rev-parse" "--is-inside-work-tree"))))
    (user-error "Project is not inside a Git work tree"))
  (let ((default-directory project-root))
    (string-trim
     (with-temp-buffer
       (call-process "git" nil t nil "status" "--short" "--untracked-files=normal")
       (let* ((lines (split-string (buffer-string) "\n" t))
              (shown (seq-take lines 20)))
         (string-join
          (append
           shown
           (when (> (length lines) (length shown))
             (list (format "... %d more change(s)"
                           (- (length lines) (length shown))))))
          "\n"))))))

(defun noema-interaction-tools--failure-lines-from-buffer (buffer)
  "Return likely failure lines from BUFFER."
  (with-current-buffer buffer
    (let ((lines nil)
          (regexp "\\(FAIL\\|FAILED\\|ERROR\\|AssertionError\\|panic\\|panicked\\|Exception\\)"))
      (save-excursion
        (goto-char (point-min))
        (while (and (< (length lines) noema-interaction-tools-test-failure-lines-limit)
                    (re-search-forward regexp nil t))
          (push (string-trim
                 (buffer-substring-no-properties
                  (line-beginning-position)
                  (line-end-position)))
                lines)))
      (nreverse (delete-dups (seq-remove #'string-empty-p lines))))))

(defun noema-interaction-tools--test-failure-summary ()
  "Return a summary of test failures from active buffers."
  (let ((buffers
         (seq-filter
          (lambda (buffer)
            (with-current-buffer buffer
              (or (derived-mode-p 'compilation-mode)
                  (string-match-p "\\*.*test.*\\*" (buffer-name buffer))
                  (string-match-p "\\*.*compilation.*\\*" (buffer-name buffer)))))
          (buffer-list)))
        (lines nil))
    (dolist (buffer buffers)
      (setq lines
            (append lines
                    (noema-interaction-tools--failure-lines-from-buffer buffer))))
    (setq lines (seq-take (delete-dups (delq nil lines))
                          noema-interaction-tools-test-failure-lines-limit))
    (unless lines
      (user-error "No test failure summary found in active buffers"))
    (string-join lines "\n")))

(defun noema-interaction-tools--selected-symbols ()
  "Prompt for one or more tool symbols."
  (mapcar
   (lambda (choice)
     (alist-get choice noema-interaction-tool-choices nil nil #'string=))
   (completing-read-multiple
    "引用工具: "
    (mapcar #'car noema-interaction-tool-choices)
    nil t)))

(defun noema-interaction-tools--build-references (choices project-root)
  "Build reference lines for CHOICES in PROJECT-ROOT."
  (let* ((file (and (buffer-file-name) (noema-interaction-tools--relative-path
                                        (buffer-file-name) project-root)))
         (references nil))
    (dolist (choice choices)
      (pcase choice
        ('current-file
         (let ((path (noema-interaction-tools--relative-path
                      (noema-interaction-tools--current-file) project-root)))
           (push (format "@file %s" path) references)))
        ('current-line
         (let ((path (noema-interaction-tools--relative-path
                      (noema-interaction-tools--current-file) project-root)))
           (push (noema-interaction-tools--line-reference path) references)))
        ('region
         (let* ((path (noema-interaction-tools--relative-path
                       (noema-interaction-tools--current-file) project-root))
                (range (noema-interaction-tools--region-range)))
           (push (noema-interaction-tools--format-range
                  path (car range) (cdr range) "selection")
                 references)))
        ('current-symbol
         (let ((path (noema-interaction-tools--relative-path
                      (noema-interaction-tools--current-file) project-root)))
           (push (noema-interaction-tools--symbol-reference path) references)))
        ('defun
         (let* ((path (noema-interaction-tools--relative-path
                       (noema-interaction-tools--current-file) project-root))
                (range (noema-interaction-tools--defun-range)))
           (push (format "%s name=%s"
                         (noema-interaction-tools--format-range
                          path
                          (plist-get range :start)
                          (plist-get range :end)
                          "defun")
                         (plist-get range :name))
                 references)))
        ('block
         (let* ((path (noema-interaction-tools--relative-path
                       (noema-interaction-tools--current-file) project-root))
                (range (noema-interaction-tools--block-range)))
           (push (noema-interaction-tools--format-range
                  path
                  (plist-get range :start)
                  (plist-get range :end)
                  "block")
                 references)))
        ('project-root
         (push (format "@project-root %s"
                       (abbreviate-file-name project-root))
               references))
        ('project-files
         (push (format "@project-files\n%s"
                       (noema-interaction-tools--project-file-summary project-root))
               references))
        ('recent-changes
         (push (format "@recent-changes\n%s"
                       (noema-interaction-tools--recent-changes-summary project-root))
               references))
        ('git-status
         (when-let* ((status (noema-interaction-tools--git-status-summary project-root)))
           (push (format "@git-status\n%s" status) references)))
        ('diagnostics
         (push (format "@diagnostics %s" (noema-interaction-tools--diagnostic-summary))
               references))
        ('test-failures
         (push (format "@test-failures\n%s"
                       (noema-interaction-tools--test-failure-summary))
               references))))
    (list :references (nreverse references)
          :display-file file)))

(defun noema-interaction-tools--prompt-template (task references)
  "Return a prompt template using TASK and REFERENCES."
  (noema-interaction-profile-render-template
   (noema-interaction-profile-read-template
    "context-prompt"
    noema-interaction-tools--context-template-fallback)
   `(("task-section" . ,(if (string-empty-p task)
                            ""
                          (format "任务:\n\n%s" task)))
     ("references" . ,(string-join references "\n")))))

(defun noema-interaction-tools--writing-text ()
  "Return the text to use for a writing task."
  (when (derived-mode-p 'prog-mode)
    (user-error "Writing prompt does not copy source code; use context references instead"))
  (cond
   ((use-region-p)
    (let* ((file (buffer-file-name))
           (root (noema-interaction-project-root))
           (rel (if (and file root) (file-relative-name file root) (buffer-name))))
      (format "@range %s:%d:%d-%d:%d"
              rel
              (line-number-at-pos (region-beginning)) (current-column)
              (line-number-at-pos (region-end)) (save-excursion (goto-char (region-end)) (current-column)))))
   ((buffer-file-name)
    (format "@file %s" (file-relative-name (buffer-file-name) (noema-interaction-project-root))))
   (t
    (user-error "No writing text available"))))

(defun noema-interaction-tools--writing-context (project-root)
  "Return lightweight writing context for PROJECT-ROOT."
  (let ((source (if-let* ((file (buffer-file-name)))
                    (format "source: %s"
                            (noema-interaction-tools--relative-path file project-root))
                  (format "buffer: %s" (buffer-name)))))
    (string-join
     (delq nil
           (list source
                 (when (use-region-p)
                   (format "range: %d-%d"
                           (line-number-at-pos (region-beginning))
                           (line-number-at-pos (region-end))))))
     "\n")))

(defun noema-interaction-tools--writing-prompt (mode task text context)
  "Return a writing prompt for MODE, TASK, TEXT, and CONTEXT."
  (noema-interaction-profile-render-template
   (noema-interaction-profile-read-template
    "writing-prompt"
    noema-interaction-tools--writing-template-fallback)
   `(("mode" . ,mode)
     ("task" . ,task)
     ("context" . ,context)
     ("text" . ,text))))

(defun noema-interaction-tools--context-dispatch (send-immediately)
  "Build context references, then draft or send based on SEND-IMMEDIATELY.
Requires an active backend session."
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root)))
    (unless (and backend
                (pcase backend
                  ('claude   (noema-interaction-claude-session-live-p project-root))
                  ('codex    (noema-interaction-codex-session-live-p  project-root))
                  ('opencode (noema-interaction-opencode-session-live-p project-root))
                  (_ nil)))
      (user-error "No active session. Start one first with `noema-interaction-open' (C-c A W)"))
    (let* ((choices (noema-interaction-tools--selected-symbols))
           (task (read-string "AI task: "))
           (context (noema-interaction-tools--build-references choices project-root))
           (references (plist-get context :references))
           (prompt (noema-interaction-tools--prompt-template task references)))
      (unless references
        (user-error "No references selected"))
      (if send-immediately
          (progn
            (noema-interaction-send-string backend prompt project-root)
            (message "noema-interaction sent prompt with %d reference(s)"
                     (length references)))
        (noema-interaction-draft-string backend prompt project-root)
        (message "noema-interaction drafted prompt with %d reference(s); press RET to submit"
                 (length references))))))

(defun noema-interaction-writing-prompt ()
  "Draft an AI writing prompt from region or current buffer.
Requires an active backend session."
  (interactive)
  (let* ((project-root (noema-interaction-project-root))
         (backend (noema-interaction-session-backend project-root)))
    (unless (and backend
                (pcase backend
                  ('claude   (noema-interaction-claude-session-live-p project-root))
                  ('codex    (noema-interaction-codex-session-live-p  project-root))
                  ('opencode (noema-interaction-opencode-session-live-p project-root))
                  (_ nil)))
      (user-error "No active session. Start one first with `noema-interaction-open' (C-c A W)"))
    (let* ((mode-label (completing-read "Writing mode: "
                                        (mapcar #'car noema-interaction-writing-modes)
                                        nil t nil nil "润色"))
           (task (read-string "Writing task: "))
           (text (noema-interaction-tools--writing-text))
           (context (noema-interaction-tools--writing-context project-root))
           (prompt (noema-interaction-tools--writing-prompt
                    mode-label task text context)))
      (noema-interaction-draft-string backend prompt project-root)
      (message "noema-interaction drafted writing prompt to %s; press RET to submit"
               backend))))

(defun noema-interaction-context-prompt ()
  "Draft a reference-style prompt into the current AI backend."
  (interactive)
  (noema-interaction-tools--context-dispatch nil))

(defun noema-interaction-context-send ()
  "Send a reference-style prompt directly to the current AI backend."
  (interactive)
  (noema-interaction-tools--context-dispatch t))

(provide 'noema-interaction-tools)
;;; noema-interaction-tools.el ends here
