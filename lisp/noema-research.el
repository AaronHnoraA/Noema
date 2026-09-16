;;; noema-research.el --- Noema research notebook model -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Noema work documents are standard nbformat 4.5 JSON containers stored as
;; `*.noema'; their research semantics live under the `noema_research'
;; metadata namespace.  This library
;; is the pure model shared by JuText (`noema-research-mode') and the Graph
;; Board: JSON reading and writing, cell accessors, relations, validation, the
;; lineage projection with semantic folding, and per-notebook view state under
;; `<repository>/.agent/views/'.  It never writes `metadata.noema', which
;; belongs to Markdown sidecar notebooks.
;;
;; JSON objects are hash tables, arrays are vectors, and null/false are the
;; keywords `:null' and `:false', so documents round-trip without loss.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'project)
(require 'seq)
(require 'subr-x)

(defconst noema-research-schema "noema.work-document/2"
  "Schema identifier stored in `metadata.noema_research.schema'.")

(defconst noema-research-legacy-schema "noema.research-notebook/1"
  "Legacy schema whose graph identity lived directly on cells.")

(defconst noema-research-namespace "noema_research"
  "Notebook and cell metadata namespace owned by research notebooks.")

(defconst noema-research-graph-kinds '("question" "work" "checkpoint")
  "Cell kinds that are nodes of the research graph.")

(defconst noema-research-kinds nil
  "Canonical cell roles stored in `noema_research.kind'.
D-023 derives every role from storage type plus its WorkNode binding.")

(defconst noema-research-work-states '("open" "active" "waiting" "done" "dropped")
  "Allowed work states.")

(defconst noema-research-work-outcomes
  '("supported" "refuted" "inconclusive" "dead_end" "superseded")
  "Allowed work outcomes.")

(defconst noema-research-relation-types '("lineage" "depends")
  "Declared WorkNode dependency types.")

(defconst noema-research-state-directory ".agent"
  "Repository-local runtime state directory.")

(define-error 'noema-research-revision-conflict
  "Research notebook changed on disk")

;;;; JSON

(defun noema-research-parse-json (text)
  "Parse notebook JSON TEXT into hash tables and vectors."
  (json-parse-string text :object-type 'hash-table :array-type 'array
                     :null-object :null :false-object :false))

(defun noema-research--json-scalar (value)
  "Return scalar VALUE encoded as JSON text, as a character string.
`json-serialize' returns unibyte UTF-8 on newer Emacsen; inserting those raw
bytes would make the serialized document unparseable in memory."
  (let ((json (json-serialize (vector value) :null-object :null :false-object :false)))
    (substring (if (multibyte-string-p json) json (decode-coding-string json 'utf-8))
               1 -1)))

(defun noema-research--json-insert (value indent)
  "Insert VALUE as JSON indented like `JSON.stringify(value, null, 2)'.
INDENT is the current indentation width."
  (let ((inner (make-string (+ indent 2) ?\s))
        (outer (make-string indent ?\s)))
    (cond
     ((hash-table-p value)
      (if (zerop (hash-table-count value))
          (insert "{}")
        (insert "{")
        (let ((first t))
          (maphash (lambda (key item)
                     (insert (if first "\n" ",\n") inner
                             (noema-research--json-scalar (format "%s" key))
                             ": ")
                     (setq first nil)
                     (noema-research--json-insert item (+ indent 2)))
                   value))
        (insert "\n" outer "}")))
     ((vectorp value)
      (if (zerop (length value))
          (insert "[]")
        (insert "[")
        (let ((first t))
          (seq-doseq (item value)
            (insert (if first "\n" ",\n") inner)
            (setq first nil)
            (noema-research--json-insert item (+ indent 2))))
        (insert "\n" outer "]")))
     ((eq value t) (insert "true"))
     ((eq value :false) (insert "false"))
     ((or (eq value :null) (null value)) (insert "null"))
     ((or (stringp value) (numberp value))
      (insert (noema-research--json-scalar value)))
     (t (error "Cannot encode %S as JSON" value)))))

(defun noema-research-serialize (document)
  "Return DOCUMENT as notebook JSON text with a trailing newline.
The layout matches the Node host's `JSON.stringify(notebook, null, 2)', so
either side can write the file without spurious diffs."
  (with-temp-buffer
    (noema-research--json-insert document 0)
    (insert "\n")
    (buffer-string)))

;;;; Tables

(defun noema-research--table (&rest pairs)
  "Return a hash table built from alternating key/value PAIRS."
  (let ((table (make-hash-table :test #'equal)))
    (while pairs
      (puthash (car pairs) (cadr pairs) table)
      (setq pairs (cddr pairs)))
    table))

(defun noema-research--get (table key &optional default)
  "Return KEY from hash TABLE, or DEFAULT."
  (if (hash-table-p table) (gethash key table default) default))

(defun noema-research--string (value)
  "Return VALUE when it is a non-empty string."
  (and (stringp value) (not (string-empty-p value)) value))

;;;; Identity

(defun noema-research--uuidv7 ()
  "Return a new UUIDv7 string."
  (let* ((millis (format "%012x" (floor (* (float-time) 1000))))
         (random (secure-hash 'sha256 (format "%s:%s:%s:%s" (float-time)
                                              (random) (emacs-pid) (random)))))
    (format "%s-%s-7%s-%x%s-%s"
            (substring millis 0 8) (substring millis 8 12)
            (substring random 0 3)
            (+ 8 (% (string-to-number (substring random 3 4) 16) 4))
            (substring random 4 7)
            (substring random 7 19))))

(defun noema-research-new-cell-id (&optional taken)
  "Return a fresh nbformat cell id that is not a key of hash TAKEN.
The id is recorded in TAKEN when TAKEN is non-nil."
  (let (id)
    (while (or (null id) (and taken (gethash id taken)))
      (setq id (concat "c-" (substring (secure-hash
                                        'sha256
                                        (format "%s:%s:%s" (float-time)
                                                (random) (emacs-pid)))
                                       0 12))))
    (when taken (puthash id t taken))
    id))

(defun noema-research-new-work-node-id (&optional taken)
  "Return a fresh durable WorkNode id not present in hash TAKEN."
  (let (id)
    (while (or (null id) (and taken (gethash id taken)))
      (setq id (concat "wn_" (noema-research--uuidv7))))
    (when taken (puthash id t taken))
    id))

;;;; Documents

(defun noema-research-notebook-meta (document)
  "Return DOCUMENT's research notebook metadata table."
  (noema-research--get (noema-research--get document "metadata")
                       noema-research-namespace))

(defun noema-research-notebook-p (document)
  "Return non-nil when DOCUMENT is a Noema research notebook."
  (member (noema-research--get (noema-research-notebook-meta document) "schema")
          (list noema-research-schema noema-research-legacy-schema)))

(defun noema-research-notebook-id (document)
  "Return DOCUMENT's notebook id, or the empty string."
  (or (noema-research--string
       (noema-research--get (noema-research-notebook-meta document) "notebook_id"))
      ""))

(defun noema-research-notebook-title (document)
  "Return DOCUMENT's title, or the empty string."
  (or (noema-research--string
       (noema-research--get (noema-research-notebook-meta document) "title"))
      ""))

(defun noema-research-default-agent (document)
  "Return DOCUMENT's configured default agent, or the empty string."
  (or (noema-research--string
       (noema-research--get (noema-research-notebook-meta document) "default_agent"))
      ""))

(defun noema-research-set-default-agent (document agent)
  "Set DOCUMENT's default AGENT; an empty value clears it."
  (let ((value (string-trim (or agent ""))))
    (when (and (not (string-empty-p value))
               (not (string-match-p "\\`[A-Za-z0-9][A-Za-z0-9._-]*\\'" value)))
      (user-error "Invalid agent id: %s" value))
    (if (string-empty-p value)
        (remhash "default_agent" (noema-research-notebook-meta document))
      (puthash "default_agent" value (noema-research-notebook-meta document))))
  document)

(defun noema-research-create-document (&optional title)
  "Return a new empty research notebook document titled TITLE."
  (noema-research--table
   "cells" []
   "metadata"
   (noema-research--table
    noema-research-namespace
    (noema-research--table "schema" noema-research-schema
                           "notebook_id" (concat "nb_" (noema-research--uuidv7))
                           "workstream_id" (concat "ws_" (noema-research--uuidv7))
                           "title" (string-trim (or title ""))
                           "work_nodes" []
                           "dependencies" []))
   "nbformat" 4
   "nbformat_minor" 5))

(defun noema-research-cells (document)
  "Return DOCUMENT's cells as a list."
  (let ((cells (noema-research--get document "cells")))
    (if (vectorp cells) (append cells nil) nil)))

(defun noema-research-work-nodes (document)
  "Return DOCUMENT's durable WorkNodes as a list."
  (let ((nodes (noema-research--get (noema-research-notebook-meta document)
                                    "work_nodes")))
    (if (vectorp nodes) (append nodes nil) nil)))

(defun noema-research-dependencies (document)
  "Return DOCUMENT's WorkNode dependencies as a list."
  (let ((edges (noema-research--get (noema-research-notebook-meta document)
                                    "dependencies")))
    (if (vectorp edges) (append edges nil) nil)))

(defun noema-research--set-work-nodes (document nodes)
  "Replace DOCUMENT's WorkNodes with NODES."
  (puthash "work_nodes" (vconcat nodes) (noema-research-notebook-meta document)))

(defun noema-research--set-dependencies (document dependencies)
  "Replace DOCUMENT's WorkNode dependencies with DEPENDENCIES."
  (puthash "dependencies" (vconcat dependencies) (noema-research-notebook-meta document)))

(defun noema-research-work-node-id (node)
  "Return NODE's durable id."
  (noema-research--get node "id"))

(defvar noema-research--lookup nil
  "While non-nil, (DOCUMENT NODES CELLS) indexing DOCUMENT for lookups.
NODES maps WorkNode ids to WorkNodes; CELLS maps them to bound Cells in
document order.  Bound only around passes that do not change structure.")

(defun noema-research--lookup-for (document)
  "Return the active lookup index when it indexes DOCUMENT."
  (and noema-research--lookup (eq (car noema-research--lookup) document)
       noema-research--lookup))

(defun noema-research--build-lookup (document)
  "Return a lookup index for DOCUMENT."
  (let ((nodes (make-hash-table :test #'equal))
        (cells (make-hash-table :test #'equal)))
    (dolist (node (noema-research-work-nodes document))
      (puthash (noema-research-work-node-id node) node nodes))
    (dolist (cell (reverse (noema-research-cells document)))
      (when-let* ((id (noema-research-cell-work-node-id cell)))
        (push cell (gethash id cells))))
    (list document nodes cells)))

(defmacro noema-research-with-lookup (document &rest body)
  "Run BODY with constant-time WorkNode and bound-Cell lookups for DOCUMENT.
BODY must not add, remove or rebind WorkNodes or Cells of DOCUMENT."
  (declare (indent 1) (debug t))
  (let ((value (make-symbol "document")))
    `(let* ((,value ,document)
            (noema-research--lookup (or (noema-research--lookup-for ,value)
                                        (noema-research--build-lookup ,value))))
       ,@body)))

(defun noema-research-find-work-node (document id)
  "Return WorkNode ID in DOCUMENT, or nil."
  (and id
       (if-let* ((lookup (noema-research--lookup-for document)))
           (gethash id (nth 1 lookup))
         (seq-find (lambda (node) (equal (noema-research-work-node-id node) id))
                   (noema-research-work-nodes document)))))

(defun noema-research-work-node-field (node key)
  "Return non-empty string KEY from WorkNode NODE."
  (noema-research--string (noema-research--get node key)))

(defun noema-research-work-node-set (node key value)
  "Set KEY on WorkNode NODE, removing it for nil or empty VALUE."
  (if (or (null value) (and (stringp value) (string-empty-p value)))
      (remhash key node)
    (puthash key value node)))

(defun noema-research-cell-work-node-id (cell)
  "Return CELL's bound WorkNode id, or nil."
  (noema-research-cell-field cell "work_node_id"))

(defun noema-research-work-node-for-cell (document cell)
  "Return the WorkNode bound to CELL in DOCUMENT."
  (noema-research-find-work-node document (noema-research-cell-work-node-id cell)))

(defun noema-research-resolve-work-node-id (document id)
  "Resolve WorkNode or cell ID to a WorkNode id in DOCUMENT."
  (cond ((noema-research-find-work-node document id) id)
        ((noema-research-find-cell document id)
         (noema-research-cell-work-node-id (noema-research-find-cell document id)))))

(defun noema-research-primary-cell (document work-node-id)
  "Return the canonical cell bound to WORK-NODE-ID, else any bound cell.
The primary Cell carries the WorkNode's JuText header.  Other bound Cells are
supporting notes; they keep a Cell-level title, which is how a question or
checkpoint primary is told apart from a supporting note in the same storage."
  (let* ((node (noema-research-find-work-node document work-node-id))
         (kind (noema-research-work-node-field node "kind"))
         (bound (noema-research-work-node-cells document work-node-id))
         (matching (seq-filter (lambda (cell)
                                 (equal (noema-research--get cell "cell_type")
                                        (if (equal kind "work") "code" "markdown")))
                               bound)))
    (or (seq-find (lambda (cell) (not (noema-research-cell-field cell "title"))) matching)
        (car matching)
        (car bound))))

(defun noema-research-cell-primary-p (document cell)
  "Return non-nil when CELL is the primary Cell of its WorkNode in DOCUMENT."
  (when-let* ((id (noema-research-cell-work-node-id cell)))
    (eq (noema-research-primary-cell document id) cell)))

(defun noema-research-cell-supporting-p (document cell)
  "Return non-nil when CELL is a supporting note bound to a WorkNode."
  (and (noema-research-work-node-for-cell document cell)
       (not (noema-research-cell-primary-p document cell))))

(defun noema-research-work-node-cells (document id)
  "Return every Cell of DOCUMENT bound to WorkNode ID, in document order."
  (and id
       (if-let* ((lookup (noema-research--lookup-for document)))
           (gethash id (nth 2 lookup))
         (seq-filter (lambda (cell) (equal (noema-research-cell-work-node-id cell) id))
                     (noema-research-cells document)))))

(defun noema-research-work-node-label (document id)
  "Return a human label for WorkNode ID in DOCUMENT; never a machine id."
  (let* ((node (noema-research-find-work-node document id))
         (title (noema-research-work-node-field node "title")))
    (or title
        (format "untitled %s" (or (noema-research-work-node-field node "kind") "node")))))

(defun noema-research--dependency-id (from to type)
  "Return deterministic identity for dependency FROM to TO of TYPE."
  (concat "dep_" (substring (secure-hash 'sha256
                                          (concat from "\0" to "\0" type))
                             0 24)))

(defun noema-research--legacy-work-node-id (document cell-id)
  "Return deterministic migration WorkNode id for CELL-ID in DOCUMENT."
  (concat "wn_legacy_"
          (substring (secure-hash 'sha256
                                  (concat (noema-research-notebook-id document)
                                          "\0" cell-id))
                     0 24)))

;;;; Cells

(defun noema-research-cell-id (cell)
  "Return CELL's id."
  (noema-research--get cell "id"))

(defun noema-research-cell-meta (cell)
  "Return CELL's research metadata table, or nil."
  (let ((meta (noema-research--get (noema-research--get cell "metadata")
                                   noema-research-namespace)))
    (and (hash-table-p meta) meta)))

(defun noema-research-cell-field (cell key)
  "Return non-empty string KEY from CELL's research metadata."
  (noema-research--string (noema-research--get (noema-research-cell-meta cell) key)))

(defun noema-research-cell-kind (cell &optional document)
  "Return CELL's role, resolving its WorkNode in DOCUMENT when available."
  (let ((legacy (noema-research-cell-field cell "kind"))
        (node (and document (noema-research-work-node-for-cell document cell))))
    (cond
     ((equal legacy "result") "result")
     ((and (equal (noema-research--get cell "cell_type") "code")
           (equal (noema-research-work-node-field node "kind") "work")) "work")
     ((and (equal (noema-research--get cell "cell_type") "code")) "code")
     ((and (member (noema-research-work-node-field node "kind") '("question" "checkpoint"))
           (noema-research-cell-primary-p document cell))
      (noema-research-work-node-field node "kind"))
     (node "note")
     (legacy legacy)
     (t "note"))))

(defun noema-research-cell-title (cell &optional document)
  "Return CELL's WorkNode title in DOCUMENT, or its local title.
A supporting note shows its own title, not the WorkNode's."
  (or (and document
           (not (noema-research-cell-supporting-p document cell))
           (noema-research-work-node-field
            (noema-research-work-node-for-cell document cell) "title"))
      (noema-research-cell-field cell "title") ""))

(defun noema-research-cell-state (cell &optional document)
  "Return CELL's bound WorkNode state in DOCUMENT."
  (and document
       (noema-research-work-node-field
        (noema-research-work-node-for-cell document cell) "state")))

(defun noema-research-cell-outcome (cell &optional document)
  "Return CELL's bound WorkNode outcome in DOCUMENT."
  (and document
       (noema-research-work-node-field
        (noema-research-work-node-for-cell document cell) "outcome")))

(defun noema-research-cell-relation (cell type &optional document)
  "Return CELL's WorkNode TYPE parents from DOCUMENT."
  (let ((id (and document (noema-research-cell-work-node-id cell))))
    (if (not id) nil
      (delete-dups
       (delq nil
             (mapcar (lambda (edge)
                       (and (equal (noema-research--get edge "to") id)
                            (equal (noema-research--get edge "type") type)
                            (noema-research--string (noema-research--get edge "from"))))
                     (noema-research-dependencies document)))))))

(defun noema-research-cell-source (cell)
  "Return CELL's source as a string."
  (let ((source (noema-research--get cell "source" "")))
    (cond ((stringp source) source)
          ((vectorp source)
           (mapconcat (lambda (part) (if (stringp part) part "")) source ""))
          (t ""))))

(defun noema-research-cell-outputs (cell)
  "Return CELL's persisted outputs as a list."
  (let ((outputs (noema-research--get cell "outputs")))
    (if (vectorp outputs) (append outputs nil) nil)))

(defun noema-research-cell-latest-run (cell)
  "Return the latest persisted Agent Run metadata for CELL, or nil.
The returned plist contains :id, :status, :agent and :finished-at when those
fields are present.  Output content is data and is deliberately not parsed for
directives or graph structure."
  (cl-loop for output in (reverse (noema-research-cell-outputs cell))
           for data = (noema-research--get output "data")
           for run = (and (hash-table-p data)
                          (noema-research--get
                           data "application/vnd.noema.run+json"))
           when (hash-table-p run)
           return (list :id (noema-research--string
                             (noema-research--get run "run_id"))
                        :status (noema-research--string
                                 (noema-research--get run "status"))
                        :agent (noema-research--string
                                (noema-research--get run "agent"))
                        :finished-at
                        (or (noema-research--string
                             (noema-research--get run "finished_at"))
                            (noema-research--string
                             (noema-research--get run "finishedAt"))))))

(defun noema-research-clear-cell-outputs (document cell-id)
  "Clear the D-023 work CELL-ID outputs in DOCUMENT."
  (let ((cell (or (noema-research-find-cell document cell-id)
                  (user-error "Unknown research cell: %s" cell-id))))
    (unless (equal (noema-research-cell-kind cell document) "work")
      (user-error "Only work blocks have outputs"))
    (puthash "execution_count" :null cell)
    (puthash "outputs" [] cell))
  document)

(defun noema-research-cell-label (cell &optional document)
  "Return a short human label for CELL."
  (let ((title (noema-research-cell-title cell document)))
    (if (not (string-empty-p title))
        title
      (let ((line (seq-find (lambda (text) (not (string-empty-p text)))
                            (mapcar #'string-trim
                                    (split-string (noema-research-cell-source cell)
                                                  "\n")))))
        (if line
            (truncate-string-to-width line 80)
          (or (noema-research-cell-id cell) ""))))))

(defun noema-research-cell-set (cell key value)
  "Set research metadata KEY of CELL to VALUE.
A nil or empty VALUE removes KEY, and an emptied namespace is removed.  A list
VALUE is stored as a JSON array."
  (let ((metadata (noema-research--get cell "metadata"))
        (meta (noema-research-cell-meta cell)))
    (if (or (null value) (and (stringp value) (string-empty-p value)))
        (when meta
          (remhash key meta)
          (when (zerop (hash-table-count meta))
            (remhash noema-research-namespace metadata)))
      (unless (hash-table-p metadata)
        (setq metadata (make-hash-table :test #'equal))
        (puthash "metadata" metadata cell))
      (unless meta
        (setq meta (make-hash-table :test #'equal))
        (puthash noema-research-namespace meta metadata))
      (puthash key (if (listp value) (vconcat value) value) meta))))

(defun noema-research-find-cell (document id)
  "Return DOCUMENT's cell with ID, or nil."
  (and id
       (seq-find (lambda (cell) (equal (noema-research-cell-id cell) id))
                 (noema-research-cells document))))

(defun noema-research-migrate-legacy-document (document)
  "Upgrade legacy cell-owned graph metadata in DOCUMENT to WorkNodes.
The mapping is deterministic, so opening an unsaved legacy file repeatedly
does not create identity drift.  DOCUMENT is mutated and returned."
  (let ((meta (noema-research-notebook-meta document)))
    (when (equal (noema-research--get meta "schema") noema-research-legacy-schema)
      (let ((bindings (make-hash-table :test #'equal))
            nodes dependencies)
        (dolist (cell (noema-research-cells document))
          (let* ((cell-meta (noema-research-cell-meta cell))
                 (kind (noema-research--get cell-meta "kind")))
            (when (member kind noema-research-graph-kinds)
              (let* ((id (noema-research--legacy-work-node-id
                          document (noema-research-cell-id cell)))
                     (node (noema-research--table
                            "id" id "kind" kind
                            "title" (or (noema-research--get cell-meta "title") ""))))
                (puthash (noema-research-cell-id cell) id bindings)
                (dolist (key '("state" "outcome" "dropped_reason" "disclosure"))
                  (when-let* ((value (noema-research--string
                                     (noema-research--get cell-meta key))))
                    (puthash key value node)))
                (push node nodes)))))
        (setq nodes (nreverse nodes))
        (dolist (cell (noema-research-cells document))
          (let* ((cell-meta (noema-research-cell-meta cell))
                 (target (gethash (noema-research-cell-id cell) bindings)))
            (when target
              (dolist (type noema-research-relation-types)
                (let ((values (noema-research--get cell-meta type)))
                  (seq-doseq (parent-cell (if (vectorp values) values []))
                    (when-let* ((from (gethash parent-cell bindings)))
                      (push (noema-research--table
                             "id" (noema-research--dependency-id from target type)
                             "from" from "to" target "type" type)
                            dependencies)))))
              (dolist (key '("kind" "title" "state" "outcome" "dropped_reason"
                             "disclosure" "lineage" "depends"))
                (noema-research-cell-set cell key nil))
              (noema-research-cell-set cell "work_node_id" target))
            (when (equal (noema-research--get cell-meta "kind") "result")
              (let ((target (gethash (noema-research--get cell-meta "of") bindings)))
                (noema-research-cell-set cell "of" nil)
                (when target (noema-research-cell-set cell "work_node_id" target))))))
        (puthash "schema" noema-research-schema meta)
        (puthash "migrated_from" noema-research-legacy-schema meta)
        (noema-research--set-work-nodes document nodes)
        (noema-research--set-dependencies document (nreverse dependencies))))
    document))

(defun noema-research-normalize-document (document)
  "Return DOCUMENT in the canonical WorkNode-based schema."
  (unless (noema-research-notebook-p document)
    (user-error "Not a Noema work document"))
  (setq document (noema-research-migrate-legacy-document document))
  ;; Agenda used to be hidden under work_nodes[].agenda.  Move that legacy
  ;; value into the primary Cell, then keep the visible directive as the only
  ;; authority.  A WorkNode without a primary Cell is not an Agenda task.
  (dolist (node (noema-research-work-nodes document))
    (unless (eq (gethash "agenda" node :absent) :absent)
      (when-let* ((cell (noema-research-primary-cell
                         document (noema-research-work-node-id node)))
                  ((null (noema-research-agenda-directive
                          (noema-research-cell-source cell)
                          (noema-research-work-node-field node "kind")))))
        (puthash "source"
                 (noema-research-replace-agenda-directive
                  (noema-research-cell-source cell) (gethash "agenda" node)
                  (noema-research-work-node-field node "kind")
                  (noema-research-work-node-field node "title"))
                 cell))
      (remhash "agenda" node)))
  document)

;;;; Relations and state

(defconst noema-research-agenda-keys
  '("sche" "ddl" "end" "prio" "effort" "tags" "context" "project" "status" "done" "progress" "clocks"))

(defun noema-research--agenda-clock-date-p (value)
  (and (stringp value)
       (string-match-p "\\`[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\} [0-9]\\{2\\}:[0-9]\\{2\\}\\'" value)
       (condition-case nil
           (let* ((parts (parse-time-string value))
                  (time (encode-time 0 (nth 1 parts) (nth 2 parts) (nth 3 parts) (nth 4 parts) (nth 5 parts) t)))
             (equal value (format-time-string "%F %H:%M" time t)))
         (error nil))))

(defun noema-research-agenda-clock-errors (clocks)
  "Validate native WorkNode clock records in CLOCKS."
  (if (not (vectorp clocks)) '("agenda.clocks must be an array")
    (let ((ids (make-hash-table :test #'equal)) (running 0) errors)
      (mapc
       (lambda (clock)
         (if (not (hash-table-p clock)) (push "agenda clock must be an object" errors)
           (let ((id (gethash "id" clock)) (from (gethash "from" clock)) (to (gethash "to" clock :absent)))
             (maphash (lambda (key _value)
                        (unless (member key '("id" "from" "to")) (push "unsupported agenda clock field" errors))) clock)
             (unless (and (stringp id) (string-match-p "\\`[A-Za-z0-9_-]\\{1,128\\}\\'" id) (not (gethash id ids)))
               (push "invalid or duplicate agenda clock ID" errors))
             (puthash id t ids)
             (unless (noema-research--agenda-clock-date-p from) (push "agenda clock.from requires a canonical date and time" errors))
             (if (eq to :absent) (cl-incf running)
               (unless (and (noema-research--agenda-clock-date-p to)
                            (stringp from) (not (string-lessp to from)))
                 (push "agenda clock.to must be at or after from" errors)))))) clocks)
      (when (> running 1) (push "a WorkNode may have only one running clock" errors))
      (nreverse errors))))

(defun noema-research-agenda-errors (agenda kind)
  "Return validation errors for native WorkNode AGENDA metadata of KIND."
  (if (not (hash-table-p agenda)) '("agenda must be an object")
    (let (errors)
      (maphash
       (lambda (key value)
         (cond
          ((not (member key noema-research-agenda-keys))
           (push (format "unsupported agenda field: %s" key) errors))
          ((equal key "clocks") (setq errors (append (noema-research-agenda-clock-errors value) errors)))
          ((not (stringp value)) (push (format "agenda.%s must be a string" key) errors))
          ((and (member key '("sche" "ddl" "end" "done")) (not (string-empty-p value)))
           (unless (condition-case nil
                       (and (string-match-p "\\`[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}\\(?: [0-9]\\{2\\}:[0-9]\\{2\\}\\)?\\'" value)
                            (let* ((parts (parse-time-string value))
                                   (time (encode-time 0 (or (nth 1 parts) 0) (or (nth 2 parts) 0)
                                                      (nth 3 parts) (nth 4 parts) (nth 5 parts) t)))
                              (equal value (format-time-string (if (> (length value) 10) "%F %H:%M" "%F") time t))))
                     (error nil))
             (push (format "invalid agenda.%s canonical date" key) errors)))
          ((equal key "prio")
           (unless (or (string-empty-p value) (string-match-p "\\`[A-Z]\\'" value))
             (push "invalid agenda priority" errors)))
          ((equal key "effort")
           (let ((case-fold-search t))
             (unless (or (string-empty-p value)
                         (string-match-p "\\`\\(?:[0-9]+:[0-5][0-9]\\|[0-9]+\\(?:\\.[0-9]+\\)?[ \t]*\\(?:d\\|day\\|days\\|h\\|hour\\|hours\\|m\\|min\\|mins\\|minute\\|minutes\\)?\\)\\'" (string-trim value)))
               (push "invalid agenda effort" errors))))
          ((equal key "progress")
           (unless (or (string-empty-p value)
                       (and (string-match-p "\\`[0-9]+\\(?:\\.[0-9]+\\)?\\'" value)
                            (<= (string-to-number value) 100)))
             (push "agenda.progress must be between 0 and 100" errors)))
          ((equal key "status")
           (when (or (equal kind "work") (not (member value '("todo" "doing" "blocked" "done" "cancelled"))))
             (push "invalid agenda status; work nodes use state" errors))))) agenda)
      (nreverse errors))))

(defun noema-research--agenda-directive-location (source kind)
  "Return (BEG END AGENDA) for leading Markdown planning commands in SOURCE."
  (with-temp-buffer
    (insert (or source ""))
    (goto-char (point-min))
    (let ((agenda nil) clocks beg end done
          (aliases '(("due" . "ddl") ("deadline" . "ddl")
                     ("scheduled" . "sche") ("start" . "sche")
                     ("priority" . "prio") ("proj" . "project")
                     ("ctx" . "context") ("pct" . "progress")
                     ("finish" . "end"))))
      (cl-labels
          ((canonical-key (key)
             (or (cdr (assoc key aliases)) key))
           (parse-pair (text table)
             (setq text (string-trim (string-remove-suffix "," text)))
             (unless (or (string-empty-p text) (string-prefix-p "#" text)
                         (string-prefix-p "//" text))
               (unless (string-match "\\`\\([A-Za-z][A-Za-z0-9_-]*\\)[ \t]*[:=][ \t]*\\(.*\\)\\'" text)
                 (user-error "Malformed planning attribute: %s" text))
               (let* ((key (canonical-key (downcase (match-string 1 text))))
                      (value (string-trim (match-string 2 text) "[\"']+" "[\"']+")))
                 (when (gethash key table) (user-error "Duplicate agenda field: %s" key))
                 (unless (string-empty-p value) (puthash key value table)))))
           (parse-attrs (raw block)
             (let ((table (make-hash-table :test #'equal)))
               (if block
                   (progn
                     (forward-line 1)
                     (let (closed)
                       (while (and (not closed) (not (eobp)))
                         (if (looking-at "^[ \t]*}[ \t]*$")
                             (progn (forward-line 1) (setq closed t))
                           (parse-pair (buffer-substring-no-properties
                                        (line-beginning-position) (line-end-position)) table)
                           (forward-line 1)))
                       (unless closed (user-error "Unclosed planning attribute block"))))
                 (dolist (part (split-string (string-trim raw "{" "}") "," t))
                   (parse-pair part table))
                 (forward-line 1))
               table)))
        (while (and (not done) (not (eobp)))
          (cond
           ((looking-at "^[ \t]*$") (forward-line 1))
           ((looking-at "^@@\\(todo\\|clock\\)\\(?:([^)]*)\\)?[ \t]+\\[.*\\][ \t]*\\({.*\\)$")
            (let* ((command (match-string-no-properties 1))
                   (command-line (match-string-no-properties 0))
                   (raw (match-string-no-properties 2))
                   (status (and (equal command "todo")
                                (when (string-match "^@@todo(\\([^)]*\\))" command-line)
                                  (match-string 1 command-line))))
                   (block (equal (string-trim raw) "{"))
                   (command-beg (line-beginning-position))
                   (attrs (parse-attrs raw block)))
              (unless beg (setq beg command-beg))
              (setq end (point))
              (if (equal command "todo")
                  (progn
                    (when agenda (user-error "Only one leading @@todo is allowed"))
                    (setq agenda attrs)
                    (when (and status (not (string-empty-p status)) (not (equal kind "work")))
                      (puthash "status" status agenda)))
                (unless agenda (user-error "@@clock requires a leading @@todo"))
                (push (apply #'noema-research--table
                             (append (list "id" (or (gethash "id" attrs) "")
                                           "from" (or (gethash "from" attrs) ""))
                                     (and (gethash "to" attrs) (list "to" (gethash "to" attrs)))))
                      clocks))))
           ((and (null agenda) (looking-at "^@@[A-Za-z][A-Za-z0-9_-]*(.*)[ \t]*$"))
            (forward-line 1))
           (t (setq done t))))
      (when agenda
        (when clocks (puthash "clocks" (vconcat (nreverse clocks)) agenda))
        (when-let* ((errors (noema-research-agenda-errors agenda kind)))
          (user-error "%s" (string-join errors "; ")))
        (list beg end agenda))))))

(defun noema-research-agenda-directive (source kind)
  "Return SOURCE's visible leading Agenda object for WorkNode KIND, or nil."
  (nth 2 (noema-research--agenda-directive-location source kind)))

(defun noema-research-format-agenda-directive (agenda kind &optional title)
  "Format AGENDA as Markdown planning commands for WorkNode KIND and TITLE."
  (when-let* ((errors (noema-research-agenda-errors agenda kind)))
    (user-error "%s" (string-join errors "; ")))
  (let* ((safe-title (replace-regexp-in-string "[]\\\\]" "\\\\&" (or title "WorkNode")))
         (status (and (not (equal kind "work")) (gethash "status" agenda)))
         (lines (list (format "@@todo%s [%s] {" (if (and status (not (equal status "todo")))
                                                      (format "(%s)" status) "") safe-title))))
    (dolist (key (remove "clocks" (remove "status" noema-research-agenda-keys)))
      (when-let* ((value (gethash key agenda)) ((not (string-empty-p value))))
        (setq lines (append lines (list (format "  %s: %s" key value))))))
    (setq lines (append lines '("}")))
    (mapc (lambda (clock)
            (setq lines
                  (append lines
                          (list (format "@@clock [%s] {id: %s, from: \"%s\"%s}"
                                        safe-title (gethash "id" clock) (gethash "from" clock)
                                        (if-let* ((to (gethash "to" clock)))
                                            (format ", to: \"%s\"" to) ""))))))
          (append (gethash "clocks" agenda) nil))
    (string-join lines "\n")))

(defun noema-research-replace-agenda-directive (source agenda kind &optional title)
  "Replace SOURCE's leading Agenda block with AGENDA for KIND.
When AGENDA is nil, remove the block."
  (let* ((source (or source ""))
         (location (noema-research--agenda-directive-location source kind)))
    (if location
        (let* ((beg (1- (nth 0 location)))
               (end (1- (nth 1 location)))
               (prefix (substring source 0 beg))
               (suffix (substring source end))
               (middle (and agenda (noema-research-format-agenda-directive agenda kind title))))
          (when (and (null agenda) (string-prefix-p "\n" suffix)
                     (or (string-empty-p prefix) (string-suffix-p "\n" prefix)))
            ;; Insertion separates visible planning commands from the prompt
            ;; with a blank line.  Removing those commands owns that separator
            ;; as well, including when the block starts at byte zero.
            (setq suffix (substring suffix 1)))
          (concat prefix (or middle "") suffix))
      (if (null agenda) source
        (concat (noema-research-format-agenda-directive agenda kind title)
                (if (string-empty-p source) "" "\n\n") source)))))

(defun noema-research-set-agenda (document id patch)
  "Patch the visible Agenda directive of WorkNode ID in DOCUMENT.
PATCH is a string-keyed hash table. Nil removes the node from Agenda.
The node, DAG, prompt and Agent outputs retain their existing identities."
  (let* ((node (or (noema-research-find-work-node document
                                               (noema-research-resolve-work-node-id document id))
                   (user-error "Unknown WorkNode: %s" id)))
         (kind (noema-research-work-node-field node "kind"))
         (cell (or (noema-research-primary-cell document (noema-research-work-node-id node))
                   (user-error "A WorkNode needs a primary Cell before it can join Agenda")))
         (agenda (copy-hash-table (or (noema-research-agenda-directive
                                       (noema-research-cell-source cell) kind)
                                      (make-hash-table :test #'equal)))))
    (when (and (null patch)
               (seq-some (lambda (clock) (eq (gethash "to" clock :absent) :absent))
                         (append (gethash "clocks" agenda) nil)))
      (user-error "Stop the running clock before removing Agenda metadata"))
    (if (null patch)
        (puthash "source" (noema-research-replace-agenda-directive
                           (noema-research-cell-source cell) nil kind
                           (noema-research-work-node-field node "title")) cell)
      (unless (hash-table-p patch) (user-error "Agenda patch must be a hash table"))
      (maphash (lambda (key value)
                 (if (or (null value) (equal value "")) (remhash key agenda)
                   (puthash key (if (and (equal key "clocks") (vectorp value))
                                    (vconcat (mapcar (lambda (clock) (if (hash-table-p clock) (copy-hash-table clock) clock)) value))
                                  value) agenda))) patch)
      (when-let* ((errors (noema-research-agenda-errors agenda kind)))
        (user-error "%s" (string-join errors "; ")))
      (puthash "source" (noema-research-replace-agenda-directive
                         (noema-research-cell-source cell) agenda kind
                         (noema-research-work-node-field node "title")) cell))
    (remhash "agenda" node)
    node))

(defun noema-research--work-node-table (document)
  "Return a hash from WorkNode id to WorkNode for DOCUMENT."
  (let ((table (make-hash-table :test #'equal)))
    (dolist (node (noema-research-work-nodes document) table)
      (puthash (noema-research-work-node-id node) node table))))

(defun noema-research-dependency-reaches-p (document from target &optional types)
  "Return non-nil when TARGET is reachable from FROM through dependency parents.
TYPES defaults to every relation type in the work DAG."
  (let ((nodes (noema-research--work-node-table document))
        (types (or types noema-research-relation-types))
        (seen (make-hash-table :test #'equal))
        (stack (list from))
        found)
    (while (and stack (not found))
      (let ((id (pop stack)))
        (cond
         ((equal id target) (setq found t))
         ((gethash id seen))
         (t
          (puthash id t seen)
          (when (gethash id nodes)
            (dolist (edge (noema-research-dependencies document))
              (when (and (equal (noema-research--get edge "to") id)
                         (member (noema-research--get edge "type") types))
                (push (noema-research--get edge "from") stack))))))))
    found))

(defun noema-research-depends-reaches-p (document from target)
  "Compatibility wrapper for depends-only reachability."
  (noema-research-dependency-reaches-p document from target '("depends")))

(defun noema-research-depends-cycle-p (document)
  "Return non-nil when DOCUMENT's depends relation contains a cycle."
  (seq-some
   (lambda (node)
     (let* ((id (noema-research-work-node-id node))
            (cell (noema-research-primary-cell document id)))
       (seq-some (lambda (parent)
                   (noema-research-depends-reaches-p document parent id))
                 (and cell (noema-research-cell-relation cell "depends" document)))))
   (noema-research-work-nodes document)))

(defun noema-research-dependency-cycle-p (document)
  "Return non-nil when DOCUMENT's combined WorkNode dependency graph cycles."
  (seq-some
   (lambda (edge)
     (noema-research-dependency-reaches-p
      document
      (noema-research--get edge "from")
      (noema-research--get edge "to")))
   (noema-research-dependencies document)))

(defun noema-research-set-relation (document id type parents)
  "Set WorkNode or cell ID's TYPE dependency parents in DOCUMENT."
  (unless (member type noema-research-relation-types)
    (user-error "Unsupported relation type: %s" type))
  (let* ((target (or (noema-research-resolve-work-node-id document id)
                     (user-error "Unknown WorkNode: %s" id)))
         (parents (delete-dups
                   (mapcar (lambda (parent)
                             (or (noema-research-resolve-work-node-id document parent)
                                 (user-error "Unknown WorkNode: %s" parent)))
                           parents))))
    (dolist (parent parents)
      (when (equal parent target)
        (user-error "A WorkNode cannot be its own %s parent" type))
      (when (noema-research-dependency-reaches-p document parent target)
        (user-error "Linking from %s would form a work-DAG cycle" parent)))
    (let ((kept (seq-remove
                 (lambda (edge)
                   (and (equal (noema-research--get edge "to") target)
                        (equal (noema-research--get edge "type") type)))
                 (noema-research-dependencies document))))
      (dolist (parent parents)
        (setq kept
              (append kept
                      (list (noema-research--table
                             "id" (noema-research--dependency-id parent target type)
                             "from" parent "to" target "type" type)))))
      (noema-research--set-dependencies document kept))
    (noema-research-find-work-node document target)))

(defun noema-research-relation-parents (document id type)
  "Return the TYPE parent WorkNode ids of ID in DOCUMENT, in edge order."
  (delete-dups
   (delq nil (mapcar (lambda (edge)
                       (and (equal (noema-research--get edge "to") id)
                            (equal (noema-research--get edge "type") type)
                            (noema-research--string (noema-research--get edge "from"))))
                     (noema-research-dependencies document)))))

(defun noema-research-relation-children (document id type)
  "Return the TYPE child WorkNode ids of ID in DOCUMENT, in edge order."
  (delete-dups
   (delq nil (mapcar (lambda (edge)
                       (and (equal (noema-research--get edge "from") id)
                            (equal (noema-research--get edge "type") type)
                            (noema-research--string (noema-research--get edge "to"))))
                     (noema-research-dependencies document)))))

(defun noema-research--require-node-id (document id)
  "Resolve WorkNode or cell ID in DOCUMENT or signal a `user-error'."
  (or (noema-research-resolve-work-node-id document id)
      (user-error "Unknown WorkNode: %s" id)))

(defun noema-research-add-relation (document from to type)
  "Add one TYPE edge FROM -> TO in DOCUMENT; return nil when it already exists."
  (unless (member type noema-research-relation-types)
    (user-error "Unsupported relation type: %s" type))
  (let ((from (noema-research--require-node-id document from))
        (to (noema-research--require-node-id document to)))
    (when (equal from to)
      (user-error "A WorkNode cannot be its own %s parent" type))
    (unless (member from (noema-research-relation-parents document to type))
      (when (noema-research-dependency-reaches-p document from to)
        (user-error "Linking “%s” → “%s” would form a work-DAG cycle"
                    (noema-research-work-node-label document from)
                    (noema-research-work-node-label document to)))
      (noema-research--set-dependencies
       document
       (append (noema-research-dependencies document)
               (list (noema-research--table
                      "id" (noema-research--dependency-id from to type)
                      "from" from "to" to "type" type))))
      t)))

(defun noema-research-remove-relation (document from to type)
  "Remove the TYPE edge FROM -> TO from DOCUMENT; return nil when absent."
  (let* ((edges (noema-research-dependencies document))
         (kept (seq-remove (lambda (edge)
                             (and (equal (noema-research--get edge "from") from)
                                  (equal (noema-research--get edge "to") to)
                                  (equal (noema-research--get edge "type") type)))
                           edges)))
    (unless (= (length kept) (length edges))
      (noema-research--set-dependencies document kept)
      t)))

(defun noema-research-strip-references (document removed)
  "Remove WorkNode ids in REMOVED and every dependency touching them."
  (noema-research--set-dependencies
   document
   (seq-remove (lambda (edge)
                 (or (member (noema-research--get edge "from") removed)
                     (member (noema-research--get edge "to") removed)))
               (noema-research-dependencies document))))

(defun noema-research--require-work (document id)
  "Return work WorkNode for node or cell ID in DOCUMENT."
  (let* ((resolved (or (noema-research-resolve-work-node-id document id)
                       (user-error "Unknown WorkNode: %s" id)))
         (node (noema-research-find-work-node document resolved)))
    (unless (equal (noema-research-work-node-field node "kind") "work")
      (user-error "State only applies to work WorkNodes"))
    node))

(defun noema-research-set-state (document id state &optional reason)
  "Set work cell ID's STATE in DOCUMENT; REASON explains a drop."
  (let ((node (noema-research--require-work document id)))
    (unless (member state noema-research-work-states)
      (user-error "Unsupported work state: %s" state))
    (noema-research-work-node-set node "state" state)
    (noema-research-work-node-set node "dropped_reason"
                                  (and (equal state "dropped") reason
                                       (string-trim reason)))
    node))

(defun noema-research-set-outcome (document id outcome)
  "Set work cell ID's OUTCOME in DOCUMENT; nil or empty clears it."
  (let ((node (noema-research--require-work document id)))
    (when (and (noema-research--string outcome)
               (not (member outcome noema-research-work-outcomes)))
      (user-error "Unsupported work outcome: %s" outcome))
    (noema-research-work-node-set node "outcome" outcome)
    node))

(defun noema-research-bind-cell (document cell kind title &optional work-node-id)
  "Bind CELL to a WorkNode of KIND and TITLE in DOCUMENT.
Reuse WORK-NODE-ID when supplied; otherwise create an independent WorkNode."
  (let* ((id (or (noema-research-resolve-work-node-id document work-node-id)
                 (noema-research-new-work-node-id)))
         (node (noema-research-find-work-node document id)))
    (unless node
      (setq node (noema-research--table "id" id "kind" kind "title" (or title "")))
      (when (equal kind "work") (puthash "state" "open" node))
      (noema-research--set-work-nodes
       document (append (noema-research-work-nodes document) (list node))))
    (puthash "kind" kind node)
    (puthash "title" (or title "") node)
    (if (equal kind "work")
        (unless (noema-research-work-node-field node "state")
          (puthash "state" "open" node))
      (dolist (key '("state" "outcome" "dropped_reason")) (remhash key node)))
    (noema-research-cell-set cell "work_node_id" id)
    (if (equal kind "work")
        (progn
          (puthash "cell_type" "code" cell)
          (puthash "execution_count" :null cell)
          (unless (vectorp (noema-research--get cell "outputs"))
            (puthash "outputs" [] cell))
          (remhash "attachments" cell))
      (puthash "cell_type" "markdown" cell)
      (remhash "execution_count" cell)
      (remhash "outputs" cell))
    node))

(defun noema-research-delete-work-node (document id &optional delete-cells reconnect)
  "Delete WorkNode ID and its dependencies from DOCUMENT.
When DELETE-CELLS is non-nil, also delete all bound cells; otherwise unbind
the ordinary cells.  With RECONNECT, every child keeps its provenance: for
each relation type the child is linked to each of ID's parents of that type."
  (setq id (or (noema-research-resolve-work-node-id document id) id))
  (when reconnect
    (dolist (type noema-research-relation-types)
      (let ((parents (noema-research-relation-parents document id type)))
        (dolist (child (noema-research-relation-children document id type))
          (dolist (parent parents)
            (unless (or (equal parent child)
                        (member parent (noema-research-relation-parents document child type)))
              (noema-research--set-dependencies
               document
               (append (noema-research-dependencies document)
                       (list (noema-research--table
                              "id" (noema-research--dependency-id parent child type)
                              "from" parent "to" child "type" type))))))))))
  (noema-research--set-work-nodes
   document (seq-remove (lambda (node) (equal (noema-research-work-node-id node) id))
                        (noema-research-work-nodes document)))
  (noema-research-strip-references document (list id))
  (let (kept)
    (dolist (cell (noema-research-cells document))
      (if (not (equal (noema-research-cell-work-node-id cell) id))
          (push cell kept)
        (if delete-cells
            nil
          ;; An unbound Cell cannot keep work storage or Run output.
          (puthash "cell_type" "markdown" cell)
          (remhash "execution_count" cell)
          (remhash "outputs" cell)
          (noema-research-cell-set cell "work_node_id" nil)
          (push cell kept))))
    (puthash "cells" (vconcat (nreverse kept)) document))
  document)

;;;; Structure editing

(defun noema-research-cell-graph-p (document cell)
  "Return non-nil when CELL carries a WorkNode header in DOCUMENT."
  (member (noema-research-cell-kind cell document) noema-research-graph-kinds))

(defun noema-research-cell-unit (document cell)
  "Return CELL's block in DOCUMENT.
A WorkNode header Cell owns the notes that follow it up to the next header;
any other Cell is a block of its own."
  (let ((tail (memq cell (noema-research-cells document))))
    (cond
     ((null tail) nil)
     ((not (noema-research-cell-graph-p document cell)) (list cell))
     (t (let ((unit (list cell)))
          (setq tail (cdr tail))
          (while (and tail (not (noema-research-cell-graph-p document (car tail))))
            (push (car tail) unit)
            (setq tail (cdr tail)))
          (nreverse unit))))))

(defun noema-research-work-node-block-end (document id)
  "Return the last Cell of WorkNode ID's block in DOCUMENT, or nil."
  (when-let* ((cell (noema-research-primary-cell document id)))
    (car (last (noema-research-cell-unit document cell)))))

(defun noema-research-move-cells (document moving after)
  "Move MOVING Cells of DOCUMENT, keeping their order, to follow Cell AFTER.
AFTER nil places them at the start of the document."
  (when (memq after moving)
    (user-error "A block cannot be moved after itself"))
  (let* ((cells (noema-research-cells document))
         (rest (seq-remove (lambda (cell) (memq cell moving)) cells))
         (ordered (seq-filter (lambda (cell) (memq cell moving)) cells))
         (index (if after
                    (1+ (or (seq-position rest after #'eq)
                            (user-error "Unknown target Cell")))
                  0)))
    (puthash "cells" (vconcat (seq-take rest index) ordered (seq-drop rest index))
             document)
    document))

(defun noema-research-shift-block (document cell direction)
  "Move CELL's block one block `up' or `down' (DIRECTION) in DOCUMENT.
A WorkNode block moves with its trailing notes past the neighbouring block;
a note moves past one neighbouring Cell."
  (let* ((cells (noema-research-cells document))
         (moving (or (noema-research-cell-unit document cell)
                     (user-error "Unknown Cell")))
         (graph (noema-research-cell-graph-p document cell)))
    (pcase direction
      ('up
       (let ((index (seq-position cells (car moving) #'eq)))
         (when (zerop index) (user-error "Already the first block"))
         (let ((target (1- index)))
           (when graph
             (while (and (> target 0)
                         (not (noema-research-cell-graph-p document (nth target cells))))
               (setq target (1- target))))
           (noema-research-move-cells document moving
                                      (and (> target 0) (nth (1- target) cells))))))
      ('down
       (let* ((index (seq-position cells (car (last moving)) #'eq))
              (next (or (nth (1+ index) cells) (user-error "Already the last block"))))
         (noema-research-move-cells
          document moving
          (if graph (car (last (noema-research-cell-unit document next))) next))))
      (_ (error "Unknown direction %S" direction)))
    document))

(defun noema-research-set-work-node-kind (document id kind)
  "Change WorkNode ID's KIND in DOCUMENT and adapt its primary Cell storage.
Changing away from work removes state, outcome and the primary Cell's outputs."
  (unless (member kind noema-research-graph-kinds)
    (user-error "Unsupported WorkNode kind: %s" kind))
  (let* ((id (noema-research--require-node-id document id))
         (node (noema-research-find-work-node document id))
         (title (or (noema-research-work-node-field node "title") ""))
         (primary (noema-research-primary-cell document id)))
    (if primary
        (progn
          (noema-research-cell-set primary "title" nil)
          (noema-research-bind-cell document primary kind title id))
      (puthash "kind" kind node)
      (if (equal kind "work")
          (unless (noema-research-work-node-field node "state")
            (puthash "state" "open" node))
        (dolist (key '("state" "outcome" "dropped_reason")) (remhash key node))))
    id))

(defun noema-research--new-cell (document)
  "Return a new empty markdown Cell whose id is unused in DOCUMENT."
  (let ((taken (make-hash-table :test #'equal)))
    (dolist (cell (noema-research-cells document))
      (puthash (noema-research-cell-id cell) t taken))
    (noema-research--table "cell_type" "markdown"
                           "id" (noema-research-new-cell-id taken)
                           "metadata" (make-hash-table :test #'equal)
                           "source" "")))

(cl-defun noema-research-create-work-node (document kind title &key parents after)
  "Create a KIND WorkNode titled TITLE with its primary Cell in DOCUMENT.
PARENTS become lineage parents.  The Cell follows Cell AFTER, or is appended.
Return the new WorkNode id."
  (unless (member kind noema-research-graph-kinds)
    (user-error "Unsupported WorkNode kind: %s" kind))
  (let ((cell (noema-research--new-cell document)))
    (puthash "cells" (vconcat (noema-research-cells document) (vector cell)) document)
    (when after (noema-research-move-cells document (list cell) after))
    (let ((id (noema-research-work-node-id
               (noema-research-bind-cell document cell kind (string-trim (or title ""))))))
      (dolist (parent parents)
        (noema-research-add-relation document parent id "lineage"))
      id)))

(cl-defun noema-research-attach-cell (document id &key after)
  "Give cell-less WorkNode ID a primary Cell in DOCUMENT; return the Cell id.
The Cell follows Cell AFTER, or is appended."
  (let* ((id (noema-research--require-node-id document id))
         (node (noema-research-find-work-node document id)))
    (when (noema-research-primary-cell document id)
      (user-error "“%s” already has a Cell" (noema-research-work-node-label document id)))
    (let ((cell (noema-research--new-cell document)))
      (puthash "cells" (vconcat (noema-research-cells document) (vector cell)) document)
      (when after (noema-research-move-cells document (list cell) after))
      (noema-research-bind-cell document cell (noema-research-work-node-field node "kind")
                                (or (noema-research-work-node-field node "title") "") id)
      (noema-research-cell-id cell))))

(cl-defun noema-research-work-node-choices (document &key predicate near)
  "Return (LABEL . WORK-NODE-ID) completion choices for DOCUMENT's WorkNodes.
Labels are unique human text — kind, title, a “no Cell” marker, and an
ordinal only when labels collide; machine ids never appear.  PREDICATE
filters ids.  With NEAR, ancestors of NEAR come first, then the nodes
nearest to it in the document, then Cell-less nodes."
  (let ((positions (make-hash-table :test #'equal))
        (ancestors (make-hash-table :test #'equal))
        near-position ids)
    (seq-do-indexed (lambda (cell index)
                      (when-let* ((id (noema-research-cell-work-node-id cell)))
                        (unless (gethash id positions) (puthash id index positions))))
                    (noema-research-cells document))
    (when near
      (setq near-position (gethash near positions))
      (let ((stack (list near)))
        (while stack
          (let ((id (pop stack)))
            (dolist (type noema-research-relation-types)
              (dolist (parent (noema-research-relation-parents document id type))
                (unless (gethash parent ancestors)
                  (puthash parent t ancestors)
                  (push parent stack))))))))
    (dolist (node (noema-research-work-nodes document))
      (let ((id (noema-research-work-node-id node)))
        (when (or (null predicate) (funcall predicate id))
          (push id ids))))
    (setq ids
          (sort (nreverse ids)
                (lambda (left right)
                  (let ((lp (gethash left positions)) (rp (gethash right positions))
                        (la (gethash left ancestors)) (ra (gethash right ancestors)))
                    (cond
                     ((and la (not ra)) t)
                     ((and ra (not la)) nil)
                     ((and lp (not rp)) t)
                     ((and rp (not lp)) nil)
                     ((and lp rp near-position)
                      (< (abs (- lp near-position)) (abs (- rp near-position))))
                     ((and lp rp) (< lp rp)))))))
    (let* ((bases (mapcar (lambda (id)
                            (replace-regexp-in-string
                             "," " "
                             (format "%s: %s%s"
                                     (or (noema-research-work-node-field
                                          (noema-research-find-work-node document id) "kind")
                                         "node")
                                     (noema-research-work-node-label document id)
                                     (if (gethash id positions) "" " · no Cell"))))
                          ids))
           (ordinals (make-hash-table :test #'equal)))
      (cl-mapcar (lambda (base id)
                   (let ((n (puthash base (1+ (gethash base ordinals 0)) ordinals)))
                     (cons (if (= (cl-count base bases :test #'equal) 1)
                               base
                             (format "%s ⟨%d⟩" base n))
                           id)))
                 bases ids))))

;;;; Validation

(defun noema-research-validate (document)
  "Return (:errors ERRORS :warnings WARNINGS) for DOCUMENT.
Each entry is a cons (ENTITY-ID . MESSAGE)."
  (let ((errors nil)
        (warnings nil)
        (ids (make-hash-table :test #'equal))
        (nodes (make-hash-table :test #'equal))
        (edges (make-hash-table :test #'equal)))
    (unless (equal (noema-research--get (noema-research-notebook-meta document) "schema")
                   noema-research-schema)
      (push (cons nil "not a canonical Noema work document") errors))
    (unless (and (equal (noema-research--get document "nbformat") 4)
                 (equal (noema-research--get document "nbformat_minor") 5))
      (push (cons nil "Noema work documents require nbformat 4.5") errors))
    (let ((metadata (noema-research--get document "metadata")))
      (when (and (hash-table-p metadata)
                 (or (gethash "kernelspec" metadata)
                     (gethash "language_info" metadata)))
        (push (cons nil ".noema cannot declare kernelspec or language_info") errors)))
    (when (string-empty-p (noema-research-notebook-id document))
      (push (cons nil "notebook_id is required") errors))
    (dolist (cell (noema-research-cells document))
      (let ((id (noema-research-cell-id cell)))
        (cond
         ((not (and (stringp id)
                    (string-match-p "\\`[A-Za-z0-9_-]\\{1,64\\}\\'" id)))
          (push (cons id (format "invalid cell id %S" id)) errors))
         ((gethash id ids)
          (push (cons id (format "duplicate cell id %s" id)) errors))
         (t (puthash id cell ids)))))
    (dolist (node (noema-research-work-nodes document))
      (let ((id (noema-research-work-node-id node))
            (kind (noema-research-work-node-field node "kind"))
            (state (noema-research-work-node-field node "state"))
            (outcome (noema-research-work-node-field node "outcome")))
        (cond
         ((not (and (stringp id)
                    (string-match-p "\\`wn_[A-Za-z0-9_-]\\{1,80\\}\\'" id)))
          (push (cons id (format "invalid WorkNode id %S" id)) errors))
         ((gethash id nodes) (push (cons id (format "duplicate WorkNode id %s" id)) errors))
         (t (puthash id node nodes)))
        (unless (member kind noema-research-graph-kinds)
          (push (cons id (format "unsupported WorkNode kind %S" kind)) errors))
        (unless (eq (gethash "agenda" node :absent) :absent)
          (push (cons id "Agenda belongs in the primary Cell's visible @@todo / @@clock commands") errors))
        (when (and state (not (member state noema-research-work-states)))
          (push (cons id (format "unsupported work state %s" state)) errors))
        (when (and outcome (not (member outcome noema-research-work-outcomes)))
          (push (cons id (format "unsupported work outcome %s" outcome)) errors))))
    (dolist (cell (noema-research-cells document))
      (let* ((id (noema-research-cell-id cell))
             (raw-kind (noema-research--get (noema-research-cell-meta cell) "kind"))
             (work-node-id (noema-research-cell-work-node-id cell))
             (node (gethash work-node-id nodes))
             (cell-type (noema-research--get cell "cell_type")))
        (when (and node (eq cell (noema-research-primary-cell document work-node-id)))
          (condition-case err
              (noema-research-agenda-directive
               (noema-research-cell-source cell)
               (noema-research-work-node-field node "kind"))
            (error (push (cons id (error-message-string err)) errors))))
        (when raw-kind
          (push (cons id "graph kind belongs to a WorkNode, not cell metadata") errors))
        (when (and work-node-id (not (gethash work-node-id nodes)))
          (push (cons id (format "cell references missing WorkNode %s" work-node-id)) errors))
        (cond
         ((equal cell-type "code")
          (unless (and node (equal (noema-research-work-node-field node "kind") "work"))
            (push (cons id "code storage cells must bind a work WorkNode") errors))
          (unless (eq (noema-research--get cell "execution_count") :null)
            (push (cons id "work execution_count must be null") errors))
          (unless (vectorp (noema-research--get cell "outputs"))
            (push (cons id "work cells must carry an outputs array") errors)))
         ((equal cell-type "markdown")
          (when (or (gethash "outputs" cell) (gethash "execution_count" cell))
            (push (cons id "markdown cells cannot carry runtime fields") errors)))
         (t (push (cons id (format "unsupported .noema cell_type %S" cell-type)) errors)))))
    (dolist (edge (noema-research-dependencies document))
      (let* ((from (noema-research--get edge "from"))
             (to (noema-research--get edge "to"))
             (type (noema-research--get edge "type"))
             (key (list from to type)))
        (unless (member type noema-research-relation-types)
          (push (cons to (format "unsupported dependency type %S" type)) errors))
        (when (equal from to) (push (cons to "dependency references its own WorkNode") errors))
        (unless (gethash from nodes)
          (push (cons to (format "%s references missing WorkNode %s" type from)) warnings))
        (unless (gethash to nodes)
          (push (cons to (format "%s targets missing WorkNode %s" type to)) warnings))
        (when (gethash key edges) (push (cons to "duplicate WorkNode dependency") errors))
        (puthash key t edges)))
    (when (noema-research-dependency-cycle-p document)
      (push (cons nil "work dependencies form a cycle") errors))
    (list :errors (nreverse errors) :warnings (nreverse warnings))))

;;;; Projection

(defun noema-research--walk (start graph &optional limit)
  "Return ids reachable from START in hash GRAPH, at most LIMIT steps away."
  (let* ((seen (make-hash-table :test #'equal))
         (queue (list (cons start 0)))
         (tail queue)
         result)
    ;; A tail pointer keeps the breadth-first walk linear; appending to the
    ;; queue on every step made large DAG projections quadratic.
    (while queue
      (pcase-let ((`(,id . ,distance) (pop queue)))
        (when (or (null limit) (< distance limit))
          (dolist (next (gethash id graph))
            (unless (or (equal next start) (gethash next seen))
              (puthash next t seen)
              (push next result)
              (let ((cell (list (cons next (1+ distance)))))
                (if queue (setcdr tail cell) (setq queue cell))
                (setq tail cell)))))))
    (nreverse result)))

(defun noema-research--exclusive-descendants (id children roots)
  "Return lineage descendants of ID that no root reaches without passing ID.
CHILDREN maps an id to its lineage children; ROOTS are the lineage roots."
  (let ((reachable (make-hash-table :test #'equal))
        (stack (remove id roots)))
    (while stack
      (let ((next (pop stack)))
        (unless (gethash next reachable)
          (puthash next t reachable)
          (dolist (child (gethash next children))
            (unless (equal child id)
              (push child stack))))))
    (seq-remove (lambda (candidate) (gethash candidate reachable))
                (noema-research--walk id children))))

(defun noema-research-lineage-maps (document)
  "Return (CHILDREN PARENTS ROOTS) for DOCUMENT's lineage edges.
CHILDREN and PARENTS are hash tables of id lists; ROOTS lists, in document
order, the WorkNodes without a lineage parent."
  (let ((children (make-hash-table :test #'equal))
        (parents (make-hash-table :test #'equal))
        (known (make-hash-table :test #'equal))
        order)
    (dolist (node (noema-research-work-nodes document))
      (let ((id (noema-research-work-node-id node)))
        (puthash id t known)
        (push id order)))
    (dolist (edge (noema-research-dependencies document))
      (let ((from (noema-research--get edge "from"))
            (to (noema-research--get edge "to")))
        (when (and (equal (noema-research--get edge "type") "lineage")
                   (gethash from known) (gethash to known) (not (equal from to)))
          (puthash from (append (gethash from children) (list to)) children)
          (puthash to (append (gethash to parents) (list from)) parents))))
    (list children parents
          (seq-filter (lambda (id) (null (gethash id parents))) (nreverse order)))))

(defun noema-research-branch-ids (document id)
  "Return the WorkNodes of DOCUMENT reachable only through ID's lineage branch."
  (pcase-let ((`(,children ,_parents ,roots) (noema-research-lineage-maps document)))
    (noema-research--exclusive-descendants id children roots)))

(defun noema-research-branch-state-targets (document id state)
  "Return the work WorkNodes a branch-wide STATE change on ID sets.
The branch is ID and every WorkNode reachable only through it; only work
nodes carry state.  ID itself always changes.  Inside the branch, marking it
done keeps dropped work dropped, dropping it keeps finished work done, and
any other state applies to every work node."
  (seq-filter
   (lambda (node-id)
     (when-let* ((node (noema-research-find-work-node document node-id)))
       (and (equal (noema-research-work-node-field node "kind") "work")
            (let ((current (noema-research-work-node-field node "state")))
              (or (equal node-id id)
                  (pcase state
                    ("done" (not (equal current "dropped")))
                    ("dropped" (not (equal current "done")))
                    (_ t)))))))
   (cons id (noema-research-branch-ids document id))))

(cl-defun noema-research-projection (document &key focus folds protect (depth 2))
  "Return the lineage-first graph projection of DOCUMENT.
The result is a plist with :nodes, :edges, :focus and :folds.  Each node is a
plist with :id, :kind, :title, :state, :outcome, :focus, :folded (the number of
contracted nodes, or nil) and :parents (visible lineage parents).  Each edge is
a list (FROM TO TYPE).  FOLDS contract descendants that are only reachable
through the folded node.  FOCUS and every id in PROTECT, together with their
ancestors, are never hidden by a fold.  FOCUS makes its node the root of the
drawing: the lens keeps FOCUS and its lineage descendants up to DEPTH levels,
and nothing above or beside it.  A fold on FOCUS itself is ignored, since
focusing a node asks to see its branch."
  (let ((nodes (make-hash-table :test #'equal))
        (children (make-hash-table :test #'equal))
        (parents (make-hash-table :test #'equal))
        order edges)
    (dolist (node (noema-research-work-nodes document))
      (let ((id (noema-research-work-node-id node)))
        (puthash id node nodes)
        (push id order)))
    (setq order (nreverse order))
    (dolist (edge (noema-research-dependencies document))
      (let ((parent (noema-research--get edge "from"))
            (id (noema-research--get edge "to"))
            (type (noema-research--get edge "type")))
        (when (and (member type noema-research-relation-types)
                   (gethash parent nodes) (gethash id nodes) (not (equal parent id)))
          (push (list parent id type) edges)
          (when (equal type "lineage")
            (puthash parent (append (gethash parent children) (list id)) children)
            (puthash id (append (gethash id parents) (list parent)) parents)))))
    (setq edges (nreverse edges))
    (let* ((focus-id (and focus (gethash focus nodes) focus))
           (protected (make-hash-table :test #'equal))
           (hidden-by (make-hash-table :test #'equal))
           (roots (seq-filter (lambda (id) (null (gethash id parents))) order))
           lens effective-folds)
      (dolist (anchor (delete-dups
                       (delq nil
                             (append (and focus-id (list focus-id))
                                     (if (listp protect) protect (list protect))))))
        (when (gethash anchor nodes)
          (puthash anchor t protected)
          (dolist (id (noema-research--walk anchor parents))
            (puthash id t protected))))
      (when focus-id
        (setq lens (make-hash-table :test #'equal))
        (puthash focus-id t lens)
        (dolist (id (noema-research--walk focus-id children depth))
          (puthash id t lens)))
      (dolist (fold (delete-dups (copy-sequence folds)))
        (when (and (gethash fold nodes) (not (equal fold focus-id)))
          (dolist (id (noema-research--exclusive-descendants fold children roots))
            (unless (or (gethash id protected) (gethash id hidden-by))
              (puthash id fold hidden-by)))
          (push fold effective-folds)))
      (setq effective-folds (nreverse effective-folds))
      (cl-labels ((representative (id)
                    (let ((current id) (guard 0))
                      (while (and (gethash current hidden-by) (< guard 10000))
                        (setq current (gethash current hidden-by)
                              guard (1+ guard)))
                      current))
                  (visible (id)
                    (and (not (gethash id hidden-by))
                         (or (null lens) (gethash id lens)))))
        (let ((hidden-counts (make-hash-table :test #'equal))
              (seen (make-hash-table :test #'equal))
              out-nodes out-edges)
          (maphash (lambda (id _fold)
                     (let ((owner (representative id)))
                       (puthash owner (1+ (gethash owner hidden-counts 0))
                                hidden-counts)))
                   hidden-by)
          (dolist (id order)
            (when (visible id)
              (let* ((node (gethash id nodes))
                     (cell (noema-research-primary-cell document id)))
                (push (list :id id
                            :cell-id (and cell (noema-research-cell-id cell))
                            :kind (noema-research-work-node-field node "kind")
                            :title (noema-research-work-node-label document id)
                            :state (noema-research-work-node-field node "state")
                            :outcome (noema-research-work-node-field node "outcome")
                            :agenda (and cell
                                         (condition-case nil
                                             (noema-research-agenda-directive
                                              (noema-research-cell-source cell)
                                              (noema-research-work-node-field node "kind"))
                                           (error nil)))
                            :focus (equal id focus-id)
                            :folded (and (member id effective-folds)
                                         (gethash id hidden-counts 0))
                            :parents (seq-filter
                                      (lambda (parent)
                                        (and (not (equal parent id))
                                             (visible parent)))
                                      (delete-dups
                                       (mapcar #'representative
                                               (gethash id parents)))))
                      out-nodes))))
          (dolist (edge edges)
            (let ((from (representative (nth 0 edge)))
                  (to (representative (nth 1 edge)))
                  (type (nth 2 edge)))
              (unless (or (equal from to) (not (visible from)) (not (visible to))
                          (gethash (list from to type) seen)
                          ;; A protected node can stay visible below a fold.
                          ;; Its edges into that fold's hidden descendants
                          ;; would be redirected to the fold owner, an
                          ;; ancestor, and draw a false cycle.  Drop them.
                          (and (not (equal to (nth 1 edge)))
                               (member from (noema-research--walk to children))))
                (puthash (list from to type) t seen)
                (push (list from to type) out-edges))))
          (list :nodes (nreverse out-nodes)
                :edges (nreverse out-edges)
                :focus focus-id
                :folds effective-folds))))))

;;;; Files

(defun noema-research-file-revision (file)
  "Return FILE's content revision, or nil when FILE does not exist."
  (when (file-exists-p file)
    (with-temp-buffer
      (set-buffer-multibyte nil)
      (insert-file-contents-literally file)
      (concat "sha256:" (secure-hash 'sha256 (current-buffer))))))

(defun noema-research-read-file (file)
  "Read research notebook FILE and return its document."
  (let ((document (with-temp-buffer
                    (let ((coding-system-for-read 'utf-8))
                      (insert-file-contents file))
                    (noema-research-parse-json (buffer-string)))))
    (unless (noema-research-notebook-p document)
      (user-error "%s is not a Noema work document" file))
    (noema-research-normalize-document document)))

(defun noema-research-write-file (file document &optional expected-revision)
  "Atomically write DOCUMENT to FILE and return the new revision.
Signal `noema-research-revision-conflict' when EXPECTED-REVISION is non-nil
and FILE no longer has that revision."
  (let ((errors (plist-get (noema-research-validate document) :errors)))
    (when errors
      (user-error "Research notebook is invalid: %s"
                  (mapconcat #'cdr errors "; "))))
  (let ((current (noema-research-file-revision file)))
    (when (and expected-revision current (not (equal current expected-revision)))
      (signal 'noema-research-revision-conflict (list file))))
  (let* ((path (expand-file-name file))
         (directory (file-name-directory path))
         (text (noema-research-serialize document))
         temporary)
    (make-directory directory t)
    (setq temporary (make-temp-file
                     (expand-file-name (concat "." (file-name-nondirectory path) ".")
                                       directory)
                     nil ".tmp"))
    (unwind-protect
        (progn
          (let ((coding-system-for-write 'utf-8-unix))
            (write-region text nil temporary nil 'silent))
          (rename-file temporary path t))
      (when (file-exists-p temporary)
        (ignore-errors (delete-file temporary))))
    (concat "sha256:" (secure-hash 'sha256 (encode-coding-string text 'utf-8)))))

;;;; Repository state

(defun noema-project--atomic-write (file text)
  "Atomically replace FILE with TEXT."
  (let* ((path (expand-file-name file))
         (directory (file-name-directory path))
         (temporary (make-temp-file
                     (expand-file-name
                      (concat "." (file-name-nondirectory path) ".")
                      directory)
                     nil ".tmp")))
    (unwind-protect
        (progn
          (let ((coding-system-for-write 'utf-8-unix))
            (write-region text nil temporary nil 'silent))
          (rename-file temporary path t))
      (when (file-exists-p temporary)
        (ignore-errors (delete-file temporary))))))

(defun noema-project--ensure-agent-ignore (root)
  "Ensure ROOT's `.gitignore' excludes the local `.agent/' directory."
  (let* ((file (expand-file-name ".gitignore" root))
         (text (if (file-readable-p file)
                   (with-temp-buffer
                     (insert-file-contents file)
                     (buffer-string))
                 ""))
         (ignored (seq-some
                   (lambda (line)
                     (member (string-trim line) '(".agent" ".agent/" "/.agent" "/.agent/")))
                   (split-string text "\n"))))
    (unless ignored
      (noema-project--atomic-write
       file
       (concat text
               (unless (or (string-empty-p text) (string-suffix-p "\n" text)) "\n")
               ".agent/\n")))
    file))

(defun noema-project--directory (path)
  "Return PATH itself when it is a directory, else its parent directory."
  (let ((path (expand-file-name path)))
    (if (file-directory-p path)
        (file-name-as-directory path)
      (file-name-directory path))))

(defun noema-project-root (path)
  "Return the root of the Noema project containing PATH, or nil.
PATH may name a directory or a file that does not exist yet.  The nearest
ancestor holding `noema.toml' wins.  This is a query and never writes."
  (when-let* ((root (locate-dominating-file (noema-project--directory path)
                                            "noema.toml")))
    (file-name-as-directory (expand-file-name root))))

(defun noema-project-default-root (directory)
  "Return the root a new Noema project for DIRECTORY should use.
The `project.el' root containing DIRECTORY wins, so the Noema project shares
its workspace's identity; outside any project DIRECTORY itself is used."
  (let ((project (project-current nil directory)))
    (file-name-as-directory
     (expand-file-name (if project (project-root project) directory)))))

(defun noema-project-ensure (path)
  "Return the Noema project root for PATH, asking before creating one.
An enclosing project is reused silently.  Otherwise the user confirms or edits
the root proposed by `noema-project-default-root', which must contain PATH.
Nothing is written unless the user accepts; quitting propagates."
  (or (noema-project-root path)
      (let* ((directory (noema-project--directory path))
             (proposed (noema-project-default-root directory))
             (root (file-name-as-directory
                    (expand-file-name
                     (read-directory-name "Create Noema project at: "
                                          proposed proposed t)))))
        (unless (file-in-directory-p directory root)
          (user-error "Noema project %s does not contain %s"
                      (abbreviate-file-name root)
                      (abbreviate-file-name (expand-file-name path))))
        (plist-get (noema-project-enable root) :root))))

;;;###autoload
(defun noema-project-enable (&optional directory)
  "Give DIRECTORY a durable Noema Project identity.
Create `noema.toml' with a UUIDv7 repository id and ensure `.agent/' is
ignored by Git.  Existing manifests and unrelated ignore rules are preserved.
Interactively, DIRECTORY defaults to `noema-project-default-root'."
  (interactive)
  (let* ((root (file-name-as-directory
                (expand-file-name
                 (or directory
                     (noema-project-default-root default-directory)))))
         (manifest (expand-file-name "noema.toml" root))
         (created nil))
    (unless (file-directory-p root)
      (user-error "Project directory does not exist: %s" root))
    (unless (file-exists-p manifest)
      (noema-project--atomic-write
       manifest
       (format "schema = 1\nrepository_id = \"%s\"\n"
               (noema-research--uuidv7)))
      (setq created t))
    (unless (file-regular-p manifest)
      (user-error "Noema project manifest is not a regular file: %s" manifest))
    (noema-project--ensure-agent-ignore root)
    (when (called-interactively-p 'interactive)
      (message "%s Noema project: %s"
               (if created "Enabled" "Already enabled") root))
    (list :root root :manifest manifest :created created)))

(defun noema-research-repository-root (file)
  "Return the Noema repository root containing FILE.
The root is the nearest directory with `noema.toml', else FILE's directory."
  (or (noema-project-root file)
      (noema-project--directory file)))

(defun noema-research-state-directory (file)
  "Return the `.agent/' directory of FILE's repository, creating it.
The directory ignores itself so repository Git never records runtime state."
  (let* ((directory (expand-file-name noema-research-state-directory
                                      (noema-research-repository-root file)))
         (ignore (expand-file-name ".gitignore" directory)))
    (make-directory directory t)
    (unless (file-exists-p ignore)
      (let ((coding-system-for-write 'utf-8-unix))
        (write-region "*\n" nil ignore nil 'silent)))
    directory))

(defun noema-research-view-file (file document)
  "Return the view state path for DOCUMENT stored at FILE."
  (let ((id (replace-regexp-in-string "[^A-Za-z0-9_-]" "-"
                                      (noema-research-notebook-id document))))
    (expand-file-name (concat (if (string-empty-p id) "notebook" id) ".json")
                      (expand-file-name
                       "views"
                       (expand-file-name noema-research-state-directory
                                         (noema-research-repository-root file))))))

(defun noema-research--view-object (path)
  "Return the JSON view object stored at PATH, or nil."
  (ignore-errors
    (when (file-readable-p path)
      (let ((view (with-temp-buffer
                    (insert-file-contents path)
                    (noema-research-parse-json (buffer-string)))))
        (and (hash-table-p view) view)))))

(defun noema-research-view-read (file document)
  "Return the saved view plist for DOCUMENT at FILE.
The plist always has :focus and :folds.  Newer view files may also carry
:zoom (overview, branch or detail), :unfolds (WorkNodes expanded against
Smart Fold), :focus-depth, :viewport (a plist :dx :dy :scale) and :settings
(an alist of document setting overrides by name).  Keys absent from the
file are absent from the plist, so older files remain valid."
  (if-let* ((view (noema-research--view-object
                   (noema-research-view-file file document))))
      (let ((result (list :focus (noema-research--string
                                  (noema-research--get view "focus"))
                          :folds (seq-filter #'stringp
                                             (append (noema-research--get
                                                      view "folds" [])
                                                     nil))))
            (zoom (noema-research--string (noema-research--get view "zoom")))
            (unfolds (noema-research--get view "unfolds"))
            (depth (noema-research--get view "focus_depth"))
            (viewport (noema-research--get view "viewport"))
            (settings (noema-research--get view "settings")))
        (when (member zoom '("overview" "branch" "detail"))
          (setq result (plist-put result :zoom zoom)))
        (when (vectorp unfolds)
          (setq result (plist-put result :unfolds
                                  (seq-filter #'stringp (append unfolds nil)))))
        (when (and (natnump depth) (> depth 0))
          (setq result (plist-put result :focus-depth depth)))
        (when (hash-table-p viewport)
          (let ((dx (noema-research--get viewport "dx"))
                (dy (noema-research--get viewport "dy"))
                (scale (noema-research--get viewport "scale")))
            (when (and (numberp dx) (numberp dy) (numberp scale) (> scale 0))
              (setq result (plist-put result :viewport
                                      (list :dx dx :dy dy :scale scale))))))
        (when (hash-table-p settings)
          (let (alist)
            (maphash (lambda (key value) (push (cons key value) alist)) settings)
            (when alist
              (setq result (plist-put result :settings (nreverse alist))))))
        result)
    (list :focus nil :folds nil)))

(defun noema-research-view-update (file document function)
  "Apply FUNCTION to DOCUMENT's saved view object at FILE and persist it.
FUNCTION receives the view as a hash table and changes it in place.  Keys it
leaves alone, including ones written by newer Noema versions, are kept.
Return the view-state path."
  (noema-research-state-directory file)
  (let* ((path (noema-research-view-file file document))
         (view (or (noema-research--view-object path)
                   (make-hash-table :test #'equal))))
    (funcall function view)
    (make-directory (file-name-directory path) t)
    (let ((coding-system-for-write 'utf-8-unix))
      (write-region (noema-research-serialize view) nil path nil 'silent))
    path))

(defun noema-research-view-write (file document focus folds &optional zoom)
  "Persist FOCUS, FOLDS and optional ZOOM for DOCUMENT at FILE.
ZOOM is one of overview, branch, or detail.  Other saved view keys are kept.
Return the view-state path."
  (when (and zoom (not (member zoom '("overview" "branch" "detail"))))
    (user-error "Unsupported Graph Board zoom: %s" zoom))
  (noema-research-view-update
   file document
   (lambda (view)
     (puthash "focus" (or focus :null) view)
     (puthash "folds" (vconcat folds) view)
     (puthash "zoom" (or zoom :null) view))))

(provide 'noema-research)

;;; noema-research.el ends here
