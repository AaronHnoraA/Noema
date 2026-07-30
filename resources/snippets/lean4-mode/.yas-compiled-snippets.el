;;; "Compiled" snippets and support files for `lean4-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'lean4-mode
		     '(("var" "variable (${1:n : ℕ})$0\n"
			"variable declaration" nil ("declarations")
			nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/variable"
			nil nil)
		       ("use" "use ${1:witness}\n$0\n" "use tactic"
			nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/use"
			nil nil)
		       ("thm"
			"theorem ${1:name} ${2:(${3:args} : ${4:Type})} : ${5:statement} := by\n  $0\n"
			"theorem declaration" nil ("declarations") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/theorem"
			nil nil)
		       ("smp" "simp only [${1:lemmas}]$0\n"
			"simp with lemmas" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/simp"
			nil nil)
		       ("sec"
			"section ${1:Name}\n\n$0\n\nend ${1:Name}\n"
			"section block" nil ("structure") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/section"
			nil nil)
		       ("ref" "refine ${1:?_}$0\n" "refine tactic" nil
			("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/refine"
			nil nil)
		       ("rca"
			"rcases ${1:h} with ⟨${2:a}, ${3:b}⟩\n$0\n"
			"rcases pattern" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/rcases"
			nil nil)
		       ("obt"
			"obtain ⟨${1:a}, ${2:b}⟩ := ${3:h}\n$0\n"
			"obtain pattern match" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/obtain"
			nil nil)
		       ("ns"
			"namespace ${1:Name}\n\n$0\n\nend ${1:Name}\n"
			"namespace block" nil ("structure") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/namespace"
			nil nil)
		       ("|-->" "⟼\n" "long mapsto" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/longmapsto"
			nil nil)
		       ("lem"
			"lemma ${1:name} ${2:(${3:args} : ${4:Type})} : ${5:statement} := by\n  $0\n"
			"lemma declaration" nil ("declarations") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/lemma"
			nil nil)
		       ("ind"
			"induction ${1:n} with\n| zero => $0\n| succ ${2:n} ${3:ih} => sorry\n"
			"induction tactic" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/induction"
			nil nil)
		       ("hav" "have ${1:h} : ${2:type} := by\n  $0\n"
			"have tactic" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/have"
			nil nil)
		       ("fext" "funext ${1:x}\n$0\n" "funext" nil
			("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/funext"
			nil nil)
		       ("exam"
			"example : ${1:statement} := by\n  $0\n"
			"anonymous example" nil ("declarations") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/example"
			nil nil)
		       ("''" "″\n" "double prime" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/double_prime"
			nil nil)
		       ("def" "def ${1:name} : ${2:Type} :=\n  $0\n"
			"definition" nil ("declarations") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/def"
			nil nil)
		       ("conv" "conv in ${1:expr} => $0\n"
			"conv tactic" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/conv"
			nil nil)
		       ("con" "constructor\n· $0\n· sorry\n"
			"constructor + focus" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/constructor"
			nil nil)
		       ("calc"
			"calc ${1:lhs}\n  _ = ${2:rhs} := by $0\n"
			"calc block" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/calc"
			nil nil)
		       ("byc" "by_contra ${1:h}\n$0\n"
			"proof by contradiction" nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/by_contra"
			nil nil)
		       ("app" "apply ${1:lemma}$0\n" "apply tactic"
			nil ("tactics") nil
			"/Users/hc/.config/emacs/snippets/lean4-mode/apply"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
