;;; benchmark-native-agenda.el --- Production native UI benchmark -*- lexical-binding: t; -*-
;; emacs --batch -Q -L lisp -l scripts/benchmark-native-agenda.el
;; Measures production rendering and local marks, without source IO or GUI
;; redisplay. This is not a measurement of indexing or a graphical frame.
(require 'noema-agenda)
(require 'benchmark)
(require 'json)

(defun noema-agenda-benchmark--snapshot (count)
  (let ((todos (cl-loop for i below count collect
                       `((uid . ,(format "task-%d" i)) (scopeId . "knowledge")
                         (file . "/fixture/tasks.md") (sourceRef . ((revision . "fixture")))
                         (text . ,(format "Review proof %05d and record the result" i))
                         (status . "todo") (effectiveStatus . "todo") (noteTitle . "Research")
                         (canon . ((prio . "B")))))))
    `((todos . ,(vconcat todos)) (days . []) (errors . [])
      (scopes . [((id . "knowledge") (kind . "knowledge") (root . "/fixture"))]))))

(let (results)
  (with-temp-buffer
    (noema-agenda-mode)
    (setq noema-agenda--from "2026-09-16" noema-agenda--blocks '((todo)))
    (noema-agenda--render (noema-agenda-benchmark--snapshot 10))
    (cl-letf (((symbol-function 'noema-agenda--call) (lambda (&rest _) (error "Unexpected source IO"))))
      (dolist (count '(100 1000 5000))
        (let* ((snapshot (noema-agenda-benchmark--snapshot count))
               (render (benchmark-run 3 (noema-agenda--render snapshot))))
          (goto-char (point-min)) (search-forward "Review proof")
          (let ((marks (benchmark-run 20 (noema-agenda-mark))))
            (push `((tasks . ,count) (renderMeanMs . ,(* 1000 (/ (car render) 3)))
                    (markMeanMs . ,(* 1000 (/ (car marks) 20)))
                    (renderGCs . ,(cadr render)) (markGCs . ,(cadr marks))) results))
          (noema-agenda-unmark-all)))))
  (princ (json-encode `((emacs . ,emacs-version) (org . ,(org-version))
                        (measurement . "production render and local marks; no IO or GUI redisplay")
                        (results . ,(vconcat (nreverse results))))))
  (princ "\n"))
