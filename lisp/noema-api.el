;;; noema-api.el --- Public semantic API for Noema -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Project identity, durable Run cancellation and effective capabilities for
;; Emacs clients and compatible agents.  Legacy document models remain in
;; noema-research; this API does not install a work-document editor.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'noema-research)

(declare-function +noema-api-call "noema/bridge/config"
                  (channel args callback &optional timeout))
(declare-function +noema--ensure-server "noema/bridge/config" (&optional callback))







(declare-function noema-agent-worker-run-work-cell "noema-agent-worker"
                  (file cell-id &optional session-policy parent-session-id session-name))
(declare-function noema-agent-worker-cancel-run "noema-agent-worker" (run-id))


(defvar +noema--ready)
(defvar noema-capability--last-resolution nil
  "Most recent effective capability resolution returned by the Noema host.")

(defvar noema-capability--cache (make-hash-table :test #'equal)
  "Project roots or :global mapped to resolution and pending request state.")
(defvar noema-capability-changed-hook nil
  "Hook called with a project root after its capability cache changes.")

(defun noema-capability-cached (&optional project)
  "Return PROJECT's cached resolution, without starting a request."
  (plist-get (gethash (noema-current-project project) noema-capability--cache)
             :resolution))

(defun noema-capability-invalidate (&optional project)
  "Invalidate PROJECT, including any outstanding stale response."
  (when-let* ((root (noema-current-project project)))
    (remhash root noema-capability--cache)))

(defun noema-capability--after-write (root callback result error-object)
  "Invalidate ROOT after a write, then deliver RESULT and ERROR-OBJECT."
  (unless error-object
    (if (eq root :global)
        (clrhash noema-capability--cache)
      (noema-capability-invalidate root))
    (when-let* ((resolution (noema--value result "capabilities")))
      (puthash root (list :resolution resolution :time (float-time)) noema-capability--cache)
      (run-hook-with-args 'noema-capability-changed-hook root)))
  (when callback (funcall callback result error-object)))

(defun noema-capability-refresh (&optional project force)
  "Refresh PROJECT asynchronously when stale, or unconditionally with FORCE."
  (when-let* ((root (noema-current-project project)))
    (let ((entry (gethash root noema-capability--cache)))
      (when (or force (and (not (plist-get entry :pending))
                          (> (- (float-time) (or (plist-get entry :time) 0)) 30)))
        (noema-capability-list :project root :callback #'ignore)))))

(defun noema-capability--saved ()
  "Invalidate cached resolutions when a capability source is saved."
  (when (and buffer-file-name
             (or (equal (file-name-nondirectory buffer-file-name) "SKILL.md")
                 (string-match-p "/\\.agents/skill-patches/.*\\.patch\\'" buffer-file-name)
                 (string-match-p "capabilities\\.json\\'" buffer-file-name)
                 (seq-some
                  (lambda (entry)
                    (seq-some (lambda (scope)
                                (let ((source (noema--value scope "source")))
                                  (and source (not (string-prefix-p "builtin:" source))
                                       (equal (file-truename buffer-file-name)
                                              (file-truename source)))))
                              (noema--sequence (noema--value (plist-get entry :resolution) "scopes"))))
                  (hash-table-values noema-capability--cache))))
    (clrhash noema-capability--cache)))

(add-hook 'after-save-hook #'noema-capability--saved)

(defun noema--value (object key &optional default)
  "Return KEY from JSON-like OBJECT, or DEFAULT."
  (let* ((name (if (symbolp key) (symbol-name key) key))
         (symbol (and (stringp name) (intern-soft name)))
         (missing (make-symbol "noema-missing"))
         (value
          (cond
           ((hash-table-p object) (gethash name object missing))
           ((listp object)
            (let ((entry (or (assoc name object) (and symbol (assq symbol object)))))
              (if entry (cdr entry) missing)))
           (t missing))))
    (if (eq value missing) default value)))

(defun noema--sequence (value)
  "Return sequence VALUE as a list."
  (cond ((vectorp value) (append value nil))
        ((listp value) value)
        (t nil)))

(defun noema--capability-type (type)
  "Normalize capability TYPE to `skill', `mcp' or `pack' wire text."
  (let ((name (string-remove-prefix ":" (format "%s" type))))
    (if (member name '("skill" "mcp" "pack"))
        name
      (user-error "Noema capability type must be skill, mcp or pack: %S" type))))

(defun noema--project-context-path (context)
  "Return a local path represented by CONTEXT."
  (cond
   ((bufferp context)
    (with-current-buffer context (or buffer-file-name default-directory)))
   ((stringp context) context)
   ((null context) (or buffer-file-name default-directory))
   (t (user-error "Noema project context must be a buffer or path: %S" context))))

;;;###autoload
(defun noema-current-project (&optional context)
  "Return the Noema project root for CONTEXT.
CONTEXT may be a buffer or path and defaults to the current buffer.  This is a
query and does not create a project or runtime state."
  (noema-project-root (noema--project-context-path context)))







;;;###autoload
(defun noema-node-id (node)
  "Return the stable identity represented by WorkNode NODE or an id string."
  (cond ((stringp node) node)
        ((hash-table-p node) (noema-research-work-node-id node))
        (t nil)))

;;;###autoload
(defun noema-node-children (node &optional type document)
  "Return NODE's child WorkNodes for relation TYPE in DOCUMENT.
TYPE defaults to `lineage'.  This is a side-effect-free query."
  (let* ((document document)
         (id (noema-node-id node))
         (type (or type "lineage")))
    (unless document (user-error "No Noema WorkDocument context"))
    (unless id (user-error "No WorkNode identity"))
    (delq nil (mapcar (lambda (child) (noema-research-find-work-node document child))
                      (noema-research-relation-children document id type)))))

;;;###autoload
(defun noema-node-parents (node &optional type document)
  "Return NODE's parent WorkNodes for relation TYPE in DOCUMENT.
TYPE defaults to `lineage'.  This is a side-effect-free query."
  (let* ((document document)
         (id (noema-node-id node))
         (type (or type "lineage")))
    (unless document (user-error "No Noema WorkDocument context"))
    (unless id (user-error "No WorkNode identity"))
    (delq nil (mapcar (lambda (parent) (noema-research-find-work-node document parent))
                      (noema-research-relation-parents document id type)))))























;;;###autoload
(defun noema-agent-cancel (run-id)
  "Request cancellation of active durable RUN-ID."
  (unless (fboundp 'noema-agent-worker-cancel-run) (require 'noema-agent-worker))
  (noema-agent-worker-cancel-run run-id))



(defun noema--host-call-now (channel body callback &optional timeout)
  "Call host CHANNEL with BODY and CALLBACK after readiness was checked.
TIMEOUT defaults to 30 seconds."
  (if (and (bound-and-true-p +noema--ready) (fboundp '+noema-api-call))
      (+noema-api-call channel (vector body) callback (or timeout 30))
    (funcall callback nil '((code . "offline")
                            (message . "Noema web-host is not ready")))))

(defun noema--host-call (channel body callback &optional timeout)
  "Call semantic host CHANNEL with BODY and CALLBACK.
CALLBACK receives (RESULT ERROR).  Starting the local host is the only effect
performed before the requested query or mutation.  TIMEOUT, in seconds, is
for channels that do network work, such as upstream Skill fetches."
  (unless (functionp callback) (user-error "Noema async API requires a callback"))
  ;; Dedicated global channels fail closed on an older host which would
  ;; otherwise ignore scope and fall back to its default project for writes.
  (when (and (string-prefix-p "noema:api:research:capability:" channel)
             (not (string-prefix-p "noema:api:research:capability:global:" channel))
             (equal (alist-get 'scope body) "global"))
    (setq channel (replace-regexp-in-string ":capability:" ":capability:global:" channel t t)))
  (if (and (fboundp '+noema--ensure-server)
           (not (bound-and-true-p +noema--ready)))
      (+noema--ensure-server
       (lambda () (apply #'noema--host-call-now channel body callback (and timeout (list timeout)))))
    (apply #'noema--host-call-now channel body callback (and timeout (list timeout)))))

(defun noema-capability--target (project scope)
  "Return the cache/request identity for PROJECT and SCOPE.
Global queries must not consult the current directory or discover a project."
  (cond ((member scope '(global "global")) :global)
        ((member scope '(nil project "project"))
         (or (noema-current-project project) (user-error "No Noema project context")))
        (t (user-error "Invalid capability scope: %S" scope))))

(defun noema-capability--body (target &optional fields)
  "Build a scope-safe request for TARGET with additional FIELDS."
  (cons (if (eq target :global) '(scope . "global") (cons 'cwd target)) fields))

;;;###autoload
(cl-defun noema-capability-list (&key project scope requested-skills requested-packs callback)
  "Resolve PROJECT's effective Skills, packs and MCPs, then call CALLBACK.
REQUESTED-SKILLS and REQUESTED-PACKS model per-task selections without
persisting them or changing the editor cache.  CALLBACK receives the
resolution object and an error object.  SCOPE `global' excludes projects."
  (let* ((root (noema-capability--target project scope))
         ;; Run-specific selections must never contaminate editor candidates.
         (entry (unless (or requested-skills requested-packs)
                  (list :pending t :time (float-time) :error nil
                        :resolution (plist-get (gethash root noema-capability--cache) :resolution)))))
    (when entry (puthash root entry noema-capability--cache))
    (let ((finish
     (lambda (result error-object)
       (let ((resolution (and result (noema--value result "capabilities"))))
         (when resolution (setq noema-capability--last-resolution resolution))
         (when (and entry (eq entry (gethash root noema-capability--cache)))
           (setf (plist-get entry :pending) nil
                 (plist-get entry :time) (float-time)
                 (plist-get entry :error) error-object
                 (plist-get entry :resolution) (and (not error-object) resolution))
           (run-hook-with-args 'noema-capability-changed-hook root))
         (funcall callback resolution error-object)))))
      (condition-case err
          (noema--host-call "noema:api:research:capability:list"
                           (noema-capability--body root `((requestedSkills . ,(vconcat requested-skills))
                                                         (requestedPacks . ,(vconcat requested-packs)))) finish)
        (error (funcall finish nil `((message . ,(error-message-string err)))))))))

;;;###autoload
(cl-defun noema-skill-list (&key project scope callback)
  "Resolve PROJECT and call CALLBACK with its Skill records and any error."
  (noema-capability-list
   :project project :scope scope
   :callback (lambda (resolution error-object)
               (funcall callback (and resolution (noema--sequence
                                                  (noema--value resolution "skills")))
                        error-object))))

;;;###autoload
(cl-defun noema-mcp-list (&key project scope callback)
  "Resolve PROJECT and call CALLBACK with its MCP records and any error."
  (noema-capability-list
   :project project :scope scope
   :callback (lambda (resolution error-object)
               (funcall callback (and resolution (noema--sequence
                                                  (noema--value resolution "mcps")))
                        error-object))))

;;;###autoload
(cl-defun noema-capability-config (&key project scope callback)
  "Read PROJECT's canonical capability configuration and call CALLBACK.
The callback receives the configuration record and an error object.  This is
a query; an absent project file is represented by the default empty model."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call
     "noema:api:research:capability:config" (noema-capability--body root)
     (lambda (result error-object)
       (funcall callback (and result (noema--value result "capabilityConfig"))
                error-object)))))

;;;###autoload
(cl-defun noema-capability-resolve (type id &key project scope requested-skills callback)
  "Resolve one capability TYPE/ID for PROJECT and call CALLBACK.
REQUESTED-SKILLS applies only to Skill resolution and models `@@skill'.  The
callback receives the effective record (or nil) and an error object."
  (noema-capability-list
   :project project :scope scope :requested-skills requested-skills
   :callback
   (lambda (resolution error-object)
     (let* ((collection (if (equal (noema--capability-type type) "mcp") "mcps" "skills"))
            (record (and resolution
                         (seq-find (lambda (item) (equal (noema--value item "id") id))
                                   (noema--sequence (noema--value resolution collection))))))
       (funcall callback record error-object)))))

;;;###autoload
(defun noema-capability-active (resolution &optional type)
  "Return active capability ids from RESOLUTION.
With TYPE `skill' or `mcp', return only that list.  Without TYPE, return a
plist containing both `:skills' and `:mcps'."
  (let* ((active (noema--value resolution "active"))
         (skills (noema--sequence (noema--value active "skills")))
         (mcps (noema--sequence (noema--value active "mcps"))))
    (pcase (and type (noema--capability-type type))
      ("skill" skills)
      ("mcp" mcps)
      (_ (list :skills skills :mcps mcps)))))

;;;###autoload
(cl-defun noema-capability-set-enabled (type id enabled &key project scope callback)
  "Set capability TYPE and ID to ENABLED for PROJECT.
This mutates `noema-capabilities.json' through the semantic host API and calls
CALLBACK with the host result and error object."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call
     "noema:api:research:capability:mutate"
     (noema-capability--body root `((type . ,(noema--capability-type type)) (id . ,id)
                                   (enabled . ,(if enabled t :false))))
     (apply-partially #'noema-capability--after-write root callback))))

;;;###autoload
(cl-defun noema-capability-set-patch (type id patch &key project scope callback)
  "Set capability TYPE/ID's project PATCH and call CALLBACK.
PATCH is a JSON-like merge-patch object; nil removes the patch from PROJECT."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call
     "noema:api:research:capability:mutate"
     (noema-capability--body root `((type . ,(noema--capability-type type)) (id . ,id)
                                   (patch . ,(or patch :null))))
     (apply-partially #'noema-capability--after-write root callback))))

;;;###autoload
(cl-defun noema-mcp-register (id definition &key project scope enabled callback)
  "Register MCP ID with DEFINITION in PROJECT.
When ENABLED is non-nil, also select it.  CALLBACK receives the host result and
error object.  This is a persistent mutation."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call
     "noema:api:research:capability:mutate"
     (noema-capability--body root `((type . "mcp") (id . ,id) (definition . ,definition)
                                   ,@(when enabled '((enabled . t)))))
     (apply-partially #'noema-capability--after-write root callback))))

(cl-defun noema-skill-install (&key project scope id description source-directory callback)
  "Create or import a Skill in SCOPE, preserving existing directories."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call
     "noema:api:research:capability:skill:install"
     (noema-capability--body root `((id . ,(or id "")) (description . ,(or description ""))
                                   (sourceDirectory . ,(or source-directory ""))))
     (apply-partially #'noema-capability--after-write root callback))))

(cl-defun noema-skill-prepare (id operation &key project callback)
  "Create a project patch or independent local copy of global Skill ID.
OPERATION is `patch' or `copy'.  Never writes the global source."
  (let ((root (noema-capability--target project 'project)))
    (unless (member operation '("patch" "copy")) (user-error "Use patch or copy"))
    (noema--host-call "noema:api:research:capability:skill:prepare"
                     `((cwd . ,root) (id . ,id) (operation . ,operation))
                     (apply-partially #'noema-capability--after-write root callback))))

;;;###autoload
(cl-defun noema-pack-define (id definition &key project scope callback)
  "Define Skill pack ID with DEFINITION in SCOPE; nil DEFINITION removes it.
DEFINITION is an alist with `members' (a vector of Skill ids) and optional
`description', `title', `preamble' and `agent_catalog'.  A pack only links
Skills by id."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call
     "noema:api:research:capability:mutate"
     (noema-capability--body root `((type . "pack") (id . ,id) (definition . ,(or definition :null))))
     (apply-partially #'noema-capability--after-write root callback))))

(defconst noema-skill-upstream-timeout 180
  "Seconds allowed for an upstream Skill fetch through the host.")

;;;###autoload
(cl-defun noema-skill-upstream-status (&key check callback)
  "Report locked global Skills; with CHECK, also query their upstreams.
CALLBACK receives the status object and an error object."
  (noema--host-call
   "noema:api:research:capability:global:skill:upstream:status"
   `((scope . "global") (check . ,(if check t :false)))
   (lambda (result error-object)
     (funcall callback (and result (noema--value result "upstream")) error-object))
   (and check noema-skill-upstream-timeout)))

;;;###autoload
(cl-defun noema-skill-upstream-install (repository &key path ref license callback)
  "Install a global Skill from REPOSITORY at PATH and REF, and lock it."
  (noema--host-call
   "noema:api:research:capability:global:skill:upstream:install"
   `((scope . "global") (repository . ,repository) (path . ,(or path "."))
     (ref . ,(or ref "HEAD")) (license . ,(or license "")))
   (apply-partially #'noema-capability--after-write :global callback)
   noema-skill-upstream-timeout))

;;;###autoload
(cl-defun noema-skill-upstream-update (id &key commit force dry-run callback)
  "Move locked global Skill ID to its upstream head, or to COMMIT.
With DRY-RUN, only report the diff.  FORCE discards local edits."
  (noema--host-call
   "noema:api:research:capability:global:skill:upstream:update"
   `((scope . "global") (id . ,id) ,@(when commit `((commit . ,commit)))
     (force . ,(if force t :false)) (dryRun . ,(if dry-run t :false)))
   (if dry-run callback
     (apply-partially #'noema-capability--after-write :global callback))
   noema-skill-upstream-timeout))

(defun noema-capability-cached-skill-ids (&optional project)
  "Return selectable Skill ids from PROJECT's authoritative resolution."
  (mapcar (lambda (skill) (noema--value skill "id"))
          (seq-filter (lambda (skill) (eq t (noema--value skill "selectable")))
                      (noema--sequence (noema--value (noema-capability-cached project) "skills")))))

(cl-defun noema-mcp-probe (id &key project scope callback)
  "Test PROJECT's resolved MCP ID and list its tools in a temporary session."
  (let ((root (noema-capability--target project scope)))
    (noema--host-call "noema:api:research:capability:probe"
                     (noema-capability--body root `((id . ,id))) callback)))

(provide 'noema-api)
;;; noema-api.el ends here
