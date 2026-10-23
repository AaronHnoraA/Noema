;;; noema-hy-memory-tests.el --- Hidden ACP memory contract -*- lexical-binding: t; -*-

(require 'ert)
(require 'noema-hy-memory)

(ert-deftest noema-hy-memory-injection-does-not-rewrite-visible-prompt ()
  (let* ((visible `[((type . "text") (text . "Original request"))])
         (noema-hy-memory--injection "Prior conversation memory")
         (request (noema-hy-memory--prompt-request-a
                   (lambda (&rest args) (plist-get args :prompt))
                   :session-id "s" :prompt visible)))
    (should (= (length request) 2))
    (should (equal (alist-get 'text (aref visible 0)) "Original request"))
    (should (equal (alist-get 'text (aref request 0)) "Original request"))
    (should (equal (alist-get 'text (aref request 1)) "Prior conversation memory"))))

(ert-deftest noema-hy-memory-context-labels-unverified-content ()
  (let ((context (noema-hy-memory--text
                  '(((content . "User prefers concise replies"))))))
    (should (string-match-p "unverified" context))
    (should (string-match-p "research evidence" context))
    (should (string-match-p "User prefers concise replies" context))))

(ert-deftest noema-hy-memory-recall-failure-still-sends-original-prompt ()
  (with-temp-buffer
    (let ((sent nil)
          (continuation nil))
      (cl-letf (((symbol-function 'noema-hy-memory--ready-p) (lambda () t))
                ((symbol-function 'noema-hy-memory--local-root) (lambda (_) "/tmp"))
                ((symbol-function 'noema-hy-memory--request)
                 (lambda (_operation _body callback)
                   (setq continuation callback))))
        (noema-hy-memory--send-command-a
         (lambda (&rest args) (push (plist-get args :prompt) sent))
         :shell-buffer (current-buffer) :prompt "Original prompt")
        (should-not sent)
        (funcall continuation nil)
        (should (equal sent '("Original prompt")))
        (funcall continuation nil)
        (should (equal sent '("Original prompt")))))))

(ert-deftest noema-hy-memory-recall-start-error-still-sends-once ()
  (with-temp-buffer
    (let ((sent nil))
      (cl-letf (((symbol-function 'noema-hy-memory--ready-p) (lambda () t))
                ((symbol-function 'noema-hy-memory--local-root) (lambda (_) "/tmp"))
                ((symbol-function 'noema-hy-memory--request)
                 (lambda (&rest _) (error "memory unavailable"))))
        (noema-hy-memory--send-command-a
         (lambda (&rest args) (push (plist-get args :prompt) sent))
         :shell-buffer (current-buffer) :prompt "Original prompt")
        (should (equal sent '("Original prompt")))))))

(ert-deftest noema-hy-memory-run-uses-the-run-bridge-once ()
  (with-temp-buffer
    (setq-local noema-agent-acp-session-origin 'run)
    (let ((sent nil)
          (memory-called nil))
      (cl-letf (((symbol-function 'noema-hy-memory--ready-p) (lambda () t))
                ((symbol-function 'noema-hy-memory--local-root) (lambda (_) "/tmp"))
                ((symbol-function 'noema-hy-memory--request)
                 (lambda (&rest _) (setq memory-called t))))
        (noema-hy-memory--send-command-a
         (lambda (&rest args) (push (plist-get args :prompt) sent))
         :shell-buffer (current-buffer) :prompt "Run prompt")
        (should (equal sent '("Run prompt")))
        (should-not memory-called)))))

(provide 'noema-hy-memory-tests)
