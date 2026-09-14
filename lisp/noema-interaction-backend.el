;;; noema-interaction-backend.el --- Backend registry for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Internal backend contribution registry.  Adapters register capabilities and
;; operation functions here; the UI and dispatch layer derive their choices
;; from this registry instead of maintaining a parallel hardcoded stack.

;;; Code:

(require 'cl-lib)

(defvar noema-interaction-backend--registry (make-hash-table :test 'eq)
  "Hash table mapping backend ids to spec plists.")

(defun noema-interaction-backend--validate (id spec)
  "Validate backend ID and SPEC."
  (unless (symbolp id)
    (error "Backend id must be a symbol: %S" id))
  (unless (stringp (plist-get spec :label))
    (error "Backend %s missing string :label" id))
  (dolist (cap (plist-get spec :capabilities))
    (unless (memq cap '(:session :send :draft :cancel :stop :headless))
      (error "Backend %s has unsupported capability %S" id cap)))
  (let ((ops (plist-get spec :operations)))
    (dolist (op '(:available-p :live-p :ensure :open))
      (unless (functionp (plist-get ops op))
        (error "Backend %s missing operation %S" id op)))
    (dolist (pair '((:send . :send) (:draft . :draft) (:stop . :stop) (:cancel . :cancel)))
      (when (memq (car pair) (plist-get spec :capabilities))
        (unless (functionp (plist-get ops (cdr pair)))
          (error "Backend %s missing operation %S" id (cdr pair))))))
  t)

;;;###autoload
(defun noema-interaction-register-backend (id &rest spec)
  "Register backend ID with SPEC and return a retractor function."
  (noema-interaction-backend--validate id spec)
  (puthash id spec noema-interaction-backend--registry)
  (let ((generation (plist-get spec :generation)))
    (lambda ()
      (when (eq generation (plist-get (gethash id noema-interaction-backend--registry)
                                      :generation))
        (remhash id noema-interaction-backend--registry)))))

(defun noema-interaction-backend-spec (id)
  "Return backend ID's spec plist, or nil."
  (gethash id noema-interaction-backend--registry))

(defun noema-interaction-backend-ids (&optional capability)
  "Return registered backend ids, optionally filtered by CAPABILITY."
  (let (ids)
    (maphash
     (lambda (id spec)
       (when (or (null capability)
                 (memq capability (plist-get spec :capabilities)))
         (push id ids)))
     noema-interaction-backend--registry)
    (sort ids (lambda (a b)
                (string< (plist-get (gethash a noema-interaction-backend--registry) :label)
                         (plist-get (gethash b noema-interaction-backend--registry) :label))))))

(defun noema-interaction-backend-label (id)
  "Return backend ID's display label."
  (or (plist-get (noema-interaction-backend-spec id) :label)
      (symbol-name id)))

(defun noema-interaction-backend-call (id operation &rest args)
  "Call OPERATION for backend ID with ARGS."
  (let* ((spec (or (noema-interaction-backend-spec id)
                   (error "Unknown backend: %s" id)))
         (fn (plist-get (plist-get spec :operations) operation)))
    (unless (functionp fn)
      (error "Backend %s does not support %S" id operation))
    (apply fn args)))

(defun noema-interaction-backend-live-p (id project-root)
  "Return non-nil when backend ID has a live session for PROJECT-ROOT."
  (ignore-errors
    (noema-interaction-backend-call id :live-p project-root)))

(provide 'noema-interaction-backend)
;;; noema-interaction-backend.el ends here
