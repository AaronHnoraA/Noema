;;; "Compiled" snippets and support files for `markdown-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'markdown-mode
		     '(("warn"
			"#+begin warning ${1:title}\n${2:Warning.}\n#+end warning\n$0\n"
			"Warning block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/warning"
			nil nil)
		       ("tocignore" "<!-- omit in toc -->$0\n"
			"toc ignore" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/tocignore"
			nil nil)
		       ("toc" "[toc]\n$0\n" "Table of contents" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/toc"
			nil nil)
		       ("tikz"
			"#+ begin tikz ${1:diagram-id} ${2:20260525-120000}\n\\draw[->] (0,0) -- (2,0) node[right] {$x$};\n\\draw[->] (0,0) -- (0,2) node[above] {$y$};\n\\draw[domain=0:1.4, smooth, variable=\\x, blue] plot ({\\x},{\\x*\\x});\n$0\n#+ end tikz\n"
			"TikZ diagram" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/tikz"
			nil nil)
		       ("thm"
			"#+begin theorem ${1:name}\n${2:Statement.}\n#+end theorem\n$0\n"
			"Theorem block" nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/theorem"
			nil nil)
		       ("todo" "- [ ] ${1:Task}$0\n" "Task item" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/task"
			nil nil)
		       ("table"
			"| ${1:Name} | ${2:Value} |\n| --- | --- |\n| ${3:item} | ${4:value} |\n$0\n"
			"Markdown table" nil ("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/table"
			nil nil)
		       ("sum"
			"#+begin summary ${1:title}\n${2:Summary.}\n#+end summary\n$0\n"
			"Summary block" nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/summary"
			nil nil)
		       ("prop"
			"#+begin proposition ${1:name}\n${2:Statement.}\n#+end proposition\n$0\n"
			"Proposition block" nil ("Noema local")
			nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/proposition"
			nil nil)
		       ("propb"
			"#+begin property ${1:name}\n${2:Property.}\n#+end property\n$0\n"
			"Property block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/property"
			nil nil)
		       ("proof"
			"#+begin proof\n${1:Proof.}\n#+end proof\n$0\n"
			"Proof block" nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/proof"
			nil nil)
		       ("org"
			"#+begin ${1:note} ${2:title}\n${3:Content.}\n#+end ${1:note}\n$0\n"
			"Generic org-env block" nil
			("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/org-block"
			nil nil)
		       ("note"
			"#+begin note ${1:title}\n${2:Note.}\n#+end note\n$0\n"
			"Note block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/note"
			nil nil)
		       ("meta"
			"#+begin meta\ntags: ${1:tag}\nid: ${2:id}\n#+end meta\n$0\n"
			"Meta block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/meta"
			nil nil)
		       ("mer"
			"```mermaid\n${1:graph TD\n  A --> B}\n```\n$0\n"
			"Mermaid diagram" nil ("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/mermaid"
			nil nil)
		       ("mind"
			"```marmind\nmindmap\n  root((${1:Topic}))\n    ${2:Branch}\n      ${3:Detail}\n```\n$0\n"
			"Interactive mind map" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/marmind"
			nil nil)
		       ("link" "[${1:text}](${2:url})$0\n"
			"Markdown link" nil ("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/link"
			nil nil)
		       ("icode" "`$1` $0\n" "Inline Code fence" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/line-code"
			nil nil)
		       ("lem"
			"#+begin lemma ${1:name}\n${2:Statement.}\n#+end lemma\n$0\n"
			"Lemma block" nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/lemma"
			nil nil)
		       (";" "$${1:x}$ $0\n" "Inline math" nil
			("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/inline-math"
			nil nil)
		       ("info"
			"#+begin info ${1:title}\n${2:Information.}\n#+end info\n$0\n"
			"Info block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/info"
			nil nil)
		       ("img" "![${1:alt}](${2:path})$0\n"
			"Markdown image" nil ("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/image"
			nil nil)
		       ("html" "#+begin html\n$1\n#+end html\n$0\n"
			"HTML block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/html"
			nil nil)
		       ("fold"
			"#+begin fold ${1:**Details**}\n${2:Hidden content.}\n#+end fold\n$0\n"
			"Fold block" nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/fold"
			nil nil)
		       ("ex"
			"#+begin example ${1:name}\n${2:Example.}\n#+end example\n$0\n"
			"Example block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/example"
			nil nil)
		       (":" "$$\n$1\n$$\n$0\n" "Display math" nil
			("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/display-math"
			nil nil)
		       ("def"
			"#+begin definition ${1:name}\n${2:Definition.}\n#+end definition\n$0\n"
			"Definition block" nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/definition"
			nil nil)
		       ("cor"
			"#+begin corollary ${1:name}\n${2:Statement.}\n#+end corollary\n$0\n"
			"Corollary block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/corollary"
			nil nil)
		       ("comment"
			"#+begin comment ${1:title}\n${2:Comment.}\n#+end comment\n$0\n"
			"Comment block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/comment"
			nil nil)
		       ("code"
			"```${1:language}\n${2:code}\n```\n$0\n"
			"Code fence" nil ("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/code"
			nil nil)
		       ("quote"
			"> ${1:Quote.}\n> \n> -- ${2:Source}\n$0\n"
			"Quote callout" nil ("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/callout"
			nil nil)
		       (";bb"
			"#+begin_${1:block}\n$2\n#+end_${1}\n$0\n"
			"org special block (definition/theorem/...)"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/bb"
			nil nil)
		       ("att"
			"#+begin attention ${1:title}\n${2:Pay attention to this point.}\n#+end attention\n$0\n"
			"Attention block" nil ("Noema blocks") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/attention"
			nil nil)
		       ("anchor" "{#${1:anchor}}$0\n" "Anchor tag" nil
			("Noema syntax") nil
			"/Users/hc/.config/emacs/snippets/markdown-mode/anchor"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
