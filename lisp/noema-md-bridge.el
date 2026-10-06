;;; noema-md-bridge.el --- Emacs tools on a Noema Markdown pane's text -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; A Noema Markdown pane is an inert xwidget placeholder: the live document,
;; selection and history belong to the CM6 renderer.  Emacs commands that work
;; on "the region" or "this buffer" -- gptel context, gptel rewrite with its
;; diff review, agent references, the compose buffer -- therefore cannot run in
;; the pane itself.  This module is the one bridge between them:
;;
;;   Emacs command in a pane
;;     -> `noema-md-bridge-request' asks the page (notification, no wait)
;;     -> the page saves, then reports FILE and the exact range
;;     -> `noema-md-bridge-handle-selection' runs the action on the file's
;;        ordinary Emacs buffer, at that range.
;;
;; Edits made in that buffer (an accepted rewrite, a manual fix) are saved on
;; idle like the page's own autosave, and every Noema pane showing the file
;; reloads when it has no unsaved text of its own.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)

(defvar my/noema-buffer-file-name)
(defvar gptel-context)
(defvar noema-md-bridge-source-mode)
(defvar my/programmatic-file-visit)
(defvar my/noema--inhibit-redirect)

(declare-function my/noema--xwidget-buffer-p "noema-xwidget-keys" (&optional buffer))
(declare-function my/noema--jupyter-xwidget-buffer-p "noema-xwidget-keys" (&optional buffer))
(declare-function my/noema--buffer-for-client "init-aaronnote" (client))
(declare-function my/noema--host-file "init-aaronnote" (file))
(declare-function my/noema--select-emacs-window "noema-xwidget-keys" (&optional window))
(declare-function my/noema--release-xwidget-input-buffer "noema-xwidget-keys" (&optional buffer))
(declare-function my/noema--focus-minibuffer-if-active "noema-xwidget-keys" ())
(declare-function my/noema-command "init-aaronnote" (command &optional detail))
(declare-function my/noema-open-file "init-aaronnote" (file))
(declare-function gptel-context--add-region "gptel-context"
                  (buffer region-beginning region-end &optional advance))
(declare-function gptel-rewrite "gptel-rewrite" ())
(declare-function noema-compose "noema-compose" (&optional name))
(declare-function noema-context--send "noema-context" (&rest arguments))
(declare-function noema-context--region-references "noema-context" (buffer begin end))
(defvar noema-context-related-prompt)

