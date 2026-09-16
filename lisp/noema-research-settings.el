;;; noema-research-settings.el --- Settings center for Noema work documents -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; One place to see and change every option of JuText and the Graph Board.
;; The model follows el-easydraw's editor settings table
;; (`edraw-editor-settings-info' / `edraw-editor-load-settings'): each entry
;; names the defcustom that holds its global value and whether a document may
;; override it.  A value resolves as
;;
;;   document override > the defcustom's current value > its standard value.
;;
;; Document overrides live with the view state under
;; `<repository>/.agent/views/', never in the `.noema' file.  Global changes go
;; through Customize, so `s' in the settings buffer persists them to
;; `custom-file'.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-research)

(defgroup noema-research-graph nil
  "Noema Graph Board display, navigation, focus and folding."
  :group 'noema-research)

;;;; Graph Board options

(defcustom noema-research-graph-window-height 0.42
  "Height of the temporary DAG pop-up as a fraction of the frame."
  :type 'number
  :group 'noema-research-graph)

(defcustom noema-research-graph-min-readable-scale 0.75
  "Smallest scale at which a DAG opens fitted to its window.
A DAG that would need a smaller scale opens at 100% instead and is panned,
so node titles stay legible however long the graph grows."
  :type 'number
  :group 'noema-research-graph)

(defcustom noema-research-graph-zoom-step 1.25
  "Magnification applied by one geometric zoom step."
  :type 'number
  :group 'noema-research-graph)

(defcustom noema-research-graph-rankdir "TB"
  "Graphviz rank direction: \"TB\" (top to bottom) or \"LR\" (left to right)."
  :type '(choice (const "TB") (const "LR"))
  :group 'noema-research-graph)

(defcustom noema-research-graph-nodesep 0.35
  "Graphviz minimum distance between nodes of one rank, in inches."
  :type 'number
  :group 'noema-research-graph)

(defcustom noema-research-graph-ranksep 0.45
  "Graphviz minimum distance between ranks, in inches."
  :type 'number
  :group 'noema-research-graph)

(defcustom noema-research-graph-theme 'auto
  "Graph Board palette: `auto' follows the frame background."
  :type '(choice (const auto) (const light) (const dark))
  :group 'noema-research-graph)

(defcustom noema-research-graph-scroll-distance
  '((nil . 80) ((shift) . 80) ((control) . 320) ((control shift) . 320))
  "Pixels panned by one pan key, by the key's modifiers.
Each element is (MODIFIERS . PIXELS), as in el-easydraw's
`edraw-editor-scroll-distance-by-arrow-key'."
  :type '(alist :key-type (repeat symbol) :value-type natnum)
  :group 'noema-research-graph)

(defcustom noema-research-graph-wheel-step 40
  "Pixels panned by one mouse-wheel click without precise deltas."
  :type 'natnum
  :group 'noema-research-graph)

(defcustom noema-research-graph-wheel-action 'scroll
  "What the plain mouse wheel does.  `C-<wheel>' always zooms."
  :type '(choice (const scroll) (const zoom))
  :group 'noema-research-graph)

(defcustom noema-research-graph-follow-margin 24
  "Pixels kept between the selected node and the viewport edge."
  :type 'natnum
  :group 'noema-research-graph)

(defcustom noema-research-graph-focus-depth 2
  "Descendant levels shown below a focused node."
  :type 'natnum
  :group 'noema-research-graph)

(defcustom noema-research-graph-auto-fold-states '("done" "dropped")
  "Work states whose branches Smart Fold contracts automatically."
  :type '(repeat string)
  :group 'noema-research-graph)

(defcustom noema-research-graph-auto-fold-zooms '("overview")
  "Semantic zoom levels in which Smart Fold is active."
  :type '(repeat string)
  :group 'noema-research-graph)

(defcustom noema-research-graph-fold-on-drop t
  "Whether dropping a branch from the Graph Board also folds it."
  :type 'boolean
  :group 'noema-research-graph)

(defcustom noema-research-graph-dim-states '("dropped")
  "Work states drawn dimmed.  Dimmed nodes stay in the DAG."
  :type '(repeat string)
  :group 'noema-research-graph)

;;;; Settings table

(defconst noema-research-settings-info
  '((noema-research-graph-window-height
     :section "Graph display" :scope global :type number)
    (noema-research-graph-min-readable-scale
     :section "Graph display" :scope global :type number)
    (noema-research-graph-zoom-step
     :section "Graph display" :scope global :type number)
    (noema-research-graph-rankdir
     :section "Graph display" :scope both :type choice :choices ("TB" "LR"))
    (noema-research-graph-nodesep
     :section "Graph display" :scope both :type number)
    (noema-research-graph-ranksep
     :section "Graph display" :scope both :type number)
    (noema-research-graph-theme
     :section "Graph display" :scope global :type choice :choices (auto light dark))
    (noema-research-graph-dot-program
     :section "Graph display" :scope global :type string)
    (noema-research-graph-scroll-distance
     :section "Navigation" :scope global :type sexp)
    (noema-research-graph-wheel-step
     :section "Navigation" :scope global :type natnum)
    (noema-research-graph-wheel-action
     :section "Navigation" :scope global :type choice :choices (scroll zoom))
    (noema-research-graph-follow-margin
     :section "Navigation" :scope global :type natnum)
    (noema-research-graph-focus-depth
     :section "Focus & fold" :scope both :type natnum)
    (noema-research-graph-auto-fold-states
     :section "Focus & fold" :scope both :type string-list
     :choices noema-research-work-states)
    (noema-research-graph-auto-fold-zooms
     :section "Focus & fold" :scope both :type string-list
     :choices ("overview" "branch" "detail"))
    (noema-research-graph-fold-on-drop
     :section "Focus & fold" :scope both :type boolean)
    (noema-research-graph-dim-states
     :section "Focus & fold" :scope both :type string-list
     :choices noema-research-work-states)
    (noema-research-structure-history-limit
     :section "Structure" :scope global :type natnum)
    (noema-research-move-relocates-block
     :section "Structure" :scope global :type boolean)
    (noema-research-python-interpreter
     :section "Runs & host" :scope global :type string)
    (noema-research-open-graph-on-visit
     :section "Workspace" :scope global :type boolean)
    (noema-research-open-output-on-visit
     :section "Workspace" :scope global :type boolean)
    (noema-research-sync-host
     :section "Runs & host" :scope global :type boolean))
  "Every Noema research setting: (VARIABLE . PROPERTIES).
PROPERTIES has :section, :scope (`global' or `both', the latter allowing a
document override), :type (boolean, natnum, number, string, choice,
string-list or sexp) and optional :choices (a list or a variable).")

(defvar noema-research-settings-changed-functions nil
  "Abnormal hook run after a setting changes.
Each function receives VARIABLE, SCOPE (`global' or `document') and the
JuText SOURCE buffer or nil.")

(defun noema-research-settings--entry (variable)
  "Return the properties of setting VARIABLE, or signal an error."
  (or (alist-get variable noema-research-settings-info)
      (error "Unknown Noema setting: %s" variable)))

(defun noema-research-settings--json-name (variable)
  "Return the view-file key of VARIABLE."
  (string-remove-prefix "noema-research-" (symbol-name variable)))

(defun noema-research-settings--standard (variable)
  "Return VARIABLE's standard (built-in) value."
  (when-let* ((standard (get variable 'standard-value)))
    (eval (car standard) t)))

(defun noema-research-setting (variable &optional overrides)
  "Return the effective value of setting VARIABLE.
OVERRIDES is an alist of document overrides (VARIABLE . VALUE)."
  (if-let* ((cell (assq variable overrides)))
      (cdr cell)
    (if (boundp variable)
        (symbol-value variable)
      (noema-research-settings--standard variable))))

(defun noema-research-settings--from-json (variable value)
  "Convert JSON VALUE stored for VARIABLE; return (VARIABLE . LISP) or nil."
  (let ((props (noema-research-settings--entry variable)))
    (pcase (plist-get props :type)
      ('boolean (and (memq value '(t :false)) (cons variable (eq value t))))
      ('natnum (and (natnump value) (cons variable value)))
      ('number (and (numberp value) (cons variable value)))
      ((or 'string 'choice) (and (stringp value) (cons variable value)))
      ('string-list (and (vectorp value) (seq-every-p #'stringp value)
                         (cons variable (append value nil)))))))

(defun noema-research-settings--to-json (variable value)
  "Return VALUE of setting VARIABLE encoded for the view file."
  (pcase (plist-get (noema-research-settings--entry variable) :type)
    ('boolean (if value t :false))
    ('string-list (vconcat value))
    (_ value)))

(defun noema-research-settings-document-overrides (file document)
  "Return DOCUMENT's setting overrides stored next to FILE as an alist."
  (when file
    (let ((stored (plist-get (noema-research-view-read file document) :settings))
          overrides)
      (pcase-dolist (`(,variable . ,props) noema-research-settings-info)
        (when (eq (plist-get props :scope) 'both)
          (when-let* ((cell (assoc (noema-research-settings--json-name variable) stored))
                      (converted (noema-research-settings--from-json
                                  variable (cdr cell))))
            (push converted overrides))))
      (nreverse overrides))))

(defun noema-research-settings-set-document (file document variable value &optional clear)
  "Store VALUE as DOCUMENT's override of VARIABLE; CLEAR removes the override."
  (unless (eq (plist-get (noema-research-settings--entry variable) :scope) 'both)
    (user-error "%s cannot be set per document" variable))
  (noema-research-view-update
   file document
   (lambda (view)
     (let ((settings (let ((existing (gethash "settings" view)))
                       (if (hash-table-p existing)
                           existing
                         (make-hash-table :test #'equal))))
           (name (noema-research-settings--json-name variable)))
       (if clear
           (remhash name settings)
         (puthash name (noema-research-settings--to-json variable value) settings))
       (puthash "settings" settings view)))))

;;;; Settings buffer

(defvar-local noema-research-settings--source nil
  "JuText buffer whose document overrides this settings buffer shows.")

(defun noema-research-settings--context ()
  "Return (FILE . DOCUMENT) of the settings buffer's source, or nil."
  (when (buffer-live-p noema-research-settings--source)
    (let ((file (buffer-file-name noema-research-settings--source))
          (document (buffer-local-value 'noema-research--document
                                        noema-research-settings--source)))
      (and file document (cons file document)))))

(defun noema-research-settings--overrides ()
  "Return the document overrides of the settings buffer's source."
  (when-let* ((context (noema-research-settings--context)))
    (noema-research-settings-document-overrides (car context) (cdr context))))

(defun noema-research-settings--origin (variable overrides)
  "Return where VARIABLE's effective value comes from, given OVERRIDES."
  (cond ((assq variable overrides) "document")
        ((and (boundp variable)
              (not (equal (symbol-value variable)
                          (noema-research-settings--standard variable))))
         "global")
        (t "default")))

(defun noema-research-settings--entries ()
  "Return `tabulated-list-entries' for the settings buffer."
  (let ((overrides (noema-research-settings--overrides)))
    (mapcar
     (lambda (entry)
       (let* ((variable (car entry))
              (props (cdr entry))
              (value (noema-research-setting variable overrides)))
         (list variable
               (vector (plist-get props :section)
                       (string-remove-prefix "noema-research-" (symbol-name variable))
                       (truncate-string-to-width (format "%S" value) 36 nil nil "…")
                       (noema-research-settings--origin variable overrides)
                       (if (eq (plist-get props :scope) 'both) "doc/global" "global")))))
     noema-research-settings-info)))

(defun noema-research-settings--choices (props)
  "Return the completion choices of setting PROPS."
  (let ((choices (plist-get props :choices)))
    (if (and choices (symbolp choices)) (symbol-value choices) choices)))

(defun noema-research-settings--read (variable current)
  "Read a new value for VARIABLE, offering CURRENT."
  (let* ((props (noema-research-settings--entry variable))
         (prompt (format "%s: " (string-remove-prefix "noema-research-"
                                                     (symbol-name variable)))))
    (pcase (plist-get props :type)
      ('boolean (not current))
      ('natnum (let ((value (read-number prompt current)))
                 (unless (natnump value)
                   (user-error "%s must be a non-negative integer" variable))
                 value))
      ('number (read-number prompt current))
      ('string (read-string prompt current))
      ('choice (let* ((choices (noema-research-settings--choices props))
                      (names (mapcar (lambda (choice) (format "%s" choice)) choices))
                      (name (completing-read prompt names nil t nil nil
                                             (format "%s" current))))
                 (nth (seq-position names name #'equal) choices)))
      ('string-list (completing-read-multiple
                     prompt (noema-research-settings--choices props) nil t
                     (string-join current ",")))
      (_ (read-from-minibuffer prompt (prin1-to-string current)
                               read-expression-map t)))))

(defun noema-research-settings--changed (variable scope)
  "Notify listeners that VARIABLE changed in SCOPE and redisplay."
  (run-hook-with-args 'noema-research-settings-changed-functions
                      variable scope noema-research-settings--source)
  (noema-research-settings-revert))

(defun noema-research-settings--variable ()
  "Return the setting on the current line."
  (or (tabulated-list-get-id) (user-error "No setting on this line")))

(defun noema-research-settings-set-global (variable value)
  "Set VARIABLE's global VALUE for this session through Customize."
  (customize-set-variable variable value)
  (when (derived-mode-p 'noema-research-settings-mode)
    (noema-research-settings--changed variable 'global)))

(defun noema-research-settings-edit ()
  "Change the setting on this line, globally or for this document."
  (interactive)
  (let* ((variable (noema-research-settings--variable))
         (props (noema-research-settings--entry variable))
         (context (noema-research-settings--context))
         (scope (if (and context (eq (plist-get props :scope) 'both))
                    (pcase (car (read-multiple-choice
                                 "Change for: "
                                 '((?d "this document") (?g "all documents"))))
                      (?d 'document) (_ 'global))
                  'global)))
    (if (eq scope 'document)
        (noema-research-settings-edit-document)
      (noema-research-settings-set-global
       variable (noema-research-settings--read variable (symbol-value variable))))))

(defun noema-research-settings-edit-document ()
  "Override the setting on this line for the source document only."
  (interactive)
  (let* ((variable (noema-research-settings--variable))
         (context (or (noema-research-settings--context)
                      (user-error "Open the settings from a saved .noema document")))
         (value (noema-research-settings--read
                 variable (noema-research-setting
                           variable (noema-research-settings--overrides)))))
    (noema-research-settings-set-document (car context) (cdr context) variable value)
    (noema-research-settings--changed variable 'document)))

(defun noema-research-settings-clear-document ()
  "Remove the source document's override of the setting on this line."
  (interactive)
  (let ((variable (noema-research-settings--variable))
        (context (or (noema-research-settings--context)
                     (user-error "No document is attached to these settings"))))
    (unless (assq variable (noema-research-settings--overrides))
      (user-error "This document does not override %s" variable))
    (noema-research-settings-set-document (car context) (cdr context) variable nil t)
    (noema-research-settings--changed variable 'document)))

(defun noema-research-settings-reset-global ()
  "Reset the setting on this line to its standard value for this session."
  (interactive)
  (let ((variable (noema-research-settings--variable)))
    (noema-research-settings-set-global
     variable (noema-research-settings--standard variable))))

(defun noema-research-settings-save-global ()
  "Save the global value of the setting on this line to `custom-file'."
  (interactive)
  (let ((variable (noema-research-settings--variable)))
    (customize-save-variable variable (symbol-value variable))
    (message "Saved %s" variable)))

(defun noema-research-settings-revert (&rest _)
  "Redisplay the settings buffer."
  (interactive)
  (let ((line (line-number-at-pos)))
    (setq tabulated-list-entries (noema-research-settings--entries))
    (tabulated-list-print t)
    (goto-char (point-min))
    (forward-line (1- line))))

(defvar-keymap noema-research-settings-mode-map
  :parent tabulated-list-mode-map
  "RET" #'noema-research-settings-edit
  "e" #'noema-research-settings-edit
  "d" #'noema-research-settings-edit-document
  "k" #'noema-research-settings-clear-document
  "r" #'noema-research-settings-reset-global
  "s" #'noema-research-settings-save-global
  "g" #'noema-research-settings-revert)

(define-derived-mode noema-research-settings-mode tabulated-list-mode "Noema-Settings"
  "Browse and change Noema research settings.
Each row shows a setting's effective value and where it comes from: a
document override, a global value, or the default.  Change a row globally or
for the source document only; saving writes the global value to
`custom-file'.

\\{noema-research-settings-mode-map}"
  (setq tabulated-list-format [("Section" 14 nil) ("Setting" 34 nil)
                               ("Value" 38 nil) ("From" 9 nil) ("Scope" 10 nil)]
        tabulated-list-padding 1)
  (setq-local revert-buffer-function #'noema-research-settings-revert)
  (tabulated-list-init-header))

(defun noema-research-settings--source-buffer ()
  "Return the JuText buffer the current buffer belongs to, or nil."
  (cond ((and (boundp 'noema-research--document) noema-research--document)
         (current-buffer))
        ((and (boundp 'noema-research-graph--source)
              (buffer-live-p noema-research-graph--source))
         noema-research-graph--source)
        ((buffer-live-p noema-research-settings--source)
         noema-research-settings--source)))

;;;###autoload
(defun noema-research-settings (&optional source)
  "Open the Noema settings center for JuText SOURCE (default: this document)."
  (interactive)
  (let ((source (or source (noema-research-settings--source-buffer)))
        (buffer (get-buffer-create "*Noema Settings*")))
    (with-current-buffer buffer
      (noema-research-settings-mode)
      (setq noema-research-settings--source source)
      (setq header-line-format
            (format " Noema settings%s  ·  RET change  d document  k clear  s save  r reset"
                    (if (and source (buffer-file-name source))
                        (format " — %s" (buffer-name source))
                      "")))
      (noema-research-settings-revert))
    (pop-to-buffer buffer)
    buffer))

(provide 'noema-research-settings)

;;; noema-research-settings.el ends here
