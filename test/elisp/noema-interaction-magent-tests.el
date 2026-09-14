;;; noema-interaction-magent-tests.el --- Tests for Magent CLI bridge -*- lexical-binding: t; -*-

(require 'ert)
(require 'seq)
(require 'magent-llm)
(require 'magent-runtime-queue)
(require 'noema-interaction-magent-cli)

(defun noema-interaction-magent-test--run (engine callback)
  "Create a bridge run for ENGINE using event CALLBACK."
  (noema-interaction-magent-cli-run-create
   :engine engine
   :root default-directory
   :request (magent-llm-request-create
             :prompt '((prompt . "hello"))
             :callback callback)
   :pending ""
   :diagnostic-bytes 0
   :answer-bytes 0))

(ert-deftest noema-interaction-magent-cli-parses-split-codex-json ()
  (let ((captured nil))
    (let ((run (noema-interaction-magent-test--run
                'codex (lambda (event) (push event captured)))))
      (noema-interaction-magent-cli--filter
       run "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"te")
      (should-not captured)
      (noema-interaction-magent-cli--filter
       run "xt\":\"done\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"output_tokens\":1}}\n")
      (let ((events (nreverse captured)))
        (should (equal (mapcar #'magent-llm-event-type events)
                       '(text-delta completed)))
        (should (equal (magent-llm-event-text (car events)) "done"))))))

(ert-deftest noema-interaction-magent-cli-enforces-answer-cap ()
  (let ((captured nil)
        (noema-interaction-magent-cli-max-answer-bytes 3))
    (let ((run (noema-interaction-magent-test--run
                'codex (lambda (event) (push event captured)))))
      (noema-interaction-magent-cli--answer-delta run "four")
      (should (eq (magent-llm-event-type (car captured)) 'error))
      (should (eq (plist-get (magent-llm-event-metadata (car captured)) :status)
                  'response-too-large)))))

(ert-deftest noema-interaction-magent-cli-codex-resume-is-durable ()
  (let* ((run (noema-interaction-magent-cli-run-create
               :engine 'codex :root "/tmp/project/" :session-id "thread-1"))
         (command (noema-interaction-magent-cli--command run "continue")))
    (should (equal (seq-take command 3) '("codex" "exec" "resume")))
    (should (member "thread-1" command))
    (should-not (member "--ephemeral" command))))

(ert-deftest noema-interaction-magent-cli-forwards-magent-system-context ()
  (let* ((request (magent-llm-request-create
                   :system "Runtime policy"
                   :prompt '((prompt . "Do the work"))))
         (prompt (noema-interaction-magent-cli--effective-prompt request 'codex)))
    (should (string-match-p "Runtime policy" prompt))
    (should (string-match-p "Do the work" prompt))
    (should (string-match-p "own native tools" prompt))))

(ert-deftest noema-interaction-magent-cli-enforces-combined-prompt-cap ()
  (let ((noema-interaction-magent-cli-max-prompt-bytes 8)
        (request (magent-llm-request-create
                  :system "policy"
                  :prompt '((prompt . "request")))))
    (should-error
     (noema-interaction-magent-cli--effective-prompt request 'codex))))

(ert-deftest noema-interaction-magent-cli-diagnostic-cap-counts-bytes ()
  (let ((noema-interaction-magent-cli-max-diagnostic-bytes 5)
        (run (noema-interaction-magent-test--run 'codex #'ignore)))
    (noema-interaction-magent-cli--diagnostic run "前缀ending")
    (should (<= (noema-interaction-magent-cli-run-diagnostic-bytes run) 5))
    (should (string-suffix-p
             "ing" (car (noema-interaction-magent-cli-run-diagnostic-chunks run))))))

(ert-deftest noema-interaction-magent-runtime-submission-keeps-request-sampler ()
  (let* ((submission (magent-runtime-submission-create :id "sampler-test"))
         (sampler (lambda (_request) 'handle)))
    (magent-runtime-submission-set-sampler submission sampler)
    (should (eq (magent-runtime-submission-sampler submission) sampler))))

(provide 'noema-interaction-magent-tests)
;;; noema-interaction-magent-tests.el ends here
