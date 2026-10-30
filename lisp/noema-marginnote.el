;;; noema-marginnote.el --- MarginNote digitization tasks -*- lexical-binding: t; -*-

;;; Commentary:
;; `noema-marginnote-sync' runs a MarginNote task in a pinned agent session
;; of its own.  The digitization workflow and its scripts live with the
;; Skill, not here.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'json)
(require 'noema-api)

(declare-function noema-agent-acp-config-for "noema-agent-acp" (agent))
(declare-function noema-agent-acp-pinned-config "noema-agent-acp" (config model-id effort))
(declare-function noema-agent-acp-start "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-subscribe "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-unsubscribe "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-export-model-id "noema-agent-acp" (model-id &optional buffer))
(declare-function noema-agent-acp-current-model-id "noema-agent-acp" (&optional buffer))
(declare-function noema-agent-acp-draft "noema-agent-acp" (buffer text))
(declare-function noema-agent-acp-prompt "noema-agent-acp" (&rest args))
(declare-function noema-agent-acp-show-buffer "noema-agent-acp" (buffer))

(defconst noema-marginnote-pack-id "marginnote-digitize"
  "Managed pack mounted by MarginNote sync sessions.")

(defun noema-marginnote--record (id records)
  "Find ID in JSON RECORDS."
  (seq-find (lambda (record)
              (or (equal id (noema--value record "id"))
                  (member id (noema--sequence (noema--value record "aliases")))))
            (noema--sequence records)))

(defun noema-marginnote--pack-context (resolution directory)
  "Return (GUIDANCE . FILES) for the effective pack in RESOLUTION.
Resolve source and patch resources against DIRECTORY.  Keep Skill source
locations so agents can read their relative scripts and references, and
name the Noema syntax document rather than inlining it."
  (let* ((pack (noema-marginnote--record
                noema-marginnote-pack-id (noema--value resolution "packs")))
         (members (copy-sequence (noema--sequence (noema--value pack "members"))))
         (guidance (list (format "Use Noema pack %s. Read and follow its member Skill files; resolve each Skill's relative resources from its source directory."
                                 noema-marginnote-pack-id)))
         seen files)
    (unless (and pack (eq t (noema--value pack "selectable")) members)
      (user-error "Pack %s is missing, disabled or invalid; inspect Skill Manager"
                  noema-marginnote-pack-id))
    (when-let* ((preamble (noema--value (noema--value pack "effective") "preamble")))
      (unless (string-empty-p preamble) (push preamble guidance)))
    (while members
      (let ((member (pop members)))
	(let* ((id (noema--value member "id"))
               (skill (noema-marginnote--record id (noema--value resolution "skills")))
               (path (noema--value (noema--value skill "source") "path")))
          (unless (and (equal (noema--value member "state") "available")
                       (eq t (noema--value skill "selectable"))
                       (stringp path) (not (string-prefix-p "builtin:" path)))
            (user-error "Pack member %s is unavailable; inspect Skill Manager" id))
          (unless (member id seen)
            (push id seen)
            (dolist (required (noema--sequence
                               (noema--value (noema--value skill "effective") "requires")))
              (setq members (append members (list `((id . ,required) (state . "available"))))))
            (push (expand-file-name path directory) files)
            (push (format "Skill %s: %S" id (car files)) guidance)
            ;; Native sessions read references rather than frozen RunSpec content.
            ;; Supply scoped deltas too, so a manager patch is not silently ignored.
            (dolist (patch (noema--sequence (noema--value skill "patches")))
              (let* ((source (noema--value patch "source"))
                     (base (file-name-directory (expand-file-name source directory)))
                     (delta (noema--value patch "patch")))
		(push (format "Apply this effective Noema patch to Skill %s (relative files use %S): %s"
                              id base (json-encode delta)) guidance)
		(dolist (key '("patch_file" "content_file"))
		  (when-let* ((file (noema--value delta key)))
                    (push (expand-file-name file base) files)))))))))
    (when (member "noema-authoring-syntax" seen)
      (let ((syntax (expand-file-name "docs/noema/design/syntax.md"
                                      user-emacs-directory)))
        (push syntax files)
        (push (format "Before writing, load the current authoritative Noema syntax from %S."
                      syntax)
              guidance)))
    (cons (mapconcat #'identity (nreverse guidance) "\n\n")
          (delete-dups (nreverse files)))))

;;; Sync: a session of its own

