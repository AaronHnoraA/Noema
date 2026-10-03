;;; noema-agent-attention-tests.el --- Attention of sessions without a Run -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; A stand-in buffer plays the agent session; agent-shell's subscription is
;; captured so each test fires the permission and turn events itself.

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-agent-inbox)
(require 'noema-agent-worker)

(defmacro noema-agent-attention-tests--with-session (spec &rest body)
  "Run BODY with `session' a watched stand-in agent buffer and `fire' its events.
SPEC is (VISIBLE FOCUSED) forms read on every event; `notified' collects the
notification bodies sent."
  (declare (indent 1) (debug t))
  `(let* ((session (generate-new-buffer " *noema-attention-session*"))
          (callbacks '())
          (notified '())
          (visible nil) (focused t)
          (noema-agent-acp-notify-function
           (lambda (_title body) (push body notified))))
     (ignore visible focused)
     (unwind-protect
         (cl-letf (((symbol-function 'noema-agent-acp-subscribe)
                    (cl-function
                     (lambda (&key buffer event callback)
                       (push (list buffer event callback) callbacks))))
                   ((symbol-function 'get-buffer-window)
                    (lambda (&rest _) (and (funcall (lambda () ,(car spec))) 'window)))
                   ((symbol-function 'frame-focus-state)
                    (lambda (&rest _) ,(cadr spec))))
           (with-current-buffer session
             (setq-local noema-agent-acp-session-name "worktree/fix")
             (setq-local noema-agent-acp-session-origin 'manual))
           (noema-agent-acp--subscribe-attention session)
           (cl-flet ((fire (event &optional data)
                       (dolist (callback callbacks)
                         (when (and (eq (car callback) session)
                                    (eq (cadr callback) event))
                           (funcall (nth 2 callback) (list (cons :event event)
                                                           (cons :data data)))))))
             ,@body))
       (kill-buffer session))))

(ert-deftest noema-agent-attention-marks-hidden-session ()
  (noema-agent-attention-tests--with-session (visible focused)
    (fire 'permission-request)
    (should (eq (buffer-local-value 'noema-agent-acp-attention session) 'permission))
    (should (equal (noema-agent-acp-attention-mark session) "!approve"))
    ;; Emacs had focus, so no system notification.
    (should-not notified)
    (fire 'turn-complete '((:stop-reason . "end_turn")))
    (should (equal (noema-agent-acp-attention-mark session) "done"))
    ;; Watching twice does not subscribe twice.
    (let ((count (length callbacks)))
      (noema-agent-acp--subscribe-attention session)
      (should (= count (length callbacks))))
    ;; Showing the buffer clears it.
    (with-current-buffer session (noema-agent-acp--attention-shown nil))
    (should-not (noema-agent-acp-attention-mark session))))

(ert-deftest noema-agent-attention-notifies-only-when-emacs-is-unfocused ()
  (noema-agent-attention-tests--with-session (visible focused)
    (setq focused nil)
    (fire 'turn-complete '((:stop-reason . "end_turn")))
    (should (equal notified '("worktree/fix finished its turn")))
    (fire 'permission-request)
    (should (equal (car notified) "worktree/fix is waiting for your permission"))))

(ert-deftest noema-agent-attention-skips-seen-cancelled-and-owned ()
  (noema-agent-attention-tests--with-session (visible focused)
    ;; On screen: seen when Emacs has focus again, so no mark.
    (setq visible t)
    (fire 'permission-request)
    (should-not (noema-agent-acp-attention-mark session))
    (setq visible nil)
    ;; The person's own interrupt is not news.
    (fire 'turn-complete '((:stop-reason . "cancelled")))
    (should-not (noema-agent-acp-attention-mark session))
    ;; A Run reports its own attention through the host.
    (let ((noema-agent-acp-run-owned-functions (list (lambda (buffer) (eq buffer session)))))
      (fire 'permission-request)
      (should-not (noema-agent-acp-attention-mark session)))
    ;; An ephemeral side chat never asks for attention.
    (with-current-buffer session (setq-local noema-agent-acp-session-origin 'side))
    (fire 'turn-complete '((:stop-reason . "end_turn")))
    (should-not (noema-agent-acp-attention-mark session))))

(ert-deftest noema-agent-attention-worker-owns-its-run-buffer ()
  (let ((noema-agent-worker--runs (make-hash-table :test #'equal))
        (buffer (generate-new-buffer " *noema-attention-run*")))
    (unwind-protect
        (progn
          (should-not (run-hook-with-args-until-success
                       'noema-agent-acp-run-owned-functions buffer))
          (puthash "run-1" (noema-agent-worker--create :run-id "run-1" :buffer buffer)
                   noema-agent-worker--runs)
          (should (run-hook-with-args-until-success
                   'noema-agent-acp-run-owned-functions buffer)))
      (kill-buffer buffer))))

(ert-deftest noema-agent-attention-inbox-ranks-navigates-and-reads ()
  (let ((waiting (generate-new-buffer " *noema-attention-waiting*"))
        (quiet (generate-new-buffer " *noema-attention-quiet*"))
        (promoted (generate-new-buffer " *noema-attention-promoted*")))
    (unwind-protect
        (with-temp-buffer
          (noema-agent-inbox-mode)
          (let* ((root "/tmp/noema-attention-project/")
                 (noema-agent-inbox--roots (list root))
                 (noema-agent-inbox--results (make-hash-table :test #'equal))
                 read)
            (with-current-buffer waiting (setq-local noema-agent-acp-attention 'permission))
            (with-current-buffer promoted (setq-local noema-agent-acp-attention 'done))
            (puthash root '((names . [((name . "recorded") (sessionId . "sid-1"))]))
                     noema-agent-inbox--results)
            (cl-letf (((symbol-function 'noema-agent-acp-sessions)
                       (lambda (&optional _root)
                         (list (list :buffer quiet :name "quiet" :root root)
                               (list :buffer waiting :name "waiting" :root root))))
                      ((symbol-function 'noema-sessions--live-buffer)
                       (lambda (entry _root)
                         (and (equal (noema-sessions--string entry "name") "recorded")
                              promoted)))
                      ((symbol-function 'noema-sessions--mark-read)
                       (lambda (_root name done) (setq read name) (funcall done t)))
                      ((symbol-function 'noema-agent-inbox--queue-update) #'ignore))
              (noema-agent-inbox--render)
              ;; The permission wait sorts first and carries its mark.
              (goto-char (point-min))
              (should (equal (aref (tabulated-list-get-entry) 0) "!approve"))
              (should (eq (plist-get (noema-agent-inbox--selected) :buffer) waiting))
              ;; A recorded Session with no host attention shows its live mark.
              (noema-agent-inbox-next-attention)
              (should (equal (plist-get (noema-agent-inbox--selected) :name) "recorded"))
              (should (equal (aref (tabulated-list-get-entry) 0) "done"))
              ;; Quiet rows are skipped; navigation wraps.
              (noema-agent-inbox-next-attention)
              (should (eq (plist-get (noema-agent-inbox--selected) :buffer) waiting))
              ;; `u' clears a local mark without asking the host.
              (noema-agent-inbox-mark-read)
              (should-not (noema-agent-acp-attention-mark waiting))
              (should-not read)
              ;; On a recorded Session it clears the live mark and reads it.
              (goto-char (point-min))
              (while (not (equal (plist-get (noema-agent-inbox--selected) :name) "recorded"))
                (forward-line 1))
              (noema-agent-inbox-mark-read)
              (should-not (noema-agent-acp-attention-mark promoted))
              (should (equal read "recorded")))))
      (mapc #'kill-buffer (list waiting quiet promoted)))))

(provide 'noema-agent-attention-tests)
;;; noema-agent-attention-tests.el ends here
