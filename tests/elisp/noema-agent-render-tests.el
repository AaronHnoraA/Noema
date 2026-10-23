;;; noema-agent-render-tests.el --- Package/render contracts -*- lexical-binding: t; -*-
(require 'ert)
(require 'cl-lib)
(require 'noema-agent-acp)

(ert-deftest noema-agent-render-hidden-turns-keep-their-original-namespaces ()
  (with-temp-buffer
    (setq-local noema-agent-render-policy 'never)
    (let ((state `((:buffer . ,(current-buffer)) (:request-count . 1))) seen)
      (dotimes (_ 2)
        (noema-agent-render--dispatch
         (lambda (&rest args) (push (plist-get args :namespace-id) seen))
         (list :state state :text "reply"))
        (map-put! state :request-count (1+ (map-elt state :request-count))))
      (noema-agent-render-flush)
      (should (equal (reverse seen) '(1 2))))))

(ert-deftest noema-agent-render-uses-unmodified-package-implementations ()
  (dolist (entry '((agent-shell . agent-shell) (acp . acp-make-client) (shell-maker . shell-maker-start)))
    (let ((source (locate-library (symbol-name (car entry)))))
      (should source)
      (should (file-in-directory-p source package-user-dir))
      (should (file-in-directory-p (symbol-file (cdr entry)) package-user-dir))))
  (should-not (fboundp 'agent-shell--defer-output-render))
  (should-not (boundp 'agent-shell-output-render-policy)))

(ert-deftest noema-agent-render-real-upstream-keyword-contract-defers-both-functions ()
  (with-temp-buffer
    (setq-local noema-agent-render-policy 'never)
    (let ((state `((:buffer . ,(current-buffer)))))
      (agent-shell--update-text :state state :text "plain")
      (agent-shell--update-fragment :state state :text "fragment" :block-id "test"))
    (should (= 2 (length noema-agent-render--pending)))
    (should (> noema-agent-render--bytes 0))))

(ert-deftest noema-agent-render-fifo-is-bounded-and-replay-is-ordered ()
  (with-temp-buffer
    (setq-local noema-agent-render-policy 'never)
    (let ((state `((:buffer . ,(current-buffer))))
          (noema-agent-render-cache-max-bytes 130) seen)
      (dotimes (i 4)
        (noema-agent-render--dispatch (lambda (&rest args) (push (plist-get args :text) seen))
                                      (list :state state :text (number-to-string i))))
      (should (= 2 (length noema-agent-render--pending)))
      (should (<= noema-agent-render--bytes noema-agent-render-cache-max-bytes))
      (noema-agent-render-flush)
      (should (equal (reverse seen) '("2" "3")))
      (should-not noema-agent-render--pending)
      (should-not noema-agent-render--tail)
      (should (= 0 noema-agent-render--bytes)))))

(ert-deftest noema-agent-render-always-and-visible-preserve-return-value ()
  (save-window-excursion
    (with-temp-buffer
      (let ((state `((:buffer . ,(current-buffer)))))
        (dolist (policy '(always visible))
          (setq-local noema-agent-render-policy policy)
          (set-window-buffer (selected-window) (current-buffer))
          (should (equal (noema-agent-render--dispatch (lambda (&rest _) :rendered) (list :state state)) :rendered))
          (should-not noema-agent-render--pending))))))

(ert-deftest noema-agent-render-zero-cache-and-killed-buffer-are-safe ()
  (let ((buffer (generate-new-buffer " *noema-render-dead*")))
    (with-current-buffer buffer
      (setq-local noema-agent-render-policy 'never)
      (let ((noema-agent-render-cache-max-bytes 0))
        (noema-agent-render--dispatch #'ignore (list :state `((:buffer . ,buffer)) :text "x")))
      (should-not noema-agent-render--pending))
    (kill-buffer buffer)
    (should-not (noema-agent-render--dispatch #'ignore (list :state `((:buffer . ,buffer)))))))

(ert-deftest noema-agent-render-disable-flushes-and-removes-advice ()
  (unwind-protect
      (with-temp-buffer
        (setq-local noema-agent-render-policy 'never)
        (let (rendered)
          (noema-agent-render--dispatch (lambda (&rest _) (setq rendered t))
                                        (list :state `((:buffer . ,(current-buffer)))))
          (noema-agent-render-mode -1)
          (should rendered)
          (should-not (advice-member-p #'noema-agent-render--text 'agent-shell--update-text))))
    (noema-agent-render-mode 1)))

(ert-deftest noema-agent-packages-pass-revisions-to-package-vc-install ()
  (require 'init-package-utils)
  (require 'package-vc)
  (let ((my/package-vc-recipes nil) (package-vc-selected-packages nil) installed)
    (cl-letf (((symbol-function 'package-installed-p) (lambda (&rest _) nil))
              ((symbol-function 'locate-library) (lambda (&rest _) nil))
              ((symbol-function 'package-vc-install) (lambda (&rest args) (setq installed args))))
      (my/package-ensure-vc 'acp "https://github.com/xenodium/acp.el" "audited-revision"))
    (should (equal (cadr installed) "audited-revision"))
    (should (equal (plist-get (cdar installed) :rev) "audited-revision"))
    (cl-letf (((symbol-function 'package-installed-p) (lambda (&rest _) t))
              ((symbol-function 'package-vc-install) (lambda (&rest _) (ert-fail "Unexpected startup network/install"))))
      (my/package-ensure-vc 'acp "https://github.com/xenodium/acp.el" "audited-revision"))))

(provide 'noema-agent-render-tests)
