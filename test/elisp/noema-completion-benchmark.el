;;; noema-completion-benchmark.el --- Repeatable CAPF timing -*- lexical-binding: t; -*-
;; Run: emacs --batch -Q -L lisp -l test/elisp/noema-completion-benchmark.el
(require 'benchmark)
(require 'noema-research-mode)

(let* ((noema-capability--cache (make-hash-table :test #'equal))
       (records (cl-loop for i below 1000
                         collect `((id . ,(format "skill-%04d" i))
                                   (selectable . t) (description . "Sample Skill"))))
       (resolution `((skills . ,(vconcat records)))))
  (puthash "/benchmark/" (list :resolution resolution) noema-capability--cache)
  (with-temp-buffer
    (setq-local major-mode 'noema-research-mode
                noema-research-completion--project "/benchmark/")
    (insert "%% work Performance\n@@skill(")
    (noema-research-completion-at-point)
    (let ((result (benchmark-run 10000 (noema-research-completion-at-point))))
      (princ (format "1000 Skills, 10000 cached CAPF calls: %.3fs total, %.4f ms/call, %d GCs\n"
                     (car result) (/ (* 1000.0 (car result)) 10000) (cadr result)))))
  (with-temp-buffer
    (setq-local major-mode 'noema-research-mode)
    (insert "%% work Large document\n" (make-string 1000000 ?x))
    (let ((result (benchmark-run 10000 (noema-research-completion-at-point))))
      (princ (format "1 MB ordinary body, 10000 CAPF calls: %.3fs total, %.4f ms/call\n"
                     (car result) (/ (* 1000.0 (car result)) 10000))))))
