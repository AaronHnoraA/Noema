;;; noema-context.el --- Hand buffer context to an agent session -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; gptel already owns picking context: `gptel-add' on a region, a buffer, a
;; file or Dired marks, the overlays that keep a region tracked as the text
;; moves, and the `*gptel-context*' review buffer.  Noema reuses that
;; selection and adds the part gptel has no notion of: handing it to one
;; chosen, live ACP session.  There is one selection, so what you gathered for
;; a gptel compose buffer is the same set you can send to an agent.
;;
;; Everything travels as a reference, never as a copy.  A region becomes
;; `path:12-40' in the prompt text -- the form `agent-shell--get-region-context'
;; uses for its own references -- plus one `resource_link' content block per
;; file, which is the block agent-shell sends for a file it will not embed.
;; The agent opens what it actually needs with its own filesystem tools, so
;; attaching a 3000-line file costs one line of prompt.
;;
;; Coupling: agent-shell and ACP details stay behind `noema-agent-acp';
;; session choice stays behind `noema-sessions'.  This module does reach into
;; gptel's context internals (`gptel-context--collect' and friends), which is
;; deliberate reuse of its selection model rather than a second one.

;;; Code:

(require 'cl-lib)
(require 'map)
(require 'seq)
(require 'subr-x)
(require 'noema-agent-acp)
(require 'noema-sessions)

(declare-function gptel-context-add "gptel-context" (&optional arg confirm))
(declare-function gptel-context-add-file "gptel-context" (path))
(declare-function gptel-context-remove-all "gptel-context" (&optional verbose))
(declare-function gptel-context--collect "gptel-context" (&optional context-alist))
(declare-function gptel-context--collect-regions "gptel-context" (buffer context-data))
(declare-function gptel-context--add-region "gptel-context"
                  (buffer region-beginning region-end &optional advance))
(declare-function gptel-context--add-buffer "gptel-context" (buffer))
(declare-function gptel-context--buffer-setup "gptel-context"
                  (&optional ignore-auto noconfirm context-alist))
(declare-function gptel-context-remove "gptel-context" (&optional context))
(declare-function which-function "which-func" ())
(defvar gptel-context)

(defgroup noema-context nil
  "Handing editor context to a Noema agent session by reference."
  :group 'noema-agent-session)

(defcustom noema-context-save-before-send 'ask
  "What to do with unsaved changes in a buffer that is being referenced.
A reference points the agent at a file on disk, so unsaved changes would send
it to stale text.  `ask' offers to save, t saves without asking, and nil
skips the entry and says so."
  :type '(choice (const :tag "Ask to save" ask)
                 (const :tag "Save without asking" t)
                 (const :tag "Skip unsaved buffers" nil))
  :group 'noema-context)

(defcustom noema-context-clear-after-send nil
  "Whether sending clears the shared gptel selection.
Off by default: the same selection usually serves several questions, and
`gptel-context-remove-all' clears it on purpose."
  :type 'boolean
  :group 'noema-context)


;;;; ── Turning the shared selection into references ─────────────────────────

(defun noema-context--agent-file (file session)
  "Return FILE as the path SESSION's agent opens, or signal.
SESSION nil means an agent on this machine.  A file on a machine that agent
cannot reach -- a local file for an agent on a server, or the reverse -- is
an error rather than a path the agent would silently fail to read."
  (or (noema-agent-acp-agent-file file session)
      (user-error "Context is not reachable by the agent: %s" file)))

(defun noema-context--relative (file root)
  "Return FILE relative to ROOT when it is inside it, else its absolute path.
This is the rule `agent-shell--get-region-context' applies to its own
references, so a Noema reference reads exactly like a native one."
  (let* ((root (and root (file-name-as-directory (expand-file-name root))))
         (relative (and root
                        (file-in-directory-p file root)
                        (file-relative-name file root))))
    ;; `file-in-directory-p' resolves symlinks and `file-relative-name' does
    ;; not, so a root reached through a link (/tmp on macOS, a linked
    ;; worktree) otherwise yields a relative name climbing out of the project.
    ;; Compare both in resolved terms before giving up on a readable name.
    (when (and root (or (null relative) (string-prefix-p "../" relative)))
      (let ((true-root (file-name-as-directory (file-truename root)))
            (true-file (file-truename file)))
        (setq relative (and (file-in-directory-p true-file true-root)
                            (file-relative-name true-file true-root)))))
    (or relative file)))

(defun noema-context--buffer-file (buffer)
  "Return the file BUFFER references, or nil when it cannot be referenced.
Honours `noema-context-save-before-send' for unsaved changes."
  (with-current-buffer buffer
    (when buffer-file-name
      (when (and (buffer-modified-p)
                 (pcase noema-context-save-before-send
                   ('ask (y-or-n-p (format "Save %s before referencing it? "
                                           (buffer-name))))
                   ('nil nil)
                   (_ t)))
        (save-buffer))
      (and (not (buffer-modified-p))
           (file-readable-p buffer-file-name)
           buffer-file-name))))

(defun noema-context--end-line (buffer end)
  "Return the last line of BUFFER a region ending at END actually covers.
A region that stops at the beginning of a line does not include that line."
  (with-current-buffer buffer
    (save-excursion
      (save-restriction
        (widen)
        (if (and (> end (point-min))
                 (save-excursion (goto-char end) (bolp)))
            (line-number-at-pos (1- end) t)
          (line-number-at-pos end t))))))

(defun noema-context--whole-buffer-p (buffer regions)
  "Return non-nil when REGIONS already cover all of BUFFER."
  (and (= (length regions) 1)
       (with-current-buffer buffer
         (save-restriction
           (widen)
           (and (<= (car (car regions)) (point-min))
                (>= (cdr (car regions)) (point-max)))))))

(defun noema-context--reference (file root &optional buffer region session)
  "Return the reference plist for FILE, limited to REGION of BUFFER when given.
:file is FILE's Emacs name, :agent-file the path SESSION's agent opens, and
:relative is relative to ROOT when FILE is inside it, else :agent-file."
  (let* ((file (expand-file-name file))
         (agent-file (noema-context--agent-file file session))
         (relative (noema-context--relative file root)))
    (append (list :file file
                  :agent-file agent-file
                  :relative (if (equal relative file) agent-file relative)
                  :kind (if region 'region 'file))
            (when region
              (list :line-start (with-current-buffer buffer
                                  (line-number-at-pos (car region) t))
                    :line-end (noema-context--end-line buffer (cdr region)))))))

(defun noema-context--resolve (&optional context root session)
  "Return (REFERENCES . SKIPPED) for CONTEXT, relative to session ROOT.
Paths are the ones SESSION's agent opens; nil means an agent on this machine.
CONTEXT defaults to the shared gptel selection.  SKIPPED describes entries
that cannot be referenced -- a buffer with no file, or one left unsaved --
because a reference to text that is not on disk would mislead the agent."
  (require 'gptel-context)
  (let (references skipped)
    (dolist (entry (gptel-context--collect (or context gptel-context)))
      (let ((source (car entry))
            (spec (cdr entry)))
        (cond
         ((bufferp source)
          (if-let* ((file (noema-context--buffer-file source)))
              (let ((regions (gptel-context--collect-regions source spec)))
                (if (or (null regions)
                        (noema-context--whole-buffer-p source regions))
                    (push (noema-context--reference file root nil nil session)
                          references)
                  (dolist (region regions)
                    (push (noema-context--reference file root source region session)
                          references))))
            (push (format "%s (%s)" (buffer-name source)
                          (if (buffer-local-value 'buffer-file-name source)
                              "unsaved changes"
                            "not visiting a file"))
                  skipped)))
         ((stringp source)
          (if (file-readable-p source)
              (push (noema-context--reference source root nil nil session)
                    references)
            (push (format "%s (unreadable)" source) skipped))))))
    (cons (nreverse references) (nreverse skipped))))

(defun noema-context-references (&optional context root session)
  "Return the reference plists for CONTEXT relative to session ROOT.
Each has :file, :agent-file, :relative and :kind, plus :line-start and
:line-end for a region.  SESSION is the agent buffer the paths are for; nil
means an agent on this machine.  See `noema-context--resolve' for what
cannot be referenced."
  (car (noema-context--resolve context root session)))


;;;; ── Reference blocks: a link and a line, never a copy ────────────────────

(defun noema-context--reference-line (reference)
  "Return REFERENCE as one line of prompt text.
The `path:START-END' form is the one agent-shell writes for its own regions."
  (if (eq (plist-get reference :kind) 'region)
      (format "%s:%d-%d" (plist-get reference :relative)
              (plist-get reference :line-start)
              (plist-get reference :line-end))
    (plist-get reference :relative)))

(defun noema-context--file-blocks (references)
  "Return one `resource_link' content block per distinct file in REFERENCES.
This is the block agent-shell sends for a file it does not embed: the agent
receives a location it can open rather than a copy of the text.  ACP has no
capability gate on resource links, so every agent understands them."
  (let ((seen (make-hash-table :test #'equal))
        blocks)
    (dolist (reference references (nreverse blocks))
      (let ((file (plist-get reference :file)))
        (unless (gethash file seen)
          (puthash file t seen)
          (let ((meta (noema-agent-acp-file-metadata file)))
            (push (delq nil
                        (list (cons 'type "resource_link")
                              (cons 'uri (concat "file://"
                                                 (plist-get reference :agent-file)))
                              (cons 'name (plist-get reference :relative))
                              (when-let* ((mime (plist-get meta :mime-type)))
                                (cons 'mimeType mime))
                              (when-let* ((size (plist-get meta :size)))
                                (cons 'size size))))
                  blocks)))))))

(defun noema-context--prompt-text (prompt references)
  "Return PROMPT with REFERENCES listed after it, as plain text."
  (if (null references)
      prompt
    (concat prompt
            "\n\nContext (open these yourself; they are not included inline):\n"
            (mapconcat (lambda (reference)
                         (concat "- " (noema-context--reference-line reference)))
                       references "\n")
            "\n")))

(defun noema-context-content-blocks (prompt references)
  "Return the ACP content blocks that send PROMPT with REFERENCES attached.
One text block names every reference, then one `resource_link' per file.  No
file content is ever put in the request."
  (cons (list (cons 'type "text")
              (cons 'text (noema-context--prompt-text prompt references)))
        (noema-context--file-blocks references)))


;;;; ── Choosing the session and delivering the turn ─────────────────────────

(defvar noema-context--last-session
  (make-hash-table :test #'equal :weakness 'value)
  "Project root to the agent buffer its editor context last went to.")

(defun noema-context--session (&optional pick)
  "Return the agent buffer editor context goes to.
The project's last target is reused until PICK, so repeated sends do not ask
again.  Starting or resuming a session happens in `noema-sessions-read'."
  (let* ((root (noema-agent-acp-project-root))
         (remembered (gethash root noema-context--last-session))
         (buffer (if (and (not pick)
                          (buffer-live-p remembered)
                          (noema-agent-acp-agent-buffer-p remembered))
                     remembered
                   (noema-sessions-read :prompt "Send context to session: "
                                        :root root :allow-new t))))
    (puthash root buffer noema-context--last-session)
    buffer))

(defun noema-context--deliver (buffer blocks)
  "Send content BLOCKS to agent BUFFER as soon as its session can take a turn."
  (cond
   ;; A session started for this send is still shaking hands with its agent.
   ((not (noema-agent-acp-state-value buffer '(:session :id)))
    (let (subscription)
      (setq subscription
            (noema-agent-acp-subscribe
             :buffer buffer :event 'init-finished
             :callback (lambda (_event)
                         (ignore-errors
                           (noema-agent-acp-unsubscribe
                            :buffer buffer :subscription subscription))
                         (when (buffer-live-p buffer)
                           (noema-context--deliver buffer blocks))))))
    (message "Noema: the session is starting; your context follows"))
   ;; Mid-turn: agent-shell's own queue sends it when the turn finishes.  A
   ;; queued prompt is plain text, so the references travel as the same
   ;; `path:START-END' lines without the resource links.
   ((noema-agent-acp-busy-p buffer)
    (noema-agent-acp-enqueue buffer (map-elt (car blocks) 'text))
    (message "Noema: the session is busy; your context is queued"))
   (t
    (noema-agent-acp-prompt :buffer buffer :content blocks)))
  (noema-agent-acp-show-buffer buffer))

(defun noema-context--report-skipped (skipped)
  "Say which entries in SKIPPED could not be turned into a reference."
  (when skipped
    (message "Noema context skipped %d entr%s: %s"
             (length skipped)
             (if (= (length skipped) 1) "y" "ies")
             (string-join skipped "; "))))

(cl-defun noema-context--send (&key prompt pick draft)
  "Send the shared selection to a session, reading PROMPT when it is nil.
PICK asks which session to use instead of reusing the project's last one.
DRAFT puts the turn in the session's input without submitting it."
  (let* ((buffer (noema-context--session pick))
         (root (buffer-local-value 'noema-agent-acp-session-root buffer))
         (resolved (noema-context--resolve nil root buffer))
         (references (car resolved))
         (prompt (or prompt
                     (read-string
                      (format "Ask %s (%d reference%s): "
                              (or (buffer-local-value 'noema-agent-acp-session-name buffer)
                                  "the agent")
                              (length references)
                              (if (= (length references) 1) "" "s")))))
         (blocks (noema-context-content-blocks prompt references)))
    (noema-context--report-skipped (cdr resolved))
    (when (and (string-empty-p (string-trim prompt)) (null references))
      (user-error "Nothing to send: no question and no context"))
    (if draft
        (progn (noema-agent-acp-draft buffer (noema-context--prompt-text prompt references))
               (noema-agent-acp-show-buffer buffer))
      (noema-context--deliver buffer blocks))
    (when noema-context-clear-after-send
      (require 'gptel-context)
      (gptel-context-remove-all))
    buffer))


;;;; ── Commands ─────────────────────────────────────────────────────────────

;;;###autoload
(defun noema-context-send (&optional pick)
  "Send the current editor context to an agent session as references.
The context is the shared gptel selection, the one `gptel-add' builds.  With
a prefix argument PICK, choose the session instead of reusing this project's
last one."
  (interactive "P")
  (noema-context--send :pick pick))

;;;###autoload
(defun noema-context-draft (&optional pick)
  "Put the current editor context in a session's input without sending it.
With a prefix argument PICK, choose the session."
  (interactive "P")
  (noema-context--send :pick pick :draft t))

;;;###autoload
(defun noema-context-send-region (&optional pick)
  "Add the active region to the selection and send it to a session.
Only `file:LINE-LINE' travels; the agent reads the lines itself.  With a
prefix argument PICK, choose the session."
  (interactive "P")
  (if (and (fboundp 'my/noema--xwidget-buffer-p)
           (my/noema--xwidget-buffer-p))
      (progn
        (unless (fboundp 'my/noema-command)
          (user-error "Noema browser command bridge is unavailable"))
        (my/noema-command "send-selection-to-agent"))
    (unless (use-region-p) (user-error "No active region"))
    (require 'gptel-context)
    (gptel-context--add-region (current-buffer) (region-beginning) (region-end) t)
    (deactivate-mark)
    (noema-context--send :pick pick)))

(defun noema-context-send-noema-selection (file line-start line-end)
  "Add FILE lines LINE-START through LINE-END to shared context and send."
  (unless (and (stringp file) (file-readable-p file)
               (integerp line-start) (integerp line-end)
               (<= 1 line-start line-end))
    (user-error "Noema selection is not a readable file range"))
  (let ((buffer (find-file-noselect file)))
    (with-current-buffer buffer
      (when (buffer-modified-p)
        (user-error "Save Emacs edits in %s before sending Noema's selection" file))
      (unless (verify-visited-file-modtime buffer)
        (revert-buffer t t))
      (save-excursion
        (save-restriction
          (widen)
          (when (> line-end (line-number-at-pos (point-max) t))
            (user-error "Noema selection is newer than the file on disk"))
          (goto-char (point-min))
          (forward-line (1- line-start))
          (let ((begin (point)))
            (forward-line (- line-end line-start))
            (end-of-line)
            (let ((end (min (point-max) (1+ (point)))))
              (require 'gptel-context)
              (gptel-context--add-region buffer begin end t))))))
    (with-current-buffer buffer
      (noema-context--send))))

;;;###autoload
(defun noema-context-send-buffer (&optional pick)
  "Add the whole current buffer to the selection and send it to a session.
With a prefix argument PICK, choose the session."
  (interactive "P")
  (require 'gptel-context)
  (gptel-context--add-buffer (current-buffer))
  (noema-context--send :pick pick))

;;;###autoload
(defun noema-context-send-file (file &optional pick)
  "Add FILE to the selection and send it to a session.
With a prefix argument PICK, choose the session."
  (interactive (list (read-file-name "Reference file: " nil nil t) current-prefix-arg))
  (require 'gptel-context)
  (gptel-context-add-file (expand-file-name file))
  (noema-context--send :pick pick))

;;;###autoload
(defun noema-context-send-at-point (&optional pick)
  "Tell a session exactly where point is, without sending any text.
The turn names the file, line, column and enclosing definition, so a question
like \"why does this branch run?\" has somewhere to land.  With a prefix
argument PICK, choose the session."
  (interactive "P")
  ;; Read point before anything else: choosing a session can start one and
  ;; show its buffer, which would move `point' out from under us.
  (let* ((file (or (noema-context--buffer-file (current-buffer))
                   (user-error "Point is not in a saved file")))
         (line (line-number-at-pos (point) t))
         (column (current-column))
         (defun-name (or (and (require 'which-func nil t)
                              (ignore-errors (which-function)))
                         (ignore-errors (add-log-current-defun))))
         (buffer (noema-context--session pick))
         (root (buffer-local-value 'noema-agent-acp-session-root buffer))
         (reference (noema-context--reference file root nil nil buffer))
         (where (format "%s:%d:%d" (plist-get reference :relative) line column))
         (prompt (read-string (format "Ask about %s: " where)))
         (blocks (list (list (cons 'type "text")
                             (cons 'text (concat prompt "\n\nPoint is at " where
                                                 (if defun-name
                                                     (format ", in `%s'" defun-name)
                                                   "")
                                                 ".\n")))
                       (car (noema-context--file-blocks (list reference))))))
    (when (string-empty-p (string-trim prompt))
      (user-error "Nothing to ask"))
    (noema-context--deliver buffer blocks)))

(defvar noema-context-review-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-c") #'noema-context-review-send)
    (define-key map (kbd "C-c C-k") #'quit-window)
    map)
  "Keymap layered over gptel's context review buffer for Noema sends.")

(define-minor-mode noema-context-review-mode
  "Send the reviewed context to an agent session instead of to gptel's menu.

gptel's own `C-c C-c' returns to its transient; here it hands the selection
to a session.  Deletions flagged with \\`d' are applied first.

\\{noema-context-review-mode-map}"
  :lighter nil
  :keymap noema-context-review-mode-map)

(defun noema-context-review-send ()
  "Apply flagged deletions in the review buffer, then send to a session."
  (interactive)
  (require 'gptel-context)
  (let ((doomed (delq nil (mapcar (lambda (overlay)
                                    (and (overlay-get overlay 'gptel-context-deletion-mark)
                                         (overlay-get overlay 'gptel-context)))
                                  (overlays-in (point-min) (point-max))))))
    (mapc #'gptel-context-remove doomed)
    (setq gptel-context (gptel-context--collect)))
  (quit-window)
  (noema-context-send))

;;;###autoload
(defun noema-context-inspect ()
  "Review the current editor selection before sending it to a session.
This is gptel's own context buffer: \\`n'/\\`p' move, \\`RET' visits, \\`d'
flags for removal.  \\`C-c C-c' sends what is left to an agent session."
  (interactive)
  (require 'gptel-context)
  (unless gptel-context
    (user-error "No context selected; add some with `gptel-add'"))
  (gptel-context--buffer-setup nil nil gptel-context)
  (when-let* ((buffer (get-buffer "*gptel-context*")))
    (with-current-buffer buffer (noema-context-review-mode 1))))

(provide 'noema-context)
;;; noema-context.el ends here
