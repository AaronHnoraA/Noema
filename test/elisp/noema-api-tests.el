;;; noema-api-tests.el --- Tests for Noema's semantic API -*- lexical-binding: t; -*-

;;; Code:

(require 'cl-lib)
(require 'ert)
(require 'noema-api)
(require 'noema-capability-ui)
(require 'noema-research-mode)
(require 'noema-agent-worker)

(defmacro noema-api-test--with-project (root &rest body)
  "Create a temporary project ROOT while evaluating BODY."
  (declare (indent 1))
  `(let ((,root (file-name-as-directory (make-temp-file "noema-api-" t))))
     (unwind-protect
         (progn
           (with-temp-file (expand-file-name "noema.toml" ,root)
             (insert "schema = 1\nrepository_id = \"test\"\n"))
           ,@body)
       (delete-directory ,root t))))

(ert-deftest noema-api-current-project-finds-the-semantic-root ()
  (noema-api-test--with-project root
    (let ((nested (expand-file-name "notes/topic/" root)))
      (make-directory nested t)
      (should (equal (noema-current-project nested) root)))))

(ert-deftest noema-api-queries-work-node-relationships ()
  (let* ((document (noema-research-create-document "API test"))
         (parent (noema-research-create-work-node document "question" "Why?"))
         (child (noema-research-create-work-node document "work" "Investigate"
                                                  :parents (list parent))))
    (should (equal (mapcar #'noema-research-work-node-id
                           (noema-node-children parent "lineage" document))
                   (list child)))
    (should (equal (mapcar #'noema-research-work-node-id
                           (noema-node-parents child "lineage" document))
                   (list parent)))))

(ert-deftest noema-api-mutation-dispatches-to-one-structural-backend ()
  (with-temp-buffer
    (setq-local major-mode 'noema-research-mode
                noema-research--document (noema-research-create-document "Mutation test"))
    (let (called)
      (cl-letf (((symbol-function 'noema-research-op-create)
                 (lambda (kind title parents after)
                   (setq called (list kind title parents after))
                   "wn-created")))
        (should (equal (noema-create-work "Check proof" '("wn-parent") "wn-after")
                       "wn-created"))
        (should (equal called '("work" "Check proof" ("wn-parent") "wn-after")))))))

(ert-deftest noema-api-run-freezes-through-the-existing-worker-dispatch ()
  (noema-api-test--with-project root
    (let* ((document (noema-research-create-document "Run test"))
           (id (noema-research-create-work-node document "work" "Execute"))
           (cell (noema-research-primary-cell document id))
           (file (expand-file-name "run.noema" root))
           called)
      (puthash "source" "Perform the semantic operation." cell)
      (with-temp-buffer
        (setq-local major-mode 'noema-research-mode
                    noema-research--document document
                    buffer-file-name file)
        (set-buffer-modified-p nil)
        (cl-letf (((symbol-function 'noema-current-cell) (lambda (&optional _) cell))
                  ((symbol-function 'noema-agent-worker-run-work-cell)
                   (lambda (&rest args) (setq called args) "submission-test")))
          (should (equal (noema-run-cell nil "continue") "submission-test"))
          (should (equal called (list file (noema-research-cell-id cell)
                                     "continue" nil))))))))

(ert-deftest noema-api-resume-routes-a-name-separately-from-session-policy ()
  (let (called)
    (cl-letf (((symbol-function 'noema-run-cell)
               (lambda (&rest args) (setq called args) 'queued)))
      (should (eq (noema-agent-resume 'cell "review-session") 'queued))
      (should (equal called '(cell "continue" nil "review-session"))))))

(ert-deftest noema-api-capability-query-uses-the-semantic-host-channel ()
  (noema-api-test--with-project root
    (let (call resolution)
      (cl-letf (((symbol-function 'noema--host-call)
                 (lambda (channel body callback)
                   (setq call (list channel body))
                   (funcall callback
                            '((capabilities
                               . ((skills . []) (mcps . [])
                                  (active . ((skills . ["noema-elisp-api"])
                                             (mcps . ["noema"])))))) nil))))
        (noema-capability-list
         :project root :requested-skills '("noema-elisp-api")
         :callback (lambda (value error-object)
                     (should-not error-object)
                     (setq resolution value)))
        (should resolution)
        (should (equal (noema-capability-active resolution)
                       '(:skills ("noema-elisp-api") :mcps ("noema"))))
        (should (equal (car call) "aaronnote:api:research:capability:list"))
        (should (equal (append (cdr (assoc 'requestedSkills (cadr call))) nil)
                       '("noema-elisp-api")))))))

(ert-deftest noema-capability-ui-mutations-call-the-public-api ()
  (with-temp-buffer
    (noema-capability-ui-mode)
    (setq noema-capability-ui--project "/tmp/noema-api-project/")
    (noema-capability-ui--render
     '((scopes . []) (diagnostics . [])
       (skills . [((id . "review") (type . "skill") (enabled . t)
                   (source . ((scope . "global") (path . "global/SKILL.md")))
                   (patches . []) (validation . ((valid . t) (errors . []) (warnings . []))))])
       (mcps . [])))
    (let (called)
      (cl-letf (((symbol-function 'noema-capability-set-enabled)
                 (lambda (type id enabled &rest options)
                   (setq called (list type id enabled options)))))
        (noema-capability-ui-disable)
        (should (equal (seq-take called 3) '("skill" "review" nil)))
        (should (equal (plist-get (nth 3 called) :project)
                       "/tmp/noema-api-project/"))))))

(ert-deftest noema-capability-ui-registers-an-mcp-through-the-public-api ()
  (with-temp-buffer
    (noema-capability-ui-mode)
    (setq noema-capability-ui--project "/tmp/noema-api-project/")
    (let (called)
      (cl-letf (((symbol-function 'read-string) (lambda (&rest _) "project-tools"))
                ((symbol-function 'noema-capability-ui--read-json-object)
                 (lambda (&rest _) '((command . "/usr/bin/env") (args . []) (env . []))))
                ((symbol-function 'noema-mcp-register)
                 (lambda (id definition &rest options)
                   (setq called (list id definition options)))))
        (noema-capability-ui-register-mcp-json)
        (should (equal (car called) "project-tools"))
        (should (equal (alist-get 'command (cadr called)) "/usr/bin/env"))
        (should (eq (plist-get (nth 2 called) :enabled) t))
        (should (equal (plist-get (nth 2 called) :project)
                       "/tmp/noema-api-project/"))))))

(ert-deftest noema-agent-worker-preserves-http-and-stdio-mcp-transports ()
  (let* ((spec '((mcp_servers
                  . [((name . "remote") (type . "http")
                      (url . "https://example.test/mcp")
                      (headers . [((name . "Authorization") (value . "Bearer test"))]))
                     ((name . "local") (command . "node")
                      (args . ["server.mjs"]) (env . [((name . "MODE") (value . "test"))]))])))
         (worker (noema-agent-worker--create :spec spec))
         (servers (noema-agent-worker--mcp-servers worker)))
    (should (equal (alist-get 'type (car servers)) "http"))
    (should (equal (alist-get 'headers (car servers))
                   [((name . "Authorization") (value . "Bearer test"))]))
    (should-not (alist-get 'type (cadr servers)))
    (should (equal (alist-get 'command (cadr servers)) "node"))
    (should (equal (alist-get 'args (cadr servers)) ["server.mjs"]))))

(ert-deftest noema-agent-workspace-shows-real-session-buffers-as-tabs ()
  (noema-api-test--with-project root
    (let ((main (generate-new-buffer " noema-agent-main"))
          (branch (generate-new-buffer " noema-agent-branch")))
      (unwind-protect
          (save-window-excursion
            ;; `derived-mode-p' is the only agent-shell predicate used here;
            ;; avoid starting external ACP processes in this presentation test.
            (dolist (buffer (list main branch))
              (with-current-buffer buffer
                (setq major-mode 'agent-shell-mode)))
            (noema-agent-acp-mark-session-buffer main "main" "opencode" root)
            (noema-agent-acp-mark-session-buffer branch "branch" "opencode" root)
            (cl-letf (((symbol-function 'noema-agent-render-flush) #'ignore))
              (noema-agent-acp-show-buffer main)
              (let ((window (noema-agent-acp--workspace-window)))
                (should (eq main (window-buffer window)))
                (noema-agent-acp-show-buffer branch)
                ;; One Agent window, showing the real interactive session.
                (should (eq window (noema-agent-acp--workspace-window)))
                (should (eq branch (window-buffer window)))
                (should (eq window (selected-window)))
                (should (= 1 (seq-count (lambda (other)
                                          (noema-agent-acp-agent-buffer-p (window-buffer other)))
                                        (window-list nil 'nomini))))
                (with-current-buffer branch
                  (should noema-agent-acp-tabs-mode)
                  (should tab-line-exclude)
                  (let ((tabs (noema-agent-acp--tab-line)))
                    (should (string-match-p "main · opencode" tabs))
                    (should (string-match-p "branch · opencode" tabs))
                    (should (eq 'tab-line-tab-current
                                (get-text-property (string-match "branch" tabs) 'face tabs)))
                    (should (eq 'tab-line-tab-inactive
                                (get-text-property (string-match "main" tabs) 'face tabs))))
                  (noema-agent-acp-next-session))
                (should (eq main (window-buffer window)))
                (let ((edges (window-edges window)))
                  (should (>= (car edges) (/ (frame-width) 2)))
                  (should (> (cadr edges) 0)))
                (should (eq main (noema-agent-acp-session-buffer "main" root))))))
        (when (buffer-live-p main) (kill-buffer main))
        (when (buffer-live-p branch) (kill-buffer branch))))))

(ert-deftest noema-agent-worker-reuses-a-resumed-session-buffer ()
  (noema-api-test--with-project root
    (let ((shell (generate-new-buffer " noema-agent-resumed"))
          (worker (noema-agent-worker--create
                   :root root :target root :agent "opencode" :session-id "ses_test"
                   :routing '((sessionName . ((name . "test")))))))
      (unwind-protect
          (progn
            (with-current-buffer shell
              (setq major-mode 'agent-shell-mode))
            (cl-letf (((symbol-function 'noema-agent-worker--config) #'ignore)
                      ((symbol-function 'noema-agent-acp-start) (lambda (&rest _) shell))
                      ((symbol-function 'noema-agent-acp-subscribe) (lambda (&rest _) 'subscription)))
              (noema-agent-worker--start-shell worker "native-test"))
            ;; The next Run of the same logical Session finds this live buffer.
            (should (eq shell (noema-agent-worker--existing-buffer "ses_test")))
            (should (equal (noema-agent-acp--tab-label shell) "test · opencode"))
            ;; A buffer retired by a newer physical Session keeps a readable tab.
            (with-current-buffer shell
              (setq-local noema-agent-acp-session-name nil)
              (rename-buffer " *Noema Agent · test · opencode @ demo* (retired)" t))
            (should (equal (noema-agent-acp--tab-label shell) "test · opencode (retired)")))
        (when (buffer-live-p shell) (kill-buffer shell))))))

(ert-deftest noema-agent-worker-sends-non-ascii-context-as-json ()
  "Frozen context with non-ASCII text must serialize into the ACP prompt."
  (let* ((text "# Noema project\n\n- Work block: 阅读背景\n")
         (item `((ref . "project") (resolvedUri . "noema://project/x")
                 (mediaType . "text/markdown; charset=utf-8")
                 (contentBase64 . ,(base64-encode-string (encode-coding-string text 'utf-8) t))))
         (worker (noema-agent-worker--create :spec '((prompt . "通读文件")) :context-items (list item))))
    (dolist (embedded '(t nil))
      (cl-letf (((symbol-function 'noema-agent-acp-state-value) (lambda (&rest _) embedded)))
        (let ((json (decode-coding-string
                     (json-serialize (vconcat (noema-agent-worker--content-blocks worker))) 'utf-8)))
          (should (string-match-p "阅读背景" json)))))))

(ert-deftest noema-agent-worker-waits-for-a-person-when-the-kernel-omits-option-id ()
  "A pending kernel permission has no optionId; it must not be answered with nil."
  (let* ((worker (noema-agent-worker--create :run-id "run_perm" :session-id "ses_perm" :epoch 1))
         (noema-agent-worker--permissions (make-hash-table :test #'equal))
         (noema-agent-worker--attention-count 0)
         responded shown)
    (setf (noema-agent-worker-started worker) t)
    (cl-letf (((symbol-function 'noema-agent-worker--api)
               (lambda (_channel _body callback &optional _timeout)
                 (funcall callback '((permission . ((id . "perm_1") (state . "pending") (version . 1)))
                                     (autoDecision . ""))
                          nil)))
              ((symbol-function 'noema-agent-worker--show-permission-request)
               (lambda (_worker) (setq shown t))))
      (should (noema-agent-worker--permission-responder
               worker `((:tool-call . ((:tool-call-id . "tool-1") (:kind . "edit")))
                        (:options . (((:option-id . "allow_once") (:kind . "allow_once"))))
                        (:respond . ,(lambda (option) (setq responded (list option))))))))
    (should-not responded)
    (should shown)
    (should (gethash "perm_1" noema-agent-worker--permissions))
    (should (= noema-agent-worker--attention-count 1))))

(ert-deftest noema-agent-worker-cancels-the-cell-wherever-its-execution-is ()
  (noema-api-test--with-project root
    (let* ((file (expand-file-name "work.noema" root))
           (noema-agent-worker--runs (make-hash-table :test #'equal))
           (noema-agent-worker--submissions (make-hash-table :test #'equal))
           (running (noema-agent-worker--create
                     :run-id "run_c1" :root root
                     :spec '((source . ((kind . "work-cell") (file . "work.noema") (cell_id . "c-1"))))))
           (queued (noema-agent-worker--create :submission-id "sub-q" :queue-state 'queued
                                               :prepare-body `((file . ,file) (cellId . "c-2"))))
           (preparing (noema-agent-worker--create :submission-id "sub-p" :queue-state 'preparing
                                                  :prepare-body `((file . ,file) (cellId . "c-3"))))
           cancelled)
      (puthash "run_c1" running noema-agent-worker--runs)
      (puthash "sub-q" queued noema-agent-worker--submissions)
      (puthash "sub-p" preparing noema-agent-worker--submissions)
      (cl-letf (((symbol-function 'noema-agent-worker--cancel) (lambda (worker) (setq cancelled worker)))
                ((symbol-function 'magent-runtime-queue-arbiter-cancel) #'ignore))
        (should (eq (noema-agent-worker-cancel-cell file "c-1") 'run))
        (should (eq cancelled running))
        (should (eq (noema-agent-worker-cancel-cell file "c-2") 'queued))
        (should-not (gethash "sub-q" noema-agent-worker--submissions))
        (should (eq (noema-agent-worker-cancel-cell file "c-3") 'preparing))
        (should (eq (noema-agent-worker-queue-state preparing) 'cancelling))
        (should-not (noema-agent-worker-cancel-cell file "c-9")))
      ;; A cancelled preparation never dispatches; its frozen Run is cancelled.
      (let (calls)
        (cl-letf (((symbol-function 'noema-agent-worker--api)
                   (lambda (channel body _callback &optional _timeout) (push (cons channel body) calls)))
                  ((symbol-function 'magent-runtime-queue-arbiter-finish) #'ignore))
          (noema-agent-worker--abandon-cancelled-preparation
           preparing `((root . ,root) (run . ((id . "run_frozen"))))))
        (should (equal (alist-get 'runId (cdr (assoc "aaronnote:api:research:run:cancel" calls))) "run_frozen"))
        (should (eq (noema-agent-worker-queue-state preparing) 'cancelled))
        (should-not (gethash "run_frozen" noema-agent-worker--runs))))))

(ert-deftest noema-jutext-interrupt-cancels-only-the-cell-at-point ()
  (let (called)
    (with-temp-buffer
      (setq buffer-file-name "/tmp/noema-interrupt/work.noema")
      (cl-letf (((symbol-function 'noema-research--require-cell) (lambda () 'cell))
                ((symbol-function 'noema-research-cell-id) (lambda (_cell) "c-7"))
                ((symbol-function 'noema-agent-worker-cancel-cell)
                 (lambda (file id) (setq called (list file id)) nil)))
        (should-error (noema-research-interrupt-current) :type 'user-error)
        (should (equal called '("/tmp/noema-interrupt/work.noema" "c-7")))))))

(ert-deftest noema-jutext-refuses-session-keyword-lookalikes ()
  (should (equal (noema-research-session-keyword-suggestion "refresh") "fresh"))
  (should (equal (noema-research-session-keyword-suggestion "Fresh") "fresh"))
  (should-not (noema-research-session-keyword-suggestion "refresh-notes"))
  (should (noema-research-session-directive-valid-p "fresh"))
  (should-not (noema-research-session-directive-valid-p "refresh"))
  (should-not (noema-research-session-directive-valid-p "refresh:child"))
  (should (noema-research-session-directive-valid-p "refresh-notes")))

(ert-deftest noema-sessions-agent-commands-act-on-the-tab-session ()
  (require 'noema-sessions)
  (noema-api-test--with-project root
    (let ((buffer (generate-new-buffer " noema-agent-named"))
          calls)
      (unwind-protect
          (progn
            (with-current-buffer buffer
              (setq major-mode 'agent-shell-mode)
              (setq-local noema-agent-acp-session-root root
                          noema-agent-acp-session-name "main"
                          noema-agent-acp-session-agent "opencode"))
            (cl-letf (((symbol-function 'noema-sessions--api)
                       (lambda (channel body _callback) (push (cons channel body) calls))))
              (noema-sessions-agent-rename buffer "main-2")
              (noema-sessions-agent-fork buffer "main/probe"))
            (should (equal (alist-get 'newName (cdr (assoc "aaronnote:api:research:session:name:rename" calls)))
                           "main-2"))
            (let ((declared (cdr (assoc "aaronnote:api:research:session:name:declare" calls))))
              (should (equal (alist-get 'parentName declared) "main"))
              (should (equal (alist-get 'agent declared) "opencode")))
            ;; A retired buffer no longer owns a name to manage.
            (with-current-buffer buffer
              (setq-local noema-agent-acp-session-name nil))
            (should-error (noema-sessions-agent-rename buffer "x") :type 'user-error))
        (kill-buffer buffer)))))

(ert-deftest noema-jutext-execution-consumes-the-public-api ()
  (let (called)
    (cl-letf (((symbol-function 'noema-run-cell)
               (lambda (&rest args) (setq called args) 'queued)))
      (should (eq (noema-research-execute-current) 'queued))
      (should (equal called nil)))))

(ert-deftest noema-jutext-exposes-api-backed-capability-and-project-run-commands ()
  (should (eq (lookup-key noema-research-mode-map (kbd "C-c j C"))
              'noema-capability-manager))
  (should (eq (lookup-key noema-research-mode-map (kbd "C-c j r"))
              'noema-run-project-file)))

(provide 'noema-api-tests)
;;; noema-api-tests.el ends here
