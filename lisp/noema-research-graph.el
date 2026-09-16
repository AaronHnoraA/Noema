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
(require 'noema-research-settings)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
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
  "Last window body pixel size (WIDTH . HEIGHT) the board was drawn for.")

(defvar-local noema-research-graph--unfolds nil
  "WorkNode ids the user expanded against Smart Fold.")

(defvar-local noema-research-graph--focus-depth nil
  "Descendant levels of the focus lens, or nil for the setting.")

(defvar-local noema-research-graph--focus-history nil
  "Earlier focus ids, newest first; a nil entry means no focus.")

(defvar-local noema-research-graph--settings nil
  "Document setting overrides of the source, as (VARIABLE . VALUE).")

(defvar-local noema-research-graph--view nil
  "Viewport transform (:dx DX :dy DY :scale SCALE), or nil before placement.
As in el-easydraw's scroll transform, the scene point (X, Y) is drawn at
\(SCALE·X + DX, SCALE·Y + DY) in the window-sized image.")

(defvar-local noema-research-graph--view-provisional nil
  "Non-nil when the view was placed before the board had a window.
The first redraw in a real window places it again for that window's size.")

(defvar-local noema-research-graph--projection-cache nil
  "Projection drawn by the current scene.")

(defvar-local noema-research-graph--dot-cache nil
  "(DOT-SOURCE . NAMES) whose Graphviz layout is cached.")

(defvar-local noema-research-graph--scene nil
  "SVG scene plist: :svg :group :nodes :selected :width :height :key.")

(defvar-local noema-research-graph--image nil
  "Displayed image, flushed before it is replaced.")

(defvar-local noema-research-graph--redraw-timer nil
  "Pending coalesced redraw.")

(defvar-local noema-research-graph--view-timer nil
  "Pending save of the viewport.")

(defvar-local noema-research-graph--fold-cycle 0
  "Position in the global fold cycle of `noema-research-graph-cycle-folds'.")

(defvar-local noema-research-graph--maximized nil
  "Window configuration saved by `noema-research-graph-toggle-maximize'.")

(defconst noema-research-graph--margin 8
  "Scene margin around the Graphviz drawing, in scene pixels.")

(defconst noema-research-graph--scale-range '(0.1 . 4.0)
  "Smallest and largest geometric zoom.")

(defconst noema-research-graph-buffer-name "*Noema DAG*"
  "Name of the single reusable research DAG buffer.")

(defconst noema-research-graph--palettes
  '((light :fills (("question" . "#e8f0fe") ("work" . "#e6f4ea")
                   ("checkpoint" . "#fef7e0") ("summary" . "#f3e8fd")
                   ("run" . "#f1f3f4") ("artifact" . "#fce8e6"))
           :default-fill "#f1f3f4" :stroke "#9aa0a6" :edge "#80868b"
           :title "#202124" :text "#5f6368" :selected "#1a73e8" :focus "#d93025")
    (dark :fills (("question" . "#1c3a5e") ("work" . "#1d3d2c")
                  ("checkpoint" . "#4a3e14") ("summary" . "#3a2850")
                  ("run" . "#303134") ("artifact" . "#4d2626"))
          :default-fill "#303134" :stroke "#5f6368" :edge "#9aa0a6"
          :title "#e8eaed" :text "#bdc1c6" :selected "#8ab4f8" :focus "#f28b82"))
  "Graph Board palettes by theme.")

(defun noema-research-graph--setting (variable)
  "Return setting VARIABLE's effective value for this board's document."
  (noema-research-setting variable noema-research-graph--settings))

