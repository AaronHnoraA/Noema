;;; noema-interaction-answer.el --- Answer-block output protocol for noema-interaction -*- lexical-binding: t; -*-

;;; Commentary:
;;
;; Unified output contract for noema-interaction CLI backends.
;;
;; Every prompt sent to an agent (one-shot exec or managed session) is wrapped
;; with `noema-interaction-wrap-prompt-with-output-contract', which instructs the
;; agent to place its final answer inside a single #+begin answer … #+end answer
;; block.  `noema-interaction-parse-answer-block' extracts that content.  Raw output
;; is preserved on failure so callers can surface it for debugging.
;;
;; Only one block type is defined: `answer'.  Do not extend this protocol
;; without a clear reason — the goal is a stable, minimal extraction contract.

;;; Code:

(require 'subr-x)

;; ── Output contract text ──────────────────────────────────────────────────────

(defconst noema-interaction-answer--contract
  "请你最终只把需要返回给 Emacs frontend 的有效内容放在下面这个 block 中：

#+begin answer
你的最终回答放这里
#+end answer

规则：
1. answer block 内只放最终答案。
2. 不要在 answer block 内放 spinner、日志、tool 调用细节或无关输出。
3. 不要输出多个 answer block。
4. 如果需要解释、代码、步骤、总结，都放在 answer block 内。
5. answer block 外部内容会被 noema-interaction 忽略。"
  "Output contract injected into every prompt sent to a CLI agent.")

;; ── Prompt wrapping ───────────────────────────────────────────────────────────

(defun noema-interaction-wrap-prompt-with-output-contract (prompt)
  "Return PROMPT wrapped with the answer-block output contract.
The wrapped prompt instructs the CLI agent to place its final answer
inside a single #+begin answer … #+end answer block."
  (concat "用户任务如下：\n\n"
          (string-trim prompt)
          "\n\n输出要求：\n\n"
          noema-interaction-answer--contract))

;; ── Answer-block parser ───────────────────────────────────────────────────────

(defun noema-interaction-parse-answer-block (output)
  "Extract the content of the last complete answer block from OUTPUT string.

Returns (cons :ok CONTENT) when a complete block is found, where
CONTENT is the trimmed text between #+begin answer and #+end answer.

Returns (cons :error OUTPUT) when no complete block is found.  The
original OUTPUT is preserved so callers can surface it for debugging.

When multiple complete blocks are present the last one is returned.
Whitespace around the block delimiters is tolerated.  Case is ignored."
  (if (not (stringp output))
      (cons :error "")
    (with-temp-buffer
      (insert output)
      (goto-char (point-max))
      ;; Search backwards for the last #+end answer line.
      (if (not (re-search-backward
                "^[[:space:]]*#\\+end[[:space:]]+answer[[:space:]]*$"
                nil t))
          (cons :error output)
        (let ((end-pos (line-beginning-position)))
          ;; From that end marker, search backwards for #+begin answer.
          (if (not (re-search-backward
                    "^[[:space:]]*#\\+begin[[:space:]]+answer[[:space:]]*$"
                    nil t))
              (cons :error output)
            (let* ((begin-end (line-end-position))
                   (content   (buffer-substring-no-properties
                               (1+ begin-end) end-pos)))
              (cons :ok (string-trim content)))))))))

;; ── Convenience helpers ───────────────────────────────────────────────────────

(defun noema-interaction-answer-extract (output &optional debug-buffer-name)
  "Extract answer from OUTPUT, logging parse failures.

On success returns the answer string.  On failure logs a warning with
the raw output and returns nil.  When DEBUG-BUFFER-NAME is non-nil the
raw output is also appended to a buffer of that name for inspection."
  (let ((result (noema-interaction-parse-answer-block output)))
    (pcase result
      (`(:ok . ,content) content)
      (`(:error . ,raw)
       (display-warning
        '(noema-interaction answer)
        (format "noema-interaction: no #+begin answer block found in CLI output.%s"
                (if (and (stringp raw) (not (string-empty-p raw)))
                    (format "\n\nRaw output:\n%s" raw)
                  ""))
        :warning)
       (when (and debug-buffer-name (stringp raw) (not (string-empty-p raw)))
         (let ((buf (get-buffer-create debug-buffer-name)))
           (with-current-buffer buf
             (goto-char (point-max))
             (insert (format "\n[%s] Raw CLI output:\n%s\n"
                             (format-time-string "%H:%M:%S")
                             raw)))))
       nil))))

(provide 'noema-interaction-answer)
;;; noema-interaction-answer.el ends here
