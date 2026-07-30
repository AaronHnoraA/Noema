;;; "Compiled" snippets and support files for `c-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'c-mode
		     '((".."
			(progn
			  (progn
			    (when
				(looking-back "[ 	]+"
					      (line-beginning-position))
			      (delete-region (match-beginning 0)
					     (match-end 0)))
			    (insert "->")))
			".. => -> (eat spaces, no newline)"
			(not (nth 8 (syntax-ppss))) nil nil
			"/Users/hc/.config/emacs/snippets/c-mode/dot-dot"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
