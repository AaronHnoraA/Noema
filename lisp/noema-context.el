;;; noema-context.el --- Noema page and knowledge context adapters -*- lexical-binding: t; -*-
(require 'tools/agent/context)
(require 'noema-md-bridge)
(require 'noema-agent-text)





(defun noema-context-find-related (&optional pick)
  "Ask an existing Emacs agent session to find related project notes.
Use the active region when present, otherwise the current note.  A Noema
Markdown pane reports its selection through the saved-range bridge."
  (interactive "P")
  (if (noema-md-bridge-pane-p)
      (noema-md-bridge-request "related" "any")
    (let* ((buffer (current-buffer))
           (file (or (+agent-context--buffer-file buffer)
                     (user-error "Current buffer is not a saved note")))
           (references (if (use-region-p)
                           (+agent-context--region-references
                            buffer (region-beginning) (region-end))
                         (+agent-context--file-references file))))
      (+agent-context--send
       :pick pick
       :prompt (noema-agent-text "related")
       :references references))))

(defun noema-context-send-noema-selection (file line-start line-end)
  "Send only FILE lines LINE-START through LINE-END to a chosen session."
  (pcase-let ((`(,buffer ,begin . ,end)
               (noema-md-bridge-region
                file (list :line-start line-start :line-end line-end))))
    (with-current-buffer buffer
      (+agent-context--send
       :references (+agent-context--region-references buffer begin end)))))

(defun noema-context--editor-action (operation &rest _arguments)
  "Let a Noema pane supply its saved selection to shared editor actions."
  (when (noema-md-bridge-pane-p)
    (pcase operation
      ('compose (noema-md-bridge-compose) t)
      ('compose-send (noema-md-bridge-request "task" "document") t)
      ('add-context (noema-md-bridge-add-context) t)
      ('rewrite (noema-md-bridge-rewrite) t)
      ('send-region (noema-md-bridge-request "agent" "selection") t)
      ('send-buffer (noema-md-bridge-request "agent" "document") t)
      ('send-at-point (noema-md-bridge-request "agent" "line") t))))
(add-hook '+agent-editor-action-functions #'noema-context--editor-action)
(provide 'noema-context)
