;;; "Compiled" snippets and support files for `c++-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'c++-mode
		     '(("std::cout" "std::cout << ${1} << '\\n';\n"
			"std::cout" nil nil nil
			"/Users/hc/.config/emacs/snippets/c++-mode/std_cout_std_cout"
			nil nil)
		       (".."
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
			"/Users/hc/.config/emacs/snippets/c++-mode/dot-dot"
			nil nil)
		       ("#if" "#ifdef USE_DD4HEP\n${1}\n#endif\n"
			"#if" nil nil nil
			"/Users/hc/.config/emacs/snippets/c++-mode/_if_if"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
