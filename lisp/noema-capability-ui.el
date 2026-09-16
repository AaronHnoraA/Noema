;;; noema-capability-ui.el --- Global and project capability manager -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; This tabulated projection displays the authoritative Skill/MCP resolution
;; returned by the Noema host.  It deliberately contains no precedence or
;; patch logic of its own.

;;; Code:

(require 'json)
(require 'pp)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'button)
(require 'noema-api)
(declare-function noema-capability-lookup "noema-capability-actions" (&optional type buffer))
(declare-function noema-capability-lookup--agent-buffer "noema-capability-actions" ())

(defvar-local noema-capability-ui--project nil)
(defvar-local noema-capability-ui--view 'global)
(defvar-local noema-capability-ui--base-filter nil)
(defvar-local noema-capability-ui--resolution nil)
(defvar-local noema-capability-ui--filter nil)
(defvar-local noema-capability-ui--origin nil)
(defvar-local noema-capability-ui--probes nil)
(defvar-local noema-capability-ui--generation 0)
(put 'noema-capability-ui--generation 'permanent-local t)

(defun noema-capability-ui--scope ()
  "Return the write/query scope of the current page."
  (if (eq noema-capability-ui--view 'global) 'global 'project))

(defun noema-capability-ui--scope-label ()
  "Describe where this page's changes are saved."
  (if (eq (noema-capability-ui--scope) 'global) "Global · etc/noema"
    (format "%s · %s" (if (eq noema-capability-ui--view 'local-skills) "Local Skills" "Project Patch")
            (abbreviate-file-name noema-capability-ui--project))))

(defun noema-capability-ui--tabs ()
  "Build small clickable scope tabs, without filesystem or host queries."
  (mapcar
   (lambda (tab)
     (let* ((view (nth 0 tab)) (command (nth 2 tab))
            (available (or (eq view 'global) noema-capability-ui--project))
            (map (make-sparse-keymap)))
       (define-key map [tab-line mouse-1]
                   (lambda (event)
                     (interactive "e")
                     (with-selected-window (posn-window (event-start event))
                       (funcall command))))
       (propertize (nth 1 tab) 'keymap map 'local-map map 'mouse-face 'highlight
                   'face (cond ((eq view noema-capability-ui--view) 'tab-line-tab-current)
                               (available 'tab-line-tab) (t 'shadow))
                   'help-echo (if available "Switch manager page" "Open the manager from a Noema project to use this page"))))
   '((global " Global " noema-capability-ui-global)
     (patches " Project Patch " noema-capability-ui-project-patches)
     (local-skills " Local Skills " noema-capability-ui-local-skills))))

(defun noema-capability-ui--project-modified-p (record)
  "Whether RECORD has explicit project overrides, not merely inherited ones."
  (or (seq-some (lambda (item) (equal (noema--value item "scope") "project"))
                 (append (noema--sequence (noema--value record "patches"))
                         (noema--sequence (noema--value record "selectedBy"))))
      (and (equal (noema--value record "type") "mcp")
           (equal (noema-capability-ui--source-scope record) "project"))))

(defun noema-capability-ui--toolbar-button (label command)
  "Build a mouse entry for COMMAND without taking any Evil key."
  (let ((map (make-sparse-keymap)))
    (define-key map [header-line mouse-1]
                (lambda (event)
                  (interactive "e")
                  (with-selected-window (posn-window (event-start event))
                    (call-interactively command))))
    (propertize (format " [%s] " label) 'local-map map 'mouse-face 'highlight
                'help-echo (symbol-name command))))

(defun noema-capability-ui--switch (view)
  "Switch to VIEW, consulting only the project captured when opened."
  (unless (or (eq view 'global) noema-capability-ui--project)
    (user-error "No project context; open this manager from a Noema project to use project pages"))
  (setq noema-capability-ui--view view
        noema-capability-ui--filter (if (eq view 'local-skills) "skill" noema-capability-ui--base-filter)
        noema-capability-ui--probes (make-hash-table :test #'equal)
        noema-capability-ui--resolution nil
        tabulated-list-entries nil)
  (cl-incf noema-capability-ui--generation)
  (tabulated-list-print t)
  (let* ((key (if (eq view 'global) :global noema-capability-ui--project))
         (entry (gethash key noema-capability--cache)))
    (when (plist-get entry :resolution)
      (noema-capability-ui--render (plist-get entry :resolution)))
    (when (or (null (plist-get entry :resolution))
              (> (- (float-time) (or (plist-get entry :time) 0)) 30))
      (noema-capability-ui-refresh))))

(defun noema-capability-ui-global ()
  "Show the shared global library."
  (interactive)
  (noema-capability-ui--switch 'global))

(defun noema-capability-ui-project-patches ()
  "Show only explicitly created project patches and selection overrides."
  (interactive)
  (noema-capability-ui--switch 'patches))

(defun noema-capability-ui-local-skills ()
  "Show only Skills defined in this project's .agents/skills."
  (interactive)
  (noema-capability-ui--switch 'local-skills))

(defun noema-capability-ui--truth-p (value)
  "Return non-nil when JSON-like VALUE represents true."
  (and value (not (memq value '(nil :false :null)))))

(defun noema-capability-ui--records ()
  "Return all records in the current capability resolution."
  (append (noema--sequence (noema--value noema-capability-ui--resolution "skills"))
          (noema--sequence (noema--value noema-capability-ui--resolution "mcps"))))

(defun noema-capability-ui--record-id (record)
  "Return the tabulated identity for RECORD."
  (cons (noema--value record "type") (noema--value record "id")))

(defun noema-capability-ui--record-at-point ()
  "Return the capability record represented by the current row."
  (let ((identity (tabulated-list-get-id)))
    (or (seq-find (lambda (record)
                    (equal (noema-capability-ui--record-id record) identity))
                  (noema-capability-ui--records))
        (user-error "No capability on this row"))))

(defun noema-capability-ui--source-scope (record)
  "Return RECORD's winning source scope."
  (or (noema--value (noema--value record "source") "scope") "unresolved"))

(defun noema-capability-ui--validation (record)
  "Return a compact validation label for RECORD."
  (let* ((validation (noema--value record "validation"))
         (errors (noema--sequence (noema--value validation "errors")))
         (warnings (noema--sequence (noema--value validation "warnings"))))
    (cond
     (errors (propertize (format "error (%d)" (length errors)) 'face 'error))
     ((eq :false (noema--value validation "valid")) (propertize "error" 'face 'error))
     (warnings (propertize (format "warning (%d)" (length warnings)) 'face 'warning))
     (t (propertize "valid" 'face 'success)))))

(defun noema-capability-ui--runtime (record)
  "Return RECORD's runtime-state label."
  (if (equal (noema--value record "type") "mcp")
      (let* ((runtime (noema--value record "runtime"))
             (state (or (noema--value runtime "state") "unknown"))
             (availability (noema--value runtime "availability")))
        (if (and availability (not (member availability '("unknown" "available")))
                 (not (equal state availability)))
            (format "%s/%s" state availability)
          state))
    "—"))

(defun noema-capability-ui--entry (record)
  "Build a `tabulated-list-mode' entry for RECORD."
  (let* ((enabled (noema-capability-ui--truth-p (noema--value record "enabled")))
         (patches (noema--sequence (noema--value record "patches")))
         (source (noema--value record "source")))
    (list
     (noema-capability-ui--record-id record)
     (vector
      (capitalize (or (noema--value record "type") ""))
      (or (noema--value record "id") "")
      (propertize (if enabled "yes" "no") 'face (if enabled 'success 'shadow))
      (noema-capability-ui--source-scope record)
      (or (noema--value source "path") "—")
      (number-to-string (length patches))
      (noema-capability-ui--validation record)
      (noema-capability-ui--runtime record)
      (let ((probe (and (hash-table-p noema-capability-ui--probes)
                        (gethash (noema--value record "id") noema-capability-ui--probes))))
        (if probe (or (noema--value probe "state") "failed") "—"))))))

(defun noema-capability-ui--render (resolution)
  "Render authoritative RESOLUTION in the current buffer."
  (setq noema-capability-ui--resolution resolution
        tabulated-list-entries
        (mapcar #'noema-capability-ui--entry
                (seq-filter (lambda (record)
                              (and (or (null noema-capability-ui--filter)
                                       (equal noema-capability-ui--filter (noema--value record "type")))
                                   (or (not (eq noema-capability-ui--view 'local-skills))
                                       (equal (noema-capability-ui--source-scope record) "project"))
                                   (or (not (eq noema-capability-ui--view 'patches))
                                       (noema-capability-ui--project-modified-p record))))
                            (noema-capability-ui--records))))
  (let* ((diagnostics (noema--sequence (noema--value resolution "diagnostics")))
         (errors (seq-count (lambda (item)
                              (equal (noema--value item "severity") "error"))
                            diagnostics)))
    (setq header-line-format
          (list (format " %s | %s | %d items · %d errors "
                        (noema-capability-ui--scope-label)
                        (or noema-capability-ui--filter "all")
                        (length tabulated-list-entries) errors)
                (noema-capability-ui--toolbar-button "Add" #'noema-capability-ui-add)
                (noema-capability-ui--toolbar-button "Patch → Project" #'noema-capability-ui-create-project-patch)
                (noema-capability-ui--toolbar-button "Copy → Local" #'noema-capability-ui-copy-global-skill)
                (noema-capability-ui--toolbar-button "Refine · Agent" #'noema-capability-ui-edit-with-agent)
                (noema-capability-ui--toolbar-button "Folder" #'noema-capability-ui-open-directory)
                (noema-capability-ui--toolbar-button "Edit" #'noema-capability-ui-open-source)
                (noema-capability-ui--toolbar-button "Actions C-c C-a" #'noema-capability-ui-menu))))
  (tabulated-list-print t)
  ;; The column labels occupy the first body line.  Land on a record when
  ;; opening a fresh list, while preserving an existing selected row.
  (when (and tabulated-list-entries (not (tabulated-list-get-id)))
    (goto-char (point-min))
    (forward-line 1)))

(defun noema-capability-ui--show-error (error-object)
  "Display an actionable ERROR-OBJECT from the host."
  (let ((message-text (or (noema--value error-object "message")
                          (and (stringp error-object) error-object)
                          "Capability request failed")))
    (message "Noema: %s" message-text)))

(defun noema-capability-ui-refresh ()
  "Re-resolve and redisplay the current page's Skills and MCPs."
  (interactive)
  (let ((buffer (current-buffer))
        (project noema-capability-ui--project)
        (generation (cl-incf noema-capability-ui--generation)))
    (setq header-line-format (format " Resolving %s…" (noema-capability-ui--scope-label)))
    (noema-capability-list
     :project project :scope (noema-capability-ui--scope)
     :callback
     (lambda (resolution error-object)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (when (= generation noema-capability-ui--generation)
            (if error-object
               (progn
                 (setq header-line-format " Capability resolution failed; C-c g to retry")
                 (noema-capability-ui--show-error error-object))
             (noema-capability-ui--render resolution)))))))))

(defun noema-capability-ui-inspect ()
  "Inspect the selected capability's effective value and provenance."
  (interactive)
  (let* ((record (noema-capability-ui--record-at-point))
         (id (noema--value record "id"))
         (project (noema-capability-ui--scope-label))
         (buffer (get-buffer-create (format "*Noema %s: %s (%s)*"
                                          (noema--value record "type") id project))))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "Noema capability: %s\nScope: %s\n\n"
                        id project))
        (insert (or (noema--value record "description") "") "\n\n")
        (insert (pp-to-string record))
        (goto-char (point-min))
        (special-mode)))
    (pop-to-buffer buffer)))

(defun noema-capability-ui--after-mutation (buffer result error-object)
  "Refresh BUFFER after a mutation, or display ERROR-OBJECT."
  (if error-object
      (noema-capability-ui--show-error error-object)
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (cl-incf noema-capability-ui--generation)
        (if-let* ((resolution (noema--value result "capabilities"))
                  (matches (or (null (noema--value resolution "scope"))
                               (equal (noema--value resolution "scope")
                                      (symbol-name (noema-capability-ui--scope))))))
            (noema-capability-ui--render resolution)
          (noema-capability-ui-refresh))))))

(defun noema-capability-ui--set-enabled (enabled)
  "Set the selected capability's selection in this page's scope to ENABLED."
  (let* ((record (noema-capability-ui--record-at-point))
         (type (noema--value record "type"))
         (id (noema--value record "id"))
         (buffer (current-buffer)))
    (noema-capability-set-enabled
     type id enabled :project noema-capability-ui--project
     :scope (noema-capability-ui--scope)
     :callback (apply-partially #'noema-capability-ui--after-mutation buffer))))

(defun noema-capability-ui-enable ()
  "Enable the capability in the scope shown by the active page."
  (interactive)
  (noema-capability-ui--set-enabled t))

(defun noema-capability-ui-disable ()
  "Disable the capability in the scope shown by the active page."
  (interactive)
  (noema-capability-ui--set-enabled nil))

(defun noema-capability-ui--project-patch (record)
  "Return RECORD's patch in the active page's scope, or nil."
  (when-let* ((entry (seq-find
                      (lambda (patch)
                        (equal (noema--value patch "scope") (symbol-name (noema-capability-ui--scope))))
                      (noema--sequence (noema--value record "patches")))))
    (noema--value entry "patch")))

(defun noema-capability-ui--read-json-object (initial prompt)
  "Read a JSON object initialized from INITIAL under PROMPT."
  (let ((buffer (generate-new-buffer " *Noema capability patch*"))
        value)
    (unwind-protect
        (save-window-excursion
          (pop-to-buffer buffer)
          (insert (if initial (json-encode initial) "{}"))
          (json-pretty-print-buffer)
          (when (fboundp 'json-mode) (json-mode))
          (message "%s; finish with C-M-c, cancel with C-]" prompt)
          (while (not (hash-table-p value))
            (recursive-edit)
            (condition-case err
                (with-current-buffer buffer
                  (setq value (json-parse-string (buffer-string)
                                                 :object-type 'hash-table :array-type 'array
                                                 :null-object :null :false-object :false))
                  (unless (hash-table-p value) (user-error "Enter a JSON object")))
              (error (setq value nil)
                     (pop-to-buffer buffer)
                     (message "%s; correct the JSON and finish with C-M-c" (error-message-string err))))))
      (when (buffer-live-p buffer) (kill-buffer buffer)))
    value))

(defun noema-capability-ui-edit-patch ()
  "Edit the selected capability's JSON Merge Patch in the active scope."
  (interactive)
  (let* ((record (noema-capability-ui--record-at-point))
         (patch (noema-capability-ui--read-json-object
                 (noema-capability-ui--project-patch record)
                 (format "Edit %s patch as JSON" (noema-capability-ui--scope-label))))
         (buffer (current-buffer)))
    (noema-capability-set-patch
     (noema--value record "type") (noema--value record "id") patch
     :project noema-capability-ui--project
     :scope (noema-capability-ui--scope)
     :callback (apply-partially #'noema-capability-ui--after-mutation buffer))))

(defun noema-capability-ui-remove-patch ()
  "Remove the selected project override; preserve its editable files."
  (interactive)
  (unless (eq noema-capability-ui--view 'patches)
    (user-error "Remove project patches from the Project Patch page"))
  (let ((record (noema-capability-ui--record-at-point))
        (buffer (current-buffer)))
    (unless (yes-or-no-p (format "Remove this capability's %s patch? " (noema-capability-ui--scope-label)))
      (user-error "Patch removal cancelled"))
    (noema-capability-set-patch
     (noema--value record "type") (noema--value record "id") nil
     :project noema-capability-ui--project
     :scope (noema-capability-ui--scope)
     :callback (apply-partially #'noema-capability-ui--after-mutation buffer))))

(defun noema-capability-ui-register-mcp-json ()
  "Define and enable an MCP in the active scope from a JSON object."
  (interactive)
  (let* ((buffer (current-buffer))
         (id (string-trim (read-string "MCP id: "))))
    (when (string-empty-p id) (user-error "MCP id cannot be empty"))
    (let ((definition (noema-capability-ui--read-json-object
                       '((command . "") (args . []) (env . []))
                       "Define the MCP transport as JSON")))
      (noema-mcp-register
       id definition :project noema-capability-ui--project :enabled t
       :scope (noema-capability-ui--scope)
       :callback (apply-partially #'noema-capability-ui--after-mutation buffer)))))

(defun noema-capability-ui-edit-config ()
  "Visit the canonical configuration for the active scope."
  (interactive)
  (let ((path (or (noema--value noema-capability-ui--resolution "configFile")
                   (user-error "Wait for resolution, or press g to refresh"))))
    (noema-capability-ui--open-right path)
    (when (= (buffer-size) 0)
      (insert "{\n  \"schema\": \"noema.capabilities/1\",\n  \"skills\": {},\n  \"mcp\": {}\n}\n")
      (goto-char (point-min)))))

(defun noema-capability-ui--global-scope ()
  "Return the global library descriptor supplied by the host."
  (or (seq-find (lambda (scope) (equal (noema--value scope "name") "global"))
                (noema--sequence (noema--value noema-capability-ui--resolution "scopes")))
      (user-error "Wait for the capability list, or press g to refresh")))

(defun noema-capability-ui-edit-global-config ()
  "Open the global Skill/MCP library configuration under Emacs etc."
  (interactive)
  (noema-capability-ui--open-right (noema--value (noema-capability-ui--global-scope) "source")))

(defun noema-capability-ui-open-global-skills ()
  "Browse the global Skill library in Dired."
  (interactive)
  (noema-capability-ui--open-right (car (noema--sequence (noema--value (noema-capability-ui--global-scope) "skillDirectories"))) t))

(defun noema-capability-ui-libraries ()
  "Show linked Claude, Codex, OpenCode and Pi libraries with source buttons."
  (interactive)
  (let ((libraries (noema--sequence (noema--value noema-capability-ui--resolution "libraries")))
        (global (noema-capability-ui--global-scope)))
    (with-current-buffer (get-buffer-create "*Noema capability libraries*")
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert "Noema shared libraries\n\n"
                "Source buttons edit the original linked file, shared with its native client.\n"
                "Manager e/d/p actions write the active page's Noema scope, not the native config.\n"
                "Imported MCPs never auto-start. OAuth credentials are not imported.\n\n")
        (dolist (library (cons `((id . "global") (state . "Noema-owned")
                                (configFile . ,(noema--value global "source"))
                                (skillDirectories . ,(noema--value global "skillDirectories"))) libraries))
          (insert (format "%s — %s (%s capabilities)\n" (noema--value library "id")
                          (noema--value library "state") (noema--value library "count" "—")))
          (dolist (path (cons (noema--value library "configFile")
                              (noema--sequence (noema--value library "skillDirectories"))))
            (when (and (stringp path) (not (string-empty-p path)))
              (insert "  ")
              (insert-text-button (abbreviate-file-name path) 'follow-link t
                                  'action (lambda (_) (noema-capability-ui--open-right path (file-directory-p path))))
              (insert (if (file-exists-p path) "\n" "  (not created yet)\n"))))
          (insert "\n"))
        (goto-char (point-min))
        (special-mode))
      (pop-to-buffer (current-buffer)))))

(defvar noema-capability-ui-mode-map (make-sparse-keymap))
(set-keymap-parent noema-capability-ui-mode-map tabulated-list-mode-map)
;; Remove bindings from earlier loads as well; Evil keeps motions, operators,
;; search, counts and undo.  Commands live under C-c and the mouse toolbar.
(dolist (key '("1" "2" "3" "i" "e" "d" "p" "P" "a" "n" "I" "f" "u" "E" "t" "l" "/" "?" "c" "G" "D" "L" "g"))
  (define-key noema-capability-ui-mode-map (kbd key) nil))
(defvar noema-capability-ui-command-map (make-sparse-keymap))
(dolist (binding '(("1" . noema-capability-ui-global) ("2" . noema-capability-ui-project-patches)
                   ("3" . noema-capability-ui-local-skills) ("C-a" . noema-capability-ui-menu)
                   ("a" . noema-capability-ui-add) ("n" . noema-capability-ui-create-skill)
                   ("I" . noema-capability-ui-import-skill) ("p" . noema-capability-ui-create-project-patch)
                   ("y" . noema-capability-ui-copy-global-skill) ("s" . noema-capability-ui-edit-with-agent)
                   ("o" . noema-capability-ui-open-directory) ("f" . noema-capability-ui-open-source)
                   ("i" . noema-capability-ui-inspect) ("e" . noema-capability-ui-enable)
                   ("=" . noema-capability-ui-diff-skill)
                   ("d" . noema-capability-ui-disable) ("j" . noema-capability-ui-edit-patch)
                   ("P" . noema-capability-ui-remove-patch) ("E" . noema-capability-ui-edit-mcp)
                   ("u" . noema-capability-ui-insert-skill) ("t" . noema-capability-ui-probe-mcp)
                   ("l" . noema-capability-ui-probe-details) ("/" . noema-capability-ui-filter)
                   ("c" . noema-capability-ui-edit-config) ("G" . noema-capability-ui-edit-global-config)
                   ("D" . noema-capability-ui-open-global-skills) ("L" . noema-capability-ui-libraries)
                   ("g" . noema-capability-ui-refresh) ("q" . quit-window)
                   ("?" . describe-mode)))
  (define-key noema-capability-ui-command-map (kbd (car binding)) (cdr binding)))
(define-key noema-capability-ui-mode-map (kbd "C-c") noema-capability-ui-command-map)
(define-key noema-capability-ui-mode-map (kbd "RET") #'noema-capability-ui-inspect)

(with-eval-after-load 'evil
  (evil-set-initial-state 'noema-capability-ui-mode 'normal)
  (evil-define-key* '(normal visual motion) noema-capability-ui-mode-map
    (kbd "C-c") noema-capability-ui-command-map
    (kbd "RET") #'noema-capability-ui-inspect))

(define-derived-mode noema-capability-ui-mode tabulated-list-mode "Noema-Capabilities"
  "Manage the global Skill/MCP library and optional project overlays.
C-c 1: global library.  C-c 2: project patches.  C-c 3: local Skills.
C-c C-a opens the action menu.  Evil's normal navigation and editing keys
are preserved; no state or mode is disabled.
C-c q closes the manager and restores the buffer it temporarily covered.
Opening always starts globally.  Project pages use the opening buffer's
project; they never prompt for a directory.  Changes apply to the active page."
  (setq tabulated-list-format
        [("Type" 8 t) ("Capability" 24 t) ("Enabled" 8 t) ("Scope" 12 t)
         ("Source" 34 t) ("Patches" 8 t) ("Validation" 13 t) ("Runtime" 13 t) ("Last test" 10 t)])
  (setq tabulated-list-padding 2
        tabulated-list-use-header-line nil
        tab-line-format '(:eval (noema-capability-ui--tabs))
        tabulated-list-sort-key '("Type" . nil)
        revert-buffer-function (lambda (&rest _) (noema-capability-ui-refresh)))
  (tabulated-list-init-header))

;;;###autoload
(defun noema-capability-manager (&optional project type)
  "Open the global Skill/MCP manager, optionally filtered by TYPE.
PROJECT or the opening buffer's project is only context for the optional
project pages.  It never changes the initial global view.  In an agent
shell the same command is a read-only lookup, because the manager's scoped
writes do not reach a running external client."
  (interactive)
  (if (and (null project) (noema-capability-lookup--agent-buffer))
      (noema-capability-lookup type)
    (let* ((root (or (and (null project) noema-capability-ui--project)
                     (noema-current-project project)))
           (origin (if (derived-mode-p 'noema-research-mode) (point-marker)
                     noema-capability-ui--origin))
           (buffer (get-buffer-create (format "*Noema %s: %s*" (or type "capabilities")
                                              "Global"))))
      (with-current-buffer buffer
        (noema-capability-ui-mode)
        (setq noema-capability-ui--project root
              default-directory (or root default-directory)
              noema-capability-ui--base-filter type
              noema-capability-ui--filter type
              noema-capability-ui--origin origin
              noema-capability-ui--probes (make-hash-table :test #'equal))
        (noema-capability-ui-global))
      (pop-to-buffer buffer))))

;;;###autoload
(defun noema-skill-manager (&optional project)
  "Open the global Skill manager, with optional PROJECT page context."
  (interactive)
  (noema-capability-manager project "skill"))

;;;###autoload
(defun noema-mcp-manager (&optional project)
  "Open the global MCP manager, with optional PROJECT page context."
  (interactive)
  (noema-capability-manager project "mcp"))

(require 'noema-capability-actions)

(provide 'noema-capability-ui)
;;; noema-capability-ui.el ends here
