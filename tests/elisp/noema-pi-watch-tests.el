;;; noema-pi-watch-tests.el --- Session facts for Pi's watches -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'noema-pi-watch)

(defmacro noema-pi-watch-tests--with-session (kind watches calls &rest body)
  "Run BODY with a KIND session whose Project has WATCHES, recording CALLS."
  (declare (indent 3))
  `(let* ((root (make-temp-file "pi-watch" t)) (,calls nil))
     (unwind-protect
         (with-temp-buffer
           (when ,watches
             (make-directory (expand-file-name ".agent/pi" root) t)
             (write-region "" nil (expand-file-name ".agent/pi/journal.jsonl" root) nil 'silent))
           (cl-letf (((symbol-function '+agent-session-kind) (lambda (_) ,kind))
                     ((symbol-function '+agent-session-snapshot) (lambda (_) (list :root root :agent 'codex)))
                     ((symbol-function 'remote-client-file-name) #'identity)
                     ((symbol-function '+noema-api-call)
                      (lambda (channel args _callback &optional _timeout) (push (cons channel args) ,calls))))
             ,@body))
       (delete-directory root t))))

(ert-deftest noema-pi-watch-w12-a-project-without-watches-makes-no-call ()
  (noema-pi-watch-tests--with-session 'agent nil calls
    (noema-pi-watch--turn-complete (current-buffer) nil)
    (should-not calls)))

(ert-deftest noema-pi-watch-w5-reports-the-session-fact ()
  (noema-pi-watch-tests--with-session 'agent t calls
    (noema-pi-watch--turn-complete (current-buffer) nil)
    (noema-pi-watch--client-ended (current-buffer))
    (should (equal (mapcar (lambda (call) (alist-get 'name (aref (cdr call) 0))) calls)
                   '("client-exit" "turn-end")))
    (let ((body (aref (cdar calls) 0)))
      (should (equal (caar calls) "noema:api:agent:pi:watch"))
      (should (equal (alist-get 'op body) "event"))
      (should (equal (alist-get 'agent body) "codex"))
      (should (equal (alist-get 'buffer body) (buffer-name))))))

(ert-deftest noema-pi-watch-w5-pi-sessions-are-not-reported ()
  (noema-pi-watch-tests--with-session 'pi t calls
    (noema-pi-watch--turn-complete (current-buffer) nil)
    (should-not calls)))

;;; noema-pi-watch-tests.el ends here
