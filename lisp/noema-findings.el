;;; noema-findings.el --- Evidence-backed research claims -*- lexical-binding: t; -*-

;;; Commentary:
;; Read-only Emacs projection of durable Findings.  Claims and verification
;; levels come from the kernel; this UI does not infer truth from a Run reply.

;;; Code:

(require 'cl-lib)
(require 'subr-x)
(require 'tabulated-list)
(require 'noema-api)

(declare-function my/noema-api-call "init-aaronnote" (channel args callback &optional timeout))
(declare-function my/noema--ensure-server "init-aaronnote" (&optional callback))

(defvar-local noema-findings--root nil)
(defvar-local noema-findings--query "")
(defvar-local noema-findings--records nil)
(defvar-local noema-findings--generation 0)
(defvar noema-findings--request-serial 0
  "Monotonic list id across buffer mode resets and projects.")

(defun noema-findings--get (record key &optional fallback)
  "Read KEY in RECORD, or FALLBACK."
  (or (noema--value record key) fallback))

(defun noema-findings--row (finding)
  "Return a tabulated row for FINDING."
  (list (noema-findings--get finding "id")
        (vector (noema-findings--get finding "kind" "")
                (noema-findings--get finding "status" "")
                (noema-findings--get finding "verificationLevel" "")
                (number-to-string (length (noema--sequence
                                           (noema-findings--get finding "evidence"))))
                (noema-findings--get finding "statement" ""))))

(defun noema-findings--render (records)
  "Render RECORDS without editing the source of truth."
  (setq noema-findings--records (noema--sequence records)
        tabulated-list-entries (mapcar #'noema-findings--row noema-findings--records)
        header-line-format (format "Findings · %s · %d claims%s"
                                   noema-findings--root (length noema-findings--records)
                                   (if (string-empty-p noema-findings--query) ""
                                     (concat " · " noema-findings--query))))
  (tabulated-list-print t))

(defun noema-findings-refresh ()
  "Reload accepted Findings from this project."
  (interactive)
  (unless noema-findings--root (user-error "No project selected"))
  (setq noema-findings--generation
        (cl-incf noema-findings--request-serial))
  (let ((buffer (current-buffer))
        (generation noema-findings--generation)
        (root noema-findings--root)
        (query noema-findings--query))
    (my/noema-api-call
     "aaronnote:api:research:finding:list"
     (vector `((cwd . ,root) (query . ,query) (includeLocal . t) (limit . 200)))
     (lambda (result error-object)
       (when (and (buffer-live-p buffer)
                  (equal generation (buffer-local-value 'noema-findings--generation buffer))
                  (equal root (buffer-local-value 'noema-findings--root buffer)))
         (with-current-buffer buffer
           (if error-object
               (message "Noema Findings: %s"
                        (noema-findings--get error-object "message" "unavailable"))
             (noema-findings--render (noema-findings--get result "findings"))))))
     30)))

(defun noema-findings-change-query ()
  "Filter the Findings list by statement text."
  (interactive)
  (setq noema-findings--query (read-string "Findings query (empty = all): " noema-findings--query))
  (noema-findings-refresh))

(defun noema-findings--show (finding)
  "Show FINDING with its evidence and provenance metadata."
  (let* ((id (noema-findings--get finding "id" ""))
         (buffer (get-buffer-create (format "*Noema Finding: %s*" id))))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "%s\n\nStatus: %s    Verification: %s\nKind: %s    Workstream: %s\nCreated: %s\nDisclosure: %s\n\n"
                        (noema-findings--get finding "statement" "")
                        (noema-findings--get finding "status" "")
                        (noema-findings--get finding "verificationLevel" "")
                        (noema-findings--get finding "kind" "")
                        (noema-findings--get finding "workstreamId" "")
                        (noema-findings--get finding "createdAt" "")
                        (noema-findings--get finding "disclosure" "")))
        (insert "Evidence spans (content-addressed; relation is part of the claim)\n")
        (dolist (span (noema--sequence (noema-findings--get finding "evidence")))
          (insert (format "  %s · %s · bytes %s–%s · SHA256 %s\n"
                          (noema-findings--get span "relation" "")
                          (noema-findings--get span "artifactId" "")
                          (noema-findings--get span "byteStart" 0)
                          (noema-findings--get span "byteEnd" 0)
                          (noema-findings--get span "blockSha256" ""))))
        (when-let* ((relations (noema--sequence (noema-findings--get finding "relations"))))
          (insert "\nClaim relations\n")
          (dolist (relation relations)
            (insert (format "  %s → %s (%s)\n"
                            (noema-findings--get relation "sourceId" "")
                            (noema-findings--get relation "targetId" "")
                            (noema-findings--get relation "type" "")))))
        (goto-char (point-min)))
      (special-mode))
    (pop-to-buffer buffer)))

(defun noema-findings-open ()
  "Read the Finding at point from the authoritative kernel."
  (interactive)
  (let ((id (tabulated-list-get-id))
        (root noema-findings--root))
    (unless id (user-error "No Finding on this line"))
    (my/noema-api-call
     "aaronnote:api:research:finding:get"
     (vector `((cwd . ,root) (id . ,id)))
     (lambda (result error-object)
       (if error-object
           (message "Noema Finding: %s"
                    (noema-findings--get error-object "message" "unavailable"))
         (when-let* ((finding (noema-findings--get result "finding")))
           (noema-findings--show finding))))
     30)))

(defvar noema-findings-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map tabulated-list-mode-map)
    (define-key map (kbd "RET") #'noema-findings-open)
    (define-key map (kbd "g") #'noema-findings-refresh)
    (define-key map (kbd "s") #'noema-findings-change-query)
    map))

(define-derived-mode noema-findings-mode tabulated-list-mode "Noema-Findings"
  "Browse accepted, evidence-backed research Findings."
  (setq tabulated-list-format [("Kind" 13 t) ("Status" 16 t) ("Verification" 18 t)
                               ("Evidence" 9 t) ("Claim" 70 nil)])
  (setq tabulated-list-padding 2)
  (tabulated-list-init-header))

;;;###autoload
(defun noema-findings (&optional directory)
  "Open accepted research Findings for project DIRECTORY."
  (interactive)
  (let* ((root (or (noema-current-project (or directory default-directory))
                   (user-error "No Noema project here")))
         (buffer (get-buffer-create (format "*Noema Findings: %s <%s>*"
                                            (file-name-nondirectory (directory-file-name root))
                                            (substring (secure-hash 'sha256 root) 0 8)))))
    (with-current-buffer buffer
      (noema-findings-mode)
      (setq noema-findings--root root default-directory root))
    (pop-to-buffer buffer)
    (if (fboundp 'my/noema--ensure-server)
        (my/noema--ensure-server
         (lambda () (when (buffer-live-p buffer)
                      (with-current-buffer buffer (noema-findings-refresh)))))
      (with-current-buffer buffer (noema-findings-refresh)))
    buffer))

(provide 'noema-findings)
;;; noema-findings.el ends here
