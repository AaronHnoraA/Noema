;;; noema-research-completion.el --- JuText directive completion -*- lexical-binding: t; -*-

(require 'noema-api)

(defvar noema-research--header-regexp)
(defvar noema-research--document)
(defvar noema-research--session-names)
(defvar noema-research-session-keywords)
(declare-function noema-research--parse-header "noema-research-mode" (text))
(declare-function noema-agent-acp-known-agents "noema-agent-acp" ())
(defvar-local noema-research-completion--timer nil)
(defvar-local noema-research-completion--project nil)
(defvar-local noema-research-completion--file-directory nil)
(defvar noema-research-completion--files (make-hash-table :test #'equal))
(defvar-local noema-research-completion--skill-resolution nil)
(defvar-local noema-research-completion--skill-pairs nil)

(defun noema-research-completion--skills ()
  "Reuse candidate metadata until the project resolution changes."
  (let ((resolution (plist-get (gethash noema-research-completion--project noema-capability--cache)
                              :resolution)))
    (unless (eq resolution noema-research-completion--skill-resolution)
      (setq noema-research-completion--skill-resolution resolution
            noema-research-completion--skill-pairs
            (mapcar
             (lambda (record)
               (cons (noema--value record "id")
                     (format "%s · %s · %s"
                             (if (eq t (noema--value record "enabled")) "enabled" "available")
                             (or (noema--value (noema--value record "source") "scope") "")
                             (or (noema--value record "description") ""))))
             (seq-filter (lambda (record) (eq t (noema--value record "selectable")))
                         (noema--sequence (noema--value resolution "skills"))))))
    noema-research-completion--skill-pairs))

(defun noema-research-completion--wake ()
  "Offer refreshed candidates in the selected Company buffer."
  (when (and (eq (current-buffer) (window-buffer (selected-window)))
             (bound-and-true-p company-mode) (fboundp 'company-auto-begin))
    (company-auto-begin)))

(defun noema-research-completion--changed (root)
  "Refresh the selected editor popup after ROOT's asynchronous response."
  (with-current-buffer (window-buffer (selected-window))
    (when (and (derived-mode-p 'noema-research-mode)
               (equal root noema-research-completion--project))
      (noema-research-completion--wake))))

(add-hook 'noema-capability-changed-hook #'noema-research-completion--changed)

(defun noema-research-completion--request-files ()
  "Load at most one requested project directory asynchronously."
  (when (and noema-research-completion--project noema-research-completion--file-directory)
    (let* ((key (cons noema-research-completion--project noema-research-completion--file-directory))
           (old (gethash key noema-research-completion--files))
           (buffer (current-buffer)))
      (unless (or (plist-get old :pending) (< (- (float-time) (or (plist-get old :time) 0)) 30))
        (let ((entry (list :pending t :time (float-time) :files (plist-get old :files))))
          (puthash key entry noema-research-completion--files)
          (condition-case nil
              (noema--host-call
               "aaronnote:api:research:capability:files" `((cwd . ,(car key)) (directory . ,(cdr key)))
               (lambda (result err)
                 (setf (plist-get entry :pending) nil
                       (plist-get entry :time) (float-time)
                       (plist-get entry :files) (unless err (noema--sequence (noema--value result "files"))))
                 (when (buffer-live-p buffer)
                   (with-current-buffer buffer (noema-research-completion--wake)))))
            (error (setf (plist-get entry :pending) nil))))))))

(defun noema-research-completion--cancel ()
  "Cancel this buffer's deferred capability query."
  (when (timerp noema-research-completion--timer)
    (cancel-timer noema-research-completion--timer))
  (setq noema-research-completion--timer nil))

(defun noema-research-completion-refresh ()
  "Schedule project candidates without doing transport work inside a CAPF."
  (unless (or noninteractive (timerp noema-research-completion--timer))
    (let ((buffer (current-buffer)))
      (setq noema-research-completion--timer
            (run-with-idle-timer
             0.2 nil
             (lambda ()
               (when (buffer-live-p buffer)
                 (with-current-buffer buffer
                   (setq noema-research-completion--timer nil)
                   (condition-case err
                       (progn
                         (unless noema-research-completion--project
                           (setq noema-research-completion--project (noema-current-project)))
                         (noema-capability-refresh noema-research-completion--project)
                         (noema-research-completion--request-files))
                     (error (message "Noema completion: %s" (error-message-string err))))))))))))

(defun noema-research-completion--control-start ()
  "Return work body start when point is inside its leading control region."
  (save-excursion
    (let ((line-start (line-beginning-position)))
      (beginning-of-line)
      (when (and (re-search-backward noema-research--header-regexp nil t)
                 (equal (car (noema-research--parse-header
                              (or (match-string-no-properties 1) ""))) "work"))
        (forward-line 1)
        (let ((start (point)) seen (valid t))
          (while (and valid (< (point) line-start))
            (cond
             ((looking-at "@@\\(?:agent\\|session\\|ctx\\|skill\\)([^)\n]+)[ \t]*$")
              (setq seen t))
             ((and seen (looking-at "[ \t]*$")))
             (t (setq valid nil)))
            (forward-line 1))
          (and valid start))))))

(defun noema-research-completion--context (value)
  "Return context candidate/annotation pairs for VALUE."
  (cond
   ((string-prefix-p "file:" value)
    (let ((directory (or (file-name-directory (substring value 5)) "")))
      (setq noema-research-completion--file-directory directory)
      (noema-research-completion-refresh)
      (mapcar (lambda (file) (cons (concat "file:" directory file) "Project file"))
              (plist-get (gethash (cons noema-research-completion--project directory)
                                  noema-research-completion--files) :files))))
   ((string-prefix-p "cell:" value)
    (mapcar (lambda (cell)
              (cons (concat "cell:" (noema-research-cell-id cell))
                    (noema-research-cell-title cell noema-research--document)))
            (noema-research-cells noema-research--document)))
   ((string-prefix-p "result:" value)
    (delq nil
          (mapcar (lambda (node)
                    (when-let* ((cell (noema-research-primary-cell
                                      noema-research--document (noema-research-work-node-id node))))
                      (when (equal (noema-research-cell-kind cell noema-research--document) "work")
                        (cons (concat "result:" (noema-research-work-node-id node))
                              (noema-research-cell-title cell noema-research--document)))))
                  (noema-research-work-nodes noema-research--document))))
   (t '(("lineage" . "Parent work context") ("lineage:2" . "Parents and grandparents")
        ("lineage:3" . "Three ancestor levels") ("none" . "No automatic context")
        ("depends" . "Dependency context")
        ("git.diff" . "Project changes") ("handoff.latest" . "Latest handoff")
        ("cell:" . "Cell in this document") ("result:" . "Work output")
        ("file:" . "Project file") ("note:" . "Knowledge note id")
        ("artifact:" . "Artifact id")))))

(defun noema-research-completion-at-point ()
  "Complete directive names and values in a work block's control region."
  (when (and (derived-mode-p 'noema-research-mode)
             (save-excursion (beginning-of-line) (looking-at "@@"))
             (noema-research-completion--control-start))
    (let ((line (buffer-substring-no-properties (line-beginning-position) (point)))
          beg end name pairs names)
      (cond
       ((string-match "\\`@@[a-z]*\\'" line)
        (setq names t beg (line-beginning-position)
              end (save-excursion (skip-chars-forward "a-z") (point))
              pairs '(("@@agent" . "Choose agent") ("@@session" . "Choose session")
                      ("@@ctx" . "Add context") ("@@skill" . "Use Skill"))))
       ((string-match "\\`@@\\(agent\\|session\\|ctx\\|skill\\)(\\([^)]*\\)\\'" line)
        (setq name (match-string 1 line)
              beg (+ (line-beginning-position) (match-beginning 2))
              end (save-excursion (skip-chars-forward "^)\n") (point)))
        (let ((value (buffer-substring-no-properties beg (point))))
          (setq pairs
                (pcase name
                  ("agent" (mapcar (lambda (id) (cons id "Agent")) (noema-agent-acp-known-agents)))
                  ("session"
                   (let ((parent (and (string-match "\\`\\(.*:\\)[^:]*\\'" value)
                                      (match-string 1 value))))
                     (mapcar (lambda (id) (cons (concat parent id) "Session"))
                             (if parent noema-research--session-names
                               (delete-dups (append noema-research-session-keywords
                                                    noema-research--session-names))))))
                  ("ctx" (noema-research-completion--context value))
                  ("skill"
                   (noema-research-completion-refresh)
                   (noema-research-completion--skills)))))))
      (when pairs
        (list beg end (mapcar #'car pairs)
              :exclusive 'no :company-prefix-length t
              :annotation-function (lambda (candidate)
                                     (concat "  " (truncate-string-to-width
                                                   (replace-regexp-in-string "[\n\r]+" " "
                                                                             (or (cdr (assoc candidate pairs)) "")) 100)))
              :company-doc-buffer
              (lambda (candidate)
                (with-current-buffer (get-buffer-create " *Noema completion help*")
                  (erase-buffer)
                  (insert candidate "\n\n" (or (cdr (assoc candidate pairs)) ""))
                  (current-buffer)))
              :exit-function
              (lambda (candidate status)
                (when (eq status 'finished)
                  (cond
                   (names (unless (looking-at "(") (insert "()") (backward-char)))
                   ((not (or (string-suffix-p ":" candidate) (string-suffix-p "/" candidate)))
                    (unless (looking-at ")") (insert ")")))))))))))

(provide 'noema-research-completion)
;;; noema-research-completion.el ends here