(defgroup noema-marginnote nil
  "MarginNote handwriting to Noema Markdown."
  :group 'noema)

(defcustom noema-marginnote-sync-agent "codex"
  "Agent that runs `noema-marginnote-sync' sessions."
  :type 'string)

(defcustom noema-marginnote-sync-model "gpt-6.1-terra"
  "Model pinned for `noema-marginnote-sync' sessions; empty keeps the agent's.
The pin never becomes the remembered model of ordinary sessions."
  :type 'string)

(defcustom noema-marginnote-sync-effort "high"
  "Reasoning effort pinned for ordinary `noema-marginnote-sync' sessions.
Dense derivations take `noema-marginnote-sync-dense-effort', chosen with a
prefix argument when the task starts."
  :type 'string)

(defcustom noema-marginnote-sync-dense-effort "xhigh"
  "Reasoning effort offered first for dense derivations."
  :type 'string)

(defconst noema-marginnote-sync-efforts '("low" "medium" "high" "xhigh" "max")
  "Reasoning efforts a sync session may be pinned to.")

(defcustom noema-marginnote-work-root (locate-user-emacs-file "var/noema/marginnote/")
  "Directory holding the intermediate products of MarginNote sync tasks.
Each native source gets a subdirectory: exported PDFs, crops, OCR candidates,
page drafts and workflow.json.  Only the Markdown goes to the target, and
the images it shows to the note's own images/<note stem>/ folder."
  :type 'directory)

(defconst noema-marginnote-sync-modes
  '(("new" . "Write a new note at the target; never overwrite an existing file.")
    ("update" . "Update only the target's passages that come from the requested source range; keep every other passage and manual edit.")
    ("append" . "Append the new transcription at the end of the target; leave the existing text unchanged.")
    ("replace" . "Replace the target's whole body with the new transcription; the person has authorized discarding its current text.")
    ("merge" . "Merge the new transcription into the target following the Skill's merge flow; the person has authorized this merge."))
  "How a sync writes its result to the target, with the instruction given.")

(defvar noema-marginnote-sync-prompt-history nil)

(defun noema-marginnote--sync-task (prompt target mode)
  "Return the task text for PROMPT written to TARGET in MODE."
  (concat
   (format "MarginNote sync task. Keep every intermediate product (official export PDFs, page renders, crops, OCR candidates, page drafts, workflow.json and its records) under %S, in one subdirectory per native source named by its stable identity; reuse that subdirectory when it already exists. Only the final Markdown belongs at the target; the images it displays go in the target's own images/<note stem>/ folder and other linked files in attachments/<note stem>/, as the syntax document's \"A note's own files\" defines; create no other folder beside it."
           (expand-file-name noema-marginnote-work-root))
   (if target
       (format "\nTarget: %S\nWrite mode %s: %s" target mode
               (alist-get mode noema-marginnote-sync-modes nil nil #'equal))
     "\nTarget: not given; the request below names it, otherwise write a new note and report its path.")
   "\n\nRequest:\n" prompt))

(defun noema-marginnote--sync-delete-frames-h ()
  "Delete the frames opened for this sync buffer, never the last frame."
  (dolist (frame (frame-list))
    (when (and (cdr (frame-list))
               (eq (frame-parameter frame 'noema-marginnote-sync-buffer)
                   (current-buffer)))
      (delete-frame frame t))))

(defun noema-marginnote--sync-display (buffer)
  "Show sync agent BUFFER in a frame of its own, outside Agent Workspace tabs."
  (let ((window (get-buffer-window buffer t)))
    (unless (window-live-p window)
      (setq window
            (if (display-graphic-p)
                (let ((frame (make-frame '((name . "Noema MarginNote sync")
                                           (width . 110) (height . 40)))))
                  (set-frame-parameter frame 'noema-agent-standalone t)
                  (set-frame-parameter frame 'noema-marginnote-sync-buffer buffer)
                  (with-current-buffer buffer
                    (add-hook 'kill-buffer-hook #'noema-marginnote--sync-delete-frames-h
                              nil t))
                  (frame-root-window frame))
              (display-buffer-pop-up-window buffer nil))))
    (set-window-buffer window buffer)
    (select-frame-set-input-focus (window-frame window))
    (select-window window)
    window))

(defun noema-marginnote--sync-start (text &optional effort)
  "Start a pinned sync session at EFFORT and send it TEXT once it is ready.
EFFORT defaults to `noema-marginnote-sync-effort'."
  (require 'noema-agent-acp)
  (let* ((base (or (noema-agent-acp-config-for noema-marginnote-sync-agent)
                   (user-error "Agent %s is not available" noema-marginnote-sync-agent)))
         (config (noema-agent-acp-pinned-config
                  base noema-marginnote-sync-model
                  (or effort noema-marginnote-sync-effort)))
         (directory (file-name-as-directory (expand-file-name noema-marginnote-work-root)))
         (model noema-marginnote-sync-model)
         buffer subscription)
    (make-directory directory t)
    (setq buffer (noema-agent-acp-start :config config :directory directory
                                        :origin 'marginnote
                                        :display-function #'noema-marginnote--sync-display))
    (setq subscription
          (noema-agent-acp-subscribe
           :buffer buffer :event 'init-finished
           :callback
           (lambda (_event)
             (noema-agent-acp-unsubscribe :buffer buffer :subscription subscription)
             (when (buffer-live-p buffer)
               (let ((selected (and (stringp model) (not (string-empty-p model))
                                    (noema-agent-acp-export-model-id model buffer))))
                 (if (and (stringp model) (not (string-empty-p model))
                          (not (and selected
                                    (equal selected (noema-agent-acp-current-model-id buffer)))))
                     ;; Never run the task on a model the person did not pick.
                     (progn
                       (noema-agent-acp-draft buffer text)
                       (message "MarginNote sync: model %s unavailable; task left as a draft"
                                model))
                   (noema-agent-acp-prompt
                    :buffer buffer
                    :content (list `((type . "text") (text . ,text))))))))))
    (noema-agent-acp-show-buffer buffer)
    buffer))

(defun noema-marginnote--read-sync-args ()
  "Read PROMPT, TARGET, MODE and, with a prefix argument, EFFORT."
  (let* ((default (and buffer-file-name
                       (string-match-p "\\.\\(md\\|markdown\\)\\'" buffer-file-name)
                       buffer-file-name))
         (target (read-file-name "Target Markdown (empty: decided by the prompt): "
                                 nil default nil (and default (file-name-nondirectory default))))
         (target (and (not (string-empty-p (string-trim target)))
                      (not (directory-name-p target))
                      (expand-file-name target)))
         (mode (cond ((null target) nil)
                     ((not (file-exists-p target)) "new")
                     (t (completing-read "Write mode: "
                                         (remove "new" (mapcar #'car noema-marginnote-sync-modes))
                                         nil t nil nil "update"))))
         (prompt (read-string "MarginNote sync prompt: " nil
                              'noema-marginnote-sync-prompt-history)))
    (list prompt target mode
          (and current-prefix-arg
               (completing-read "Reasoning effort: " noema-marginnote-sync-efforts
                                nil t nil nil noema-marginnote-sync-dense-effort)))))

;;;###autoload
(defun noema-marginnote-sync (prompt &optional target mode effort)
  "Run PROMPT as a MarginNote sync task in a pinned agent session of its own.
TARGET is the Markdown file written, or nil when PROMPT names it; MODE is a
key of `noema-marginnote-sync-modes'.  EFFORT pins the reasoning effort,
default `noema-marginnote-sync-effort'; interactively a prefix argument
asks for it, offering `noema-marginnote-sync-dense-effort' for dense
derivations.  The session mounts the managed
`marginnote-digitize' pack, keeps its intermediate products under
`noema-marginnote-work-root' and opens in a frame of its own; its model
never changes the model of ordinary sessions."
  (interactive (noema-marginnote--read-sync-args))
  (when (string-empty-p (string-trim prompt))
    (user-error "A sync prompt is required"))
  (when (and effort (not (member effort noema-marginnote-sync-efforts)))
    (user-error "Unknown reasoning effort: %s" effort))
  (when (and target (not (assoc mode noema-marginnote-sync-modes)))
    (user-error "Unknown write mode: %s" mode))
  (when (and target (equal mode "new") (file-exists-p target))
    (user-error "Target exists; choose update, append, replace or merge"))
  (let ((directory default-directory)
        (project (noema-current-project)))
    (noema-capability-list
     :project project :scope (unless project 'global)
     :requested-packs (list noema-marginnote-pack-id)
     :callback
     (lambda (resolution error-object)
       (if error-object
           (message "MarginNote: %s" (or (noema--value error-object "message") error-object))
         (condition-case err
             (let* ((default-directory directory)
                    (context (noema-marginnote--pack-context
                              resolution (or project directory))))
               (noema-marginnote--sync-start
                (concat (car context) "\n\n"
                        (noema-marginnote--sync-task prompt target mode))
                effort))
           (error (message "MarginNote sync: %s" (error-message-string err)))))))))

(provide 'noema-marginnote)
;;; noema-marginnote.el ends here
