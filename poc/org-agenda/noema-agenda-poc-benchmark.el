;;; noema-agenda-poc-benchmark.el --- Measure native record rendering -*- lexical-binding: t; -*-
(require 'noema-agenda-poc)
(require 'benchmark)

(defun noema-agenda-poc-benchmark ()
  "Measure synthetic seven-day native agenda generation after warmup."
  (let ((rows nil))
    (noema-agenda-poc-open '((items)))
    (noema-agenda-poc-close)
    (dolist (count '(100 1000 5000))
      (let* ((items
              (cl-loop for index below count collect
                       `((uid . ,(format "bench-%s" index)) (id . ,(format "#%s" index))
                         (kind . "markdown-task") (file . "/synthetic.md")
                         (title . ,(format "Synthetic task %s" index))
                         (status . "todo") (priority . "D") (project . "Benchmark")
                         (scheduled . "2026-09-15") (deadline . ""))))
             (snapshot `((items . ,items)))
             (measurements
              (cl-loop repeat 3 collect
                       (benchmark-run 1
                         (unwind-protect
                             (noema-agenda-poc-open snapshot "2026-09-15")
                           (when (get-buffer "*Noema Agenda Prototype*")
                             (with-current-buffer "*Noema Agenda Prototype*"
                               (noema-agenda-poc-close))))))))
        (push `((items . ,count)
                (medianSeconds . ,(nth 1 (sort (mapcar #'car measurements) #'<)))
                (samples . ,(vconcat (mapcar (lambda (measurement)
                                              `((seconds . ,(car measurement))
                                                (gcCount . ,(cadr measurement))
                                                (gcSeconds . ,(caddr measurement))))
                                            measurements)))) rows)))
    (princ (json-encode `((emacs . ,emacs-version) (org . ,(org-version))
                         (kind . "synthetic-native-record-render-warm-three-samples")
                         (rows . ,(vconcat (nreverse rows))))))
    (terpri)))

(noema-agenda-poc-benchmark)
