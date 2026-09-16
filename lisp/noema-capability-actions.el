;;; noema-capability-actions.el --- Skill and MCP manager actions -*- lexical-binding: t; -*-

(require 'noema-api)
(require 'wid-edit)
(require 'json)
(require 'transient)
(declare-function noema-agent-acp-config-for "noema-agent-acp" (agent))
(declare-function noema-agent-acp-start "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-draft "noema-agent-acp" (buffer text))
(declare-function noema-capability-ui--switch "noema-capability-ui" (view))
(defvar noema-capability-ui--project)
(defvar noema-capability-ui--resolution)
(defvar noema-capability-ui--filter)
(defvar noema-capability-ui--origin)
(defvar noema-capability-ui--probes)
(defvar noema-capability-ui--generation)
(defvar noema-capability-ui--view)
(declare-function noema-capability-ui--scope "noema-capability-ui" ())
(declare-function noema-capability-ui--scope-label "noema-capability-ui" ())
(declare-function noema-capability-ui--record-at-point "noema-capability-ui" ())
(declare-function noema-capability-ui--render "noema-capability-ui" (resolution))
(declare-function noema-capability-ui-refresh "noema-capability-ui" ())
(declare-function noema-capability-ui--show-error "noema-capability-ui" (error-object))
(declare-function noema-capability-ui--after-mutation "noema-capability-ui" (buffer result error-object))
(declare-function noema-research--entry-at-point "noema-research-mode" (&optional entries))
(declare-function noema-research--require-cell "noema-research-mode" ())
(declare-function vterm-send-string "vterm" (string &optional paste-p))

(defun noema-capability-ui--open-right (path &optional directory manager)
  "Open PATH to the right of MANAGER without replacing the manager window.
DIRECTORY means use Dired.  Reuse only a window previously owned by this
manager; do not steal an unrelated work, DAG or output window."
  (let* ((manager (or manager (current-buffer)))
         (anchor (get-buffer-window manager (selected-frame)))
         (existing (seq-find (lambda (window)
                               (eq (window-parameter window 'noema-capability-owner) manager))
                             (window-list)))
         (window (or existing (split-window (or anchor (selected-window)) nil 'right)))
         (buffer (if directory (dired-noselect path) (find-file-noselect path))))
    (set-window-parameter window 'noema-capability-owner manager)
    (set-window-buffer window buffer)
    (select-window window)
    buffer))

(defun noema-capability-ui-filter ()
  "Choose the kinds of capabilities to show."
  (interactive)
  (when (eq noema-capability-ui--view 'local-skills)
    (user-error "This page only shows project-local Skills; use 1 or 2 for other capabilities"))
  (let ((type (completing-read "Show: " '("all" "skill" "mcp") nil t)))
    (setq noema-capability-ui--filter (unless (equal type "all") type))
    (noema-capability-ui--render noema-capability-ui--resolution)))

(defun noema-capability-ui--installed (manager result error-object)
  "Refresh MANAGER and open a newly installed Skill from RESULT."
  (if error-object (noema-capability-ui--show-error error-object)
    (when (buffer-live-p manager)
      (noema-capability-ui--after-mutation manager result nil))
    (when-let* ((path (noema--value (noema--value result "skill") "path")))
      (noema-capability-ui--open-right path nil manager))))

(defun noema-capability-ui-create-skill ()
  "Create a Skill in the active scope and open its SKILL.md."
  (interactive)
  (let ((id (string-trim (read-string "Skill id: "))))
    (unless (string-match-p "\\`[A-Za-z0-9][A-Za-z0-9._-]*\\'" id)
      (user-error "Use letters, digits, dots, hyphens or underscores for the id"))
    (noema-skill-install :project noema-capability-ui--project :id id
                        :scope (noema-capability-ui--scope)
                        :description (read-string "Description: ")
                        :callback (apply-partially #'noema-capability-ui--installed (current-buffer)))))

(defun noema-capability-ui-import-skill ()
  "Import a local Skill directory including its supporting resources."
  (interactive)
  (let ((directory (read-directory-name "Import Skill directory: " nil nil t)))
    (unless (file-regular-p (expand-file-name "SKILL.md" directory))
      (user-error "This directory has no SKILL.md"))
    (noema-skill-install :project noema-capability-ui--project :source-directory directory
                        :scope (noema-capability-ui--scope)
                        :callback (apply-partially #'noema-capability-ui--installed (current-buffer)))))

(defun noema-capability-ui-open-source ()
  "Edit this page's Skill file or MCP configuration, not an inherited source."
  (interactive)
  (noema-capability-ui--open-right (noema-capability-ui--edit-path)))

(defun noema-capability-ui--edit-path ()
  "Return the selected entry's editable file in this page's scope."
  (let* ((record (noema-capability-ui--record-at-point))
         (project-patch (seq-find (lambda (patch) (equal (noema--value patch "scope") "project"))
                                   (noema--sequence (noema--value record "patches"))))
         (path (if (eq noema-capability-ui--view 'patches)
                   (or (noema--value project-patch "file")
                       (noema--value noema-capability-ui--resolution "configFile"))
                 (noema--value (noema--value record "source") "path"))))
    (unless (and path (not (string-prefix-p "builtin:" path)))
      (user-error "This built-in MCP has no source configuration file"))
    (expand-file-name path noema-capability-ui--project)))

(defun noema-capability-ui-open-directory ()
  "Open the selected Skill's editable directory in Emacs Dired."
  (interactive)
  (noema-capability-ui--open-right (file-name-directory (noema-capability-ui--edit-path)) t))

(defun noema-capability-ui-diff-skill ()
  "Review the actual unified diff, not a full Markdown override."
  (interactive)
  (unless (eq noema-capability-ui--view 'patches) (user-error "Select a project Skill patch first"))
  (let ((path (noema-capability-ui--edit-path)))
    (unless (string-suffix-p ".patch" path)
      (user-error "Use Patch → Project to convert this legacy override to a unified diff"))
    (noema-capability-ui--open-right path)))

(defun noema-capability-ui--prepared (manager operation result error-object)
  "Show the project page and editable file prepared by OPERATION."
  (if error-object (noema-capability-ui--show-error error-object)
    (when (buffer-live-p manager)
      (with-current-buffer manager
        (noema-capability-ui--switch (if (equal operation "patch") 'patches 'local-skills))))
    (when-let* ((path (noema--value (noema--value result "skill") "path")))
      (noema-capability-ui--open-right path nil manager)
      (message (if (equal operation "patch")
                   "Noema: unified diff only; C-c s in the manager drafts an agent-shell refinement. Save then refresh to validate with patch."
                 "Noema: independent Local Skill; the global original is unchanged.")))))

(defun noema-capability-ui-create-project-patch ()
  "Create a project-only patch from the selected global capability."
  (interactive)
  (unless noema-capability-ui--project (user-error "Open the global manager from your target project first"))
  (let ((record (noema-capability-ui--record-at-point)))
    (if (equal (noema--value record "type") "skill")
        (noema-skill-prepare
         (noema--value record "id") "patch" :project noema-capability-ui--project
         :callback (apply-partially #'noema-capability-ui--prepared (current-buffer) "patch"))
      (noema-capability-set-patch
       "mcp" (noema--value record "id")
       (noema-capability-ui--read-json-object nil "Create this project's MCP patch")
       :project noema-capability-ui--project :scope 'project
       :callback (apply-partially #'noema-capability-ui--prepared (current-buffer) "patch")))))

(defun noema-capability-ui-copy-global-skill ()
  "Copy a global Skill and its resources into independent project-local files."
  (interactive)
  (unless noema-capability-ui--project (user-error "Open the global manager from your target project first"))
  (let* ((manager (current-buffer))
         (project noema-capability-ui--project)
         (record (and (eq noema-capability-ui--view 'global) (tabulated-list-get-id)
                      (noema-capability-ui--record-at-point)))
         (copy (lambda (id)
                 (noema-skill-prepare id "copy" :project project
                                     :callback (apply-partially #'noema-capability-ui--prepared manager "copy")))))
    (if (and record (equal (noema--value record "type") "skill"))
        (funcall copy (noema--value record "id"))
      (noema-skill-list
       :scope 'global
       :callback (lambda (skills error-object)
                   (if error-object (noema-capability-ui--show-error error-object)
                     (funcall copy (completing-read "Copy global Skill: "
                                                   (mapcar (lambda (skill) (noema--value skill "id")) skills) nil t))))))))

(defun noema-capability-ui-edit-with-agent ()
  "Draft an agent-shell request to edit the selected project Skill patch.
No request is sent until the user reviews the draft and presses RET."
  (interactive)
  (unless (memq noema-capability-ui--view '(patches local-skills))
    (user-error "Create a project Patch or Copy to Local first"))
  (let* ((record (noema-capability-ui--record-at-point))
         (path (noema-capability-ui--edit-path))
         (source (expand-file-name (noema--value (noema--value record "source") "path") noema-capability-ui--project))
         agent request)
    (unless (and (equal (noema--value record "type") "skill")
                 (or (string-suffix-p ".patch" path)
                     (and (eq noema-capability-ui--view 'local-skills)
                          (equal (file-name-nondirectory path) "SKILL.md"))))
      (user-error "Select a unified-diff Patch or Local Skill; convert legacy overrides with Patch → Project"))
    (setq agent (completing-read "Edit with agent: " '("codex" "claude" "opencode") nil t)
          request (read-string "Skill refinement: "))
    (require 'noema-agent-acp)
    (let ((buffer (noema-agent-acp-start :config (noema-agent-acp-config-for agent)
                                       :directory (file-name-directory path) :focus t)))
      (noema-agent-acp-draft
       buffer (concat
               (if (string-suffix-p ".patch" path)
                   (format "Micro-refine this Skill by editing ONLY the unified diff file %S using your apply_patch/file-patch tool.\nRead PATCH-BASE.md in this directory as the immutable baseline; read the existing diff first and preserve its changes.\nThe diff must have exactly these headers: --- SKILL.md and +++ SKILL.md, followed by unified @@ hunks. Save the cumulative minimal delta against PATCH-BASE.md, NOT a full replacement Markdown file.\nValidate using the system patch command on a temporary copy of PATCH-BASE.md, with -t -N -F 0; never apply it to the baseline or global original.\nDo not change PATCH-BASE.md, the frontmatter name, or capability config.\n" path)
                 (format "Refine only the independent Local Skill file %S using your file-edit/patch tool. Keep its frontmatter name unchanged.\n" path))
               (format "Do not modify global Skills, client configuration, or unrelated files. Supporting resources resolve from %S (read-only).\nRequested micro-refinement:\n%s"
                       (file-name-directory source) request))))))

(transient-define-prefix noema-capability-ui-menu ()
  "Manage Skills/MCPs without overriding Evil's editing and movement keys."
  [["Library / project"
    ("1" "Global" noema-capability-ui-global)
    ("2" "Project patches" noema-capability-ui-project-patches)
    ("3" "Local Skills" noema-capability-ui-local-skills)
    ("g" "Refresh" noema-capability-ui-refresh)]
   ["Create / refine"
    ("a" "Add" noema-capability-ui-add)
    ("p" "Create project Patch" noema-capability-ui-create-project-patch)
    ("y" "Copy global to Local" noema-capability-ui-copy-global-skill)
    ("s" "Edit with agent-shell" noema-capability-ui-edit-with-agent)
    ("I" "Import directory" noema-capability-ui-import-skill)]
   ["Edit / inspect"
    ("f" "Edit file" noema-capability-ui-open-source)
    ("o" "Open directory" noema-capability-ui-open-directory)
    ("i" "Inspect" noema-capability-ui-inspect)
    ("j" "Advanced JSON patch" noema-capability-ui-edit-patch)
    ("=" "Review Skill diff" noema-capability-ui-diff-skill)
    ("P" "Remove patch" noema-capability-ui-remove-patch)]
   ["Selection / MCP"
    ("e" "Enable" noema-capability-ui-enable)
    ("d" "Disable" noema-capability-ui-disable)
    ("u" "Use @@skill" noema-capability-ui-insert-skill)
    ("E" "Edit MCP" noema-capability-ui-edit-mcp)
    ("t" "Test MCP" noema-capability-ui-probe-mcp)
    ("l" "Test details" noema-capability-ui-probe-details)]]
  [["Configuration"
    ("/" "Filter" noema-capability-ui-filter)
    ("c" "Scope config" noema-capability-ui-edit-config)
    ("G" "Global config" noema-capability-ui-edit-global-config)
    ("D" "Global directory" noema-capability-ui-open-global-skills)
    ("L" "Linked libraries" noema-capability-ui-libraries)]] )

(defun noema-capability-ui-insert-skill ()
  "Insert the selected Skill into the work block that opened this manager."
  (interactive)
  (let* ((record (noema-capability-ui--record-at-point))
         (origin noema-capability-ui--origin)
         (manager-window (get-buffer-window (current-buffer) (selected-frame)))
         (id (noema--value record "id")))
    (unless (equal (noema--value record "type") "skill") (user-error "Select a Skill"))
    (unless (eq t (noema--value record "selectable"))
      (user-error "This Skill is disabled or invalid; inspect or enable it first"))
    (unless (and (markerp origin) (marker-buffer origin))
      (user-error "Open the manager from the destination JuText work block"))
    (with-current-buffer (marker-buffer origin)
      (goto-char origin)
      (let* ((cell (noema-research--require-cell))
             (entry (noema-research--entry-at-point))
             (directive (format "@@skill(%s)" id)))
	(unless (equal (noema-research-cell-kind cell (noema-current-document)) "work")
          (user-error "Skills can only be inserted into a work block"))
	(goto-char (1+ (plist-get entry :header-end)))
	(let ((start (point)) found seen)
          (while (and (< (point) (plist-get entry :block-end))
                      (or (looking-at "@@\\(?:agent\\|session\\|ctx\\|skill\\)([^)\n]+)[ \t]*$")
                          (and seen (looking-at "[ \t]*$"))))
            (when (looking-at (concat (regexp-quote directive) "[ \t]*$")) (setq found t))
            (setq seen t)
            (forward-line 1))
          (unless found
            (goto-char start)
            (atomic-change-group (insert directive "\n")))
          (message "Noema: %s %s" (if found "Already uses" "Inserted") id))))
    ;; Finish the temporary manager display before returning to JuText.
    ;; `pop-to-buffer' alone leaves the manager covering its previous buffer.
    (when (window-live-p manager-window)
      (quit-window nil manager-window))
    (pop-to-buffer (marker-buffer origin))))

(defun noema-capability-ui-add ()
  "Add a Skill or MCP in the current manager view."
  (interactive)
  (if (eq noema-capability-ui--view 'patches)
      (progn (noema-capability-ui-global)
             (message "Select a global capability, then click Patch → Project"))
    (if (equal (or noema-capability-ui--filter
                 (completing-read "Add: " '("skill" "mcp") nil t)) "skill")
      (noema-capability-ui-create-skill)
      (noema-capability-ui-register-mcp))))

(defun noema-capability-ui-register-mcp ()
  "Open a form for a new MCP in the active scope."
  (interactive)
  (noema-capability-ui--mcp-form))

(defun noema-capability-ui-edit-mcp ()
  "Edit the selected MCP as a definition in the active scope."
  (interactive)
  (let ((record (noema-capability-ui--record-at-point)))
    (unless (equal (noema--value record "type") "mcp") (user-error "Select an MCP"))
    (when (equal (noema--value record "id") "noema")
      (user-error "The built-in endpoint is managed by Noema; use p to override configuration"))
    (noema-capability-ui--mcp-form record)))

(defun noema-capability-ui--mcp-form (&optional record)
  "Build an Emacs widget form, optionally initialized from RECORD."
  (let* ((manager (current-buffer))
         (project noema-capability-ui--project)
         (scope (noema-capability-ui--scope))
         (scope-label (noema-capability-ui--scope-label))
         (directory default-directory)
         (config (noema--value (noema--value record "effective") "config"))
         (form (generate-new-buffer "*Noema MCP configuration*"))
         id transport command args url pairs)
    (pop-to-buffer form)
    (setq default-directory directory)
    (widget-insert (format "MCP configuration\nScope: %s\n\n" scope-label))
    (setq id (widget-create (if record 'item 'editable-field) :tag "Id" :format "%t: %v\n"
                            (or (noema--value record "id") ""))
          transport (widget-create 'menu-choice :tag "Transport" :value (or (noema--value config "type") "stdio")
                                   '(const "stdio") '(const "http") '(const "sse")))
    (widget-insert "\nFor stdio, enter a command and one argument per row.\n")
    (setq command (widget-create 'editable-field :tag "Command" :format "%t: %v\n"
                                 (or (noema--value config "command") ""))
          args (widget-create 'editable-list :tag "Arguments"
                              :value (noema--sequence (noema--value config "args"))
                              '(editable-field)))
    (widget-insert "\nFor HTTP/SSE, enter the endpoint URL.\n")
    (setq url (widget-create 'editable-field :tag "URL" :format "%t: %v\n" (or (noema--value config "url") "")))
    (widget-insert "\nEnvironment (stdio) or request headers (HTTP/SSE):\n")
    (setq pairs (widget-create
                 'editable-list :value
                 (mapcar (lambda (pair) (list (noema--value pair "name") (noema--value pair "value")))
                         (noema--sequence (or (noema--value config "env") (noema--value config "headers"))))
                 '(group (editable-field :tag "Name" :format "%t: %v\n")
                         (editable-field :tag "Value" :format "%t: %v\n"))))
    (widget-insert "\n")
    (widget-create
     'push-button :notify
     (lambda (&rest _)
       (let* ((identity (string-trim (widget-value id)))
              (kind (widget-value transport))
              (entries (vconcat (mapcar (lambda (pair) `((name . ,(car pair)) (value . ,(cadr pair))))
                                       (widget-value pairs))))
              (definition (if (equal kind "stdio")
                              `((command . ,(string-trim (widget-value command)))
                                (args . ,(vconcat (widget-value args))) (env . ,entries))
                            `((type . ,kind) (url . ,(string-trim (widget-value url))) (headers . ,entries)))))
         (unless (string-match-p "\\`[A-Za-z0-9][A-Za-z0-9._-]*\\'" identity) (user-error "Invalid MCP id"))
         (when (equal identity "noema") (user-error "The id noema is reserved for the built-in endpoint"))
         (when (and (equal kind "stdio") (string-empty-p (noema--value definition "command")))
           (user-error "Command is required"))
         (when (and (not (equal kind "stdio"))
                    (not (string-match-p "\\`https?://[^/]+" (noema--value definition "url"))))
           (user-error "Enter an HTTP or HTTPS URL"))
         (noema-mcp-register
          identity definition :project project :enabled (if record (eq t (noema--value record "enabled")) t)
          :scope scope
          :callback (lambda (result err)
                      (noema-capability-ui--after-mutation manager result err)
                      (unless err
                        (when (buffer-live-p form) (kill-buffer form))
                        (when (buffer-live-p manager) (pop-to-buffer manager)))))))
     (format "Save %s MCP" scope))
    (widget-insert "  ")
    (widget-create 'push-button :notify (lambda (&rest _) (kill-buffer form)) "Cancel")
    (use-local-map widget-keymap)
    (widget-setup)
    (goto-char (point-min))))

(defun noema-capability-ui-probe-mcp ()
  "Test the selected MCP and display its tools and connection diagnostics."
  (interactive)
  (let* ((record (noema-capability-ui--record-at-point))
         (id (noema--value record "id"))
         (generation noema-capability-ui--generation)
         (manager (current-buffer)))
    (unless (equal (noema--value record "type") "mcp") (user-error "Select an MCP"))
    (unless (hash-table-p noema-capability-ui--probes)
      (setq noema-capability-ui--probes (make-hash-table :test #'equal)))
    (when (equal (noema--value (gethash id noema-capability-ui--probes) "state") "testing")
      (user-error "This MCP test is already running"))
    (puthash id '((state . "testing")) noema-capability-ui--probes)
    (noema-capability-ui--render noema-capability-ui--resolution)
    (message "Noema: testing %s…" id)
    (noema-mcp-probe
     id :project noema-capability-ui--project
     :scope (noema-capability-ui--scope)
     :callback
     (lambda (result error-object)
       (when (and (buffer-live-p manager)
                  (= generation (buffer-local-value 'noema-capability-ui--generation manager)))
         (with-current-buffer manager
           (unless (hash-table-p noema-capability-ui--probes)
             (setq noema-capability-ui--probes (make-hash-table :test #'equal)))
           (puthash id (if error-object `((error . ,(or (noema--value error-object "message") "Probe failed")))
                         (noema--value result "probe")) noema-capability-ui--probes)
           (noema-capability-ui--render noema-capability-ui--resolution)
           (noema-capability-ui-probe-details id)))))))

(defun noema-capability-ui-probe-details (&optional id)
  "Display the last MCP test's tools, schemas and logs for ID."
  (interactive)
  (let* ((id (or id (noema--value (noema-capability-ui--record-at-point) "id")))
         (probe (and (hash-table-p noema-capability-ui--probes) (gethash id noema-capability-ui--probes)))
         (project (noema-capability-ui--scope-label)))
    (unless probe (user-error "No test result; press t on an MCP first"))
    (with-current-buffer (get-buffer-create (format "*Noema MCP test: %s (%s)*" id project))
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "MCP test: %s\nScope: %s\nState: %s    Checked: %s    Duration: %s ms\n\n"
                        id project (or (noema--value probe "state") "failed")
                        (or (noema--value probe "checkedAt") "—") (or (noema--value probe "durationMs") "—")))
        (when-let* ((error (noema--value probe "error"))) (insert "Error: " error "\n\n"))
        (insert "Connection log\n" (mapconcat #'identity (noema--sequence (noema--value probe "log")) "\n") "\n\n")
        (when-let* ((stderr (noema--value probe "stderr"))) (insert "Server stderr\n" stderr "\n\n"))
        (insert "Tools\n")
        (dolist (tool (noema--sequence (noema--value probe "tools")))
          (insert (or (noema--value tool "name") "") "\n"
                  (or (noema--value tool "description") "") "\n"
                  (pp-to-string (noema--value tool "inputSchema")) "\n"))
        (goto-char (point-min))
        (special-mode))
      (display-buffer (current-buffer)))))

;;; Agent-shell lookup
;;
;; An agent-shell session is an external client with its own capability
;; installation; the manager's scoped writes do not reach it.  There the same
;; command is a read-only lookup that drafts a reference to the resolved
;; source, and nothing is enabled, patched, installed or submitted.

(defun noema-capability-lookup--agent-buffer ()
  "Return the current buffer when it is an agent input surface, or nil."
  (and (or (derived-mode-p 'agent-shell-mode) (derived-mode-p 'vterm-mode))
       (current-buffer)))

(defun noema-capability-lookup--reference (record project)
  "Return the one-line reference drafted for RECORD, resolved against PROJECT.
The text stays on one line so a terminal never submits it on insertion."
  (let* ((id (noema--value record "id"))
         (path (noema--value (noema--value record "source") "path"))
         (file (and (stringp path) (not (string-prefix-p "builtin:" path))
                    (expand-file-name path (or project default-directory)))))
    (if (equal (noema--value record "type") "skill")
        (if file
            (format "Noema Skill %s — read and follow %S; resolve its relative resources from %S."
                    id file (directory-file-name (file-name-directory file)))
          (format "Noema Skill %s — %s" id (or (noema--value record "description") "")))
      (format "Noema MCP %s — use its tools%s."
              id (if file (format "; configured in %S" file) "")))))

(defun noema-capability-lookup--read (records type)
  "Read one record from RECORDS, annotated with scope, state and description.
TYPE is the manager's filter, or nil when both kinds are offered."
  (unless records (user-error "No capabilities resolved for this directory"))
  (let* ((table (mapcar (lambda (record)
                          (cons (if type (noema--value record "id")
                                  (format "%s:%s" (noema--value record "type")
                                          (noema--value record "id")))
                                record))
                        records))
         (annotate
          (lambda (key)
            (let ((record (cdr (assoc key table))))
              (format "  %s · %s · %s"
                      (if (eq t (noema--value record "enabled")) "enabled" "available")
                      (or (noema--value (noema--value record "source") "scope") "")
                      (or (noema--value record "description") "")))))
         (key (completing-read
               (format "Look up %s: " (or type "capability"))
               (lambda (string predicate action)
                 (if (eq action 'metadata)
                     `(metadata (annotation-function . ,annotate)
                                (category . noema-capability))
                   (complete-with-action action table string predicate)))
               nil t)))
    (cdr (assoc key table))))

(defun noema-capability-lookup--draft (buffer text)
  "Draft TEXT in BUFFER's agent input; never submit it."
  (if (with-current-buffer buffer (derived-mode-p 'agent-shell-mode))
      (progn (require 'noema-agent-acp)
             (noema-agent-acp-draft buffer text))
    (with-current-buffer buffer
      (if (derived-mode-p 'vterm-mode) (vterm-send-string text) (insert text)))))

;;;###autoload
(defun noema-capability-lookup (&optional type buffer)
  "Look up a Skill or MCP and draft its reference in agent input BUFFER.
TYPE filters the candidates.  This is a lookup: it resolves the same host
capability model as the manager and writes nothing to any scope."
  (interactive)
  (let* ((target (or buffer (noema-capability-lookup--agent-buffer) (current-buffer)))
         (project (noema-current-project target)))
    (apply
     #'noema-capability-list
     (append
      (if project (list :project project) (list :scope 'global))
      (list
       :callback
       (lambda (resolution error-object)
         (cond
          (error-object (noema-capability-ui--show-error error-object))
          ((not (buffer-live-p target))
           (message "Noema: the agent buffer closed before the lookup finished"))
          (t
           (let* ((records (seq-filter
                            (lambda (record)
                              (or (null type) (equal (noema--value record "type") type)))
                            (append (noema--sequence (noema--value resolution "skills"))
                                    (noema--sequence (noema--value resolution "mcps")))))
                  (record (noema-capability-lookup--read records type)))
             (noema-capability-lookup--draft
              target (noema-capability-lookup--reference record project))
             (message "Noema: drafted %s; review before sending"
                      (noema--value record "id")))))))))))

(provide 'noema-capability-actions)
;;; noema-capability-actions.el ends here
