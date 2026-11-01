;;; noema-api-example.el --- Query project Agent capabilities -*- lexical-binding: t; -*-
(require 'noema-api)

(noema-capability-list
 :scope 'global :requested-packs '("noema-project")
 :callback (lambda (environment error-object)
             (if error-object
                 (message "Noema capability query failed: %S" error-object)
               (message "Active project guidance: %S"
                        (noema-capability-active environment)))))

;;; noema-api-example.el ends here