(defun noema-research-graph--palette ()
  "Return the active palette plist."
  (alist-get (pcase (noema-research-graph--setting 'noema-research-graph-theme)
               ('dark 'dark)
               ('light 'light)
               (_ (if (eq (frame-parameter nil 'background-mode) 'dark) 'dark 'light)))
             noema-research-graph--palettes))

(defconst noema-research-graph--bindings
  '(("n" . noema-research-graph-continue)
    ("s" . noema-research-graph-sibling)
    ("c" . noema-research-graph-checkpoint)
    ("N" . noema-research-graph-new-root)
    ("p" . noema-research-graph-lineage-menu)
    ("D" . noema-research-graph-depends-menu)
    ("m" . noema-research-graph-move-work-node)
    ("r" . noema-research-graph-rename-work-node)
    ("K" . noema-research-graph-change-kind)
    ("t" . noema-research-graph-set-state)
    ("o" . noema-research-graph-set-outcome)
    ("d" . noema-research-graph-mark-done)
    ("x" . noema-research-graph-drop)
    ("R" . noema-research-graph-reopen)
    ("u" . noema-research-graph-undo)
    ("U" . noema-research-graph-redo)
    ("TAB" . noema-research-graph-toggle-fold)
    ("f" . noema-research-graph-toggle-focus)
    ("F" . noema-research-graph-run-fork)
    ("S" . noema-research-graph-sessions)
    ("e" . noema-research-graph-execute)
    ("z" . noema-research-graph-cycle-zoom)
    ("X" . noema-research-graph-structure)
    ("i" . noema-research-graph-inspect)
    ("a" . noema-research-attention)
    ("RET" . noema-research-graph-visit)
    ("q" . noema-research-graph-quit)
    ("g" . noema-research-graph-refresh-all)
    ("?" . noema-research-graph-help)
    ("B" . noema-research-graph-branch-menu)
    ("v" . noema-research-graph-view-menu)
    ("<backtab>" . noema-research-graph-cycle-folds)
    ("[" . noema-research-graph-focus-shallower)
    ("]" . noema-research-graph-focus-deeper)
    ("b" . noema-research-graph-focus-back)
    ("^" . noema-research-graph-focus-up)
    ("H" . noema-research-graph-select-parent)
    ("L" . noema-research-graph-select-child)
    ("{" . noema-research-graph-select-previous-sibling)
    ("}" . noema-research-graph-select-next-sibling)
    ("/" . noema-research-graph-goto)
    ("+" . noema-research-graph-zoom-in)
    ("-" . noema-research-graph-zoom-out)
    ("0" . noema-research-graph-zoom-reset)
    ("=" . noema-research-graph-fit)
    ("." . noema-research-graph-center)
    ("SPC" . noema-research-graph-interactive-scroll)
    ("w" . noema-research-graph-toggle-maximize)
    ("," . noema-research-settings)
    ("S-<left>" . noema-research-graph-pan-left)
    ("S-<right>" . noema-research-graph-pan-right)
    ("S-<up>" . noema-research-graph-pan-up)
    ("S-<down>" . noema-research-graph-pan-down)
    ("C-S-<left>" . noema-research-graph-pan-left)
    ("C-S-<right>" . noema-research-graph-pan-right)
    ("C-S-<up>" . noema-research-graph-pan-up)
    ("C-S-<down>" . noema-research-graph-pan-down)
    ("<down-mouse-1>" . noema-research-graph-mouse-down)
    ("<down-mouse-2>" . noema-research-graph-mouse-down)
    ("<mouse-1>" . ignore)
    ("<mouse-2>" . ignore)
    ("<double-down-mouse-1>" . ignore)
    ("<double-mouse-1>" . noema-research-graph-mouse-visit)
    ("<wheel-up>" . noema-research-graph-wheel)
    ("<wheel-down>" . noema-research-graph-wheel)
    ("<wheel-left>" . noema-research-graph-wheel)
    ("<wheel-right>" . noema-research-graph-wheel)
    ("S-<wheel-up>" . noema-research-graph-wheel)
    ("S-<wheel-down>" . noema-research-graph-wheel)
    ("C-<wheel-up>" . noema-research-graph-wheel)
    ("C-<wheel-down>" . noema-research-graph-wheel)
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

(defun noema-research-graph--overflow ()
  "Return arrows naming the viewport edges the drawing continues beyond."
  (when-let* ((view noema-research-graph--view)
              (scene noema-research-graph--scene))
    (pcase-let* ((`(,width . ,height) (noema-research-graph--view-size))
                 (scale (plist-get view :scale))
                 (dx (plist-get view :dx))
                 (dy (plist-get view :dy))
                 (right (+ dx (* scale (plist-get scene :width))))
                 (bottom (+ dy (* scale (plist-get scene :height))))
                 (arrows (concat (if (< dx -1) "←" "") (if (> right (1+ width)) "→" "")
                                 (if (< dy -1) "↑" "") (if (> bottom (1+ height)) "↓" ""))))
      (unless (string-empty-p arrows) arrows))))

(defun noema-research-graph--header-line ()
  "Return the Graph Board's status line.
It reports semantic zoom, geometric scale, focus with its depth, the fold
count and the viewport edges the drawing continues beyond.  This is a status
indicator, not an outline: view state is never encoded only in the drawing."
  (let* ((zoom (capitalize (or noema-research-graph--zoom "branch")))
         (view noema-research-graph--view)
         (overflow (noema-research-graph--overflow))
         (document (and (buffer-live-p noema-research-graph--source)
                        (buffer-local-value 'noema-research--document
                                            noema-research-graph--source)))
         (focus-node (and document noema-research-graph--focus
                          (noema-research-find-work-node
                           document noema-research-graph--focus)))
         (focus-label (and noema-research-graph--focus
                           (if focus-node
                               (noema-research-graph--focus-trail document)
                             noema-research-graph--focus)))
         (folds (length noema-research-graph--folds)))
    ;; `header-line-format' treats `%' as a construct; titles may contain it.
    (string-replace
     "%" "%%"
     (concat " " zoom
            (when view (format "  ·  %d%%" (round (* 100 (plist-get view :scale)))))
            (when focus-label
              (format "  ·  focus: %s ↓%d" focus-label
                      (noema-research-graph--effective-focus-depth)))
            (when (> folds 0) (format "  ·  %d folded" folds))
            (when overflow (format "  ·  more %s" overflow))))))

(define-derived-mode noema-research-graph-mode special-mode "Noema-Graph"
  "Navigate and edit the lineage graph of a research notebook.

\\{noema-research-graph-mode-map}"
  (setq-local truncate-lines t)
  (setq-local header-line-format '(:eval (noema-research-graph--header-line)))
  ;; The buffer holds one window-sized image; panning happens in the SVG
  ;; transform, so Emacs scrolling, the cursor and wheel coalescing are off.
  (setq-local cursor-type nil)
  (setq-local scroll-margin 0)
  (setq-local auto-hscroll-mode nil)
  (setq-local mwheel-coalesce-scroll-events nil)
  (add-hook 'change-major-mode-hook #'noema-research-graph--retire nil t)
  (add-hook 'kill-buffer-hook #'noema-research-graph--retire nil t)
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
    ("H" "lineage parent" noema-research-graph-select-parent)
    ("L" "first child" noema-research-graph-select-child)
    ("}" "next sibling ({ previous)" noema-research-graph-select-next-sibling)
    ("/" "go to node by title" noema-research-graph-goto)
    ("RET" "visit selected node" noema-research-graph-visit)
    ("q" "close graph" noema-research-graph-quit)]
   ["Viewport"
    ("S-←" "pan (S-arrows; C-S- farther)" noema-research-graph-pan-left)
    ("+" "zoom in" noema-research-graph-zoom-in)
    ("-" "zoom out" noema-research-graph-zoom-out)
    ("0" "100%" noema-research-graph-zoom-reset)
    ("=" "fit whole DAG" noema-research-graph-fit)
    ("." "center selection" noema-research-graph-center)
    ("SPC" "pan/zoom mode (drag, wheel)" noema-research-graph-interactive-scroll)
    ("w" "enlarge / restore" noema-research-graph-toggle-maximize)]
   ["View"
    ("TAB" "fold branch" noema-research-graph-toggle-fold)
    ("S-TAB" "cycle levels" noema-research-graph-cycle-folds)
    ("f" "focus: node as root" noema-research-graph-toggle-focus)
    ("^" "focus parent" noema-research-graph-focus-up)
    ("]" "focus deeper ([ shallower)" noema-research-graph-focus-deeper)
    ("b" "previous focus" noema-research-graph-focus-back)
    ("v" "view menu" noema-research-graph-view-menu)
    ("z" "semantic zoom" noema-research-graph-cycle-zoom)
    ("g" "refresh data" noema-research-graph-refresh-all)
    ("," "settings" noema-research-settings)]
   ["Create"
    ("n" "child work" noema-research-graph-continue)
    ("s" "sibling work" noema-research-graph-sibling)
    ("c" "checkpoint" noema-research-graph-checkpoint)
    ("N" "root node" noema-research-graph-new-root)]
   ["Edit node"
    ("r" "rename" noema-research-graph-rename-work-node)
    ("m" "move under parent" noema-research-graph-move-work-node)
    ("K" "change kind" noema-research-graph-change-kind)
    ("t" "state" noema-research-graph-set-state)
    ("o" "outcome" noema-research-graph-set-outcome)
    ("d" "done" noema-research-graph-mark-done)
    ("x" "drop" noema-research-graph-drop)
    ("R" "reopen" noema-research-graph-reopen)]
   ["Links / structure"
    ("p" "lineage links" noema-research-graph-lineage-menu)
    ("D" "dependencies" noema-research-graph-depends-menu)
    ("X" "structure" noema-research-graph-structure)
    ("B" "branch" noema-research-graph-branch-menu)
    ("u" "undo structure" noema-research-graph-undo)
    ("U" "redo structure" noema-research-graph-redo)]
   ["Run / inspect"
    ("e" "run" noema-research-graph-execute)
    ("i" "inspect" noema-research-graph-inspect)
    ("a" "Attention" noema-research-attention)]])

(defun noema-research-graph-quit ()
  "Dismiss the temporary Graph pop-up and return to JuText."
  (interactive)
  (noema-research-graph--flush-view-save)
  (noema-research-graph--restore-size)
  (quit-window nil (selected-window)))

(defun noema-research-graph-pop-buffer (graph)
  "Show and select GRAPH in the same dock used at document initialization."
  (let ((source (buffer-local-value 'noema-research-graph--source graph)))
    (unless (buffer-live-p source) (user-error "The graph's JuText source was closed"))
    (select-window (noema-research-graph-dock source)))
  graph)

(defun noema-research-graph-dock (source)
  "Show SOURCE's DAG docked below its JuText window, without selecting it.
This is the default workspace position: JuText above, the DAG in the
bottom-left and OutputArea on the right.  A visible DAG is reused.  Docking
never follows the cursor; `noema-research-sync-graph' is the explicit
cursor-to-DAG action.  Return the DAG window."
  (let* ((graph (noema-research-graph--buffer-for source))
         (source-window (or (get-buffer-window source) (display-buffer source)))
         (existing (get-buffer-window graph))
         ;; Relocate only an old misplaced graph popup, preserving other panes.
         (_relocate
          (when (and existing (window-live-p source-window)
                     (not (and (eq existing (window-in-direction 'below source-window))
                               (= (car (window-edges existing)) (car (window-edges source-window)))
                               (= (nth 2 (window-edges existing)) (nth 2 (window-edges source-window))))))
            (delete-window existing)
            (setq existing nil)))
         (window (or existing
                     (display-buffer
                      graph
                      `((display-buffer-in-direction)
                        (direction . below)
                        (window . ,(or source-window 'main))
                        (inhibit-same-window . t)
                        (window-height
                         . ,(noema-research-setting
                             'noema-research-graph-window-height)))))))
    (with-current-buffer graph
      (noema-research-graph-refresh))
    window))

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
  "Return the selected node id."
  (or noema-research-graph--selected
      (user-error "No node selected: click one, move with h/j/k/l, or create a root node with N")))

(defun noema-research-graph--related-parent (id)
  "Return the visible parent of `Deeper branches' summary ID, or nil."
  (when (and (stringp id) (string-prefix-p "noema-summary:related:" id))
    (car (plist-get (seq-find (lambda (node) (equal (plist-get node :id) id))
                              (plist-get noema-research-graph--projection-cache :nodes))
                    :parents))))

(defun noema-research-graph--selected-node ()
  "Return the selected materialized node id."
  (let ((id (noema-research-graph--node-at-point)))
    (noema-research-graph--require-materialized id)
    id))

(defun noema-research-graph--edit (function)
  "Call FUNCTION in the source JuText buffer as one Graph Board edit.
FUNCTION runs with the source buffer current and its document synced.  When
it returns a WorkNode id, that node becomes the selection.  The board then
redraws once and stays open."
  (let ((graph (current-buffer))
        (source noema-research-graph--source)
        result)
    (unless (buffer-live-p source)
      (user-error "The research notebook buffer is no longer live"))
    (let ((noema-research--inhibit-graph-notify t))
      (setq result (with-current-buffer source
                     (noema-research-mode--sync)
                     (funcall function))))
    (when (buffer-live-p graph)
      (with-current-buffer graph
        (let ((document (buffer-local-value 'noema-research--document source)))
          (when (and (stringp result) (noema-research-find-work-node document result))
            (setq noema-research-graph--selected result)
            ;; A new sibling of the focus root, or a child past the lens
            ;; depth, must not be created invisibly.
            (when (noema-research-graph--keep-in-focus document result)
              (noema-research-graph--save-view))))
        (noema-research-graph-refresh)))
    result))

(defun noema-research-graph--jump-and-call (function)
  "Visit the node at point in its source buffer and call FUNCTION there.
The DAG stays where it is (docked by default); focus moves to the JuText
window, reusing it when it is visible."
  (let ((id (noema-research-graph--node-at-point))
        (source noema-research-graph--source))
    (noema-research-graph--require-materialized id)
    (noema-research-graph--flush-view-save)
    (noema-research-graph--restore-size)
    (if-let* ((window (get-buffer-window source)))
        (select-window window)
      (pop-to-buffer source))
    (with-current-buffer source
      (noema-research-mode--sync)
      (noema-research-goto-cell id)
      (when function (funcall function)))))


(defun noema-research-graph--save-view ()
  "Persist the board's focus, folds, zoom and viewport next to the notebook."
  (when-let* ((source noema-research-graph--source)
              ((buffer-live-p source))
              (file (buffer-file-name source)))
    (let ((focus noema-research-graph--focus)
          (folds noema-research-graph--folds)
          (zoom noema-research-graph--zoom)
          (unfolds noema-research-graph--unfolds)
          (depth noema-research-graph--focus-depth)
          (view noema-research-graph--view))
      (noema-research-view-update
       file (buffer-local-value 'noema-research--document source)
       (lambda (object)
         (puthash "focus" (or focus :null) object)
         (puthash "folds" (vconcat folds) object)
         (puthash "zoom" (or zoom :null) object)
         (puthash "unfolds" (vconcat unfolds) object)
         (puthash "focus_depth" (or depth :null) object)
         (puthash "viewport"
                  (if view
                      (noema-research--table
                       "dx" (round (plist-get view :dx))
                       "dy" (round (plist-get view :dy))
                       "scale" (/ (fround (* 10000 (plist-get view :scale))) 10000))
                    :null)
                  object))))))

(defun noema-research-graph--schedule-view-save ()
  "Save the viewport once panning and zooming pause."
  (when (timerp noema-research-graph--view-timer)
    (cancel-timer noema-research-graph--view-timer))
  (let ((graph (current-buffer)))
    (setq noema-research-graph--view-timer
          (run-with-idle-timer
           1 nil
           (lambda ()
             (when (buffer-live-p graph)
               (with-current-buffer graph
                 (setq noema-research-graph--view-timer nil)
                 (noema-research-graph--save-view))))))))

(defun noema-research-graph--flush-view-save ()
  "Save a pending viewport change now."
  (when (timerp noema-research-graph--view-timer)
    (cancel-timer noema-research-graph--view-timer)
    (setq noema-research-graph--view-timer nil)
    (noema-research-graph--save-view)))

(defun noema-research-graph--retire ()
  "Save pending view state and cancel this board's timers."
  (noema-research-graph--flush-view-save)
  (when (timerp noema-research-graph--redraw-timer)
    (cancel-timer noema-research-graph--redraw-timer))
  (setq noema-research-graph--redraw-timer nil))

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

(defun noema-research-graph--smart-folds (document &optional unprotected)
  "Return the branches Smart Fold contracts in DOCUMENT.
A branch contracts when its head's state is in
`noema-research-graph-auto-fold-states', it has descendants, the user has
not expanded it (`noema-research-graph--unfolds') and no earlier Smart Fold
already hides it.  Unless UNPROTECTED, the selected or focused path is never
contracted."
  (pcase-let* ((`(,children ,parents) (noema-research-graph--lineage-maps document))
               (states (noema-research-graph--setting
                        'noema-research-graph-auto-fold-states))
               (anchor (and (not unprotected)
                            (or noema-research-graph--focus
                                noema-research-graph--selected)))
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
                   (member state states)
                   (not (gethash id protected))
                   (not (member id noema-research-graph--unfolds))
                   (not (seq-some
                         (lambda (fold)
                           (member id (noema-research-graph--walk fold children)))
                         automatic)))
          (setq automatic (append automatic (list id))))))
    automatic))

(defun noema-research-graph--automatic-folds (document)
  "Return Smart Fold contractions for the current zoom and selection."
  (when (member noema-research-graph--zoom
                (noema-research-graph--setting 'noema-research-graph-auto-fold-zooms))
    (noema-research-graph--smart-folds document)))

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

(defvar-local noema-research-graph--activity-index nil
  "((RUNS . EVENTS) . (RUN-TABLE . TIME-TABLE)) for the fetched activity lists.")

(defun noema-research-graph--activity-tables ()
  "Return (RUN-TABLE . TIME-TABLE) keyed by WorkNode id.
RUN-TABLE holds each WorkNode's latest durable Run and TIME-TABLE its latest
event time.  Both are rebuilt only when the fetched Run or event list is
replaced, so decorating a projection is linear in nodes plus history instead
of rescanning the history for every node and fold summary."
  (let ((runs noema-research-graph--runs)
        (events noema-research-graph--events))
    (unless (and noema-research-graph--activity-index
                 (eq (caar noema-research-graph--activity-index) runs)
                 (eq (cdar noema-research-graph--activity-index) events))
      (let ((run-table (make-hash-table :test #'equal))
            (time-table (make-hash-table :test #'equal)))
        (dolist (run runs)
          (when-let* ((id (or (noema-research-graph--value run "workNodeId")
                              (noema-research-graph--value run "work_node_id")))
                      ((stringp id)))
            (let* ((latest (gethash id run-table))
                   (latest-time (and latest (noema-research-graph--run-time latest)))
                   (time (noema-research-graph--run-time run)))
              (when (or (null latest)
                        (and (stringp time)
                             (or (not (stringp latest-time))
                                 (string-lessp latest-time time))))
                (puthash id run run-table)))))
        (dolist (event events)
          (when-let* ((id (or (noema-research-graph--value event "work_node_id")
                              (noema-research-graph--value event "workNodeId")))
                      ((stringp id)))
            (puthash id (noema-research-graph--later-time
                         (gethash id time-table)
                         (noema-research-graph--value event "ts"))
                     time-table)))
        (setq noema-research-graph--activity-index
              (cons (cons runs events) (cons run-table time-table)))))
    (cdr noema-research-graph--activity-index)))

(defun noema-research-graph--runtime-run (work-node-id)
  "Return the latest durable Run for WORK-NODE-ID."
  (gethash work-node-id (car (noema-research-graph--activity-tables))))

(defun noema-research-graph--event-time (work-node-id)
  "Return the latest durable event time for WORK-NODE-ID."
  (gethash work-node-id (cdr (noema-research-graph--activity-tables))))

(defun noema-research-graph--activity (document work-node-id)
  "Return latest Run activity plist for WORK-NODE-ID in DOCUMENT."
  (let* ((cell (noema-research-primary-cell document work-node-id))
         (persisted (and cell (noema-research-cell-latest-run cell)))
         (run (noema-research-graph--runtime-run work-node-id))
         (event-time (noema-research-graph--event-time work-node-id)))
    (when (or run persisted event-time)
      (list :run-id (or (and run (noema-research-graph--value run "id"))
                        (plist-get persisted :id) "")
            :run-status (or (and run
                                 (equal (noema-research-graph--value run "id") (plist-get persisted :id))
                                 (member (plist-get persisted :status) '("completed" "cancelled" "failed" "interrupted"))
                                 (plist-get persisted :status))
                            (and run (noema-research-graph--value run "status"))
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
  "Add visible contraction nodes for branches omitted by the focus lens.
The lens is the focused branch cut at its depth, so every contraction hangs
below a drawn node and stands for the levels past that depth."
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
                                            :title "Deeper branches"
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
  "Return the semantic Graph Board projection for DOCUMENT.
Lookups are indexed for the pass, so projecting stays linear in the size of
the document instead of rescanning every Cell for every node."
  (noema-research-with-lookup document
    (noema-research-graph--projection-1 document)))

(defun noema-research-graph--projection-1 (document)
  "Compute `noema-research-graph--projection' for DOCUMENT."
  (let* ((folds (delete-dups
                 (append noema-research-graph--folds
                         (noema-research-graph--automatic-folds document))))
         (projection (noema-research-projection
                      document :focus noema-research-graph--focus :folds folds
                      :protect (delq nil (list noema-research-graph--focus
                                               noema-research-graph--selected))
                      :depth (noema-research-graph--effective-focus-depth))))
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
      (insert (format "digraph noema {\n  rankdir=%s;\n  nodesep=%s;\n  ranksep=%s;\n"
                      (if (equal (noema-research-graph--setting
                                  'noema-research-graph-rankdir)
                                 "LR")
                          "LR" "TB")
                      (noema-research-graph--setting 'noema-research-graph-nodesep)
                      (noema-research-graph--setting 'noema-research-graph-ranksep))
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

(defun noema-research-graph--run-dot (source)
  "Return Graphviz JSON for DOT SOURCE, or nil when Graphviz is unavailable."
  (when-let* ((program (executable-find
                        (noema-research-graph--setting
                         'noema-research-graph-dot-program))))
    (with-temp-buffer
      (insert source)
      (when (zerop (call-process-region (point-min) (point-max) program t t nil "-Tjson"))
        (noema-research-parse-json (buffer-string))))))

(defun noema-research-graph--layout (projection)
  "Return a Graphviz layout plist for PROJECTION, or nil without Graphviz.
The plist has :width, :height, :nodes (plists :id :x :y :width :height) and
:edges (plists :points :arrow :dashed), in top-left coordinates."
  (pcase-let ((`(,source . ,names) (noema-research-graph--dot-source projection)))
    (noema-research-graph--layout-from-source source names)))

(defun noema-research-graph--layout-from-source (source names)
  "Lay out DOT SOURCE whose NAMES map node ids to DOT names.
Return the plist described in `noema-research-graph--layout', or nil."
  (when-let* ((json (noema-research-graph--run-dot source)))
    (let* ((bb (mapcar #'string-to-number
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
            :nodes (nreverse nodes) :edges (nreverse edges)))))

;;;; Drawing

(defun noema-research-graph--path (points margin)
  "Return an SVG cubic path through POINTS offset by MARGIN."
  (let ((shifted (mapcar (lambda (point)
                           (format "%.1f %.1f" (+ margin (car point)) (+ margin (cdr point))))
                         points)))
    (concat "M " (car shifted) " C " (string-join (cdr shifted) " "))))

(defun noema-research-graph--style-shape (shape selected base-stroke palette)
  "Stroke SHAPE as SELECTED, or with BASE-STROKE, using PALETTE."
  (dom-set-attribute shape 'stroke (if selected (plist-get palette :selected) base-stroke))
  (dom-set-attribute shape 'stroke-width (if selected 2.5 1)))

(defun noema-research-graph--svg (projection layout selected)
  "Return (SVG . SHAPES) drawing PROJECTION with LAYOUT, highlighting SELECTED.
SVG is a complete drawing at its natural size whose content lives in the
group `noema-scene'.  SHAPES maps node ids to (SHAPE . BASE-STROKE), so a
selection change restyles two shapes instead of rebuilding the scene."
  (let* ((margin noema-research-graph--margin)
         (palette (noema-research-graph--palette))
         (fills (plist-get palette :fills))
         (dim (noema-research-graph--setting 'noema-research-graph-dim-states))
         (svg (svg-create (ceiling (+ (* 2 margin) (plist-get layout :width)))
                          (ceiling (+ (* 2 margin) (plist-get layout :height)))))
         (group (dom-node 'g '((id . "noema-scene"))))
         (by-id (make-hash-table :test #'equal))
         (shapes (make-hash-table :test #'equal)))
    (dom-append-child svg group)
    (dolist (node (plist-get projection :nodes))
      (puthash (plist-get node :id) node by-id))
    (dolist (edge (plist-get layout :edges))
      (when-let* ((points (plist-get edge :points)))
        (let ((dash (pcase (plist-get edge :style)
                      ("dashed" "5 4") ("dotted" "2 4") (_ nil))))
          (dom-append-child
           group (dom-node 'path `((d . ,(noema-research-graph--path points margin))
                                   (fill . "none") (stroke . ,(plist-get palette :edge))
                                   (stroke-width . "1.2")
                                   ,@(when dash `((stroke-dasharray . ,dash))))))))
      (when-let* ((arrow (plist-get edge :arrow)))
        (svg-polygon group (mapcar (lambda (point)
                                     (cons (+ margin (car point)) (+ margin (cdr point))))
                                   arrow)
                     :fill (plist-get palette :edge) :stroke (plist-get palette :edge))))
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
             (state (plist-get node :state))
             (base-stroke (if (plist-get node :focus)
                              (plist-get palette :focus)
                            (plist-get palette :stroke)))
             (dash (if (or (plist-get node :ghost)
                           (plist-get node :summary)
                           (equal state "dropped"))
                       "4 3" "none"))
             (shape-args (list :fill (or (cdr (assoc kind fills))
                                         (plist-get palette :default-fill))
                               :stroke-dasharray dash))
             (item (dom-node 'g (when (and state (member state dim))
                                  '((opacity . "0.45")))))
             (lines (noema-research-graph--label-lines node))
             (line-height 13)
             (text-y (+ cy 4 (- (/ (* (1- (length lines)) line-height) 2.0)))))
        (pcase kind
          ("checkpoint"
           (apply #'svg-polygon item
                  (list (cons cx y0) (cons (+ x0 width) cy)
                        (cons cx (+ y0 height)) (cons x0 cy))
                  shape-args))
          ("run"
           (apply #'svg-ellipse item cx cy (/ width 2.0) (/ height 2.0) shape-args))
          (_
           (apply #'svg-rectangle item x0 y0 width height
                  :rx (if (equal kind "summary") 12 6)
                  :ry (if (equal kind "summary") 12 6)
                  shape-args)))
        (let ((shape (car (dom-children item))))
          (noema-research-graph--style-shape shape (equal id selected) base-stroke palette)
          (puthash id (cons shape base-stroke) shapes))
        (cl-loop for line in lines
                 for index from 0
                 do (svg-text item line
                              :x cx :y (+ text-y (* index line-height))
                              :text-anchor "middle"
                              :font-size (if (zerop index) 11 9.5)
                              :font-weight (if (zerop index) "600" "400")
                              :font-family "Helvetica"
                              :fill (plist-get palette (if (zerop index) :title :text))
                              :stroke "none"))
        (dom-append-child group item)))
    (cons svg shapes)))

(defun noema-research-graph--scene-key (projection)
  "Return what the drawn scene of PROJECTION depends on besides selection."
  (list (car noema-research-graph--dot-cache)
        (noema-research-graph--palette)
        (noema-research-graph--setting 'noema-research-graph-dim-states)
        (mapcar (lambda (node)
                  (list (plist-get node :id) (plist-get node :kind)
                        (plist-get node :state) (plist-get node :focus)
                        (plist-get node :ghost) (plist-get node :summary)))
                (plist-get projection :nodes))))

(defun noema-research-graph--build-scene (projection)
  "Draw PROJECTION with the cached layout and return the scene plist."
  (pcase-let* ((layout noema-research-graph--layout-cache)
               (`(,svg . ,shapes) (noema-research-graph--svg
                                   projection layout noema-research-graph--selected)))
    (list :svg svg
          :group (seq-find (lambda (child) (and (consp child) (eq (dom-tag child) 'g)))
                           (dom-children svg))
          :nodes shapes
          :selected noema-research-graph--selected
          :width (+ (* 2 noema-research-graph--margin) (plist-get layout :width))
          :height (+ (* 2 noema-research-graph--margin) (plist-get layout :height))
          :key (noema-research-graph--scene-key projection))))

(defun noema-research-graph--restyle-selection (old new)
  "Move the current scene's selection highlight from node OLD to NEW."
  (let ((palette (noema-research-graph--palette))
        (shapes (plist-get noema-research-graph--scene :nodes)))
    (dolist (id (delete-dups (delq nil (list old new))))
      (when-let* ((entry (gethash id shapes)))
        (noema-research-graph--style-shape (car entry) (equal id new) (cdr entry) palette)))
    (setq noema-research-graph--scene
          (plist-put noema-research-graph--scene :selected new))))

;;;; Viewport
;;
;; Modelled on el-easydraw's editor view (`edraw-scroll-transform-xy',
;; `edraw-update-root-transform', `edraw-zoom'): the image always has the
;; window's size, the scene sits in one group with a
;; translate(DX DY) scale(SCALE) transform, and panning or zooming only
;; changes that transform.  Pointer positions are mapped back through the
;; transform and hit-tested against the Graphviz boxes.

(defun noema-research-graph--view-size ()
  "Return the (WIDTH . HEIGHT) in pixels of the image this board draws.
The image fills the window body, so a long DAG is never shrunk to fit; the
view transform decides which part of it shows."
  (if-let* ((window (get-buffer-window (current-buffer) t)))
      (cons (max 120 (- (window-body-width window t) 2))
            (max 80 (- (window-body-height window t) 2)))
    (if-let* ((size noema-research-graph--window-size))
        (cons (max 120 (- (car size) 2)) (max 80 (- (cdr size) 2)))
      (cons 800 480))))

(defun noema-research-graph--clamp-view (view)
  "Return VIEW with its scale in range and part of the drawing kept visible."
  (pcase-let* ((`(,width . ,height) (noema-research-graph--view-size))
               (scene noema-research-graph--scene)
               (keep (max 16 (noema-research-graph--setting
                              'noema-research-graph-follow-margin)))
               (scale (min (cdr noema-research-graph--scale-range)
                           (max (car noema-research-graph--scale-range)
                                (float (plist-get view :scale)))))
               (drawn-width (* scale (plist-get scene :width)))
               (drawn-height (* scale (plist-get scene :height))))
    (list :dx (round (max (- keep drawn-width) (min (- width keep) (plist-get view :dx))))
          :dy (round (max (- keep drawn-height) (min (- height keep) (plist-get view :dy))))
          :scale scale)))

(defun noema-research-graph--fit-view ()
  "Return the view showing the whole drawing, centered, at most at 100%."
  (pcase-let* ((`(,width . ,height) (noema-research-graph--view-size))
               (scene-width (plist-get noema-research-graph--scene :width))
               (scene-height (plist-get noema-research-graph--scene :height))
               (scale (min 1.0 (/ (float width) scene-width)
                           (/ (float height) scene-height))))
    (list :dx (/ (- width (* scale scene-width)) 2.0)
          :dy (/ (- height (* scale scene-height)) 2.0)
          :scale scale)))

(defun noema-research-graph--node-center (view id)
  "Return the viewport pixel (X . Y) of node ID's center under VIEW, or nil."
  (when-let* ((box (noema-research-graph--layout-node id)))
    (let ((scale (plist-get view :scale)))
      (cons (+ (plist-get view :dx)
               (* scale (+ noema-research-graph--margin (plist-get box :x))))
            (+ (plist-get view :dy)
               (* scale (+ noema-research-graph--margin (plist-get box :y))))))))

(defun noema-research-graph--centered-view (view id)
  "Return VIEW panned so node ID sits in the middle, or nil if ID is not drawn."
  (when-let* ((center (noema-research-graph--node-center view id)))
    (pcase-let ((`(,width . ,height) (noema-research-graph--view-size)))
      (list :dx (+ (plist-get view :dx) (- (/ width 2.0) (car center)))
            :dy (+ (plist-get view :dy) (- (/ height 2.0) (cdr center)))
            :scale (plist-get view :scale)))))

(defun noema-research-graph--revealed-view (view id)
  "Return VIEW minimally panned so node ID lies within the follow margin."
  (if-let* ((box (noema-research-graph--layout-node id))
            (center (noema-research-graph--node-center view id)))
      (pcase-let* ((`(,width . ,height) (noema-research-graph--view-size))
                   (scale (plist-get view :scale))
                   (margin (noema-research-graph--setting
                            'noema-research-graph-follow-margin))
                   (half-width (/ (* scale (plist-get box :width)) 2.0))
                   (half-height (/ (* scale (plist-get box :height)) 2.0)))
        (cl-flet ((shift (low high limit)
                    (cond ((< low margin) (- margin low))
                          ((> high (- limit margin))
                           (- (min (- high (- limit margin)) (- low margin))))
                          (t 0))))
          (list :dx (+ (plist-get view :dx)
                       (shift (- (car center) half-width)
                              (+ (car center) half-width) width))
                :dy (+ (plist-get view :dy)
                       (shift (- (cdr center) half-height)
                              (+ (cdr center) half-height) height))
                :scale scale)))
    view))

(defun noema-research-graph--zoomed-view (view magnification x y)
  "Return VIEW zoomed by MAGNIFICATION around viewport pixel X, Y.
The drawing point under X, Y stays in place, as in el-easydraw's `edraw-zoom'."
  (let* ((old (float (plist-get view :scale)))
         (new (min (cdr noema-research-graph--scale-range)
                   (max (car noema-research-graph--scale-range) (* old magnification))))
         (ratio (/ new old)))
    (list :dx (- (* ratio (plist-get view :dx)) (* (- ratio 1) x))
          :dy (- (* ratio (plist-get view :dy)) (* (- ratio 1) y))
          :scale new)))

(defun noema-research-graph--top-node ()
  "Return the id of the topmost, then leftmost, laid-out node."
  (plist-get (car (sort (copy-sequence (plist-get noema-research-graph--layout-cache :nodes))
                        (lambda (left right)
                          (if (= (plist-get left :y) (plist-get right :y))
                              (< (plist-get left :x) (plist-get right :x))
                            (< (plist-get left :y) (plist-get right :y))))))
             :id))

(defun noema-research-graph--initial-view ()
  "Return the view a newly drawn DAG opens with.
The whole DAG is fitted when that keeps it at least at
`noema-research-graph-min-readable-scale'.  A larger DAG opens at 100%,
centered on the selection, or with its top node at the top of the window."
  (let ((fit (noema-research-graph--fit-view)))
    (if (>= (plist-get fit :scale)
            (noema-research-graph--setting 'noema-research-graph-min-readable-scale))
        fit
      (let* ((selected (and (noema-research-graph--layout-node
                             noema-research-graph--selected)
                            noema-research-graph--selected))
             (id (or selected (noema-research-graph--top-node)))
             (view (noema-research-graph--centered-view (list :dx 0 :dy 0 :scale 1.0) id)))
        (cond ((null view) (list :dx 0 :dy 0 :scale 1.0))
              (selected view)
              (t (let ((box (noema-research-graph--layout-node id)))
                   (plist-put view :dy
                              (- (noema-research-graph--setting
                                  'noema-research-graph-follow-margin)
                                 noema-research-graph--margin
                                 (- (plist-get box :y) (/ (plist-get box :height) 2.0)))))))))))

(defun noema-research-graph--node-at (x y)
  "Return the id of the node drawn at viewport pixel X, Y, or nil.
The pixel is mapped back through the view transform and hit-tested against
the Graphviz boxes; the smallest enclosing box wins."
  (when-let* ((view noema-research-graph--view)
              (layout noema-research-graph--layout-cache))
    (let* ((scale (float (plist-get view :scale)))
           (layout-x (- (/ (- x (plist-get view :dx)) scale) noema-research-graph--margin))
           (layout-y (- (/ (- y (plist-get view :dy)) scale) noema-research-graph--margin))
           best best-area)
      (dolist (node (plist-get layout :nodes))
        (let ((width (plist-get node :width))
              (height (plist-get node :height)))
          (when (and (<= (abs (- layout-x (plist-get node :x))) (/ width 2.0))
                     (<= (abs (- layout-y (plist-get node :y))) (/ height 2.0))
                     (or (null best-area) (< (* width height) best-area)))
            (setq best node best-area (* width height)))))
      (and best (plist-get best :id)))))

(defun noema-research-graph--apply-view ()
  "Size the scene's SVG to the viewport and apply the view transform."
  (pcase-let ((`(,width . ,height) (noema-research-graph--view-size))
              (svg (plist-get noema-research-graph--scene :svg))
              (view noema-research-graph--view))
    (dom-set-attribute svg 'width width)
    (dom-set-attribute svg 'height height)
    (dom-set-attribute svg 'viewBox (format "0 0 %d %d" width height))
    (dom-set-attribute (plist-get noema-research-graph--scene :group) 'transform
                       (format "translate(%.2f %.2f) scale(%.4f)"
                               (plist-get view :dx) (plist-get view :dy)
                               (plist-get view :scale)))))

(defun noema-research-graph--display (&optional notice)
  "Show the scene as one window-sized image, or NOTICE when there is none."
  (let ((inhibit-read-only t))
    (with-silent-modifications
      (erase-buffer)
      (when noema-research-graph--image
        (ignore-errors (image-flush noema-research-graph--image))
        (setq noema-research-graph--image nil))
      (if (and noema-research-graph--scene noema-research-graph--view
               (display-images-p) (image-type-available-p 'svg))
          (progn
            (noema-research-graph--apply-view)
            ;; Read the scene before `with-temp-buffer': it is buffer-local.
            ;; `:scale 1.0' cancels `image-scaling-factor', so image pixels
            ;; are viewport pixels (el-easydraw does the same).
            (let ((svg (plist-get noema-research-graph--scene :svg)))
              (setq noema-research-graph--image
                    (create-image (with-temp-buffer
                                    (svg-print svg)
                                    (buffer-string))
                                  'svg t :scale 1.0)))
            (insert (propertize " " 'display noema-research-graph--image)))
        (insert (propertize
                 (or notice
                     "DAG rendering requires a graphical Emacs with SVG and Graphviz.")
                 'face 'warning))))
    (goto-char (point-min))))

(defun noema-research-graph--set-view (view)
  "Install VIEW, kept in range, redisplay the board and schedule saving it."
  (setq noema-research-graph--view (noema-research-graph--clamp-view view)
        noema-research-graph--view-provisional nil)
  (noema-research-graph--display)
  (force-mode-line-update)
  (noema-research-graph--schedule-view-save))

(defun noema-research-graph--require-scene ()
  "Signal a `user-error' unless the board shows a drawing."
  (unless (and noema-research-graph--scene noema-research-graph--view)
    (user-error "The DAG has no drawing to move")))

(defun noema-research-graph--pan-distance (event)
  "Return the pixels one pan key EVENT moves, chosen by its modifiers."
  (let ((modifiers (seq-difference (event-modifiers event)
                                   '(click double triple drag down))))
    (or (cdr (seq-find (lambda (entry) (seq-set-equal-p (car entry) modifiers))
                       (noema-research-graph--setting
                        'noema-research-graph-scroll-distance)))
        80)))

(defun noema-research-graph--pan (dx dy)
  "Move the drawing by DX, DY viewport pixels."
  (noema-research-graph--require-scene)
  (let ((view noema-research-graph--view))
    (noema-research-graph--set-view
     (list :dx (+ (plist-get view :dx) dx)
           :dy (+ (plist-get view :dy) dy)
           :scale (plist-get view :scale)))))

(defun noema-research-graph-pan-left ()
  "Show more of the DAG to the left."
  (interactive)
  (noema-research-graph--pan (noema-research-graph--pan-distance last-input-event) 0))

(defun noema-research-graph-pan-right ()
  "Show more of the DAG to the right."
  (interactive)
  (noema-research-graph--pan (- (noema-research-graph--pan-distance last-input-event)) 0))

(defun noema-research-graph-pan-up ()
  "Show more of the DAG above."
  (interactive)
  (noema-research-graph--pan 0 (noema-research-graph--pan-distance last-input-event)))

(defun noema-research-graph-pan-down ()
  "Show more of the DAG below."
  (interactive)
  (noema-research-graph--pan 0 (- (noema-research-graph--pan-distance last-input-event))))

(defun noema-research-graph--zoom-by (magnification &optional x y)
  "Zoom by MAGNIFICATION around viewport pixel X, Y.
Without X and Y, zoom around the selected node when it is visible, else
around the middle of the window."
  (noema-research-graph--require-scene)
  (pcase-let* ((view noema-research-graph--view)
               (`(,width . ,height) (noema-research-graph--view-size))
               (selected (and noema-research-graph--selected
                              (noema-research-graph--node-center
                               view noema-research-graph--selected)))
               (anchor (or (and x y (cons x y))
                           (and selected
                                (<= 0 (car selected) width)
                                (<= 0 (cdr selected) height)
                                selected)
                           (cons (/ width 2.0) (/ height 2.0)))))
    (noema-research-graph--set-view
     (noema-research-graph--zoomed-view view magnification (car anchor) (cdr anchor)))))

(defun noema-research-graph-zoom-in ()
  "Magnify the DAG around the selection."
  (interactive)
  (noema-research-graph--zoom-by
   (noema-research-graph--setting 'noema-research-graph-zoom-step)))

(defun noema-research-graph-zoom-out ()
  "Shrink the DAG around the selection."
  (interactive)
  (noema-research-graph--zoom-by
   (/ 1.0 (noema-research-graph--setting 'noema-research-graph-zoom-step))))

(defun noema-research-graph-zoom-reset ()
  "Show the DAG at 100%, where every title is legible."
  (interactive)
  (noema-research-graph--require-scene)
  (noema-research-graph--zoom-by (/ 1.0 (plist-get noema-research-graph--view :scale))))

(defun noema-research-graph-fit ()
  "Fit the whole DAG into the window."
  (interactive)
  (noema-research-graph--require-scene)
  (noema-research-graph--set-view (noema-research-graph--fit-view)))

(defun noema-research-graph-center ()
  "Center the selected node in the window."
  (interactive)
  (noema-research-graph--require-scene)
  (noema-research-graph--set-view
   (or (noema-research-graph--centered-view noema-research-graph--view
                                            (noema-research-graph--node-at-point))
       (user-error "The selected node is not drawn"))))

(defun noema-research-graph--event-xy (event)
  "Return the viewport pixel (X . Y) of mouse EVENT, or nil."
  (let ((xy (posn-x-y (event-start event))))
    (and (consp xy) (numberp (car xy)) (numberp (cdr xy)) xy)))

(defun noema-research-graph-mouse-down (event)
  "Select the node under EVENT on a click, or pan the DAG by dragging.
Dragging follows el-easydraw's `edraw-editor-scroll-by-dragging': the new
offset is the offset at the press plus the pointer's movement since."
  (interactive "e")
  (when-let* ((window (posn-window (event-start event)))
              ((windowp window)))
    (select-window window))
  (when-let* ((start (and noema-research-graph--view
                          (noema-research-graph--event-xy event))))
    (let ((origin noema-research-graph--view)
          moved done)
      (track-mouse
        (setq track-mouse 'dragging)
        (while (not done)
          (let ((next (read-event)))
            (if (mouse-movement-p next)
                (when-let* ((xy (noema-research-graph--event-xy next)))
                  (when (or moved
                            (> (+ (abs (- (car xy) (car start)))
                                  (abs (- (cdr xy) (cdr start))))
                               3))
                    (setq moved t)
                    (noema-research-graph--set-view
                     (list :dx (+ (plist-get origin :dx) (- (car xy) (car start)))
                           :dy (+ (plist-get origin :dy) (- (cdr xy) (cdr start)))
                           :scale (plist-get origin :scale)))))
              (setq done t)
              (unless (memq (event-basic-type next) '(mouse-1 mouse-2 mouse-3))
                (push next unread-command-events))))))
      (unless moved
        (when-let* ((id (noema-research-graph--node-at (car start) (cdr start))))
          (noema-research-graph-select id))))))

(defun noema-research-graph-mouse-visit (event)
  "Visit the node double-clicked with EVENT."
  (interactive "e")
  (when-let* ((xy (noema-research-graph--event-xy event))
              (id (noema-research-graph--node-at (car xy) (cdr xy))))
    (setq noema-research-graph--selected id)
    (noema-research-graph-visit)))

(defun noema-research-graph-wheel (event)
  "Pan or zoom the DAG with wheel EVENT.
Vertical wheels pan up and down, horizontal wheels and trackpad swipes pan
sideways, `S-' turns a vertical wheel sideways and `C-' zooms around the
pointer.  With `noema-research-graph-wheel-action' set to `zoom' the plain
vertical wheel zooms too.  Precise trackpad deltas are used when present."
  (interactive "e")
  (noema-research-graph--require-scene)
  (let* ((type (event-basic-type event))
         (modifiers (event-modifiers event))
         (vertical (memq type '(wheel-up wheel-down)))
         (delta (nth 4 event))
         (precise (and (consp delta) (numberp (car delta)) (numberp (cdr delta))
                       (abs (if vertical (cdr delta) (car delta)))))
         (clicks (if (numberp (nth 2 event)) (max 1 (nth 2 event)) 1))
         (pixels (if (and precise (> precise 0))
                     precise
                   (* clicks (noema-research-graph--setting
                              'noema-research-graph-wheel-step))))
         (xy (noema-research-graph--event-xy event)))
    (cond
     ((and vertical
           (or (memq 'control modifiers)
               (and (not (memq 'shift modifiers))
                    (eq (noema-research-graph--setting 'noema-research-graph-wheel-action)
                        'zoom))))
      (let ((step (expt (noema-research-graph--setting 'noema-research-graph-zoom-step)
                        (min 1.0 (/ pixels 40.0)))))
        (noema-research-graph--zoom-by (if (eq type 'wheel-up) step (/ 1.0 step))
                                       (car xy) (cdr xy))))
     ((and vertical (not (memq 'shift modifiers)))
      (noema-research-graph--pan 0 (if (eq type 'wheel-up) pixels (- pixels))))
     (t
      (let ((reveal-left (if vertical
                             (eq type 'wheel-up)
                           (eq type (if mouse-wheel-flip-direction 'wheel-left 'wheel-right)))))
        (noema-research-graph--pan (if reveal-left pixels (- pixels)) 0))))))

(defun noema-research-graph-interactive-scroll ()
  "Pan and zoom until SPC, q or a right click, as in el-easydraw.
Drag pans, the wheel and + / - zoom, arrows pan (S- and C- for farther),
0 shows 100% and = fits the whole DAG."
  (interactive)
  (noema-research-graph--require-scene)
  (let (done)
    (while (not done)
      (let ((event (read-event
                    "DAG view: drag pan · wheel/+/- zoom · arrows pan · 0 100% · = fit · SPC/q done")))
        (cond
         ((memq (car-safe event) '(down-mouse-1 down-mouse-2))
          (noema-research-graph-mouse-down event))
         ((memq (car-safe event) '(wheel-up wheel-down))
          (let ((xy (noema-research-graph--event-xy event))
                (step (noema-research-graph--setting 'noema-research-graph-zoom-step)))
            (noema-research-graph--zoom-by (if (eq (car event) 'wheel-up) step (/ 1.0 step))
                                           (car xy) (cdr xy))))
         ((memq (car-safe event) '(wheel-left wheel-right))
          (noema-research-graph-wheel event))
         ((or (memq event '(?q ?\s)) (eq (car-safe event) 'mouse-3))
          (setq done t))
         ((eq event ?+) (noema-research-graph-zoom-in))
         ((eq event ?-) (noema-research-graph-zoom-out))
         ((eq event ?0) (noema-research-graph-zoom-reset))
         ((eq event ?=) (noema-research-graph-fit))
         ((memq (event-basic-type event) '(left right up down))
          (let ((distance (noema-research-graph--pan-distance event)))
            (pcase (event-basic-type event)
              ('left (noema-research-graph--pan distance 0))
              ('right (noema-research-graph--pan (- distance) 0))
              ('up (noema-research-graph--pan 0 distance))
              ('down (noema-research-graph--pan 0 (- distance)))))))))
    (message nil)))

(defun noema-research-graph--restore-size ()
  "Restore the window layout saved when the DAG pop-up was enlarged."
  (when-let* ((configuration noema-research-graph--maximized))
    (setq noema-research-graph--maximized nil)
    (set-window-configuration configuration)))

(defun noema-research-graph-toggle-maximize ()
  "Let the DAG fill the frame, or restore the layout it popped up in.
This works for stacked and side-by-side pop-ups alike; `q' and visiting a
node restore the layout first."
  (interactive)
  (cond
   (noema-research-graph--maximized
    (noema-research-graph--restore-size)
    (when-let* ((window (get-buffer-window (current-buffer))))
      (select-window window)))
   ((one-window-p t)
    (user-error "The DAG already fills the frame; q closes it"))
   (t
    (let ((configuration (current-window-configuration)))
      (delete-other-windows)
      (setq noema-research-graph--maximized configuration)))))

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
    (noema-research-graph-select (plist-get (or best current) :id))))

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

;;;; Structural navigation

;; h/j/k/l follow the drawing; these follow the lineage tree, as outline and
;; mind-map editors do, so a wide or folded layout never hides a relative.

(defun noema-research-graph--select-structural (id)
  "Select WorkNode ID, widening the focus lens when it would hide ID."
  (let ((document (noema-research-graph--cached-document)))
    (when (noema-research-graph--keep-in-focus document id)
      (noema-research-graph--save-view))
    (noema-research-graph-select id)))

(defun noema-research-graph-select-parent ()
  "Select the first lineage parent of the selected WorkNode.
At the focus root the focus moves up together with the selection."
  (interactive)
  (pcase-let* ((id (noema-research-graph--selected-node))
               (document (noema-research-graph--cached-document))
               (`(,_children ,parents ,_roots) (noema-research-lineage-maps document))
               (parent (car (gethash id parents))))
    (cond ((not parent)
           (user-error "“%s” is a lineage root" (noema-research-work-node-label document id)))
          ((equal id noema-research-graph--focus) (noema-research-graph--refocus parent))
          (t (noema-research-graph--select-structural parent)))))

(defun noema-research-graph-select-child ()
  "Select the first lineage child of the selected WorkNode."
  (interactive)
  (pcase-let* ((id (noema-research-graph--selected-node))
               (document (noema-research-graph--cached-document))
               (`(,children ,_parents ,_roots) (noema-research-lineage-maps document))
               (child (car (gethash id children))))
    (unless child
      (user-error "“%s” has no lineage child" (noema-research-work-node-label document id)))
    (noema-research-graph--select-structural child)))

(defun noema-research-graph--select-sibling (offset)
  "Select the lineage sibling OFFSET places from the selected WorkNode.
Siblings share the first lineage parent; lineage roots are siblings too."
  (pcase-let* ((id (noema-research-graph--selected-node))
               (document (noema-research-graph--cached-document))
               (`(,children ,parents ,roots) (noema-research-lineage-maps document))
               (parent (car (gethash id parents)))
               (siblings (if parent (gethash parent children) roots))
               (index (+ (or (seq-position siblings id #'equal) 0) offset)))
    (unless (and (>= index 0) (< index (length siblings)))
      (user-error "No %s sibling" (if (> offset 0) "next" "previous")))
    (noema-research-graph--select-structural (nth index siblings))))

(defun noema-research-graph-select-next-sibling ()
  "Select the next lineage sibling of the selected WorkNode."
  (interactive)
  (noema-research-graph--select-sibling 1))

(defun noema-research-graph-select-previous-sibling ()
  "Select the previous lineage sibling of the selected WorkNode."
  (interactive)
  (noema-research-graph--select-sibling -1))

(defun noema-research-graph-goto (id)
  "Select WorkNode ID, chosen by title, and center it.
A focus lens or fold that hides the node is widened or bypassed."
  (interactive
   (let* ((document (noema-research-graph--cached-document))
          (near (and (stringp noema-research-graph--selected)
                     (noema-research-find-work-node document noema-research-graph--selected)
                     noema-research-graph--selected)))
     (list (noema-research-read-work-node
            "Go to node: " (noema-research-work-node-choices document :near near)))))
  (noema-research-graph--select-structural id)
  (noema-research-graph--center-on id))

;;;; Commands

(defun noema-research-graph--prune-view (document)
  "Forget focus, folds and selection naming WorkNodes absent from DOCUMENT.
Persist the view again when focus or folds changed."
  (let ((focus noema-research-graph--focus)
        (folds noema-research-graph--folds)
        (unfolds noema-research-graph--unfolds)
        (live (lambda (id) (noema-research-find-work-node document id))))
    (unless (noema-research-find-work-node document noema-research-graph--focus)
      (setq noema-research-graph--focus nil))
    (setq noema-research-graph--folds (seq-filter live noema-research-graph--folds)
          noema-research-graph--unfolds (seq-filter live noema-research-graph--unfolds)
          noema-research-graph--focus-history
          (seq-filter (lambda (id) (or (null id) (funcall live id)))
                      noema-research-graph--focus-history))
    (when (and (stringp noema-research-graph--selected)
               (string-prefix-p "wn_" noema-research-graph--selected)
               (not (noema-research-find-work-node document noema-research-graph--selected)))
      (setq noema-research-graph--selected nil))
    (unless (and (equal focus noema-research-graph--focus)
                 (equal folds noema-research-graph--folds)
                 (equal unfolds noema-research-graph--unfolds))
      (noema-research-graph--save-view))))

(defun noema-research-graph--cached-document ()
  "Return the source document without re-syncing its text."
  (unless (buffer-live-p noema-research-graph--source)
    (user-error "The research notebook buffer is no longer live"))
  (or (buffer-local-value 'noema-research--document noema-research-graph--source)
      (noema-research-graph--document)))

(defun noema-research-graph--redraw (&optional sync)
  "Redisplay the board, redoing only what changed.
With SYNC, first sync the source JuText text.  As with el-easydraw's
invalidated UI parts, work happens in layers: Graphviz runs only when the
DOT source changed, the SVG scene is rebuilt only when its drawn content
changed, a selection change restyles two shapes, and the view transform is
applied last.  A new selection or a new layout is scrolled into view."
  (let* ((document (if sync
                       (noema-research-graph--document)
                     (noema-research-graph--cached-document)))
         (_pruned (noema-research-graph--prune-view document))
         (projection (noema-research-graph--with-proposals
                      (noema-research-graph--projection document)
                      document noema-research-graph--proposals))
         (previous (plist-get noema-research-graph--scene :selected))
         (relaid nil)
         (notice nil))
    (setq noema-research-graph--projection-cache projection)
    (if (null (plist-get projection :nodes))
        (setq noema-research-graph--layout-cache nil
              noema-research-graph--dot-cache nil
              noema-research-graph--scene nil
              notice "No WorkNodes yet · ? lists commands")
      (pcase-let ((`(,source . ,names) (noema-research-graph--dot-source projection)))
        (unless (and noema-research-graph--layout-cache
                     (equal source (car noema-research-graph--dot-cache)))
          (setq noema-research-graph--layout-cache
                (noema-research-graph--layout-from-source source names)
                noema-research-graph--dot-cache (cons source names)
                noema-research-graph--scene nil
                relaid t)))
      (cond
       ((null noema-research-graph--layout-cache)
        (setq noema-research-graph--dot-cache nil
              notice "Drawing the DAG requires Graphviz (dot)."))
       ((and noema-research-graph--scene
             (equal (plist-get noema-research-graph--scene :key)
                    (noema-research-graph--scene-key projection)))
        (unless (equal previous noema-research-graph--selected)
          (noema-research-graph--restyle-selection previous noema-research-graph--selected)))
       (t
        (setq noema-research-graph--scene (noema-research-graph--build-scene projection)))))
    (when noema-research-graph--scene
      (let* ((displayed (get-buffer-window (current-buffer) t))
             (view (if (and noema-research-graph--view
                            (not (and displayed noema-research-graph--view-provisional)))
                       noema-research-graph--view
                     (setq noema-research-graph--view-provisional (not displayed))
                     (noema-research-graph--initial-view))))
        ;; A new layout that fits the window at the current scale is centered,
        ;; so folding a large DAG down does not leave it in a corner.
        (when relaid
          (pcase-let* ((`(,width . ,height) (noema-research-graph--view-size))
                       (scale (plist-get view :scale))
                       (drawn-width (* scale (plist-get noema-research-graph--scene :width)))
                       (drawn-height (* scale (plist-get noema-research-graph--scene :height))))
            (when (and (<= drawn-width width) (<= drawn-height height))
              (setq view (list :dx (/ (- width drawn-width) 2.0)
                               :dy (/ (- height drawn-height) 2.0)
                               :scale scale)))))
        (when (and noema-research-graph--selected
                   (or relaid (not (equal previous noema-research-graph--selected))))
          (setq view (noema-research-graph--revealed-view view noema-research-graph--selected)))
        (setq noema-research-graph--view (noema-research-graph--clamp-view view))))
    (noema-research-graph--display notice)
    (force-mode-line-update)))

(defun noema-research-graph--schedule-redraw ()
  "Redraw once after the pending Noema data callbacks have arrived."
  (unless (timerp noema-research-graph--redraw-timer)
    (let ((graph (current-buffer)))
      (setq noema-research-graph--redraw-timer
            (run-with-timer
             0 nil
             (lambda ()
               (when (buffer-live-p graph)
                 (with-current-buffer graph
                   (setq noema-research-graph--redraw-timer nil)
                   (when (buffer-live-p noema-research-graph--source)
                     (noema-research-graph--redraw))))))))))

(defun noema-research-graph-refresh ()
  "Sync the source document and redraw the Graph Board."
  (interactive)
  (noema-research-graph--redraw t))

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
                 (noema-research-graph--schedule-redraw))))))))))

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
               (noema-research-graph--schedule-redraw)))))))))

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
                   ;; One newest event per WorkNode.  Paging from seq 0 returned
                   ;; the oldest events, so long notebooks showed stale activity.
                   (latestPerWorkNode . t)))
         (lambda (result error-object)
           (when (and (not error-object) (buffer-live-p graph)
                      (eq (buffer-local-value
                           'noema-research-graph--source graph)
                          source))
             (with-current-buffer graph
               (setq noema-research-graph--events
                     (noema-research-graph--sequence
                      (noema-research-graph--value result "events")))
               (noema-research-graph--schedule-redraw)))))))))

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
               (noema-research-graph--schedule-redraw)))))))))

(defun noema-research-graph-refresh-all ()
  "Redraw the Graph Board and refresh Proposals, Runs and ArtifactLinks."
  (interactive)
  (noema-research-graph-refresh)
  (noema-research-graph-refresh-proposals)
  (noema-research-graph-refresh-runs)
  (noema-research-graph-refresh-events)
  (noema-research-graph-refresh-artifacts))

(defun noema-research-graph--selection-affects-projection-p ()
  "Return non-nil when moving the selection can change the drawn DAG.
The selection only protects its path from folds, so without manual folds and
outside Smart Fold's zoom levels the projection is independent of it."
  (or noema-research-graph--folds
      (member noema-research-graph--zoom
              (noema-research-graph--setting 'noema-research-graph-auto-fold-zooms))))

(defun noema-research-graph-select (id)
  "Select graph node ID and keep it inside the viewport.
When the selection cannot change the projection, only the two strokes and
the view transform change; otherwise the board redraws."
  (setq noema-research-graph--selected id)
  (if (and noema-research-graph--scene noema-research-graph--view
           (gethash id (plist-get noema-research-graph--scene :nodes))
           (not (noema-research-graph--selection-affects-projection-p)))
      (progn
        (noema-research-graph--restyle-selection
         (plist-get noema-research-graph--scene :selected) id)
        (noema-research-graph--set-view
         (noema-research-graph--revealed-view noema-research-graph--view id)))
    (noema-research-graph--redraw)))

(defun noema-research-graph-visit ()
  "Visit the selected node in its JuText buffer.
A Cell-less WorkNode is offered a new header Cell first.  On a `Deeper
branches' summary the focus moves to its parent instead."
  (interactive)
  (if-let* ((parent (noema-research-graph--related-parent
                     noema-research-graph--selected)))
      (noema-research-graph--refocus parent)
    (let* ((id (noema-research-graph--selected-node))
           (document (noema-research-graph--document)))
      (when (and (noema-research-find-work-node document id)
                 (not (noema-research-primary-cell document id)))
        (let ((label (noema-research-work-node-label document id)))
          (unless (y-or-n-p (format "“%s” has no Cell; create one? " label))
            (user-error "“%s” has no Cell" label)))
        (noema-research-graph--edit (lambda () (noema-research-op-attach-cell id))))
      (noema-research-graph--jump-and-call nil))))

(defun noema-research-graph--create-from (kind relation)
  "Create a KIND node as RELATION (`child' or `sibling') of the selection."
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (let* ((document noema-research--document)
              (label (noema-research-work-node-label document id))
              (parents (if (eq relation 'sibling)
                           (noema-research-relation-parents document id "lineage")
                         (list id)))
              (title (noema-research-read-title
                      (format (if (eq relation 'sibling)
                                  "New %s beside “%s”: "
                                "New %s after “%s”: ")
                              kind label))))
         (noema-create-node kind title parents id))))))

(defun noema-research-graph-continue ()
  "Create work continuing from the selected node; the board stays open."
  (interactive)
  (noema-research-graph--create-from "work" 'child))

(defun noema-research-graph-sibling ()
  "Create work sharing the selected node's lineage parents; the board stays open."
  (interactive)
  (noema-research-graph--create-from "work" 'sibling))

(defun noema-research-graph-checkpoint ()
  "Record a checkpoint after the selected node; the board stays open."
  (interactive)
  (noema-research-graph--create-from "checkpoint" 'child))

(defun noema-research-graph-new-root ()
  "Create a root WorkNode; this also works on an empty graph."
  (interactive)
  (noema-research-graph--edit
   (lambda ()
     (let* ((kind (noema-research-read-kind "New root node kind: " "question"))
            (title (noema-research-read-title (format "New root %s: " kind))))
       (noema-create-node kind title nil nil)))))

(defun noema-research-graph-rename-work-node ()
  "Rename the selected node without changing its identity or edges."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (noema-research-op-rename
        id (noema-research-read-title
            "New title: " (noema-research-work-node-field
                           (noema-research-find-work-node noema-research--document id)
                           "title")))))))

(defun noema-research-graph-move-work-node (&optional stay)
  "Move the selected node under another lineage parent, or make it a root.
Its JuText block follows the new parent unless STAY (prefix argument) or
`noema-research-move-relocates-block' is nil."
  (interactive "P")
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (noema-research-op-move id (noema-research-read-move-parent noema-research--document id)
                               (and noema-research-move-relocates-block (not stay)))))))

(defun noema-research-graph-change-kind ()
  "Change the selected node to question, work or checkpoint."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (noema-research-op-set-kind
        id (noema-research-read-kind-change noema-research--document id))))))

(defun noema-research-graph-set-state ()
  "Set the selected work's state."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (let* ((state (completing-read "State: " noema-research-work-states nil t))
              (reason (when (equal state "dropped") (read-string "Reason (optional): "))))
         (noema-set-node-state id state reason))))))

(defun noema-research-graph-set-outcome ()
  "Set or clear the selected work's outcome."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (noema-research-op-set-outcome
        id (noema-research-read-outcome noema-research--document id))))))

(defun noema-research-graph-mark-done ()
  "Mark the selected work done."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit (lambda () (noema-set-node-state id "done")))))

(defun noema-research-graph-drop ()
  "Drop the selected work, prompting for a reason."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (noema-set-node-state id "dropped" (read-string "Reason (optional): "))))))

(defun noema-research-graph-reopen ()
  "Reopen the selected work."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit (lambda () (noema-set-node-state id "open")))))

(defun noema-research-graph--relation (type direction action)
  "Apply one TYPE link change in DIRECTION with ACTION around the selection."
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (noema-research--apply-relation-command
        noema-research--document id type direction action)))))

(defun noema-research-graph-add-lineage-parent ()
  "Add one lineage parent to the selected node."
  (interactive)
  (noema-research-graph--relation "lineage" 'parent 'add))

(defun noema-research-graph-remove-lineage-parent ()
  "Remove one lineage parent from the selected node."
  (interactive)
  (noema-research-graph--relation "lineage" 'parent 'remove))

(defun noema-research-graph-add-lineage-child ()
  "Make another node a lineage child of the selected node."
  (interactive)
  (noema-research-graph--relation "lineage" 'child 'add))

(defun noema-research-graph-remove-lineage-child ()
  "Detach one lineage child from the selected node."
  (interactive)
  (noema-research-graph--relation "lineage" 'child 'remove))

(defun noema-research-graph-add-depends-parent ()
  "Add one hard dependency to the selected node."
  (interactive)
  (noema-research-graph--relation "depends" 'parent 'add))

(defun noema-research-graph-remove-depends-parent ()
  "Remove one hard dependency from the selected node."
  (interactive)
  (noema-research-graph--relation "depends" 'parent 'remove))

(defun noema-research-graph-add-depends-child ()
  "Make another node depend on the selected node."
  (interactive)
  (noema-research-graph--relation "depends" 'child 'add))

(defun noema-research-graph-remove-depends-child ()
  "Remove one node's dependency on the selected node."
  (interactive)
  (noema-research-graph--relation "depends" 'child 'remove))

(defun noema-research-graph-edit-lineage ()
  "Rewrite the whole lineage parent set of the selected node."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda () (noema-research--rewrite-relation noema-research--document id "lineage")))))

(defun noema-research-graph-edit-depends ()
  "Rewrite the whole hard-dependency set of the selected node."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda () (noema-research--rewrite-relation noema-research--document id "depends")))))

(transient-define-prefix noema-research-graph-lineage-menu ()
  "Edit the lineage links of the selected node."
  [["Parents"
    ("a" "add parent" noema-research-graph-add-lineage-parent)
    ("r" "remove parent" noema-research-graph-remove-lineage-parent)
    ("p" "rewrite all parents" noema-research-graph-edit-lineage)]
   ["Children"
    ("c" "add child" noema-research-graph-add-lineage-child)
    ("x" "remove child" noema-research-graph-remove-lineage-child)]
   ["Position"
    ("m" "move under another parent" noema-research-graph-move-work-node)]])

(transient-define-prefix noema-research-graph-depends-menu ()
  "Edit the hard dependencies of the selected node."
  [["Depends on"
    ("a" "add dependency" noema-research-graph-add-depends-parent)
    ("r" "remove dependency" noema-research-graph-remove-depends-parent)
    ("D" "rewrite all dependencies" noema-research-graph-edit-depends)]
   ["Required by"
    ("c" "add dependent" noema-research-graph-add-depends-child)
    ("x" "remove dependent" noema-research-graph-remove-depends-child)]])

(defun noema-research-graph-undo ()
  "Undo the newest structure edit of the source document."
  (interactive)
  (noema-research-graph--edit (lambda () (noema-research-structure-undo) nil)))

(defun noema-research-graph-redo ()
  "Redo the newest undone structure edit of the source document."
  (interactive)
  (noema-research-graph--edit (lambda () (noema-research-structure-redo) nil)))

(defun noema-research-graph-inspect ()
  "Inspect the selected node."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (with-current-buffer noema-research-graph--source
      (noema-research-mode--sync)
      (save-excursion
        (noema-research-goto-cell id)
        (noema-research-inspect)))))

;;;; Folding

(defun noema-research-graph--smart-fold-candidate-p (document id)
  "Return non-nil when Smart Fold would contract ID if it were not selected."
  (let ((noema-research-graph--unfolds (remove id noema-research-graph--unfolds)))
    (member id (noema-research-graph--smart-folds document t))))

(defun noema-research-graph--apply-view-change (&optional note)
  "Persist the view state, redraw, and echo NOTE."
  (noema-research-graph--save-view)
  (noema-research-graph--redraw)
  (when note (message "%s" note)))

(defun noema-research-graph-toggle-fold ()
  "Fold or expand the branch below the selected node.
Expanding a branch Smart Fold would contract records the expansion, so it
stays open after the selection moves on.  On a `Deeper branches' summary
the focus moves to its parent instead."
  (interactive)
  (let ((id (noema-research-graph--node-at-point)))
    (if-let* ((parent (noema-research-graph--related-parent id)))
        (noema-research-graph--refocus parent)
      (noema-research-graph--require-materialized id)
      (let ((document (noema-research-graph--cached-document)))
        (unless (noema-research-branch-ids document id)
          (user-error "“%s” has no branch to fold"
                      (noema-research-work-node-label document id)))
        (setq noema-research-graph--selected id)
        (if (member id noema-research-graph--folds)
            (progn
              (setq noema-research-graph--folds (remove id noema-research-graph--folds))
              (when (noema-research-graph--smart-fold-candidate-p document id)
                (setq noema-research-graph--unfolds
                      (append (remove id noema-research-graph--unfolds) (list id))))
              (noema-research-graph--apply-view-change "Branch expanded"))
          (setq noema-research-graph--unfolds (remove id noema-research-graph--unfolds)
                noema-research-graph--folds (append noema-research-graph--folds (list id)))
          (noema-research-graph--apply-view-change "Branch folded"))))))

(defun noema-research-graph--node-ids (document)
  "Return DOCUMENT's WorkNode ids in document order."
  (mapcar #'noema-research-work-node-id (noema-research-work-nodes document)))

(defun noema-research-graph-fold-finished ()
  "Fold every branch Smart Fold contracts, in every zoom level."
  (interactive)
  (let* ((document (noema-research-graph--cached-document))
         (ids (let ((noema-research-graph--unfolds nil))
                (noema-research-graph--smart-folds document t))))
    (unless ids (user-error "No finished branch to fold"))
    (setq noema-research-graph--folds (delete-dups (append noema-research-graph--folds ids))
          noema-research-graph--unfolds (seq-difference noema-research-graph--unfolds ids))
    (noema-research-graph--apply-view-change
     (format "%d finished branch%s folded" (length ids) (if (cdr ids) "es" "")))))

(defun noema-research-graph-unfold-all ()
  "Expand every branch, including ones Smart Fold would contract."
  (interactive)
  (let ((document (noema-research-graph--cached-document)))
    (setq noema-research-graph--folds nil
          noema-research-graph--unfolds (let ((noema-research-graph--unfolds nil))
                                          (noema-research-graph--smart-folds document t))
          noema-research-graph--fold-cycle 0)
    (noema-research-graph--apply-view-change "Every branch expanded")))

(defun noema-research-graph--lineage-depths (document)
  "Return a hash table of each WorkNode's shortest lineage depth in DOCUMENT."
  (pcase-let* ((`(,children ,_parents ,roots) (noema-research-lineage-maps document))
               (depths (make-hash-table :test #'equal))
               (queue (mapcar (lambda (root) (cons root 0)) roots)))
    (while queue
      (pcase-let ((`(,id . ,depth) (pop queue)))
        (unless (gethash id depths)
          (puthash id depth depths)
          (dolist (child (gethash id children))
            (setq queue (append queue (list (cons child (1+ depth)))))))))
    depths))

(defun noema-research-graph-fold-to-level (level)
  "Show LEVEL lineage levels and fold every branch below them."
  (interactive (list (read-number "Show lineage levels: " 2)))
  (unless (and (integerp level) (> level 0))
    (user-error "Levels must be a positive integer"))
  (let* ((document (noema-research-graph--cached-document))
         (depths (noema-research-graph--lineage-depths document)))
    (setq noema-research-graph--folds
          (seq-filter (lambda (id)
                        (and (eql (gethash id depths) (1- level))
                             (noema-research-branch-ids document id)))
                      (noema-research-graph--node-ids document))
          noema-research-graph--unfolds
          (let ((noema-research-graph--unfolds nil))
            (noema-research-graph--smart-folds document t)))
    (noema-research-graph--apply-view-change
     (format "Showing %d lineage level%s" level (if (= level 1) "" "s")))))

(defun noema-research-graph-fold-others ()
  "Fold every branch beside the selected node's lineage path."
  (interactive)
  (let ((id (noema-research-graph--selected-node))
        (document (noema-research-graph--cached-document))
        ids)
    (pcase-let* ((`(,children ,parents ,roots) (noema-research-lineage-maps document))
                 (path (cons id (noema-research--walk id parents))))
      (dolist (candidate (append roots
                                 (mapcan (lambda (node) (copy-sequence (gethash node children)))
                                         path)))
        (when (and (not (member candidate path))
                   (not (member candidate ids))
                   (noema-research-branch-ids document candidate))
          (push candidate ids))))
    (unless ids (user-error "Nothing beside this path to fold"))
    (setq ids (nreverse ids)
          noema-research-graph--folds (delete-dups (append noema-research-graph--folds ids))
          noema-research-graph--unfolds (seq-difference noema-research-graph--unfolds ids))
    (noema-research-graph--apply-view-change
     (format "%d branch%s beside the path folded" (length ids) (if (cdr ids) "es" "")))))

(defun noema-research-graph-cycle-folds ()
  "Cycle the whole DAG through one level, two levels and everything."
  (interactive)
  (pcase noema-research-graph--fold-cycle
    (0 (noema-research-graph-fold-to-level 1)
       (setq noema-research-graph--fold-cycle 1))
    (1 (noema-research-graph-fold-to-level 2)
       (setq noema-research-graph--fold-cycle 2))
    (_ (noema-research-graph-unfold-all)
       (setq noema-research-graph--fold-cycle 0))))

;;;; Focus

(defun noema-research-graph--effective-focus-depth ()
  "Return the descendant depth of the focus lens."
  (or noema-research-graph--focus-depth
      (noema-research-graph--setting 'noema-research-graph-focus-depth)
      2))

(defun noema-research-graph--center-on (id)
  "Center the viewport on node ID when it is drawn."
  (when-let* ((view noema-research-graph--view)
              (centered (and id (noema-research-graph--centered-view view id))))
    (noema-research-graph--set-view centered)))

(defun noema-research-graph--remember-focus ()
  "Push the current focus onto the bounded focus history."
  (setq noema-research-graph--focus-history
        (seq-take (cons noema-research-graph--focus noema-research-graph--focus-history)
                  20)))

(defun noema-research-graph--focus-trail (document)
  "Return the breadcrumb from a lineage root down to the focus of DOCUMENT.
Each step follows the first lineage parent; long trails keep their last
three steps."
  (pcase-let ((`(,_children ,parents ,_roots) (noema-research-lineage-maps document)))
    (let ((id noema-research-graph--focus)
          (seen (make-hash-table :test #'equal))
          trail)
      (while (and id (not (gethash id seen)))
        (puthash id t seen)
        (push (truncate-string-to-width
               (noema-research-work-node-label document id) 28 nil nil "…")
              trail)
        (setq id (car (gethash id parents))))
      (string-join (if (> (length trail) 3)
                       (cons "…" (last trail 3))
                     trail)
                   " › "))))

(defun noema-research-graph--focus-distance (document id)
  "Return how many lineage levels ID lies below the focus in DOCUMENT.
Return 0 for the focus itself and nil when ID is outside the focused branch."
  (when-let* ((focus noema-research-graph--focus))
    (if (equal id focus)
        0
      (pcase-let ((`(,children ,_parents ,_roots) (noema-research-lineage-maps document)))
        (let ((seen (make-hash-table :test #'equal))
              (frontier (list focus))
              (level 0)
              found)
          (puthash focus t seen)
          (while (and frontier (not found))
            (setq level (1+ level))
            (let (next)
              (dolist (parent frontier)
                (dolist (child (gethash parent children))
                  (unless (gethash child seen)
                    (puthash child t seen)
                    (when (equal child id) (setq found level))
                    (push child next))))
              (setq frontier next)))
          found)))))

(defun noema-research-graph--keep-in-focus (document id)
  "Widen the focus lens of DOCUMENT so node ID stays drawn.
A node below the focus but past the lens depth deepens the lens; a node
outside the focused branch clears the focus, which stays in the focus
history.  Return non-nil when the view state changed."
  (when (and noema-research-graph--focus document (stringp id)
             (noema-research-find-work-node document id))
    (let ((distance (noema-research-graph--focus-distance document id)))
      (cond ((null distance)
             (noema-research-graph--remember-focus)
             (setq noema-research-graph--focus nil)
             t)
            ((> distance (noema-research-graph--effective-focus-depth))
             (setq noema-research-graph--focus-depth distance)
             t)))))

(defun noema-research-graph--refocus (id)
  "Focus the lens on ID, or clear it when ID is nil, remembering the old focus."
  (unless (equal id noema-research-graph--focus)
    (noema-research-graph--remember-focus))
  (setq noema-research-graph--focus id)
  (when id (setq noema-research-graph--selected id))
  (noema-research-graph--apply-view-change)
  (noema-research-graph--center-on (or id noema-research-graph--selected)))

(defun noema-research-graph-focus-up ()
  "Move the focus root one lineage level up, or clear it at a root.
A node with several lineage parents moves to the first one."
  (interactive)
  (unless noema-research-graph--focus
    (user-error "No focus: press f on a node first"))
  (pcase-let* ((document (noema-research-graph--cached-document))
               (`(,_children ,parents ,_roots) (noema-research-lineage-maps document))
               (parent (car (gethash noema-research-graph--focus parents))))
    (noema-research-graph--refocus parent)
    (unless parent (message "Focus cleared: the focused node is a root"))))

(defun noema-research-graph-toggle-focus ()
  "Make the selected node the root of the drawing, or clear the focus.
The lens shows that node and its lineage descendants down to the focus
depth.  On a `Deeper branches' summary the focus moves to the summary's
parent, continuing the branch below the current lens."
  (interactive)
  (let ((id (noema-research-graph--node-at-point)))
    (if-let* ((parent (noema-research-graph--related-parent id)))
        (noema-research-graph--refocus parent)
      (noema-research-graph--require-materialized id)
      (noema-research-graph--refocus (unless (equal id noema-research-graph--focus) id)))))

(defun noema-research-graph-focus-back ()
  "Return to the previous focus."
  (interactive)
  (unless noema-research-graph--focus-history
    (user-error "No earlier focus"))
  (let ((previous (pop noema-research-graph--focus-history)))
    (setq noema-research-graph--focus previous)
    (when previous (setq noema-research-graph--selected previous))
    (noema-research-graph--apply-view-change)
    (noema-research-graph--center-on (or previous noema-research-graph--selected))))

(defun noema-research-graph--change-focus-depth (delta)
  "Change the focus lens depth by DELTA levels."
  (unless noema-research-graph--focus
    (user-error "No focus: press f on a node first"))
  (setq noema-research-graph--focus-depth
        (max 1 (min 12 (+ (noema-research-graph--effective-focus-depth) delta))))
  (noema-research-graph--apply-view-change
   (format "Focus depth: %d" noema-research-graph--focus-depth)))

(defun noema-research-graph-focus-deeper ()
  "Show one more descendant level below the focus."
  (interactive)
  (noema-research-graph--change-focus-depth 1))

(defun noema-research-graph-focus-shallower ()
  "Show one descendant level fewer below the focus."
  (interactive)
  (noema-research-graph--change-focus-depth -1))

(defun noema-research-graph-cycle-zoom ()
  "Cycle semantic zoom through overview, branch, and detail."
  (interactive)
  (setq noema-research-graph--zoom
        (pcase noema-research-graph--zoom
          ("overview" "branch") ("branch" "detail") (_ "overview")))
  (noema-research-graph--apply-view-change
   (format "Noema Graph semantic zoom: %s" noema-research-graph--zoom)))

;;;; Branch organization

(defun noema-research-graph-branch-done ()
  "Mark the selected work and its branch done, as one structure edit."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit (lambda () (noema-research-op-set-branch-state id "done")))))

(defun noema-research-graph-branch-reopen ()
  "Reopen the selected work and its branch, and expand it."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit (lambda () (noema-research-op-set-branch-state id "open")))
    (setq noema-research-graph--folds (remove id noema-research-graph--folds))
    (noema-research-graph--apply-view-change)))

(defun noema-research-graph-drop-branch ()
  "Drop the selected branch with a reason, then fold it and select its parent.
The DAG keeps the branch; `noema-research-graph-fold-on-drop' contracts it
to a summary, as in Drop Branch of the assignment walkthrough."
  (interactive)
  (let* ((id (noema-research-graph--selected-node))
         (reason (read-string "Reason (optional): ")))
    (noema-research-graph--edit
     (lambda () (noema-research-op-set-branch-state id "dropped" reason)))
    (let ((document (noema-research-graph--cached-document)))
      (when (and (noema-research-graph--setting 'noema-research-graph-fold-on-drop)
                 (noema-research-branch-ids document id))
        (setq noema-research-graph--folds
              (append (remove id noema-research-graph--folds) (list id))
              noema-research-graph--unfolds (remove id noema-research-graph--unfolds))
        (when-let* ((parent (car (noema-research-relation-parents document id "lineage"))))
          (setq noema-research-graph--selected parent))
        (noema-research-graph--apply-view-change "Branch dropped and folded")))))

(transient-define-prefix noema-research-graph-branch-menu ()
  "Organize the selected branch."
  [["State (one undo step)"
    ("d" "mark branch done" noema-research-graph-branch-done)
    ("x" "drop branch and fold it" noema-research-graph-drop-branch)
    ("o" "reopen branch" noema-research-graph-branch-reopen)]
   ["View"
    ("TAB" "fold / expand branch" noema-research-graph-toggle-fold)
    ("f" "focus branch" noema-research-graph-toggle-focus)
    ("O" "fold others" noema-research-graph-fold-others)]])

(transient-define-prefix noema-research-graph-view-menu ()
  "Change what the Graph Board shows and where it looks."
  [["Fold"
    ("a" "fold finished branches" noema-research-graph-fold-finished)
    ("A" "expand everything" noema-research-graph-unfold-all)
    ("l" "show N levels" noema-research-graph-fold-to-level)
    ("o" "fold others" noema-research-graph-fold-others)
    ("TAB" "fold / expand branch" noema-research-graph-toggle-fold :transient t)]
   ["Focus"
    ("f" "focus / clear" noema-research-graph-toggle-focus)
    ("^" "focus parent" noema-research-graph-focus-up :transient t)
    ("[" "shallower" noema-research-graph-focus-shallower :transient t)
    ("]" "deeper" noema-research-graph-focus-deeper :transient t)
    ("b" "previous focus" noema-research-graph-focus-back)]
   ["Viewport"
    ("+" "zoom in" noema-research-graph-zoom-in :transient t)
    ("-" "zoom out" noema-research-graph-zoom-out :transient t)
    ("0" "100%" noema-research-graph-zoom-reset)
    ("=" "fit whole DAG" noema-research-graph-fit)
    ("." "center selection" noema-research-graph-center)
    ("w" "enlarge / restore" noema-research-graph-toggle-maximize)]
   ["Board"
    ("z" "semantic zoom" noema-research-graph-cycle-zoom :transient t)
    ("," "settings" noema-research-settings)]])

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
    (when (noema-research-work-prompt-empty-p cell)
      (user-error "“%s” has no prompt yet; visit it (RET) and write what the agent should do"
                  (noema-research-work-node-label document id)))
    (with-current-buffer source
      ;; D-031: SESSION-POLICY is a `@@session' value; a fork parent is a
      ;; session name, never a machine id.
      (noema-run-cell cell session-policy))))

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

(defun noema-research-graph-run-fork (target)
  "Run selected work in a session forked as TARGET.
TARGET is `parent:child' (or `:child' to fork the inherited session); empty
forks the inherited session under a derived child name."
  (interactive (list (read-string "Fork as parent:child (empty derives both): ")))
  (let ((target (string-trim target)))
    (unless (or (string-empty-p target) (noema-research-session-directive-valid-p target))
      (user-error "Invalid session fork: %s" target))
    (noema-research-graph--run (if (string-empty-p target) "fork" target))))

(defun noema-research-graph-sessions ()
  "List the named agent sessions of the Graph Board's document."
  (interactive)
  (with-current-buffer (or noema-research-graph--source (current-buffer))
    (noema-sessions)))

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

(defun noema-research-graph-delete-work-node ()
  "Delete the selected WorkNode; its Cells stay as notes."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (let ((policy (noema-research-read-delete-policy noema-research--document id)))
         (noema-research-op-delete-node id (eq policy 'reconnect)))))))

(defun noema-research-graph--header-cell (id)
  "Return the header Cell of WorkNode ID in the current source document."
  (or (noema-research-primary-cell noema-research--document id)
      (user-error "“%s” has no Cell"
                  (noema-research-work-node-label noema-research--document id))))

(defun noema-research-graph-unbind-cell ()
  "Unbind the selected node's header Cell; the WorkNode stays."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (let ((cell (noema-research-graph--header-cell id)))
         (unless (yes-or-no-p
                  (format "Unbind the Cell of “%s” and keep the WorkNode? "
                          (noema-research-work-node-label noema-research--document id)))
           (user-error "Unbind cancelled"))
         (noema-research-op-unbind-cell (noema-research-cell-id cell)))))))

(defun noema-research-graph-delete-cell ()
  "Delete the selected node's header Cell; the WorkNode stays."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit
     (lambda ()
       (let ((cell (noema-research-graph--header-cell id)))
         (unless (yes-or-no-p
                  (format "Delete the Cell of “%s” and keep the WorkNode? "
                          (noema-research-work-node-label noema-research--document id)))
           (user-error "Cell deletion cancelled"))
         (noema-research-op-delete-cell (noema-research-cell-id cell)))))))

(defun noema-research-graph-attach-cell ()
  "Create a header Cell for the selected Cell-less WorkNode."
  (interactive)
  (let ((id (noema-research-graph--selected-node)))
    (noema-research-graph--edit (lambda () (noema-research-op-attach-cell id)))))

(transient-define-prefix noema-research-graph-structure ()
  "Change the selected node's identity-bearing structure."
  [["WorkNode"
    ("r" "rename (identity/edges unchanged)" noema-research-graph-rename-work-node)
    ("k" "change kind" noema-research-graph-change-kind)
    ("m" "move under another parent" noema-research-graph-move-work-node)
    ("w" "delete WorkNode; keep Cells as notes" noema-research-graph-delete-work-node)]
   ["Cell"
    ("b" "create a Cell for a Cell-less node" noema-research-graph-attach-cell)
    ("u" "unbind Cell; keep WorkNode" noema-research-graph-unbind-cell)
    ("c" "delete Cell; keep WorkNode" noema-research-graph-delete-cell)]
   ["History"
    ("z" "undo structure edit" noema-research-graph-undo)
    ("Z" "redo structure edit" noema-research-graph-redo)]])

(defun noema-research-graph--buffer-for (source)
  "Return the DAG buffer already attached to SOURCE, or initialize one.
Reusing the attached board keeps its focus, folds, viewport and caches."
  (let ((existing (get-buffer noema-research-graph-buffer-name)))
    (if (and existing
             (eq (buffer-local-value 'noema-research-graph--source existing) source)
             (with-current-buffer existing
               (derived-mode-p 'noema-research-graph-mode)))
        existing
      (noema-research-graph-buffer source))))

(defun noema-research-graph-follow-source (source work-node-id)
  "Explicitly attach the singleton DAG to SOURCE and select WORK-NODE-ID.
When the DAG is displayed, the selected node is centered."
  (let ((graph (noema-research-graph--buffer-for source)))
    (with-current-buffer graph
      (when work-node-id
        (setq noema-research-graph--selected work-node-id)
        (when (noema-research-graph--keep-in-focus
               (buffer-local-value 'noema-research--document source) work-node-id)
          (noema-research-graph--save-view))
        (noema-research-graph-refresh)
        (when-let* (((get-buffer-window graph t))
                    (view noema-research-graph--view)
                    (centered (noema-research-graph--centered-view view work-node-id)))
          (noema-research-graph--set-view centered))))
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
            noema-research-graph--unfolds
            (delq nil (mapcar (lambda (id)
                                (noema-research-resolve-work-node-id document id))
                              (plist-get view :unfolds)))
            noema-research-graph--focus-depth (plist-get view :focus-depth)
            noema-research-graph--view (plist-get view :viewport)
            noema-research-graph--settings
            (and file (noema-research-settings-document-overrides file document))
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
  "Keep the DAG's viewport on the same drawing point after a resize in FRAME.
Only the image size and transform change; Graphviz does not run."
  (when-let* ((graph (get-buffer noema-research-graph-buffer-name))
              (window (get-buffer-window graph (or frame t))))
    (let ((size (cons (window-body-width window t)
                      (window-body-height window t))))
      (with-current-buffer graph
        (unless (equal size noema-research-graph--window-size)
          (let ((old noema-research-graph--window-size)
                (view noema-research-graph--view))
            (setq noema-research-graph--window-size size)
            (when (buffer-live-p noema-research-graph--source)
              (if (and old view noema-research-graph--scene
                       (not noema-research-graph--view-provisional))
                  (progn
                    (setq noema-research-graph--view
                          (noema-research-graph--clamp-view
                           (list :dx (+ (plist-get view :dx) (/ (- (car size) (car old)) 2.0))
                                 :dy (+ (plist-get view :dy) (/ (- (cdr size) (cdr old)) 2.0))
                                 :scale (plist-get view :scale))))
                    (noema-research-graph--display))
                (noema-research-graph--redraw)))))))))

(add-hook 'window-size-change-functions
          #'noema-research-graph--window-size-changed)

(defun noema-research-graph--settings-changed (_variable _scope source)
  "Reload document settings and redraw the board showing SOURCE."
  (when-let* ((graph (get-buffer noema-research-graph-buffer-name)))
    (with-current-buffer graph
      (when (and (buffer-live-p noema-research-graph--source)
                 (or (null source) (eq source noema-research-graph--source)))
        (let ((file (buffer-file-name noema-research-graph--source)))
          (setq noema-research-graph--settings
                (and file (noema-research-settings-document-overrides
                           file (buffer-local-value 'noema-research--document
                                                    noema-research-graph--source)))
                noema-research-graph--dot-cache nil
                noema-research-graph--scene nil))
        (noema-research-graph--redraw)))))

(add-hook 'noema-research-settings-changed-functions
          #'noema-research-graph--settings-changed)

(provide 'noema-research-graph)

;;; noema-research-graph.el ends here