(defgroup noema-md-bridge nil
  "Running Emacs tools on the text of a Noema Markdown pane."
  :group 'noema-context)

(defcustom noema-md-bridge-autosave-delay 1.0
  "Idle seconds before a bridged source buffer saves its edits.
Saving is what lets the Noema pane show an accepted rewrite; nil disables it
and leaves saving to you."
  :type '(choice (number :tag "Seconds") (const :tag "Never" nil))
  :group 'noema-md-bridge)

(defconst noema-md-bridge-actions '("agent" "related" "context" "rewrite" "compose" "source")
  "Actions a pane may report a range for.")

(defconst noema-md-bridge-scopes '("selection" "line" "any" "document")
  "Ranges a pane may be asked for.
selection  the selection only; an empty one is refused by the page
line       the selection, else the cursor's line
any        the selection, else the whole note
document   the whole note")


;;;; ── Asking the pane ──────────────────────────────────────────────────────

(defun noema-md-bridge-pane-p (&optional buffer)
  "Return non-nil when BUFFER (default current) is a Noema Markdown pane."
  (let ((buffer (or buffer (current-buffer))))
    (and (fboundp 'my/noema--xwidget-buffer-p)
         (my/noema--xwidget-buffer-p buffer)
         (not (and (fboundp 'my/noema--jupyter-xwidget-buffer-p)
                   (my/noema--jupyter-xwidget-buffer-p buffer))))))

(defcustom noema-md-bridge-answer-timeout 4
  "Seconds to wait for a Noema page to answer a selection request.
When it does not, Emacs says so instead of leaving the command silent."
  :type 'number
  :group 'noema-md-bridge)

(defvar noema-md-bridge--pending (make-hash-table :test #'equal)
  "Request id -> timeout timer for page selection requests still unanswered.")

(defvar noema-md-bridge--request-counter 0
  "Counter making selection request ids unique within this Emacs.")

(defun noema-md-bridge--timeout (id action)
  "Report that the page never answered request ID for ACTION."
  (when (gethash id noema-md-bridge--pending)
    (remhash id noema-md-bridge--pending)
    (message "Noema: the page did not answer the %s request.  Reload the page \
(H-o r), or rebuild it (H-o B) if Noema was just updated" action)))

(defun noema-md-bridge--settle (id)
  "Forget request ID; return non-nil when it was still pending.
An answer without an id comes from a web host older than request ids; it
settles every pending request, since only one is normally outstanding."
  (if (and (stringp id) (not (string-empty-p id)))
      (when-let* ((timer (gethash id noema-md-bridge--pending)))
        (cancel-timer timer)
        (remhash id noema-md-bridge--pending)
        t)
    (let (settled)
      (maphash (lambda (_ timer) (cancel-timer timer) (setq settled t))
               noema-md-bridge--pending)
      (clrhash noema-md-bridge--pending)
      settled)))

(defun noema-md-bridge-request (action scope)
  "Ask the current Noema pane to save and report SCOPE for ACTION.
This only queues a notification; the answer arrives as a host event and is
handled by `noema-md-bridge-handle-selection'.  The page always answers, with
a range or with the reason it cannot; no answer within
`noema-md-bridge-answer-timeout' seconds is reported too.

The whole note needs no answer: SCOPE \"document\" asks the page to save and
runs ACTION on the pane's file at once."
  (unless (member action noema-md-bridge-actions)
    (error "Unknown Noema bridge action: %s" action))
  (unless (member scope noema-md-bridge-scopes)
    (error "Unknown Noema bridge scope: %s" scope))
  (unless (fboundp 'my/noema-command)
    (user-error "Noema browser command bridge is unavailable"))
  (if (equal scope "document")
      (let ((file (or my/noema-buffer-file-name
                      (user-error "This Noema pane shows no file"))))
        (my/noema-command "save")
        (let ((buffer (noema-md-bridge-source-buffer file)))
          (noema-md-bridge-run action buffer
                               (with-current-buffer buffer (point-min))
                               (with-current-buffer buffer (point-max)))))
    (let ((id (format "emacs-%d-%d" (emacs-pid)
                      (cl-incf noema-md-bridge--request-counter))))
      (puthash id (run-at-time noema-md-bridge-answer-timeout nil
                               #'noema-md-bridge--timeout id action)
               noema-md-bridge--pending)
      (message "Noema: asking the page for its %s…"
               (if (equal scope "line") "selection or cursor line" "selection"))
      (my/noema-command "emacs-selection"
                        `((action . ,action) (scope . ,scope) (requestId . ,id))))))

(defmacro noema-md-bridge-define-pane-command (name action scope doc)
  "Define command NAME asking the current pane for SCOPE and running ACTION.
DOC is its documentation."
  (declare (indent 3) (doc-string 4))
  `(defun ,name ()
     ,doc
     (interactive)
     (unless (noema-md-bridge-pane-p)
       (user-error "Not in a Noema Markdown pane"))
     (noema-md-bridge-request ,action ,scope)))

;;;###autoload (autoload 'noema-md-bridge-edit-source "noema-md-bridge" nil t)
(noema-md-bridge-define-pane-command noema-md-bridge-edit-source "source" "line"
  "Show the pane's note in its Emacs source buffer, at the selection.")

;;;###autoload (autoload 'noema-md-bridge-rewrite "noema-md-bridge" nil t)
(noema-md-bridge-define-pane-command noema-md-bridge-rewrite "rewrite" "line"
  "Rewrite the pane's selection (else its cursor line) with gptel.")

;;;###autoload (autoload 'noema-md-bridge-add-context "noema-md-bridge" nil t)
(noema-md-bridge-define-pane-command noema-md-bridge-add-context "context" "any"
  "Add the pane's selection (else its whole note) to the shared AI context.")

;;;###autoload (autoload 'noema-md-bridge-compose "noema-md-bridge" nil t)
(noema-md-bridge-define-pane-command noema-md-bridge-compose "compose" "any"
  "Open a gptel compose buffer with the pane's selection (else note) as context.")


;;;; ── The source buffer and its range ──────────────────────────────────────

(defun noema-md-bridge--same-file-p (a b)
  "Return non-nil when files A and B name the same note."
  (let ((canonical (lambda (file)
                     (if (fboundp 'my/noema--host-file)
                         (or (ignore-errors (my/noema--host-file file))
                             (expand-file-name file))
                       (expand-file-name file)))))
    (and (stringp a) (stringp b)
         (equal (funcall canonical a) (funcall canonical b)))))

(defun noema-md-bridge--visit (file)
  "Visit Markdown FILE as an ordinary Emacs buffer, never as a Noema page.
Called from an interactive command, a plain `find-file-noselect' would hand the
file to Noema (the Markdown redirect) and return a blank placeholder, so the
visit is marked programmatic.  A leftover redirect placeholder is replaced."
  (let ((my/programmatic-file-visit t)
        (my/noema--inhibit-redirect t))
    (when-let* ((existing (find-buffer-visiting file)))
      (when (and (with-current-buffer existing
                   (bound-and-true-p my/noema--markdown-redirected))
                 (not (buffer-modified-p existing)))
        (kill-buffer existing)))
    (let ((existing (find-buffer-visiting file))
          (buffer (find-file-noselect file)))
      (unless existing (noema-md-bridge--hide buffer))
      buffer)))

;;;; Hidden source buffers
;;
;; A note the bridge opened only to read is not a buffer the person opened.
;; Left as an ordinary buffer it would capture the next open of the note --
;; Emacs reuses a buffer already visiting a file, so the Markdown→Noema
;; redirect never runs and the note appears as raw Markdown.  Such a buffer is
;; hidden (a leading-space name), dropped after an agent send, and, when
;; something displays it later, hands that open to Noema.

(defvar-local noema-md-bridge--hidden nil
  "Non-nil in a note buffer the bridge opened only to read.")

(defun noema-md-bridge--hide (buffer)
  "Mark BUFFER as a hidden read-only-use copy of its note."
  (with-current-buffer buffer
    (setq noema-md-bridge--hidden t)
    (unless (string-prefix-p " " (buffer-name))
      (rename-buffer (concat " " (buffer-name)) t))
    (add-hook 'window-buffer-change-functions
              #'noema-md-bridge--surface-hidden nil t)))

;;;###autoload
(defun noema-md-bridge-claim (&optional buffer)
  "Make BUFFER (default current) an ordinary buffer the person uses."
  (with-current-buffer (or buffer (current-buffer))
    (when noema-md-bridge--hidden
      (setq noema-md-bridge--hidden nil)
      (remove-hook 'window-buffer-change-functions
                   #'noema-md-bridge--surface-hidden t)
      (when (and buffer-file-name (string-prefix-p " " (buffer-name)))
        (rename-buffer (file-name-nondirectory buffer-file-name) t)))))

(defun noema-md-bridge--surface-hidden (window)
  "Hand an open of a hidden note shown in WINDOW back to Noema."
  (let ((buffer (and (window-live-p window) (window-buffer window))))
    (when (and buffer
               (buffer-local-value 'noema-md-bridge--hidden buffer)
               (not (buffer-local-value 'noema-md-bridge-source-mode buffer)))
      (let ((file (buffer-local-value 'buffer-file-name buffer)))
        (switch-to-prev-buffer window t)
        (when (and file (fboundp 'my/noema-open-file))
          (run-at-time 0 nil #'my/noema-open-file file))))))

(defun noema-md-bridge--drop-hidden (buffer)
  "Kill hidden BUFFER when nothing uses it any more."
  (when (and (buffer-live-p buffer)
             (buffer-local-value 'noema-md-bridge--hidden buffer)
             (not (buffer-modified-p buffer))
             (not (get-buffer-window buffer t)))
    (kill-buffer buffer)))

(defun noema-md-bridge-source-buffer (file)
  "Return FILE's Emacs buffer holding exactly the text on disk.
The page saved before reporting, so disk is authoritative.  A buffer with
unsaved Emacs edits is refused rather than overwritten."
  (unless (and (stringp file) (file-readable-p file))
    (user-error "Noema note is not a readable file: %s" file))
  (let ((buffer (noema-md-bridge--visit file)))
    (with-current-buffer buffer
      (when (buffer-modified-p)
        (user-error "Save or revert the Emacs edits in %s first" (buffer-name)))
      (unless (verify-visited-file-modtime buffer)
        (revert-buffer t t t)))
    buffer))

(defun noema-md-bridge--position (line column)
  "Return the position of 1-based LINE and character COLUMN, clamped."
  (save-excursion
    (goto-char (point-min))
    (if (> (forward-line (1- line)) 0)
        (point-max)
      (min (+ (point) column) (line-end-position)))))

(defun noema-md-bridge-region (file range)
  "Return (BUFFER BEGIN . END) for RANGE of FILE.
RANGE is the page's report: exact :from-line/:from-column/:to-line/:to-column
when present, else whole lines :line-start through :line-end."
  (let ((buffer (noema-md-bridge-source-buffer file)))
    (with-current-buffer buffer
      (save-restriction
        (widen)
        (let ((from-line (plist-get range :from-line))
              (line-start (plist-get range :line-start))
              (line-end (plist-get range :line-end)))
          (if (integerp from-line)
              (cons buffer
                    (cons (noema-md-bridge--position
                           from-line (or (plist-get range :from-column) 0))
                          (noema-md-bridge--position
                           (plist-get range :to-line)
                           (or (plist-get range :to-column) 0))))
            (unless (and (integerp line-start) (integerp line-end)
                         (<= 1 line-start line-end))
              (user-error "Noema selection is not a line range"))
            (when (> line-end (line-number-at-pos (point-max) t))
              (user-error "Noema selection is newer than the file on disk"))
            (let ((begin (noema-md-bridge--position line-start 0)))
              (cons buffer
                    (cons begin
                          (save-excursion
                            (goto-char (noema-md-bridge--position line-end 0))
                            (min (point-max) (1+ (line-end-position)))))))))))))

(defun noema-md-bridge--show-region (buffer begin end)
  "Show BUFFER beside the Noema pane with BEGIN..END as the active region.
The pane keeps its window; focus moves to Emacs so the region can be used."
  (let ((window (display-buffer
                 buffer
                 '((display-buffer-reuse-window
                    display-buffer-use-some-window
                    display-buffer-pop-up-window)
                   (inhibit-same-window . t)))))
    (when (window-live-p window)
      (if (fboundp 'my/noema--select-emacs-window)
          (my/noema--select-emacs-window window)
        (select-window window)))
    (with-current-buffer buffer
      ;; Shown on purpose: it is the person's buffer from now on.
      (noema-md-bridge-claim)
      (noema-md-bridge-source-mode 1)
      (goto-char begin)
      (push-mark end t t)
      (exchange-point-and-mark)
      (when (window-live-p window)
        (set-window-point window (point))))
    window))


;;;; ── Actions ──────────────────────────────────────────────────────────────

(defun noema-md-bridge--add-context (buffer begin end)
  "Add BEGIN..END of BUFFER to the shared gptel context."
  (require 'gptel-context)
  (gptel-context--add-region buffer begin end t)
  (message "Noema: added %s to AI context (%d item%s)"
           (with-current-buffer buffer
             (format "%s:%d-%d" (file-name-nondirectory buffer-file-name)
                     (line-number-at-pos begin t)
                     (line-number-at-pos (max begin (1- end)) t)))
           (length gptel-context)
           (if (= (length gptel-context) 1) "" "s")))

(defun noema-md-bridge-run (action buffer begin end)
  "Run ACTION on BEGIN..END of note BUFFER."
  (pcase action
    ("agent"
     (require 'noema-context)
     (let ((session (with-current-buffer buffer
                      (noema-context--send
                       :references (noema-context--region-references
                                    buffer begin end)))))
       ;; Asked from a Noema page: continue in the session, not the page.
       (when-let* ((window (and (buffer-live-p session)
                                (get-buffer-window session 'visible))))
         (if (fboundp 'my/noema--select-emacs-window)
             (my/noema--select-emacs-window window)
           (select-window window))
         (with-current-buffer session (goto-char (point-max))))
       ;; References name the file; the agent needs no Emacs buffer.
       (noema-md-bridge--drop-hidden buffer)))
    ("related"
     (require 'noema-context)
     (let ((session (with-current-buffer buffer
                      (noema-context--send
                       :prompt noema-context-related-prompt
                       :references (noema-context--region-references buffer begin end)))))
       (when-let* ((window (and (buffer-live-p session)
                                (get-buffer-window session 'visible))))
         (if (fboundp 'my/noema--select-emacs-window)
             (my/noema--select-emacs-window window)
           (select-window window)))
       (noema-md-bridge--drop-hidden buffer)))
    ("context"
     (noema-md-bridge--add-context buffer begin end))
    ("compose"
     (noema-md-bridge--add-context buffer begin end)
     (require 'noema-compose)
     (noema-compose))
    ("rewrite"
     (require 'gptel-rewrite)
     (noema-md-bridge--show-region buffer begin end)
     (call-interactively #'gptel-rewrite))
    ("source"
     (noema-md-bridge--show-region buffer begin end))
    (_ (user-error "Unknown Noema bridge action: %s" action))))

(defun noema-md-bridge--event-range (event)
  "Return the range plist from host EVENT."
  (list :line-start (alist-get 'lineStart event)
        :line-end (alist-get 'lineEnd event)
        :from-line (alist-get 'fromLine event)
        :from-column (alist-get 'fromColumn event)
        :to-line (alist-get 'toLine event)
        :to-column (alist-get 'toColumn event)))

;;;###autoload
(defun noema-md-bridge-handle-selection (event)
  "Handle a pane's saved-range report EVENT from the Noema host.
EVENT names the reporting client, its file, the range and the action.  A
report whose pane no longer shows that file is refused."
  (let* ((client (alist-get 'client event))
         (file (alist-get 'file event))
         (action (or (alist-get 'action event) "agent"))
         (failure (alist-get 'error event))
         (pane (and (fboundp 'my/noema--buffer-for-client)
                    (my/noema--buffer-for-client client))))
    (noema-md-bridge--settle (alist-get 'requestId event))
    ;; The page could not produce a range (nothing selected, save failed...).
    ;; Say why here: page statuses only reach the echo area as errors.
    (when (and (stringp failure) (not (string-empty-p failure)))
      (user-error "Noema: %s" failure))
    (message nil)
    (unless (and (buffer-live-p pane)
                 (noema-md-bridge--same-file-p
                  (buffer-local-value 'my/noema-buffer-file-name pane) file))
      (user-error "Noema selection no longer matches its pane"))
    (pcase-let ((`(,buffer ,begin . ,end)
                 (noema-md-bridge-region file (noema-md-bridge--event-range event))))
      ;; The action prompts (which session, what to ask) and may open a
      ;; transient.  Run it as its own step, not inside the host-event queue:
      ;; a prompt there blocks every later Noema event until answered.
      (run-at-time 0 nil #'noema-md-bridge--run-interactively
                   pane action buffer begin end))))

(defun noema-md-bridge--run-interactively (pane action buffer begin end)
  "Run ACTION on BEGIN..END of BUFFER with the keyboard on Emacs, not PANE.
The Noema page kept WebKit's keyboard focus when it answered; without this
the session prompt appears but every key goes to the page."
  (when (buffer-live-p buffer)
    (when (and (buffer-live-p pane)
               (fboundp 'my/noema--release-xwidget-input-buffer))
      (my/noema--release-xwidget-input-buffer pane))
    (when (fboundp 'my/noema--select-emacs-window)
      (my/noema--select-emacs-window))
    (let ((minibuffer-setup-hook
           (if (fboundp 'my/noema--focus-minibuffer-if-active)
               (cons #'my/noema--focus-minibuffer-if-active minibuffer-setup-hook)
             minibuffer-setup-hook)))
      (condition-case failure
          (noema-md-bridge-run action buffer begin end)
        (quit (message "Noema: %s cancelled" action))
        (user-error (message "%s" (error-message-string failure)))
        (error (message "Noema %s failed: %s" action
                        (error-message-string failure)))))))


;;;; ── Keeping panes and source buffers in step ─────────────────────────────

(defun noema-md-bridge--panes-for (file)
  "Return the live Noema Markdown panes showing FILE."
  (seq-filter (lambda (buffer)
                (and (buffer-local-value 'my/noema-buffer-file-name buffer)
                     (noema-md-bridge-pane-p buffer)
                     (noema-md-bridge--same-file-p
                      (buffer-local-value 'my/noema-buffer-file-name buffer) file)))
              (seq-filter (lambda (buffer)
                            (eq (buffer-local-value 'major-mode buffer)
                                'xwidget-webkit-mode))
                          (buffer-list))))

(defun noema-md-bridge-notify-saved (&optional file)
  "Tell every Noema pane showing FILE (default: this buffer's) to reload.
A pane holding unsaved text of its own keeps it and says so instead."
  (when-let* ((file (or file buffer-file-name)))
    (dolist (pane (noema-md-bridge--panes-for file))
      (with-current-buffer pane
        (my/noema-command "reload-if-clean"
                          `((file . ,my/noema-buffer-file-name)))))))

(defun noema-md-bridge--after-save ()
  "After an Emacs save, refresh the Noema panes that show this file."
  (when (and buffer-file-name
             (fboundp 'my/noema-command)
             (member (file-name-extension buffer-file-name) '("md" "markdown")))
    (noema-md-bridge-notify-saved)))

(add-hook 'after-save-hook #'noema-md-bridge--after-save)

(defvar-local noema-md-bridge--save-timer nil
  "Idle timer that saves this bridged source buffer, or nil.")

(defun noema-md-bridge--save-now (buffer)
  "Save BUFFER when it is still bridged and modified."
  (when (buffer-live-p buffer)
    (with-current-buffer buffer
      (setq noema-md-bridge--save-timer nil)
      (when (and noema-md-bridge-source-mode (buffer-modified-p))
        (save-buffer)))))

(defun noema-md-bridge--schedule-save (&rest _)
  "Save this buffer after `noema-md-bridge-autosave-delay' idle seconds."
  (when (and noema-md-bridge-autosave-delay (not noema-md-bridge--save-timer))
    (setq noema-md-bridge--save-timer
          (run-with-idle-timer noema-md-bridge-autosave-delay nil
                               #'noema-md-bridge--save-now (current-buffer)))))

(defun noema-md-bridge--cancel-save ()
  "Cancel this buffer's pending bridge save."
  (when (timerp noema-md-bridge--save-timer)
    (cancel-timer noema-md-bridge--save-timer))
  (setq noema-md-bridge--save-timer nil))

(defun noema-md-bridge-return ()
  "Save this source buffer and go back to the Noema pane showing it."
  (interactive)
  (noema-md-bridge--cancel-save)
  (when (buffer-modified-p) (save-buffer))
  (let ((pane (car (noema-md-bridge--panes-for buffer-file-name))))
    (quit-window)
    (when-let* ((window (and pane (get-buffer-window pane 'visible))))
      (select-window window)
      (with-current-buffer pane (my/noema-command "focus")))))

(defvar-keymap noema-md-bridge-source-mode-map
  :doc "Keys in an Emacs source buffer opened from a Noema pane."
  "C-c C-c" #'noema-md-bridge-return)

(define-minor-mode noema-md-bridge-source-mode
  "Emacs view of a note that is also open in a Noema pane.
Edits save on idle so the pane shows them; \\[noema-md-bridge-return] saves
and returns to the pane."
  :lighter " Noema↔"
  :keymap noema-md-bridge-source-mode-map
  (if noema-md-bridge-source-mode
      (progn
        (add-hook 'after-change-functions #'noema-md-bridge--schedule-save nil t)
        (add-hook 'kill-buffer-hook #'noema-md-bridge--cancel-save nil t))
    (remove-hook 'after-change-functions #'noema-md-bridge--schedule-save t)
    (remove-hook 'kill-buffer-hook #'noema-md-bridge--cancel-save t)
    (noema-md-bridge--cancel-save)))

(provide 'noema-md-bridge)
;;; noema-md-bridge.el ends here
