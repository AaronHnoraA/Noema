;;; noema-agent-acp-tests.el --- Tests for Noema's ACP boundary -*- lexical-binding: t; -*-

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-agent-acp)

(ert-deftest noema-agent-acp-renamed-shell-restores-real-input-and-submits ()
  "Exercise the real shell process, prompt filter, Evil keys and input sender."
  (save-window-excursion
    (let* ((directory (make-temp-file "noema-native-input-" t))
           (shell-maker-root-path directory)
           (agent-shell-mode-hook nil)
           (original-name (generate-new-buffer-name " *native-input-test*"))
           (buffer (shell-maker-start-v2
                    :config (agent-shell--make-shell-maker-config
                             :prompt "OpenCode> " :prompt-regexp "OpenCode> ")
                    :buffer-name original-name :no-focus t :new-session t
                    :alias-commands nil)))
      (unwind-protect
          (with-current-buffer buffer
            ;; This is shell-maker's local placeholder process. Its default
            ;; termination notice cannot be inserted into read-only output.
            (set-process-sentinel (get-buffer-process buffer) #'ignore)
            (setq-local agent-shell--state (agent-shell--make-state :buffer buffer)
                        noema-agent-render-policy 'always)
            (setf (alist-get :id (alist-get :session agent-shell--state)) "session")
            (noema-agent-acp-mark-session-buffer buffer "input-test" "opencode" directory)
            (should (eq (shell-maker-buffer shell-maker--config) buffer))
            (should (eq (shell-maker--process) (get-buffer-process buffer)))
            (agent-shell--update-text :state agent-shell--state :block-id "answer"
                                      :text "\nFinished answer.\n" :create-new t)
            (should-not (noema-agent-acp--live-input-p))
            ;; Reproduce an already-open session with the old stale mapping
            ;; and busy flag.  Focus input must repair these as well.
            (setq-local shell-maker--buffer-name-override original-name
                        shell-maker--busy t
                        noema-agent-acp--prompt-owed nil)
            (switch-to-buffer buffer)
            (evil-local-mode 1)
            (evil-normal-state)
            (dolist (state '(normal insert visual motion))
              (evil-change-state state)
              (should (eq (key-binding (kbd "C-c C-e")) #'noema-agent-acp-focus-input)))
            (evil-normal-state)
            (cl-letf (((symbol-function 'noema-agent-acp-show-buffer)
                       (lambda (target) (switch-to-buffer target))))
              (call-interactively (key-binding (kbd "C-c C-e"))))
            (should (eq evil-state 'insert))
            (should (= (point) (point-max)))
            (should (agent-shell--live-input-prompt-p comint-last-prompt))
            (should-not shell-maker--busy)
            (should-not (get-buffer original-name))
            (insert "Please explain the second point.")
            (let (submitted)
              (cl-letf (((symbol-function 'shell-maker--eval-input-on-buffer-v2)
                         (lambda (&rest args) (setq submitted (plist-get args :input)))))
                (call-interactively (key-binding (kbd "RET"))))
              (should (equal submitted "Please explain the second point.")))
            (shell-maker-finish-output :config shell-maker--config :success t)
            ;; Successful, cancelled and failed ACP replies must all restore
            ;; native input, including when their output was deferred.
            (dolist (outcome '("end_turn" "cancelled" "failed"))
              (setq-local noema-agent-render-policy 'never)
              (let (wire)
                (cl-letf (((symbol-function 'acp-send-request)
                           (lambda (&rest args) (setq wire args))))
                  (noema-agent-acp-prompt :buffer buffer :run-id outcome
                                          :content '(((type . "text") (text . "Next request")))))
                (agent-shell--update-text :state agent-shell--state :block-id "reply"
                                          :text "\nNext reply\n" :create-new t)
                (should-error (noema-agent-acp-focus-input buffer) :type 'user-error)
                (if (equal outcome "failed")
                    (funcall (plist-get wire :on-failure) "offline" '((message . "offline")))
                  (funcall (plist-get wire :on-success) `((stopReason . ,outcome))))
                (should noema-agent-acp--prompt-owed)
                (should noema-agent-render--pending)
                (noema-agent-render-flush buffer)
                (should-not noema-agent-acp--prompt-owed)
                (should (noema-agent-acp--live-input-p))
                (save-excursion
                  (goto-char (point-max))
                  (let ((status (pcase outcome
                                  ("failed" "Failed") ("cancelled" "Stopped") (_ "Completed"))))
                    (should (search-backward status nil t))
                    (should (< (point) (marker-position (car comint-last-prompt))))
                    (should (search-backward "Next reply" nil t))))
                (let ((end (point-max)))
                  (noema-agent-acp-restore-prompt buffer)
                  (should (= end (point-max)))))))
        (when (buffer-live-p buffer)
          (with-current-buffer buffer
            (when-let* ((process (get-buffer-process buffer))) (delete-process process))
            (let ((kill-buffer-query-functions nil)) (kill-buffer buffer))))
        (when-let* ((orphan (get-buffer original-name))) (kill-buffer orphan))
        (delete-directory directory t)))))

(ert-deftest noema-agent-acp-submitted-input-is-visible-and-preserves-native-draft ()
  (with-temp-buffer
    (setq-local major-mode 'agent-shell-mode
                noema-agent-render-policy 'always
                comint-last-output-start (copy-marker 1))
    (insert "OpenCode> ")
    (setq-local comint-last-prompt (cons (copy-marker 1) (copy-marker (point))))
    (insert "unfinished draft")
    (let ((state `((:buffer . ,(current-buffer)) (:request-count . 1))))
      (cl-letf (((symbol-function 'agent-shell--render-markdown) #'ignore))
        (noema-agent-acp--display-submitted-content
         state '(((type . "text") (text . "Review this proof."))) "first"))
      (should (string-match-p "Review this proof" (buffer-string)))
      (should (equal (buffer-substring-no-properties (cdr comint-last-prompt) (point-max))
                     "unfinished draft"))
      (should (agent-shell--live-input-prompt-p comint-last-prompt)))))

(ert-deftest noema-agent-acp-mouse-model-selection-is-remembered-after-ack ()
  (with-temp-buffer
    (setq-local major-mode 'agent-shell-mode)
    (setq-local agent-shell--state
                '((:agent-config . ((:identifier . opencode)))))
    (let (request saved)
      (cl-letf (((symbol-function 'agent-shell--current-model-id) (lambda (_) "provider/chosen"))
                ((symbol-function 'noema-agent-acp--remember-model)
                 (lambda (id model) (setq saved (list id model)))))
        (noema-agent-acp--set-model
         (lambda (&rest args) (setq request args)) :model-id "provider/chosen")
        (should-not saved)
        (with-temp-buffer (funcall (plist-get request :on-success)))
        (should (equal saved '(opencode "provider/chosen")))))))

(ert-deftest noema-agent-acp-model-change-reaches-acp-and-updates-session ()
  (with-temp-buffer
    (setq-local major-mode 'agent-shell-mode
                agent-shell--state
                `((:buffer . ,(current-buffer))
                  (:agent-config . ((:identifier . opencode)))
                  (:session . ((:id . "s") (:model-id . "opencode/big-pickle")))))
    (let (wire saved)
      (cl-letf (((symbol-function 'acp-send-request) (lambda (&rest args) (setq wire args)))
                ((symbol-function 'agent-shell--update-header-and-mode-line) #'ignore)
                ((symbol-function 'noema-agent-acp--remember-model)
                 (lambda (id model) (setq saved (list id model)))))
        ;; Same upstream setter used by the model menu, including its RPC.
        (agent-shell--config-option-set-model-id :model-id "provider/chosen")
        (should (equal (map-nested-elt (plist-get wire :request) '(:params modelId))
                       "provider/chosen"))
        (should-not saved)
        (funcall (plist-get wire :on-success) nil)
        (should (equal (agent-shell--current-model-id agent-shell--state) "provider/chosen"))
        (should (equal saved '(opencode "provider/chosen")))))))

(ert-deftest noema-agent-acp-prompt-displays-input-and-sends-exact-blocks-once ()
  (with-temp-buffer
    (setq-local shell-maker--current-request-id 7)
    (setq-local agent-shell--state
                `((:buffer . ,(current-buffer)) (:request-count . 7)
                  (:last-entry-type . "agent_message_chunk")
                  (:session . ((:id . "selected-session") (:model-id . "provider/chosen")))))
    (let ((content '(((type . "text") (text . "Review this proof."))
                     ((type . "resource") (resource . ((uri . "file:///proof") (text . "frozen context"))))))
          displayed requests)
      (cl-letf (((symbol-function 'agent-shell--update-fragment)
                 (lambda (&rest args) (setq displayed args)))
                ((symbol-function 'acp-send-request)
                 (lambda (&rest args)
                   (should displayed)
                   (push (plist-get args :request) requests))))
        (noema-agent-acp-prompt :buffer (current-buffer) :run-id "run-1" :content content)
        (should (= 1 (length requests)))
        (should (equal (map-elt (car requests) :method) "session/prompt"))
        (should (equal (map-nested-elt (car requests) '(:params sessionId)) "selected-session"))
        (should (equal (map-nested-elt (car requests) '(:params prompt)) (vconcat content)))
        (should (string-match-p "Review this proof" (plist-get displayed :body)))
        (should (plist-get displayed :above-last-prompt))
        (should (= (map-elt agent-shell--state :request-count) 8))
        (should-not (map-elt agent-shell--state :last-entry-type))
        (should (equal (map-nested-elt agent-shell--state '(:session :model-id)) "provider/chosen"))))))

(ert-deftest noema-agent-acp-model-memory-is-per-agent-and-validates-availability ()
  (let* ((directory (make-temp-file "noema-models-" t))
         (noema-agent-acp-model-preferences-file (expand-file-name "models.json" directory)))
    (unwind-protect
        (progn
          (noema-agent-acp--remember-model 'opencode "provider/fast")
          (noema-agent-acp--remember-model 'codex "another")
          (should (equal (gethash "opencode" (noema-agent-acp--read-models)) "provider/fast"))
          (let* ((args (noema-agent-acp--model-config '(:config ((:identifier . opencode)))))
                 (default (map-elt (plist-get args :config) :default-model-id)))
            (cl-letf (((symbol-function 'agent-shell--state) #'ignore)
                      ((symbol-function 'agent-shell--get-available-models)
                       (lambda (_) '(((:model-id . "provider/fast"))))))
              (should (equal (funcall default) "provider/fast")))
            (cl-letf (((symbol-function 'agent-shell--state) #'ignore)
                      ((symbol-function 'agent-shell--get-available-models) #'ignore))
              (should-not (funcall default)))))
      (delete-directory directory t))))

(ert-deftest noema-agent-acp-model-memory-records-only-successful-selection ()
  (let (success saved)
    (cl-letf (((symbol-function 'agent-shell--state) (lambda () '((:agent-config . ((:identifier . opencode))))))
              ((symbol-function 'agent-shell--current-model-id) (lambda (_) "fast"))
              ((symbol-function 'noema-agent-worker-buffer-busy-p) #'ignore)
              ((symbol-function 'noema-agent-acp--remember-model) (lambda (id model) (setq saved (list id model)))))
      (noema-agent-acp--select-model (lambda (callback) (setq success callback)))
      (should-not saved)
      (funcall success)
      (should (equal saved '(opencode "fast"))))))

(ert-deftest noema-agent-acp-model-switch-rejects-an-active-request ()
  (cl-letf (((symbol-function 'agent-shell--state) (lambda () '((:active-requests . (prompt))))))
    (should-error (noema-agent-acp--select-model (lambda (&rest _) (ert-fail "changed busy model"))) :type 'user-error)))

(ert-deftest noema-agent-acp-receipt-precedes-consumer-and-is-run-scoped ()
  (with-temp-buffer
    (setq-local agent-shell--state '((:session . ((:id . "s")))))
    (let (success)
      (cl-letf (((symbol-function 'agent-shell--send-request)
                 (lambda (&rest args) (setq success (plist-get args :on-success)))))
        (noema-agent-acp-prompt :buffer (current-buffer) :run-id "r" :content []
                                :on-success (lambda (_) (error "consumer crashed")))
        (should-error (funcall success '((stopReason . "end_turn"))))
        (should (eq (plist-get (noema-agent-acp-prompt-receipt (current-buffer) "r") :status) 'completed))
        (should-not (noema-agent-acp-prompt-receipt (current-buffer) "other-run"))))))

(ert-deftest noema-agent-acp-projects-logical-local-directory ()
  (let ((root (file-name-as-directory temporary-file-directory)))
    (cl-letf (((symbol-function 'remote-client-file-name)
               (lambda (path) (should (string-prefix-p "/fs:local:" path)) root)))
      (should (equal (noema-agent-acp--client-directory (concat "/fs:local:" root)) root)))))

(ert-deftest noema-agent-acp-rejects-unprojectable-directory-before-start ()
  (cl-letf (((symbol-function 'remote-client-file-name) (lambda (_) nil))
            ((symbol-function 'agent-shell--start) (lambda (&rest _) (ert-fail "Started with invalid cwd"))))
    (should-error (noema-agent-acp-start :directory "/fs:unavailable:/project" :config 'test)
                  :type 'user-error)))

(ert-deftest noema-agent-acp-pins-native-cwd-through-async-handshake ()
  (let ((root (file-name-as-directory temporary-file-directory))
        (buffer (generate-new-buffer " *noema-native-cwd-test*")))
    (unwind-protect
        (cl-letf (((symbol-function 'remote-client-file-name) (lambda (_) root))
                  ((symbol-function 'agent-shell--start)
                   (lambda (&rest _)
                     (should (equal default-directory root))
                     (should (equal (funcall agent-shell-cwd-function) root))
                     buffer))
                  ((symbol-function 'noema-agent-acp--install-workspace-tabs) #'ignore)
                  ((symbol-function 'noema-agent-acp-subscribe) #'ignore)
                  ((symbol-function 'noema-agent-acp-hide-client-stderr) #'ignore))
          (noema-agent-acp-start :directory (concat "/fs:local:" root) :config 'test)
          (with-current-buffer buffer
            (should (local-variable-p 'agent-shell-cwd-function))
            (should (equal (funcall agent-shell-cwd-function) root))))
      (kill-buffer buffer))))

(ert-deftest noema-agent-acp-hides-client-stderr-buffer ()
  "The acp.el stderr buffer is hidden like the agent buffer it serves."
  (let* ((agent (generate-new-buffer " *noema-acp-test-agent*"))
         (stderr (generate-new-buffer "acp-client-stderr(noema-test)-1"))
         (process (make-process :name "acp-client(noema-test)-1"
                                :command '("sleep" "5")
                                :stderr stderr
                                :connection-type 'pipe
                                :noquery t)))
    (unwind-protect
        (cl-letf (((symbol-function 'noema-agent-acp-agent-buffer-p)
                   (lambda (buffer) (eq buffer agent)))
                  ((symbol-function 'noema-agent-acp--state)
                   (lambda (_buffer) `((:client . ((:process . ,process)))))))
          (should (eq (noema-agent-acp-hide-client-stderr agent) stderr))
          (should (equal (buffer-name stderr) " acp-client-stderr(noema-test)-1"))
          ;; Idempotent: an already hidden buffer is left alone.
          (should-not (noema-agent-acp-hide-client-stderr agent)))
      (delete-process process)
      (when-let* ((pipe (get-process "acp-client(noema-test)-1 stderr")))
        (delete-process pipe))
      (kill-buffer agent)
      (when (buffer-live-p stderr)
        (kill-buffer stderr)))))

(ert-deftest noema-agent-acp-retires-transcript-copy-workspace ()
  "Reloading replaces an old copied-transcript workspace with the real session."
  (let* ((root (file-name-as-directory (make-temp-file "noema-acp-retire-" t)))
         (agent (generate-new-buffer " noema-agent-retire"))
         (old (generate-new-buffer "*Noema Agent Workspace · retire*")))
    (unwind-protect
        (save-window-excursion
          (with-current-buffer agent
            (setq major-mode 'agent-shell-mode)
            (setq-local noema-agent-acp-session-root root)
            ;; Hooks of the removed workspace point at functions that no
            ;; longer exist; they must not survive into editing or killing.
            (add-hook 'after-change-functions 'noema-agent-acp--workspace-source-changed nil t)
            (add-hook 'kill-buffer-hook 'noema-agent-acp--workspace-source-killed nil t))
          (with-current-buffer old
            (setq-local noema-agent-acp-workspace-root root)
            (add-hook 'kill-buffer-hook 'noema-agent-acp--workspace-killed nil t))
          (set-window-buffer (selected-window) old)
          (noema-agent-acp--retire-transcript-workspace)
          (should-not (buffer-live-p old))
          (should (eq agent (window-buffer (selected-window))))
          (with-current-buffer agent
            (should noema-agent-acp-tabs-mode)
            (should-not (memq 'noema-agent-acp--workspace-source-changed after-change-functions))
            (insert "still editable")))
      (when (buffer-live-p agent) (kill-buffer agent))
      (when (buffer-live-p old) (kill-buffer old))
      (delete-directory root t))))

(ert-deftest noema-agent-acp-window-keys-and-help ()
  "Management keys are bound and `?' types in the prompt, helps elsewhere."
  (dolist (binding '(("C-c C-e" . noema-agent-acp-focus-input)
                     ("C-c C-x" . noema-agent-acp-stop)
                     ("C-c C-r" . noema-sessions-agent-restart)
                     ("C-c C-k" . noema-agent-acp-close)
                     ("C-c C-w" . noema-sessions-agent-rename)
                     ("C-c C-d" . noema-sessions-agent-archive)
                     ("C-c C-z" . noema-agent-acp-menu)
                     ("?" . noema-agent-acp-help-or-insert)))
    (should (eq (lookup-key noema-agent-acp-tabs-mode-map (kbd (car binding)))
                (cdr binding))))
  (with-temp-buffer
    (insert "Codex> ")
    (setq-local comint-last-prompt (cons (copy-marker 1) (copy-marker (point))))
    (let (helped)
      (cl-letf (((symbol-function 'noema-agent-acp-help) (lambda () (setq helped t))))
        (let ((last-command-event ??))
          (noema-agent-acp-help-or-insert))
        (should (equal (buffer-string) "Codex> ?"))
        (should-not helped)
        (goto-char (point-min))
        (noema-agent-acp-help-or-insert)
        (should helped)))))

(ert-deftest noema-agent-acp-restores-an-input-prompt-after-a-noema-turn ()
  (let ((buffer (generate-new-buffer " noema-agent-prompt"))
        (live nil)
        finished)
    (unwind-protect
        (with-current-buffer buffer
          (setq major-mode 'agent-shell-mode)
          (setq-local shell-maker--config 'config
                      shell-maker--busy nil
                      noema-agent-render--pending nil
                      comint-last-prompt (cons (copy-marker 1) (copy-marker 1)))
          (cl-letf (((symbol-function 'shell-maker-finish-output)
                     (lambda (&rest args) (setq finished args live t)))
                    ((symbol-function 'agent-shell--live-input-prompt-p)
                     (lambda (_prompt) live)))
            ;; A live prompt already awaits input: nothing to write.
            (setq live t)
            (should-not (noema-agent-acp-restore-prompt buffer))
            (should-not finished)
            (should-not noema-agent-acp--prompt-owed)
            ;; Output followed the prompt: write the next one as agent-shell does.
            (setq live nil)
            (should (noema-agent-acp-restore-prompt buffer))
            (should (equal finished '(:config config :success t)))
            ;; Hidden buffer: output is deferred, so the prompt waits for it.
            (setq live nil finished nil)
            (setq-local noema-agent-render--pending '((text)))
            (should-not (noema-agent-acp-restore-prompt buffer))
            (should noema-agent-acp--prompt-owed)
            (should-not finished)
            (setq-local noema-agent-render--pending nil)
            (noema-agent-acp--settle-after-flush-a buffer)
            (should (equal finished '(:config config :success t)))
            (should-not noema-agent-acp--prompt-owed)))
      (kill-buffer buffer))))

(ert-deftest noema-agent-acp-tab-management-stops-closes-and-offers-a-menu ()
  (let* ((root (file-name-as-directory (make-temp-file "noema-acp-manage-" t)))
         (main (generate-new-buffer " noema-agent-main"))
         (other (generate-new-buffer " noema-agent-other"))
         (retired (generate-new-buffer " noema-agent-retired"))
         stopped interrupted)
    (unwind-protect
        (save-window-excursion
          (dolist (buffer (list main other retired))
            (with-current-buffer buffer
              (setq major-mode 'agent-shell-mode)
              (setq-local noema-agent-acp-session-root root)))
          (with-current-buffer main (setq-local noema-agent-acp-session-name "main"))
          (with-current-buffer other (setq-local noema-agent-acp-session-name "other"))
          (cl-letf (((symbol-function 'noema-agent-render-flush) #'ignore)
                    ((symbol-function 'noema-agent-acp-interrupt)
                     (lambda (&rest _) (setq interrupted t))))
            (noema-agent-acp-show-buffer main)
            (let ((window (noema-agent-acp--workspace-window))
                  (noema-agent-acp-stop-functions
                   (list (lambda (buffer) (setq stopped buffer)))))
              ;; A Run owner stops its Run; otherwise the turn is interrupted.
              (noema-agent-acp-stop main)
              (should (eq stopped main))
              (should-not interrupted)
              (setq noema-agent-acp-stop-functions nil)
              (noema-agent-acp-stop main)
              (should interrupted)
              ;; Name actions are unavailable for a retired buffer.
              (let ((active (lambda (buffer label)
                              (let ((item (seq-find (lambda (item)
                                                      (and (vectorp item) (equal (aref item 0) label)))
                                                    (noema-agent-acp--menu-items buffer))))
                                (plist-get (append (seq-drop item 2) nil) :active)))))
                (should (eq t (funcall active main "Restart session")))
                (should-not (funcall active retired "Restart session")))
              ;; Closing a shown tab keeps the Agent window on the next session.
              (noema-agent-acp-close main)
              (should-not (buffer-live-p main))
              (should (eq other (window-buffer window)))
              (noema-agent-acp-close-retired other)
              (should-not (buffer-live-p retired))
              (should (buffer-live-p other)))))
      (dolist (buffer (list main other retired))
        (when (buffer-live-p buffer) (kill-buffer buffer)))
      (delete-directory root t))))

(provide 'noema-agent-acp-tests)
;;; noema-agent-acp-tests.el ends here
