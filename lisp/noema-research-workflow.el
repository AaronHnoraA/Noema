;;; noema-research-workflow.el --- Guided research work documents -*- lexical-binding: t; -*-

;;; Commentary:
;; A template is created as one validated document write after a human preview.
;; It is not an agent graph.declare proposal: these are user-invoked local
;; scaffolds.  Agents still use the proposal/CAS path for structural changes.

;;; Code:

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'button)
(require 'noema-research)
(require 'noema-research-mode)

(defvar-local noema-research-workflow--preview-document nil)
(defvar-local noema-research-workflow--preview-file nil)

(defconst noema-research-workflow--templates
  '(("empirical"
     ("question" "question" "研究问题与可证伪假设" nil nil "写明问题、范围、成功标准与可推翻假设的结果。")
     ("literature" "work" "文献检索与对照" "question" nil "@@skill(lit-review)\n\n检索已有工作；记录已读原文、关键对照、分歧与尚未解决的问题。")
     ("gap-review" "checkpoint" "人工复核：研究空白与选题" "literature" nil "人工复核文献覆盖、研究空白和可行性；未确认前不要推进实验设计。")
     ("design" "work" "实验设计与预注册" "gap-review" nil "@@skill(experiment-design)\n\n给出假设、变量、数据、对照、样本量或停止准则、分析计划与失败条件；不执行。")
     ("experiment" "work" "执行与复现" "design" nil "@@skill(reproduce-analysis)\n\n运行预先约定的实验；固定数据、代码、环境与随机种子，保存原始输出。")
     ("result-review" "checkpoint" "人工复核：结果与偏差" "experiment" nil "人工核对原始结果、负结果、偏差和与预注册计划的差异。")
     ("synthesis" "work" "证据与结论" "result-review" nil "@@skill(evidence-synthesis)\n\n把每个结论与可检查的证据跨度对应；区分支持、反驳和不足。")
     ("manuscript" "work" "论文初稿" "synthesis" nil "@@skill(intro-drafter)\n\n以已复核的结论写作；明确方法、结果、局限和负结果；不要凭空补引文。")
     ("submission-review" "checkpoint" "人工复核：投稿准备" "manuscript" nil "人工核对论文论断、图表、引用、可复现材料、伦理与目标期刊要求。"))
    ("theoretical"
     ("question" "question" "研究问题与命题" nil nil "写明定义、假设、目标命题及反例会是什么。")
     ("literature" "work" "文献与已有定理" "question" nil "@@skill(lit-review)\n\n阅读原始论文，记录先前结果、关键假设及证明技术。")
     ("gap-review" "checkpoint" "人工复核：新意与问题" "literature" nil "人工核对命题的新意、重要性及已有结果能否直接推出。")
     ("proof-plan" "work" "证明路线与关键引理" "gap-review" nil "@@skill(proof-plan)\n\n分解命题、找可能反例、列出引理与依赖；标明未证部分。")
     ("derivation" "work" "推导与形式检查" "proof-plan" nil "@@skill(proof-review)\n\n逐步推导，检查定义域、量词、边界情形和反例；保留失败路线。")
     ("result-review" "checkpoint" "人工复核：证明与反例" "derivation" nil "人工逐项核验关键引理、反例搜索、计算辅助证明和未解决空白。")
     ("synthesis" "work" "结论与证据" "result-review" nil "@@skill(evidence-synthesis)\n\n区分严格证明、数值证据和猜想；结论只覆盖已证条件。")
     ("manuscript" "work" "论文初稿" "synthesis" nil "@@skill(intro-drafter)\n\n写作定理、证明与局限；对照原文核实所有引用。")
     ("submission-review" "checkpoint" "人工复核：投稿准备" "manuscript" nil "人工核对命题、证明、引用、附录及目标期刊要求。")))
  "Each row is KEY, KIND, TITLE, PARENT, unused extension, and SOURCE.")

