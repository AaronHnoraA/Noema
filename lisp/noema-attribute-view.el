;;; noema-attribute-view.el --- Attribute views as native Emacs tables -*- lexical-binding: t; -*-

;;; Commentary:
;; A `#+begin av' block is a query over facts that live in Markdown (todos,
;; planning items, block properties).  The page draws it inside a note; this
;; file draws the same answer in an Emacs buffer with `vtable', so a view can be
;; sorted, read and edited from the keyboard without the page.
;;
;; Nothing here evaluates a view.  The spec is sent unchanged to the host
;; channel the page uses (`noema:api:notes:attribute-view'), which asks the Go
;; kernel; a cell edit goes through `noema:api:notes:attribute-view-cell-patch',
;; which writes the Markdown source.  The buffer keeps no data of its own: `g'
;; asks again, an edit asks again after the write.  Grammar:
;; docs/noema/design/syntax.md "Attribute view".

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'vtable)
(require 'noema-api)

(declare-function +noema-api-call "noema/bridge/config" (channel args callback &optional timeout))
(declare-function +noema--ensure-server "noema/bridge/config" (&optional callback))
(declare-function +noema-buffer-file "noema/bridge/config" (&optional buffer))
(declare-function aaron-open-place "aaron-open" (file &optional placement line column no-focus))

(defvar noema-attribute-view-table-map)

(defconst noema-attribute-view--open-re
  "^[ \t]*#\\+begin[ \t]+av\\(?:[ \t]+\\(.*?\\)\\)?[ \t]*$"
  "Opening line of an attribute view; group 1 is the title.")

(defconst noema-attribute-view--close-re "^[ \t]*#\\+end[ \t]+av[ \t]*$"
  "Closing line of an attribute view.")

(defconst noema-attribute-view--fence-re "^[ \t]*\\(```\\|~~~\\)"
  "A code fence; nothing inside one is a Noema form.")

(defvar noema-attribute-view-visit-function #'noema-attribute-view--visit-default
  "Function called with FILE and LINE to show a row's source.")

(defvar-local noema-attribute-view--spec nil
  "Plist (:file :title :source :line) of the view this buffer shows.")
(defvar-local noema-attribute-view--generation 0
  "Latest request; older answers are dropped.")
(defvar-local noema-attribute-view--result nil
  "Last answer, kept only to redraw and to read rows at point.")

;;;; Finding views in a note

(defun noema-attribute-view-blocks (text)
  "Return the attribute views in Markdown TEXT, in order.
Each is a plist (:title :source :line), LINE being the 1-based line of
the opening `#+begin av'.  Views inside code fences are examples, not
views, and an unclosed block is not a view."
  (let ((lines (split-string text "\n"))
        (number 0) fence open title body blocks)
    (dolist (line lines)
      (cl-incf number)
      (cond
       ((and (not open) (string-match noema-attribute-view--fence-re line))
        (let ((marker (match-string 1 line)))
          (cond ((null fence) (setq fence marker))
                ((string= fence marker) (setq fence nil)))))
       (fence nil)
       ((and (not open) (string-match noema-attribute-view--open-re line))
        (setq open number
              title (string-trim (or (match-string 1 line) ""))
              body nil))
       ((and open (string-match-p noema-attribute-view--close-re line))
        (push (list :title title
                    :source (string-join (nreverse body) "\n")
                    :line open)
              blocks)
        (setq open nil))
       (open (push line body))))
    (nreverse blocks)))

(defun noema-attribute-view--note-file ()
  "Return the Markdown note the current buffer stands for, or nil."
  (or (and (fboundp '+noema-buffer-file) (+noema-buffer-file))
      buffer-file-name))

(defun noema-attribute-view--note-text (file)
  "Return the text of FILE: the visiting buffer's, else the disk's."
  (if-let* ((buffer (find-buffer-visiting file)))
      (with-current-buffer buffer
        (save-restriction (widen) (buffer-substring-no-properties (point-min) (point-max))))
    (with-temp-buffer
      (insert-file-contents file)
      (buffer-string))))

(defun noema-attribute-view--label (block)
  "Return a completion label for BLOCK."
  (let ((title (plist-get block :title)))
    (format "%s  (line %d)"
            (if (string-empty-p title) "Attribute view" title)
            (plist-get block :line))))

(defun noema-attribute-view--choose (blocks)
  "Return the block of BLOCKS at point, the only one, or the one chosen."
  (let ((here (and buffer-file-name (line-number-at-pos))))
    (or (and here
             (seq-find (lambda (block)
                         (let ((start (plist-get block :line)))
                           (and (>= here start)
                                (<= here (+ start 1 (length (split-string (plist-get block :source) "\n")))))))
                       blocks))
        (and (null (cdr blocks)) (car blocks))
        (let* ((choices (mapcar (lambda (block) (cons (noema-attribute-view--label block) block)) blocks))
               (choice (completing-read "Attribute view: " choices nil t)))
          (cdr (assoc choice choices))))))

;;;###autoload
(defun noema-attribute-view (&optional file)
  "Show an attribute view of FILE (default: the current note) as a table.
Point inside a `#+begin av' block selects that block; otherwise a note
with several views asks which one."
  (interactive)
  (let* ((file (or file (noema-attribute-view--note-file)
                   (user-error "This buffer is not a Markdown note")))
         (blocks (noema-attribute-view-blocks (noema-attribute-view--note-text file))))
    (unless blocks
      (user-error "No `#+begin av' block in %s" (file-name-nondirectory file)))
    (let ((block (noema-attribute-view--choose blocks)))
      (noema-attribute-view-open (expand-file-name file)
                                 (plist-get block :title)
                                 (plist-get block :source)
                                 (plist-get block :line)))))

