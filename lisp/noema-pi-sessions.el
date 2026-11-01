;;; noema-pi-sessions.el --- Pi's own session records and list -*- lexical-binding: t; -*-
(require 'cl-lib)
(require 'json)
(require 'seq)
(require 'subr-x)
(require 'tabulated-list)
(require 'tools/agent/acp)
(require 'tools/agent/sessions)

(defvar noema-pi-agent-directory)
(defvar noema-pi-companion-directory)
(defvar noema-pi-router--emacs-buffer)
(defvar noema-pi-router--buffers)
(defvar-local noema-pi-session-id nil "Independent Pi session record identity.")
(put 'noema-pi-session-id 'permanent-local t)

(defvar-local noema-pi-sessions--refresh-timer nil)
(defvar-local noema-pi-sessions--watching nil)

(defun noema-pi-sessions--cancel-refresh ()
  (when (timerp noema-pi-sessions--refresh-timer)
    (cancel-timer noema-pi-sessions--refresh-timer))
  (setq noema-pi-sessions--refresh-timer nil))

(defun noema-pi-sessions--suspend ()
  (noema-pi-sessions--cancel-refresh)
  (remove-hook '+agent-acp-changed-functions #'noema-pi-sessions--refresh-visible)
  (setq noema-pi-sessions--watching nil))

(defun noema-pi-sessions--view-killed-h ()
  (noema-pi-sessions--suspend)
  (remove-hook 'window-buffer-change-functions #'noema-pi-sessions--visibility-h)
  (remove-hook 'kill-emacs-hook #'noema-pi-sessions--shutdown-view))

(defun noema-pi-sessions--shutdown-view ()
  (when-let* ((view (get-buffer "*Pi Sessions*")))
    (with-current-buffer view (noema-pi-sessions--view-killed-h))))

(defun noema-pi-sessions--visibility-h (&optional _frame)
  "Own the change subscription only while the existing list is visible."
  (when-let* ((view (get-buffer "*Pi Sessions*")))
    (with-current-buffer view
      (if (not (get-buffer-window view 'visible)) (noema-pi-sessions--suspend)
        (unless noema-pi-sessions--watching
          (setq noema-pi-sessions--watching t)
          (add-hook '+agent-acp-changed-functions #'noema-pi-sessions--refresh-visible)
          (noema-pi-sessions--refresh-visible))))))

(defun noema-pi-sessions--refresh-visible (&optional buffer)
  "Update the existing view on Pi facts, without polling or opening a view."
  (when (or (null buffer)
            (and (buffer-live-p buffer)
                 (memq (buffer-local-value '+agent-acp-session-origin buffer) '(pi pi-emacs pi-project))))
    (when-let* ((view (get-buffer "*Pi Sessions*")))
      (with-current-buffer view
        (if (not (get-buffer-window view 'visible)) (noema-pi-sessions--suspend)
          (unless (timerp noema-pi-sessions--refresh-timer)
            (let (timer)
              (setq timer
                    (run-at-time
                     0.15 nil
                     (lambda ()
                       (when (and (buffer-live-p view)
                                  (eq timer (buffer-local-value 'noema-pi-sessions--refresh-timer view)))
			 (with-current-buffer view
                           (setq noema-pi-sessions--refresh-timer nil)
                           (when (and (derived-mode-p 'noema-pi-sessions-mode)
                                      (get-buffer-window view 'visible))
                             (noema-pi-sessions-refresh)))))))
              (setq noema-pi-sessions--refresh-timer timer))))))))

(defvar noema-pi-sessions--cache-file nil)
(defvar noema-pi-sessions--cache-signature nil)
(defvar noema-pi-sessions--cache-store nil)
(defvar noema-pi-sessions--cache-json nil)

(defun noema-pi-sessions--signature (file)
  "Identify FILE's current bytes without a watcher or an atime dependency."
  (when-let* ((attributes (file-attributes file 'integer)))
    (list (file-attribute-modification-time attributes)
          (file-attribute-status-change-time attributes)
          (file-attribute-size attributes)
          (file-attribute-inode-number attributes)
          (file-attribute-device-number attributes))))

(defun noema-pi-sessions--copy (store)
  "Copy owned mutable metadata; never edit the published cache in place."
  (let ((copy (copy-hash-table store)))
    (puthash "active" (copy-hash-table (gethash "active" store)) copy)
    (puthash "sessions" (vconcat (mapcar #'copy-hash-table (gethash "sessions" store))) copy)
    copy))

(defun noema-pi-sessions--file ()
  (expand-file-name "sessions.json" noema-pi-agent-directory))

(defun noema-pi-sessions--empty ()
  (let ((value (make-hash-table :test #'equal)))
    (puthash "schema" "noema.pi-sessions/1" value)
    (puthash "active" (make-hash-table :test #'equal) value)
    (puthash "sessions" [] value)
    value))

(defun noema-pi-sessions--read ()
  "Read owned metadata. A corrupt store must never be silently replaced."
  (let* ((file (noema-pi-sessions--file))
         (signature (noema-pi-sessions--signature file)))
    (if (and (equal file noema-pi-sessions--cache-file)
             (equal signature noema-pi-sessions--cache-signature)
             noema-pi-sessions--cache-store)
        noema-pi-sessions--cache-store
      (let ((value (if (not signature) (noema-pi-sessions--empty)
                     (with-temp-buffer
                       (insert-file-contents file)
                       (json-parse-buffer :object-type 'hash-table :array-type 'array
                                          :null-object nil :false-object :false)))))
        (unless (and (hash-table-p value)
                     (equal (gethash "schema" value) "noema.pi-sessions/1")
                     (hash-table-p (gethash "active" value))
                     (vectorp (gethash "sessions" value)))
          (user-error "Invalid Pi session store: %s" file))
        (setq noema-pi-sessions--cache-file file
              noema-pi-sessions--cache-signature signature
              noema-pi-sessions--cache-json (json-serialize value :null-object nil :false-object :false)
              noema-pi-sessions--cache-store value)))))

(defun noema-pi-sessions--write (value)
  "Atomically write only Pi metadata, never a native transcript."
  (let* ((file (noema-pi-sessions--file))
         (serialized (json-serialize value :null-object nil :false-object :false)) temporary)
    (unless (and (equal file noema-pi-sessions--cache-file)
                 (equal (noema-pi-sessions--signature file) noema-pi-sessions--cache-signature)
                 (equal serialized noema-pi-sessions--cache-json)
                 (file-exists-p file))
      (make-directory (file-name-directory file) t)
      (setq temporary (make-temp-file (concat file ".")))
      (unwind-protect
          (progn
            (let ((coding-system-for-write 'utf-8-unix))
              (write-region (concat serialized "\n")
                            nil temporary nil 'silent))
            (rename-file temporary file t)
            (setq noema-pi-sessions--cache-file file
                  noema-pi-sessions--cache-signature (noema-pi-sessions--signature file)
                  noema-pi-sessions--cache-json serialized
                  noema-pi-sessions--cache-store (noema-pi-sessions--copy value))
            (noema-pi-sessions--refresh-visible))
        (when (file-exists-p temporary) (delete-file temporary))))))

(defun noema-pi-sessions--id (scope native)
  (concat "pi_" (substring (secure-hash 'sha256 (concat scope "\0" native)) 0 24)))

(defun noema-pi-sessions--record (store scope native)
  "Record one observed NATIVE id in SCOPE, retaining earlier conversations."
  (let* ((id (noema-pi-sessions--id scope native))
         (records (append (gethash "sessions" store) nil))
         (record (seq-find (lambda (item) (equal (gethash "id" item) id)) records))
         (now (format-time-string "%FT%TZ" nil t)))
    (unless record
      (setq record (make-hash-table :test #'equal))
      (dolist (entry `(("id" . ,id) ("scope" . ,scope) ("target" . "local")
                       ("role" . ,(if (equal scope "emacs") "emacs" "project"))
                       ("parentScope" . ,(unless (equal scope "emacs") "emacs"))
                       ("nativeSessionId" . ,native) ("createdAt" . ,now)))
        (puthash (car entry) (cdr entry) record))
      (setq records (append records (list record))))
    (puthash "lastSeenAt" now record)
    (puthash "sessions" (vconcat records) store)
    (puthash scope id (gethash "active" store))
    record))

(defun noema-pi-sessions--load ()
  "Import the earlier local identity index once, without changing it."
  (if (file-exists-p (noema-pi-sessions--file)) (noema-pi-sessions--read)
    (let ((store (noema-pi-sessions--empty))
          (legacy (expand-file-name "assistants.json" noema-pi-agent-directory)))
      (when (file-readable-p legacy)
        (let ((index (with-temp-buffer
                       (insert-file-contents legacy)
                       (json-parse-buffer :object-type 'hash-table))))
          (unless (hash-table-p index) (user-error "Invalid legacy Pi identity index"))
          (maphash (lambda (scope native)
                     (when (and (stringp native) (not (string-empty-p native)))
                       (noema-pi-sessions--record store scope native))) index))
        (noema-pi-sessions--write store))
      store)))

(defun noema-pi-sessions--edit ()
  "Begin an edit of the current disk-validated metadata snapshot."
  (noema-pi-sessions--copy (noema-pi-sessions--load)))

(defun noema-pi-sessions-active-native (scope)
  "Return SCOPE's active native conversation, without creating a session."
  (let* ((store (noema-pi-sessions--load))
         (id (gethash scope (gethash "active" store)))
         (record (seq-find (lambda (item) (equal id (gethash "id" item)))
                           (append (gethash "sessions" store) nil))))
    (and record (not (gethash "archivedAt" record))
         (not (equal (gethash "persistence" record) "volatile"))
         (gethash "nativeSessionId" record))))

(defun noema-pi-sessions-observe (scope buffer)
  "Record BUFFER after the controller confirms its provider-owned history."
  (when-let* ((native (+agent-acp-state-value buffer '(:session :id))))
    (let* ((store (noema-pi-sessions--edit))
           (record (noema-pi-sessions--record store scope native)))
      (puthash "persistence" "confirmed" record)
      (with-current-buffer buffer (setq-local noema-pi-session-id (gethash "id" record)))
      (noema-pi-sessions--write store)
      record)))

(defun noema-pi-sessions-note-volatile (scope native)
  "Correct a prior live reference which the provider confirms is not saved."
  (let* ((store (noema-pi-sessions--edit))
         (id (noema-pi-sessions--id scope native))
         (record (seq-find (lambda (item) (equal id (gethash "id" item)))
                           (append (gethash "sessions" store) nil))))
    (when record
      (puthash "persistence" "volatile" record)
      (when (equal id (gethash scope (gethash "active" store)))
        (remhash scope (gethash "active" store)))
      (noema-pi-sessions--write store))))

(defun noema-pi-sessions-records ()
  "Return Pi metadata, without consulting Research or copying history."
  (mapcar #'copy-hash-table (gethash "sessions" (noema-pi-sessions--load))))

(defun noema-pi-sessions-import-native (scope native source)
  "Import an actual NATIVE reference from SOURCE without taking over a scope."
  (unless (and (stringp native) (not (string-empty-p native)))
    (user-error "A real native Pi session reference is required"))
  (let* ((store (noema-pi-sessions--edit))
         (active (gethash scope (gethash "active" store)))
         (record (noema-pi-sessions--record store scope native)))
    (puthash "importedFrom" source record)
    (when active (puthash scope active (gethash "active" store)))
    (noema-pi-sessions--write store)
    record))

(defun noema-pi-sessions--buffer (record)
  (seq-find (lambda (buffer)
              (and (buffer-live-p buffer)
                   (memq (buffer-local-value '+agent-acp-session-origin buffer) '(pi pi-emacs pi-project))
                   (equal (+agent-acp-state-value buffer '(:session :id))
                          (gethash "nativeSessionId" record))))
            (buffer-list)))

(defun noema-pi-sessions--end-current (scope)
  "Use the shared close path before changing SCOPE's active conversation."
  (let ((buffer (if (equal scope "emacs") noema-pi-router--emacs-buffer
                  (gethash scope noema-pi-router--buffers))))
    (when (buffer-live-p buffer)
      (+agent-acp-close buffer)
      (when (buffer-live-p buffer) (user-error "The current Pi session remains open")))))

(defun noema-pi-sessions--open-scope (scope)
  (require 'noema-pi-router)
  (let ((buffer (if (equal scope "emacs") (noema-pi-emacs-ensure)
                  (noema-pi-project-ensure scope))))
    (noema-pi-router--show-or-resume buffer)
    buffer))

(defun noema-pi-sessions-resume (record)
  "Continue RECORD's real native conversation and make it active in its scope."
  (require 'noema-pi-router)
  (when (equal (gethash "persistence" record) "volatile")
    (user-error "This Pi has no saved native history; create a new conversation"))
  (let* ((scope (gethash "scope" record))
         (buffer (noema-pi-sessions--buffer record))
         (current (if (equal scope "emacs") noema-pi-router--emacs-buffer
                    (gethash scope noema-pi-router--buffers))))
    (unless (eq current buffer) (noema-pi-sessions--end-current scope))
    (let* ((store (noema-pi-sessions--edit))
           (id (gethash "id" record))
           (saved (seq-find (lambda (item) (equal id (gethash "id" item)))
                            (append (gethash "sessions" store) nil))))
      (unless saved (user-error "Pi session no longer exists"))
      (puthash scope id (gethash "active" store))
      (remhash "archivedAt" saved)
      (noema-pi-sessions--write store))
    (if buffer
        (progn (noema-pi-router--attach scope buffer)
               (noema-pi-router--show-or-resume buffer))
      (noema-pi-sessions--open-scope scope))))

(defun noema-pi-sessions-new (scope)
  "Start a fresh conversation in SCOPE, retaining the earlier native history."
  (noema-pi-sessions--end-current scope)
  (let ((store (noema-pi-sessions--edit)))
    (remhash scope (gethash "active" store))
    (noema-pi-sessions--write store))
  (noema-pi-sessions--open-scope scope))

(defun noema-pi-sessions-archive (record)
  "Archive RECORD's reference; keep the provider's actual history intact."
  (let* ((id (gethash "id" record))
         (scope (gethash "scope" record)))
    (noema-pi-sessions-find id)
    (when-let* ((buffer (noema-pi-sessions--buffer record)))
      (+agent-acp-close buffer)
      (when (buffer-live-p buffer) (user-error "The selected Pi session remains open")))
    ;; Closing may run callbacks or wait for the person's decision. Read a
    ;; fresh snapshot afterwards rather than overwriting intervening facts.
    (let* ((store (noema-pi-sessions--edit))
           (saved (seq-find (lambda (item) (equal id (gethash "id" item)))
                            (append (gethash "sessions" store) nil))))
      (unless saved (user-error "Pi session no longer exists"))
      (when (equal id (gethash scope (gethash "active" store)))
	(remhash scope (gethash "active" store)))
      (puthash "archivedAt" (format-time-string "%FT%TZ" nil t) saved)
      (noema-pi-sessions--write store))))

(defun noema-pi-sessions-find (id)
  (or (seq-find (lambda (record) (equal id (gethash "id" record))) (noema-pi-sessions-records))
      (user-error "Unknown Pi session: %s" id)))

;;;###autoload
(cl-defun noema-pi-sessions-import-research (directory)
  "Read a former Research Pi's native reference into Pi's own history.
The Research registry and transcript are not modified. Existing active Pi
conversations keep their active pointer."
  (interactive (list (read-directory-name "Former Pi project: " default-directory nil t)))
  (require 'noema-pi-router)
  (let ((root (noema-pi-project-root directory)))
    (when-let* ((native (noema-pi-router--legacy-native-session-id root)))
      (noema-pi-sessions-import-native root native (noema-pi-router--legacy-registry-file root))
      (message "Imported the former Pi reference; its source remains unchanged")
      (cl-return-from noema-pi-sessions-import-research t))
    (+noema--ensure-server
     (lambda ()
       (+noema-api-call
        "noema:api:research:session:name:get" (vector `((cwd . ,root) (name . "pi")))
        (lambda (result error-object)
          (when error-object (user-error "Could not read the former Pi session"))
          (let* ((name (noema-pi-router--value result "name"))
                 (native (noema-pi-router--string name "nativeSessionId"))
                 (scope (or (noema-pi-router--string result "root") root)))
            (unless native (user-error "No former Pi conversation is recorded for this project"))
            (progn
              (noema-pi-sessions-import-native scope native "research-session-name")
              (message "Imported the native Pi reference; Research history is retained")
              (when-let* ((view (get-buffer "*Pi Sessions*")))
                (with-current-buffer view (noema-pi-sessions-refresh)))))) 30)))))

(defun noema-pi-sessions--selected ()
  (or (seq-find (lambda (record) (equal (gethash "id" record) (tabulated-list-get-id)))
                (noema-pi-sessions-records))
      (user-error "Select a Pi conversation")))

(defun noema-pi-sessions-visit ()
  (interactive)
  (let ((id (tabulated-list-get-id)))
    (if (bufferp id) (+agent-acp-show-buffer id)
      (noema-pi-sessions-resume (noema-pi-sessions--selected)))))

(defun noema-pi-sessions-new-at-point ()
  (interactive)
  (noema-pi-sessions-new
   (let ((id (tabulated-list-get-id)))
     (cond ((bufferp id) (buffer-local-value 'noema-pi-router--scope id))
           (id (gethash "scope" (noema-pi-sessions--selected)))
           (t "emacs")))))

(defun noema-pi-sessions-archive-at-point ()
  (interactive)
  (noema-pi-sessions-archive (noema-pi-sessions--selected))
  (noema-pi-sessions-refresh))

(defun noema-pi-sessions--state (buffer)
  (if (not (buffer-live-p buffer)) "stopped"
    (let ((snapshot (+agent-session-snapshot buffer)))
      (cond ((memq (plist-get snapshot :process-state) '(dead disconnected)) "disconnected")
            ((plist-get snapshot :last-error) "failed")
            ((not (+agent-acp-state-value buffer '(:init-finished))) "starting")
            ((+agent-acp-busy-p buffer) "busy")
            (t "ready")))))

(defun noema-pi-sessions-refresh ()
  "Refresh from one metadata read and a single pass over live Pi buffers."
  (interactive)
  (noema-pi-sessions--cancel-refresh)
  (let* ((records (noema-pi-sessions-records))
         (buffers (seq-filter
                   (lambda (buffer)
                     (memq (buffer-local-value '+agent-acp-session-origin buffer) '(pi pi-emacs pi-project)))
                   (buffer-list)))
         (by-native (make-hash-table :test #'equal))
         (listed (make-hash-table :test #'eq)))
    (dolist (buffer buffers)
      (when-let* ((id (or (+agent-acp-state-value buffer '(:session :id))
                         (+agent-acp-state-value buffer '(:resume-session-id)))))
        (puthash id buffer by-native)))
    (setq tabulated-list-entries
          (mapcar (lambda (record)
                    (let* ((scope (gethash "scope" record))
                           (native (gethash "nativeSessionId" record))
                           (buffer (gethash native by-native)))
                      (when buffer (puthash buffer t listed))
                      (list (gethash "id" record)
                            (vector (gethash "role" record)
                                    (if (equal scope "emacs") "Emacs" (abbreviate-file-name scope))
                                    (cond ((gethash "archivedAt" record) "archived")
                                          ((equal (gethash "persistence" record) "volatile") "not saved")
                                          (t (noema-pi-sessions--state buffer)))
                                    (substring native 0 (min 16 (length native)))
                                    (gethash "lastSeenAt" record))))) records))
    ;; Empty live conversations remain visible, without inventing durable history.
    (dolist (buffer buffers)
      (unless (gethash buffer listed)
        (push (list buffer
                    (vector (if (eq (buffer-local-value '+agent-acp-session-origin buffer) 'pi-emacs) "emacs" "project")
                            (or (buffer-local-value '+agent-acp-session-root buffer) "")
                            (noema-pi-sessions--state buffer)
                            (or (+agent-acp-state-value buffer '(:session :id)) "pending") "")) tabulated-list-entries))))
  (tabulated-list-print t))

(define-derived-mode noema-pi-sessions-mode tabulated-list-mode "Pi Sessions"
  "Pi conversations: RET resume, n new, a archive, i import, g refresh."
  (setq tabulated-list-format [("Role" 9 t) ("Scope" 40 t) ("State" 10 t)
                               ("Native session" 18 t) ("Last seen" 22 t)]
        tabulated-list-padding 2 tabulated-list-sort-key '("Last seen" . t))
  (add-hook 'kill-buffer-hook #'noema-pi-sessions--view-killed-h nil t)
  (add-hook 'change-major-mode-hook #'noema-pi-sessions--view-killed-h nil t)
  (add-hook 'window-buffer-change-functions #'noema-pi-sessions--visibility-h)
  (add-hook 'kill-emacs-hook #'noema-pi-sessions--shutdown-view)
  (tabulated-list-init-header))
(define-key noema-pi-sessions-mode-map (kbd "RET") #'noema-pi-sessions-visit)
(define-key noema-pi-sessions-mode-map (kbd "n") #'noema-pi-sessions-new-at-point)
(define-key noema-pi-sessions-mode-map (kbd "g") #'noema-pi-sessions-refresh)
(define-key noema-pi-sessions-mode-map (kbd "a") #'noema-pi-sessions-archive-at-point)
(define-key noema-pi-sessions-mode-map (kbd "i") #'noema-pi-sessions-import-research)

;;;###autoload
(defun noema-pi-sessions ()
  "Open Pi's independent conversation list without starting a model turn."
  (interactive)
  (require 'noema-pi-router)
  (with-current-buffer (get-buffer-create "*Pi Sessions*")
    (unless (derived-mode-p 'noema-pi-sessions-mode) (noema-pi-sessions-mode))
    (pop-to-buffer (current-buffer))
    (noema-pi-sessions--visibility-h)
    (noema-pi-sessions-refresh)))

(provide 'noema-pi-sessions)
