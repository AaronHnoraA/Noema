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
  "Return scalar VALUE encoded as JSON text."
  (substring (json-serialize (vector value)
                             :null-object :null :false-object :false)
             1 -1))

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

(defun noema-research-find-work-node (document id)
  "Return WorkNode ID in DOCUMENT, or nil."
  (and id
       (seq-find (lambda (node) (equal (noema-research-work-node-id node) id))
                 (noema-research-work-nodes document))))

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
  "Return the canonical cell bound to WORK-NODE-ID, else any bound cell."
  (let* ((node (noema-research-find-work-node document work-node-id))
         (kind (noema-research-work-node-field node "kind"))
         (bound (seq-filter
                (lambda (cell) (equal (noema-research-cell-work-node-id cell)
                                      work-node-id))
                (noema-research-cells document))))
    (or (seq-find (lambda (cell)
                    (equal (noema-research--get cell "cell_type")
                           (if (equal kind "work") "code" "markdown")))
                  bound)
        (car bound))))

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
     ((member (noema-research-work-node-field node "kind") '("question" "checkpoint"))
      (noema-research-work-node-field node "kind"))
     (legacy legacy)
     (t "note"))))

(defun noema-research-cell-title (cell &optional document)
  "Return CELL's WorkNode title in DOCUMENT, or its local title."
  (or (and document
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
  (noema-research-migrate-legacy-document document))

;;;; Relations and state

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

(defun noema-research-delete-work-node (document id &optional delete-cells)
  "Delete WorkNode ID and its dependencies from DOCUMENT.
When DELETE-CELLS is non-nil, also delete all bound cells; otherwise unbind
the ordinary cells."
  (setq id (or (noema-research-resolve-work-node-id document id) id))
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
          (noema-research-cell-set cell "work_node_id" nil)
          (push cell kept))))
    (puthash "cells" (vconcat (nreverse kept)) document))
  document)

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
  (let ((seen (make-hash-table :test #'equal))
        (queue (list (cons start 0)))
        result)
    (while queue
      (pcase-let ((`(,id . ,distance) (pop queue)))
        (when (or (null limit) (< distance limit))
          (dolist (next (gethash id graph))
            (unless (or (equal next start) (gethash next seen))
              (puthash next t seen)
              (push next result)
              (setq queue (append queue (list (cons next (1+ distance))))))))))
    (nreverse result)))

(cl-defun noema-research-projection (document &key focus folds (depth 2))
  "Return the lineage-first graph projection of DOCUMENT.
The result is a plist with :nodes, :edges, :focus and :folds.  Each node is a
plist with :id, :kind, :title, :state, :outcome, :focus, :folded (the number of
contracted nodes, or nil) and :parents (visible lineage parents).  Each edge is
a list (FROM TO TYPE).  FOLDS contract descendants that are only reachable
through the folded node; FOCUS and its ancestors are never hidden.  With
FOCUS, the lens keeps ancestors, descendants up to DEPTH, and siblings."
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
      (when focus-id
        (puthash focus-id t protected)
        (dolist (id (noema-research--walk focus-id parents))
          (puthash id t protected))
        (setq lens (copy-hash-table protected))
        (dolist (id (noema-research--walk focus-id children depth))
          (puthash id t lens))
        (dolist (parent (gethash focus-id parents))
          (dolist (sibling (gethash parent children))
            (puthash sibling t lens))))
      (dolist (fold (delete-dups (copy-sequence folds)))
        (when (gethash fold nodes)
          (let ((reachable (make-hash-table :test #'equal))
                (stack (remove fold roots)))
            (while stack
              (let ((id (pop stack)))
                (unless (gethash id reachable)
                  (puthash id t reachable)
                  (dolist (child (gethash id children))
                    (unless (equal child fold)
                      (push child stack))))))
            (dolist (id (noema-research--walk fold children))
              (unless (or (gethash id reachable) (gethash id protected)
                          (gethash id hidden-by))
                (puthash id fold hidden-by)))
            (push fold effective-folds))))
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
                            :title (or (noema-research-work-node-field node "title") id)
                            :state (noema-research-work-node-field node "state")
                            :outcome (noema-research-work-node-field node "outcome")
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
                          (gethash (list from to type) seen))
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

;;;###autoload
(defun noema-project-enable (&optional directory)
  "Give DIRECTORY a durable Noema Project identity.
Create `noema.toml' with a UUIDv7 repository id and ensure `.agent/' is
ignored by Git.  Existing manifests and unrelated ignore rules are preserved.
Interactively, DIRECTORY defaults to the current project root."
  (interactive)
  (let* ((project (and (null directory) (project-current nil)))
         (root (file-name-as-directory
                (expand-file-name
                 (or directory
                     (and project (project-root project))
                     default-directory))))
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
  (let* ((directory (file-name-directory (expand-file-name file)))
         (root (locate-dominating-file directory "noema.toml")))
    (file-name-as-directory (expand-file-name (or root directory)))))

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

(defun noema-research-view-read (file document)
  "Return the saved view plist (:focus :folds) for DOCUMENT at FILE."
  (let ((path (noema-research-view-file file document)))
    (or (ignore-errors
          (when (file-readable-p path)
            (let ((view (with-temp-buffer
                          (insert-file-contents path)
                          (noema-research-parse-json (buffer-string)))))
              (list :focus (noema-research--string (noema-research--get view "focus"))
                    :folds (seq-filter #'stringp
                                       (append (noema-research--get view "folds" [])
                                               nil))))))
        (list :focus nil :folds nil))))

(defun noema-research-view-write (file document focus folds)
  "Persist FOCUS and FOLDS for DOCUMENT stored at FILE and return the path."
  (noema-research-state-directory file)
  (let ((path (noema-research-view-file file document)))
    (make-directory (file-name-directory path) t)
    (let ((coding-system-for-write 'utf-8-unix))
      (write-region (noema-research-serialize
                     (noema-research--table "focus" (or focus :null)
                                            "folds" (vconcat folds)))
                    nil path nil 'silent))
    path))

(provide 'noema-research)

;;; noema-research.el ends here
