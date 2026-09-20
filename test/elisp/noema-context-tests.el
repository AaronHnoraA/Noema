;;; noema-context-tests.el --- Tests for referenced editor context -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; These cover the two promises of `noema-context': a selection becomes a
;; reference with the right line range, and what is sent never contains the
;; text itself.  Nothing here starts an agent or reaches the Noema host.

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-context)
(require 'gptel-context)

(defvar noema-context-tests--body
  "alpha\nbravo\ncharlie\ndelta\necho\n"
  "Five distinct lines, so a wrong line range is visible in the failure.")

(defmacro noema-context-tests--with-project (spec &rest body)
  "Run BODY with a temporary project bound to `root'.
SPEC is a list of (NAME . CONTENT) files created in it and bound to
`files' as an alist of NAME to absolute path."
  (declare (indent 1) (debug t))
  `(let* ((root (file-name-as-directory (make-temp-file "noema-context-" t)))
          (gptel-context nil)
          (gptel-context-restrict-to-project-files nil)
          (noema-context-save-before-send nil)
          (files (mapcar (lambda (entry)
                           (let ((path (expand-file-name (car entry) root)))
                             (with-temp-file path (insert (cdr entry)))
                             (cons (car entry) path)))
                         ,spec))
          (opened '()))
     (ignore files opened)
     (unwind-protect (progn ,@body)
       (dolist (buffer opened)
         (when (buffer-live-p buffer)
           (with-current-buffer buffer (set-buffer-modified-p nil))
           (kill-buffer buffer)))
       (delete-directory root t))))

(defun noema-context-tests--line-pos (buffer line)
  "Return the beginning of LINE in BUFFER."
  (with-current-buffer buffer
    (save-excursion
      (goto-char (point-min))
      (forward-line (1- line))
      (point))))


;;;; ── References ───────────────────────────────────────────────────────────

(ert-deftest noema-context-region-becomes-a-line-range ()
  "A selected region is referenced as `path:START-END', not copied."
  (noema-context-tests--with-project '(("a.txt" . "alpha\nbravo\ncharlie\ndelta\necho\n"))
    (let ((buffer (find-file-noselect (alist-get "a.txt" files nil nil #'equal))))
      (push buffer opened)
      (gptel-context--add-region buffer
                                 (noema-context-tests--line-pos buffer 2)
                                 (1- (noema-context-tests--line-pos buffer 4)))
      (let ((references (noema-context-references nil root)))
        (should (= (length references) 1))
        (should (eq (plist-get (car references) :kind) 'region))
        (should (equal (plist-get (car references) :relative) "a.txt"))
        (should (= (plist-get (car references) :line-start) 2))
        (should (= (plist-get (car references) :line-end) 3))
        (should (equal (noema-context--reference-line (car references)) "a.txt:2-3"))))))

(ert-deftest noema-context-region-ending-at-bol-excludes-that-line ()
  "A region stopping at the start of line 4 covers lines 2 and 3 only."
  (noema-context-tests--with-project '(("a.txt" . "alpha\nbravo\ncharlie\ndelta\necho\n"))
    (let ((buffer (find-file-noselect (alist-get "a.txt" files nil nil #'equal))))
      (push buffer opened)
      (gptel-context--add-region buffer
                                 (noema-context-tests--line-pos buffer 2)
                                 (noema-context-tests--line-pos buffer 4))
      (let ((reference (car (noema-context-references nil root))))
        (should (= (plist-get reference :line-start) 2))
        (should (= (plist-get reference :line-end) 3))))))

(ert-deftest noema-context-whole-buffer-is-a-plain-file-reference ()
  "Selecting a whole buffer references the file, not lines 1 to N."
  (noema-context-tests--with-project '(("a.txt" . "alpha\nbravo\ncharlie\ndelta\necho\n"))
    (let ((buffer (find-file-noselect (alist-get "a.txt" files nil nil #'equal))))
      (push buffer opened)
      (gptel-context--add-buffer buffer)
      (let ((reference (car (noema-context-references nil root))))
        (should (eq (plist-get reference :kind) 'file))
        (should-not (plist-get reference :line-start))
        (should (equal (noema-context--reference-line reference) "a.txt"))))))

(ert-deftest noema-context-file-outside-the-session-root-stays-absolute ()
  "A reference is relative only inside the session root, as agent-shell does."
  (noema-context-tests--with-project '(("a.txt" . "alpha\n"))
    (let* ((path (alist-get "a.txt" files nil nil #'equal))
           (gptel-context (list (list path)))
           (outside (noema-context-references nil "/definitely/not/here/"))
           (inside (noema-context-references nil root)))
      (should (equal (plist-get (car outside) :relative) path))
      (should (equal (plist-get (car inside) :relative) "a.txt")))))

(ert-deftest noema-context-skips-what-cannot-be-referenced ()
  "A buffer with no file, and one left unsaved, are reported, never copied."
  (noema-context-tests--with-project '(("a.txt" . "alpha\nbravo\n"))
    (let ((scratch (generate-new-buffer " *noema-context-scratch*"))
          (visiting (find-file-noselect (alist-get "a.txt" files nil nil #'equal))))
      (push scratch opened)
      (push visiting opened)
      (with-current-buffer scratch (insert "not on disk\n"))
      (with-current-buffer visiting
        (goto-char (point-max))
        (insert "unsaved edit\n"))
      (gptel-context--add-buffer scratch)
      (gptel-context--add-buffer visiting)
      (let ((resolved (noema-context--resolve nil root)))
        (should (null (car resolved)))
        (should (= (length (cdr resolved)) 2))
        (should (seq-some (lambda (note) (string-match-p "not visiting a file" note))
                          (cdr resolved)))
        (should (seq-some (lambda (note) (string-match-p "unsaved changes" note))
                          (cdr resolved)))))))


;;;; ── Content blocks ───────────────────────────────────────────────────────

(ert-deftest noema-context-blocks-link-instead-of-copying ()
  "Two regions of one file and a second file produce links and no content."
  (noema-context-tests--with-project '(("a.txt" . "alpha\nbravo\ncharlie\ndelta\necho\n")
                                       ("b.txt" . "secret-marker\n"))
    (let ((buffer (find-file-noselect (alist-get "a.txt" files nil nil #'equal))))
      (push buffer opened)
      (gptel-context--add-region buffer
                                 (noema-context-tests--line-pos buffer 1)
                                 (1- (noema-context-tests--line-pos buffer 2)))
      (gptel-context--add-region buffer
                                 (noema-context-tests--line-pos buffer 4)
                                 (1- (noema-context-tests--line-pos buffer 5)))
      (setq gptel-context
            (append gptel-context (list (list (alist-get "b.txt" files nil nil #'equal)))))
      (let* ((references (noema-context-references nil root))
             (blocks (noema-context-content-blocks "Why does this differ?" references))
             (types (mapcar (lambda (block) (map-elt block 'type)) blocks))
             (printed (format "%S" blocks)))
        ;; One text block, then exactly one link per distinct file.
        (should (equal types '("text" "resource_link" "resource_link")))
        (should-not (member "resource" types))
        ;; Nothing was read, so no file content can be in the request.
        (should-not (string-match-p "secret-marker" printed))
        (should-not (string-match-p "charlie" printed))
        (let ((text (map-elt (car blocks) 'text)))
          (should (string-match-p "Why does this differ?" text))
          (should (string-match-p "^- a\\.txt:1-1$" text))
          (should (string-match-p "^- a\\.txt:4-4$" text))
          (should (string-match-p "^- b\\.txt$" text)))
        (dolist (link (cdr blocks))
          (should (string-prefix-p "file:///" (map-elt link 'uri)))
          (should (member (map-elt link 'name) '("a.txt" "b.txt")))
          (should (integerp (map-elt link 'size))))))))

(ert-deftest noema-context-blocks-without-references-are-just-the-prompt ()
  "With nothing selected the turn is the question alone."
  (let ((blocks (noema-context-content-blocks "Plain question" nil)))
    (should (= (length blocks) 1))
    (should (equal (map-elt (car blocks) 'type) "text"))
    (should (equal (map-elt (car blocks) 'text) "Plain question"))))


;;;; ── Session registration ─────────────────────────────────────────────────

(ert-deftest noema-agent-acp-project-root-never-creates-a-project ()
  "Root resolution is a query: a plain directory stays a plain directory."
  (let* ((root (file-name-as-directory (make-temp-file "noema-plain-" t))))
    (unwind-protect
        (progn
          (should (equal (noema-agent-acp-project-root root)
                         (noema-agent-acp--workspace-root root)))
          (should-not (file-exists-p (expand-file-name "noema.toml" root)))
          (with-temp-file (expand-file-name "noema.toml" root) (insert "\n"))
          (let ((nested (expand-file-name "deep/deeper/" root)))
            (make-directory nested t)
            (should (equal (noema-agent-acp-project-root nested)
                           (noema-agent-acp--workspace-root root)))))
      (delete-directory root t))))

(ert-deftest noema-agent-acp-generated-names-are-unique-and-spare-pi ()
  "Generated local names never collide and never claim the coordinator name."
  (let ((root "/tmp/noema-name-test/"))
    (cl-letf (((symbol-function 'noema-agent-acp--claimed-names)
               (lambda (_root) '("popup/claude" "popup/claude-2"))))
      (should (equal (noema-agent-acp--unique-name "popup/claude" root)
                     "popup/claude-3"))
      (should (equal (noema-agent-acp--unique-name "popup/codex" root)
                     "popup/codex"))
      (should (equal (noema-agent-acp--unique-name "pi" root) "pi-2")))))

(ert-deftest noema-agent-acp-adopt-registers-without-touching-the-host ()
  "Adopting in a plain directory names the session and asks the host nothing."
  (let* ((root (file-name-as-directory (make-temp-file "noema-adopt-" t)))
         (buffer (generate-new-buffer " *noema-adopt-test*"))
         (called nil))
    (unwind-protect
        (cl-letf (((symbol-function 'noema-agent-acp-agent-buffer-p)
                   (lambda (candidate) (buffer-live-p candidate)))
                  ((symbol-function 'my/noema-api-call)
                   (lambda (&rest _) (setq called t))))
          (with-current-buffer buffer (setq-local default-directory root))
          (noema-agent-acp-adopt buffer :agent 'claude :origin 'popup)
          (should (equal (buffer-local-value 'noema-agent-acp-session-name buffer)
                         "popup/claude"))
          (should (equal (buffer-local-value 'noema-agent-acp-session-agent buffer)
                         "claude"))
          (should (eq (buffer-local-value 'noema-agent-acp-session-origin buffer) 'popup))
          (should (equal (buffer-local-value 'noema-agent-acp-session-root buffer)
                         (noema-agent-acp--workspace-root root)))
          ;; No durable registry exists here, so nothing was promoted or bound
          ;; and no project was created behind the person's back.
          (should-not called)
          (should-not (file-exists-p (expand-file-name "noema.toml" root)))
          ;; The merged view lists it like any Run's session.
          (let ((session (car (noema-agent-acp-sessions root))))
            (should (eq (plist-get session :buffer) buffer))
            (should (equal (plist-get session :name) "popup/claude"))
            (should (eq (plist-get session :origin) 'popup))))
      (kill-buffer buffer)
      (delete-directory root t))))

(provide 'noema-context-tests)
;;; noema-context-tests.el ends here
