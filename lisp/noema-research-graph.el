;;; noema-research-graph.el --- Graph Board for research notebooks -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; The Graph Board is an interactive projection of a research notebook's
;; lineage graph.  Graphviz computes the layout (`dot -Tjson'); Noema draws its
;; own SVG scene with clickable nodes.  The buffer deliberately contains only
;; the DAG; discoverable commands live behind `?', and keyboard navigation is
;; geometric rather than an additional text outline.  Every command is a
;; semantic edit applied to the notebook through its JuText buffer; folding and
;; focus are view state stored under `<repository>/.agent/views/'.

;;; Code:

(require 'cl-lib)
(require 'dom)
(require 'seq)
(require 'subr-x)
(require 'svg)
(require 'transient)
(require 'noema-research)
(require 'noema-research-mode)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function noema-agent-worker-run-work-cell
                  "noema-agent-worker" (file cell-id &optional session-policy parent-session-id))
(declare-function evil-local-set-key "evil-core" (state key def))

(defcustom noema-research-graph-dot-program "dot"
  "Graphviz program used to lay out the research graph."
  :type 'string
  :group 'noema-research)

(defvar-local noema-research-graph--source nil
  "JuText buffer displayed by this Graph Board.")

(defvar-local noema-research-graph--focus nil
  "Focused cell id, or nil.")

(defvar-local noema-research-graph--folds nil
  "Folded cell ids.")

(defvar-local noema-research-graph--zoom "branch"
  "Semantic zoom level: overview, branch, or detail.")

(defvar-local noema-research-graph--selected nil
  "Selected cell id, or nil.")

(defvar-local noema-research-graph--proposals nil
  "Pending Proposal rows projected as ghost nodes.")

(defvar-local noema-research-graph--runs nil
  "Durable Run rows used for status, activity and detail projection.")

(defvar-local noema-research-graph--events nil
  "Durable research events used to derive WorkNode activity times.")

(defvar-local noema-research-graph--artifacts nil
  "ArtifactLink rows used by the detail projection.")

(defvar-local noema-research-graph--layout-cache nil
  "Latest Graphviz layout, used for geometric keyboard navigation.")

(defvar-local noema-research-graph--window-size nil
  "Last pixel size used to fit this DAG buffer.")

(defconst noema-research-graph-buffer-name "*Noema DAG*"
  "Name of the single reusable research DAG buffer.")

(defconst noema-research-graph--fills
  '(("question" . "#e8f0fe") ("work" . "#e6f4ea")
    ("checkpoint" . "#fef7e0") ("summary" . "#f3e8fd")
    ("run" . "#f1f3f4") ("artifact" . "#fce8e6"))
  "SVG fill colours by research kind.")

(defconst noema-research-graph--bindings
  '(("n" . noema-research-graph-continue)
    ("s" . noema-research-graph-sibling)
    ("c" . noema-research-graph-checkpoint)
    ("p" . noema-research-graph-edit-lineage)
    ("D" . noema-research-graph-edit-depends)
    ("d" . noema-research-graph-mark-done)
    ("x" . noema-research-graph-drop)
    ("R" . noema-research-graph-reopen)
    ("TAB" . noema-research-graph-toggle-fold)
    ("f" . noema-research-graph-toggle-focus)
    ("F" . noema-research-graph-run-fork)
    ("e" . noema-research-graph-execute)
    ("z" . noema-research-graph-cycle-zoom)
    ("X" . noema-research-graph-structure)
    ("i" . noema-research-graph-inspect)
    ("a" . noema-research-attention)
    ("RET" . noema-research-graph-visit)
    ("q" . noema-research-graph-quit)
    ("g" . noema-research-graph-refresh-all)
    ("?" . noema-research-graph-help)
    ("h" . noema-research-graph-move-left)
    ("j" . noema-research-graph-move-down)
    ("k" . noema-research-graph-move-up)
    ("l" . noema-research-graph-move-right)
    ("<left>" . noema-research-graph-move-left)
    ("<down>" . noema-research-graph-move-down)
    ("<up>" . noema-research-graph-move-up)
    ("<right>" . noema-research-graph-move-right))
  "Graph Board keys shared by vanilla Emacs and Evil normal state.")

(defvar noema-research-graph-mode-map
  (let ((map (make-sparse-keymap)))
    (dolist (binding noema-research-graph--bindings)
      (define-key map (kbd (car binding)) (cdr binding)))
    map)
  "Keymap for `noema-research-graph-mode'.")

(autoload 'noema-research-attention "noema-research-inspector" nil t)

(define-derived-mode noema-research-graph-mode special-mode "Noema-Graph"
  "Navigate and edit the lineage graph of a research notebook.

\\{noema-research-graph-mode-map}"
  (setq-local truncate-lines t)
  ;; AaronEmacs uses Evil normal state in special modes.  Its minor-mode map
  ;; otherwise shadows every single-letter Graph Board command.
  (when (fboundp 'evil-local-set-key)
    (dolist (binding noema-research-graph--bindings)
      (evil-local-set-key 'normal (kbd (car binding)) (cdr binding)))))

(transient-define-prefix noema-research-graph-help ()
  "Show the Graph Board's contextual command reference."
  [["Navigate"
    ("h/←" "left" noema-research-graph-move-left)
    ("j/↓" "down" noema-research-graph-move-down)
    ("k/↑" "up" noema-research-graph-move-up)
    ("l/→" "right" noema-research-graph-move-right)
    ("RET" "visit selected node" noema-research-graph-visit)
    ("q" "close graph" noema-research-graph-quit)]
   ["View"
    ("TAB" "fold branch" noema-research-graph-toggle-fold)
    ("f" "focus branch" noema-research-graph-toggle-focus)
    ("z" "semantic zoom" noema-research-graph-cycle-zoom)
    ("g" "refresh data" noema-research-graph-refresh-all)]
   ["Selected node"
    ("e" "run" noema-research-graph-execute)
    ("i" "inspect" noema-research-graph-inspect)
    ("n" "continue" noema-research-graph-continue)
    ("s" "sibling" noema-research-graph-sibling)
    ("c" "checkpoint" noema-research-graph-checkpoint)
    ("X" "structure" noema-research-graph-structure)]
   ["State / relations"
    ("d" "done" noema-research-graph-mark-done)
    ("x" "drop" noema-research-graph-drop)
    ("R" "reopen" noema-research-graph-reopen)
    ("p" "lineage" noema-research-graph-edit-lineage)
    ("D" "depends" noema-research-graph-edit-depends)
    ("a" "Attention" noema-research-attention)]])

(defun noema-research-graph-quit ()
  "Dismiss the temporary Graph pop-up and return to JuText."
  (interactive)
  (quit-window nil (selected-window)))

(defun noema-research-graph-pop-buffer (graph)
  "Show GRAPH as a temporary pop-up and return it.
This deliberately uses `display-buffer-pop-up-window' rather than a side or
dedicated workspace window, so `q' and visiting a node restore the prior
JuText layout exactly."
  (pop-to-buffer
   graph
   '((display-buffer-reuse-window display-buffer-pop-up-window)
     (inhibit-same-window . t)
     (window-height . 0.42)))
  ;; Initial rendering can happen before the pop-up has dimensions.
  (with-current-buffer graph
    (noema-research-graph-refresh))
  graph)

;;;; Source access

(defun noema-research-graph--document ()
  "Return the synced document of the source JuText buffer."
  (unless (buffer-live-p noema-research-graph--source)
    (user-error "The research notebook buffer is no longer live"))
  (with-current-buffer noema-research-graph--source
    (noema-research-mode--sync)))

(defun noema-research-graph--value (object key &optional default)
  "Read string KEY from JSON-like OBJECT, returning DEFAULT when absent."
  (let ((missing (make-symbol "noema-missing")))
    (let ((value (cond
                  ((hash-table-p object) (gethash key object missing))
                  ((listp object)
                   (let ((entry (or (assoc key object)
                                    (assq (intern-soft key) object))))
                     (if entry (cdr entry) missing)))
                  (t missing))))
      (if (eq value missing) default value))))

(defun noema-research-graph--sequence (value)
  "Return JSON array VALUE as a list."
  (cond ((vectorp value) (append value nil))
        ((listp value) value)
        (t nil)))

(defun noema-research-graph--ghost-p (id)
  "Return non-nil when ID names a pending Proposal ghost."
  (seq-some
   (lambda (proposal)
     (let* ((payload (or (noema-research-graph--value proposal "reviewedPayload")
                         (noema-research-graph--value proposal "payload")))
            (cell (or (noema-research-graph--value payload "cell") payload)))
       (equal id (noema-research-graph--value cell "cellId"))))
   noema-research-graph--proposals))

(defun noema-research-graph--require-materialized (id)
  "Require graph node ID to be a materialized notebook cell."
  (cond
   ((noema-research-graph--ghost-p id)
    (user-error "This is a pending Proposal ghost; review it in Attention (a)"))
   ((string-prefix-p "noema-summary:" id)
    (user-error "This is a folded graph summary; expand or change focus first"))
   ((string-prefix-p "run:" id)
    (user-error "This is a Run projection; select its WorkNode to edit structure"))
   ((string-prefix-p "artifact:" id)
    (user-error "This is an Artifact projection; select its WorkNode to edit structure"))))

(defun noema-research-graph--node-at-point ()
  "Return the node id at point or the selected node."
  (or (get-text-property (point) 'noema-research-node)
      noema-research-graph--selected
      (user-error "No graph node at point")))

(defun noema-research-graph--in-source (id function)
  "Call FUNCTION in the source buffer with point on cell ID."
  (noema-research-graph--require-materialized id)
  (let ((graph (current-buffer)))
    (with-current-buffer noema-research-graph--source
      (noema-research-mode--sync)
      (noema-research-goto-cell id)
      (funcall function))
    (when (buffer-live-p graph)
      (with-current-buffer graph
        (setq noema-research-graph--selected id)
        (noema-research-graph-refresh)))))

(defun noema-research-graph--jump-and-call (function)
  "Visit the node at point in its source buffer and call FUNCTION there.
The Graph Board is a temporary pop-up: visiting a node restores the prior
JuText window instead of leaving a dedicated DAG window behind."
  (let ((id (noema-research-graph--node-at-point))
        (source noema-research-graph--source)
        (graph-window (selected-window)))
    (noema-research-graph--require-materialized id)
    (quit-window nil graph-window)
    (pop-to-buffer source)
    (with-current-buffer source
      (noema-research-mode--sync)
      (noema-research-goto-cell id)
      (when function (funcall function)))))

(defun noema-research-graph--save-view ()
  "Persist the board's focus and folds next to the notebook."
  (when-let* ((file (buffer-file-name noema-research-graph--source)))
    (noema-research-view-write
     file (buffer-local-value 'noema-research--document noema-research-graph--source)
     noema-research-graph--focus noema-research-graph--folds
     noema-research-graph--zoom)))

(defun noema-research-graph--lineage-maps (document)
  "Return (CHILDREN PARENTS) hash tables for DOCUMENT's lineage edges."
  (let ((children (make-hash-table :test #'equal))
        (parents (make-hash-table :test #'equal)))
    (dolist (edge (noema-research-dependencies document))
      (when (equal (noema-research--get edge "type") "lineage")
        (let ((from (noema-research--get edge "from"))
              (to (noema-research--get edge "to")))
          (puthash from (append (gethash from children) (list to)) children)
          (puthash to (append (gethash to parents) (list from)) parents))))
    (list children parents)))

(defun noema-research-graph--walk (start graph)
  "Return ids reachable below START in adjacency hash GRAPH."
  (let ((seen (make-hash-table :test #'equal))
        (stack (copy-sequence (gethash start graph)))
        result)
    (while stack
      (let ((id (pop stack)))
        (unless (gethash id seen)
          (puthash id t seen)
          (push id result)
          (setq stack (append (gethash id graph) stack)))))
    (nreverse result)))

(defun noema-research-graph--automatic-folds (document)
  "Return deterministic semantic folds for the current zoom and selection."
  (when (equal noema-research-graph--zoom "overview")
    (pcase-let* ((`(,children ,parents) (noema-research-graph--lineage-maps document))
                 (anchor (or noema-research-graph--focus
                             noema-research-graph--selected))
                 (protected (make-hash-table :test #'equal))
                 (automatic nil))
      (when anchor
        (puthash anchor t protected)
        (dolist (id (noema-research-graph--walk anchor parents))
          (puthash id t protected)))
      (dolist (node (noema-research-work-nodes document))
        (let* ((id (noema-research-work-node-id node))
               (state (noema-research-work-node-field node "state"))
               (descendants (noema-research-graph--walk id children)))
          (when (and descendants
                     (member state '("done" "dropped"))
                     (not (gethash id protected))
                     (not (seq-some
                           (lambda (fold)
                             (member id (noema-research-graph--walk fold children)))
                           automatic)))
            (setq automatic (append automatic (list id))))))
      automatic)))

(defun noema-research-graph--run-time (run)
  "Return RUN's latest durable timestamp, or nil."
  (or (noema-research-graph--value run "finishedAt")
      (noema-research-graph--value run "finished_at")
      (noema-research-graph--value run "startedAt")
      (noema-research-graph--value run "started_at")
      (noema-research-graph--value run "createdAt")
      (noema-research-graph--value run "created_at")))

(defun noema-research-graph--later-time (left right)
  "Return the later non-empty ISO timestamp of LEFT and RIGHT."
  (cond ((not (stringp left)) right)
        ((not (stringp right)) left)
        ((string-lessp left right) right)
        (t left)))

(defun noema-research-graph--runtime-run (work-node-id)
  "Return the latest durable Run for WORK-NODE-ID."
  (let (latest latest-time)
    (dolist (run noema-research-graph--runs latest)
      (when (equal (or (noema-research-graph--value run "workNodeId")
                       (noema-research-graph--value run "work_node_id"))
                   work-node-id)
        (let ((time (noema-research-graph--run-time run)))
          (when (or (null latest)
                    (and (stringp time)
                         (or (not (stringp latest-time))
                             (string-lessp latest-time time))))
            (setq latest run latest-time time)))))))

(defun noema-research-graph--event-time (work-node-id)
  "Return the latest durable event time for WORK-NODE-ID."
  (let (latest)
    (dolist (event noema-research-graph--events latest)
      (when (equal (or (noema-research-graph--value event "work_node_id")
                       (noema-research-graph--value event "workNodeId"))
                   work-node-id)
        (setq latest
              (noema-research-graph--later-time
               latest (noema-research-graph--value event "ts")))))))

(defun noema-research-graph--activity (document work-node-id)
  "Return latest Run activity plist for WORK-NODE-ID in DOCUMENT."
  (let* ((cell (noema-research-primary-cell document work-node-id))
         (persisted (and cell (noema-research-cell-latest-run cell)))
         (run (noema-research-graph--runtime-run work-node-id))
         (event-time (noema-research-graph--event-time work-node-id)))
    (when (or run persisted event-time)
      (list :run-id (or (and run (noema-research-graph--value run "id"))
                        (plist-get persisted :id) "")
            :run-status (or (and run (noema-research-graph--value run "status"))
                            (plist-get persisted :status) "")
            :agent (or (and run (or (noema-research-graph--value run "adapter")
                                    (noema-research-graph--value run "agent")))
                       (plist-get persisted :agent) "")
            :last-activity (noema-research-graph--later-time
                            (noema-research-graph--later-time
                             (and run (noema-research-graph--run-time run))
                             (plist-get persisted :finished-at))
                            event-time)))))

(defun noema-research-graph--count (key counts)
  "Increment KEY in alist COUNTS and return the alist."
  (if-let* ((entry (assoc key counts)))
      (progn (setcdr entry (1+ (cdr entry))) counts)
    (append counts (list (cons key 1)))))

(defun noema-research-graph--semantic-summary (document ids)
  "Summarize WorkNode IDS from DOCUMENT for a contraction node."
  (let (outcomes kinds last-activity)
    (dolist (id ids)
      (when-let* ((node (noema-research-find-work-node document id)))
        (setq kinds (noema-research-graph--count
                     (noema-research-work-node-field node "kind") kinds))
        (when-let* ((outcome (noema-research-work-node-field node "outcome")))
          (setq outcomes (noema-research-graph--count outcome outcomes)))
        (setq last-activity
              (noema-research-graph--later-time
               last-activity
               (plist-get (noema-research-graph--activity document id)
                          :last-activity)))))
    (let* ((ranked (sort (copy-sequence outcomes)
                         (lambda (left right)
                           (if (= (cdr left) (cdr right))
                               (< (or (seq-position noema-research-work-outcomes
                                                    (car left) #'equal)
                                      most-positive-fixnum)
                                  (or (seq-position noema-research-work-outcomes
                                                    (car right) #'equal)
                                      most-positive-fixnum))
                             (> (cdr left) (cdr right))))))
           (primary (caar ranked)))
      (list :nodes (length ids) :kinds kinds :outcomes outcomes
            :primary-outcome primary :last-activity last-activity))))

(defun noema-research-graph--summary-outcome (summary)
  "Return an honest outcome label for fold SUMMARY.
When the leading outcomes are tied, show every tied outcome and its count
instead of choosing an arbitrary winner."
  (let* ((outcomes (plist-get summary :outcomes))
         (highest (and outcomes (apply #'max (mapcar #'cdr outcomes))))
         (leaders (seq-filter (lambda (entry) (= (cdr entry) highest)) outcomes)))
    (if (> (length leaders) 1)
        (mapconcat
         (lambda (outcome)
           (format "%s %d" (noema-research-graph--humanize (car outcome))
                   (cdr outcome)))
         (seq-filter
          (lambda (entry) (assoc (car entry) leaders))
          (mapcar (lambda (name) (cons name (or (cdr (assoc name outcomes)) 0)))
                  noema-research-work-outcomes))
         " · ")
      (noema-research-graph--humanize (plist-get summary :primary-outcome)))))

(defun noema-research-graph--decorate-projection (projection document)
  "Add Run activity and rich fold summaries to PROJECTION."
  (pcase-let ((`(,children ,_parents) (noema-research-graph--lineage-maps document)))
    (let ((visible (make-hash-table :test #'equal)))
      (dolist (node (plist-get projection :nodes))
        (puthash (plist-get node :id) t visible))
      (dolist (node (plist-get projection :nodes))
        (let* ((id (plist-get node :id))
               (work-node (noema-research-find-work-node document id))
               (activity (noema-research-graph--activity document id)))
          (when work-node
            (setq node
                  (plist-put node :dropped-reason
                             (noema-research-work-node-field
                              work-node "dropped_reason"))))
          (while activity
            (setq node (plist-put node (pop activity) (pop activity))))
          (when (numberp (plist-get node :folded))
            (let ((ids (cons id
                             (seq-remove (lambda (candidate)
                                           (gethash candidate visible))
                                         (noema-research-graph--walk id children)))))
              (setq node
                    (plist-put
                     node :fold-summary
                     (let ((summary (noema-research-graph--semantic-summary
                                     document ids))
                           (anchor (or noema-research-graph--focus
                                       noema-research-graph--selected)))
                       (when (and anchor
                                  (member id noema-research-graph--folds)
                                  (member anchor
                                          (noema-research-graph--walk id children)))
                         (setq summary (plist-put summary :path-preserved t)))
                       summary)))))))
      projection)))

(defun noema-research-graph--focus-summaries (projection document)
  "Add visible contraction nodes for branches omitted by the focus lens."
  (if (not (plist-get projection :focus))
      projection
    (pcase-let ((`(,children ,_parents) (noema-research-graph--lineage-maps document)))
      (let ((visible (make-hash-table :test #'equal))
            (represented (make-hash-table :test #'equal))
            (assigned (make-hash-table :test #'equal))
            (nodes (copy-sequence (plist-get projection :nodes)))
            (edges (copy-sequence (plist-get projection :edges))))
        (dolist (node nodes)
          (unless (or (plist-get node :summary) (plist-get node :run))
            (puthash (plist-get node :id) t visible))
          (when (numberp (plist-get node :folded))
            (dolist (id (noema-research-graph--walk (plist-get node :id) children))
              (puthash id t represented))))
        ;; Traverse the projection order instead of hash order so the same
        ;; notebook and view always produce the same contraction nodes.
        (dolist (parent-node (copy-sequence nodes))
          (let ((parent (plist-get parent-node :id))
                omitted)
            (when (gethash parent visible)
              (dolist (child (gethash parent children))
                (when (and (not (gethash child visible))
                           (not (gethash child represented))
                           (not (gethash child assigned)))
                  (dolist (id (cons child (noema-research-graph--walk child children)))
                    (when (and (not (gethash id visible))
                               (not (gethash id represented))
                               (not (gethash id assigned)))
                      (puthash id t assigned)
                      (push id omitted)))))
              (when omitted
                (setq omitted (nreverse omitted))
                (let* ((id (concat "noema-summary:related:"
                                   (substring (secure-hash 'sha256 parent) 0 12)))
                       (summary (noema-research-graph--semantic-summary
                                 document omitted)))
                  (setq nodes
                        (append nodes
                                (list (list :id id :kind "summary"
                                            :title "Related branches"
                                            :summary t :parents (list parent)
                                            :fold-summary summary))))
                  (setq edges (append edges (list (list parent id "lineage")))))))))
        (plist-put (plist-put projection :nodes nodes) :edges edges)))))

(defun noema-research-graph--detail-runs (projection)
  "Project each visible WorkNode's latest Run into DETAIL PROJECTION."
  (if (not (equal noema-research-graph--zoom "detail"))
      projection
    (let ((nodes (copy-sequence (plist-get projection :nodes)))
          (edges (copy-sequence (plist-get projection :edges))))
      (dolist (node (copy-sequence nodes))
        (when-let* ((run-id (plist-get node :run-id))
                    ((not (string-empty-p run-id))))
          (let ((id (concat "run:" run-id)))
            (setq nodes
                  (append nodes
                          (list (list :id id :kind "run" :title "Agent Run"
                                      :state (plist-get node :run-status)
                                      :agent (plist-get node :agent)
                                      :last-activity (plist-get node :last-activity)
                                      :run t :parents (list (plist-get node :id))))))
            (setq edges (append edges (list (list (plist-get node :id) id "run")))))))
      (plist-put (plist-put projection :nodes nodes) :edges edges))))

(defun noema-research-graph--detail-artifacts (projection)
  "Project ArtifactLinks attached to visible WorkNodes into DETAIL PROJECTION."
  (if (not (equal noema-research-graph--zoom "detail"))
      projection
    (let ((nodes (copy-sequence (plist-get projection :nodes)))
          (edges (copy-sequence (plist-get projection :edges)))
          (visible (make-hash-table :test #'equal))
          (projected (make-hash-table :test #'equal)))
      (dolist (node nodes)
        (puthash (plist-get node :id) t visible))
      (dolist (link noema-research-graph--artifacts)
        (let* ((parent (or (noema-research-graph--value link "workNodeId")
                           (noema-research-graph--value link "work_node_id")))
               (artifact (noema-research-graph--value link "artifact"))
               (artifact-id (and artifact
                                 (noema-research-graph--value artifact "id")))
               (source (noema-research-graph--value link "sourceUri"))
               (relation (or (noema-research-graph--value link "relation")
                             "produced"))
               (id (and (stringp parent) (stringp artifact-id)
                        (format "artifact:%s:%s" artifact-id
                                (substring (secure-hash 'sha256 parent) 0 8)))))
          (when (and id (gethash parent visible) (not (gethash id projected)))
            (puthash id t projected)
            (setq nodes
                  (append nodes
                          (list
                           (list :id id :kind "artifact"
                                 :title (if (and (stringp source)
                                                 (not (string-empty-p source)))
                                            source
                                          (format "Artifact %s" artifact-id))
                                 :relation relation
                                 :media-type (noema-research-graph--value
                                              artifact "mediaType")
                                 :last-activity
                                 (noema-research-graph--value link "createdAt")
                                 :artifact t :parents (list parent)))))
            (setq edges (append edges (list (list parent id "artifact")))))))
      (plist-put (plist-put projection :nodes nodes) :edges edges))))

(defun noema-research-graph--projection (document)
  "Return the semantic Graph Board projection for DOCUMENT."
  (let* ((folds (delete-dups
                 (append noema-research-graph--folds
                         (noema-research-graph--automatic-folds document))))
         (projection (noema-research-projection
                      document :focus noema-research-graph--focus :folds folds
                      :protect (delq nil (list noema-research-graph--focus
                                               noema-research-graph--selected)))))
    (setq projection (noema-research-graph--decorate-projection projection document)
          projection (noema-research-graph--focus-summaries projection document)
          projection (noema-research-graph--detail-runs projection)
          projection (noema-research-graph--detail-artifacts projection))
    projection))

;;;; Layout

(defun noema-research-graph--humanize (value)
  "Return VALUE with storage separators made readable."
  (and (stringp value) (replace-regexp-in-string "_" " " value)))

(defun noema-research-graph--short-time (value)
  "Return a compact display form of ISO timestamp VALUE."
  (when (and (stringp value) (not (string-empty-p value)))
    (if (string-match
         "\\`\\([0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}\\)[T ]\\([0-9]\\{2\\}:[0-9]\\{2\\}\\)"
         value)
        (format "%s %s" (match-string 1 value) (match-string 2 value))
      value)))

(defun noema-research-graph--label-lines (node)
  "Return semantic display lines for projection NODE."
  (let* ((limit (pcase noema-research-graph--zoom
                  ("overview" 34) ("detail" 72) (_ 52)))
         (title (concat (if (plist-get node :ghost) "◇ " "")
                        (if (equal (plist-get node :kind) "question") "? " "")
                        (truncate-string-to-width
                         (or (plist-get node :title) "Untitled") limit nil nil "…")))
         (fold (plist-get node :fold-summary))
         (state (noema-research-graph--humanize (plist-get node :state)))
         (outcome (noema-research-graph--humanize (plist-get node :outcome)))
         (run-status (noema-research-graph--humanize (plist-get node :run-status)))
         (agent (plist-get node :agent))
         lines)
    (push title lines)
    (cond
     (fold
     (push (string-join
             (delq nil
                   (list (concat "▸"
                                 (when-let* ((summary-outcome
                                              (noema-research-graph--summary-outcome fold)))
                                   (concat " " summary-outcome)))
                         (format "%d nodes" (or (plist-get fold :nodes) 0))))
             " · ")
            lines)
      (when (plist-get fold :path-preserved)
        (push "current path preserved" lines))
      (when-let* ((time (noema-research-graph--short-time
                         (plist-get fold :last-activity))))
        (push (concat "last " time) lines)))
     ((plist-get node :run)
      (push (string-join (delq nil (list agent state)) " · ") lines)
      (when-let* ((time (noema-research-graph--short-time
                         (plist-get node :last-activity))))
        (push time lines)))
     ((plist-get node :artifact)
      (push (string-join
             (delq nil
                   (list (noema-research-graph--humanize
                          (plist-get node :relation))
                         (plist-get node :media-type)))
             " · ")
            lines)
      (when-let* ((time (noema-research-graph--short-time
                         (plist-get node :last-activity))))
        (push time lines)))
     (t
     (when-let* ((semantic (delq nil (list state outcome
                                             (and run-status
                                                  (concat "run " run-status))))))
        (push (string-join semantic " · ") lines))))
    (when-let* ((reason (plist-get node :dropped-reason)))
      (push (truncate-string-to-width reason limit nil nil "…") lines))
    (nreverse (seq-filter (lambda (line)
                            (and (stringp line) (not (string-empty-p line))))
                          lines))))

(defun noema-research-graph--label (node)
  "Return the complete drawn label of projection NODE."
  (string-join (noema-research-graph--label-lines node) "\n"))

(defun noema-research-graph--with-proposals (projection document proposals)
  "Merge pending cell PROPOSALS for DOCUMENT into graph PROJECTION."
  (let ((notebook-id (noema-research-notebook-id document))
        (nodes (copy-sequence (plist-get projection :nodes)))
        (edges (copy-sequence (plist-get projection :edges)))
        (ids (make-hash-table :test #'equal))
        ghosts)
    (dolist (node nodes) (puthash (plist-get node :id) t ids))
    (dolist (proposal proposals)
      (let* ((status (noema-research-graph--value proposal "status" ""))
             (payload (if (equal status "accepting")
                          (or (noema-research-graph--value proposal "reviewedPayload")
                              (noema-research-graph--value proposal "payload"))
                        (noema-research-graph--value proposal "payload")))
             (cell (or (noema-research-graph--value payload "cell") payload))
             (id (noema-research-graph--value cell "cellId"))
             (parent (noema-research-resolve-work-node-id
                      document (noema-research-graph--value cell "lineageParent")))
             (kind (noema-research-graph--value cell "kind" "work"))
             (title (noema-research-graph--value cell "title" "Untitled Proposal")))
        (when (and (member status '("pending" "accepting"))
                   (equal (noema-research-graph--value proposal "kind") "cell.create")
                   (equal (noema-research-graph--value cell "notebookId") notebook-id)
                   (stringp id) (not (string-empty-p id)) (not (gethash id ids)))
          (puthash id t ids)
          (push (list :id id :kind kind :title title :state status
                      :parents (and (stringp parent) (list parent))
                      :ghost t
                      :proposal-id (noema-research-graph--value proposal "id"))
                ghosts))))
    (setq ghosts (nreverse ghosts)
          nodes (append nodes ghosts))
    (dolist (node ghosts)
      (let ((id (plist-get node :id)))
        (dolist (parent (plist-get node :parents))
          (when (gethash parent ids)
            (setq edges (append edges (list (list parent id "lineage"))))))
        (let* ((proposal (seq-find
                          (lambda (candidate)
                            (let* ((payload (or (noema-research-graph--value candidate "reviewedPayload")
                                                (noema-research-graph--value candidate "payload")))
                                   (cell (or (noema-research-graph--value payload "cell") payload)))
                              (equal id (noema-research-graph--value cell "cellId"))))
                          proposals))
               (payload (or (noema-research-graph--value proposal "reviewedPayload")
                            (noema-research-graph--value proposal "payload")))
               (cell (or (noema-research-graph--value payload "cell") payload)))
          (dolist (dependency (noema-research-graph--sequence
                               (noema-research-graph--value cell "depends")))
            (let ((resolved (noema-research-resolve-work-node-id document dependency)))
              (when (and resolved (gethash resolved ids))
                (setq edges (append edges (list (list resolved id "depends"))))))))))
    (plist-put (plist-put (copy-sequence projection) :nodes nodes) :edges edges)))

(defun noema-research-graph--dot-quote (text)
  "Return TEXT as a quoted Graphviz string."
  (let ((escaped (replace-regexp-in-string "[\"\\\\]" "\\\\\\&" text)))
    (setq escaped (replace-regexp-in-string "\r" "" escaped)
          ;; Graphviz uses one backslash followed by n for a centred line
          ;; break.  With LITERAL non-nil the replacement must contain exactly
          ;; that pair, not a doubled backslash that Graphviz prints verbatim.
          escaped (replace-regexp-in-string "\n" "\\n" escaped nil t))
    (concat "\"" escaped "\"")))

(defun noema-research-graph--dot-source (projection)
  "Return (DOT . NAMES) for PROJECTION, NAMES mapping cell ids to node names."
  (let ((names (make-hash-table :test #'equal))
        (index 0))
    (with-temp-buffer
      (insert "digraph noema {\n  rankdir=TB;\n  nodesep=0.35;\n  ranksep=0.45;\n"
              ;; Graphviz must reserve room for the largest face used by our
              ;; SVG painter.  The first line is 11px semibold and later
              ;; lines are smaller, so sizing every line as Helvetica Bold 11
              ;; is deliberately conservative and prevents text overflow.
              "  node [shape=box, fontname=\"Helvetica Bold\", fontsize=11, margin=\"0.14,0.10\"];\n")
      (dolist (node (plist-get projection :nodes))
        (let* ((name (format "n%d" index))
               (kind (plist-get node :kind))
               (shape (pcase kind
                        ("checkpoint" "diamond")
                        ("run" "ellipse")
                        (_ "box"))))
          (puthash (plist-get node :id) name names)
          (setq index (1+ index))
          (insert (format "  %s [shape=%s, label=%s];\n" name shape
                          (noema-research-graph--dot-quote
                           (noema-research-graph--label node))))))
      (dolist (edge (plist-get projection :edges))
        (insert (format "  %s -> %s%s;\n"
                        (gethash (nth 0 edge) names) (gethash (nth 1 edge) names)
                        (pcase (nth 2 edge)
                          ("depends" " [style=dashed, constraint=false]")
                          ((or "run" "artifact") " [style=dotted]")
                          (_ "")))))
      (insert "}\n")
      (cons (buffer-string) names))))

(defun noema-research-graph--points (points height)
  "Convert Graphviz POINTS to top-left coordinates for a drawing of HEIGHT."
  (mapcar (lambda (point) (cons (float (aref point 0)) (- height (aref point 1))))
          (append points nil)))

(defun noema-research-graph--layout (projection)
  "Return a Graphviz layout plist for PROJECTION, or nil without Graphviz.
The plist has :width, :height, :nodes (plists :id :x :y :width :height) and
:edges (plists :points :arrow :dashed), in top-left coordinates."
  (when-let* ((program (executable-find noema-research-graph-dot-program)))
    (pcase-let ((`(,source . ,names) (noema-research-graph--dot-source projection)))
      (with-temp-buffer
        (insert source)
        (when (zerop (call-process-region (point-min) (point-max) program t t nil "-Tjson"))
          (let* ((json (noema-research-parse-json (buffer-string)))
                 (bb (mapcar #'string-to-number
                             (split-string (noema-research--get json "bb" "0,0,0,0") ",")))
                 (height (float (nth 3 bb)))
                 (ids (make-hash-table :test #'equal))
                 nodes edges)
            (maphash (lambda (id name) (puthash name id ids)) names)
            (seq-doseq (object (noema-research--get json "objects" []))
              (when-let* ((id (gethash (noema-research--get object "name") ids))
                          (pos (noema-research--get object "pos")))
                (let ((xy (mapcar #'string-to-number (split-string pos ","))))
                  (push (list :id id
                              :x (float (nth 0 xy))
                              :y (- height (nth 1 xy))
                              :width (* 72 (string-to-number
                                            (format "%s" (noema-research--get object "width" "0"))))
                              :height (* 72 (string-to-number
                                             (format "%s" (noema-research--get object "height" "0")))))
                        nodes))))
            (seq-doseq (edge (noema-research--get json "edges" []))
              (let (points arrow)
                (seq-doseq (op (noema-research--get edge "_draw_" []))
                  (when (member (noema-research--get op "op") '("b" "B"))
                    (setq points (noema-research-graph--points
                                  (noema-research--get op "points" []) height))))
                (seq-doseq (op (noema-research--get edge "_hdraw_" []))
                  (when (member (noema-research--get op "op") '("P" "p"))
                    (setq arrow (noema-research-graph--points
                                 (noema-research--get op "points" []) height))))
                (let ((style (noema-research--get edge "style")))
                  (push (list :points points :arrow arrow :style style
                              :dashed (equal style "dashed"))
                        edges))))
            (list :width (float (nth 2 bb)) :height height
                  :nodes (nreverse nodes) :edges (nreverse edges))))))))

;;;; Drawing

(defun noema-research-graph--path (points margin)
  "Return an SVG cubic path through POINTS offset by MARGIN."
  (let ((shifted (mapcar (lambda (point)
                           (format "%.1f %.1f" (+ margin (car point)) (+ margin (cdr point))))
                         points)))
    (concat "M " (car shifted) " C " (string-join (cdr shifted) " "))))

(defun noema-research-graph--fit-scale (layout)
  "Return a scale that fits LAYOUT in the displayed Graph window."
  (if-let* ((window (get-buffer-window (current-buffer) t))
            (available-width (max 120 (- (window-body-width window t) 12)))
            (available-height (max 120 (- (window-body-height window t) 12))))
      (min 1.0
           (/ (float available-width) (+ 16.0 (plist-get layout :width)))
           (/ (float available-height) (+ 16.0 (plist-get layout :height))))
    1.0))

(defun noema-research-graph--svg (projection layout selected &optional scale)
  "Return (SVG . MAP) drawing PROJECTION with LAYOUT, highlighting SELECTED.
SCALE changes the SVG viewport and its image-map coordinates while preserving
Graphviz's coordinate system through a viewBox."
  (let* ((margin 8)
         (scale (or scale 1.0))
         (natural-width (ceiling (+ (* 2 margin) (plist-get layout :width))))
         (natural-height (ceiling (+ (* 2 margin) (plist-get layout :height))))
         (svg (svg-create (max 1 (round (* scale natural-width)))
                          (max 1 (round (* scale natural-height)))
                          :viewBox (format "0 0 %d %d" natural-width natural-height)
                          :preserveAspectRatio "xMidYMid meet"))
         (by-id (make-hash-table :test #'equal))
         map)
    (dolist (node (plist-get projection :nodes))
      (puthash (plist-get node :id) node by-id))
    (dolist (edge (plist-get layout :edges))
      (when-let* ((points (plist-get edge :points)))
        (let ((dash (pcase (plist-get edge :style)
                      ("dashed" "5 4") ("dotted" "2 4") (_ nil))))
          (dom-append-child
           svg (dom-node 'path `((d . ,(noema-research-graph--path points margin))
                                 (fill . "none") (stroke . "#80868b")
                                 (stroke-width . "1.2")
                                 ,@(when dash `((stroke-dasharray . ,dash))))))))
      (when-let* ((arrow (plist-get edge :arrow)))
        (svg-polygon svg (mapcar (lambda (point)
                                   (cons (+ margin (car point)) (+ margin (cdr point))))
                                 arrow)
                     :fill "#80868b" :stroke "#80868b")))
    (dolist (box (plist-get layout :nodes))
      (let* ((id (plist-get box :id))
             (node (gethash id by-id))
             (width (plist-get box :width))
             (height (plist-get box :height))
             (x0 (+ margin (- (plist-get box :x) (/ width 2.0))))
             (y0 (+ margin (- (plist-get box :y) (/ height 2.0))))
             (cx (+ x0 (/ width 2.0)))
             (cy (+ y0 (/ height 2.0)))
             (kind (plist-get node :kind))
             (fill (or (cdr (assoc kind noema-research-graph--fills)) "#f1f3f4"))
             (stroke (cond ((equal id selected) "#1a73e8")
                           ((plist-get node :focus) "#d93025")
                           (t "#9aa0a6")))
             (stroke-width (if (equal id selected) 2.5 1))
             (dash (if (or (plist-get node :ghost)
                           (plist-get node :summary)
                           (equal (plist-get node :state) "dropped"))
                       "4 3" "none"))
             (shape-args (list :fill fill :stroke stroke
                               :stroke-width stroke-width
                               :stroke-dasharray dash))
             (lines (noema-research-graph--label-lines node))
             (line-height 13)
             (text-y (+ cy 4 (- (/ (* (1- (length lines)) line-height) 2.0)))))
        (pcase kind
          ("checkpoint"
           (apply #'svg-polygon svg
                  (list (cons cx y0) (cons (+ x0 width) cy)
                        (cons cx (+ y0 height)) (cons x0 cy))
                  shape-args))
          ("run"
           (apply #'svg-ellipse svg cx cy (/ width 2.0) (/ height 2.0) shape-args))
          (_
           (apply #'svg-rectangle svg x0 y0 width height
                  :rx (if (equal kind "summary") 12 6)
                  :ry (if (equal kind "summary") 12 6)
                  shape-args)))
        (cl-loop for line in lines
                 for index from 0
                 do (svg-text svg line
                              :x cx :y (+ text-y (* index line-height))
                              :text-anchor "middle"
                              :font-size (if (zerop index) 11 9.5)
                              :font-weight (if (zerop index) "600" "400")
                              :font-family "Helvetica"
                              :fill (if (zerop index) "#202124" "#5f6368")
                              :stroke "none"))
        (push `((rect . ((,(round (* scale x0)) . ,(round (* scale y0)))
                         . (,(round (* scale (+ x0 width)))
                            . ,(round (* scale (+ y0 height))))))
                ,(intern (concat "noema-node-" id))
                (pointer hand help-echo ,(string-join lines " — ")))
              map)))
    (cons svg map)))

(defun noema-research-graph--insert-image (projection)
  "Insert the Graphviz drawing of PROJECTION; return non-nil on success."
  (when-let* ((layout (and (plist-get projection :nodes)
                           (noema-research-graph--layout projection))))
    (setq noema-research-graph--layout-cache layout)
    (let ((scale (noema-research-graph--fit-scale layout)))
      (pcase-let ((`(,svg . ,map)
                   (noema-research-graph--svg projection layout
                                              noema-research-graph--selected
                                              scale)))
      (let ((keymap (make-sparse-keymap)))
        (dolist (area map)
          (let* ((symbol (nth 1 area))
                 (id (string-remove-prefix "noema-node-" (symbol-name symbol))))
            (define-key keymap (vector symbol 'mouse-1)
                        (lambda () (interactive) (noema-research-graph-select id)))
            (define-key keymap (vector symbol 'double-mouse-1)
                        (lambda ()
                          (interactive)
                          (setq noema-research-graph--selected id)
                          (noema-research-graph-visit)))))
        (set-keymap-parent keymap noema-research-graph-mode-map)
        (use-local-map keymap))
      (insert-image (svg-image svg :map map))
      t))))

(defun noema-research-graph--layout-node (id)
  "Return the cached layout node identified by ID."
  (seq-find (lambda (node) (equal (plist-get node :id) id))
            (plist-get noema-research-graph--layout-cache :nodes)))

(defun noema-research-graph--move (direction)
  "Move the DAG selection geometrically in DIRECTION."
  (unless noema-research-graph--layout-cache
    (user-error "The DAG has no Graphviz layout"))
  (let* ((nodes (plist-get noema-research-graph--layout-cache :nodes))
         (current (or (noema-research-graph--layout-node
                       noema-research-graph--selected)
                      (car (sort (copy-sequence nodes)
                                 (lambda (left right)
                                   (if (= (plist-get left :y) (plist-get right :y))
                                       (< (plist-get left :x) (plist-get right :x))
                                     (< (plist-get left :y) (plist-get right :y))))))))
         (cx (and current (plist-get current :x)))
         (cy (and current (plist-get current :y)))
         best best-score)
    (unless current
      (user-error "The DAG has no nodes"))
    (dolist (candidate nodes)
      (unless (eq candidate current)
        (let* ((dx (- (plist-get candidate :x) cx))
               (dy (- (plist-get candidate :y) cy))
               (primary (if (memq direction '(left right)) (abs dx) (abs dy)))
               (secondary (if (memq direction '(left right)) (abs dy) (abs dx)))
               (eligible (pcase direction
                           ('left (< dx -0.5))
                           ('right (> dx 0.5))
                           ('up (< dy -0.5))
                           ('down (> dy 0.5))))
               ;; Prefer the requested axis, then the closest adjacent lane.
               (score (+ primary (* secondary 2.0))))
          (when (and eligible (or (null best-score) (< score best-score)))
            (setq best candidate best-score score)))))
    (setq noema-research-graph--selected
          (plist-get (or best current) :id))
    (noema-research-graph-refresh)))

(defun noema-research-graph-move-left ()
  "Select the nearest DAG node to the left." (interactive)
  (noema-research-graph--move 'left))

(defun noema-research-graph-move-right ()
  "Select the nearest DAG node to the right." (interactive)
  (noema-research-graph--move 'right))

(defun noema-research-graph-move-up ()
  "Select the nearest DAG node above." (interactive)
  (noema-research-graph--move 'up))

(defun noema-research-graph-move-down ()
  "Select the nearest DAG node below." (interactive)
  (noema-research-graph--move 'down))

(defun noema-research-graph--insert-outline (projection)
  "Insert the navigable lineage outline of PROJECTION."
  (let ((nodes (plist-get projection :nodes))
        (by-id (make-hash-table :test #'equal))
        (children (make-hash-table :test #'equal))
        (depends (make-hash-table :test #'equal))
        (printed (make-hash-table :test #'equal)))
    (dolist (node nodes)
      (puthash (plist-get node :id) node by-id))
    (dolist (node nodes)
      (dolist (parent (plist-get node :parents))
        (puthash parent (append (gethash parent children) (list (plist-get node :id)))
                 children)))
    (dolist (edge (plist-get projection :edges))
      (when (equal (nth 2 edge) "depends")
        (puthash (nth 1 edge) (1+ (gethash (nth 1 edge) depends 0)) depends)))
    (cl-labels ((emit (id depth)
                  (let ((node (gethash id by-id))
                        (repeat (gethash id printed))
                        (start (point)))
                    (insert (make-string (* 2 depth) ?\s)
                            (if (plist-get node :ghost)
                                "◇ "
                              (pcase (plist-get node :kind)
                                ("question" "? ")
                                ("checkpoint" "◆ ")
                                ("summary" "▸ ")
                                ("run" "↳ ")
                                ("artifact" "⧉ ")
                                (_ "• ")))
                            (plist-get node :title))
                    (when-let* ((state (plist-get node :state)))
                      (insert " [" state
                              (if (plist-get node :outcome)
                                  (concat "/" (plist-get node :outcome))
                                "")
                              "]"))
                    (when (> (gethash id depends 0) 0)
                      (insert (format "  ⇠%d" (gethash id depends))))
                    (when-let* ((run-status (plist-get node :run-status)))
                      (insert (format "  {run:%s}" run-status)))
                    (when-let* ((summary (plist-get node :fold-summary)))
                      (insert (format "  {%s · %d nodes · last %s}"
                                      (or (noema-research-graph--humanize
                                           (plist-get summary :primary-outcome))
                                          "no outcome")
                                      (or (plist-get summary :nodes) 0)
                                      (or (noema-research-graph--short-time
                                           (plist-get summary :last-activity)) "—"))))
                    (when-let* ((reason (plist-get node :dropped-reason)))
                      (insert (format "  — %s" reason)))
                    (when (plist-get node :focus) (insert "  ◎"))
                    (when repeat (insert "  ↩"))
                    (add-text-properties start (point) `(noema-research-node ,id))
                    (when (equal id noema-research-graph--selected)
                      (add-face-text-property start (point) 'highlight))
                    (insert "\n")
                    (unless repeat
                      (puthash id t printed)
                      (dolist (child (gethash id children))
                        (emit child (1+ depth)))))))
      (dolist (node nodes)
        (unless (plist-get node :parents)
          (emit (plist-get node :id) 0)))
      (dolist (node nodes)
        (unless (gethash (plist-get node :id) printed)
          (emit (plist-get node :id) 0))))))

;;;; Commands

(defun noema-research-graph-refresh ()
  "Redraw the Graph Board."
  (interactive)
  (let* ((document (noema-research-graph--document))
         (projection (noema-research-graph--with-proposals
                      (noema-research-graph--projection document)
                      document noema-research-graph--proposals))
         (selected noema-research-graph--selected)
         (inhibit-read-only t))
    (use-local-map noema-research-graph-mode-map)
    (erase-buffer)
    (setq noema-research-graph--layout-cache nil)
    (if (and (display-images-p) (image-type-available-p 'svg)
             (noema-research-graph--insert-image projection))
        (goto-char (point-min))
      (insert (propertize
               "DAG rendering requires a graphical Emacs with SVG and Graphviz."
               'face 'warning)))
    (setq noema-research-graph--selected selected)))

(defun noema-research-graph-refresh-proposals ()
  "Refresh pending Proposal ghosts from the Noema authority."
  (interactive)
  (unless (fboundp 'my/noema-api-call)
    (when (called-interactively-p 'interactive)
      (user-error "Noema web-host integration is unavailable")))
  (when (and (fboundp 'my/noema-api-call)
             (buffer-live-p noema-research-graph--source))
    (let* ((graph (current-buffer))
           (source noema-research-graph--source)
           (document (with-current-buffer source (noema-research-mode--sync)))
           (file (buffer-local-value 'buffer-file-name source))
           (root (and file (noema-research-repository-root file)))
           (workstream-id (noema-research--get
                           (noema-research-notebook-meta document) "workstream_id" "")))
      (when root
        (my/noema-api-call
         "aaronnote:api:research:proposal:list"
         (vector `((cwd . ,root) (workstreamId . ,workstream-id) (limit . 1000)))
         (lambda (result error-object)
           (when (and (buffer-live-p graph)
                      (eq (buffer-local-value
                           'noema-research-graph--source graph)
                          source))
             (with-current-buffer graph
               (if error-object
                   (message "Noema Proposal ghost refresh failed")
                 (setq noema-research-graph--proposals
                       (noema-research-graph--sequence
                        (noema-research-graph--value result "proposals")))
                 (noema-research-graph-refresh))))))))))

(defun noema-research-graph-refresh-runs ()
  "Refresh durable Run activity used by the Graph Board."
  (interactive)
  (when (and (fboundp 'my/noema-api-call)
             (buffer-live-p noema-research-graph--source))
    (let* ((graph (current-buffer))
           (source noema-research-graph--source)
           (document (with-current-buffer source (noema-research-mode--sync)))
           (file (buffer-local-value 'buffer-file-name source))
           (root (and file (noema-research-repository-root file)))
           (workstream-id (noema-research--get
                           (noema-research-notebook-meta document)
                           "workstream_id" "")))
      (when root
        (my/noema-api-call
         "aaronnote:api:research:run:list"
         (vector `((cwd . ,root) (workstreamId . ,workstream-id) (limit . 1000)))
         (lambda (result error-object)
           (when (and (not error-object) (buffer-live-p graph)
                      (eq (buffer-local-value
                           'noema-research-graph--source graph)
                          source))
             (with-current-buffer graph
               (setq noema-research-graph--runs
                     (noema-research-graph--sequence
                      (noema-research-graph--value result "runs")))
               (noema-research-graph-refresh)))))))))

(defun noema-research-graph-refresh-events ()
  "Refresh durable WorkNode event times used by fold summaries."
  (interactive)
  (when (and (fboundp 'my/noema-api-call)
             (buffer-live-p noema-research-graph--source))
    (let* ((graph (current-buffer))
           (source noema-research-graph--source)
           (document (with-current-buffer source (noema-research-mode--sync)))
           (file (buffer-local-value 'buffer-file-name source))
           (root (and file (noema-research-repository-root file)))
           (notebook-id (noema-research-notebook-id document)))
      (when root
        (my/noema-api-call
         "aaronnote:api:research:events:list"
         (vector `((file . ,(expand-file-name file))
                   (cwd . ,root) (notebookId . ,notebook-id)
                   (after . 0) (limit . 1000)))
         (lambda (result error-object)
           (when (and (not error-object) (buffer-live-p graph)
                      (eq (buffer-local-value
                           'noema-research-graph--source graph)
                          source))
             (with-current-buffer graph
               (setq noema-research-graph--events
                     (noema-research-graph--sequence
                      (noema-research-graph--value result "events")))
               (noema-research-graph-refresh)))))))))

(defun noema-research-graph-refresh-artifacts ()
  "Refresh ArtifactLinks used by the Graph Board detail projection."
  (interactive)
  (when (and (fboundp 'my/noema-api-call)
             (buffer-live-p noema-research-graph--source))
    (let* ((graph (current-buffer))
           (source noema-research-graph--source)
           (document (with-current-buffer source (noema-research-mode--sync)))
           (file (buffer-local-value 'buffer-file-name source))
           (root (and file (noema-research-repository-root file)))
           (workstream-id (noema-research--get
                           (noema-research-notebook-meta document)
                           "workstream_id" ""))
           (notebook-id (noema-research-notebook-id document)))
      (when root
        (my/noema-api-call
         "aaronnote:api:research:artifact:links"
         (vector `((cwd . ,root) (workstreamId . ,workstream-id)
                   (notebookId . ,notebook-id) (limit . 1000)))
         (lambda (result error-object)
           (when (and (not error-object) (buffer-live-p graph)
                      (eq (buffer-local-value
                           'noema-research-graph--source graph)
                          source))
             (with-current-buffer graph
               (setq noema-research-graph--artifacts
                     (noema-research-graph--sequence
                      (noema-research-graph--value result "links")))
               (noema-research-graph-refresh)))))))))

(defun noema-research-graph-refresh-all ()
  "Redraw the Graph Board and refresh Proposals, Runs and ArtifactLinks."
  (interactive)
  (noema-research-graph-refresh)
  (noema-research-graph-refresh-proposals)
  (noema-research-graph-refresh-runs)
  (noema-research-graph-refresh-events)
  (noema-research-graph-refresh-artifacts))

(defun noema-research-graph--find-node (id &optional start)
  "Return the first outline position of node ID at or after START."
  (let ((position (or start (point-min)))
        found)
    (while (and (not found) (< position (point-max)))
      (if (equal (get-text-property position 'noema-research-node) id)
          (setq found position)
        (setq position (next-single-property-change
                        position 'noema-research-node nil (point-max)))))
    found))

(defun noema-research-graph-select (id)
  "Select graph node ID."
  (setq noema-research-graph--selected id)
  (noema-research-graph-refresh))

(defun noema-research-graph-visit ()
  "Visit the node at point in its JuText buffer."
  (interactive)
  (noema-research-graph--jump-and-call nil))

(defun noema-research-graph-continue ()
  "Create work continuing from the node at point."
  (interactive)
  (noema-research-graph--jump-and-call #'noema-research-continue))

(defun noema-research-graph-sibling ()
  "Create a sibling of the node at point."
  (interactive)
  (noema-research-graph--jump-and-call #'noema-research-new-sibling))

(defun noema-research-graph-checkpoint ()
  "Record a checkpoint continuing from the node at point."
  (interactive)
  (noema-research-graph--jump-and-call #'noema-research-new-checkpoint))

(defun noema-research-graph-edit-lineage ()
  "Edit the lineage parents of the node at point."
  (interactive)
  (noema-research-graph--in-source (noema-research-graph--node-at-point)
                                   #'noema-research-edit-lineage))

(defun noema-research-graph-edit-depends ()
  "Edit the hard dependencies of the node at point."
  (interactive)
  (noema-research-graph--in-source (noema-research-graph--node-at-point)
                                   #'noema-research-edit-depends))

(defun noema-research-graph-mark-done ()
  "Mark the work at point done."
  (interactive)
  (noema-research-graph--in-source (noema-research-graph--node-at-point)
                                   (lambda () (noema-research-set-work-state "done"))))

(defun noema-research-graph-drop ()
  "Drop the work at point, prompting for a reason."
  (interactive)
  (noema-research-graph--in-source (noema-research-graph--node-at-point)
                                   (lambda () (noema-research-set-work-state "dropped"))))

(defun noema-research-graph-reopen ()
  "Reopen the work at point."
  (interactive)
  (noema-research-graph--in-source (noema-research-graph--node-at-point)
                                   (lambda () (noema-research-set-work-state "open"))))

(defun noema-research-graph-inspect ()
  "Inspect the node at point."
  (interactive)
  (noema-research-graph--in-source (noema-research-graph--node-at-point)
                                   #'noema-research-inspect))

(defun noema-research-graph-toggle-fold ()
  "Fold or unfold the branch below the node at point."
  (interactive)
  (let ((id (noema-research-graph--node-at-point)))
    (noema-research-graph--require-materialized id)
    (setq noema-research-graph--selected id
          noema-research-graph--folds (if (member id noema-research-graph--folds)
                                          (remove id noema-research-graph--folds)
                                        (append noema-research-graph--folds (list id))))
    (noema-research-graph--save-view)
    (noema-research-graph-refresh)))

(defun noema-research-graph-toggle-focus ()
  "Focus the lens on the node at point, or clear the focus."
  (interactive)
  (let ((id (noema-research-graph--node-at-point)))
    (noema-research-graph--require-materialized id)
    (setq noema-research-graph--selected id
          noema-research-graph--focus (unless (equal id noema-research-graph--focus) id))
    (noema-research-graph--save-view)
    (noema-research-graph-refresh)))

(defun noema-research-graph-cycle-zoom ()
  "Cycle semantic zoom through overview, branch, and detail."
  (interactive)
  (setq noema-research-graph--zoom
        (pcase noema-research-graph--zoom
          ("overview" "branch") ("branch" "detail") (_ "overview")))
  (noema-research-graph--save-view)
  (noema-research-graph-refresh)
  (message "Noema Graph semantic zoom: %s" noema-research-graph--zoom))

(defun noema-research-graph--run (session-policy)
  "Run the selected work using optional SESSION-POLICY."
  (let* ((id (noema-research-graph--node-at-point))
         (_materialized (noema-research-graph--require-materialized id))
         (source noema-research-graph--source)
         (document (noema-research-graph--document))
         (node (noema-research-find-work-node document id))
         (cell (noema-research-primary-cell document id)))
    (unless (and node (equal (noema-research-work-node-field node "kind") "work")
                 cell (equal (noema-research--get cell "cell_type") "code"))
      (user-error "Agent Run applies only to a materialized work block"))
    (unless (fboundp 'noema-agent-worker-run-work-cell)
      (require 'noema-agent-worker))
    (with-current-buffer source
      (when (buffer-modified-p) (save-buffer))
      (let ((default-directory
             (noema-research-repository-root buffer-file-name)))
        (noema-agent-worker-run-work-cell
         (expand-file-name buffer-file-name)
         (noema-research-cell-id cell)
         session-policy
         (when (equal session-policy "fork")
           (read-string "Parent Noema session id: ")))))))

(defun noema-research-graph-run-default ()
  "Run selected work using its declared or default session route."
  (interactive)
  (noema-research-graph--run nil))

(defun noema-research-graph-run-continue ()
  "Run selected work by continuing its prior session."
  (interactive)
  (noema-research-graph--run "continue"))

(defun noema-research-graph-run-fresh ()
  "Run selected work in a fresh session."
  (interactive)
  (noema-research-graph--run "fresh"))

(defun noema-research-graph-run-fork ()
  "Run selected work by forking a chosen parent session."
  (interactive)
  (noema-research-graph--run "fork"))

(defun noema-research-graph-run-project-file ()
  "Run a repository script or notebook from the selected Work."
  (interactive)
  (let ((id (noema-research-graph--node-at-point))
        (source noema-research-graph--source))
    (noema-research-graph--require-materialized id)
    (pop-to-buffer source)
    (noema-research-mode--sync)
    (noema-research-goto-cell id)
    (call-interactively #'noema-research-run-project-file)))

(transient-define-prefix noema-research-graph-execute ()
  "Run the selected `.noema' work through an agent or project file."
  [["Agent Run"
    ("r" "declared/default route" noema-research-graph-run-default)
    ("c" "continue" noema-research-graph-run-continue)
    ("f" "fork" noema-research-graph-run-fork)
	("n" "fresh" noema-research-graph-run-fresh)]
	["Project Run"
	 ("p" "run .py / .ipynb" noema-research-graph-run-project-file)]])

(defun noema-research-graph--structure-command (function)
  "Apply source-buffer structure FUNCTION to the selected materialized node."
  (let ((id (noema-research-graph--node-at-point))
        (source noema-research-graph--source))
    (noema-research-graph--require-materialized id)
    (with-current-buffer source
      (noema-research-mode--sync)
      (noema-research-goto-cell id)
      (call-interactively function))
    (setq noema-research-graph--selected nil)
    (noema-research-graph-refresh)))

(defun noema-research-graph-delete-work-node ()
  "Delete the selected WorkNode while preserving its cells as notes."
  (interactive)
  (let* ((id (noema-research-graph--node-at-point))
         (_materialized (noema-research-graph--require-materialized id))
         (source noema-research-graph--source))
    (with-current-buffer source
      (let* ((document (noema-research-mode--sync))
             (cell (noema-research-primary-cell document id)))
        (if cell
            (progn
              (noema-research-goto-cell id)
              (call-interactively #'noema-research-delete-current-work-node))
          (unless (noema-research-find-work-node document id)
            (user-error "Unknown WorkNode: %s" id))
          (unless (yes-or-no-p (format "Delete orphan WorkNode %s? " id))
            (user-error "WorkNode deletion cancelled"))
          (noema-research-delete-work-node document id)
          (noema-research--render-structure-mutation))))
    (setq noema-research-graph--selected nil)
    (noema-research-graph-refresh)))

(defun noema-research-graph-unbind-cell ()
  "Unbind the selected Cell while preserving its WorkNode."
  (interactive)
  (noema-research-graph--structure-command #'noema-research-unbind-current-cell))

(defun noema-research-graph-delete-cell ()
  "Delete the selected Cell while preserving its WorkNode."
  (interactive)
  (noema-research-graph--structure-command #'noema-research-delete-current-cell))

(transient-define-prefix noema-research-graph-structure ()
  "Perform identity-safe Graph structure changes."
  [["Distinct identities"
    ("w" "delete WorkNode; keep Cell as note" noema-research-graph-delete-work-node)
    ("u" "unbind Cell; keep WorkNode" noema-research-graph-unbind-cell)
    ("c" "delete Cell; keep WorkNode" noema-research-graph-delete-cell)]])

(defun noema-research-graph-follow-source (source work-node-id)
  "Explicitly attach the singleton DAG to SOURCE and select WORK-NODE-ID."
  (let ((graph (noema-research-graph-buffer source)))
    (with-current-buffer graph
      (when work-node-id
        (setq noema-research-graph--selected work-node-id)
        (noema-research-graph-refresh)))
    graph))

;;;###autoload
(defun noema-research-graph-buffer (&optional source)
  "Return the initialized Graph Board buffer for JuText SOURCE.
The same buffer is reused across every `.noema' source.  It is a temporary
pop-up; merely selecting a different JuText window never retargets it."
  (setq source (or source (current-buffer)))
  (unless (buffer-live-p source)
    (user-error "The research notebook buffer is no longer live"))
  (with-current-buffer source
    (unless (derived-mode-p 'noema-research-mode)
      (user-error "Not in a research notebook")))
  (let* ((cell (with-current-buffer source
                 (ignore-errors (noema-research--cell-at-point))))
         (document (buffer-local-value 'noema-research--document source))
         (file (buffer-local-value 'buffer-file-name source))
         (view (if file
                   (noema-research-view-read file document)
                 (list :focus nil :folds nil)))
         (buffer (get-buffer-create noema-research-graph-buffer-name)))
    ;; Retire buffers created by versions that named one board per source.
    (dolist (candidate (buffer-list))
      (when (and (not (eq candidate buffer))
                 (with-current-buffer candidate
                   (derived-mode-p 'noema-research-graph-mode)))
        (kill-buffer candidate)))
    (with-current-buffer buffer
      (noema-research-graph-mode)
      (setq noema-research-graph--source source
            noema-research-graph--focus
            (noema-research-resolve-work-node-id document (plist-get view :focus))
            noema-research-graph--folds
            (delq nil (mapcar (lambda (id)
                                (noema-research-resolve-work-node-id document id))
                              (plist-get view :folds)))
            noema-research-graph--zoom (or (plist-get view :zoom) "branch")
            noema-research-graph--selected
            (and cell (noema-research-cell-work-node-id cell)))
      (noema-research-graph-refresh)
      (if (fboundp 'my/noema--ensure-server)
          (let ((graph buffer))
            (my/noema--ensure-server
             (lambda ()
               (when (and (buffer-live-p graph)
                          (eq (buffer-local-value
                               'noema-research-graph--source graph)
                              source))
                 (with-current-buffer graph
                   (noema-research-graph-refresh-proposals)
                   (noema-research-graph-refresh-runs)
                   (noema-research-graph-refresh-events)
                   (noema-research-graph-refresh-artifacts))))))
        (noema-research-graph-refresh-proposals)
        (noema-research-graph-refresh-runs)
        (noema-research-graph-refresh-events)
        (noema-research-graph-refresh-artifacts)))
    buffer))

;;;###autoload
(defun noema-research-graph-open ()
  "Open the single reusable Graph Board for the current research notebook."
  (interactive)
  (noema-research-graph-pop-buffer
   (noema-research-graph-buffer (current-buffer))))

(defun noema-research-graph--window-size-changed (&optional frame)
  "Refit the displayed singleton DAG after a window resize in FRAME."
  (when-let* ((graph (get-buffer noema-research-graph-buffer-name))
              (window (get-buffer-window graph (or frame t))))
    (let ((size (cons (window-body-width window t)
                      (window-body-height window t))))
      (with-current-buffer graph
        (unless (equal size noema-research-graph--window-size)
          (setq noema-research-graph--window-size size)
          (when (buffer-live-p noema-research-graph--source)
            (noema-research-graph-refresh)))))))

(add-hook 'window-size-change-functions
          #'noema-research-graph--window-size-changed)

(provide 'noema-research-graph)

;;; noema-research-graph.el ends here
