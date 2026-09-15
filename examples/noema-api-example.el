;;; noema-api-example.el --- Compose Noema semantic operations -*- lexical-binding: t; -*-

;; Evaluate this form from a visited `.noema' work block.  It queries context,
;; creates a downstream WorkNode, and asynchronously inspects the effective
;; capability environment without editing JuText as raw text.

(require 'noema-api)

(let* ((project (or (noema-current-project)
                    (user-error "Visit a Noema project first")))
       (parent (or (noema-current-node)
                   (user-error "Put point on a WorkNode first")))
       (parent-id (noema-node-id parent))
       (existing-children (mapcar #'noema-node-id
                                  (noema-node-children parent)))
       (created-id (noema-create-work
                    "Audit the effective capability boundary"
                    (list parent-id))))
  (noema-capability-list
   :project project
   :callback
   (lambda (environment error-object)
     (if error-object
         (message "Noema capability query failed: %S" error-object)
       (message "Created %s after %s (previous children %S); active %S"
                created-id parent-id existing-children
                (noema-capability-active environment)))))
  created-id)

;;; noema-api-example.el ends here