(defun noema-attribute-view-open (file title source &optional line)
  "Show the view with TITLE and SOURCE spec found in FILE at LINE."
  (let ((buffer (get-buffer-create
                 (format "*Noema view: %s*"
                         (if (string-empty-p (or title "")) (file-name-base file) title)))))
    (with-current-buffer buffer
      (noema-attribute-view-mode)
      (setq noema-attribute-view--spec (list :file file :title (or title "")
                                             :source (or source "") :line line))
      (noema-attribute-view-refresh))
    (pop-to-buffer buffer)))

;;;; Asking the host

(defun noema-attribute-view--call (channel body callback)
  "Send BODY on CHANNEL once the host runs; CALLBACK gets (RESULT ERROR)."
  (unless (fboundp '+noema-api-call) (require 'noema/bridge/config))
  (+noema--ensure-server
   (lambda () (+noema-api-call channel (vector body) callback 30))))

(defun noema-attribute-view-refresh ()
  "Ask the host for this view again and redraw it."
  (interactive)
  (let ((buffer (current-buffer))
        (generation (cl-incf noema-attribute-view--generation))
        (spec noema-attribute-view--spec))
    (noema-attribute-view--render-status "Evaluating…")
    (noema-attribute-view--call
     "noema:api:notes:attribute-view"
     `((title . ,(plist-get spec :title))
       (source . ,(plist-get spec :source))
       (file . ,(plist-get spec :file)))
     (lambda (result error-object)
       (when (buffer-live-p buffer)
         (with-current-buffer buffer
           (when (= generation noema-attribute-view--generation)
             (if error-object
                 (noema-attribute-view--render-status
                  (format "Evaluation failed: %s" (noema--value error-object "message" error-object)))
               (setq noema-attribute-view--result result)
               (noema-attribute-view--name-after result)
               (noema-attribute-view--render result)))))))))

(defun noema-attribute-view--name-after (result)
  "Name this buffer after RESULT's title, which the host has cleaned.
The title in the note can carry a block anchor; the host's answer is the
one parse of it, so the name is taken from there rather than re-parsed."
  (let ((title (noema--value result "title" "")))
    (unless (string-empty-p title)
      (let ((name (format "*Noema view: %s*" title)))
        (unless (equal (buffer-name) name)
          (rename-buffer name t))))))

;;;; Drawing

(defun noema-attribute-view--header (result)
  "Insert the title line and counts of RESULT."
  (let* ((spec noema-attribute-view--spec)
         (rows (length (noema--sequence (noema--value result "rows"))))
         (total (or (noema--value result "total") rows)))
    (insert (propertize (let ((title (noema--value result "title" "")))
                          (if (string-empty-p title) "Attribute view" title))
                        'face 'bold)
            "  "
            (propertize (format "%s · %s"
                                (noema--value result "source" "")
                                (if (eq (noema--value result "truncated") t)
                                    (format "%d of %d rows (limit)" rows total)
                                  (format "%d rows" total)))
                        'face 'shadow)
            "\n"
            (propertize (abbreviate-file-name (plist-get spec :file)) 'face 'shadow)
            "\n")
    (dolist (diagnostic (noema--sequence (noema--value result "diagnostics")))
      (insert (propertize (format "line %s: %s\n" (noema--value diagnostic "line" "?")
                                  (noema--value diagnostic "message" ""))
                          'face 'warning)))
    (insert "\n")))

(defun noema-attribute-view--numeric-type-p (type)
  "Non-nil when column TYPE holds numbers."
  (member type '("number" "linenumber")))

(defun noema-attribute-view--cell (row key)
  "Return the value of column KEY in ROW."
  (let ((cell (seq-find (lambda (cell) (equal (noema--value cell "key") key))
                        (noema--sequence (noema--value row "cells")))))
    (or (noema--value cell "value") "")))

(defun noema-attribute-view--table (columns rows)
  "Insert a vtable of ROWS with COLUMNS."
  (if (null rows)
      (insert (propertize "  No rows match.\n" 'face 'shadow))
    (make-vtable
     :columns (mapcar (lambda (column)
                        (let ((type (noema--value column "type")))
                          (append
                           (list :name (noema--value column "label" (noema--value column "key"))
                                 :max-width 60)
                           (when (noema-attribute-view--numeric-type-p type)
                             (list :align 'right)))))
                      columns)
     :objects rows
     :getter (lambda (row index _table)
               (noema-attribute-view--cell row (noema--value (nth index columns) "key")))
     :separator-width 2
     :keymap noema-attribute-view-table-map)))

(defun noema-attribute-view--calculations (result)
  "Insert RESULT's calculation footer."
  (when-let* ((calculations (noema--sequence (noema--value result "calculations"))))
    (insert "\n")
    (dolist (calculation calculations)
      (insert (propertize (format "  %s %s" (noema--value calculation "key")
                                  (noema--value calculation "operator"))
                          'face 'shadow)
              "  "
              (format "%s" (let ((value (noema--value calculation "value")))
                             (cond ((vectorp value) (string-join (mapcar (lambda (v) (format "%s" v)) value) ", "))
                                   ((null value) "")
                                   (t value))))
              "\n"))))

(defun noema-attribute-view--groups (rows)
  "Return ROWS grouped as ((NAME . ROWS)…) in first-seen order."
  (let (groups)
    (dolist (row rows)
      (let* ((name (or (noema--value row "group") ""))
             (entry (assoc name groups)))
        (if entry (setcdr entry (cons row (cdr entry)))
          (push (list name row) groups))))
    (mapcar (lambda (group) (cons (car group) (nreverse (cdr group)))) (nreverse groups))))

(defun noema-attribute-view--render (result)
  "Redraw the buffer from RESULT, keeping point's row when possible."
  (let ((inhibit-read-only t)
        (line (line-number-at-pos)))
    (erase-buffer)
    (noema-attribute-view--header result)
    (let ((columns (noema--sequence (noema--value result "columns")))
          (rows (noema--sequence (noema--value result "rows")))
          (group-by (noema--value result "groupBy" "")))
      (if (string-empty-p group-by)
          (noema-attribute-view--table columns rows)
        (dolist (group (noema-attribute-view--groups rows))
          (insert (propertize (format "%s: %s" group-by
                                      (if (string-empty-p (car group)) "(none)" (car group)))
                              'face 'font-lock-keyword-face)
                  (propertize (format "  %d\n" (length (cdr group))) 'face 'shadow))
          (noema-attribute-view--table columns (cdr group))
          (insert "\n"))))
    (noema-attribute-view--calculations result)
    (goto-char (point-min))
    (forward-line (1- line))))

(defun noema-attribute-view--render-status (text)
  "Show TEXT above the last drawn table, or alone."
  (let ((inhibit-read-only t))
    (save-excursion
      (goto-char (point-min))
      (if (get-text-property (point) 'noema-attribute-view-status)
          (delete-region (point) (line-beginning-position 2)))
      (insert (propertize (concat text "\n") 'face 'shadow 'noema-attribute-view-status t)))))

;;;; Acting on rows

(defun noema-attribute-view--row ()
  "Return the row at point or signal."
  (or (and (fboundp 'vtable-current-object) (ignore-errors (vtable-current-object)))
      (user-error "No row here")))

(defun noema-attribute-view--visit-default (file line)
  "Show FILE at LINE in another window."
  (if (fboundp 'aaron-open-place)
      (aaron-open-place file 'other line)
    (find-file-other-window file)
    (goto-char (point-min))
    (forward-line (1- (max 1 line)))))

(defun noema-attribute-view-visit ()
  "Show the source of the row at point."
  (interactive)
  (let ((row (noema-attribute-view--row)))
    (funcall noema-attribute-view-visit-function
             (noema--value row "file") (or (noema--value row "line") 1))))

(defun noema-attribute-view-visit-spec ()
  "Show the `#+begin av' block this buffer was opened from."
  (interactive)
  (let ((spec noema-attribute-view--spec))
    (funcall noema-attribute-view-visit-function
             (plist-get spec :file) (or (plist-get spec :line) 1))))

(defun noema-attribute-view--column-key ()
  "Return the column key under point."
  (let* ((index (or (ignore-errors (vtable-current-column)) (user-error "No column here")))
         (column (nth index (noema--sequence (noema--value noema-attribute-view--result "columns")))))
    (noema--value column "key")))

(defun noema-attribute-view-edit ()
  "Edit the cell at point; the host writes the Markdown source."
  (interactive)
  (let* ((row (noema-attribute-view--row))
         (key (noema-attribute-view--column-key))
         (old (noema-attribute-view--cell row key))
         (value (read-string (format "%s: " key) old))
         (buffer (current-buffer)))
    (unless (equal value old)
      (noema-attribute-view--call
       "noema:api:notes:attribute-view-cell-patch"
       `((id . ,(noema--value row "id")) (kind . ,(noema--value row "kind"))
         (file . ,(noema--value row "file")) (index . ,(noema--value row "index"))
         (key . ,key) (value . ,value))
       (lambda (_result error-object)
         (if error-object
             (message "Cell not written: %s" (noema--value error-object "message" error-object))
           (noema-attribute-view--revert-source (noema--value row "file"))
           (when (buffer-live-p buffer)
             (with-current-buffer buffer (noema-attribute-view-refresh)))))))))

(defun noema-attribute-view--revert-source (file)
  "Reread FILE in a clean visiting buffer after the host wrote it."
  (when-let* ((buffer (and (stringp file) (find-buffer-visiting file))))
    (with-current-buffer buffer
      (when (and (not (buffer-modified-p)) (not (verify-visited-file-modtime buffer)))
        (revert-buffer t t)))))

;;;; Mode

(defvar noema-attribute-view-table-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'noema-attribute-view-visit)
    (define-key map (kbd "e") #'noema-attribute-view-edit)
    map)
  "Keys on a table row, in addition to `vtable-map' (sorting, widths).")

(defvar noema-attribute-view-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'noema-attribute-view-refresh)
    (define-key map (kbd "v") #'noema-attribute-view-visit-spec)
    map)
  "Keys of an attribute view buffer.")

(define-derived-mode noema-attribute-view-mode special-mode "Noema-View"
  "An attribute view drawn as a table.
On a row, RET shows its source and `e' edits the cell at point; the
host writes the Markdown.  `g' asks again and `v' shows the view's
spec.  `vtable' keys sort (S) and resize ({ }) columns."
  (setq truncate-lines t))

(provide 'noema-attribute-view)
;;; noema-attribute-view.el ends here
