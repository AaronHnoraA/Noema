;;; noema-research-graph.el --- Graph Board for research notebooks -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; The Graph Board is an interactive projection of a research notebook's
;; lineage graph.  Graphviz computes the layout (`dot -Tjson'); Noema draws its
;; own SVG scene with clickable nodes and always renders a navigable outline,
;; so the board also works in terminals and without Graphviz.  Every command is
;; a semantic edit applied to the notebook through its JuText buffer; folding
;; and focus are view state stored under `<repository>/.agent/views/'.

;;; Code:

(require 'cl-lib)
(require 'dom)
(require 'seq)
(require 'subr-x)
(require 'svg)
(require 'noema-research)
(require 'noema-research-mode)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))

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

(defvar-local noema-research-graph--selected nil
  "Selected cell id, or nil.")

(defvar-local noema-research-graph--proposals nil
  "Pending Proposal rows projected as ghost nodes.")

(defconst noema-research-graph--fills
  '(("question" . "#e8f0fe") ("work" . "#e6f4ea") ("checkpoint" . "#fef7e0"))
  "SVG fill colours by research kind.")

(defvar noema-research-graph-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "n") #'noema-research-graph-continue)
    (define-key map (kbd "s") #'noema-research-graph-sibling)
    (define-key map (kbd "c") #'noema-research-graph-checkpoint)
    (define-key map (kbd "p") #'noema-research-graph-edit-lineage)
    (define-key map (kbd "D") #'noema-research-graph-edit-depends)
    (define-key map (kbd "d") #'noema-research-graph-mark-done)
    (define-key map (kbd "x") #'noema-research-graph-drop)
    (define-key map (kbd "R") #'noema-research-graph-reopen)
    (define-key map (kbd "TAB") #'noema-research-graph-toggle-fold)
    (define-key map (kbd "f") #'noema-research-graph-toggle-focus)
    (define-key map (kbd "i") #'noema-research-graph-inspect)
    (define-key map (kbd "a") #'noema-research-attention)
    (define-key map (kbd "RET") #'noema-research-graph-visit)
    (define-key map (kbd "g") #'noema-research-graph-refresh-all)
    (define-key map (kbd "j") #'next-line)
    (define-key map (kbd "k") #'previous-line)
    map)
  "Keymap for `noema-research-graph-mode'.")

(autoload 'noema-research-attention "noema-research-inspector" nil t)

(define-derived-mode noema-research-graph-mode special-mode "Noema-Graph"
  "Navigate and edit the lineage graph of a research notebook.

\\{noema-research-graph-mode-map}"
  (setq-local truncate-lines t))

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
  (when (noema-research-graph--ghost-p id)
    (user-error "This is a pending Proposal ghost; review it in Attention (a)")))

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
  "Visit the node at point in its source buffer and call FUNCTION there."
  (let ((id (noema-research-graph--node-at-point))
        (source noema-research-graph--source))
    (noema-research-graph--require-materialized id)
    (pop-to-buffer source)
    (noema-research-mode--sync)
    (noema-research-goto-cell id)
    (when function (funcall function))))

(defun noema-research-graph--save-view ()
  "Persist the board's focus and folds next to the notebook."
  (when-let* ((file (buffer-file-name noema-research-graph--source)))
    (noema-research-view-write
     file (buffer-local-value 'noema-research--document noema-research-graph--source)
     noema-research-graph--focus noema-research-graph--folds)))

;;;; Layout

(defun noema-research-graph--label (node)
  "Return the drawn label of projection NODE."
  (concat (if (plist-get node :ghost) "◇ " "")
          (truncate-string-to-width (plist-get node :title) 36 nil nil "…")
          (if (plist-get node :folded) (format " (+%d)" (plist-get node :folded)) "")))

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
  (concat "\"" (replace-regexp-in-string
                "[\"\\\\]" "\\\\\\&" (replace-regexp-in-string "[\n\r]" " " text))
          "\""))

(defun noema-research-graph--dot-source (projection)
  "Return (DOT . NAMES) for PROJECTION, NAMES mapping cell ids to node names."
  (let ((names (make-hash-table :test #'equal))
        (index 0))
    (with-temp-buffer
      (insert "digraph noema {\n  rankdir=TB;\n  nodesep=0.35;\n  ranksep=0.45;\n"
              "  node [shape=box, fontname=\"Helvetica\", fontsize=11, margin=\"0.14,0.07\"];\n")
      (dolist (node (plist-get projection :nodes))
        (let ((name (format "n%d" index)))
          (puthash (plist-get node :id) name names)
          (setq index (1+ index))
          (insert (format "  %s [label=%s];\n" name
                          (noema-research-graph--dot-quote
                           (noema-research-graph--label node))))))
      (dolist (edge (plist-get projection :edges))
        (insert (format "  %s -> %s%s;\n"
                        (gethash (nth 0 edge) names) (gethash (nth 1 edge) names)
                        (if (equal (nth 2 edge) "depends")
                            " [style=dashed, constraint=false]"
                          ""))))
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
                (push (list :points points :arrow arrow
                            :dashed (equal (noema-research--get edge "style") "dashed"))
                      edges)))
            (list :width (float (nth 2 bb)) :height height
                  :nodes (nreverse nodes) :edges (nreverse edges))))))))

;;;; Drawing

(defun noema-research-graph--path (points margin)
  "Return an SVG cubic path through POINTS offset by MARGIN."
  (let ((shifted (mapcar (lambda (point)
                           (format "%.1f %.1f" (+ margin (car point)) (+ margin (cdr point))))
                         points)))
    (concat "M " (car shifted) " C " (string-join (cdr shifted) " "))))

(defun noema-research-graph--svg (projection layout selected)
  "Return (SVG . MAP) drawing PROJECTION with LAYOUT, highlighting SELECTED."
  (let* ((margin 8)
         (svg (svg-create (ceiling (+ (* 2 margin) (plist-get layout :width)))
                          (ceiling (+ (* 2 margin) (plist-get layout :height)))))
         (by-id (make-hash-table :test #'equal))
         map)
    (dolist (node (plist-get projection :nodes))
      (puthash (plist-get node :id) node by-id))
    (dolist (edge (plist-get layout :edges))
      (when-let* ((points (plist-get edge :points)))
        (dom-append-child
         svg (dom-node 'path `((d . ,(noema-research-graph--path points margin))
                               (fill . "none") (stroke . "#80868b") (stroke-width . "1.2")
                               ,@(when (plist-get edge :dashed)
                                   '((stroke-dasharray . "5 4")))))))
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
             (y0 (+ margin (- (plist-get box :y) (/ height 2.0)))))
        (svg-rectangle svg x0 y0 width height :rx 6 :ry 6
                       :fill (or (cdr (assoc (plist-get node :kind)
                                             noema-research-graph--fills))
                                 "#f1f3f4")
                       :stroke (cond ((equal id selected) "#1a73e8")
                                     ((plist-get node :focus) "#d93025")
                                     (t "#9aa0a6"))
                       :stroke-width (if (equal id selected) 2.5 1)
                       :stroke-dasharray (if (or (plist-get node :ghost)
                                                 (equal (plist-get node :state) "dropped"))
                                             "4 3" "none"))
        (svg-text svg (noema-research-graph--label node)
                  :x (+ x0 (/ width 2.0)) :y (+ y0 (/ height 2.0) 4)
                  :text-anchor "middle" :font-size 11 :font-family "Helvetica"
                  :fill "#202124" :stroke "none")
        (push `((rect . ((,(round x0) . ,(round y0))
                         . (,(round (+ x0 width)) . ,(round (+ y0 height)))))
                ,(intern (concat "noema-node-" id))
                (pointer hand help-echo ,(plist-get node :title)))
              map)))
    (cons svg map)))

(defun noema-research-graph--insert-image (projection)
  "Insert the Graphviz drawing of PROJECTION; return non-nil on success."
  (when-let* ((layout (and (plist-get projection :nodes)
                           (noema-research-graph--layout projection))))
    (pcase-let ((`(,svg . ,map)
                 (noema-research-graph--svg projection layout
                                            noema-research-graph--selected)))
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
      t)))

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
                    (when (plist-get node :folded)
                      (insert (format "  ▸ %d hidden" (plist-get node :folded))))
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
                      (noema-research-projection document
                                                 :focus noema-research-graph--focus
                                                 :folds noema-research-graph--folds)
                      document noema-research-graph--proposals))
         (selected noema-research-graph--selected)
         (inhibit-read-only t))
    (use-local-map noema-research-graph-mode-map)
    (erase-buffer)
    (insert (propertize (let ((title (noema-research-notebook-title document)))
                          (if (string-empty-p title) "Research graph" title))
                        'face 'bold)
            "\n"
            (propertize (format "%d nodes · %d folded%s\n"
                                (length (plist-get projection :nodes))
                                (length (plist-get projection :folds))
                                (if (plist-get projection :focus) " · focus lens" ""))
                        'face 'shadow)
            (propertize "n continue  s sibling  c checkpoint  p lineage  D depends  d done  x drop  R reopen\nTAB fold  f focus  i inspect  a Attention  RET visit  g refresh\n\n"
                        'face 'shadow))
    (when (and (display-images-p) (image-type-available-p 'svg))
      (when (noema-research-graph--insert-image projection)
        (insert "\n\n")))
    (let ((outline-start (point)))
      (noema-research-graph--insert-outline projection)
      (goto-char outline-start)
      (when-let* ((position (and selected
                                 (noema-research-graph--find-node selected outline-start))))
        (goto-char position)))))

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
           (when (buffer-live-p graph)
             (with-current-buffer graph
               (if error-object
                   (message "Noema Proposal ghost refresh failed")
                 (setq noema-research-graph--proposals
                       (noema-research-graph--sequence
                        (noema-research-graph--value result "proposals")))
                 (noema-research-graph-refresh))))))))))

(defun noema-research-graph-refresh-all ()
  "Redraw the Graph Board and refresh its Proposal ghosts."
  (interactive)
  (noema-research-graph-refresh)
  (noema-research-graph-refresh-proposals))

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
    (setq noema-research-graph--selected id
          noema-research-graph--focus (unless (equal id noema-research-graph--focus) id))
    (noema-research-graph--save-view)
    (noema-research-graph-refresh)))

;;;###autoload
(defun noema-research-graph-open ()
  "Open the Graph Board of the current research notebook."
  (interactive)
  (unless (derived-mode-p 'noema-research-mode)
    (user-error "Not in a research notebook"))
  (let* ((source (current-buffer))
         (cell (ignore-errors (noema-research--cell-at-point)))
         (document noema-research--document)
         (view (if buffer-file-name
                   (noema-research-view-read buffer-file-name document)
                 (list :focus nil :folds nil)))
         (buffer (get-buffer-create (format "*Noema Graph: %s*" (buffer-name source)))))
    (with-current-buffer buffer
      (noema-research-graph-mode)
      (setq noema-research-graph--source source
            noema-research-graph--focus
            (noema-research-resolve-work-node-id document (plist-get view :focus))
            noema-research-graph--folds
            (delq nil (mapcar (lambda (id)
                                (noema-research-resolve-work-node-id document id))
                              (plist-get view :folds)))
            noema-research-graph--selected
            (and cell (noema-research-cell-work-node-id cell)))
      (noema-research-graph-refresh)
      (noema-research-graph-refresh-proposals))
    (pop-to-buffer buffer)))

(provide 'noema-research-graph)

;;; noema-research-graph.el ends here
