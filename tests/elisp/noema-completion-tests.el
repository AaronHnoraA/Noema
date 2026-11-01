;;; noema-completion-tests.el --- Completion and capability UI regressions -*- lexical-binding: t; -*-
(require 'ert)
(require 'cl-lib)

(require 'noema-capability-ui)





























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
      (dolist (command '(noema-capability-manager noema-mcp-manager))
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

(ert-deftest noema-skill-opens-input-completion-for-effective-skills ()
  (let (request scheduled records)
    (with-temp-buffer
      (cl-letf (((symbol-function 'noema-current-project)
                 (lambda (&optional _) "/project/"))
                ((symbol-function 'noema-capability-list)
                 (lambda (&rest args) (setq request args)))
                ((symbol-function 'run-at-time)
                 (lambda (_delay _repeat fn &rest args)
                   (setq scheduled (cons fn args)))))
        (noema-skill)
        (should (equal (plist-get request :project) "/project/"))
        (should (eq (plist-get request :scope) 'project))
        (funcall (plist-get request :callback)
                 '((skills . [((type . "skill") (id . "proof-review"))])
                   (packs . [((type . "pack") (id . "proof-pack"))])) nil)
        (should (eq (car scheduled) #'noema-skill--present))
        (cl-letf (((symbol-function 'noema-capability-lookup--read)
                   (lambda (candidates kind)
                     (setq records (list candidates kind))
                     nil)))
          (apply (car scheduled) (cdr scheduled)))
        (should (equal (mapcar (lambda (record) (noema--value record "id"))
                               (car records))
                       '("proof-review" "proof-pack")))
        (should (equal (cadr records) "skill"))))))

(ert-deftest noema-skill-cmd-comma-opens-the-full-skill-manager ()
  (with-temp-buffer
    (noema-skill--minibuffer-setup)
    (should (eq (key-binding (kbd "M-,"))
                #'noema-skill--manage-from-minibuffer))
    (should (eq (key-binding (kbd "C-c ,"))
                #'noema-skill--manage-from-minibuffer)))
  (let ((noema-skill--manage-requested nil)
        exited)
    (with-temp-buffer
      (cl-letf (((symbol-function 'all-completions) (lambda (&rest _) '("proof-review")))
                ((symbol-function 'delete-minibuffer-contents) #'erase-buffer)
                ((symbol-function 'exit-minibuffer) (lambda () (setq exited t))))
        (noema-skill--manage-from-minibuffer))
      (should (equal (buffer-string) "proof-review")))
    (should noema-skill--manage-requested)
    (should exited))
  (with-temp-buffer
    (let (received)
      (cl-letf (((symbol-function 'noema-capability-manager)
                 (lambda (project type)
                   (setq received (list project type major-mode default-directory)))))
        (noema-skill--open-manager "/project/" "/tmp/" nil))
      (should (equal received '("/project/" "skill" fundamental-mode "/tmp/")))))
  (with-temp-buffer
    (let (opened visited)
      (cl-letf (((symbol-function 'noema-capability-lookup--read)
                 (lambda (&rest _)
                   (setq noema-skill--manage-requested t)
                   '((type . "skill") (id . "proof-review"))))
                ((symbol-function 'noema-skill--open-manager)
                 (lambda (&rest args) (setq opened args)))
                ((symbol-function 'noema-skill--visit)
                 (lambda (&rest args) (setq visited args))))
        (noema-skill--present '((skills . [])) "/project/" (current-buffer) "/tmp/" nil))
      (should (equal opened '("/project/" "/tmp/" nil)))
      (should-not visited))))

(ert-deftest noema-skill-manager-compatibility-opens-search ()
  (let (opened)
    (cl-letf (((symbol-function 'noema-skill) (lambda (&optional project) (setq opened project))))
      (noema-skill-manager "/project/"))
    (should (equal opened "/project/"))))

(ert-deftest noema-skill-result-drafts-into-the-originating-agent ()
  (let ((origin (generate-new-buffer " *noema-skill-agent*"))
        drafted)
    (unwind-protect
        (progn
          (with-current-buffer origin (setq-local major-mode 'agent-shell-mode))
          (cl-letf (((symbol-function 'noema-capability-lookup--draft)
                     (lambda (buffer text) (setq drafted (list buffer text)))))
            (noema-skill--visit
             '((type . "skill") (id . "proof-review")
               (source . ((path . "/project/skills/proof-review/SKILL.md"))))
             "/project/" nil origin))
          (should (eq (car drafted) origin))
          (should (string-match-p "proof-review/SKILL.md" (cadr drafted))))
      (kill-buffer origin))))

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
  (let ((+noema--ready t) request)
    (cl-letf (((symbol-function 'noema--host-call-now)
               (lambda (channel body _callback) (setq request (cons channel body)))))
      (noema--host-call "noema:api:research:capability:mutate" '((scope . "global")) #'ignore)
      (should (equal (car request) "noema:api:research:capability:global:mutate"))
      (noema--host-call "noema:api:research:capability:mutate" '((cwd . "/project/")) #'ignore)
      (should (equal (car request) "noema:api:research:capability:mutate")))))

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
