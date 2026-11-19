;;; noema-hy-memory-tests.el --- Hidden ACP memory contract -*- lexical-binding: t; -*-

(require 'ert)
(require 'noema-hy-memory)
(defvar agent-shell--state)
(defvar +agent-acp-session-origin)

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
    (setq-local +agent-acp-session-origin 'run)
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

(ert-deftest noema-hy-memory-scope-is-the-project-a-run-recalls-under ()
  (let ((root (make-temp-file "hy-scope-" t)))
    (unwind-protect
        (with-temp-buffer
          (setq-local default-directory (file-name-as-directory (expand-file-name "sub/deep" root)))
          (make-directory default-directory t)
          (cl-letf (((symbol-function 'noema-project-client-path) #'identity)
                    ((symbol-function 'noema-project-scope)
                     (lambda (_) (file-name-as-directory root))))
            (should (equal (noema-hy-memory--local-root (current-buffer))
                           (file-name-as-directory root))))
          (cl-letf (((symbol-function 'noema-project-client-path) #'ignore))
            (should-not (noema-hy-memory--local-root (current-buffer)))))
      (delete-directory root t))))

(ert-deftest noema-hy-memory-slash-commands-and-tool-origins-stay-out ()
  (should (noema-hy-memory--conversation-p "  plain text"))
  (should-not (noema-hy-memory--conversation-p " /compact keep the plan"))
  (should-not (noema-hy-memory--conversation-p nil))
  (with-temp-buffer
    (setq-local +agent-acp-session-origin 'marginnote)
    (should-not (noema-hy-memory--ordinary-session-p (current-buffer)))
    (setq-local +agent-acp-session-origin 'pi-project)
    (should (noema-hy-memory--ordinary-session-p (current-buffer)))))

(ert-deftest noema-agent-entry-c51-goes-once-to-ordinary-project-sessions ()
  (require 'noema-agent-entry)
  (clrhash noema-agent-entry--sent)
  (with-temp-buffer
    (setq-local agent-shell--state '((:session . ((:id . "native")))))
    (let* ((requests nil)
           (build (lambda (&rest _)
                   (noema-agent-entry--prompt-request-a
                    (lambda (&rest args) (push (plist-get args :prompt) requests))
                    :session-id "native" :prompt [((type . "text") (text . "Task"))]))))
      (cl-letf (((symbol-function 'noema-hy-memory--local-root) (lambda (_) "/tmp/p/"))
                ((symbol-function 'noema-project-root) (lambda (_) "/tmp/p/")))
        (dotimes (_ 2)
          (noema-agent-entry--send-command-a build :shell-buffer (current-buffer) :prompt "Task"))
        (noema-agent-entry--send-command-a build :shell-buffer (current-buffer) :prompt "/compact now")
        (should (= (length (car requests)) 1))
        (clrhash noema-agent-entry--sent)
        (setq requests nil)
        (dotimes (_ 2)
          (noema-agent-entry--send-command-a build :shell-buffer (current-buffer) :prompt "Task"))
        (should (= (length (cadr requests)) 2))
        (should (= (length (car requests)) 1))
        (should (string-match-p "noema-project-maintenance"
                                (alist-get 'text (aref (cadr requests) 1))))
        (should (string-match-p "/tmp/p" (alist-get 'text (aref (cadr requests) 1))))
        ;; C22: the session learns that Pi exists and who it is to Pi.
        (should (string-match-p "Skill noema-pi" (alist-get 'text (aref (cadr requests) 1))))
        (should (string-match-p "nativeSessionId=native" (alist-get 'text (aref (cadr requests) 1)))))
      (setq requests nil)
      (clrhash noema-agent-entry--sent)
      (cl-letf (((symbol-function 'noema-hy-memory--local-root) (lambda (_) "/tmp/q/"))
                ((symbol-function 'noema-project-root) #'ignore))
        (noema-agent-entry--send-command-a build :shell-buffer (current-buffer) :prompt "Task")
        (should (= (length (car requests)) 1)))
      (setq-local +agent-acp-session-origin 'run)
      (setq requests nil)
      (cl-letf (((symbol-function 'noema-hy-memory--local-root) (lambda (_) "/tmp/p/"))
                ((symbol-function 'noema-project-root) (lambda (_) "/tmp/p/")))
        (noema-agent-entry--send-command-a build :shell-buffer (current-buffer) :prompt "Task")
        (should (= (length (car requests)) 1))))))

(ert-deftest noema-agent-entry-c51-offers-rather-than-orders ()
  (require 'noema-agent-entry)
  (with-temp-buffer
    (let ((text (noema-agent-entry--text "/tmp/p/" (current-buffer) "native")))
      (should (string-match-p "not needed for ordinary work" text))
      (should-not (string-match-p "read it before" text))
      (should (<= (length text) 900)))))

(ert-deftest noema-agent-entry-c66-names-the-document-tools ()
  "A session that did not start from a page still learns how to change a note
so its open page follows and the change is attributed (C66)."
  (require 'noema-agent-entry)
  (with-temp-buffer
    (let ((text (noema-agent-entry--text "/tmp/p/" (current-buffer) "native")))
      (should (string-match-p "agent:document:propose" text))
      (should (string-match-p "agent:document:edit" text))
      (should (<= (length text) 900)))))

(ert-deftest noema-agent-entry-c51-command-encodes-paths-as-shell-and-json ()
  (require 'noema-agent-entry)
  (let* ((directory (make-temp-file "entry command ' " t))
         (noema-agent-entry--source directory)
         (root "/tmp/中文 path ' \" $(false) `false`/"))
    (unwind-protect
        (progn
          (make-directory (expand-file-name "scripts" directory))
          ;; The fake CLI echoes stdin: run exactly the entry's shell command.
          (with-temp-file (expand-file-name "scripts/agent-api.mjs" directory)
            (insert "process.stdin.pipe(process.stdout);\n"))
          (let* ((command (noema-agent-entry--command root))
                 ;; An Agent's non-login shell need not inherit Emacs's PATH.
                 (process-environment (cons "PATH=/usr/bin:/bin" process-environment))
                 (json (shell-command-to-string command))
                 (args (json-parse-string json :object-type 'alist)))
            (should (equal (alist-get 'root (aref args 0)) (directory-file-name root)))
            (should (equal (alist-get 'id (aref args 0)) "noema-project-maintenance"))))
      (delete-directory directory t))))

(ert-deftest noema-agent-entry-c51-builder-error-does-not-consume-entry ()
  (require 'noema-agent-entry)
  (let ((noema-agent-entry--pending '("native" . "entry"))
        (noema-agent-entry--sent (make-hash-table :test #'equal)))
    (should-error (noema-agent-entry--prompt-request-a
                   (lambda (&rest _) (error "request build failed"))
                   :session-id "native" :prompt []))
    (should-not (gethash "native" noema-agent-entry--sent))
    (let ((request (noema-agent-entry--prompt-request-a
                    (lambda (&rest args) (plist-get args :prompt))
                    :session-id "other" :prompt [])))
      (should (= (length request) 0))
      (should-not (gethash "native" noema-agent-entry--sent)))
    (noema-agent-entry--prompt-request-a #'list :session-id "native" :prompt [])
    (should (gethash "native" noema-agent-entry--sent))))

;; The citation loop (docs/noema/design/hy-memory.md M1-M4).

(ert-deftest noema-hy-memory-m1-recalled-memories-are-citable ()
  (let ((context (noema-hy-memory--text
                  '(((content . "Prefers Lean 4 with Mathlib") (id . "0123456789abcdef"))
                    ((content . "No id here"))))))
    (should (string-match-p "\\[mem:01234567\\] Prefers Lean 4 with Mathlib" context))
    (should (string-match-p "cite it as \\[mem:ID\\]" context))
    (should (string-match-p "^No id here$" context))))

(ert-deftest noema-hy-memory-m2-only-given-memories-count-as-cited ()
  (let ((recalled '(("01234567" . "0123456789abcdef") ("feedbeef" . "feedbeef-full"))))
    (should (equal (noema-hy-memory--cited "Used [mem:01234567] and [mem:01234567], invented [mem:99999999]." recalled)
                   '("0123456789abcdef")))
    (should-not (noema-hy-memory--cited "No citation." recalled))))

(ert-deftest noema-hy-memory-m3-the-ledger-is-written-only-in-a-project ()
  (let ((dir (file-name-as-directory (make-temp-file "memory-ledger" t))))
    (unwind-protect
        (progn
          (cl-letf (((symbol-function 'noema-project-root) (lambda (_) nil)))
            (noema-hy-memory--append dir '((kind . "recall") (ids . ["a"])))
            (should-not (file-exists-p (expand-file-name ".agent" dir))))
          (cl-letf (((symbol-function 'noema-project-root) (lambda (_) dir)))
            (noema-hy-memory--append dir '((kind . "recall") (ids . ["a"])))
            (should (equal (with-temp-buffer
                             (insert-file-contents (expand-file-name ".agent/memory/citations.jsonl" dir))
                             (buffer-string))
                           "{\"kind\":\"recall\",\"ids\":[\"a\"]}\n"))
            (should (file-exists-p (expand-file-name ".agent/.gitignore" dir)))))
      (delete-directory dir t))))

(ert-deftest noema-hy-memory-m4-a-turn-records-what-it-recalled-and-cited ()
  (let ((dir (file-name-as-directory (make-temp-file "memory-loop" t)))
        (continuation nil) (sent nil))
    (unwind-protect
        (with-temp-buffer
          (setq-local agent-shell--state nil)
          (cl-letf (((symbol-function 'noema-project-root) (lambda (_) dir))
                    ((symbol-function 'noema-hy-memory--ready-p) (lambda () t))
                    ((symbol-function 'noema-hy-memory--local-root) (lambda (_) dir))
                    ((symbol-function 'noema-hy-memory--request)
                     (lambda (operation _body callback)
                       (when (equal operation "search") (setq continuation callback)))))
            (noema-hy-memory--send-command-a (lambda (&rest args) (push args sent))
                                             :shell-buffer (current-buffer) :prompt "Prove the lemma again")
            (funcall continuation '((items . (((content . "Use induction on n") (id . "aaaaaaaa-1"))
                                               ((content . "Unrelated") (id . "bbbbbbbb-2"))))))
            (should sent)
            (noema-hy-memory--event (current-buffer) '((:event . input-submitted) (:data . ((:prompt . "Prove the lemma again")))))
            (noema-hy-memory--event (current-buffer) '((:event . agent-message-chunk) (:data . ((:text-chunk . "By induction [mem:aaaaaaaa].")))))
            (noema-hy-memory--event (current-buffer) '((:event . turn-complete) (:data . ((:stop-reason . "end_turn")))))
            (let ((lines (with-temp-buffer
                           (insert-file-contents (expand-file-name ".agent/memory/citations.jsonl" dir))
                           (split-string (buffer-string) "\n" t))))
              (should (= (length lines) 2))
              (should (string-match-p "\"kind\":\"recall\".*\"aaaaaaaa-1\",\"bbbbbbbb-2\"" (nth 0 lines)))
              (should (string-match-p "\"kind\":\"cite\".*\"ids\":\\[\"aaaaaaaa-1\"\\]" (nth 1 lines))))
            (should-not noema-hy-memory--recalled)))
      (delete-directory dir t))))

(provide 'noema-hy-memory-tests)