(defun noema-research-workflow-build (kind title)
  "Build an unsaved KIND work document named TITLE with a complete DAG."
  (let* ((template (assoc kind noema-research-workflow--templates))
         (document (noema-research-create-document title))
         (ids (make-hash-table :test #'equal))
         stages)
    (unless template (user-error "Unknown research workflow: %s" kind))
    (dolist (step (cdr template))
      (pcase-let ((`(,key ,node-kind ,heading ,parent ,_extension ,source) step))
        (let* ((parent-id (and parent (gethash parent ids)))
               (id (noema-research-create-work-node
                    document node-kind heading :parents (and parent-id (list parent-id))))
               (cell (noema-research-primary-cell document id)))
          (puthash "source" source cell)
          (puthash key id ids)
          (push (noema-research--table "key" key "node_id" id
                                        "gate" (if (equal node-kind "checkpoint") t :false))
                stages))))
    (puthash "workflow" (noema-research--table
                          "template" kind "version" 1 "stages" (vconcat (nreverse stages)))
             (noema-research-notebook-meta document))
    (when-let* ((errors (plist-get (noema-research-validate document) :errors)))
      (user-error "Workflow template is invalid: %s" (mapconcat #'cdr errors "; ")))
    document))

(defun noema-research-workflow--stages (document)
  "Return workflow stages of DOCUMENT as a list."
  (noema--sequence (noema-research--get
                    (noema-research--get (noema-research-notebook-meta document) "workflow")
                    "stages")))

(defun noema-research-workflow--approved-p (source)
  "Return non-nil if checkpoint SOURCE contains the human approval marker."
  (string-match-p "^Human review: approved by .+ at [0-9-]+T[0-9:]+" source))

(defun noema-research-workflow--next-stage (document)
  "Return first unfinished workflow stage in DOCUMENT."
  (seq-find
   (lambda (stage)
     (let* ((id (noema-research--get stage "node_id"))
            (node (noema-research-find-work-node document id))
            (cell (noema-research-primary-cell document id)))
       (and node cell
            (cond ((equal (noema-research-work-node-field node "kind") "question") nil)
                  ((eq (noema-research--get stage "gate") t)
                   (not (noema-research-workflow--approved-p
                         (noema-research-cell-source cell))))
                  (t (not (equal (noema-research-work-node-field node "state") "done")))))))
   (noema-research-workflow--stages document)))

(defun noema-research-workflow-assert-ready (document cell)
  "Refuse running CELL ahead of DOCUMENT's first unfinished template stage."
  (when-let* ((stages (noema-research-workflow--stages document))
              (stage (seq-find (lambda (entry)
                                 (equal (noema-research--get entry "node_id")
                                        (noema-research-cell-work-node-id cell))) stages))
              (next (noema-research-workflow--next-stage document)))
    (unless (eq stage next)
      (let* ((next-id (noema-research--get next "node_id"))
             (next-node (noema-research-find-work-node document next-id)))
        (user-error "Finish or review workflow stage “%s” before this Run"
                    (noema-research-work-node-field next-node "title"))))))

;;;###autoload
(defun noema-research-workflow-next ()
  "Go to the first unfinished stage of this research workflow."
  (interactive)
  (let* ((document (or noema-research--document (user-error "Not in a Noema work document")))
         (stage (noema-research-workflow--next-stage (noema-research-mode--sync))))
    (unless (noema-research-workflow--stages document)
      (user-error "This document has no workflow template"))
    (if stage
        (progn (noema-research-goto-cell (noema-research--get stage "node_id"))
               (message "Next research stage: %s" (noema-research--get stage "key")))
      (message "All workflow stages are complete"))))

;;;###autoload
(defun noema-research-workflow-approve-gate ()
  "Human-review the checkpoint at point and record approval in the document.
Only an explicit interactive confirmation can write this marker."
  (interactive)
  (let* ((document (or noema-research--document (user-error "Not in a Noema work document")))
         (cell (noema-research--cell-at-point))
         (id (and cell (noema-research-cell-work-node-id cell)))
         (stage (seq-find (lambda (entry)
                            (and (equal (noema-research--get entry "node_id") id)
                                 (eq (noema-research--get entry "gate") t)))
                          (noema-research-workflow--stages document)))
         (heading (and id (noema-research-work-node-field
                           (noema-research-find-work-node document id) "title"))))
    (unless stage (user-error "Point is not a workflow review checkpoint"))
    (unless (eq stage (noema-research-workflow--next-stage document))
      (user-error "Earlier workflow stages need completion before this review"))
    (when (noema-research-workflow--approved-p (noema-research-cell-source cell))
      (user-error "This checkpoint is already approved"))
    (unless (yes-or-no-p (format "Approve human review: %s? " heading))
      (user-error "Review not approved"))
    (noema-research-structure-edit
     (format "approve research checkpoint %s" heading)
     (lambda (current)
       (let* ((target (noema-research-primary-cell current id))
              (source (noema-research-cell-source target)))
         (puthash "source"
                  (concat (string-trim-right source) "\n\nHuman review: approved by "
                          (user-login-name) " at " (format-time-string "%FT%T%z") "\n")
                  target)
         id)))
    (message "Approved: %s" heading)))

(defvar noema-research-workflow-preview-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "C-c C-c") #'noema-research-workflow-create)
    map))

(define-derived-mode noema-research-workflow-preview-mode special-mode "Noema-Workflow"
  "Preview a complete research workflow before committing it.")

;;;###autoload
(defun noema-research-workflow-preview (kind file title)
  "Preview a KIND research workflow at FILE titled TITLE without writing it."
  (interactive
   (list (completing-read "Workflow: " (mapcar #'car noema-research-workflow--templates) nil t)
         (read-file-name "New .noema document: ")
         (read-string "Research title: ")))
  (let* ((path (expand-file-name (if (string-suffix-p ".noema" file t)
                                     file (concat file ".noema"))))
         (document (noema-research-workflow-build kind title))
         (buffer (get-buffer-create "*Noema Research Workflow Preview*")))
    (when (file-exists-p path) (user-error "Document already exists: %s" path))
    (with-current-buffer buffer
      (noema-research-workflow-preview-mode)
      (setq noema-research-workflow--preview-document document
            noema-research-workflow--preview-file path)
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "Research workflow: %s\nTarget: %s\n\n" kind path))
        (dolist (stage (noema-research-workflow--stages document))
          (let* ((id (noema-research--get stage "node_id"))
                 (node (noema-research-find-work-node document id)))
            (insert (format "%s  %s\n"
                            (if (eq (noema-research--get stage "gate") t) "REVIEW" "STAGE ")
                            (noema-research-work-node-field node "title")))))
        (insert "\nC-c C-c: create entire document    q: cancel\n")
        (goto-char (point-min))))
    (pop-to-buffer buffer)
    buffer))

(defun noema-research-workflow-create ()
  "Commit this previewed document as one validated write, then visit it."
  (interactive)
  (unless (derived-mode-p 'noema-research-workflow-preview-mode)
    (user-error "Not in a workflow preview"))
  (let ((path noema-research-workflow--preview-file)
        (document noema-research-workflow--preview-document))
    (unless (and path document) (user-error "No workflow is ready"))
    (when (file-exists-p path) (user-error "Document already exists: %s" path))
    (noema-project-ensure path)
    (noema-research-write-file path document)
    (find-file path)
    (unless (derived-mode-p 'noema-research-mode) (noema-research-mode))
    (message "Research workflow created: %s" path)))

(provide 'noema-research-workflow)
;;; noema-research-workflow.el ends here
