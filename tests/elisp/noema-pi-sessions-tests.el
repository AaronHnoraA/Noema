;;; noema-pi-sessions-tests.el --- Independent Pi session contracts -*- lexical-binding: t; -*-
(require 'ert)
(require 'cl-lib)
(require 'noema-pi-router)
(require 'noema-agent-acp)

(defmacro noema-pi-sessions-test--store (&rest body)
  (declare (indent 0))
  `(let* ((temporary (make-temp-file "pi-sessions-test-" t))
          (noema-pi-agent-directory temporary)
          (noema-pi-router--emacs-buffer nil)
          (noema-pi-router--buffers (make-hash-table :test #'equal)))
     (unwind-protect (progn ,@body) (delete-directory temporary t))))

(ert-deftest pi-session-c1-does-not-promote-or-expose-research-identity ()
  (with-temp-buffer
    (setq-local +agent-acp-session-origin 'pi-project
                noema-agent-promote--session-id "old-research-reference")
    (cl-letf (((symbol-function 'noema-project-root)
               (lambda (_) (ert-fail "Pi registration must not discover Research state"))))
      (noema-agent-register-session (current-buffer) "pi" "/tmp/"))
    (should-not (noema-agent--session-id (current-buffer)))
    (should-not (noema-agent--group (current-buffer)))
    (should (equal (noema-pi-router--group (current-buffer)) '(:key pi :label "Pi")))))

(ert-deftest pi-session-c2-retains-history-with-one-active-reference ()
  (noema-pi-sessions-test--store
    (with-temp-buffer
      (let ((native "first"))
        (cl-letf (((symbol-function '+agent-acp-state-value) (lambda (&rest _) native)))
          (noema-pi-sessions-observe "emacs" (current-buffer))
          (setq native "second")
          (noema-pi-sessions-observe "emacs" (current-buffer))
          (should (= (length (noema-pi-sessions-records)) 2))
          (should (equal (noema-pi-sessions-active-native "emacs") "second"))
          (noema-pi-sessions-observe "emacs" (current-buffer))
          (should (= (length (noema-pi-sessions-records)) 2)))))))

(ert-deftest pi-session-c2-legacy-index-import-is-idempotent-and-preserves-the-source ()
  (noema-pi-sessions-test--store
    (let* ((file (expand-file-name "assistants.json" temporary))
           (source "{\"emacs\":\"native-main\",\"/project/\":\"native-project\"}"))
      (write-region source nil file nil 'silent)
      (should (equal (noema-pi-sessions-active-native "emacs") "native-main"))
      (should (equal (noema-pi-sessions-active-native "/project/") "native-project"))
      (should (= (length (noema-pi-sessions-records)) 2))
      (should (equal (noema-pi-router--read-file file) source)))))

(ert-deftest pi-session-c2-import-does-not-replace-the-current-conversation ()
  (noema-pi-sessions-test--store
    (noema-pi-sessions-import-native "emacs" "current" "local")
    (noema-pi-sessions-import-native "emacs" "former" "research-session-name")
    (should (= (length (noema-pi-sessions-records)) 2))
    (should (equal (noema-pi-sessions-active-native "emacs") "current"))))

(ert-deftest pi-session-c2-corrupt-metadata-is-not-overwritten ()
  (noema-pi-sessions-test--store
    (let ((file (noema-pi-sessions--file)))
      (write-region "incomplete JSON" nil file nil 'silent)
      (should-error (noema-pi-sessions-import-native "emacs" "native" "local"))
      (should (equal (noema-pi-router--read-file file) "incomplete JSON")))))

(ert-deftest pi-session-c5-cancelled-close-retains-the-active-conversation ()
  (noema-pi-sessions-test--store
    (let ((buffer (generate-new-buffer " *pi-close-cancelled*")))
      (unwind-protect
          (progn
            (noema-pi-sessions-import-native "emacs" "current" "test")
            (noema-pi-sessions-import-native "emacs" "former" "test")
            (setq noema-pi-router--emacs-buffer buffer)
            (cl-letf (((symbol-function '+agent-acp-close) #'ignore)
                      ((symbol-function 'noema-pi-sessions--buffer) (lambda (_) nil)))
              (should-error
               (noema-pi-sessions-resume
                (seq-find (lambda (record) (equal (gethash "nativeSessionId" record) "former"))
                          (noema-pi-sessions-records))) :type 'user-error))
            (should (equal (noema-pi-sessions-active-native "emacs") "current")))
        (kill-buffer buffer)))))

(ert-deftest pi-session-c5-archive-retains-a-resumable-native-reference ()
  (noema-pi-sessions-test--store
    (let* ((record (noema-pi-sessions-import-native "emacs" "native" "test")) resumed)
      (noema-pi-sessions-archive record)
      (should-not (noema-pi-sessions-active-native "emacs"))
      (should (= (length (noema-pi-sessions-records)) 1))
      (cl-letf (((symbol-function 'noema-pi-sessions--buffer) (lambda (_) nil))
                ((symbol-function 'noema-pi-sessions--open-scope)
                 (lambda (scope) (setq resumed (noema-pi-sessions-active-native scope)))))
        (noema-pi-sessions-resume record))
      (should (equal resumed "native"))
      (should-not (gethash "archivedAt" (car (noema-pi-sessions-records)))))))

(ert-deftest pi-session-c5-closing-project-pi-does-not-stop-task-agents ()
  (let* ((root (file-name-as-directory temporary-file-directory))
         (pi (generate-new-buffer " *pi-close-only*"))
         closed)
    (unwind-protect
        (cl-letf (((symbol-function 'noema-pi-router-buffer) (lambda (&rest _) pi))
                  ((symbol-function '+agent-acp-close) (lambda (buffer) (setq closed buffer)))
                  ((symbol-function 'noema-agent-worker-stop-buffer)
                   (lambda (&rest _) (ert-fail "Pi does not own task agent lifetime"))))
          (noema-pi-close-project root)
          (should (eq closed pi)))
      (kill-buffer pi))))

(ert-deftest pi-session-c8-uninitialized-buffer-does-not-create-a-native-record ()
  (noema-pi-sessions-test--store
    (with-temp-buffer
      (cl-letf (((symbol-function '+agent-acp-state-value) (lambda (&rest _) nil)))
        (noema-pi-sessions-observe "emacs" (current-buffer)))
      (should-not (noema-pi-sessions-records))
      (should-not (file-exists-p (noema-pi-sessions--file))))))

(ert-deftest pi-session-c2-live-empty-is-not-assumed-to-be-durable-history ()
  (noema-pi-sessions-test--store
    (with-temp-buffer
      (let ((saved nil) (queries 0))
        (cl-letf (((symbol-function '+agent-acp-state-value)
                   (lambda (_buffer path &optional _default)
                     (pcase path ('(:session :id) "native") ('(:request-count) 0))))
                  ((symbol-function '+agent-acp-list-native-sessions)
                   (lambda (_buffer callback &optional limit)
                     (cl-incf queries)
                     (should (= limit 1))
                     (funcall callback (when saved '(((sessionId . "native")))) nil))))
          (noema-pi-router--remember "emacs" (current-buffer))
          (should-not (noema-pi-sessions-records))
          (setq saved t)
          (noema-pi-router--remember "emacs" (current-buffer))
          (should (equal (noema-pi-sessions-active-native "emacs") "native"))
          (noema-pi-router--remember "emacs" (current-buffer))
          (should (= queries 2)))))))

(ert-deftest pi-session-c2-unpersisted-prototype-reference-is-retained-without-resuming-it ()
  (noema-pi-sessions-test--store
    (noema-pi-sessions-import-native "emacs" "empty" "former-live-index")
    (noema-pi-sessions-note-volatile "emacs" "empty")
    (should-not (noema-pi-sessions-active-native "emacs"))
    (should (= (length (noema-pi-sessions-records)) 1))
    (should-error (noema-pi-sessions-resume (car (noema-pi-sessions-records))) :type 'user-error)))

(provide 'noema-pi-sessions-tests)
