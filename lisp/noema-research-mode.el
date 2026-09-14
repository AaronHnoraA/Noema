;;; noema-research-mode.el --- JuText projection of research notebooks -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; JuText is the writing projection of a Noema research notebook.  Every cell
;; starts with a header line:
;;
;;   %% question Title      research question
;;   %% work Title          research work
;;   %% checkpoint Title    significant change in understanding
;;   %% Title / %%          ordinary note (`%% note Title' when ambiguous)
;;   %% code python         executable code cell
;;   %% result ...          read-only result written by a run
;;
;; Cell ids never appear in the text: they are attached to header lines as text
;; properties, so renaming a title keeps every relation.  Source lines that
;; begin with `%%' are escaped with a backslash.  Relations, state, and other
;; research metadata are edited through commands, never typed as syntax.
;;
;; Saving writes the `*.noema' directly (so editing works without the Noema host)
;; and then asks a running host to reindex; the kernel derives the semantic
;; history by diffing against its previous index.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'url-util)
(require 'noema-research)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function my/noema--host-file "init-aaronnote" (file))
(declare-function my/noema-jupyter-output-open-document
                  "init-aaronnote" (payload &optional focus))
(declare-function my/noema-jupyter-cell--api-sync
                  "init-aaronnote-jupyter-cell" (channel body &optional timeout))
(defvar my/noema--ready)

(autoload 'noema-research-graph-open "noema-research-graph" nil t)
(autoload 'noema-research-attention "noema-research-inspector" nil t)
(autoload 'noema-research-propose-with-magent "noema-research-synthesis" nil t)
(autoload 'noema-agent-worker-run-work-cell "noema-agent-worker" nil t)
(autoload 'noema-agent-worker-cancel-run "noema-agent-worker" nil t)

(defgroup noema-research nil
  "Noema research notebooks."
  :group 'tools)

(defcustom noema-research-sync-host t
  "Whether saving a research notebook asks a running Noema host to reindex."
  :type 'boolean
  :group 'noema-research)

(defcustom noema-research-jupyter-execute-timeout 86400
  "Seconds an Emacs request may wait for a `.noema' Jupyter execution."
  :type 'integer
  :group 'noema-research)

(defface noema-research-question-face
  '((t :inherit font-lock-keyword-face :weight bold))
  "Face for question headers.")

(defface noema-research-work-face
  '((t :inherit font-lock-function-name-face :weight bold))
  "Face for work headers.")

(defface noema-research-checkpoint-face
  '((t :inherit warning :weight bold))
  "Face for checkpoint headers.")

(defface noema-research-note-face
  '((t :inherit font-lock-comment-face))
  "Face for note headers.")

(defface noema-research-code-face
  '((t :inherit font-lock-constant-face))
  "Face for code cell headers.")

(defface noema-research-result-face
  '((t :inherit shadow))
  "Face for result cells.")

(defface noema-research-decoration-face
  '((t :inherit shadow :slant italic))
  "Face for header decorations.")

(defvar-local noema-research--document nil
  "Research notebook document backing the current JuText buffer.")

(defvar-local noema-research--revision nil
  "File revision the current JuText buffer was loaded from or saved as.")

(defvar-local noema-research--decoration-timer nil
  "Pending idle timer that refreshes header decorations.")

(defvar-local noema-research--kernel-status "not-started"
  "Last Jupyter kernel state received for this work document.")

(defconst noema-research--header-regexp "^%%\\(?:[ \t]+\\(.*?\\)\\)?[ \t]*$"
  "Regexp matching a JuText cell header.")

(defconst noema-research--header-words
  '("question" "work" "checkpoint" "result" "code" "note")
  "Words with a structural meaning at the start of a header.")

(defconst noema-research--font-lock-keywords
  '(("^%%[ \t]+question\\_>.*$" . 'noema-research-question-face)
    ("^%%[ \t]+work\\_>.*$" . 'noema-research-work-face)
    ("^%%[ \t]+checkpoint\\_>.*$" . 'noema-research-checkpoint-face)
    ("^%%[ \t]+result\\_>.*$" . 'noema-research-result-face)
    ("^%%[ \t]+code\\_>.*$" . 'noema-research-code-face)
    ("^%%\\(?:[ \t].*\\)?$" . 'noema-research-note-face))
  "Font lock keywords for JuText headers.")

;;;; Projection

(defun noema-research--escape-source (source)
  "Escape SOURCE lines that would read as JuText headers."
  (replace-regexp-in-string "^\\(\\\\*%%\\)" "\\\\\\1" source))

(defun noema-research--unescape-source (text)
  "Undo `noema-research--escape-source' on TEXT."
  (replace-regexp-in-string "^\\\\\\(\\\\*%%\\)" "\\1" text))

(defun noema-research--notebook-language (document)
  "Return DOCUMENT's kernel language."
  (or (noema-research--string
       (noema-research--get (noema-research--get (noema-research--get document "metadata")
                                                 "kernelspec")
                            "language"))
      "python"))

(defun noema-research--header-text (cell document)
  "Return the JuText header line for CELL in DOCUMENT."
  (let ((kind (noema-research-cell-kind cell document))
        (title (noema-research-cell-title cell document)))
    (pcase kind
      ("code" (concat "%% code " (noema-research--notebook-language document)))
      ("note"
       (cond
        ((string-empty-p title) "%%")
        ((member (car (split-string title "[ \t]+" t)) noema-research--header-words)
         (concat "%% note " title))
        (t (concat "%% " title))))
      ("result"
       (let ((target (noema-research-primary-cell
                      document (noema-research-cell-work-node-id cell))))
         (string-trim-right
          (concat "%% result " (if target (noema-research-cell-label target document) "")))))
      (_ (string-trim-right (concat "%% " kind " " title))))))

(defun noema-research--parse-header (text)
  "Return (KIND . TITLE) for header TEXT."
  (let* ((text (string-trim text))
         (word (car (split-string text "[ \t]+" t))))
    (if (member word noema-research--header-words)
        (cons word (string-trim (substring text (length word))))
      (cons "note" text))))

(defun noema-research--render (document)
  "Replace the current buffer with the JuText projection of DOCUMENT."
  (let ((inhibit-read-only t)
        (first t))
    (erase-buffer)
    (dolist (cell (noema-research-cells document))
      (unless first (insert "\n"))
      (setq first nil)
      (let ((start (point))
            (source (noema-research-cell-source cell)))
        (insert (noema-research--header-text cell document))
        (put-text-property start (point) 'noema-research-id
                           (noema-research-cell-id cell))
        (when-let* ((work-node-id (noema-research-cell-work-node-id cell)))
          (put-text-property start (point) 'noema-research-work-node-id work-node-id))
        (insert "\n")
        (unless (string-empty-p source)
          (insert (noema-research--escape-source source) "\n"))
        (when (equal (noema-research-cell-kind cell document) "result")
          (add-text-properties
           start (point)
           '(read-only "Result cells are written by runs"
                       rear-nonsticky (read-only)
                       face noema-research-result-face))))))
  (goto-char (point-min)))

(defun noema-research--line-property (beg end property)
  "Return the first non-nil PROPERTY between BEG and END."
  (let ((position beg)
        value)
    (while (and (< position end) (not value))
      (setq value (get-text-property position property)
            position (next-single-property-change position property nil end)))
    value))

(defun noema-research--scan ()
  "Return the cell entries of the current JuText buffer, in order.
Each entry is a plist with :header-beg, :header-end, :block-end, :text, :id,
:work-node-id, :lineage and :body."
  (save-excursion
    (save-restriction
      (widen)
      (goto-char (point-min))
      (let (headers entries)
        (while (re-search-forward noema-research--header-regexp nil t)
          (push (list (match-beginning 0) (match-end 0)
                      (or (match-string-no-properties 1) ""))
                headers))
        (setq headers (nreverse headers))
        (while headers
          (pcase-let* ((`(,beg ,end ,text) (car headers))
                       (block-end (if (cdr headers) (car (cadr headers)) (point-max)))
                       (body-beg (min block-end (1+ end))))
            (push (list :header-beg beg
                        :header-end end
                        :block-end block-end
                        :text text
                        :id (noema-research--line-property beg end 'noema-research-id)
                        :work-node-id (noema-research--line-property
                                       beg end 'noema-research-work-node-id)
                        :lineage (noema-research--line-property
                                  beg end 'noema-research-lineage)
                        :body (noema-research--unescape-source
                               (string-trim-right
                                (buffer-substring-no-properties body-beg block-end)
                                "\n+")))
                  entries))
          (setq headers (cdr headers)))
        (nreverse entries)))))

(defun noema-research--ensure-leading-header ()
  "Give text before the first header its own note header."
  (save-excursion
    (save-restriction
      (widen)
      (goto-char (point-min))
      (let ((first (save-excursion
                     (and (re-search-forward noema-research--header-regexp nil t)
                          (match-beginning 0)))))
        (when (string-match-p "[^ \t\n]"
                              (buffer-substring-no-properties
                               (point-min) (or first (point-max))))
          (let ((inhibit-read-only t))
            (insert "%%\n")))))))

(defun noema-research--apply-kind (document cell kind title &optional work-node-id)
  "Make CELL a KIND cell in DOCUMENT while preserving unrelated content."
  (if (equal kind "code")
      (unless (equal (gethash "cell_type" cell) "code")
        (puthash "cell_type" "code" cell)
        (puthash "execution_count" :null cell)
        (puthash "outputs" [] cell)
        (remhash "attachments" cell))
    (when (equal (gethash "cell_type" cell) "code")
      (puthash "cell_type" "markdown" cell)
      (remhash "execution_count" cell)
      (remhash "outputs" cell)))
  (if (member kind noema-research-graph-kinds)
      (progn
        (noema-research-cell-set cell "kind" nil)
        (noema-research-cell-set cell "title" nil)
        (noema-research-bind-cell document cell kind title work-node-id))
    (if (equal kind "code")
        (noema-research-cell-set cell "work_node_id" work-node-id)
      (noema-research-cell-set cell "work_node_id" nil))
    (noema-research-cell-set cell "kind" nil)
    (noema-research-cell-set cell "title" (unless (equal kind "code") title))))

(defun noema-research-mode--sync ()
  "Merge the JuText buffer into `noema-research--document' and return it.
New headers receive stable cell ids that are attached to their header lines;
copied headers are given new ids; cells whose headers disappeared are removed
together with every relation that referenced them."
  (noema-research--ensure-leading-header)
  (let ((document noema-research--document)
        (old (make-hash-table :test #'equal))
        (taken (make-hash-table :test #'equal))
        (seen (make-hash-table :test #'equal))
        (seen-nodes (make-hash-table :test #'equal))
        cells assignments removed removed-node-candidates context-node)
    (dolist (cell (noema-research-cells document))
      (puthash (noema-research-cell-id cell) cell old)
      (puthash (noema-research-cell-id cell) t taken))
    (dolist (entry (noema-research--scan))
      (let* ((parsed (noema-research--parse-header (plist-get entry :text)))
             (kind (car parsed))
             (title (cdr parsed))
             (claimed (plist-get entry :id))
             (existing (and claimed (not (gethash claimed seen))
                            (gethash claimed old)))
             (claimed-node (or (and existing (noema-research-cell-work-node-id existing))
                               (plist-get entry :work-node-id)
                               (and (equal kind "code") (not existing) context-node)))
             (reusable-node (and claimed-node
                                 (or (equal kind "code")
                                     (not (gethash claimed-node seen-nodes)))
                                 (noema-research-find-work-node document claimed-node)
                                 claimed-node))
             (cell (or existing
                       (noema-research--table
                        "cell_type" "markdown"
                        "id" (noema-research-new-cell-id taken)
                        "metadata" (make-hash-table :test #'equal)
                        "source" ""))))
        (cond
         ((and existing (equal (noema-research-cell-kind existing document) "result"))
          (setq kind "result"))
         ((equal kind "result")
          (setq kind "note")))
        (unless (equal kind "result")
          (noema-research--apply-kind document cell kind title reusable-node)
          (puthash "source" (plist-get entry :body) cell)
          (when (and (not existing) (plist-get entry :lineage)
                     (member kind noema-research-graph-kinds))
            (noema-research-set-relation
             document (noema-research-cell-work-node-id cell) "lineage"
             (list (plist-get entry :lineage)))))
        (puthash (noema-research-cell-id cell) t seen)
        (when-let* ((work-node-id (noema-research-cell-work-node-id cell)))
          (setq context-node work-node-id)
          (unless (equal kind "code")
            (puthash work-node-id t seen-nodes)))
        (push cell cells)
        (push (list (plist-get entry :header-beg) (plist-get entry :header-end)
                    (noema-research-cell-id cell)
                    (noema-research-cell-work-node-id cell))
              assignments)))
    (maphash (lambda (id cell)
               (unless (gethash id seen)
                 (push id removed)
                 (when-let* ((work-node-id (noema-research-cell-work-node-id cell)))
                   (push work-node-id removed-node-candidates))))
             old)
    (puthash "cells" (vconcat (nreverse cells)) document)
    (dolist (work-node-id (delete-dups removed-node-candidates))
      (unless (seq-some
               (lambda (cell)
                 (and (equal (noema-research-cell-work-node-id cell) work-node-id)
                      (not (equal (noema-research-cell-field cell "kind") "result"))))
               (noema-research-cells document))
        (noema-research-delete-work-node document work-node-id t)))
    (with-silent-modifications
      (let ((inhibit-read-only t))
        (dolist (assignment assignments)
          (pcase-let ((`(,beg ,end ,id ,work-node-id) assignment))
            (put-text-property beg end 'noema-research-id id)
            (if work-node-id
                (put-text-property beg end 'noema-research-work-node-id work-node-id)
              (remove-text-properties beg end '(noema-research-work-node-id nil)))
            (remove-text-properties beg end '(noema-research-lineage nil))))))
    document))

;;;; Decorations

(defun noema-research--decoration (cell)
  "Return the header decoration string for CELL."
  (if (null cell)
      "  · new"
    (let* ((kind (noema-research-cell-kind cell noema-research--document))
           (lineage (length (noema-research-cell-relation cell "lineage" noema-research--document)))
           (depends (length (noema-research-cell-relation cell "depends" noema-research--document)))
           (parts (delq nil (list (noema-research-cell-state cell noema-research--document)
                                  (noema-research-cell-outcome cell noema-research--document)
                                  (and (> lineage 0) (format "↑%d" lineage))
                                  (and (> depends 0) (format "⇠%d" depends))))))
      (cond
       ((member kind '("note" "code" "result")) nil)
       (parts (concat "  · " (string-join parts " · ")))))))

(defun noema-research-mode--refresh-decorations ()
  "Refresh the header decorations of the current JuText buffer."
  (when noema-research--document
    (remove-overlays (point-min) (point-max) 'noema-research-decoration t)
    (dolist (entry (noema-research--scan))
      (let* ((id (plist-get entry :id))
             (cell (noema-research-find-cell noema-research--document id))
             (text (noema-research--decoration cell)))
        (when text
          (let ((overlay (make-overlay (plist-get entry :header-end)
                                       (plist-get entry :header-end))))
            (overlay-put overlay 'noema-research-decoration t)
            (overlay-put overlay 'after-string
                         (propertize text 'face 'noema-research-decoration-face))))))))

(defun noema-research--schedule-decorations (&rest _)
  "Refresh decorations once Emacs is idle."
  (unless noema-research--decoration-timer
    (let ((buffer (current-buffer)))
      (setq noema-research--decoration-timer
            (run-with-idle-timer
             0.3 nil
             (lambda ()
               (when (buffer-live-p buffer)
                 (with-current-buffer buffer
                   (setq noema-research--decoration-timer nil)
                   (noema-research-mode--refresh-decorations)))))))))

;;;; Loading and saving

(defun noema-research--load (document revision)
  "Render DOCUMENT loaded at REVISION into the current buffer."
  (setq noema-research--document document
        noema-research--revision revision)
  (let ((buffer-undo-list t))
    (noema-research--render document))
  (setq buffer-undo-list nil)
  (set-buffer-modified-p nil)
  (noema-research-mode--refresh-decorations))

(defun noema-research-notify-host (file reason)
  "Ask a running Noema host to reindex FILE because of REASON."
  (when (and noema-research-sync-host file
             (fboundp 'my/noema-api-call)
             (bound-and-true-p my/noema--ready))
    (my/noema-api-call
     "aaronnote:api:research:notebook:sync"
     (vector (noema-research--table "file" (expand-file-name file)
                                    "actor" "emacs"
                                    "reason" reason))
     (lambda (_result error-object)
       (when error-object
         (message "Noema research index sync failed: %s"
                  (or (and (hash-table-p error-object)
                           (gethash "message" error-object))
                      (and (listp error-object)
                           (alist-get 'message error-object))
                      "request failed")))))))

(defun noema-research-mode--write-contents ()
  "Write the research notebook for `write-contents-functions'."
  (let ((document (noema-research-mode--sync)))
    (setq noema-research--revision
          (condition-case nil
              (noema-research-write-file buffer-file-name document
                                         noema-research--revision)
            (noema-research-revision-conflict
             (unless (yes-or-no-p
                      "Research notebook changed on disk; overwrite it? ")
               (user-error "Save cancelled; revert to load the external change"))
             (noema-research-write-file buffer-file-name document))))
    (set-visited-file-modtime)
    (set-buffer-modified-p nil)
    (noema-research-mode--refresh-decorations)
    (noema-research-notify-host buffer-file-name "jutext.save")
    t))

(defun noema-research--revert (_ignore-auto noconfirm)
  "Reload the research notebook from disk.
NOCONFIRM has the meaning documented by `revert-buffer'."
  (when (and (buffer-modified-p) (not noconfirm)
             (not (yes-or-no-p "Discard unsaved research notebook changes? ")))
    (user-error "Revert cancelled"))
  (let ((line (line-number-at-pos)))
    (run-hooks 'before-revert-hook)
    (noema-research--load (noema-research-read-file buffer-file-name)
                          (noema-research-file-revision buffer-file-name))
    (goto-char (point-min))
    (forward-line (1- line))
    (set-visited-file-modtime)
    (run-hooks 'after-revert-hook)
    t))

;;;; Jupyter execution and rich output

(defun noema-research--jupyter-session (document)
  "Return the Jupyter session name recorded by DOCUMENT."
  (or (noema-research--string
       (noema-research--get
        (noema-research--get (noema-research--get document "metadata") "noema")
        "session"))
      "default"))

(defun noema-research--jupyter-kernel (document)
  "Return the Jupyter kernelspec name recorded by DOCUMENT."
  (or (noema-research--string
       (noema-research--get
        (noema-research--get (noema-research--get document "metadata") "kernelspec")
        "name"))
      "python3"))

(defun noema-research--jupyter-context (&optional require-code)
  "Return the Jupyter context at point, optionally REQUIRE-CODE.
The JuText projection is saved first so the runtime reads the canonical
`.noema' file rather than an unsaved shadow representation."
  (unless buffer-file-name (user-error "This work document has no file"))
  (when (buffer-modified-p) (save-buffer))
  (let* ((cell (noema-research--require-cell))
         (type (noema-research--get cell "cell_type")))
    (when (and require-code (not (equal type "code")))
      (user-error "Current Noema cell is not executable code"))
    (list :cell-id (noema-research-cell-id cell)
          :script-file (expand-file-name buffer-file-name)
          :project-root (noema-research-repository-root buffer-file-name)
          :language (noema-research--notebook-language noema-research--document)
          :kernel (noema-research--jupyter-kernel noema-research--document)
          :session (noema-research--jupyter-session noema-research--document))))

(defun noema-research--jupyter-payload (context &optional view)
  "Return browser/runtime payload for Jupyter CONTEXT and optional VIEW."
  (let* ((file (plist-get context :script-file))
         (project-root (plist-get context :project-root))
         (host-file (if (fboundp 'my/noema--host-file)
                        (my/noema--host-file file)
                      file))
         (host-root (if (fboundp 'my/noema--host-file)
                        (my/noema--host-file project-root)
                      project-root)))
    `((scriptFile . ,host-file)
      (sourceFile . ,host-file)
      (projectRoot . ,host-root)
      (cellId . ,(plist-get context :cell-id))
      (language . ,(plist-get context :language))
      (kernel . ,(plist-get context :kernel))
      (session . ,(plist-get context :session))
      ,@(when view `((view . ,view))))))

(defun noema-research-open-outputs (&optional focus)
  "Show this `.noema' document in Emacs' right-side rich-output view.
With FOCUS non-nil (interactively, with a prefix), select the output window."
  (interactive "P")
  (unless (fboundp 'my/noema-jupyter-output-open-document)
    (user-error "Noema's Jupyter output renderer is unavailable"))
  (let ((context (noema-research--jupyter-context)))
    (my/noema-jupyter-output-open-document
     (noema-research--jupyter-payload context "outputs") focus)))

(defun noema-research--jupyter-action (action success-message &optional require-code)
  "Send Jupyter ACTION for this work document and report SUCCESS-MESSAGE."
  (unless (and (fboundp 'my/noema-api-call)
               (fboundp 'my/noema--ensure-server))
    (user-error "Noema's Jupyter runtime bridge is unavailable"))
  (let* ((source-buffer (current-buffer))
         (context (noema-research--jupyter-context require-code))
         (body `((scriptFile . ,(plist-get context :script-file))
                 (sourceFile . ,(plist-get context :script-file))
                 (projectRoot . ,(plist-get context :project-root))
                 (cellId . ,(plist-get context :cell-id))
                 (language . ,(plist-get context :language))
                 (kernel . ,(plist-get context :kernel))
                 (session . ,(plist-get context :session))
                 (action . ,action))))
    (my/noema--ensure-server
     (lambda ()
       (when (buffer-live-p source-buffer)
         (with-current-buffer source-buffer
           (when (string-prefix-p "run-" action)
             ;; This is an Emacs-owned view over the execution.  It is opened
             ;; before the request so subsequent runs stream without changing
             ;; the user's current work buffer.
             (my/noema-jupyter-output-open-document
              (noema-research--jupyter-payload context "outputs") nil))
           (my/noema-api-call
            "aaronnote:api:jupyter:script-action" (vector body)
            (lambda (_result error-object)
              (if error-object
                  (message "Noema Jupyter: %s"
                           (or (and (hash-table-p error-object)
                                    (gethash "message" error-object))
                               "request failed"))
                (message "Noema Jupyter: %s" success-message)))
            noema-research-jupyter-execute-timeout)))))))

(defun noema-research-execute-current ()
  "Execute the current `.noema' Cell through its native substrate.
Code Cells use the Noema-owned Jupyter runtime.  Markdown Cells bound to a
work WorkNode become durable external-agent Runs.  Cell and WorkNode identity
remain distinct in either path."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (cell-type (noema-research--get cell "cell_type"))
         (node (noema-research-work-node-for-cell
                noema-research--document cell)))
    (cond
     ((equal cell-type "code")
      (noema-research--jupyter-action "run-current" "cell finished" t))
     ((and (equal cell-type "markdown")
           (equal (noema-research-work-node-field node "kind") "work"))
      (unless buffer-file-name
        (user-error "This Work Cell has no canonical .noema file"))
      (when (buffer-modified-p) (save-buffer))
      (let ((default-directory
             (noema-research-repository-root buffer-file-name)))
        (noema-agent-worker-run-work-cell
         (expand-file-name buffer-file-name)
         (noema-research-cell-id cell))))
     (t
      (user-error "Only code Cells and Cells bound to a work WorkNode are executable")))))

(defun noema-research-execute-all ()
  "Execute every code cell in the current `.noema' work document."
  (interactive)
  (noema-research--jupyter-action "run-all" "document finished"))

(defun noema-research-clear-current-output ()
  "Clear the current `.noema' code cell's durable Jupyter output."
  (interactive)
  (noema-research--jupyter-action "clear-output" "cell output cleared" t))

(defun noema-research-clear-all-outputs ()
  "Clear all durable Jupyter outputs in the current `.noema' document."
  (interactive)
  (noema-research--jupyter-action "clear-all-outputs" "document outputs cleared"))

(defun noema-research-interrupt ()
  "Interrupt this `.noema' document's Noema-owned Jupyter kernel."
  (interactive)
  (noema-research--jupyter-action "interrupt" "interrupt requested"))

(defun noema-research-interrupt-current ()
  "Interrupt the current Cell's execution substrate."
  (interactive)
  (if (equal (noema-research--get (noema-research--require-cell) "cell_type")
             "code")
      (noema-research-interrupt)
    (call-interactively #'noema-agent-worker-cancel-run)))

(defun noema-research-restart-kernel ()
  "Restart this `.noema' document's Noema-owned Jupyter kernel."
  (interactive)
  (noema-research--jupyter-action "restart" "kernel restarted"))

(defun noema-research-shutdown-kernel ()
  "Shut down this `.noema' document's Noema-owned Jupyter kernel."
  (interactive)
  (noema-research--jupyter-action "shutdown" "kernel shut down"))

(defun noema-research--jupyter-kernel-choices (catalog)
  "Return display/value choices from Noema Jupyter CATALOG."
  (cl-labels ((value (table key)
                (cond
                 ((hash-table-p table) (gethash key table))
                 ((listp table)
                  (or (alist-get (intern key) table)
                      (alist-get key table nil nil #'string=))))))
  (let ((entries (append (or (value catalog "selections") []) nil))
        choices)
    (dolist (entry entries (nreverse choices))
      (let* ((kind (or (noema-research--string
                        (value entry "kind")) "start"))
             (value (or (noema-research--string
                         (or (value entry "value")
                             (value entry "name"))) ""))
             (label (or (noema-research--string
                         (value entry "label"))
                        (format "%s · %s"
                                (capitalize kind)
                                (or (noema-research--string
                                     (value entry "displayName"))
                                    value)))))
        (when (or (equal kind "none") (not (string-empty-p value)))
          (push (cons label (cons kind value)) choices)))))))

(defun noema-research-select-kernel ()
  "Select or attach the Jupyter kernel for this `.noema' document in Emacs."
  (interactive)
  (unless (fboundp 'my/noema-jupyter-cell--api-sync)
    (user-error "Noema's Jupyter runtime bridge is unavailable"))
  (let* ((context (noema-research--jupyter-context))
         (file (plist-get context :script-file))
         (project-root (plist-get context :project-root))
         (catalog (my/noema-jupyter-cell--api-sync
                   "aaronnote:api:jupyter-cell:kernels"
                   `((file . ,file) (scriptFile . ,file) (sourceFile . ,file)
                     (projectRoot . ,project-root)) 30))
         (choices (noema-research--jupyter-kernel-choices catalog)))
    (unless choices (user-error "No Jupyter kernels are available"))
    (let* ((label (completing-read "Noema Jupyter kernel: " choices nil t))
           (choice (cdr (assoc label choices)))
           (kind (car choice))
           (value (cdr choice))
           (body `((scriptFile . ,file)
                   (sourceFile . ,file)
                   (projectRoot . ,project-root)
                   (kind . ,kind)
                   ,@(pcase kind
                       ("start" `((kernelSpecName . ,value)))
                       ("connect" `((kernelId . ,value))))))
           (reply (my/noema-jupyter-cell--api-sync
                   "aaronnote:api:jupyter:session-select" body 60)))
      (noema-research-accept-jupyter-runtime reply)
      (message "Noema Jupyter: %s" label))))

(defun noema-research-accept-jupyter-runtime (snapshot)
  "Merge durable Jupyter runtime state from disk after SNAPSHOT.
Only code-cell outputs and Jupyter-owned metadata are accepted.  JuText text,
WorkNodes, and dependencies remain owned by the Emacs buffer, so a live run
cannot clobber edits made while output was streaming."
  (let ((status (or (noema-research--get snapshot "kernelStatus")
                    (and (listp snapshot)
                         (or (alist-get 'kernelStatus snapshot)
                             (alist-get "kernelStatus" snapshot nil nil #'string=))))))
    (when status (setq-local noema-research--kernel-status (format "%s" status)))
    (when (and buffer-file-name (file-exists-p buffer-file-name))
      (condition-case err
          (let* ((disk (noema-research-read-file buffer-file-name))
                 (memory-by-id (make-hash-table :test #'equal))
                 (disk-metadata (noema-research--get disk "metadata"))
                 (memory-metadata (noema-research--get noema-research--document "metadata")))
            (dolist (cell (noema-research-cells noema-research--document))
              (puthash (noema-research-cell-id cell) cell memory-by-id))
            (dolist (disk-cell (noema-research-cells disk))
              (when-let* ((cell (gethash (noema-research-cell-id disk-cell) memory-by-id)))
                (when (and (equal (noema-research--get cell "cell_type") "code")
                           (equal (noema-research--get disk-cell "cell_type") "code"))
                  (puthash "execution_count"
                           (noema-research--get disk-cell "execution_count" :null) cell)
                  (puthash "outputs" (or (noema-research--get disk-cell "outputs") []) cell)
                  (let ((memory-cell-meta (noema-research--get cell "metadata"))
                        (disk-cell-meta (noema-research--get disk-cell "metadata")))
                    (when (hash-table-p memory-cell-meta)
                      (if-let* ((runtime (and (hash-table-p disk-cell-meta)
                                              (noema-research--get disk-cell-meta "noema"))))
                          (puthash "noema" runtime memory-cell-meta)
                        (remhash "noema" memory-cell-meta)))))))
            (when (and (hash-table-p disk-metadata) (hash-table-p memory-metadata))
              (dolist (key '("kernelspec" "language_info" "noema"))
                (if-let* ((value (noema-research--get disk-metadata key)))
                    (puthash key value memory-metadata)
                  (remhash key memory-metadata))))
            (setq-local noema-research--revision
                        (noema-research-file-revision buffer-file-name))
            (set-visited-file-modtime)
            (force-mode-line-update t))
        (error
         (message "Noema Jupyter state refresh failed: %s"
                  (error-message-string err)))))))

;;;; Commands

(defun noema-research--entry-at-point (&optional entries)
  "Return the entry of ENTRIES (default: a fresh scan) containing point."
  (let ((position (point))
        found)
    (dolist (entry (or entries (noema-research--scan)) found)
      (when (<= (plist-get entry :header-beg) position)
        (setq found entry)))))

(defun noema-research--cell-at-point ()
  "Sync the buffer and return the cell at point, or nil."
  (noema-research-mode--sync)
  (when-let* ((entry (noema-research--entry-at-point)))
    (noema-research-find-cell noema-research--document (plist-get entry :id))))

(defun noema-research--require-cell ()
  "Return the cell at point or signal a `user-error'."
  (or (noema-research--cell-at-point) (user-error "No research cell at point")))

(defun noema-research-goto-cell (id)
  "Move point to the header of cell or WorkNode ID."
  (let* ((resolved-cell (or (and (noema-research-find-cell noema-research--document id) id)
                            (and-let* ((cell (noema-research-primary-cell
                                              noema-research--document id)))
                              (noema-research-cell-id cell))))
         (entry (seq-find (lambda (item) (equal (plist-get item :id) resolved-cell))
                         (noema-research--scan))))
    (unless entry (user-error "WorkNode %s has no cell in this buffer" id))
    (goto-char (plist-get entry :header-beg))))

(defun noema-research--graph-anchor (cell)
  "Return the graph cell id that work created at CELL continues from."
  (let ((kind (noema-research-cell-kind cell noema-research--document)))
    (cond
     ((member kind noema-research-graph-kinds) (noema-research-cell-work-node-id cell))
     ((equal kind "result") (noema-research-cell-work-node-id cell))
     (t (cl-loop with anchor = nil
                 for other in (noema-research-cells noema-research--document)
                 when (eq other cell) return anchor
                 when (member (noema-research-cell-kind other noema-research--document) noema-research-graph-kinds)
                 do (setq anchor (noema-research-cell-work-node-id other))
                 finally return anchor)))))

(defun noema-research--insert-cell (kind parent)
  "Insert a KIND header below the cell at point with lineage PARENT.
Point is left where the title is typed."
  (let* ((entries (noema-research--scan))
         (entry (noema-research--entry-at-point entries))
         (anchor-cell (and entry (noema-research-find-cell noema-research--document
                                                           (plist-get entry :id))))
         (anchor (and anchor-cell (noema-research-cell-work-node-id anchor-cell)))
         (position (if entry (plist-get entry :block-end) (point-max))))
    (dolist (next entries)
      (when (= (plist-get next :header-beg) position)
        (let ((cell (noema-research-find-cell noema-research--document
                                              (plist-get next :id))))
          (when (and cell anchor
                     (equal (noema-research-cell-kind cell noema-research--document) "result")
                     (equal (noema-research-cell-work-node-id cell) anchor))
            (setq position (plist-get next :block-end))))))
    (goto-char position)
    (when (and (= position (point-max)) (not (bobp)))
      (unless (bolp) (insert "\n"))
      (unless (save-excursion (forward-line -1) (looking-at-p "^$"))
        (insert "\n")))
    (let ((beg (point)))
      (insert "%% " kind " ")
      (when parent
        (put-text-property beg (point) 'noema-research-lineage parent))
      (save-excursion
        (insert (if (eobp) "\n" "\n\n"))))
    (noema-research--schedule-decorations)))

;;;###autoload
(defun noema-research-continue (&optional kind)
  "Continue the research from the cell at point with new work.
With KIND, create that kind of cell instead."
  (interactive)
  (let* ((cell (noema-research--cell-at-point))
         (parent (and cell (noema-research--graph-anchor cell))))
    (noema-research--insert-cell (or kind "work") parent)))

(defun noema-research-new-checkpoint ()
  "Record a checkpoint continuing from the cell at point."
  (interactive)
  (noema-research-continue "checkpoint"))

(defun noema-research-new-sibling ()
  "Create work that shares the lineage parent of the cell at point."
  (interactive)
  (let* ((cell (noema-research--cell-at-point))
         (anchor (and cell (noema-research--graph-anchor cell)))
         (anchor-cell (noema-research-primary-cell noema-research--document anchor)))
    (noema-research--insert-cell
     "work" (and anchor-cell (car (noema-research-cell-relation anchor-cell "lineage" noema-research--document))))))

(defun noema-research-new-question ()
  "Append a new research question."
  (interactive)
  (goto-char (point-max))
  (noema-research--insert-cell "question" nil))

(defun noema-research-insert-code ()
  "Insert a code cell participating in the current contextual WorkNode."
  (interactive)
  (let* ((cell (noema-research--cell-at-point))
         (work-node-id (and cell (noema-research--graph-anchor cell)))
         (entry (noema-research--entry-at-point))
         (position (if entry (plist-get entry :block-end) (point-max)))
         (language (noema-research--notebook-language noema-research--document)))
    (goto-char position)
    (when (and (= position (point-max)) (not (bobp)))
      (unless (bolp) (insert "\n"))
      (unless (save-excursion (forward-line -1) (looking-at-p "^$"))
        (insert "\n")))
    (let ((beg (point)))
      (insert "%% code " language "\n")
      (when work-node-id
        (put-text-property beg (1- (point))
                           'noema-research-work-node-id work-node-id))
      (save-excursion (insert (if (eobp) "\n" "\n\n"))))
    (noema-research--schedule-decorations)))

(defun noema-research-bind-current-cell ()
  "Bind the current cell to an existing WorkNode chosen by label."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (nodes (noema-research-work-nodes noema-research--document))
         (choices
          (mapcar
           (lambda (node)
             (cons (format "%s: %s  [%s]"
                           (noema-research-work-node-field node "kind")
                           (noema-research-work-node-field node "title")
                           (noema-research-work-node-id node))
                   (noema-research-work-node-id node)))
           nodes))
         (choice (completing-read "Participates in WorkNode: " choices nil t))
         (work-node-id (cdr (assoc choice choices)))
         (entry (noema-research--entry-at-point)))
    (noema-research-cell-set cell "work_node_id" work-node-id)
    (when entry
      (put-text-property (plist-get entry :header-beg) (plist-get entry :header-end)
                         'noema-research-work-node-id work-node-id))
    (set-buffer-modified-p t)
    (noema-research-mode--refresh-decorations)))

(defun noema-research--ancestors (cell)
  "Return the lineage ancestor ids of CELL."
  (let ((seen nil)
        (stack (noema-research-cell-relation cell "lineage" noema-research--document)))
    (while stack
      (let ((id (pop stack)))
        (unless (member id seen)
          (push id seen)
          (when-let* ((parent (noema-research-primary-cell noema-research--document id)))
            (setq stack (append (noema-research-cell-relation parent "lineage" noema-research--document) stack))))))
    seen))

(defun noema-research--candidates (cell &optional predicate)
  "Return (LABEL . CELL) relation candidates for CELL, nearest first.
PREDICATE, when non-nil, filters candidate cells."
  (let* ((cells (noema-research-cells noema-research--document))
         (here (or (seq-position cells cell #'eq) 0))
         (ancestors (noema-research--ancestors cell))
         candidates)
    (dolist (other cells)
      (when (and (not (eq other cell))
                 (member (noema-research-cell-kind other noema-research--document) noema-research-graph-kinds)
                 (or (null predicate) (funcall predicate other)))
        (push (cons (format "%s: %s  [%s]"
                            (noema-research-cell-kind other noema-research--document)
                            (replace-regexp-in-string
                             "," " " (noema-research-cell-label other noema-research--document))
                            (noema-research-cell-work-node-id other))
                    other)
              candidates)))
    (sort candidates
          (lambda (left right)
            (let ((left-ancestor (member (noema-research-cell-work-node-id (cdr left)) ancestors))
                  (right-ancestor (member (noema-research-cell-work-node-id (cdr right)) ancestors)))
              (if (not (eq (not left-ancestor) (not right-ancestor)))
                  left-ancestor
                (< (abs (- (seq-position cells (cdr left) #'eq) here))
                   (abs (- (seq-position cells (cdr right) #'eq) here)))))))))

(defun noema-research--edit-relation (type)
  "Edit the TYPE relation parents of the cell at point."
  (let* ((cell (noema-research--require-cell))
         (id (noema-research-cell-work-node-id cell))
         (predicate (when (equal type "depends")
                      (lambda (other)
                        (not (noema-research-depends-reaches-p
                              noema-research--document
                              (noema-research-cell-work-node-id other) id)))))
         (candidates (noema-research--candidates cell predicate))
         (current (delq nil
                        (mapcar (lambda (parent)
                                  (car (seq-find (lambda (candidate)
                                                   (equal (noema-research-cell-work-node-id
                                                           (cdr candidate))
                                                          parent))
                                                 candidates)))
                                (noema-research-cell-relation cell type noema-research--document))))
         (chosen (completing-read-multiple
                  (format "%s parents: " (capitalize type))
                  candidates nil t (string-join current ","))))
    (noema-research-set-relation
     noema-research--document id type
     (mapcar (lambda (choice) (noema-research-cell-work-node-id (cdr (assoc choice candidates))))
             chosen))
    (set-buffer-modified-p t)
    (noema-research-mode--refresh-decorations)))

(defun noema-research-edit-lineage ()
  "Edit the lineage parents of the cell at point."
  (interactive)
  (noema-research--edit-relation "lineage"))

(defun noema-research-edit-depends ()
  "Edit the hard dependencies of the cell at point."
  (interactive)
  (noema-research--edit-relation "depends"))

(defun noema-research-set-work-state (state &optional outcome)
  "Set the work cell at point to STATE.
With a prefix argument, also prompt for OUTCOME (empty clears it)."
  (interactive
   (list (completing-read "State: " noema-research-work-states nil t)
         (when current-prefix-arg
           (completing-read "Outcome (empty clears): "
                            noema-research-work-outcomes nil nil))))
  (let* ((cell (noema-research--require-cell))
         (id (noema-research-cell-work-node-id cell))
         (reason (when (equal state "dropped")
                   (read-string "Reason (optional): "))))
    (noema-research-set-state noema-research--document id state reason)
    (when outcome
      (noema-research-set-outcome noema-research--document id outcome))
    (set-buffer-modified-p t)
    (noema-research-mode--refresh-decorations)))

(defun noema-research--artifact-link-source-path (root source-uri)
  "Resolve a project-local artifact SOURCE-URI beneath ROOT."
  (when (and (stringp source-uri)
             (string-prefix-p "noema://file/" source-uri))
    (expand-file-name
     (mapconcat #'url-unhex-string
                (split-string (substring source-uri (length "noema://file/")) "/" t)
                "/")
     root)))

(defun noema-research--insert-artifact-link (link root)
  "Insert one WorkNode artifact LINK relative to project ROOT."
  (let* ((artifact (noema-research--get link "artifact"))
         (source-uri (or (noema-research--string
                          (noema-research--get link "sourceUri"))
                         "immutable artifact"))
         (path (noema-research--artifact-link-source-path root source-uri))
         (relation (or (noema-research--string
                        (noema-research--get link "relation"))
                       "produced"))
         (kind (or (noema-research--string
                    (noema-research--get artifact "kind"))
                   "artifact"))
         (digest (or (noema-research--string
                      (noema-research--get artifact "sha256"))
                     "")))
    (insert (format "  %-9s " relation))
    (if path
        (insert-text-button
         (file-relative-name path root)
         'follow-link t
         'help-echo "Visit the ordinary project file"
         'action (lambda (_button) (find-file path)))
      (insert source-uri))
    (insert (format " · %s%s\n" kind
                    (if (string-empty-p digest) ""
                      (format " · %.12s" digest))))))

(defun noema-research--load-inspector-artifacts
    (buffer start-marker end-marker root notebook-id work-node-id)
  "Load WORK-NODE-ID artifact provenance into BUFFER between two markers."
  (if (not (and (fboundp 'my/noema-api-call)
                (bound-and-true-p my/noema--ready)))
      (when (buffer-live-p buffer)
        (with-current-buffer buffer
          (let ((inhibit-read-only t))
            (goto-char start-marker)
            (delete-region start-marker end-marker)
            (insert "Runtime index unavailable; ordinary files remain accessible.\n"))))
    (my/noema-api-call
     "aaronnote:api:research:artifact:links"
     (vector (noema-research--table
              "cwd" root "notebookId" notebook-id
              "workNodeId" work-node-id "limit" 100))
     (lambda (result error-object)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (let ((inhibit-read-only t))
             (goto-char start-marker)
             (delete-region start-marker end-marker)
             (cond
              (error-object
               (insert (format "Artifact provenance unavailable: %s\n"
                               (or (noema-research--string
                                    (and (hash-table-p error-object)
                                         (gethash "message" error-object)))
                                   "request failed"))))
              (t
               (let ((links (append (or (noema-research--get result "links") []) nil)))
                 (if links
                     (dolist (link links)
                       (noema-research--insert-artifact-link link root))
                   (insert "No Run-produced artifacts recorded for this WorkNode.\n"))))))))))))

(defun noema-research-inspect ()
  "Show the research metadata of the cell at point."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (document noema-research--document)
         (cell-id (noema-research-cell-id cell))
         (id (noema-research-cell-work-node-id cell))
         (label (lambda (work-node-id)
                  (let ((target (noema-research-primary-cell document work-node-id)))
                    (if target (noema-research-cell-label target document)
                      (format "%s (no cell)" work-node-id)))))
         (children (seq-filter (lambda (other)
                                 (member id (noema-research-cell-relation other "lineage" document)))
                               (noema-research-cells document)))
         (validation (noema-research-validate document))
         (root (noema-research-repository-root buffer-file-name))
         (notebook-id (noema-research-notebook-id document))
         (buffer (get-buffer-create "*Noema Inspector*")))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (propertize (noema-research-cell-label cell document) 'face 'bold) "\n\n")
        (dolist (field `(("Kind" . ,(noema-research-cell-kind cell document))
                         ("WorkNode" . ,id)
                         ("Cell" . ,cell-id)
                         ("State" . ,(noema-research-cell-state cell document))
                         ("Outcome" . ,(noema-research-cell-outcome cell document))
                         ("Dropped reason" . ,(noema-research-work-node-field
                                                (noema-research-work-node-for-cell document cell)
                                                "dropped_reason"))
                         ("Lineage parents" . ,(mapconcat label (noema-research-cell-relation cell "lineage" document) ", "))
                         ("Depends on" . ,(mapconcat label (noema-research-cell-relation cell "depends" document) ", "))
                         ("Continued by" . ,(mapconcat (lambda (item) (noema-research-cell-label item document)) children ", "))))
          (when (noema-research--string (cdr field))
            (insert (format "%-16s %s\n" (car field) (cdr field)))))
        (dolist (kind '(:errors :warnings))
          (dolist (entry (plist-get validation kind))
            (when (member (car entry) (list id cell-id))
              (insert (format "%-16s %s\n" (if (eq kind :errors) "Error" "Warning")
                              (cdr entry))))))
        (insert "\n" (propertize "Artifacts" 'face 'bold) "\n\n")
        (let ((start (copy-marker (point) nil)))
          (insert "Loading WorkNode artifact provenance…\n")
          (let ((end (copy-marker (point) t)))
            (noema-research--load-inspector-artifacts
             buffer start end root notebook-id id)))
        (goto-char (point-min))
        (special-mode)))
    (display-buffer buffer)))

(defun noema-research--imenu-index ()
  "Return an imenu index of JuText headers."
  (mapcar (lambda (entry)
            (cons (string-trim (concat "%% " (plist-get entry :text)))
                  (plist-get entry :header-beg)))
          (noema-research--scan)))

;;;###autoload
(defun noema-research-new-notebook (file title)
  "Create research notebook FILE titled TITLE and visit it."
  (interactive
   (list (read-file-name "New research notebook: ")
         (read-string "Title: ")))
  (let ((path (expand-file-name (if (string-suffix-p ".noema" file t)
                                    file
                                  (concat file ".noema")))))
    (when (file-exists-p path)
      (user-error "%s already exists" path))
    (noema-research-write-file path (noema-research-create-document title))
    (find-file path)
    (unless (derived-mode-p 'noema-research-mode)
      (noema-research-mode))))

(defvar noema-research-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-n") #'noema-research-continue)
    (define-key map (kbd "C-c C-s") #'noema-research-new-sibling)
    (define-key map (kbd "C-c C-k") #'noema-research-new-checkpoint)
    (define-key map (kbd "C-c C-q") #'noema-research-new-question)
    (define-key map (kbd "C-c C-p") #'noema-research-edit-lineage)
    (define-key map (kbd "C-c C-d") #'noema-research-edit-depends)
    (define-key map (kbd "C-c C-t") #'noema-research-set-work-state)
    (define-key map (kbd "C-c C-i") #'noema-research-inspect)
    (define-key map (kbd "C-c C-a") #'noema-research-attention)
    (define-key map (kbd "C-c C-r") #'noema-research-propose-with-magent)
    (define-key map (kbd "C-c C-g") #'noema-research-graph-open)
    (define-key map (kbd "C-c C-c") #'noema-research-execute-current)
    (define-key map (kbd "C-c C-o") #'noema-research-open-outputs)
    (define-key map (kbd "C-c C-z") #'noema-research-interrupt-current)
    (define-key map (kbd "C-c j a") #'noema-research-execute-all)
    (define-key map (kbd "C-c j x") #'noema-research-clear-current-output)
    (define-key map (kbd "C-c j X") #'noema-research-clear-all-outputs)
    (define-key map (kbd "C-c j i") #'noema-research-interrupt)
    (define-key map (kbd "C-c j r") #'noema-research-restart-kernel)
    (define-key map (kbd "C-c j k") #'noema-research-shutdown-kernel)
    (define-key map (kbd "C-c j K") #'noema-research-select-kernel)
    (define-key map (kbd "C-c C-e") #'noema-research-insert-code)
    (define-key map (kbd "C-c C-b") #'noema-research-bind-current-cell)
    map)
  "Keymap for `noema-research-mode'.")

;;;###autoload
(define-derived-mode noema-research-mode text-mode "JuText"
  "Edit a Noema research notebook through its JuText projection.

\\{noema-research-mode-map}"
  (setq-local font-lock-defaults '(noema-research--font-lock-keywords t))
  (setq-local imenu-create-index-function #'noema-research--imenu-index)
  (setq-local require-final-newline nil)
  (setq-local buffer-file-coding-system 'utf-8-unix)
  (setq-local revert-buffer-function #'noema-research--revert)
  (add-hook 'write-contents-functions #'noema-research-mode--write-contents nil t)
  (add-hook 'after-change-functions #'noema-research--schedule-decorations nil t)
  (let* ((file buffer-file-name)
         (on-disk (and file (file-exists-p file))))
    (noema-research--load (if on-disk
                              (noema-research-read-file file)
                            (noema-research-normalize-document
                             (noema-research-parse-json (buffer-string))))
                          (and on-disk (noema-research-file-revision file)))
    (when on-disk
      (set-visited-file-modtime)
      (noema-research-notify-host file "jutext.open"))))

(provide 'noema-research-mode)

;;; noema-research-mode.el ends here
