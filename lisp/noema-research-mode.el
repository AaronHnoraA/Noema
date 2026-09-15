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
;;
;; Cell ids never appear in the text: they are attached to header lines as text
;; properties, so renaming a title keeps every relation.  Source lines that
;; begin with `%%' are escaped with a backslash.  Relations, state, and other
;; research metadata are edited through commands, never typed as syntax.
;;
;; Saving writes the `*.noema' directly (so editing works without the Noema host)
;; and then asks a running host to reindex; the Go index derives the semantic
;; history by diffing against its previous index.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'url-util)
(require 'transient)
(require 'noema-research)
(require 'noema-api)
(require 'noema-research-completion)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function my/noema--host-file "init-aaronnote" (file))
(declare-function my/noema-jupyter-output-open-document
                  "init-aaronnote" (payload &optional focus))
(declare-function my/noema-jupyter-cell--api-sync
                  "init-aaronnote-jupyter-cell" (channel body &optional timeout))
(declare-function noema-research-graph-follow-source
                  "noema-research-graph" (source work-node-id))
(declare-function noema-research-graph-buffer
                  "noema-research-graph" (&optional source))
(declare-function noema-research-graph-pop-buffer
                  "noema-research-graph" (graph))
(declare-function noema-research-graph-refresh "noema-research-graph" ())
(defvar my/noema--ready)
(defvar noema-research-graph--source)

(autoload 'noema-research-graph-open "noema-research-graph" nil t)
(autoload 'noema-research-graph-buffer "noema-research-graph" nil nil)
(autoload 'noema-research-attention "noema-research-inspector" nil t)
(autoload 'noema-research-propose-with-magent "noema-research-synthesis" nil t)
(autoload 'noema-research-settings "noema-research-settings" nil t)
(autoload 'noema-capability-manager "noema-capability-ui" nil t)
(autoload 'noema-skill-manager "noema-capability-ui" nil t)
(autoload 'noema-mcp-manager "noema-capability-ui" nil t)
(autoload 'noema-research-graph-dock "noema-research-graph")
(autoload 'noema-sessions "noema-sessions" nil t)
(declare-function noema-pi-router-note-visit "noema-pi-router" (&optional buffer))
(declare-function file-notify-add-watch "filenotify" (file flags callback))
(declare-function file-notify-rm-watch "filenotify" (descriptor))
(autoload 'noema-agent-worker-cancel-run "noema-agent-worker" nil t)
(autoload 'noema-agent-worker-cancel-cell "noema-agent-worker")
(autoload 'noema-agent-acp-known-agents "noema-agent-acp" nil nil)

(defgroup noema-research nil
  "Noema research notebooks."
  :group 'tools)

(defcustom noema-research-sync-host t
  "Whether saving a research notebook asks a running Noema host to reindex."
  :type 'boolean
  :group 'noema-research)

(defcustom noema-research-open-output-on-visit t
  "Whether visiting a `.noema' file opens its right-side OutputArea.
Command-Return (`s-<return>', or `M-<return>' with Command as Meta) syncs
OutputArea to the block at point."
  :type 'boolean
  :group 'noema-research)

(defcustom noema-research-open-graph-on-visit t
  "Whether visiting a `.noema' file docks its DAG below JuText.
The DAG never follows the cursor.  Command-Shift-Return (`s-S-<return>' or
`M-S-<return>') or the right-click menu syncs it to the block at point."
  :type 'boolean
  :group 'noema-research)

(defcustom noema-research-python-interpreter "python3"
  "Interpreter used by non-agent project-file Runs for `.py' files."
  :type 'string
  :group 'noema-research)

(defvar-local noema-research--output-timer nil
  "Pending deferred default OutputArea open for this JuText buffer.")

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

(defface noema-research-decoration-face
  '((t :inherit shadow :slant italic))
  "Face for header decorations.")

(defvar-local noema-research--document nil
  "Research notebook document backing the current JuText buffer.")

(defvar-local noema-research--revision nil
  "File revision the current JuText buffer was loaded from or saved as.")

(defvar-local noema-research--decoration-timer nil
  "Pending idle timer that refreshes header decorations.")

(defcustom noema-research-structure-history-limit 50
  "Number of structure edits kept for `noema-research-structure-undo'."
  :type 'natnum
  :group 'noema-research)

(defcustom noema-research-move-relocates-block t
  "Whether moving a WorkNode under a new parent also moves its JuText block.
The block then follows the new parent's block, where continuing work is
inserted.  Document order never changes the DAG itself."
  :type 'boolean
  :group 'noema-research)

(defvar-local noema-research--structure-undo nil
  "Undoable structure edits, newest first: (LABEL DOCUMENT-TEXT FINGERPRINT).")

(defvar-local noema-research--structure-redo nil
  "Undone structure edits that can be redone, newest first.")

(defvar-local noema-research--tombstones nil
  "Cells whose header text left the buffer, keyed by cell id.
Yanking or undoing that header text restores the Cell, its WorkNode and the
WorkNode's edges instead of minting new identities.")

(defvar-local noema-research--tombstone-order nil
  "Tombstoned cell ids, newest first.")

(defvar-local noema-research--base nil
  "Document text as last loaded from or saved to disk.
It is the base that tells structure another Noema writer added on disk
apart from structure this buffer deleted.")

(defconst noema-research--tombstone-limit 200
  "Maximum number of removed Cells remembered for restoration.")

(defvar noema-research--inhibit-graph-notify nil
  "Non-nil while the Graph Board applies an edit and redraws itself.")

(defconst noema-research--header-regexp "^%%\\(?:[ \t]+\\(.*?\\)\\)?[ \t]*$"
  "Regexp matching a JuText cell header.")

(defconst noema-research--header-words
  '("question" "work" "checkpoint" "note")
  "Words with a structural meaning at the start of a header.")

(defconst noema-research--font-lock-keywords
  '(("^%%[ \t]+question\\_>.*$" . 'noema-research-question-face)
    ("^%%[ \t]+work\\_>.*$" . 'noema-research-work-face)
    ("^%%[ \t]+checkpoint\\_>.*$" . 'noema-research-checkpoint-face)
    ("^%%\\(?:[ \t].*\\)?$" . 'noema-research-note-face)
    ("^@@\\(?:agent\\|session\\|ctx\\|skill\\)([^)\n]+)[ \t]*$"
     . 'font-lock-preprocessor-face))
  "Font lock keywords for JuText headers.")

;;;; Projection

(defun noema-research--escape-source (source)
  "Escape SOURCE lines that would read as JuText headers."
  (replace-regexp-in-string "^\\(\\\\*%%\\)" "\\\\\\1" source))

(defun noema-research--unescape-source (text)
  "Undo `noema-research--escape-source' on TEXT."
  (replace-regexp-in-string "^\\\\\\(\\\\*%%\\)" "\\1" text))

(defun noema-research--header-text (cell document)
  "Return the JuText header line for CELL in DOCUMENT."
  (let ((kind (noema-research-cell-kind cell document))
        (title (noema-research-cell-title cell document)))
    (pcase kind
      ("note"
       (cond
        ((string-empty-p title) "%%")
        ((member (car (split-string title "[ \t]+" t)) noema-research--header-words)
         (concat "%% note " title))
        (t (concat "%% " title))))
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
          (insert (noema-research--escape-source source) "\n")))))
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
  (if (member kind noema-research-graph-kinds)
      (progn
        (noema-research-cell-set cell "kind" nil)
        (noema-research-cell-set cell "title" nil)
        (noema-research-bind-cell document cell kind title work-node-id))
    (puthash "cell_type" "markdown" cell)
    (remhash "execution_count" cell)
    (remhash "outputs" cell)
    (noema-research-cell-set cell "work_node_id" nil)
    (noema-research-cell-set cell "kind" nil)
    (noema-research-cell-set cell "title" title)))

(defun noema-research--tombstone-put (cell &rest plist)
  "Remember removed CELL with PLIST (:primary :node :edges)."
  (unless (hash-table-p noema-research--tombstones)
    (setq noema-research--tombstones (make-hash-table :test #'equal)))
  (let ((id (noema-research-cell-id cell)))
    (puthash id (append (list :cell cell) plist) noema-research--tombstones)
    (setq noema-research--tombstone-order
          (cons id (delete id noema-research--tombstone-order)))
    (when-let* ((overflow (nthcdr noema-research--tombstone-limit
                                  noema-research--tombstone-order)))
      (dolist (old overflow) (remhash old noema-research--tombstones))
      (setq noema-research--tombstone-order
            (seq-take noema-research--tombstone-order noema-research--tombstone-limit)))))

(defun noema-research--tombstone-take (id)
  "Remove and return the tombstone of cell ID, or nil."
  (when-let* (((hash-table-p noema-research--tombstones))
              (tomb (gethash id noema-research--tombstones)))
    (remhash id noema-research--tombstones)
    (setq noema-research--tombstone-order (delete id noema-research--tombstone-order))
    tomb))

(defun noema-research-mode--sync ()
  "Merge the JuText buffer into `noema-research--document' and return it.
New headers receive stable cell ids that are attached to their header lines;
copied headers are given new ids.  A header whose text disappears removes its
Cell, and a WorkNode left without Cells together with its relations; both are
tombstoned, so yanking or undoing that header text restores them.  A
supporting note (a non-primary bound Cell) keeps its binding."
  (noema-research--ensure-leading-header)
  (let ((document noema-research--document)
        (old (make-hash-table :test #'equal))
        (old-primary (make-hash-table :test #'equal))
        (taken (make-hash-table :test #'equal))
        (seen (make-hash-table :test #'equal))
        (seen-nodes (make-hash-table :test #'equal))
        cells assignments removed revived)
    (dolist (cell (noema-research-cells document))
      (puthash (noema-research-cell-id cell) cell old)
      (puthash (noema-research-cell-id cell) t taken)
      (when (noema-research-cell-primary-p document cell)
        (puthash (noema-research-cell-id cell) t old-primary)))
    (when (hash-table-p noema-research--tombstones)
      (maphash (lambda (id _tomb) (puthash id t taken)) noema-research--tombstones))
    (dolist (entry (noema-research--scan))
      (let* ((parsed (noema-research--parse-header (plist-get entry :text)))
             (kind (car parsed))
             (title (cdr parsed))
             (claimed (plist-get entry :id))
             (existing (and claimed (not (gethash claimed seen))
                            (gethash claimed old)))
             (tomb (and claimed (not existing) (not (gethash claimed seen))
                        (noema-research--tombstone-take claimed))))
        (when tomb
          (setq existing (plist-get tomb :cell))
          (when (plist-get tomb :primary) (puthash claimed t old-primary))
          (when-let* ((node (plist-get tomb :node))
                      ((not (noema-research-find-work-node
                             document (noema-research-work-node-id node)))))
            (noema-research--set-work-nodes
             document (append (noema-research-work-nodes document) (list node)))
            (push tomb revived)))
        (let* ((was-primary (and existing
                                 (gethash (noema-research-cell-id existing) old-primary)))
               (bound-node (and existing
                                (noema-research-find-work-node
                                 document (noema-research-cell-work-node-id existing))
                                (noema-research-cell-work-node-id existing)))
               (claimed-node (if existing
                                 (and was-primary bound-node)
                               (plist-get entry :work-node-id)))
               (reusable-node (and claimed-node
                                   (not (gethash claimed-node seen-nodes))
                                   (noema-research-find-work-node document claimed-node)
                                   claimed-node))
               (cell (or existing
                         (noema-research--table
                          "cell_type" "markdown"
                          "id" (noema-research-new-cell-id taken)
                          "metadata" (make-hash-table :test #'equal)
                          "source" ""))))
          (if (and (equal kind "note") bound-node (not was-primary))
              (noema-research-cell-set cell "title" title)
            (noema-research--apply-kind document cell kind title reusable-node))
          (puthash "source" (plist-get entry :body) cell)
          (when (and (not existing) (member kind noema-research-graph-kinds))
            (when-let* ((parents (seq-filter
                                  (lambda (parent)
                                    (noema-research-find-work-node document parent))
                                  (ensure-list (plist-get entry :lineage)))))
              (noema-research-set-relation
               document (noema-research-cell-work-node-id cell) "lineage" parents)))
          (puthash (noema-research-cell-id cell) t seen)
          (when-let* (((member kind noema-research-graph-kinds))
                      (work-node-id (noema-research-cell-work-node-id cell)))
            (puthash work-node-id t seen-nodes))
          (push cell cells)
          (push (list (plist-get entry :header-beg) (plist-get entry :header-end)
                      (noema-research-cell-id cell)
                      (noema-research-cell-work-node-id cell))
                assignments))))
    (maphash (lambda (id cell) (unless (gethash id seen) (push cell removed))) old)
    (puthash "cells" (vconcat (nreverse cells)) document)
    (dolist (cell removed)
      (let* ((work-node-id (noema-research-cell-work-node-id cell))
             (node (noema-research-find-work-node document work-node-id))
             (orphaned (and node (not (noema-research-work-node-cells document work-node-id)))))
        (noema-research--tombstone-put
         cell
         :primary (gethash (noema-research-cell-id cell) old-primary)
         :node (and orphaned node)
         :edges (and orphaned
                     (seq-filter (lambda (edge)
                                   (or (equal (noema-research--get edge "from") work-node-id)
                                       (equal (noema-research--get edge "to") work-node-id)))
                                 (noema-research-dependencies document))))))
    (dolist (cell removed)
      (let ((work-node-id (noema-research-cell-work-node-id cell)))
        (when (and (noema-research-find-work-node document work-node-id)
                   (not (noema-research-work-node-cells document work-node-id)))
          (noema-research-delete-work-node document work-node-id t))))
    (dolist (tomb revived)
      (dolist (edge (plist-get tomb :edges))
        (let ((from (noema-research--get edge "from"))
              (to (noema-research--get edge "to"))
              (type (noema-research--get edge "type")))
          (when (and (noema-research-find-work-node document from)
                     (noema-research-find-work-node document to)
                     (not (member from (noema-research-relation-parents document to type)))
                     (not (noema-research-dependency-reaches-p document from to)))
            (noema-research--set-dependencies
             document (append (noema-research-dependencies document) (list edge)))))))
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

;;;; Structure transactions

(defun noema-research--reproject ()
  "Make the buffer text the JuText projection of `noema-research--document'.
Only differing text is replaced, so point, window starts, markers and
unrelated undo history survive; header identities are then reattached."
  (let ((document noema-research--document)
        (target (generate-new-buffer " *noema-reproject*" t))
        entries text)
    (unwind-protect
        (progn
          (with-current-buffer target
            (noema-research--render document)
            (setq entries (noema-research--scan)
                  text (buffer-substring-no-properties (point-min) (point-max))))
          (save-restriction
            (widen)
            (let ((inhibit-read-only t))
              (unless (string= text (buffer-substring-no-properties (point-min) (point-max)))
                ;; Obsolete in Emacs 31 in favour of `replace-region-contents',
                ;; whose signature differs on Emacs 30; keep one call for both.
                (with-suppressed-warnings ((obsolete replace-buffer-contents))
                  (replace-buffer-contents target 0.2)))
              (with-silent-modifications
                (remove-text-properties (point-min) (point-max)
                                        '(noema-research-id nil
                                          noema-research-work-node-id nil
                                          noema-research-lineage nil))
                (dolist (entry entries)
                  (put-text-property (plist-get entry :header-beg) (plist-get entry :header-end)
                                     'noema-research-id (plist-get entry :id))
                  (when-let* ((work-node-id (plist-get entry :work-node-id)))
                    (put-text-property (plist-get entry :header-beg)
                                       (plist-get entry :header-end)
                                       'noema-research-work-node-id work-node-id)))))))
      (kill-buffer target))))

(defun noema-research--structure-fingerprint (document)
  "Return DOCUMENT's structure, without Cell text or outputs, as JSON text."
  (let ((copy (noema-research-parse-json (noema-research-serialize document))))
    (seq-doseq (cell (noema-research--get copy "cells" []))
      (remhash "source" cell)
      (remhash "outputs" cell)
      (remhash "execution_count" cell))
    (noema-research-serialize copy)))

(defun noema-research--notify-graph ()
  "Redraw the displayed Graph Board when it projects the current buffer."
  (unless noema-research--inhibit-graph-notify
    (when-let* ((source (current-buffer))
                ((boundp 'noema-research-graph--source))
                ((fboundp 'noema-research-graph-refresh))
                (graph (get-buffer "*Noema DAG*"))
                ((get-buffer-window graph t))
                ((eq (buffer-local-value 'noema-research-graph--source graph) source)))
      (with-current-buffer graph
        (condition-case error-object
            (noema-research-graph-refresh)
          (error (message "Noema DAG refresh failed: %s"
                          (error-message-string error-object))))))))

(defun noema-research--record-structure (label pre)
  "Reproject and record the edit from document text PRE under LABEL.
Return non-nil when the document changed."
  (noema-research--reproject)
  (let* ((document (noema-research-mode--sync))
         (changed (not (equal pre (noema-research-serialize document)))))
    (when changed
      (set-buffer-modified-p t)
      (setq noema-research--structure-undo
            (seq-take (cons (list label pre (noema-research--structure-fingerprint document))
                            noema-research--structure-undo)
                      noema-research-structure-history-limit)
            noema-research--structure-redo nil))
    (noema-research-mode--refresh-decorations)
    (noema-research--notify-graph)
    changed))

(defun noema-research-structure-edit (label function)
  "Apply FUNCTION to this buffer's synced document as one validated edit.
FUNCTION receives the document and returns a WorkNode or Cell id, or nil.
An error, a quit, or any validation error the edit introduces rolls the
whole edit back.  Success reprojects the JuText text and records an undo
step named LABEL.  Return FUNCTION's value."
  (unless noema-research--document
    (user-error "Not in a Noema work document"))
  (let* ((document (noema-research-mode--sync))
         (pre (noema-research-serialize document))
         (errors (plist-get (noema-research-validate document) :errors))
         result)
    (condition-case signal-data
        (progn
          (setq result (funcall function document))
          (when-let* ((introduced (seq-difference
                                   (plist-get (noema-research-validate document) :errors)
                                   errors)))
            (user-error "Refused to %s: %s" label (mapconcat #'cdr introduced "; "))))
      ((error quit)
       (setq noema-research--document
             (noema-research-normalize-document (noema-research-parse-json pre)))
       (signal (car signal-data) (cdr signal-data))))
    (noema-research--record-structure label pre)
    result))

(defun noema-research--structure-step (from to verb)
  "Move the newest edit from history FROM to TO; VERB is undo or redo.
Text typed since the edit is kept.  The step is refused when the structure
changed afterwards, or when it would discard text written in a Cell that
the edit created."
  (let ((entry (car (symbol-value from))))
    (unless entry (user-error "No structure edit to %s" verb))
    (pcase-let* ((`(,label ,target ,expected) entry)
                 (document (noema-research-mode--sync)))
      (unless (equal (noema-research--structure-fingerprint document) expected)
        (user-error "Cannot %s “%s”: the structure changed afterwards" verb label))
      (let ((current (noema-research-serialize document))
            (restored (noema-research-normalize-document (noema-research-parse-json target)))
            (live (make-hash-table :test #'equal)))
        (dolist (cell (noema-research-cells document))
          (puthash (noema-research-cell-id cell) cell live))
        (dolist (cell (noema-research-cells restored))
          (when-let* ((now (gethash (noema-research-cell-id cell) live)))
            (puthash "source" (noema-research-cell-source now) cell)
            (when (and (equal (noema-research--get cell "cell_type") "code")
                       (equal (noema-research--get now "cell_type") "code"))
              (puthash "outputs" (or (noema-research--get now "outputs") []) cell))
            (remhash (noema-research-cell-id cell) live)))
        (maphash (lambda (_id cell)
                   (when (string-match-p "[^ \t\n]" (noema-research-cell-source cell))
                     (user-error "Cannot %s “%s”: it would discard text in a Cell it created"
                                 verb label)))
                 live)
        (set from (cdr (symbol-value from)))
        (setq noema-research--document restored)
        (noema-research--reproject)
        (let ((synced (noema-research-mode--sync)))
          (set to (cons (list label current (noema-research--structure-fingerprint synced))
                        (symbol-value to))))
        (set-buffer-modified-p t)
        (noema-research-mode--refresh-decorations)
        (noema-research--notify-graph)
        (message "Structure %s: %s" verb label)
        label))))

(defun noema-research-structure-undo ()
  "Undo the newest WorkNode/DAG structure edit of this document."
  (interactive)
  (noema-research--structure-step 'noema-research--structure-undo
                                  'noema-research--structure-redo "undo"))

(defun noema-research-structure-redo ()
  "Redo the newest undone WorkNode/DAG structure edit of this document."
  (interactive)
  (noema-research--structure-step 'noema-research--structure-redo
                                  'noema-research--structure-undo "redo"))

;;;; Decorations

(defun noema-research--latest-run-status (cell)
  "Return CELL's latest known Run status, without reviving a finished Run."
  (let* ((persisted (noema-research-cell-latest-run cell))
         (route (and (boundp 'noema-research--session-labels)
                     (hash-table-p noema-research--session-labels)
                     (gethash (noema-research-cell-id cell) noema-research--session-labels)))
         (live (noema-research--route-field route "latestRun")))
    (if (and live (not (and (equal (noema-research--route-field live "id") (plist-get persisted :id))
                            (member (plist-get persisted :status) '("completed" "cancelled" "failed" "interrupted")))))
        (noema-research--route-field live "status")
      (plist-get persisted :status))))

(defun noema-research--decoration (cell)
  "Return the header decoration string for CELL."
  (if (null cell)
      "  · new"
    (let* ((kind (noema-research-cell-kind cell noema-research--document))
           (lineage (length (noema-research-cell-relation cell "lineage" noema-research--document)))
           (depends (length (noema-research-cell-relation cell "depends" noema-research--document)))
           (parts (delq nil (list (noema-research-cell-state cell noema-research--document)
                                  (noema-research-cell-outcome cell noema-research--document)
                                  (and (equal kind "work")
                                       (when-let* ((status (noema-research--latest-run-status cell)))
                                         (concat "run:" status)))
                                  (and (> lineage 0) (format "↑%d" lineage))
                                  (and (> depends 0) (format "⇠%d" depends))))))
      (cond
       ((equal kind "note")
        (when-let* ((node (noema-research-work-node-for-cell noema-research--document cell)))
          (format "  · ↳ %s" (noema-research-work-node-label
                              noema-research--document
                              (noema-research-work-node-id node)))))
       (parts (concat "  · " (string-join parts " · ")))))))

(defun noema-research-mode--refresh-decorations ()
  "Refresh the header decorations of the current JuText buffer."
  (when noema-research--document
    (remove-overlays (point-min) (point-max) 'noema-research-decoration t)
    (dolist (entry (noema-research--scan))
      (let* ((id (plist-get entry :id))
             (cell (noema-research-find-cell noema-research--document id))
             (text (noema-research--decoration cell))
             (session (noema-research--session-decoration cell)))
        (when (or text session)
          (let ((overlay (make-overlay (plist-get entry :header-end)
                                       (plist-get entry :header-end))))
            (overlay-put overlay 'noema-research-decoration t)
            (overlay-put overlay 'after-string
                         (concat (and text (propertize text 'face 'noema-research-decoration-face))
                                 session))))))))

;;;; D-031 session routes shown on work blocks

(defface noema-research-session-face
  '((t :inherit font-lock-comment-face :slant normal))
  "Face for the named session a work block will run in."
  :group 'noema-research)

(defvar-local noema-research--session-labels nil
  "Cell id to the D-031 session route the host resolved for this document.")

(defvar-local noema-research--session-names nil
  "Session names known in this document's project, for completion.")

(defvar-local noema-research--session-timer nil
  "Idle timer that refreshes work-block session routes.")

(defvar noema-research-session-keywords)

(defun noema-research--route-field (object key)
  "Read string KEY from a JSON-like host OBJECT."
  (let ((value (cond ((hash-table-p object) (gethash key object))
                     ((listp object) (cdr (or (assoc key object) (assq (intern key) object)))))))
    (unless (memq value '(:null :false))
      (if (and (stringp value) (string-empty-p value)) nil value))))

(defun noema-research--session-decoration (cell)
  "Return the session label of work CELL, or nil."
  (when-let* ((cell cell)
              ((hash-table-p noema-research--session-labels))
              (route (gethash (noema-research-cell-id cell) noema-research--session-labels)))
    (if-let* ((problem (noema-research--route-field route "error")))
        (propertize "  ⟨session ✗⟩" 'face 'error 'help-echo problem)
      (when-let* ((name (noema-research--route-field route "name")))
        (let ((parent (noema-research--route-field route "parentName")))
          (propertize (format "  ⟨%s%s · %s%s⟩" name
                              (if parent (format " ⇠ %s" parent) "")
                              (or (noema-research--route-field route "agent") "")
                              (if (noema-research--route-field route "busy") " ●" ""))
                      'face 'noema-research-session-face
                      'help-echo (noema-research--route-field route "reason")))))))

(defun noema-research-refresh-session-routes ()
  "Ask the host which named session each saved work block will run in."
  (interactive)
  (when (and buffer-file-name noema-research--document
             (fboundp 'my/noema-api-call) (bound-and-true-p my/noema--ready))
    (let* ((buffer (current-buffer))
           (preview (copy-hash-table (noema-research-mode--sync)))
           (tick (buffer-chars-modified-tick))
           (root (noema-research-repository-root buffer-file-name))
           (cell-ids (delq nil (mapcar (lambda (cell)
                                         (and (equal (noema-research-cell-kind cell noema-research--document) "work")
                                              (noema-research-cell-id cell)))
                                       (noema-research-cells noema-research--document)))))
      ;; Routing needs source/structure, not a second copy of large outputs.
      (puthash "cells" (vconcat
                         (mapcar (lambda (cell)
                                   (let ((copy (copy-hash-table cell)))
                                     (when (equal (gethash "cell_type" copy) "code")
                                       (puthash "outputs" [] copy))
                                     copy))
                                 (noema-research-cells preview))) preview)
      (my/noema-api-call
       "aaronnote:api:research:session:names" (vector `((cwd . ,root)))
       (lambda (result error-object)
         (when (and (buffer-live-p buffer) (not error-object))
           (with-current-buffer buffer
             (setq noema-research--session-names
                   (delq nil (mapcar (lambda (entry) (noema-research--route-field entry "name"))
                                     (append (noema-research--route-field result "names") nil)))))))
       30)
      (when cell-ids
        (my/noema-api-call
         "aaronnote:api:research:session:resolve"
         (vector `((file . ,(expand-file-name buffer-file-name)) (cwd . ,root)
                   (notebook . ,preview)
                   (cellIds . ,(vconcat cell-ids))))
         (lambda (result error-object)
           (when (and (buffer-live-p buffer) (not error-object)
                      (= tick (buffer-chars-modified-tick buffer)))
             (with-current-buffer buffer
               (let ((labels (make-hash-table :test #'equal)))
                 (dolist (route (append (noema-research--route-field result "sessions") nil))
                   (puthash (noema-research--route-field route "cellId") route labels))
                 (setq noema-research--session-labels labels)
                 (noema-research-mode--refresh-decorations)))))
         30)))))

(defun noema-research--schedule-session-routes ()
  "Refresh the work-block session routes once Emacs is idle."
  (when (and buffer-file-name noema-research-sync-host (not noninteractive)
             (not (timerp noema-research--session-timer)))
    (let ((buffer (current-buffer)))
      (setq noema-research--session-timer
            (run-with-idle-timer
             0.8 nil
             (lambda ()
               (when (buffer-live-p buffer)
                 (with-current-buffer buffer
                   (setq noema-research--session-timer nil)
                   (noema-research-refresh-session-routes)))))))))

(defun noema-research--directive-lines (entry)
  "Return (BEG . END) of each leading `@@' line in the body of scan ENTRY."
  (save-excursion
    (let ((limit (plist-get entry :block-end))
          lines saw)
      (goto-char (min limit (1+ (plist-get entry :header-end))))
      (catch 'done
        (while (< (point) limit)
          (let ((line (buffer-substring-no-properties (line-beginning-position) (line-end-position))))
            (cond ((string-match-p "\\`@@[A-Za-z]" line)
                   (setq saw t)
                   (push (cons (line-beginning-position) (line-end-position)) lines))
                  ((and saw (string-blank-p line)))
                  (t (throw 'done nil))))
          (unless (zerop (forward-line 1)) (throw 'done nil))))
      (nreverse lines))))

(defun noema-research--work-entry-p (entry)
  "Return non-nil when scan ENTRY is a work block."
  (when-let* ((cell (noema-research-find-cell noema-research--document (plist-get entry :id))))
    (equal (noema-research-cell-kind cell noema-research--document) "work")))

(defun noema-research-pin-session (name)
  "Pin the work block at point to session NAME with a leading `@@session' line.
An existing `@@session' line is replaced.  This is an ordinary, undoable text
edit: a person's explicit binding always outranks Pi and DAG derivation."
  (interactive
   (list (completing-read "Session (name, parent:child or keyword): "
                          (append noema-research-session-keywords noema-research--session-names))))
  (unless (noema-research-session-directive-valid-p name)
    (user-error "Invalid @@session value: %s" name))
  (noema-research-mode--sync)
  (let ((entry (or (noema-research--entry-at-point) (user-error "No block at point"))))
    (unless (noema-research--work-entry-p entry)
      (user-error "Only a work block runs in a session"))
    (let ((existing (seq-find (lambda (line)
                                (string-prefix-p "@@session("
                                                 (buffer-substring-no-properties (car line) (cdr line))))
                              (noema-research--directive-lines entry)))
          (text (format "@@session(%s)" name)))
      (save-excursion
        (cond
         (existing
          (goto-char (car existing))
          (delete-region (car existing) (cdr existing))
          (insert text))
         ((>= (plist-get entry :header-end) (point-max))
          (goto-char (point-max))
          (insert "\n" text))
         (t
          (goto-char (1+ (plist-get entry :header-end)))
          (insert text "\n"))))
      (message "Work block pinned to session %s (save to apply)" name))))

(defun noema-research-rename-session-directives (old new)
  "Rename session OLD to NEW in the leading `@@session' lines of work blocks.
Text after a block's directive region is data and is left alone.  Return the
number of lines changed."
  (let ((count 0))
    (when noema-research--document
      (noema-research-mode--sync)
      (save-excursion
        (dolist (entry (reverse (noema-research--scan)))
          (when (noema-research--work-entry-p entry)
            (dolist (line (reverse (noema-research--directive-lines entry)))
              (let ((text (buffer-substring-no-properties (car line) (cdr line))))
                (when (string-match "\\`@@session(\\([^)]*\\))[ \t]*\\'" text)
                  (let* ((value (match-string 1 text))
                         (renamed (mapconcat (lambda (part) (if (equal (string-trim part) old) new part))
                                             (split-string value ":") ":")))
                    (unless (equal renamed value)
                      (goto-char (car line))
                      (delete-region (car line) (cdr line))
                      (insert (format "@@session(%s)" renamed))
                      (setq count (1+ count)))))))))))
    count))

;;;; D-034 disk sync owned by the buffer

(defvar-local noema-research--file-watch nil
  "File-notify descriptor watching this document's directory.")

(defvar-local noema-research--disk-sync-timer nil
  "Debounce timer for merging another Noema writer's change.")

(defun noema-research--unwatch-file ()
  "Stop watching this document on disk."
  (when noema-research--file-watch
    (ignore-errors (file-notify-rm-watch noema-research--file-watch))
    (setq noema-research--file-watch nil))
  (when (timerp noema-research--disk-sync-timer)
    (cancel-timer noema-research--disk-sync-timer))
  (setq noema-research--disk-sync-timer nil))

(defun noema-research--sync-from-disk (buffer)
  "Merge another Noema writer's change into BUFFER without any prompt."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq noema-research--disk-sync-timer nil)
      (when (and buffer-file-name noema-research--document
                 (file-exists-p buffer-file-name)
                 (not (equal (noema-research-file-revision buffer-file-name)
                             noema-research--revision)))
        (condition-case error-object
            (progn
              (noema-research-merge-disk-outputs)
              (noema-research--schedule-session-routes))
          (error
           (display-warning 'noema-research
                            (format "Could not merge %s from disk: %s"
                                    (buffer-name) (error-message-string error-object))
                            :warning)))))))

(defun noema-research--schedule-disk-sync (buffer)
  "Merge BUFFER's document from disk shortly, coalescing bursts of events."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (when (timerp noema-research--disk-sync-timer)
        (cancel-timer noema-research--disk-sync-timer))
      (setq noema-research--disk-sync-timer
            (run-at-time 0.2 nil #'noema-research--sync-from-disk buffer)))))

(defun noema-research--watch-file ()
  "Watch this document so Run outputs and Proposals merge in place.
The directory is watched because atomic writes replace the file."
  (noema-research--unwatch-file)
  (when (and buffer-file-name (fboundp 'file-notify-add-watch)
             (not (file-remote-p buffer-file-name)))
    (let ((buffer (current-buffer))
          (file (expand-file-name buffer-file-name)))
      (setq noema-research--file-watch
            (ignore-errors
              (file-notify-add-watch
               (file-name-directory file) '(change)
               (lambda (event)
                 (when (seq-some (lambda (path)
                                   (and (stringp path) (string= (expand-file-name path) file)))
                                 (cddr event))
                   (noema-research--schedule-disk-sync buffer)))))))))

(defun noema-research--schedule-decorations (&rest _)
  "Refresh decorations once Emacs is idle."
  (noema-research--schedule-session-routes)
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

(defun noema-research--merge-disk-structure (disk)
  "Add structure DISK gained since `noema-research--base'; non-nil if any.
Cells, WorkNodes and edges present on DISK but absent from the base were
written by another Noema writer, such as an accepted Proposal.  They are
added unless this buffer already has them, deleted them, or cut them.
Local titles, states and relation edits always win."
  (when noema-research--base
    (let ((base (noema-research-parse-json noema-research--base))
          (document noema-research--document)
          (base-cells (make-hash-table :test #'equal))
          (base-nodes (make-hash-table :test #'equal))
          (base-edges (make-hash-table :test #'equal))
          changed anchor)
      (seq-doseq (cell (noema-research--get base "cells" []))
        (puthash (noema-research-cell-id cell) t base-cells))
      (dolist (node (noema-research-work-nodes base))
        (puthash (noema-research-work-node-id node) t base-nodes))
      (dolist (edge (noema-research-dependencies base))
        (puthash (list (noema-research--get edge "from") (noema-research--get edge "to")
                       (noema-research--get edge "type"))
                 t base-edges))
      (dolist (node (noema-research-work-nodes disk))
        (let ((id (noema-research-work-node-id node)))
          (unless (or (gethash id base-nodes) (noema-research-find-work-node document id))
            (noema-research--set-work-nodes
             document (append (noema-research-work-nodes document) (list node)))
            (setq changed t))))
      (dolist (cell (noema-research-cells disk))
        (let ((id (noema-research-cell-id cell))
              (node-id (noema-research-cell-work-node-id cell)))
          (unless (or (gethash id base-cells)
                      (noema-research-find-cell document id)
                      (and (hash-table-p noema-research--tombstones)
                           (gethash id noema-research--tombstones))
                      (and node-id (not (noema-research-find-work-node document node-id))))
            (puthash "cells" (vconcat (noema-research-cells document) (vector cell)) document)
            (noema-research-move-cells document (list cell)
                                       (and anchor (noema-research-find-cell document anchor)))
            (setq changed t))
          (when (noema-research-find-cell document id) (setq anchor id))))
      (dolist (edge (noema-research-dependencies disk))
        (let ((from (noema-research--get edge "from"))
              (to (noema-research--get edge "to"))
              (type (noema-research--get edge "type")))
          (unless (or (gethash (list from to type) base-edges)
                      (equal from to)
                      (not (noema-research-find-work-node document from))
                      (not (noema-research-find-work-node document to))
                      (member from (noema-research-relation-parents document to type))
                      (noema-research-dependency-reaches-p document from to))
            (noema-research--set-dependencies
             document (append (noema-research-dependencies document) (list edge)))
            (setq changed t))))
      changed)))

(defun noema-research-merge-disk-outputs ()
  "Merge what other Noema writers persisted into the in-memory document.
Work outputs come from disk.  Structure that appeared on disk since this
buffer last loaded or saved (an accepted Proposal) is added.  Unsaved JuText
text is synced first and, like local structure edits, always wins.
Afterwards the buffer is current with disk, so saving never asks about
external changes."
  (when (and buffer-file-name noema-research--document
             (file-exists-p buffer-file-name)
             ;; Idempotent: the Run resync and the file watch may both fire
             ;; for one write; an unchanged revision only refreshes modtime.
             (or (not (equal noema-research--revision
                             (noema-research-file-revision buffer-file-name)))
                 (progn (set-visited-file-modtime) nil)))
    (let ((modified (buffer-modified-p))
          (disk (noema-research-read-file buffer-file-name))
          (memory (make-hash-table :test #'equal))
          structure)
      (noema-research-mode--sync)
      (setq structure (noema-research--merge-disk-structure disk))
      ;; A Cell cut from the text but not yet yanked back still receives its
      ;; Run output, so moving a block during a Run loses nothing.
      (when (hash-table-p noema-research--tombstones)
        (maphash (lambda (id tomb) (puthash id (plist-get tomb :cell) memory))
                 noema-research--tombstones))
      (dolist (cell (noema-research-cells noema-research--document))
        (puthash (noema-research-cell-id cell) cell memory))
      (dolist (disk-cell (noema-research-cells disk))
        (when-let* ((cell (gethash (noema-research-cell-id disk-cell) memory))
                    ((equal (noema-research--get cell "cell_type") "code"))
                    ((equal (noema-research-cell-kind disk-cell disk) "work")))
          (puthash "execution_count" :null cell)
          (puthash "outputs" (or (noema-research--get disk-cell "outputs") []) cell)))
      (when structure
        (noema-research--reproject)
        (unless modified (set-buffer-modified-p nil))
        (noema-research--notify-graph))
      (setq-local noema-research--revision (noema-research-file-revision buffer-file-name))
      (setq-local noema-research--base (noema-research-serialize disk))
      (set-visited-file-modtime)
      (noema-research-mode--refresh-decorations)
      (noema-research--notify-graph)
      (noema-research--schedule-session-routes)))
  noema-research--document)

(defconst noema-research-session-keywords '("continue" "fork" "fresh")
  "`@@session' keywords; every other value is a D-031 session name.")

(defconst noema-research-session-keyword-lookalikes
  '(("refresh" . "fresh") ("renew" . "fresh") ("new" . "fresh") ("reset" . "fresh")
    ("restart" . "fresh") ("resume" . "continue") ("cont" . "continue")
    ("continued" . "continue") ("same" . "continue") ("forked" . "fork"))
  "Words written for a `@@session' keyword, refused as names.
A mistyped keyword then fails loudly instead of silently creating a named
session.  The table is shared with Node and the Go kernel.")

(defun noema-research-session-keyword-suggestion (value)
  "Return the `@@session' keyword VALUE was probably meant to be, or nil."
  (when (stringp value)
    (let ((word (downcase (string-trim value))))
      (if (member word noema-research-session-keywords)
          word
        (cdr (assoc word noema-research-session-keyword-lookalikes))))))

(defun noema-research--session-name-valid-p (name &optional allow-pi)
  "Return non-nil when NAME is a valid session name.
The reserved coordinator name `pi' is accepted only with ALLOW-PI."
  (and (stringp name)
       (<= (length name) 80)
       (string-match-p "\\`[[:alnum:]][[:alnum:]._/@-]*\\'" name)
       (not (noema-research-session-keyword-suggestion name))
       (or allow-pi (not (equal name "pi")))))

(defun noema-research-session-directive-valid-p (value)
  "Return non-nil when VALUE is a valid D-031 `@@session' argument.
It is a keyword, a name, or parent:child (parent may be empty)."
  (cond
   ((member value noema-research-session-keywords) t)
   ((string-match "\\`\\([^:]*\\):\\([^:]*\\)\\'" value)
    (let ((parent (string-trim (match-string 1 value)))
          (child (string-trim (match-string 2 value))))
      (and (or (string-empty-p parent) (noema-research--session-name-valid-p parent t))
           (noema-research--session-name-valid-p child))))
   (t (and (not (string-search ":" value))
           (noema-research--session-name-valid-p value)))))

(defun noema-research--directive-errors (document)
  "Return save-time directive errors for work blocks in DOCUMENT."
  (let (errors)
    (dolist (cell (noema-research-cells document))
      (when (equal (noema-research-cell-kind cell document) "work")
        (let ((lines (split-string (noema-research-cell-source cell) "\n"))
              (seen (make-hash-table :test #'equal))
              (saw nil)
              (body nil))
          (while (and lines (not body))
            (let ((line (pop lines)))
              (cond
               ((string-match "\\`@@\\([A-Za-z][A-Za-z0-9_-]*\\)(\\(.*\\))[ \t]*\\'" line)
                (let* ((name (match-string 1 line))
                       (value (string-trim (match-string 2 line)))
                       (old (gethash name seen)))
                  (setq saw t)
                  (cond
                   ((not (member name '("agent" "session" "ctx" "skill")))
                    (push (format "%s: unsupported directive @@%s"
                                  (noema-research-cell-id cell) name) errors))
                   ((string-empty-p value)
                    (push (format "%s: empty @@%s directive"
                                  (noema-research-cell-id cell) name) errors))
                   ((and (member name '("agent" "skill"))
                         (not (string-match-p "\\`[A-Za-z0-9][A-Za-z0-9._-]*\\'" value)))
                    (push (format "%s: invalid @@%s value" (noema-research-cell-id cell) name) errors))
                   ((and (equal name "session")
                         (not (noema-research-session-directive-valid-p value)))
                    (push (if-let* ((meant (noema-research-session-keyword-suggestion value)))
                              (format "%s: @@session(%s) is not a keyword; did you mean @@session(%s)?"
                                      (noema-research-cell-id cell) value meant)
                            (format "%s: invalid @@session value" (noema-research-cell-id cell)))
                          errors))
                   ((and (equal name "ctx")
                         (not
                          (or (member value '("lineage" "depends" "git.diff"
                                              "handoff.latest"))
                              (string-match-p "\\`cell:[A-Za-z0-9_-][A-Za-z0-9_-]*\\'" value)
                              (string-match-p "\\`result:wn_[A-Za-z0-9_-][A-Za-z0-9_-]*\\'" value)
                              (string-match-p "\\`file:..*\\'" value)
                              (string-match-p "\\`note:[A-Za-z0-9_-][A-Za-z0-9_-]*\\'" value)
                              (string-match-p "\\`artifact:art_[A-Za-z0-9_-][A-Za-z0-9_-]*\\'" value))))
                    (push (format "%s: unsupported @@ctx reference" (noema-research-cell-id cell)) errors))
                   ((and (member name '("agent" "session")) old
                         (not (equal old value)))
                    (push (format "%s: conflicting @@%s directives"
                                  (noema-research-cell-id cell) name) errors)))
                  (unless (equal name "ctx") (puthash name value seen))))
               ((string-match-p "\\`@@[A-Za-z]" line)
                (push (format "%s: malformed directive %s"
                              (noema-research-cell-id cell) line) errors))
               ((and saw (string-empty-p (string-trim line))))
               (t (setq body (cons line lines)))))))))
    (nreverse errors)))

(defun noema-research-work-prompt-empty-p (cell)
  "Return non-nil when work CELL has no prompt text beyond `@@' directives.
An empty work block is a valid sketch of the DAG; it just cannot run yet."
  (not (seq-some (lambda (line)
                   (and (string-match-p "[^ \t]" line)
                        (not (string-match-p "\\`[ \t]*@@[A-Za-z]" line))))
                 (split-string (noema-research-cell-source cell) "\n"))))

(defun noema-research--load (document revision)
  "Render DOCUMENT loaded at REVISION into the current buffer."
  (setq noema-research--document document
        noema-research--revision revision
        noema-research--structure-undo nil
        noema-research--structure-redo nil
        noema-research--tombstones nil
        noema-research--tombstone-order nil
        noema-research--base (noema-research-serialize document))
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
    (when-let* ((errors (noema-research--directive-errors document)))
      (user-error "Invalid work directives: %s" (string-join errors "; ")))
    (when (and noema-research--revision
               (not (equal noema-research--revision
                           (noema-research-file-revision buffer-file-name))))
      (noema-research-merge-disk-outputs))
    (setq noema-research--revision
          (noema-research-write-file buffer-file-name document
                                     noema-research--revision)
          noema-research--base (noema-research-serialize document))
    (set-visited-file-modtime)
    (set-buffer-modified-p nil)
    (noema-research-mode--refresh-decorations)
    (noema-research--schedule-session-routes)
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

;;;; Agent execution and rich output

(defun noema-research--output-context (&optional require-work)
  "Return the D-023 output context at point, optionally REQUIRE-WORK.
The JuText projection is saved first so the runtime reads the canonical file."
  (unless buffer-file-name (user-error "This work document has no file"))
  (when (buffer-modified-p) (save-buffer))
  (let ((cell (noema-research--require-cell)))
    (when (and require-work
               (not (equal (noema-research-cell-kind cell noema-research--document)
                           "work")))
      (user-error "C-c C-c only runs a work block"))
    (list :cell-id (noema-research-cell-id cell)
          :script-file (expand-file-name buffer-file-name)
          :project-root (noema-research-repository-root buffer-file-name))))

(defun noema-research--output-payload (context &optional run-id)
  "Return right-side renderer payload for CONTEXT and optional RUN-ID."
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
      ,@(when run-id `((runId . ,run-id))))))

(defun noema-research-open-outputs (&optional focus)
  "Show this `.noema' document in Emacs' right-side rich-output view.
With FOCUS non-nil (interactively, with a prefix), select the output window."
  (interactive "P")
  (unless (fboundp 'my/noema-jupyter-output-open-document)
    (user-error "Noema's Jupyter output renderer is unavailable"))
  (let ((context (noema-research--output-context)))
    (my/noema-jupyter-output-open-document
     (noema-research--output-payload context) focus)))

(defun noema-research--project-run-body (context project-file args confirmed)
  "Return host request for CONTEXT, PROJECT-FILE, ARGS and CONFIRMED policy."
  (let ((host-path (lambda (path)
                     (if (fboundp 'my/noema--host-file)
                         (my/noema--host-file path)
                       path))))
    (vector
     (noema-research--table
      "file" (funcall host-path (plist-get context :script-file))
      "cellId" (plist-get context :cell-id)
      "projectFile" (funcall host-path project-file)
      "root" (funcall host-path (plist-get context :project-root))
      "cwd" (funcall host-path (plist-get context :project-root))
      "interpreter" noema-research-python-interpreter
      "args" (vconcat args)
      "confirmed" (and confirmed t)))))

;;;###autoload
(defun noema-research-run-project-file (project-file &optional args)
  "Run repository PROJECT-FILE from the current Work without an agent.
`.py' stdout/stderr streams into the Run OutputArea; `.ipynb' MIME outputs use
the same JupyterLab renderer as ordinary notebook cells.  Generated or changed
project files are linked back to the Work as immutable Artifacts."
  (interactive
   (let* ((context (noema-research--output-context t))
          (root (plist-get context :project-root))
          (file
           (read-file-name
            "Run project .py or .ipynb: " root nil t nil
            (lambda (candidate)
              (or (file-directory-p candidate)
                  (string-match-p "\\.\\(?:py\\|ipynb\\)\\'" candidate)))))
          (arguments (if (string-suffix-p ".py" file t)
                         (split-string-and-unquote (read-string "Python arguments: "))
                       nil)))
     (list file arguments)))
  (let* ((context (noema-research--output-context t))
         (root (file-truename (plist-get context :project-root)))
         (project-file (file-truename (expand-file-name project-file))))
    (unless (file-in-directory-p project-file root)
      (user-error "Project-file Run must stay inside %s" root))
    (unless (string-match-p "\\.\\(?:py\\|ipynb\\)\\'" project-file)
      (user-error "Project-file Run supports only .py and .ipynb"))
    (unless (yes-or-no-p
             (format "Run %s locally? It may execute code and modify project files. The frozen Run will record the default capability policy. "
                     (file-relative-name project-file root)))
      (user-error "Project-file Run cancelled"))
    (unless (and (fboundp 'my/noema--ensure-server)
                 (fboundp 'my/noema-api-call))
      (user-error "Noema web-host integration is unavailable"))
    (let ((request (noema-research--project-run-body context project-file args t)))
      (message "Noema project-file Run waiting for web-host")
      (my/noema--ensure-server
       (lambda ()
         (my/noema-api-call
          "aaronnote:api:research:run:project-file" request
          (lambda (result error-object)
            (if error-object
                (message "Noema project-file Run failed: %s"
                         (or (and (hash-table-p error-object) (gethash "message" error-object))
                             (and (listp error-object) (alist-get 'message error-object))
                             "request failed"))
              (let* ((run (and (hash-table-p result) (gethash "run" result)))
                     (run-id (and (hash-table-p run) (gethash "id" run))))
                (when (fboundp 'my/noema-jupyter-output-open-document)
                  (my/noema-jupyter-output-open-document
                   (noema-research--output-payload context run-id) nil))
                (message "Noema project-file Run started%s"
                         (if run-id (format ": %s" run-id) "")))))
          30000))))))

;;;###autoload
(defun noema-research-open-workspace (&optional focus-graph)
  "Compatibility name for opening the Graph dock below JuText.
FOCUS-GRAPH is accepted for callers from the earlier workspace layout."
  (interactive "P")
  (unless (derived-mode-p 'noema-research-mode)
    (user-error "Not in a research notebook"))
  (ignore focus-graph)
  (noema-research-graph-open))

(defun noema-research-sync-graph ()
  "Sync the DAG to this JuText block, docking the DAG when it is not shown.
This is the only cursor-to-DAG path: the DAG never follows the cursor on its
own.  Focus stays in JuText."
  (interactive)
  (unless (derived-mode-p 'noema-research-mode)
    (user-error "Not in a research notebook"))
  (let* ((entry (noema-research--entry-at-point (noema-research--scan)))
         (id (and entry (plist-get entry :work-node-id)))
         (source (current-buffer)))
    (noema-research-graph-dock source)
    (noema-research-graph-follow-source source id)
    (message "Noema DAG synced%s"
             (if id
                 (format " to “%s”" (noema-research-work-node-label
                                     noema-research--document id))
               " to this document"))))

(defun noema-research--schedule-default-output ()
  "Open this document's default DAG and OutputArea once its window settles."
  (when (timerp noema-research--output-timer)
    (cancel-timer noema-research--output-timer))
  (let ((source (current-buffer)))
    (setq noema-research--output-timer
          (run-at-time
           0 nil
           (lambda ()
             (when (buffer-live-p source)
               (with-current-buffer source
                 (setq noema-research--output-timer nil)
                 ;; Dock the DAG first so OutputArea then splits the whole
                 ;; JuText/DAG column and the DAG stays bottom-left.
                 (when noema-research-open-graph-on-visit
                   (condition-case error-object
                       (noema-research-graph-dock source)
                     (error
                      (message "Noema default DAG unavailable: %s"
                               (error-message-string error-object)))))
                 (when noema-research-open-output-on-visit
                   (condition-case error-object
                       (noema-research-open-outputs nil)
                     (error
                      (message "Noema default OutputArea unavailable: %s"
                               (error-message-string error-object))))))))))))

(defun noema-research--cancel-output-timer ()
  "Cancel this buffer's pending default OutputArea open."
  (when (timerp noema-research--output-timer)
    (cancel-timer noema-research--output-timer))
  (setq noema-research--output-timer nil))

(defun noema-research--kernel-disabled ()
  "Explain the D-023 execution boundary."
  (user-error ".noema has no Jupyter kernel; run a work block through an agent"))

(defun noema-research-execute-current ()
  "Run the current D-023 work block through the configured ACP agent."
  (interactive)
  (noema-run-cell))

(defun noema-research-execute-all ()
  "Reject notebook-style run-all for a D-023 work document."
  (interactive)
  (noema-research--kernel-disabled))

(defun noema-research-clear-current-output ()
  "Clear the current work block's persisted agent output."
  (interactive)
  (let ((cell (noema-research--require-cell)))
    (noema-research-clear-cell-outputs
     noema-research--document (noema-research-cell-id cell))
    (set-buffer-modified-p t)
    (save-buffer)
    (message "Noema work output cleared")))

(defun noema-research-clear-all-outputs ()
  "Clear all persisted agent outputs in the current `.noema' document."
  (interactive)
  (noema-research-mode--sync)
  (dolist (cell (noema-research-cells noema-research--document))
    (when (equal (noema-research-cell-kind cell noema-research--document) "work")
      (puthash "execution_count" :null cell)
      (puthash "outputs" [] cell)))
  (set-buffer-modified-p t)
  (save-buffer)
  (message "Noema work outputs cleared"))

(defun noema-research-interrupt ()
  "Cancel an active agent Run."
  (interactive)
  (call-interactively #'noema-agent-worker-cancel-run))

(defun noema-research-interrupt-current ()
  "Cancel the Noema execution of the work cell at point.
A running Run is cancelled, a queued one is dropped, and one still being
prepared is cancelled as soon as it exists."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (what (and buffer-file-name
                    (noema-agent-worker-cancel-cell buffer-file-name
                                                    (noema-research-cell-id cell)))))
    (pcase what
      ('run (message "Cancelling this cell's Run"))
      ('queued (message "Dropped this cell's queued execution"))
      ('preparing (message "This cell's Run will be cancelled as soon as it is prepared"))
      (_ (user-error "This cell has no running or queued Noema execution")))))

(defun noema-research-restart-kernel ()
  "Reject Jupyter restart for `.noema'."
  (interactive)
  (noema-research--kernel-disabled))

(defun noema-research-shutdown-kernel ()
  "Reject Jupyter shutdown for `.noema'."
  (interactive)
  (noema-research--kernel-disabled))

(defun noema-research--jupyter-kernel-choices (catalog)
  "Compatibility shim: CATALOG has no meaning for `.noema'."
  (ignore catalog)
  nil)

(defun noema-research-select-kernel ()
  "Reject Jupyter session selection for `.noema'."
  (interactive)
  (noema-research--kernel-disabled))

(defun noema-research-accept-jupyter-runtime (snapshot)
  "Compatibility callback that merges D-023 outputs from disk.
SNAPSHOT is ignored; the `.noema' file is the sole durable authority."
  (ignore snapshot)
  (noema-research-merge-disk-outputs))

;;;; Commands

(defun noema-research-set-document-default-agent (agent)
  "Set the current work document's default AGENT."
  (interactive
   (list (completing-read "Default agent (empty clears): "
                          (noema-agent-acp-known-agents) nil nil nil nil
                          (noema-research-default-agent noema-research--document))))
  (noema-research-mode--sync)
  (noema-research-set-default-agent noema-research--document agent)
  (set-buffer-modified-p t)
  (save-buffer)
  (message "Noema default agent: %s" (if (string-empty-p agent) "configuration default" agent)))

(defun noema-research-migrate-d023 ()
  "Explicitly migrate the current legacy work document to D-023."
  (interactive)
  (unless buffer-file-name (user-error "This work document has no file"))
  (when (buffer-modified-p)
    (user-error "Save or discard edits before migration"))
  (unless (fboundp 'my/noema-jupyter-cell--api-sync)
    (user-error "Noema host integration is unavailable"))
  (let* ((root (noema-research-repository-root buffer-file-name))
         (result (my/noema-jupyter-cell--api-sync
                  "aaronnote:api:research:notebook:migrate"
                  `((file . ,(expand-file-name buffer-file-name))
                    (cwd . ,root)) 120))
         (migrated (or (noema-research--get result "migrated")
                       (and (listp result) (alist-get 'migrated result)))))
    (revert-buffer :ignore-auto :noconfirm)
    (message "Noema D-023 migration: %s" (if migrated "completed" "already current"))))

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
    (unless entry
      (user-error "“%s” has no Cell in this buffer"
                  (noema-research-work-node-label noema-research--document id)))
    (goto-char (plist-get entry :header-beg))))

(defun noema-research--graph-anchor (cell)
  "Return the graph cell id that work created at CELL continues from."
  (let ((kind (noema-research-cell-kind cell noema-research--document)))
    (cond
     ((member kind noema-research-graph-kinds) (noema-research-cell-work-node-id cell))
     (t (cl-loop with anchor = nil
                 for other in (noema-research-cells noema-research--document)
                 when (eq other cell) return anchor
                 when (member (noema-research-cell-kind other noema-research--document) noema-research-graph-kinds)
                 do (setq anchor (noema-research-cell-work-node-id other))
                 finally return anchor)))))

(defun noema-research--entry-graph-p (entry)
  "Return non-nil when scanned ENTRY is a WorkNode header."
  (member (car (noema-research--parse-header (plist-get entry :text)))
          noema-research-graph-kinds))

(defun noema-research--insert-cell (kind parents)
  "Insert a KIND header after the block at point with lineage PARENTS.
The header goes after the enclosing WorkNode's trailing notes, so those
notes stay with their node.  Point is left where the title is typed."
  (let* ((entries (noema-research--scan))
         (entry (noema-research--entry-at-point entries))
         (position (point-max)))
    (when entry
      (setq position (plist-get entry :block-end))
      (let ((tail (cdr (memq entry entries))))
        (while (and tail (not (noema-research--entry-graph-p (car tail))))
          (setq position (plist-get (car tail) :block-end)
                tail (cdr tail)))))
    (goto-char position)
    (when (and (= position (point-max)) (not (bobp)))
      (unless (bolp) (insert "\n"))
      (unless (save-excursion (forward-line -1) (looking-at-p "^$"))
        (insert "\n")))
    (let ((beg (point)))
      (insert "%% " kind " ")
      (when parents
        (put-text-property beg (point) 'noema-research-lineage parents))
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
    (noema-research--insert-cell (or kind "work") (and parent (list parent)))))

(defun noema-research-new-checkpoint ()
  "Record a checkpoint continuing from the cell at point."
  (interactive)
  (noema-research-continue "checkpoint"))

(defun noema-research-new-sibling ()
  "Create work that shares every lineage parent of the node at point."
  (interactive)
  (let* ((cell (noema-research--cell-at-point))
         (anchor (and cell (noema-research--graph-anchor cell))))
    (noema-research--insert-cell
     "work" (and anchor (noema-research-relation-parents
                         noema-research--document anchor "lineage")))))

(defun noema-research-new-question ()
  "Append a new research question."
  (interactive)
  (goto-char (point-max))
  (noema-research--insert-cell "question" nil))

(defun noema-research-insert-code ()
  "Reject programming-language blocks in a D-023 work document."
  (interactive)
  (user-error ".noema work documents cannot contain programming-language code"))

(defun noema-research-bind-current-cell ()
  "Bind the Cell at point to a WorkNode chosen by label.
A header Cell, or any Cell of a node without a header Cell, becomes that
node's header; otherwise the Cell becomes a supporting note with its own
title."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (current (noema-research-cell-work-node-id cell))
         (target (noema-research-read-work-node
                  "Bind this Cell to WorkNode: "
                  (noema-research-work-node-choices
                   noema-research--document
                   :predicate (lambda (id) (not (equal id current)))))))
    (noema-research-op-bind-cell (noema-research-cell-id cell) target)))

(defun noema-research-unbind-current-cell ()
  "Unbind the Cell at point while preserving its WorkNode.
A work header Cell becomes a note and loses its latest output, because an
unbound note cannot own Agent Run output."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (node (or (noema-research-work-node-for-cell noema-research--document cell)
                   (user-error "This Cell is not bound to a WorkNode"))))
    (unless (yes-or-no-p (format "Unbind this Cell and keep WorkNode “%s”? "
                                 (noema-research-work-node-label
                                  noema-research--document
                                  (noema-research-work-node-id node))))
      (user-error "Unbind cancelled"))
    (noema-research-op-unbind-cell (noema-research-cell-id cell))))

(defun noema-research-delete-current-cell ()
  "Delete the Cell at point while preserving its WorkNode and DAG edges."
  (interactive)
  (let* ((cell (noema-research--require-cell))
         (node (noema-research-work-node-for-cell noema-research--document cell)))
    (unless (yes-or-no-p
             (if node
                 (format "Delete this Cell and keep WorkNode “%s”? "
                         (noema-research-work-node-label
                          noema-research--document (noema-research-work-node-id node)))
               "Delete this note Cell? "))
      (user-error "Cell deletion cancelled"))
    (noema-research-op-delete-cell (noema-research-cell-id cell))))

(defun noema-research-delete-current-work-node ()
  "Delete the WorkNode at point; its Cells stay as notes.
When the node has both parents and children, choose whether the children
are reconnected to its parents or detached."
  (interactive)
  (let* ((id (noema-research--node-at-point))
         (policy (noema-research-read-delete-policy noema-research--document id)))
    (noema-research-op-delete-node id (eq policy 'reconnect))))

;;;; Structure operations
;;
;; Every operation is one validated, undoable structure edit addressed by a
;; stable WorkNode or Cell id.  JuText commands pass the id at point; the
;; Graph Board passes its selection to the very same operations and readers.

(defun noema-research--node-at-point ()
  "Return the WorkNode id of the Cell at point, or signal a `user-error'."
  (let ((cell (noema-research--require-cell)))
    (or (and (noema-research-work-node-for-cell noema-research--document cell)
             (noema-research-cell-work-node-id cell))
        (user-error "This Cell is a note; bind it to a WorkNode first (C-c C-b)"))))

(defun noema-research--completion-table (choices)
  "Return a completion table over CHOICES that keeps their given order."
  (lambda (string predicate action)
    (if (eq action 'metadata)
        '(metadata (display-sort-function . identity)
                   (cycle-sort-function . identity))
      (complete-with-action action choices string predicate))))

(defun noema-research-read-work-node (prompt choices)
  "Read one WorkNode id among CHOICES, (LABEL . ID) pairs, with PROMPT."
  (unless choices (user-error "No eligible WorkNode"))
  (let ((choice (completing-read prompt (noema-research--completion-table choices) nil t)))
    (or (cdr (assoc choice choices))
        (user-error "No WorkNode selected"))))

(defun noema-research-read-work-nodes (prompt choices initial)
  "Read WorkNode ids among CHOICES with PROMPT, starting from INITIAL ids."
  (let ((labels (delq nil (mapcar (lambda (id) (car (rassoc id choices))) initial))))
    (delete-dups
     (mapcar (lambda (choice)
               (or (cdr (assoc choice choices))
                   (user-error "Unknown WorkNode: %s" choice)))
             (completing-read-multiple prompt (noema-research--completion-table choices)
                                       nil t (string-join labels ","))))))

(defun noema-research-read-title (prompt &optional initial)
  "Read a non-empty WorkNode title with PROMPT and INITIAL input."
  (let ((title (string-trim (read-string prompt initial))))
    (when (string-empty-p title) (user-error "A title is required"))
    title))

(defun noema-research-read-kind (prompt &optional default)
  "Read a WorkNode kind with PROMPT, defaulting to DEFAULT."
  (let ((kind (completing-read prompt noema-research-graph-kinds nil t nil nil default)))
    (when (string-empty-p kind) (user-error "No kind selected"))
    kind))

(defun noema-research--parent-choices (document id type)
  "Choices that can become TYPE parents of ID without closing a cycle."
  (let ((existing (noema-research-relation-parents document id type)))
    (noema-research-work-node-choices
     document :near id
     :predicate (lambda (candidate)
                  (and (not (equal candidate id))
                       (not (member candidate existing))
                       (not (noema-research-dependency-reaches-p document candidate id)))))))

(defun noema-research--child-choices (document id type)
  "Choices that can become TYPE children of ID without closing a cycle."
  (let ((existing (noema-research-relation-children document id type)))
    (noema-research-work-node-choices
     document :near id
     :predicate (lambda (candidate)
                  (and (not (equal candidate id))
                       (not (member candidate existing))
                       (not (noema-research-dependency-reaches-p document id candidate)))))))

(defun noema-research--link-choices (document id linked)
  "Choices naming the LINKED ids around ID, including missing WorkNodes."
  (append (noema-research-work-node-choices
           document :near id :predicate (lambda (candidate) (member candidate linked)))
          (let ((ordinal 0))
            (delq nil (mapcar (lambda (other)
                                (unless (noema-research-find-work-node document other)
                                  (cons (format "missing WorkNode ⟨%d⟩" (cl-incf ordinal))
                                        other)))
                              linked)))))

(defun noema-research-read-move-parent (document id)
  "Read the new lineage parent of WorkNode ID; nil makes ID a root."
  (let* ((root "(no parent: make it a root)")
         (choices (cons (cons root nil)
                        (noema-research-work-node-choices
                         document :near id
                         :predicate (lambda (candidate)
                                      (and (not (equal candidate id))
                                           (not (noema-research-dependency-reaches-p
                                                 document candidate id)))))))
         (choice (completing-read (format "Move “%s” under: "
                                          (noema-research-work-node-label document id))
                                  (noema-research--completion-table choices) nil t)))
    (unless (assoc choice choices) (user-error "No new parent selected"))
    (cdr (assoc choice choices))))

(defun noema-research-read-kind-change (document id)
  "Read a new kind for WorkNode ID, confirming before agent output is dropped."
  (let* ((label (noema-research-work-node-label document id))
         (current (noema-research-work-node-field
                   (noema-research-find-work-node document id) "kind"))
         (kind (completing-read (format "Change “%s” from %s to: " label current)
                                (remove current noema-research-graph-kinds) nil t)))
    (when (string-empty-p kind) (user-error "No kind selected"))
    (when-let* (((equal current "work"))
                (primary (noema-research-primary-cell document id))
                ((noema-research-cell-outputs primary))
                ((not (yes-or-no-p (format "“%s” has agent output; drop it and make it a %s? "
                                           label kind)))))
      (user-error "Kind change cancelled"))
    kind))

(defun noema-research-read-outcome (document id)
  "Read an outcome for work ID in DOCUMENT; the empty string clears it."
  (completing-read (format "Outcome of “%s” (empty clears): "
                           (noema-research-work-node-label document id))
                   noema-research-work-outcomes nil t))

(defun noema-research-read-delete-policy (document id)
  "Ask how deleting WorkNode ID treats its links: `reconnect' or `detach'."
  (let* ((label (noema-research-work-node-label document id))
         (cells (length (noema-research-work-node-cells document id)))
         (linked (lambda (function)
                   (seq-some (lambda (type) (funcall function document id type))
                             noema-research-relation-types))))
    (if (and (funcall linked #'noema-research-relation-parents)
             (funcall linked #'noema-research-relation-children))
        (pcase (car (read-multiple-choice
                     (format "Delete “%s” (%d Cell(s) stay as notes)" label cells)
                     '((?r "reconnect" "link its children to its parents")
                       (?d "detach" "its children lose these links")
                       (?q "cancel" "keep the WorkNode"))))
          (?r 'reconnect)
          (?d 'detach)
          (_ (user-error "WorkNode deletion cancelled")))
      (unless (yes-or-no-p (format "Delete WorkNode “%s” (%d Cell(s) stay as notes)? "
                                   label cells))
        (user-error "WorkNode deletion cancelled"))
      'detach)))

(defun noema-research--demote-cell (cell title)
  "Turn CELL into an unbound note titled TITLE."
  (puthash "cell_type" "markdown" cell)
  (remhash "execution_count" cell)
  (remhash "outputs" cell)
  (noema-research-cell-set cell "work_node_id" nil)
  (noema-research-cell-set cell "kind" nil)
  (noema-research-cell-set cell "title" title))

(defun noema-research-op-create (kind title parents after-id)
  "Create a KIND WorkNode titled TITLE with lineage PARENTS; return its id.
Its block follows AFTER-ID's block, or is appended when AFTER-ID is nil."
  (noema-research-structure-edit
   (format "create %s “%s”" kind title)
   (lambda (document)
     (noema-research-create-work-node
      document kind title :parents parents
      :after (and after-id (noema-research-work-node-block-end document after-id))))))

(defun noema-research-op-rename (id title)
  "Rename WorkNode ID to TITLE; identity and edges are unchanged."
  (noema-research-structure-edit
   (format "rename “%s”" title)
   (lambda (document)
     (let ((id (noema-research--require-node-id document id)))
       (noema-research-work-node-set (noema-research-find-work-node document id)
                                     "title" (string-trim title))
       id))))

(defun noema-research-op-set-kind (id kind)
  "Change WorkNode ID to KIND."
  (noema-research-structure-edit
   (format "make “%s” a %s" (noema-research-work-node-label noema-research--document id) kind)
   (lambda (document) (noema-research-set-work-node-kind document id kind))))

(defun noema-research-op-move (id parent &optional relocate)
  "Make PARENT the only lineage parent of ID; nil PARENT makes ID a root.
With RELOCATE, ID's block follows PARENT's block in the document."
  (noema-research-structure-edit
   "move a WorkNode"
   (lambda (document)
     (noema-research-set-relation document id "lineage" (and parent (list parent)))
     (when-let* ((relocate)
                 (parent)
                 (cell (noema-research-primary-cell document id))
                 (unit (noema-research-cell-unit document cell))
                 (anchor (noema-research-work-node-block-end document parent))
                 ((not (memq anchor unit))))
       (noema-research-move-cells document unit anchor))
     id)))

(defun noema-research-op-link (from to type)
  "Add the TYPE edge FROM -> TO."
  (noema-research-structure-edit
   (format "link %s" type)
   (lambda (document) (noema-research-add-relation document from to type) to)))

(defun noema-research-op-unlink (from to type)
  "Remove the TYPE edge FROM -> TO."
  (noema-research-structure-edit
   (format "unlink %s" type)
   (lambda (document)
     (unless (noema-research-remove-relation document from to type)
       (user-error "No such %s link" type))
     to)))

(defun noema-research-op-set-parents (id type parents)
  "Replace every TYPE parent of ID with PARENTS."
  (noema-research-structure-edit
   (format "set %s parents" type)
   (lambda (document) (noema-research-set-relation document id type parents) id)))

(defun noema-research-op-delete-node (id &optional reconnect)
  "Delete WorkNode ID, keeping its Cells as notes; return a neighbour id.
With RECONNECT, its children are first linked to its parents."
  (noema-research-structure-edit
   (if reconnect "delete a WorkNode and reconnect its children" "delete a WorkNode")
   (lambda (document)
     (let* ((id (noema-research--require-node-id document id))
            (title (noema-research-work-node-field
                    (noema-research-find-work-node document id) "title"))
            (primary (noema-research-primary-cell document id))
            (neighbour (or (car (noema-research-relation-parents document id "lineage"))
                           (car (noema-research-relation-parents document id "depends"))
                           (car (noema-research-relation-children document id "lineage")))))
       (dolist (cell (noema-research-work-node-cells document id))
         (noema-research--demote-cell
          cell (if (eq cell primary) title (noema-research-cell-field cell "title"))))
       (noema-research-delete-work-node document id nil reconnect)
       neighbour))))

(defun noema-research-op-unbind-cell (cell-id)
  "Unbind Cell CELL-ID from its WorkNode; return that WorkNode id."
  (noema-research-structure-edit
   "unbind a Cell"
   (lambda (document)
     (let* ((cell (or (noema-research-find-cell document cell-id) (user-error "Unknown Cell")))
            (node (or (noema-research-work-node-for-cell document cell)
                      (user-error "This Cell is not bound to a WorkNode"))))
       (noema-research--demote-cell
        cell (if (noema-research-cell-primary-p document cell)
                 (noema-research-work-node-field node "title")
               (noema-research-cell-field cell "title")))
       (noema-research-work-node-id node)))))

(defun noema-research-op-delete-cell (cell-id)
  "Delete Cell CELL-ID, keeping its WorkNode; return that WorkNode id."
  (noema-research-structure-edit
   "delete a Cell"
   (lambda (document)
     (let ((cell (or (noema-research-find-cell document cell-id) (user-error "Unknown Cell"))))
       (puthash "cells" (vconcat (delq cell (noema-research-cells document))) document)
       (noema-research-cell-work-node-id cell)))))

(defun noema-research-op-bind-cell (cell-id work-node-id)
  "Bind Cell CELL-ID to WORK-NODE-ID and return the WorkNode id.
A header Cell, or any Cell of a node without a header Cell, becomes the
node's header Cell.  Otherwise the Cell becomes a supporting note that keeps
its own title."
  (noema-research-structure-edit
   "bind a Cell"
   (lambda (document)
     (let* ((cell (or (noema-research-find-cell document cell-id) (user-error "Unknown Cell")))
            (target (noema-research--require-node-id document work-node-id))
            (node (noema-research-find-work-node document target))
            (label (noema-research-work-node-label document target))
            (occupied (seq-some (lambda (other)
                                  (and (not (eq other cell))
                                       (noema-research-cell-graph-p document other)))
                                (noema-research-work-node-cells document target))))
       (when (equal (noema-research-cell-work-node-id cell) target)
         (user-error "This Cell is already bound to “%s”" label))
       (if (not occupied)
           (progn
             (noema-research-cell-set cell "title" nil)
             (noema-research-bind-cell document cell
                                       (noema-research-work-node-field node "kind")
                                       (or (noema-research-work-node-field node "title") "")
                                       target))
         (when (noema-research-cell-graph-p document cell)
           (user-error "“%s” already has a header Cell; make this header a note first" label))
         (let ((title (noema-research-cell-title cell document)))
           (when (string-empty-p title)
             ;; An untitled note would be indistinguishable from a header Cell.
             (setq title (or (seq-find (lambda (line) (not (string-empty-p line)))
                                       (mapcar #'string-trim
                                               (split-string (noema-research-cell-source cell)
                                                             "\n")))
                             "Supporting note")
                   title (truncate-string-to-width title 60)))
           (noema-research-cell-set cell "work_node_id" target)
           (noema-research-cell-set cell "title" title)))
       target))))

(defun noema-research-op-attach-cell (id)
  "Create a header Cell for Cell-less WorkNode ID; return ID."
  (noema-research-structure-edit
   "create a Cell for a WorkNode"
   (lambda (document)
     (let ((parent (car (noema-research-relation-parents document id "lineage"))))
       (noema-research-attach-cell
        document id :after (and parent (noema-research-work-node-block-end document parent)))
       id))))

(defun noema-research-op-set-state (id state &optional reason outcome)
  "Set work ID's STATE; REASON explains a drop.  Non-nil OUTCOME is set too."
  (noema-research-structure-edit
   (format "set state %s" state)
   (lambda (document)
     (noema-research-set-state document id state reason)
     (when outcome (noema-research-set-outcome document id outcome))
     id)))

(defun noema-research-op-set-outcome (id outcome)
  "Set work ID's OUTCOME; the empty string clears it."
  (noema-research-structure-edit
   (if (noema-research--string outcome) (format "set outcome %s" outcome) "clear outcome")
   (lambda (document) (noema-research-set-outcome document id outcome) id)))

(defun noema-research-op-shift-block (cell-id direction)
  "Move Cell CELL-ID's block one block `up' or `down' (DIRECTION)."
  (noema-research-structure-edit
   (format "move a block %s" direction)
   (lambda (document)
     (noema-research-shift-block
      document (or (noema-research-find-cell document cell-id) (user-error "Unknown Cell"))
      direction)
     cell-id)))

(defun noema-research--apply-relation-command (document id type direction action)
  "Prompt for and apply one TYPE link change around ID in DOCUMENT; return ID.
DIRECTION is `parent' or `child'; ACTION is `add' or `remove'."
  (let* ((label (noema-research-work-node-label document id))
         (noun (if (equal type "lineage")
                   (if (eq direction 'parent) "lineage parent" "lineage child")
                 (if (eq direction 'parent) "dependency" "dependent")))
         (linked (if (eq direction 'parent)
                     (noema-research-relation-parents document id type)
                   (noema-research-relation-children document id type))))
    (pcase action
      ('add
       (let ((choices (if (eq direction 'parent)
                          (noema-research--parent-choices document id type)
                        (noema-research--child-choices document id type))))
         (unless choices
           (user-error "No WorkNode can become a %s of “%s” without a cycle" noun label))
         (let ((other (noema-research-read-work-node
                       (format "Add %s of “%s”: " noun label) choices)))
           (if (eq direction 'parent)
               (noema-link other id type)
             (noema-link id other type)))))
      ('remove
       (unless linked (user-error "“%s” has no %s" label noun))
       (let ((other (noema-research-read-work-node
                     (format "Remove %s of “%s”: " noun label)
                     (noema-research--link-choices document id linked))))
         (if (eq direction 'parent)
             (noema-unlink other id type)
           (noema-unlink id other type)))))
    id))

(defun noema-research--rewrite-relation (document id type)
  "Replace every TYPE parent of ID in DOCUMENT with a chosen set; return ID."
  (let* ((current (noema-research-relation-parents document id type))
         (choices (noema-research-work-node-choices
                   document :near id
                   :predicate (lambda (candidate)
                                (or (member candidate current)
                                    (and (not (equal candidate id))
                                         (not (noema-research-dependency-reaches-p
                                               document candidate id))))))))
    (noema-research-op-set-parents
     id type
     (noema-research-read-work-nodes
      (format "%s parents of “%s”: " (capitalize type)
              (noema-research-work-node-label document id))
      choices current))
    id))

(defun noema-research--relation-command (type direction action)
  "Apply one TYPE link change in DIRECTION with ACTION around the node at point."
  (noema-research--apply-relation-command
   noema-research--document (noema-research--node-at-point) type direction action))

(defun noema-research-add-lineage-parent ()
  "Add one lineage parent to the WorkNode at point."
  (interactive)
  (noema-research--relation-command "lineage" 'parent 'add))

(defun noema-research-remove-lineage-parent ()
  "Remove one lineage parent from the WorkNode at point."
  (interactive)
  (noema-research--relation-command "lineage" 'parent 'remove))

(defun noema-research-add-lineage-child ()
  "Make another WorkNode a lineage child of the WorkNode at point."
  (interactive)
  (noema-research--relation-command "lineage" 'child 'add))

(defun noema-research-remove-lineage-child ()
  "Detach one lineage child from the WorkNode at point."
  (interactive)
  (noema-research--relation-command "lineage" 'child 'remove))

(defun noema-research-add-depends-parent ()
  "Add one hard dependency to the WorkNode at point."
  (interactive)
  (noema-research--relation-command "depends" 'parent 'add))

(defun noema-research-remove-depends-parent ()
  "Remove one hard dependency from the WorkNode at point."
  (interactive)
  (noema-research--relation-command "depends" 'parent 'remove))

(defun noema-research-add-depends-child ()
  "Make another WorkNode depend on the WorkNode at point."
  (interactive)
  (noema-research--relation-command "depends" 'child 'add))

(defun noema-research-remove-depends-child ()
  "Remove one WorkNode's dependency on the WorkNode at point."
  (interactive)
  (noema-research--relation-command "depends" 'child 'remove))

(defun noema-research-edit-lineage ()
  "Rewrite the whole lineage parent set of the WorkNode at point."
  (interactive)
  (noema-research--rewrite-relation
   noema-research--document (noema-research--node-at-point) "lineage"))

(defun noema-research-edit-depends ()
  "Rewrite the whole hard-dependency set of the WorkNode at point."
  (interactive)
  (noema-research--rewrite-relation
   noema-research--document (noema-research--node-at-point) "depends"))

(defun noema-research-rename-work-node ()
  "Rename the WorkNode at point; its identity and edges stay the same."
  (interactive)
  (let ((id (noema-research--node-at-point)))
    (noema-research-op-rename
     id (noema-research-read-title
         "New title: " (noema-research-work-node-field
                        (noema-research-find-work-node noema-research--document id)
                        "title")))))

(defun noema-research-move-work-node (&optional stay)
  "Move the WorkNode at point under another lineage parent.
Its block follows the new parent's block unless STAY (prefix argument) or
`noema-research-move-relocates-block' is nil."
  (interactive "P")
  (let* ((id (noema-research--node-at-point))
         (parent (noema-research-read-move-parent noema-research--document id)))
    (noema-research-op-move id parent (and noema-research-move-relocates-block (not stay)))
    (noema-research-goto-cell id)))

(defun noema-research-change-work-node-kind ()
  "Change the WorkNode at point to question, work or checkpoint."
  (interactive)
  (let ((id (noema-research--node-at-point)))
    (noema-research-op-set-kind id (noema-research-read-kind-change noema-research--document id))))

(defun noema-research-set-work-outcome ()
  "Set or clear the outcome of the work at point."
  (interactive)
  (let ((id (noema-research--node-at-point)))
    (noema-research-op-set-outcome id (noema-research-read-outcome noema-research--document id))))

(defun noema-research-set-work-state (state &optional outcome)
  "Set the work at point to STATE.
With a prefix argument, also prompt for OUTCOME (empty clears it)."
  (interactive
   (list (completing-read "State: " noema-research-work-states nil t)
         (when current-prefix-arg
           (completing-read "Outcome (empty clears): "
                            noema-research-work-outcomes nil nil))))
  (let* ((id (noema-research--node-at-point))
         (reason (when (equal state "dropped")
                   (read-string "Reason (optional): "))))
    (noema-set-node-state id state reason outcome)))

(defun noema-research--shift-block-at-point (direction)
  "Move the block at point one block in DIRECTION, keeping point inside it."
  (let* ((cell (noema-research--require-cell))
         (id (noema-research-cell-id cell))
         (offset (- (point) (plist-get (noema-research--entry-at-point) :header-beg))))
    (noema-research-op-shift-block id direction)
    (noema-research-goto-cell id)
    (goto-char (min (point-max) (+ (point) offset)))))

(defun noema-research-move-block-up ()
  "Move the block at point above the previous block."
  (interactive)
  (noema-research--shift-block-at-point 'up))

(defun noema-research-move-block-down ()
  "Move the block at point below the next block."
  (interactive)
  (noema-research--shift-block-at-point 'down))

(transient-define-prefix noema-research-lineage-menu ()
  "Edit the lineage links of the WorkNode at point."
  [["Parents"
    ("a" "add parent" noema-research-add-lineage-parent)
    ("r" "remove parent" noema-research-remove-lineage-parent)
    ("p" "rewrite all parents" noema-research-edit-lineage)]
   ["Children"
    ("c" "add child" noema-research-add-lineage-child)
    ("x" "remove child" noema-research-remove-lineage-child)]
   ["Position"
    ("m" "move under another parent" noema-research-move-work-node)]])

(transient-define-prefix noema-research-depends-menu ()
  "Edit the hard dependencies of the WorkNode at point."
  [["Depends on"
    ("a" "add dependency" noema-research-add-depends-parent)
    ("r" "remove dependency" noema-research-remove-depends-parent)
    ("D" "rewrite all dependencies" noema-research-edit-depends)]
   ["Required by"
    ("c" "add dependent" noema-research-add-depends-child)
    ("x" "remove dependent" noema-research-remove-depends-child)]])

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
    (unless (locate-dominating-file (file-name-directory path) "noema.toml")
      (noema-project-enable (file-name-directory path)))
    (noema-research-write-file path (noema-research-create-document title))
    (find-file path)
    (unless (derived-mode-p 'noema-research-mode)
      (noema-research-mode))))

(defun noema-research-op-set-branch-state (id state &optional reason)
  "Set STATE on work ID and its branch as one structure edit.
The affected WorkNodes are `noema-research-branch-state-targets'.  REASON
explains a drop and is recorded on ID.  Return ID."
  (noema-research-structure-edit
   (format "set branch state %s" state)
   (lambda (document)
     (let ((targets (noema-research-branch-state-targets document id state)))
       (unless targets
         (user-error "“%s” has no work whose state can become %s"
                     (noema-research-work-node-label document id) state))
       (dolist (target targets)
         (noema-research-set-state document target state
                                   (and (equal target id) reason))))
     id)))

(defun noema-research-branch-done ()
  "Mark the work at point and its branch done."
  (interactive)
  (noema-research-op-set-branch-state (noema-research--node-at-point) "done"))

(defun noema-research-branch-drop ()
  "Drop the work at point and its branch, prompting for a reason."
  (interactive)
  (let ((id (noema-research--node-at-point)))
    (noema-research-op-set-branch-state id "dropped" (read-string "Reason (optional): "))))

(defun noema-research-branch-reopen ()
  "Reopen the work at point and its branch."
  (interactive)
  (noema-research-op-set-branch-state (noema-research--node-at-point) "open"))

(transient-define-prefix noema-research-branch-menu ()
  "Change the state of the branch at point as one structure edit."
  [["Branch"
    ("d" "mark branch done" noema-research-branch-done)
    ("x" "drop branch" noema-research-branch-drop)
    ("o" "reopen branch" noema-research-branch-reopen)]])

(defconst noema-research--command-return-bindings
  '(("s-<return>" . noema-research-open-outputs)
    ("M-<return>" . noema-research-open-outputs)
    ("s-S-<return>" . noema-research-sync-graph)
    ("M-S-<return>" . noema-research-sync-graph))
  "Command-Return keys.  AaronEmacs maps Command to Meta, so both spellings.")

(defun noema-research--context-menu-map ()
  "Return the JuText right-click menu for the block at point."
  (let ((map (make-sparse-keymap "Noema")))
    (define-key-after map [noema-sync-dag]
      '(menu-item "Sync DAG to this block" noema-research-sync-graph
                  :keys "Cmd-Shift-RET"))
    (define-key-after map [noema-sync-output]
      '(menu-item "Sync OutputArea to this block" noema-research-open-outputs
                  :keys "Cmd-RET"))
    (define-key-after map [noema-separator] menu-bar-separator)
    (define-key-after map [noema-run]
      '(menu-item "Run work block" noema-research-execute-current))
    (define-key-after map [noema-branch]
      '(menu-item "Branch…" noema-research-branch-menu))
    (define-key-after map [noema-inspect]
      '(menu-item "Inspect" noema-research-inspect))
    (define-key-after map [noema-capabilities]
      '(menu-item "Skill/MCP libraries…" noema-capability-manager))
    (define-key-after map [noema-settings]
      '(menu-item "Settings" noema-research-settings))
    map))

(defun noema-research-context-menu (event)
  "Move point to mouse EVENT and pop up the JuText block menu."
  (interactive "e")
  (mouse-set-point event)
  (popup-menu (noema-research--context-menu-map) event))

(defun noema-research--context-menu-function (menu click)
  "Add JuText block actions to `context-menu-mode' MENU for CLICK."
  (mouse-set-point click)
  (define-key-after menu [noema-context-separator] menu-bar-separator)
  (map-keymap (lambda (key binding) (define-key-after menu (vector key) binding))
              (noema-research--context-menu-map))
  menu)

(defvar noema-research-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-n") #'noema-research-continue)
    (define-key map (kbd "C-c C-s") #'noema-research-new-sibling)
    (define-key map (kbd "C-c C-k") #'noema-research-new-checkpoint)
    (define-key map (kbd "C-c C-q") #'noema-research-new-question)
    (define-key map (kbd "C-c C-p") #'noema-research-lineage-menu)
    (define-key map (kbd "C-c C-d") #'noema-research-depends-menu)
    (define-key map (kbd "C-c C-t") #'noema-research-set-work-state)
    (define-key map (kbd "C-c C-i") #'noema-research-open-outputs)
    (define-key map (kbd "C-c C-a") #'noema-research-attention)
    (define-key map (kbd "C-c C-r") #'noema-research-propose-with-magent)
    (define-key map (kbd "C-c C-g") #'noema-research-graph-open)
    ;; Command-Return syncs OutputArea (Jupyter's convention);
    ;; Command-Shift-Return syncs the DAG, which never follows the cursor.
    (dolist (binding noema-research--command-return-bindings)
      (define-key map (kbd (car binding)) (cdr binding)))
    (define-key map [mouse-3] #'noema-research-context-menu)
    (define-key map (kbd "C-c C-c") #'noema-research-execute-current)
	(define-key map (kbd "C-c j r") #'noema-run-project-file)
    (define-key map (kbd "C-c C-o") #'noema-research-open-outputs)
    (define-key map (kbd "C-c C-z") #'noema-research-interrupt-current)
    (define-key map (kbd "C-c j x") #'noema-research-clear-current-output)
    (define-key map (kbd "C-c j X") #'noema-research-clear-all-outputs)
    (define-key map (kbd "C-c j u") #'noema-research-unbind-current-cell)
    (define-key map (kbd "C-c j d") #'noema-research-delete-current-cell)
    (define-key map (kbd "C-c j w") #'noema-research-delete-current-work-node)
    (define-key map (kbd "C-c j i") #'noema-research-inspect)
    (define-key map (kbd "C-c j n") #'noema-research-rename-work-node)
    (define-key map (kbd "C-c j m") #'noema-research-move-work-node)
    (define-key map (kbd "C-c j k") #'noema-research-change-work-node-kind)
    (define-key map (kbd "C-c j o") #'noema-research-set-work-outcome)
    (define-key map (kbd "C-c j B") #'noema-research-branch-menu)
    (define-key map (kbd "C-c j C") #'noema-capability-manager)
    (define-key map (kbd "C-c j ,") #'noema-research-settings)
    (define-key map (kbd "C-c j S") #'noema-sessions)
    (define-key map (kbd "C-c j s") #'noema-research-pin-session)
    (define-key map (kbd "M-<up>") #'noema-research-move-block-up)
    (define-key map (kbd "M-<down>") #'noema-research-move-block-down)
    (define-key map (kbd "C-c C-/") #'noema-research-structure-undo)
    (define-key map (kbd "C-c M-/") #'noema-research-structure-redo)
    (define-key map (kbd "C-c C-b") #'noema-research-bind-current-cell)
    (define-key map (kbd "C-c C-f") #'noema-research-set-document-default-agent)
    (define-key map (kbd "C-c M-m") #'noema-research-migrate-d023)
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
  (setq-local revert-buffer-function #'noema-research--revert))

(defun noema-research--initialize-document ()
  "Initialize a real JuText editing buffer after its mode hooks are enabled.
Preview consumers such as Company/Yasnippet use `delay-mode-hooks' to
borrow syntax highlighting.  They must not load the visited document,
register file watches, start agents, or rearrange the workspace."
  (add-hook 'completion-at-point-functions
            #'noema-research-completion-at-point nil t)
  (add-hook 'kill-buffer-hook #'noema-research-completion--cancel nil t)
  (noema-research-completion-refresh)
  (add-hook 'write-contents-functions #'noema-research-mode--write-contents nil t)
  (add-hook 'after-change-functions #'noema-research--schedule-decorations nil t)
  (add-hook 'kill-buffer-hook #'noema-research--cancel-output-timer nil t)
  (add-hook 'context-menu-functions #'noema-research--context-menu-function nil t)
  ;; Evil state maps would otherwise shadow Command-Return in JuText.
  (when (fboundp 'evil-local-set-key)
    (dolist (state '(normal insert visual))
      (dolist (binding noema-research--command-return-bindings)
        (evil-local-set-key state (kbd (car binding)) (cdr binding)))))
  ;; D-034: this buffer owns its disk sync.  Other Noema writers (Run
  ;; outputs, accepted Proposals) merge in place through a file watch, never
  ;; through auto-revert's reload or the stale-file prompt.
  (setq-local global-auto-revert-ignore-buffer t)
  (add-hook 'kill-buffer-hook #'noema-research--unwatch-file nil t)
  (let* ((file buffer-file-name)
         (on-disk (and file (file-exists-p file))))
    (noema-research--load (if on-disk
                              (noema-research-read-file file)
                            (noema-research-normalize-document
                             (noema-research-parse-json (buffer-string))))
                          (and on-disk (noema-research-file-revision file)))
    (when on-disk
      (set-visited-file-modtime)
      (noema-research-notify-host file "jutext.open")
      (noema-research--watch-file)
      ;; D-035: the project's Pi manager starts with its first document and
      ;; stops after the project's last document closes.
      (when (require 'noema-pi-router nil t)
        (noema-pi-router-note-visit (current-buffer)))
      (noema-research--schedule-session-routes)
      (when (and (or noema-research-open-output-on-visit
                     noema-research-open-graph-on-visit)
                 (not noninteractive))
        (noema-research--schedule-default-output)))))

;; Run before ordinary user hooks, but respect syntax-only mode activation.
(add-hook 'noema-research-mode-hook #'noema-research--initialize-document -100)

(provide 'noema-research-mode)

;;; noema-research-mode.el ends here
