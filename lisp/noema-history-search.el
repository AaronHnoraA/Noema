;;; noema-history-search.el --- Native agent history search in Emacs -*- lexical-binding: t; -*-

;;; Commentary:
;; This is a read-only projection of Noema's project-scoped FTS5 index.  It
;; never edits the underlying Codex, Claude, Magent or agent-shell transcripts.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-api)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))
(declare-function noema-research-history-index "noema-agent-promote" (&optional directory))

(defvar-local noema-history-search--root nil)
(defvar-local noema-history-search--query "")
(defvar-local noema-history-search--source "")
(defvar-local noema-history-search--hits nil)
(defvar-local noema-history-search--generation 0)
(defvar noema-history-search--request-serial 0
  "Monotonic search id across buffer mode resets and projects.")

(defun noema-history-search--get (record key &optional fallback)
  "Read KEY in RECORD, or FALLBACK."
  (or (noema--value record key) fallback))

(defun noema-history-search--excerpt (hit)
  "Return HIT's excerpt without the FTS HTML marker tags."
  (let ((text (noema-history-search--get hit "excerpt" "")))
    (if (stringp text)
        (string-trim (replace-regexp-in-string "</?mark>" "" text t t))
      "")))

(defun noema-history-search--row (hit)
  "Return one tabulated HIT row."
  (let ((id (noema-history-search--get hit "id"))
        (date (noema-history-search--get hit "timestamp" "")))
    (list id
          (vector (noema-history-search--get hit "source" "")
                  (noema-history-search--get hit "role" "")
                  (if (and (stringp date) (> (length date) 16)) (substring date 0 16) date)
                  (noema-history-search--excerpt hit)))))

(defun noema-history-search--render (hits)
  "Render HITS in the current results buffer."
  (setq noema-history-search--hits (noema--sequence hits)
        tabulated-list-entries (mapcar #'noema-history-search--row noema-history-search--hits)
        header-line-format (format "Project: %s   Query: %s   Source: %s   Hits: %d"
                                   noema-history-search--root noema-history-search--query
                                   (if (string-empty-p noema-history-search--source)
                                       "all" noema-history-search--source)
                                   (length noema-history-search--hits)))
  (tabulated-list-print t))

(defun noema-history-search-refresh ()
  "Search this project's indexed native history."
  (interactive)
  (unless (and noema-history-search--root
               (not (string-empty-p (string-trim noema-history-search--query))))
    (user-error "Enter a history query first"))
  (setq noema-history-search--generation
        (cl-incf noema-history-search--request-serial))
  (let ((buffer (current-buffer))
        (generation noema-history-search--generation)
        (root noema-history-search--root)
        (query noema-history-search--query)
        (source noema-history-search--source))
    (my/noema-api-call
     "aaronnote:api:research:history:search"
     (vector `((cwd . ,root) (projectRoot . ,root) (query . ,query)
               (source . ,source) (limit . 100)))
     (lambda (result error-object)
       (when (and (buffer-live-p buffer)
                  (equal generation (buffer-local-value 'noema-history-search--generation buffer))
                  (equal root (buffer-local-value 'noema-history-search--root buffer)))
         (with-current-buffer buffer
           (if error-object
               (message "Noema history search: %s"
                        (noema-history-search--get error-object "message" "unavailable"))
             (noema-history-search--render (noema-history-search--get result "hits"))))))
     30)))

(defun noema-history-search-change-query ()
  "Change the current search query."
  (interactive)
  (setq noema-history-search--query
        (read-string "Search agent history: " noema-history-search--query))
  (noema-history-search-refresh))

(defun noema-history-search-change-source ()
  "Filter native history by source kind, or search all sources."
  (interactive)
  (setq noema-history-search--source
        (completing-read "History source (empty = all): "
                         '("" "codex" "claude" "magent" "agent-shell" "noema" "pi")
                         nil nil nil nil noema-history-search--source))
  (noema-history-search-refresh))

(defun noema-history-search--show (record complete)
  "Display RECORD content in a read-only buffer; COMPLETE labels full reads."
  (let* ((id (noema-history-search--get record "id" ""))
         (buffer (get-buffer-create (format "*Noema History: %s*" id))))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "%s · %s · %s\n%s\n\n"
                        (noema-history-search--get record "source" "")
                        (noema-history-search--get record "role" "")
                        (noema-history-search--get record "timestamp" "")
                        (if complete "Full native fragment" "Preview (press R on the result for full text)")))
        (insert (noema-history-search--get record "content" ""))
        (goto-char (point-min)))
      (special-mode))
    (pop-to-buffer buffer)))

(defun noema-history-search-open (&optional complete)
  "Show the hit at point; with COMPLETE, read its full native fragment."
  (interactive "P")
  (let ((id (tabulated-list-get-id))
        (root noema-history-search--root))
    (unless id (user-error "No history hit on this line"))
    (my/noema-api-call
     (if complete "aaronnote:api:research:history:read"
       "aaronnote:api:research:history:peek")
     (vector `((cwd . ,root) (id . ,id) (maxRunes . 1200)))
     (lambda (result error-object)
       (if error-object
           (message "Noema history: %s"
                    (noema-history-search--get error-object "message" "unavailable"))
         (when-let* ((record (noema-history-search--get result "record")))
           (noema-history-search--show record complete))))
     30)))

(defun noema-history-search-reindex ()
  "Explicitly rebuild this project's read-only native transcript index."
  (interactive)
  (require 'noema-agent-promote)
  (noema-research-history-index noema-history-search--root))

(defvar noema-history-search-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'noema-history-search-open)
    (define-key map (kbd "R") (lambda () (interactive) (noema-history-search-open t)))
    (define-key map (kbd "g") #'noema-history-search-refresh)
    (define-key map (kbd "s") #'noema-history-search-change-query)
    (define-key map (kbd "f") #'noema-history-search-change-source)
    (define-key map (kbd "i") #'noema-history-search-reindex)
    map))

(define-derived-mode noema-history-search-mode tabulated-list-mode "Noema-History"
  "Search project-scoped native agent history."
  (setq tabulated-list-format [ ("Source" 14 t) ("Role" 12 t) ("When" 17 t)
                                ("Excerpt" 70 nil) ])
  (setq tabulated-list-padding 2)
  (tabulated-list-init-header))

;;;###autoload
(defun noema-history-search (&optional directory query)
  "Search native agent history for Noema project DIRECTORY with QUERY."
  (interactive (list nil (read-string "Search agent history: ")))
  (let* ((root (or (noema-current-project (or directory default-directory))
                   (user-error "No Noema project here")))
         (buffer (get-buffer-create (format "*Noema History: %s <%s>*"
                                            (file-name-nondirectory (directory-file-name root))
                                            (substring (secure-hash 'sha256 root) 0 8)))))
    (with-current-buffer buffer
      (noema-history-search-mode)
      (setq noema-history-search--root root
            noema-history-search--query (or query noema-history-search--query)
            default-directory root))
    (pop-to-buffer buffer)
    (if (fboundp 'my/noema--ensure-server)
        (my/noema--ensure-server
         (lambda () (when (buffer-live-p buffer)
                      (with-current-buffer buffer (noema-history-search-refresh)))))
      (with-current-buffer buffer (noema-history-search-refresh)))
    buffer))

(provide 'noema-history-search)
;;; noema-history-search.el ends here
