;;; noema-completion-tests.el --- Completion and capability UI regressions -*- lexical-binding: t; -*-
(require 'ert)
(require 'cl-lib)
(require 'noema-research-mode)
(require 'noema-capability-ui)

(ert-deftest noema-completion-snippet-preview-does-not-open-a-document ()
  "A real snippet preview may borrow JuText syntax without opening a file."
  (skip-unless (require 'company-yasnippet nil t))
  (require 'yasnippet)
  (save-window-excursion
    (with-temp-buffer
      (let ((source (current-buffer))
            (layout (current-window-configuration)))
        (setq-local major-mode 'noema-research-mode
                    buffer-file-name "/tmp/preview-source.noema")
        (cl-letf (((symbol-function 'noema-research--load)
                   (lambda (&rest _) (ert-fail "Preview loaded a work document")))
                  ((symbol-function 'noema-research-completion-refresh)
                   (lambda () (ert-fail "Preview scheduled capability requests")))
                  ((symbol-function 'noema-research--schedule-default-output)
                   (lambda () (ert-fail "Preview scheduled workspace changes"))))
          (unwind-protect
              (let ((preview
                     (company-yasnippet
                      'doc-buffer
                      (propertize "@@skill" 'yas-template
                                  (yas--make-template :content "@@skill(example)")))))
                (should (buffer-live-p preview))
                (should (eq (current-buffer) source))
                (with-current-buffer preview
                  (should (derived-mode-p 'noema-research-mode))
                  (should (equal (buffer-string) "@@skill(example)"))
                  (should-not noema-research--document)
                  (should-not noema-research--output-timer)
                  (should-not (memq #'noema-research-mode--write-contents
                                    write-contents-functions)))
                (should (compare-window-configurations
                         layout (current-window-configuration))))
            (when-let* ((preview (get-buffer "*company-documentation*")))
              (kill-buffer preview))))))))

(ert-deftest noema-completion-delayed-mode-preserves-preview-text ()
  (with-temp-buffer
    (insert "@@skill(example)")
    (delay-mode-hooks (noema-research-mode))
    (font-lock-ensure)
    (should (equal (buffer-string) "@@skill(example)"))
    (should-not noema-research--document)))

(defmacro noema-completion-test--buffer (text &rest body)
  (declare (indent 1))
  `(with-temp-buffer
     (setq-local major-mode 'noema-research-mode
                 noema-research-completion--project "/project/")
     (insert ,text)
     ,@body))

(ert-deftest noema-completion-directive-names-and-delimiters ()
  (noema-completion-test--buffer "%% work Review\n@@ski"
    (let* ((capf (noema-research-completion-at-point))
           (exit (plist-get (nthcdr 3 capf) :exit-function)))
      (should (member "@@skill" (nth 2 capf)))
      (delete-region (nth 0 capf) (nth 1 capf))
      (insert "@@skill")
      (funcall exit "@@skill" 'finished)
      (should (looking-at ")"))
      (should (string-suffix-p "@@skill()" (buffer-string))))))

(ert-deftest noema-completion-only-in-work-leading-control-region ()
  (dolist (text '("%% question Q\n@@" "%% note N\n@@" "%% work W\nPrompt\n@@"
                  "%% work W\n```\n@@" "%% work W\n\n@@" "%% work W\n  @@"))
    (noema-completion-test--buffer text
      (should-not (noema-research-completion-at-point))))
  (noema-completion-test--buffer "%% note N\nData\n%% work W\n@@ctx(lineage)\n\n@@"
    (should (noema-research-completion-at-point))))

(ert-deftest noema-completion-cached-candidates-do-no-io ()
  (let ((noema-capability--cache (make-hash-table :test #'equal)))
    (puthash "/project/"
             '(:resolution ((skills . [((id . "available") (selectable . t) (enabled . :false))
                                      ((id . "disabled") (selectable . :false))
                                      ((id . "invalid") (selectable . :false))])))
             noema-capability--cache)
    (noema-completion-test--buffer "%% work W\n@@skill("
      (cl-letf (((symbol-function 'noema--host-call) (lambda (&rest _) (ert-fail "CAPF made a request")))
                ((symbol-function 'noema-current-project) (lambda (&rest _) (ert-fail "CAPF scanned for a project")))
                ((symbol-function 'directory-files) (lambda (&rest _) (ert-fail "CAPF scanned a directory"))))
        (dotimes (_ 1000)
          (should (equal (nth 2 (noema-research-completion-at-point)) '("available"))))))
    (noema-completion-test--buffer "%% work W\n@@skill("
      (setq noema-research-completion--project "/other-project/")
      (should-not (noema-research-completion-at-point)))))

(ert-deftest noema-completion-file-candidates-are-memory-only ()
  (let ((noema-research-completion--files (make-hash-table :test #'equal)))
    (puthash '("/project/" . "src/") '(:files ("main.py" "sub/")) noema-research-completion--files)
    (noema-completion-test--buffer "%% work W\n@@ctx(file:src/"
      (cl-letf (((symbol-function 'file-name-all-completions) (lambda (&rest _) (ert-fail "CAPF read files")))
                ((symbol-function 'noema--host-call) (lambda (&rest _) (ert-fail "CAPF queried host"))))
        (should (equal (nth 2 (noema-research-completion-at-point)) '("file:src/main.py" "file:src/sub/")))))))

(ert-deftest noema-completion-company-supports-empty-value-prefix ()
  (skip-unless (require 'company-capf nil t))
  (noema-completion-test--buffer "%% work W\n@@session("
    (setq-local completion-at-point-functions '(noema-research-completion-at-point))
    (should (equal (company-capf 'prefix) '("" "" t)))))

(ert-deftest noema-completion-file-request-failure-does-not-stick-pending ()
  (let ((noema-research-completion--files (make-hash-table :test #'equal)))
    (noema-completion-test--buffer "%% work W\n@@ctx(file:"
      (setq noema-research-completion--file-directory "./")
      (cl-letf (((symbol-function 'noema--host-call) (lambda (&rest _) (error "offline"))))
        (noema-research-completion--request-files)
        (should-not (plist-get (gethash '("/project/" . "./") noema-research-completion--files) :pending))))))

(ert-deftest noema-capability-manager-global-actions-use-host-paths ()
  (with-temp-buffer
    (noema-capability-ui-mode)
    (setq noema-capability-ui--resolution
          '((scopes . [((name . "global") (source . "/custom/emacs/etc/noema/capabilities.json")
                        (skillDirectories . ["/custom/emacs/etc/noema/skills"]))])))
    (let (visited browsed)
      (cl-letf (((symbol-function 'noema-capability-ui--open-right)
                 (lambda (path &optional directory _manager)
                   (if directory (setq browsed path) (setq visited path)))))
        (noema-capability-ui-edit-global-config)
        (noema-capability-ui-open-global-skills)
        (should (equal visited "/custom/emacs/etc/noema/capabilities.json"))
        (should (equal browsed "/custom/emacs/etc/noema/skills"))))))

(ert-deftest noema-capability-manager-always-opens-global-without-prompt ()
  (save-window-excursion
    (dolist (project '(nil "/current-project/"))
      (dolist (command '(noema-capability-manager noema-skill-manager noema-mcp-manager))
        (let ((noema-capability--cache (make-hash-table :test #'equal)) request)
          (with-temp-buffer
            (cl-letf (((symbol-function 'noema-current-project) (lambda (&optional _) project))
                      ((symbol-function 'read-directory-name) (lambda (&rest _) (ert-fail "Unexpected project prompt")))
                      ((symbol-function 'noema-capability-list) (lambda (&rest args) (setq request args))))
              (call-interactively command)
              (unwind-protect
                  (progn
                    (should (eq noema-capability-ui--view 'global))
                    (should (eq (plist-get request :scope) 'global))
                    (should (equal noema-capability-ui--project project))
                    (unless project
                      (should-error (noema-capability-ui-project-patches) :type 'user-error)))
                (kill-buffer (current-buffer))))))))))

(ert-deftest noema-capability-manager-project-pages-are-explicit-and-local-filtered ()
  (with-temp-buffer
    (noema-capability-ui-mode)
    (setq noema-capability-ui--project "/project/" noema-capability-ui--base-filter "mcp")
    (let ((noema-capability--cache (make-hash-table :test #'equal)) request)
      (cl-letf (((symbol-function 'noema-capability-list) (lambda (&rest args) (setq request args))))
        (noema-capability-ui-project-patches)
        (should (eq (plist-get request :scope) 'project))
        (should (equal (plist-get request :project) "/project/"))
        (noema-capability-ui-local-skills)
        (noema-capability-ui--render
         '((skills . [((type . "skill") (id . "shared") (source . ((scope . "global"))))
                       ((type . "skill") (id . "local") (source . ((scope . "project"))))])))
        (should (equal (mapcar #'car tabulated-list-entries) '(("skill" . "local"))))
        (noema-capability-ui-global)
        (should (eq (plist-get request :scope) 'global))
        (should (equal noema-capability-ui--filter "mcp"))))))

(ert-deftest noema-capability-global-api-never-discovers-project-and-invalidates-all-caches ()
  (let ((noema-capability--cache (make-hash-table :test #'equal)) request)
    (puthash "/project/" '(:resolution stale) noema-capability--cache)
    (cl-letf (((symbol-function 'noema-current-project) (lambda (&rest _) (ert-fail "Global API discovered project")))
              ((symbol-function 'noema--host-call)
               (lambda (_channel body callback)
                 (setq request body)
                 (funcall callback '((capabilities . ((scope . "global") (skills . [])))) nil))))
      (noema-capability-list :scope 'global :callback #'ignore)
      (should (equal (alist-get 'scope request) "global"))
      (should-not (assq 'cwd request))
      (noema-capability-set-enabled "skill" "proof" t :scope 'global :callback #'ignore)
      (should-not (gethash "/project/" noema-capability--cache))
      (should (gethash :global noema-capability--cache)))))

(ert-deftest noema-capability-global-wire-channels-fail-closed-on-old-hosts ()
  (let ((my/noema--ready t) request)
    (cl-letf (((symbol-function 'noema--host-call-now)
               (lambda (channel body _callback) (setq request (cons channel body)))))
      (noema--host-call "aaronnote:api:research:capability:mutate" '((scope . "global")) #'ignore)
      (should (equal (car request) "aaronnote:api:research:capability:global:mutate"))
      (noema--host-call "aaronnote:api:research:capability:mutate" '((cwd . "/project/")) #'ignore)
      (should (equal (car request) "aaronnote:api:research:capability:mutate")))))

(ert-deftest noema-capability-library-buttons-retain-their-own-targets ()
  (save-window-excursion
    (with-temp-buffer
      (noema-capability-ui-mode)
      (setq noema-capability-ui--resolution
            '((scopes . [((name . "global") (source . "/global/capabilities.json")
                          (skillDirectories . ["/global/skills"]))])
              (libraries . [((id . "codex") (state . "available") (configFile . "/codex/config.toml"))])))
      (noema-capability-ui-libraries)
      (unwind-protect
          (with-current-buffer "*Noema capability libraries*"
            (let (visited)
              (cl-letf (((symbol-function 'noema-capability-ui--open-right)
                         (lambda (path &rest _) (push path visited))))
                (goto-char (point-min))
                (while (next-button (point))
                  (goto-char (button-start (next-button (point))))
                  (button-activate (button-at (point)))
                  (goto-char (button-end (button-at (point)))))
                (should (equal (nreverse visited)
                               '("/global/capabilities.json" "/global/skills" "/codex/config.toml"))))))
        (kill-buffer "*Noema capability libraries*")))))

(ert-deftest noema-completion-replaces-whole-value-without-duplicating-close ()
  (noema-completion-test--buffer "%% work W\n@@session(continue)"
    (search-backward "tinue")
    (let ((capf (noema-research-completion-at-point)))
      (delete-region (nth 0 capf) (nth 1 capf))
      (insert "fresh")
      (funcall (plist-get (nthcdr 3 capf) :exit-function) "fresh" 'finished)
      (should (string-suffix-p "@@session(fresh)" (buffer-string))))))

(ert-deftest noema-capability-cache-coalesces-and-rejects-stale-responses ()
  (let ((noema-capability--cache (make-hash-table :test #'equal))
        (noema-capability-changed-hook nil) callbacks)
    (cl-letf (((symbol-function 'noema-current-project) (lambda (&optional project) (or project "/project/")))
              ((symbol-function 'noema--host-call) (lambda (_ _ callback) (push callback callbacks))))
      (dotimes (_ 20) (noema-capability-refresh "/project/"))
      (should (= (length callbacks) 1))
      (let ((stale (car callbacks)))
        (noema-capability-invalidate "/project/")
        (noema-capability-refresh "/project/")
        (funcall (car callbacks) '((capabilities . ((skills . [((id . "new") (selectable . t))])))) nil)
        (funcall stale '((capabilities . ((skills . [((id . "stale") (selectable . t))])))) nil)
        (should (equal (noema-capability-cached-skill-ids "/project/") '("new")))))))

(ert-deftest noema-capability-run-selections-do-not-overwrite-editor-cache ()
  (let ((noema-capability--cache (make-hash-table :test #'equal)))
    (cl-letf (((symbol-function 'noema-current-project) (lambda (&optional _) "/project/"))
              ((symbol-function 'noema--host-call)
               (lambda (_ _ callback) (funcall callback '((capabilities . ((skills . [])))) nil))))
      (noema-capability-list :requested-skills '("special") :callback #'ignore)
      (should-not (noema-capability-cached)))))

(ert-deftest noema-capability-request-errors-release-pending-state ()
  (let ((noema-capability--cache (make-hash-table :test #'equal))
        (noema-capability-changed-hook nil))
    (cl-letf (((symbol-function 'noema-current-project) (lambda (&optional _) "/project/"))
              ((symbol-function 'noema--host-call) (lambda (&rest _) (error "offline"))))
      (noema-capability-refresh)
      (should-not (plist-get (gethash "/project/" noema-capability--cache) :pending))
      (should (plist-get (gethash "/project/" noema-capability--cache) :error)))))

(ert-deftest noema-capability-manager-inserts-skill-at-work-start-once ()
  (let* ((document (noema-research-create-document "Skill insertion"))
         (node (noema-research-create-work-node document "work" "Review"))
         (cell (noema-research-primary-cell document node)))
    (puthash "source" "Review this proof." cell)
    (with-temp-buffer
      (setq-local major-mode 'noema-research-mode noema-research--document document)
      (noema-research--render document)
      (goto-char (point-max))
      (let ((origin (point-marker)) (editor (current-buffer)))
        (with-temp-buffer
          (noema-capability-ui-mode)
          (setq noema-capability-ui--project "/project/" noema-capability-ui--origin origin)
          (noema-capability-ui--render '((skills . [((id . "review") (type . "skill") (selectable . t))])))
          (let ((manager (current-buffer)))
            (cl-letf (((symbol-function 'pop-to-buffer) (lambda (buffer &rest _) (set-buffer buffer))))
              (noema-capability-ui-insert-skill)
              (set-buffer manager)
              (noema-capability-ui-insert-skill)))
          (with-current-buffer editor
            (should (string-match-p "%% work Review\n@@skill(review)\nReview this proof" (buffer-string)))
            (should (= (how-many "@@skill(review)" (point-min) (point-max)) 1))))))))

(ert-deftest noema-capability-skill-selection-restores-covered-pane ()
  "Selecting a Skill restores the output pane and focuses the source."
  (save-window-excursion
    (let* ((source (generate-new-buffer " *skill-source*"))
           (output (generate-new-buffer " *skill-output*"))
           (graph (generate-new-buffer " *skill-graph*"))
           (manager (generate-new-buffer " *skill-manager*"))
           (document (noema-research-create-document "Selection"))
           (node (noema-research-create-work-node document "work" "Review")))
      (unwind-protect
          (progn
            (puthash "source" "Review this proof."
                     (noema-research-primary-cell document node))
            (delete-other-windows)
            (switch-to-buffer source)
            (setq-local major-mode 'noema-research-mode
                        noema-research--document document)
            (noema-research--render document)
            (goto-char (point-max))
            (let* ((origin (point-marker))
                   (left (selected-window))
                   (right (split-window-right))
                   (bottom (split-window left nil 'below)))
              (set-window-buffer right output)
              (set-window-buffer bottom graph)
              (with-current-buffer output
                (setq-local major-mode 'xwidget-webkit-mode))
              (with-current-buffer manager
                (noema-capability-ui-mode)
                (setq noema-capability-ui--origin origin)
                (noema-capability-ui--render
                 '((skills . [((id . "review") (type . "skill") (selectable . t))]))))
              (let ((edges (mapcar #'window-edges (list left right bottom))))
                (select-window right)
                (pop-to-buffer manager '(display-buffer-same-window))
                (noema-capability-ui-insert-skill)
                (should (eq (selected-window) left))
                (should (eq (window-buffer right) output))
                (should (eq (window-buffer bottom) graph))
                (should (equal edges (mapcar #'window-edges (list left right bottom))))
                (should-not (get-buffer-window manager))
                (should (string-match-p "@@skill(review)" (buffer-string))))))
        (dolist (buffer (list source output graph manager))
          (when (buffer-live-p buffer) (kill-buffer buffer)))))))

(ert-deftest noema-capability-json-patch-keeps-null-empty-objects-and-project ()
  (save-window-excursion
    (with-temp-buffer
      (let ((manager (current-buffer)))
        (cl-letf (((symbol-function 'recursive-edit)
                   (lambda () (erase-buffer) (insert "{\"remove\":null,\"empty\":{},\"list\":[]}"))))
          (let ((patch (noema-capability-ui--read-json-object nil "Patch")))
            (should (eq manager (current-buffer)))
            (should (eq (gethash "remove" patch) :null))
            (should (hash-table-p (gethash "empty" patch)))
            (should (equal (gethash "list" patch) []))))))))

(ert-deftest noema-capability-mcp-form-submits-fields-through-public-api ()
  (save-window-excursion
    (with-temp-buffer
      (setq-local noema-capability-ui--project temporary-file-directory)
      (let (form widgets called)
        (unwind-protect
            (progn
              (noema-capability-ui--mcp-form
               '((id . "test-tools") (enabled . t)
                 (effective . ((config . ((type . "http") (url . "https://example.test/mcp")
                                          (headers . [((name . "X-Test") (value . "yes"))])))))))
              (setq form (current-buffer))
              (goto-char (point-min))
              (while (< (point) (point-max))
                (when-let* ((widget (widget-at))) (push widget widgets))
                (forward-char))
              (let ((button (seq-find (lambda (widget) (equal (widget-value widget) "Save global MCP")) widgets)))
                (should button)
                (cl-letf (((symbol-function 'noema-mcp-register) (lambda (&rest args) (setq called args))))
                  (widget-apply button :notify button nil))
                (should (equal (car called) "test-tools"))
                (should (eq (plist-get (cddr called) :scope) 'global))
                (should (equal (noema--value (cadr called) "url") "https://example.test/mcp"))
                (should (equal (noema--value (cadr called) "headers") [((name . "X-Test") (value . "yes"))]))))
          (when (buffer-live-p form) (kill-buffer form)))))))

(provide 'noema-completion-tests)
