;;; "Compiled" snippets and support files for `tex-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'tex-mode
		     '(("zzzz" "\\zeta\n" "Zeta" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/zzzz"
			nil nil)
		       ("xx" "\\times\n" "Times" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/xx"
			nil nil)
		       ("xor" "# --\n\\oplus$0\n" "XOR" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/xor"
			nil nil)
		       ("xelatex"
			"# --\n%! TeX program = xelatex\n$0\n"
			"Xelatex" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/xelatex"
			nil nil)
		       ("while"
			"\\While{$1}\n	\\State $0\n\\EndWhile\n"
			"Algorithm:While" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/while"
			nil nil)
		       ("warning"
			"# --\n#+begin_warning\n$0\n#+end_warning\n"
			"Org warning block" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/warning"
			nil nil)
		       ("vvmatrix"
			"# --\n\\begin{Vmatrix}\n$1\n\\end{Vmatrix}\n"
			"\\begin{Vmatrix}…\\end{Vmatirx}" nil nil nil
			"/Users/hc/.config/emacs/snippets/tex-mode/vvmatrix"
			nil nil)
		       ("vmatrix"
			"# --\n\\begin{vmatrix}\n$1\n\\end{vmatrix}\n"
			"\\begin{vmatrix}…\\end{vmatirx}" nil nil nil
			"/Users/hc/.config/emacs/snippets/tex-mode/vmatrix"
			nil nil)
		       ("vmat"
			"\\begin{vmatrix}\n$1\n\\end{vmatrix}\n"
			"Vmatrix" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/vmat-2"
			nil nil)
		       ("vec" "\\vec{$1}$2\n" "Vector" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/vec"
			nil nil)
		       ("var"
			"# --\n\\operatorname{Var}\\left[${1:X}\\right]$0\n"
			"Variance" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/var"
			nil nil)
		       ("uuuu" "\\upsilon\n" "Upsilon (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/uuuu-2"
			nil nil)
		       ("und" "\\underline{$1}$2\n" "Underline" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/und"
			nil nil)
		       ("tttt" "\\theta\n" "Theta (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tttt-2"
			nil nil)
		       ("trace" "\\mathrm{Tr}\n" "Trace" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/trace"
			nil nil)
		       ("toc" "# --\n#+begin_toc\n$0\n#+end_toc\n"
			"Org toc block" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/toc"
			nil nil)
		       ("tip" "# --\n#+begin_tip\n$0\n#+end_tip\n"
			"Org tip block" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tip"
			nil nil)
		       ("tildeO"
			"# --\n\\widetilde{O}\\left(${1:f(n)}\\right)$0\n"
			"Soft O" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tildeO"
			nil nil)
		       ("tilde" "\\tilde{$1}$2\n" "Tilde Accent" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tilde"
			nil nil)
		       ("tikzpath"
			"\\path (${1:A}) edge${2:[${3:->}]} node${4:[${5:above}]} {${6:label}} (${7:B});$0\n"
			"TikZ path" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tikzpath"
			nil nil)
		       ("tikznode"
			"\\node (${1:name}) at (${2:0,0}) {${3:label}};$0\n"
			"TikZ node" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tikznode"
			nil nil)
		       ("tikzdraw"
			"\\draw${1:[${2:thick}]} (${3:A}) -- (${4:B});$0\n"
			"TikZ draw line" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tikzdraw"
			nil nil)
		       ("thml"
			"# --\n\\begin{theorem}{$1}\\label{thm:$1}\n	$2\n\\end{theorem}\n$0\n"
			"Theorem (with label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/thml"
			nil nil)
		       ("thm" "# --\n#+begin_thm\n$0\n#+end_thm\n"
			"Org theorem alias block" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/thm"
			nil nil)
		       ("theorem"
			"# --\n\\begin{theorem}{$1}\n	$2\n\\end{theorem}\n$0\n"
			"Theorem (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/theorem"
			nil nil)
		       ("text" "\\text{$1}$2\n" "Text Environment" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/text"
			nil nil)
		       ("tcOt"
			"\\widetilde{O}\\!\\left(${1:n}\\right)$0\n"
			"Soft-O" nil ("TCS symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tctildeo"
			nil nil)
		       ("tcred" "\\leq_m^p$0\n" "Many-one reduction"
			nil ("TCS symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tcred"
			nil nil)
		       ("tclog"
			"\\operatorname{polylog}\\!\\left(${1:n}\\right)$0\n"
			"Polylogarithmic bound" nil ("TCS symbols")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tcpolylog"
			nil nil)
		       ("tcpoly"
			"\\operatorname{poly}\\!\\left(${1:n}\\right)$0\n"
			"Polynomial bound" nil ("TCS symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tcpoly"
			nil nil)
		       ("tcor" "${1:\\mathsf{P}}^{${2:A}}$0\n"
			"Oracle class" nil ("TCS symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tcoracle"
			nil nil)
		       ("tccomp"
			"${1:\\mathsf{NP}}\\text{-complete}$0\n"
			"Complete problem class" nil ("TCS symbols")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tccomplete"
			nil nil)
		       ("tccls" "\\mathsf{${1:P}}$0\n"
			"Complexity class" nil ("TCS symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tcclass"
			nil nil)
		       ("tcO" "O\\!\\left(${1:n}\\right)$0\n" "Big-O"
			nil ("TCS symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tcbigo"
			nil nil)
		       ("tayl"
			"$1($2 + $3) = $1($2) + $1'($2)$3 + $1''($2) \\frac{$3^{2}}{2!} + \\dots$4\n"
			"Taylor Expansion" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tayl"
			nil nil)
		       ("table:ref"
			"# --\n${1:Table}~\\ref{tab:$2}$0\n"
			"Table:Ref" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/table_ref"
			nil nil)
		       ("table:acm:*"
			"# --\n\\begin{table*}\n	\\caption{$1}\\label{tab:$2}\n	\\begin{tabular}{${3:ccl}}\n		\\toprule\n		$4\n		a & b & c \\\\\\\\\n		\\midrule\n		d & e & f \\\\\\\\\n		\\bottomrule\n	\\end{tabular}\n\\end{table*}\n$0\n"
			"Table:ACM:*" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/table_acm-2"
			nil nil)
		       ("table:acm"
			"# --\n\\begin{table}\n	\\caption{$1}\\label{tab:$2}\n	\\begin{tabular}{${3:ccl}}\n		\\toprule\n		$4\n		a & b & c \\\\\\\\\n		\\midrule\n		d & e & f \\\\\\\\\n		\\bottomrule\n	\\end{tabular}\n\\end{table}\n$0\n"
			"Table:ACM" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/table_acm"
			nil nil)
		       ("table"
			"# --\n\\begin{table}\n	\\caption{$1}\\label{tab:$2}\n	\\begin{center}\n		\\begin{tabular}[c]{l|l}\n			\\hline\n			\\multicolumn{1}{c|}{\\textbf{$3}} & \n			\\multicolumn{1}{c}{\\textbf{$4}} \\\\\\\\\n			\\hline\n			a & b \\\\\\\\\n			c & d \\\\\\\\\n			$5\n			\\hline\n		\\end{tabular}\n	\\end{center}\n\\end{table}\n$0\n"
			"Table" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/table"
			nil nil)
		       ("tabl"
			"# --\n\\begin{tabular}{${1:c}}\\label{tab:$2}\n$0\n\\end{tabular}\n"
			"Tabular (with label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tabl"
			nil nil)
		       ("tab"
			"# --\n\\begin{tabular}{${1:c}}\n$0\n\\end{tabular}\n"
			"Tabular (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/tab"
			nil nil)
		       (":t" "\\vartheta\n" "Vartheta" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/t"
			nil nil)
		       ("sup=" "\\supseteq\n" "Superset Equal" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sup"
			nil nil)
		       ("summary"
			"# --\n#+begin_summary\n$0\n#+end_summary\n"
			"Org summary block" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/summary"
			nil nil)
		       ("sum" "\\sum\n" "Sum" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sum"
			nil nil)
		       ("subsl"
			"# --\n\\subsubsection{$1}\\label{sec:$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Sub Sub Section (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/subsl"
			nil nil)
		       ("subs"
			"# --\n\\subsubsection{$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Sub Sub Section (no label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/subs"
			nil nil)
		       ("subpl"
			"# --\n\\subparagraph{$1}\\label{subp:$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Sub Paragraph (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/subpl"
			nil nil)
		       ("subp"
			"# --\n\\subparagraph{$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Sub Paragraph (no label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/subp"
			nil nil)
		       ("subl"
			"# --\n\\subsection{$1}\\label{sub:$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Sub Section (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/subl"
			nil nil)
		       ("subfile" "# --\n\\subfile{$1}\n$0\n"
			"Subfile" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/subfile"
			nil nil)
		       ("sub=" "\\subseteq\n" "Subset Equal" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sub-2"
			nil nil)
		       ("sub"
			"# --\n\\subsection{$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Sub Section (no label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sub"
			nil nil)
		       ("sts" "_\\text{$1}\n" "Text Subscript" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sts"
			nil nil)
		       ("state" "\\State $1\n" "Algorithm:State" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/state"
			nil nil)
		       ("ssss" "\\sigma\n" "Sigma (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ssss-2"
			nil nil)
		       ("sr" "^{2}\n" "Square" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sr"
			nil nil)
		       ("sq" "\\sqrt{ $1 }$2\n" "Square Root" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sq"
			nil nil)
		       ("spl"
			"# --\n\\begin{split}\n	$0\n\\end{split}\n"
			"Split" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/spl"
			nil nil)
		       ("solution"
			"# --\n\\begin{solution}\n	$1\n\\end{solution}\n$0\n"
			"Solution" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/solution"
			nil nil)
		       ("=>" "\\implies\n" "Implies" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-9"
			nil nil)
		       ("===" "\\equiv\n" "Equiv" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-8"
			nil nil)
		       ("=<" "\\impliedby\n" "Implied By" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-7"
			nil nil)
		       ("<=" "\\leq\n" "Less or Equal" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-6"
			nil nil)
		       ("<<" "\\ll\n" "Much Less" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-5"
			nil nil)
		       ("**" "\\cdot\n" "Dot" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-4"
			nil nil)
		       ("\"" "\\text{$1}$2\n"
			"Text Environment (short)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-3"
			nil nil)
		       ("!>" "\\mapsto\n" "Maps To" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-2"
			nil nil)
		       ("_" "_{$1}$2\n" "Subscript" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-13"
			nil nil)
		       ("\\\\\\" "\\setminus\n" "Set Minus" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-12"
			nil nil)
		       (">>" "\\gg\n" "Much Greater" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-11"
			nil nil)
		       (">=" "\\geq\n" "Greater or Equal" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet-10"
			nil nil)
		       ("!=" "\\neq\n" "Not Equal" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/snippet"
			nil nil)
		       ("simm" "\\sim\n" "Similar To" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/simm"
			nil nil)
		       ("sim=" "\\simeq\n" "Approx Equal" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sim"
			nil nil)
		       ("setsubfile"
			"# --\n\\documentclass[$1]{subfiles}\n\\graphicspath{{$2}}\n$0\n"
			"SetSubfile" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/setsubfile"
			nil nil)
		       ("set" "\\{ $1 \\}$2\n" "Set" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/set"
			nil nil)
		       ("section:ref"
			"# --\n${1:Section}~\\ref{sec:$2}$0\n"
			"Section:Ref" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/section_ref"
			nil nil)
		       ("secpar" "# --\n1^{${1:\\lambda}}$0\n"
			"Security parameter" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/secpar"
			nil nil)
		       ("secl"
			"# --\n\\section{$1}\\label{sec:$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Section (with label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/secl"
			nil nil)
		       ("sec"
			"# --\n\\section{$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Section (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sec"
			nil nil)
		       ("sch"
			"# --\ni\\hbar \\frac{\\partial}{\\partial t}\\lvert\\psi(t)\\rangle = H\\lvert\\psi(t)\\rangle$0\n"
			"Schrodinger equation" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sch"
			nil nil)
		       ("sample"
			"# --\n${1:x} \\xleftarrow{\\mathrm{R}} ${2:S}$0\n"
			"Random sampling" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/sample"
			nil nil)
		       ("rm" "\\mathrm{$1}$2\n" "Roman" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/rm"
			nil nil)
		       ("remark"
			"# --\n\\begin{remark}\n	$1\n\\end{remark}\n$0\n"
			"Remark" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/remark"
			nil nil)
		       ("#region" "# --\n%#Region $0\n" "Region Start"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/region"
			nil nil)
		       ("ref" "# --\n\\ref{$1: $2}$0\n" "Reference"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ref"
			nil nil)
		       ("redm" "# --\n${1:A} \\le_m^p ${2:B}$0\n"
			"Polynomial many-one reduction" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/redm"
			nil nil)
		       ("redT" "# --\n${1:A} \\le_T^p ${2:B}$0\n"
			"Polynomial Turing reduction" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/redT"
			nil nil)
		       ("rd" "^{$1}$2\n" "Raise to Power" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/rd"
			nil nil)
		       ("qvar"
			"\\operatorname{Var}_{${1:\\rho}}\\!\\left(${2:A}\\right)$0\n"
			"Variance" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qvar"
			nil nil)
		       ("question"
			"# --\n#+begin_question\n$0\n#+end_question\n"
			"Org question block" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/question"
			nil nil)
		       ("qtr"
			"\\operatorname{Tr}\\!\\left(${1:X}\\right)$0\n"
			"Trace" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qtrace"
			nil nil)
		       ("qten" "${1:A}\\otimes ${2:B}$0\n"
			"Tensor product" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qtensor"
			nil nil)
		       ("qrho" "\\rho_{${1:A}}$0\n" "Density operator"
			nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qrho"
			nil nil)
		       ("qptr"
			"\\operatorname{Tr}_{${1:B}}\\!\\left(${2:\\rho_{AB}}\\right)$0\n"
			"Partial trace" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qptrace"
			nil nil)
		       ("qproj"
			"\\ket{${1:\\psi}}\\!\\bra{${1:\\psi}}$0\n"
			"Projector" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qproj"
			nil nil)
		       ("qpovm" "\\{${1:E_i}\\}_{${2:i}}$0\n"
			"POVM elements" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qpovm"
			nil nil)
		       ("qpauli" "\\sigma_{${1:x}}$0\n"
			"Pauli matrices" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qpauli"
			nil nil)
		       ("qkraus"
			"\\sum_{${1:i}} ${2:K_i}\\,${3:\\rho}\\,${2:K_i}^{\\dagger}$0\n"
			"Kraus decomposition" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qkraus"
			nil nil)
		       ("qkb"
			"\\ket{${1:\\psi}}\\!\\bra{${2:\\phi}}$0\n"
			"Ket-bra operator" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qketbra"
			nil nil)
		       ("qket" "\\ket{${1:\\psi}}$0\n" "Quantum ket"
			nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qket"
			nil nil)
		       ("qH" "H$0\n" "Hadamard gate" nil
			("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qhadamard"
			nil nil)
		       ("qgate" "# --\n\\operatorname{${1:U}}$0\n"
			"Quantum gate" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qgate"
			nil nil)
		       ("qft"
			"# --\n\\operatorname{QFT}_{${1:n}}\\lvert ${2:x}\\rangle =\n\\frac{1}{\\sqrt{${3:2^n}}}\\sum_{${4:y}=0}^{${3:2^n}-1}\ne^{2\\pi i ${2:x}${4:y}/${3:2^n}}\\lvert ${4:y}\\rangle$0\n"
			"Quantum Fourier transform" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qft"
			nil nil)
		       ("qexp"
			"\\langle ${1:A} \\rangle_{${2:\\rho}}$0\n"
			"Expectation value" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qexpval"
			nil nil)
		       ("qdag" "${1:U}^{\\dagger}$0\n" "Dagger" nil
			("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qdag"
			nil nil)
		       ("qcomm" "\\left[${1:A},${2:B}\\right]$0\n"
			"Commutator" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qcomm"
			nil nil)
		       ("qcx" "\\operatorname{CNOT}$0\n" "CNOT gate"
			nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qcnot"
			nil nil)
		       ("qcirc"
			"# --\n\\begin{quantikz}\n\\lstick{\\ket{0}} & \\gate{H} & \\ctrl{1} & \\qw \\\\\n\\lstick{\\ket{0}} & \\qw      & \\targ{}  & \\qw\n\\end{quantikz}\n$0\n"
			"Quantikz circuit" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qcirc"
			nil nil)
		       ("qchan"
			"\\mathcal{${1:N}}\\!\\left(${2:\\rho}\\right)$0\n"
			"Quantum channel" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qchannel"
			nil nil)
		       ("qbr" "\\braket{${1:\\phi}|${2:\\psi}}$0\n"
			"Bra-ket inner product" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qbraket"
			nil nil)
		       ("qbra" "\\bra{${1:\\psi}}$0\n" "Quantum bra"
			nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qbra"
			nil nil)
		       ("qbell"
			"\\frac{1}{\\sqrt{2}}\\left(\\ket{00}+\\ket{11}\\right)$0\n"
			"Bell state" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qbell"
			nil nil)
		       ("qanti" "\\left\\{${1:A},${2:B}\\right\\}$0\n"
			"Anticommutator" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qanticomm"
			nil nil)
		       ("qad"
			"${1:U}\\,${2:\\rho}\\,${1:U}^{\\dagger}$0\n"
			"Adjoint action" nil ("QC symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/qadjoint"
			nil nil)
		       ("pu" "\\pu{ $1 }\n" "Physical Units" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/pu"
			nil nil)
		       ("ptr"
			"# --\n\\operatorname{Tr}_{${1:B}}\\left(\\rho_{${2:AB}}\\right)$0\n"
			"Partial trace" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ptr"
			nil nil)
		       ("proposition"
			"# --\n\\begin{proposition}{$1}\n		$2\n\\end{proposition}\n$0\n"
			"Proposition (no label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/proposition"
			nil nil)
		       ("propl"
			"# --\n\\begin{proposition}{$1}\\label{pro:$1}\n		$2\n\\end{proposition}\n$0\n"
			"Proposition (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/propl"
			nil nil)
		       ("property"
			"# --\n#+begin_property\n$0\n#+end_property\n"
			"Org property block" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/property"
			nil nil)
		       ("prop" "\\propto\n" "Proportional To" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/prop"
			nil nil)
		       ("proof"
			"# --\n\\begin{proof}\n	$1\n\\end{proof}\n$0\n"
			"Proof" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/proof"
			nil nil)
		       ("proj"
			"# --\n\\lvert ${1:\\psi}\\rangle\\langle ${1:\\psi}\\rvert $0\n"
			"Projector" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/proj"
			nil nil)
		       ("prod" "\\prod\n" "Product" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/prod"
			nil nil)
		       ("problemset"
			"# --\n\\begin{problemset}\n	$1\n\\end{problemset}\n$0\n"
			"Problemset" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/problemset"
			nil nil)
		       ("problem"
			"# --\n\\begin{problem}\n	$1\n\\end{problem}\n$0\n"
			"Problem" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/problem"
			nil nil)
		       ("ppt" "# --\n\\mathsf{PPT}$0\n"
			"PPT adversary" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ppt"
			nil nil)
		       ("povm" "# --\n\\{${1:E_m}\\}_{${2:m}}$0\n"
			"POVM" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/povm"
			nil nil)
		       ("postulate"
			"# --\n\\begin{postulate}{$1}\n		$2\n\\end{postulate}\n$0\n"
			"Postulate (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/postulate"
			nil nil)
		       ("postl"
			"# --\n\\begin{postulate}{$1}\\label{pos:$1}\n		$2\n\\end{postulate}\n$0\n"
			"Postulate (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/postl"
			nil nil)
		       ("polylog"
			"# --\n\\operatorname{polylog}\\left(${1:n}\\right)$0\n"
			"Polylogarithmic" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/polylog"
			nil nil)
		       ("poly"
			"# --\n\\operatorname{poly}\\left(${1:n}\\right)$0\n"
			"Polynomial" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/poly"
			nil nil)
		       ("pmatrix"
			"# --\n\\begin{pmatrix}\n$1\n\\end{pmatrix}\n"
			"\\begin{pmatrix}…\\end{pmatirx}" nil nil nil
			"/Users/hc/.config/emacs/snippets/tex-mode/pmatrix"
			nil nil)
		       ("pmat"
			"\\begin{pmatrix}\n$1\n\\end{pmatrix}\n"
			"Pmatrix" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/pmat"
			nil nil)
		       ("plaininline" "# --\n\\lstinline{$1}$0\n"
			"lstinline" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/plaininline"
			nil nil)
		       ("plain"
			"# --\n\\begin{lstlisting}\n	$1\n\\end{lstlisting}\n$0\n"
			"lstlisting" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/plain"
			nil nil)
		       ("part"
			"# --\n\\begin{part}\n	$0\n\\end{part}\n"
			"Part" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/part"
			nil nil)
		       ("parl"
			"# --\n\\paragraph{$1}\\label{par:$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Paragraph (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/parl"
			nil nil)
		       ("para" "\\parallel\n" "Parallel" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/para"
			nil nil)
		       ("par"
			"# --\n\\paragraph{$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Paragraph (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/par"
			nil nil)
		       ("page" "# --\n${1:page}~\\pageref{$2}$0\n"
			"Page" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/page"
			nil nil)
		       ("overview"
			"# --\n#+begin_overview\n$0\n#+end_overview\n"
			"Org overview block" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/overview"
			nil nil)
		       ("outlineexp"
			"# --\n\\\\[\n	$1\n\\\\]\n$0\n" "OutlineExp"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/outlineexp"
			nil nil)
		       ("outer" "\\ket{$1} \\bra{$1} $2\n"
			"Outer Product" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/outer"
			nil nil)
		       ("ox" "\\otimes\n" "Tensor product" nil
			("Noema local") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/otimes"
			nil nil)
		       ("orr" "\\cup\n" "Union" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/orr"
			nil nil)
		       ("oracle"
			"# --\n\\mathcal{${1:O}}\\left(${2:x}\\right)$0\n"
			"Oracle" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/oracle"
			nil nil)
		       ("o+" "\\oplus\n" "Direct sum" nil
			("Noema local") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/oplus"
			nil nil)
		       ("openlink"
			"# --\nhttp://10.31.2.53/openlink.html?link=$0\n"
			"NasOpenlink" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/openlink"
			nil nil)
		       ("oooo" "\\omega\n" "Omega (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/oooo-2"
			nil nil)
		       ("ooo" "\\infty\n" "Infinity" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ooo"
			nil nil)
		       ("ome" "\\omega\n" "Omega (alt)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ome-2"
			nil nil)
		       ("oint" "\\oint\n" "Contour Integral" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/oint"
			nil nil)
		       ("oinf" "\\int_{0}^{\\infty} $1 \\, d$2 $3\n"
			"Integral 0 to Infinity" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/oinf"
			nil nil)
		       ("npcomplete"
			"# --\n\\mathsf{NP}\\text{-complete}$0\n"
			"NP-complete" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/npcomplete"
			nil nil)
		       ("notin" "\\not\\in\n" "Not Element Of" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/notin"
			nil nil)
		       ("note"
			"# --\n\\begin{note}\n	$1\n\\end{note}\n$0\n"
			"Note" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/note"
			nil nil)
		       ("norm" "\\lvert $1 \\rvert $2\n"
			"Absolute Value" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/norm-2"
			nil nil)
		       ("negl"
			"# --\n\\operatorname{negl}\\left(${1:\\lambda}\\right)$0\n"
			"Negligible" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/negl"
			nil nil)
		       ("nabl" "\\nabla\n" "Nabla" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/nabl"
			nil nil)
		       ("msun" "M_{\\odot}\n" "Solar Mass" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/msun"
			nil nil)
		       ("mspan"
			"\\operatorname{span}\\left\\{${1:v_i}\\right\\}$0\n"
			"Span" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mspan"
			nil nil)
		       ("mset"
			"\\left\\{${1:x}\\mid ${2:condition}\\right\\}$0\n"
			"Set builder" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mset"
			nil nil)
		       ("mrank"
			"\\operatorname{rank}\\!\\left(${1:A}\\right)$0\n"
			"Rank" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mrank"
			nil nil)
		       ("mPr" "\\Pr\\!\\left[${1:E}\\right]$0\n"
			"Probability" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mprob"
			nil nil)
		       ("mod" "|$1|$2\n" "Modulus" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mod"
			nil nil)
		       ("mnorm" "\\left\\|${1:x}\\right\\|$0\n" "Norm"
			nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mnorm"
			nil nil)
		       ("mker" "\\ker\\!\\left(${1:T}\\right)$0\n"
			"Kernel" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mker"
			nil nil)
		       ("minn"
			"\\left\\langle ${1:x}, ${2:y} \\right\\rangle$0\n"
			"Inner product" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/minner"
			nil nil)
		       ("mim"
			"\\operatorname{im}\\!\\left(${1:T}\\right)$0\n"
			"Image" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mim"
			nil nil)
		       ("mfloor"
			"\\left\\lfloor ${1:x} \\right\\rfloor$0\n"
			"Floor" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mfloor"
			nil nil)
		       ("mE"
			"\\mathbb{E}_{${1:x}}\\!\\left[${2:f(x)}\\right]$0\n"
			"Expectation" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mexpect"
			nil nil)
		       ("me"
			"\\langle ${1:\\phi}\\rvert ${2:A}\\lvert ${3:\\psi}\\rangle $0\n"
			"matrix element" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/me"
			nil nil)
		       ("mceil"
			"\\left\\lceil ${1:x} \\right\\rceil$0\n"
			"Ceiling" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mceil"
			nil nil)
		       ("matrix"
			"# --\n\\begin{matrix}\n$1\n\\end{matrix}\n"
			"\\begin{matrix}…\\end{matirx}" nil nil nil
			"/Users/hc/.config/emacs/snippets/tex-mode/matrix"
			nil nil)
		       ("operatorname" "\\operatorname{${1:rank}}$0\n"
			"Math [operatorname] — Named operator" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-operatorname"
			nil nil)
		       ("mathtt" "\\mathtt{${1:X}}$0\n"
			"Math [mathtt] — Monospace math" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathtt"
			nil nil)
		       ("mathsf" "\\mathsf{${1:X}}$0\n"
			"Math [mathsf] — Sans serif math" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathsf"
			nil nil)
		       ("mathrm" "\\mathrm{${1:X}}$0\n"
			"Math [mathrm] — Roman math" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathrm"
			nil nil)
		       ("mathit" "\\mathit{${1:X}}$0\n"
			"Math [mathit] — Italic math" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathit"
			nil nil)
		       ("mathfrak" "\\mathfrak{${1:g}}$0\n"
			"Math [mathfrak] — Fraktur" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathfrak"
			nil nil)
		       ("mathcal" "\\mathcal{${1:F}}$0\n"
			"Math [mathcal] — Calligraphic" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathcal"
			nil nil)
		       ("mathbf" "\\mathbf{${1:X}}$0\n"
			"Math [mathbf] — Bold math" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathbf"
			nil nil)
		       ("mathbb" "\\mathbb{${1:X}}$0\n"
			"Math [mathbb] — Blackboard bold" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-mathbb"
			nil nil)
		       ("boldsymbol" "\\boldsymbol{${1:\\alpha}}$0\n"
			"Math [boldsymbol] — Bold symbol" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-style-boldsymbol"
			nil nil)
		       ("wedgepow" "\\bigwedge^{${1:d}} ${2:V}$0\n"
			"Math [wedgepow] — Exterior power symbol" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-wedgepow"
			nil nil)
		       ("underset" "\\underset{${1:*}}{${2:=}}$0\n"
			"Math [underset] — Underset" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-underset"
			nil nil)
		       ("underbrace"
			"\\underbrace{${1:x}}_{${2:text}}$0\n"
			"Math [underbrace] — Underbrace" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-underbrace"
			nil nil)
		       ("tensor" "${1:A}\\otimes ${2:B}$0\n"
			"Math [tensor] — Tensor product expression"
			nil ("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-tensor"
			nil nil)
		       ("suchthat" "\\,\\middle|\\,$0\n"
			"Math [suchthat] — Set-builder separator" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-suchthat"
			nil nil)
		       ("substack"
			"\\substack{${1:i\\in I} \\\\ ${2:j\\in J}}$0\n"
			"Math [substack] — Stacked subscript" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-substack"
			nil nil)
		       ("restrict"
			"\\left.${1:A}\\right|_{${2:S}}$0\n"
			"Math [restrict] — Restriction" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-restrict"
			nil nil)
		       ("qexpect"
			"\\left\\langle ${1:A}\\right\\rangle$0\n"
			"Math [qexpect] — Quantum expectation" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-qexpect"
			nil nil)
		       ("prob" "\\Pr\\!\\left[${1:E}\\right]$0\n"
			"Math [prob] — Probability" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-prob"
			nil nil)
		       ("partition"
			"\\bigsqcup_{${1:i=1}}^{${2:s}} ${3:P_i}$0\n"
			"Math [partition] — Indexed disjoint union"
			nil ("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-partition"
			nil nil)
		       ("overset" "\\overset{${1:*}}{${2:=}}$0\n"
			"Math [overset] — Overset" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-overset"
			nil nil)
		       ("overline" "\\overline{${1:z}}$0\n"
			"Math [overline] — Overline / conjugate" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-overline"
			nil nil)
		       ("overbrace"
			"\\overbrace{${1:x}}^{${2:text}}$0\n"
			"Math [overbrace] — Overbrace" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-overbrace"
			nil nil)
		       ("matrixel"
			"\\left\\langle ${1:\\phi}\\middle|${2:A}\\middle|${3:\\psi}\\right\\rangle$0\n"
			"Math [matrixel] — Quantum matrix element" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-matrixel"
			nil nil)
		       ("ketbra"
			"\\left|${1:\\psi}\\right\\rangle\\!\\left\\langle${1}\\right|$0\n"
			"Math [ketbra] — Ket-bra projector" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-ketbra"
			nil nil)
		       ("inner"
			"\\left\\langle ${1:u}, ${2:v}\\right\\rangle$0\n"
			"Math [inner] — Inner product" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-inner"
			nil nil)
		       ("indexedunion"
			"\\bigcup_{${1:i\\in I}} ${2:S_i}$0\n"
			"Math [indexedunion] — Indexed union" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-indexedunion"
			nil nil)
		       ("indexedinter"
			"\\bigcap_{${1:i\\in I}} ${2:S_i}$0\n"
			"Math [indexedinter] — Indexed intersection"
			nil ("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-indexedinter"
			nil nil)
		       ("exterior"
			"\\Lambda^{${1:d}}\\!\\left(${2:V}\\right)$0\n"
			"Math [exterior] — Exterior power" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-exterior"
			nil nil)
		       ("directsum" "${1:U}\\oplus ${2:V}$0\n"
			"Math [directsum] — Direct sum expression" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-directsum"
			nil nil)
		       ("casesmath"
			"\\begin{cases}\n  ${1:a}, & ${2:\\text{if } P}, \\\\\n  ${3:b}, & ${4:\\text{otherwise}}.\n\\end{cases}$0\n"
			"Math [casesmath] — Cases expression" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-cases"
			nil nil)
		       ("card" "\\left|${1:S}\\right|$0\n"
			"Math [card] — Cardinality" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-card"
			nil nil)
		       ("aligned"
			"\\begin{aligned}\n  ${1:a} &= ${2:b} \\\\\n         &= ${3:c}.\n\\end{aligned}$0\n"
			"Math [aligned] — Aligned equations" nil
			("Math · Structures") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-aligned"
			nil nil)
		       ("adjoint" "${1:A}^{\\dagger}$0\n"
			"Math [adjoint] — Adjoint" nil
			("Math · Recent notes") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-structure-adjoint"
			nil nil)
		       ("varnothing" "\\varnothing$0\n"
			"Math [varnothing] — Empty set (round)" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-varnothing"
			nil nil)
		       ("uplus" "\\uplus$0\n"
			"Math [uplus] — Disjoint union" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-uplus"
			nil nil)
		       ("supseteq" "\\supseteq$0\n"
			"Math [supseteq] — Superset or equal" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-supseteq"
			nil nil)
		       ("supset" "\\supset$0\n"
			"Math [supset] — Superset" nil ("Math · Sets")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-supset"
			nil nil)
		       ("subseteq" "\\subseteq$0\n"
			"Math [subseteq] — Subset or equal" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-subseteq"
			nil nil)
		       ("subset" "\\subset$0\n"
			"Math [subset] — Subset" nil ("Math · Sets")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-subset"
			nil nil)
		       ("sqcup" "\\sqcup$0\n"
			"Math [sqcup] — Square union" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-sqcup"
			nil nil)
		       ("sqcap" "\\sqcap$0\n"
			"Math [sqcap] — Square intersection" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-sqcap"
			nil nil)
		       ("smallsetminus" "\\smallsetminus$0\n"
			"Math [smallsetminus] — Small set difference"
			nil ("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-smallsetminus"
			nil nil)
		       ("setminus" "\\setminus$0\n"
			"Math [setminus] — Set difference" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-setminus"
			nil nil)
		       ("powerset"
			"\\mathcal{P}\\!\\left(${1:S}\\right)$0\n"
			"Math [powerset] — Power set" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-powerset"
			nil nil)
		       ("nsubseteq" "\\nsubseteq$0\n"
			"Math [nsubseteq] — Not subset or equal" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-nsubseteq"
			nil nil)
		       ("ni" "\\ni$0\n"
			"Math [ni] — Contains as member" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-ni"
			nil nil)
		       ("in" "\\in$0\n" "Math [in] — Element of" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-in"
			nil nil)
		       ("emptyset" "\\emptyset$0\n"
			"Math [emptyset] — Empty set" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-emptyset"
			nil nil)
		       ("cup" "\\cup$0\n" "Math [cup] — Union" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-cup"
			nil nil)
		       ("complement" "${1:S}^{\\complement}$0\n"
			"Math [complement] — Set complement" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-complement"
			nil nil)
		       ("cap" "\\cap$0\n" "Math [cap] — Intersection"
			nil ("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-cap"
			nil nil)
		       ("bigsqcup" "\\bigsqcup$0\n"
			"Math [bigsqcup] — Big square union" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-bigsqcup"
			nil nil)
		       ("bigcup" "\\bigcup$0\n"
			"Math [bigcup] — Big union" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-bigcup"
			nil nil)
		       ("bigcap" "\\bigcap$0\n"
			"Math [bigcap] — Big intersection" nil
			("Math · Sets") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-set-bigcap"
			nil nil)
		       ("succeq" "\\succeq$0\n"
			"Math [succeq] — Succeeds or equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-succeq"
			nil nil)
		       ("succ" "\\succ$0\n" "Math [succ] — Succeeds"
			nil ("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-succ"
			nil nil)
		       ("simeq" "\\simeq$0\n"
			"Math [simeq] — Similar or equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-simeq"
			nil nil)
		       ("sim" "\\sim$0\n" "Math [sim] — Similar" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-sim"
			nil nil)
		       ("propto" "\\propto$0\n"
			"Math [propto] — Proportional to" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-propto"
			nil nil)
		       ("preceq" "\\preceq$0\n"
			"Math [preceq] — Precedes or equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-preceq"
			nil nil)
		       ("prec" "\\prec$0\n" "Math [prec] — Precedes"
			nil ("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-prec"
			nil nil)
		       ("perp" "\\perp$0\n"
			"Math [perp] — Perpendicular / bottom" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-perp"
			nil nil)
		       ("parallel" "\\parallel$0\n"
			"Math [parallel] — Parallel" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-parallel"
			nil nil)
		       ("nparallel" "\\nparallel$0\n"
			"Math [nparallel] — Not parallel" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-nparallel"
			nil nil)
		       ("nmid" "\\nmid$0\n"
			"Math [nmid] — Does not divide" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-nmid"
			nil nil)
		       ("neq" "\\neq$0\n" "Math [neq] — Not equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-neq"
			nil nil)
		       ("mid" "\\mid$0\n"
			"Math [mid] — Divides / such that" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-mid"
			nil nil)
		       ("leq" "\\leq$0\n"
			"Math [leq] — Less than or equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-leq"
			nil nil)
		       ("geq" "\\geq$0\n"
			"Math [geq] — Greater than or equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-geq"
			nil nil)
		       ("equiv" "\\equiv$0\n"
			"Math [equiv] — Equivalent" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-equiv"
			nil nil)
		       ("cong" "\\cong$0\n"
			"Math [cong] — Congruent / isomorphic" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-cong"
			nil nil)
		       ("coloneqq" "\\coloneqq$0\n"
			"Math [coloneqq] — Defined as" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-coloneqq"
			nil nil)
		       ("asymp" "\\asymp$0\n"
			"Math [asymp] — Asymptotic" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-asymp"
			nil nil)
		       ("approx" "\\approx$0\n"
			"Math [approx] — Approximately equal" nil
			("Math · Relations") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-relation-approx"
			nil nil)
		       ("wedge" "\\wedge$0\n"
			"Math [wedge] — Wedge / exterior product" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-wedge"
			nil nil)
		       ("vee" "\\vee$0\n" "Math [vee] — Vee / join"
			nil ("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-vee"
			nil nil)
		       ("times" "\\times$0\n"
			"Math [times] — Times / product" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-times"
			nil nil)
		       ("star" "\\star$0\n"
			"Math [star] — Star operator" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-star"
			nil nil)
		       ("pm" "\\pm$0\n" "Math [pm] — Plus or minus"
			nil ("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-pm"
			nil nil)
		       ("otimes" "\\otimes$0\n"
			"Math [otimes] — Tensor product" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-otimes"
			nil nil)
		       ("oplus" "\\oplus$0\n"
			"Math [oplus] — Direct sum" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-oplus"
			nil nil)
		       ("odot" "\\odot$0\n"
			"Math [odot] — Circled dot" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-odot"
			nil nil)
		       ("mp" "\\mp$0\n" "Math [mp] — Minus or plus"
			nil ("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-mp"
			nil nil)
		       ("div" "\\div$0\n" "Math [div] — Division" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-div"
			nil nil)
		       ("circledast" "\\circledast$0\n"
			"Math [circledast] — Circled asterisk" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-circledast"
			nil nil)
		       ("bullet" "\\bullet$0\n"
			"Math [bullet] — Bullet operator" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-bullet"
			nil nil)
		       ("boxtimes" "\\boxtimes$0\n"
			"Math [boxtimes] — Boxed times" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-boxtimes"
			nil nil)
		       ("boxplus" "\\boxplus$0\n"
			"Math [boxplus] — Boxed plus" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-boxplus"
			nil nil)
		       ("bigwedge" "\\bigwedge$0\n"
			"Math [bigwedge] — Big wedge" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-bigwedge"
			nil nil)
		       ("bigvee" "\\bigvee$0\n"
			"Math [bigvee] — Big vee" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-bigvee"
			nil nil)
		       ("bigotimes" "\\bigotimes$0\n"
			"Math [bigotimes] — Big tensor product" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-bigotimes"
			nil nil)
		       ("bigoplus" "\\bigoplus$0\n"
			"Math [bigoplus] — Big direct sum" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-bigoplus"
			nil nil)
		       ("bigodot" "\\bigodot$0\n"
			"Math [bigodot] — Big circled dot" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-bigodot"
			nil nil)
		       ("ast" "\\ast$0\n"
			"Math [ast] — Asterisk operator" nil
			("Math · Operators") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-operator-ast"
			nil nil)
		       ("wp" "\\wp$0\n" "Math [wp] — Weierstrass p"
			nil ("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-wp"
			nil nil)
		       ("vdots" "\\vdots$0\n"
			"Math [vdots] — Vertical dots" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-vdots"
			nil nil)
		       ("thinspace" "\\,$0\n"
			"Math [thinspace] — Thin math space" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-thinspace"
			nil nil)
		       ("thickspace" "\\;$0\n"
			"Math [thickspace] — Thick math space" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-thickspace"
			nil nil)
		       ("rangle" "\\rangle$0\n"
			"Math [rangle] — Right angle bracket" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-rangle"
			nil nil)
		       ("quad" "\\quad$0\n" "Math [quad] — Quad space"
			nil ("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-quad"
			nil nil)
		       ("qquad" "\\qquad$0\n"
			"Math [qquad] — Double quad space" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-qquad"
			nil nil)
		       ("negspace" "\\!$0\n"
			"Math [negspace] — Negative thin space" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-negspace"
			nil nil)
		       ("medspace" "\\:$0\n"
			"Math [medspace] — Medium math space" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-medspace"
			nil nil)
		       ("ldots" "\\ldots$0\n"
			"Math [ldots] — Low dots" nil ("Math · Misc")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-ldots"
			nil nil)
		       ("langle" "\\langle$0\n"
			"Math [langle] — Left angle bracket" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-langle"
			nil nil)
		       ("hbar" "\\hbar$0\n"
			"Math [hbar] — Reduced Planck constant" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-hbar"
			nil nil)
		       ("ell" "\\ell$0\n" "Math [ell] — Script ell"
			nil ("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-ell"
			nil nil)
		       ("dots" "\\dots$0\n"
			"Math [dots] — Contextual dots" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-dots"
			nil nil)
		       ("ddots" "\\ddots$0\n"
			"Math [ddots] — Diagonal dots" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-ddots"
			nil nil)
		       ("cdots" "\\cdots$0\n"
			"Math [cdots] — Centered dots" nil
			("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-cdots"
			nil nil)
		       ("aleph" "\\aleph$0\n" "Math [aleph] — Aleph"
			nil ("Math · Misc") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-misc-aleph"
			nil nil)
		       ("vdash" "\\vdash$0\n"
			"Math [vdash] — Proves / turnstile" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-vdash"
			nil nil)
		       ("top" "\\top$0\n" "Math [top] — Truth / top"
			nil ("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-top"
			nil nil)
		       ("nexists" "\\nexists$0\n"
			"Math [nexists] — Does not exist" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-nexists"
			nil nil)
		       ("models" "\\models$0\n"
			"Math [models] — Models" nil ("Math · Logic")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-models"
			nil nil)
		       ("lor" "\\lor$0\n" "Math [lor] — Logical or"
			nil ("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-lor"
			nil nil)
		       ("lnot" "\\lnot$0\n"
			"Math [lnot] — Logical not" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-lnot"
			nil nil)
		       ("land" "\\land$0\n"
			"Math [land] — Logical and" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-land"
			nil nil)
		       ("implies" "\\implies$0\n"
			"Math [implies] — Implies" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-implies"
			nil nil)
		       ("impliedby" "\\impliedby$0\n"
			"Math [impliedby] — Implied by" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-impliedby"
			nil nil)
		       ("iff" "\\iff$0\n"
			"Math [iff] — If and only if" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-iff"
			nil nil)
		       ("forall" "\\forall$0\n"
			"Math [forall] — For all" nil ("Math · Logic")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-forall"
			nil nil)
		       ("exists" "\\exists$0\n"
			"Math [exists] — Exists" nil ("Math · Logic")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-exists"
			nil nil)
		       ("dashv" "\\dashv$0\n"
			"Math [dashv] — Reverse turnstile" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-dashv"
			nil nil)
		       ("bot" "\\bot$0\n"
			"Math [bot] — False / bottom" nil
			("Math · Logic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-logic-bot"
			nil nil)
		       ("SL" "\\operatorname{SL}$0\n"
			"Math [SL] — Special linear group" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-upper-supper-l"
			nil nil)
		       ("Hom" "\\operatorname{Hom}$0\n"
			"Math [Hom] — Hom space" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-upper-hom"
			nil nil)
		       ("GL" "\\operatorname{GL}$0\n"
			"Math [GL] — General linear group" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-upper-gupper-l"
			nil nil)
		       ("End" "\\operatorname{End}$0\n"
			"Math [End] — Endomorphism algebra" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-upper-end"
			nil nil)
		       ("Aut" "\\operatorname{Aut}$0\n"
			"Math [Aut] — Automorphism group" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-upper-aut"
			nil nil)
		       ("tr" "\\operatorname{tr}$0\n"
			"Math [tr] — Trace operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-tr"
			nil nil)
		       ("span" "\\operatorname{span}$0\n"
			"Math [span] — Span operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-span"
			nil nil)
		       ("rank" "\\operatorname{rank}$0\n"
			"Math [rank] — Rank operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-rank"
			nil nil)
		       ("ker" "\\ker$0\n"
			"Math [ker] — Kernel operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-ker"
			nil nil)
		       ("imageop" "\\operatorname{im}$0\n"
			"Math [imageop] — Image operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-imageop"
			nil nil)
		       ("idop" "\\operatorname{id}$0\n"
			"Math [idop] — Identity operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-idop"
			nil nil)
		       ("dim" "\\dim$0\n"
			"Math [dim] — Dimension operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-dim"
			nil nil)
		       ("diag" "\\operatorname{diag}$0\n"
			"Math [diag] — Diagonal operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-diag"
			nil nil)
		       ("det" "\\det$0\n"
			"Math [det] — Determinant operator" nil
			("Math · Linear algebra") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-linear-det"
			nil nil)
		       ("zeta" "\\zeta$0\n" "Math [zeta] — Zeta" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-zeta"
			nil nil)
		       ("xi" "\\xi$0\n" "Math [xi] — Xi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-xi"
			nil nil)
		       ("vartheta" "\\vartheta$0\n"
			"Math [vartheta] — Variant theta" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-vartheta"
			nil nil)
		       ("varsigma" "\\varsigma$0\n"
			"Math [varsigma] — Final sigma" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-varsigma"
			nil nil)
		       ("varrho" "\\varrho$0\n"
			"Math [varrho] — Variant rho" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-varrho"
			nil nil)
		       ("varpi" "\\varpi$0\n"
			"Math [varpi] — Variant pi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-varpi"
			nil nil)
		       ("varphi" "\\varphi$0\n"
			"Math [varphi] — Variant phi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-varphi"
			nil nil)
		       ("varepsilon" "\\varepsilon$0\n"
			"Math [varepsilon] — Variant epsilon" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-varepsilon"
			nil nil)
		       ("upsilon" "\\upsilon$0\n"
			"Math [upsilon] — Upsilon" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upsilon"
			nil nil)
		       ("Xi" "\\Xi$0\n" "Math [Xi] — Xi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-xi"
			nil nil)
		       ("Upsilon" "\\Upsilon$0\n"
			"Math [Upsilon] — Upsilon" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-upsilon"
			nil nil)
		       ("Theta" "\\Theta$0\n" "Math [Theta] — Theta"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-theta"
			nil nil)
		       ("Sigma" "\\Sigma$0\n" "Math [Sigma] — Sigma"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-sigma"
			nil nil)
		       ("Psi" "\\Psi$0\n" "Math [Psi] — Psi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-psi"
			nil nil)
		       ("Pi" "\\Pi$0\n" "Math [Pi] — Pi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-pi"
			nil nil)
		       ("Phi" "\\Phi$0\n" "Math [Phi] — Phi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-phi"
			nil nil)
		       ("Omega" "\\Omega$0\n" "Math [Omega] — Omega"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-omega"
			nil nil)
		       ("Lambda" "\\Lambda$0\n"
			"Math [Lambda] — Lambda" nil ("Math · Greek")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-lambda"
			nil nil)
		       ("Gamma" "\\Gamma$0\n" "Math [Gamma] — Gamma"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-gamma"
			nil nil)
		       ("Delta" "\\Delta$0\n" "Math [Delta] — Delta"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-upper-delta"
			nil nil)
		       ("theta" "\\theta$0\n" "Math [theta] — Theta"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-theta"
			nil nil)
		       ("tau" "\\tau$0\n" "Math [tau] — Tau" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-tau"
			nil nil)
		       ("sigma" "\\sigma$0\n" "Math [sigma] — Sigma"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-sigma"
			nil nil)
		       ("rho" "\\rho$0\n" "Math [rho] — Rho" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-rho"
			nil nil)
		       ("psi" "\\psi$0\n" "Math [psi] — Psi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-psi"
			nil nil)
		       ("pi" "\\pi$0\n" "Math [pi] — Pi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-pi"
			nil nil)
		       ("phi" "\\phi$0\n" "Math [phi] — Phi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-phi"
			nil nil)
		       ("omega" "\\omega$0\n" "Math [omega] — Omega"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-omega"
			nil nil)
		       ("nu" "\\nu$0\n" "Math [nu] — Nu" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-nu"
			nil nil)
		       ("mu" "\\mu$0\n" "Math [mu] — Mu" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-mu"
			nil nil)
		       ("lambda" "\\lambda$0\n"
			"Math [lambda] — Lambda" nil ("Math · Greek")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-lambda"
			nil nil)
		       ("kappa" "\\kappa$0\n" "Math [kappa] — Kappa"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-kappa"
			nil nil)
		       ("iota" "\\iota$0\n" "Math [iota] — Iota" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-iota"
			nil nil)
		       ("gamma" "\\gamma$0\n" "Math [gamma] — Gamma"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-gamma"
			nil nil)
		       ("eta" "\\eta$0\n" "Math [eta] — Eta" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-eta"
			nil nil)
		       ("epsilon" "\\epsilon$0\n"
			"Math [epsilon] — Epsilon" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-epsilon"
			nil nil)
		       ("delta" "\\delta$0\n" "Math [delta] — Delta"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-delta"
			nil nil)
		       ("chi" "\\chi$0\n" "Math [chi] — Chi" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-chi"
			nil nil)
		       ("beta" "\\beta$0\n" "Math [beta] — Beta" nil
			("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-beta"
			nil nil)
		       ("alpha" "\\alpha$0\n" "Math [alpha] — Alpha"
			nil ("Math · Greek") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-greek-alpha"
			nil nil)
		       ("frakp" "\\mathfrak{p}$0\n"
			"Math [frakp] — Fraktur p" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-frak-p"
			nil nil)
		       ("frakm" "\\mathfrak{m}$0\n"
			"Math [frakm] — Fraktur m" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-frak-m"
			nil nil)
		       ("frakh" "\\mathfrak{h}$0\n"
			"Math [frakh] — Fraktur h" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-frak-h"
			nil nil)
		       ("frakg" "\\mathfrak{g}$0\n"
			"Math [frakg] — Fraktur g" nil
			("Math · Styles") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-frak-g"
			nil nil)
		       ("sumop" "\\sum$0\n"
			"Math [sumop] — Summation operator" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-sumop"
			nil nil)
		       ("sumfrom"
			"\\sum_{${1:i=1}}^{${2:n}} ${3:a_i}$0\n"
			"Math [sumfrom] — Indexed sum" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-sumfrom"
			nil nil)
		       ("sqrt" "\\sqrt{${1:x}}$0\n"
			"Math [sqrt] — Square root" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-sqrt"
			nil nil)
		       ("prodop" "\\prod$0\n"
			"Math [prodop] — Product operator" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-prodop"
			nil nil)
		       ("prodfrom"
			"\\prod_{${1:i=1}}^{${2:n}} ${3:a_i}$0\n"
			"Math [prodfrom] — Indexed product" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-prodfrom"
			nil nil)
		       ("pderiv"
			"\\frac{\\partial ${1:f}}{\\partial ${2:x}}$0\n"
			"Math [pderiv] — Partial derivative" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-pderiv"
			nil nil)
		       ("partial" "\\partial$0\n"
			"Math [partial] — Partial derivative symbol"
			nil ("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-partial"
			nil nil)
		       ("ointop" "\\oint$0\n"
			"Math [ointop] — Contour integral operator"
			nil ("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-ointop"
			nil nil)
		       ("nabla" "\\nabla$0\n" "Math [nabla] — Nabla"
			nil ("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-nabla"
			nil nil)
		       ("limto"
			"\\lim_{${1:x}\\to ${2:a}} ${3:f(x)}$0\n"
			"Math [limto] — Limit to" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-limto"
			nil nil)
		       ("intop" "\\int$0\n"
			"Math [intop] — Integral operator" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-intop"
			nil nil)
		       ("intfrom"
			"\\int_{${1:a}}^{${2:b}} ${3:f(x)}\\,d${4:x}$0\n"
			"Math [intfrom] — Definite integral" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-intfrom"
			nil nil)
		       ("infty" "\\infty$0\n"
			"Math [infty] — Infinity" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-infty"
			nil nil)
		       ("iintop" "\\iint$0\n"
			"Math [iintop] — Double integral operator" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-iintop"
			nil nil)
		       ("iiintop" "\\iiint$0\n"
			"Math [iiintop] — Triple integral operator"
			nil ("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-iiintop"
			nil nil)
		       ("deriv" "\\frac{d${1:f}}{d${2:x}}$0\n"
			"Math [deriv] — Derivative" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-deriv"
			nil nil)
		       ("coprod" "\\coprod$0\n"
			"Math [coprod] — Coproduct operator" nil
			("Math · Calculus") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-calculus-coprod"
			nil nil)
		       ("calZ" "\\mathcal{Z}$0\n"
			"Math [calZ] — Calligraphic Z" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-z"
			nil nil)
		       ("calY" "\\mathcal{Y}$0\n"
			"Math [calY] — Calligraphic Y" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-y"
			nil nil)
		       ("calX" "\\mathcal{X}$0\n"
			"Math [calX] — Calligraphic X" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-x"
			nil nil)
		       ("calW" "\\mathcal{W}$0\n"
			"Math [calW] — Calligraphic W" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-w"
			nil nil)
		       ("calV" "\\mathcal{V}$0\n"
			"Math [calV] — Calligraphic V" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-v"
			nil nil)
		       ("calU" "\\mathcal{U}$0\n"
			"Math [calU] — Calligraphic U" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-u"
			nil nil)
		       ("calT" "\\mathcal{T}$0\n"
			"Math [calT] — Calligraphic T" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-t"
			nil nil)
		       ("calS" "\\mathcal{S}$0\n"
			"Math [calS] — Calligraphic S" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-s"
			nil nil)
		       ("calR" "\\mathcal{R}$0\n"
			"Math [calR] — Calligraphic R" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-r"
			nil nil)
		       ("calQ" "\\mathcal{Q}$0\n"
			"Math [calQ] — Calligraphic Q" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-q"
			nil nil)
		       ("calP" "\\mathcal{P}$0\n"
			"Math [calP] — Calligraphic P" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-p"
			nil nil)
		       ("calO" "\\mathcal{O}$0\n"
			"Math [calO] — Calligraphic O" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-o"
			nil nil)
		       ("calN" "\\mathcal{N}$0\n"
			"Math [calN] — Calligraphic N" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-n"
			nil nil)
		       ("calM" "\\mathcal{M}$0\n"
			"Math [calM] — Calligraphic M" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-m"
			nil nil)
		       ("calL" "\\mathcal{L}$0\n"
			"Math [calL] — Calligraphic L" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-l"
			nil nil)
		       ("calK" "\\mathcal{K}$0\n"
			"Math [calK] — Calligraphic K" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-k"
			nil nil)
		       ("calJ" "\\mathcal{J}$0\n"
			"Math [calJ] — Calligraphic J" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-j"
			nil nil)
		       ("calI" "\\mathcal{I}$0\n"
			"Math [calI] — Calligraphic I" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-i"
			nil nil)
		       ("calH" "\\mathcal{H}$0\n"
			"Math [calH] — Calligraphic H" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-h"
			nil nil)
		       ("calG" "\\mathcal{G}$0\n"
			"Math [calG] — Calligraphic G" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-g"
			nil nil)
		       ("calF" "\\mathcal{F}$0\n"
			"Math [calF] — Calligraphic F" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-f"
			nil nil)
		       ("calE" "\\mathcal{E}$0\n"
			"Math [calE] — Calligraphic E" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-e"
			nil nil)
		       ("calD" "\\mathcal{D}$0\n"
			"Math [calD] — Calligraphic D" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-d"
			nil nil)
		       ("calC" "\\mathcal{C}$0\n"
			"Math [calC] — Calligraphic C" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-c"
			nil nil)
		       ("calB" "\\mathcal{B}$0\n"
			"Math [calB] — Calligraphic B" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-b"
			nil nil)
		       ("calA" "\\mathcal{A}$0\n"
			"Math [calA] — Calligraphic A" nil
			("Math · Calligraphic") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-cal-a"
			nil nil)
		       ("bbZ" "\\mathbb{Z}$0\n"
			"Math [bbZ] — Integers" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-z"
			nil nil)
		       ("bbR" "\\mathbb{R}$0\n" "Math [bbR] — Reals"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-r"
			nil nil)
		       ("bbQ" "\\mathbb{Q}$0\n"
			"Math [bbQ] — Rationals" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-q"
			nil nil)
		       ("bbP" "\\mathbb{P}$0\n"
			"Math [bbP] — Projective space / probability"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-p"
			nil nil)
		       ("bbN" "\\mathbb{N}$0\n"
			"Math [bbN] — Natural numbers" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-n"
			nil nil)
		       ("bbK" "\\mathbb{K}$0\n" "Math [bbK] — Field K"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-k"
			nil nil)
		       ("bbH" "\\mathbb{H}$0\n"
			"Math [bbH] — Quaternions / Hilbert space" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-h"
			nil nil)
		       ("bbF" "\\mathbb{F}$0\n" "Math [bbF] — Field"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-f"
			nil nil)
		       ("bbE" "\\mathbb{E}$0\n"
			"Math [bbE] — Expectation" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-e"
			nil nil)
		       ("bbC" "\\mathbb{C}$0\n"
			"Math [bbC] — Complex numbers" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-c"
			nil nil)
		       ("QQ" "\\mathbb{Q}$0\n"
			"Math [QQ] — Rational numbers" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-alias-qq"
			nil nil)
		       ("PP" "\\mathbb{P}$0\n"
			"Math [PP] — Projective space / probability"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-alias-pp"
			nil nil)
		       ("KK" "\\mathbb{K}$0\n" "Math [KK] — Field K"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-alias-kk"
			nil nil)
		       ("FF" "\\mathbb{F}$0\n" "Math [FF] — Field F"
			nil ("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-alias-ff"
			nil nil)
		       ("EE" "\\mathbb{E}$0\n"
			"Math [EE] — Expectation" nil
			("Math · Blackboard") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-bb-alias-ee"
			nil nil)
		       ("Rightarrow" "\\Rightarrow$0\n"
			"Math [Rightarrow] — Right double arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-upper-rightarrow"
			nil nil)
		       ("Longrightarrow" "\\Longrightarrow$0\n"
			"Math [Longrightarrow] — Long right double arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-upper-longrightarrow"
			nil nil)
		       ("Longleftrightarrow"
			"\\Longleftrightarrow$0\n"
			"Math [Longleftrightarrow] — Long left-right double arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-upper-longleftrightarrow"
			nil nil)
		       ("Longleftarrow" "\\Longleftarrow$0\n"
			"Math [Longleftarrow] — Long left double arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-upper-longleftarrow"
			nil nil)
		       ("Leftrightarrow" "\\Leftrightarrow$0\n"
			"Math [Leftrightarrow] — Left-right double arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-upper-leftrightarrow"
			nil nil)
		       ("Leftarrow" "\\Leftarrow$0\n"
			"Math [Leftarrow] — Left double arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-upper-leftarrow"
			nil nil)
		       ("updownarrow" "\\updownarrow$0\n"
			"Math [updownarrow] — Up-down arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-updownarrow"
			nil nil)
		       ("uparrow" "\\uparrow$0\n"
			"Math [uparrow] — Up arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-uparrow"
			nil nil)
		       ("twoheadrightarrow" "\\twoheadrightarrow$0\n"
			"Math [twoheadrightarrow] — Surjective right arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-twoheadrightarrow"
			nil nil)
		       ("twoheadleftarrow" "\\twoheadleftarrow$0\n"
			"Math [twoheadleftarrow] — Surjective left arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-twoheadleftarrow"
			nil nil)
		       ("to" "\\to$0\n" "Math [to] — Right arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-to"
			nil nil)
		       ("rightarrow" "\\rightarrow$0\n"
			"Math [rightarrow] — Right arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-rightarrow"
			nil nil)
		       ("mapsto" "\\mapsto$0\n"
			"Math [mapsto] — Maps to" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-mapsto"
			nil nil)
		       ("longrightarrow" "\\longrightarrow$0\n"
			"Math [longrightarrow] — Long right arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-longrightarrow"
			nil nil)
		       ("longmapsto" "\\longmapsto$0\n"
			"Math [longmapsto] — Long maps to" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-longmapsto"
			nil nil)
		       ("longleftrightarrow"
			"\\longleftrightarrow$0\n"
			"Math [longleftrightarrow] — Long left-right arrow"
			nil ("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-longleftrightarrow"
			nil nil)
		       ("longleftarrow" "\\longleftarrow$0\n"
			"Math [longleftarrow] — Long left arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-longleftarrow"
			nil nil)
		       ("leftrightarrow" "\\leftrightarrow$0\n"
			"Math [leftrightarrow] — Left-right arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-leftrightarrow"
			nil nil)
		       ("leftarrow" "\\leftarrow$0\n"
			"Math [leftarrow] — Left arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-leftarrow"
			nil nil)
		       ("leadsto" "\\leadsto$0\n"
			"Math [leadsto] — Leads to" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-leadsto"
			nil nil)
		       ("hookrightarrow" "\\hookrightarrow$0\n"
			"Math [hookrightarrow] — Right hook arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-hookrightarrow"
			nil nil)
		       ("hookleftarrow" "\\hookleftarrow$0\n"
			"Math [hookleftarrow] — Left hook arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-hookleftarrow"
			nil nil)
		       ("downarrow" "\\downarrow$0\n"
			"Math [downarrow] — Down arrow" nil
			("Math · Arrows") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math-arrow-downarrow"
			nil nil)
		       ("math"
			"# --\n\\begin{math}\n	$1\n\\end{math}\n$0\n"
			"Math" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/math"
			nil nil)
		       ("mat"
			"# --\n\\begin{${1:p/b/v/V/B/small}matrix}\n	$0\n\\end{${1:p/b/v/V/B/small}matrix}\n"
			"Matrix" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mat"
			nil nil)
		       ("marginpar" "# --\n\\marginpar{$1}\n$0\n"
			"Marginpar" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/marginpar"
			nil nil)
		       ("mabs" "\\left|${1:x}\\right|$0\n"
			"Absolute value" nil ("Math symbols") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/mabs"
			nil nil)
		       ("lra" "\\left< $1 \\right> $2\n"
			"Left-Right Angle" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lra"
			nil nil)
		       ("lr|" "\\left| $1 \\right| $2\n"
			"Left-Right Absolute" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lr-4"
			nil nil)
		       ("lr{" "\\left\\{ $1 \\right\\} $2\n"
			"Left-Right Braces" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lr-3"
			nil nil)
		       ("lr[" "\\left[ $1 \\right] $2\n"
			"Left-Right Brackets" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lr-2"
			nil nil)
		       ("lr(" "\\left( $1 \\right) $2\n"
			"Left-Right Parentheses" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lr"
			nil nil)
		       ("llll" "\\lambda\n" "Lambda (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/llll-2"
			nil nil)
		       ("listing:ref"
			"# --\n${1:Listing}~\\ref{lst:$2}$0\n"
			"Listing:Ref" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/listing_ref"
			nil nil)
		       ("lim" "\\lim_{ $1 \\to $2 } $3\n" "Limit" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lim"
			nil nil)
		       ("lemmal"
			"# --\n\\begin{lemma}{$1}\\label{lem:$1}\n	$2\n\\end{lemma}\n$0\n"
			"Lemma (with label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lemmal"
			nil nil)
		       ("lemma"
			"# --\n\\begin{lemma}{$1}\n	$2\n\\end{lemma}\n$0\n"
			"Lemma (no label)" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lemma"
			nil nil)
		       ("lax"
			"\\begin{align*}\n$1 &= $2 \\\\\n$3 &= $0\n\\end{align*}\n"
			"latex" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lax"
			nil nil)
		       ("lang"
			"# --\n${1:L} \\subseteq \\{0,1\\}^{${2:*}}$0\n"
			"Language over bits" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/lang"
			nil nil)
		       ("kraus"
			"# --\n\\mathcal{${1:E}}(\\rho)=\\sum_${2:k} ${3:E_k}\\rho ${3:E_k}^{\\dagger}$0\n"
			"Kraus map" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/kraus"
			nil nil)
		       ("kkkk" "\\kappa\n" "Kappa" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/kkkk"
			nil nil)
		       ("ket1" "\\lvert 1\\rangle $0\n" "ket1" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ket1"
			nil nil)
		       ("ket0" "\\lvert 0\\rangle $0\n" "ket0" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ket0"
			nil nil)
		       ("ket" "\\ket{$1} $2\n" "Ket" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ket"
			nil nil)
		       ("kbt" "k_{B}T\n" "Boltzmann Constant" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/kbt"
			nil nil)
		       ("item"
			"# --\n\\\\begin{itemize}\n	\\item $0\n\\\\end{itemize}\n"
			"Itemize" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/item"
			nil nil)
		       ("iso" "{}^{$1}_{$2}$3\n" "Isotope" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/iso"
			nil nil)
		       ("invs" "^{-1}\n" "Inverse" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/invs"
			nil nil)
		       ("introduction"
			"# --\n\\begin{introduction}\n	$1\n\\end{introduction}\n$0\n"
			"Introduction" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/introduction"
			nil nil)
		       ("int" "\\int $1 \\, d$2 $3\n" "Integral" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/int"
			nil nil)
		       ("inn" "\\in\n" "Element Of" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/inn"
			nil nil)
		       ("inlineexp" "# --\n\\\\($1\\\\)$0\n"
			"InlineExp" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/inlineexp"
			nil nil)
		       (";" "$${1:x}$ $0\n" "Inline math" nil
			("LaTeX local") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/inline-math"
			nil nil)
		       ("info" "# --\n#+begin_info\n$0\n#+end_info\n"
			"Org info block" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/info"
			nil nil)
		       ("infi"
			"\\int_{-\\infty}^{\\infty} $1 \\, d$2 $3\n"
			"Integral -Inf to Inf" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/infi"
			nil nil)
		       ("indic"
			"# --\n\\mathbf{1}\\left\\{${1:E}\\right\\}$0\n"
			"Indicator" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/indic"
			nil nil)
		       ("important"
			"# --\n#+begin_important\n$0\n#+end_important\n"
			"Org important block" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/important"
			nil nil)
		       ("iint" "\\iint\n" "Double Integral" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/iint"
			nil nil)
		       ("iiint" "\\iiint\n" "Triple Integral" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/iiint"
			nil nil)
		       ("iiii" "\\iota\n" "Iota" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/iiii"
			nil nil)
		       ("if"
			"\\If{$1}\n\\ElsIf{$2}\n\\Else\n\\EndIf\n"
			"Algorithm:If" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/if"
			nil nil)
		       ("iden"
			"\\begin{pmatrix}\n1 & 0 & \\dots & 0 \\\\\n0 & 1 & \\dots & 0 \\\\\n\\vdots & \\vdots & \\ddots & \\vdots \\\\\n0 & 0 & \\dots & 1\n\\end{pmatrix}\n"
			"Identity Matrix" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/iden"
			nil nil)
		       ("hybrid" "# --\nH_${1:i}: ${2:...}$0\n"
			"Hybrid game" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/hybrid"
			nil nil)
		       ("hide"
			"# --\n\\begin{hide}\n	$1\n\\end{hide}\n$0\n"
			"hide" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/hide"
			nil nil)
		       ("he4" "{}^{4}_{2}He\n" "Helium-4" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/he4"
			nil nil)
		       ("he3" "{}^{3}_{2}He\n" "Helium-3" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/he3"
			nil nil)
		       ("hat" "\\hat{$1}$2\n" "Hat Accent" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/hat"
			nil nil)
		       ("hash"
			"# --\n${1:H}: \\{0,1\\}^* \\to \\{0,1\\}^{${2:\\lambda}}$0\n"
			"Hash function" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/hash"
			nil nil)
		       ("had" "# --\nH\\lvert ${1:\\psi}\\rangle$0\n"
			"Hadamard on state" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/had"
			nil nil)
		       ("gggg" "\\gamma\n" "Gamma (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/gggg-2"
			nil nil)
		       ("gat"
			"# --\n\\begin{gather}\n	$0\n\\end{gather}\n"
			"Gather(ed)" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/gat"
			nil nil)
		       ("game"
			"# --\n\\mathsf{Game}^{${1:ind-cpa}}_{${2:\\Pi},\\mathcal{${3:A}}}\\left(${4:\\lambda}\\right)$0\n"
			"Cryptographic game" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/game"
			nil nil)
		       ("frac" "\\frac{${1:a}}{${2:b}}$0\n" "Fraction"
			nil ("Noema local") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/frac"
			nil nil)
		       ("for"
			"\\For{i=0:$1}\n	\\State $0\n\\EndFor\n"
			"Algorithm:For" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/for"
			nil nil)
		       ("floor" "\\lfloor $1 \\rfloor $2\n" "Floor"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/floor"
			nil nil)
		       ("figure:ref"
			"# --\n${1:Figure}~\\ref{fig:$2}$0\n"
			"Figure:Ref" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/figure_ref"
			nil nil)
		       ("figure:acm:*"
			"# --\n\\begin{figure*}\n	\\includegraphics[width=0.45\\textwidth]{figures/$1}\n	\\caption{$2}\\label{fig:$3}\n\\end{figure*}\n$0\n"
			"Figure:ACM:*" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/figure_acm-2"
			nil nil)
		       ("figure:acm"
			"# --\n\\begin{figure}\n	\\includegraphics[width=0.45\\textwidth]{figures/$1}\n	\\caption{$2}\\label{fig:$3}\n\\end{figure}\n$0\n"
			"Figure:ACM" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/figure_acm"
			nil nil)
		       ("figure"
			"# --\n\\begin{figure}\n	\\begin{center}\n		\\includegraphics[width=0.95\\textwidth]{figures/$1}\n	\\end{center}\n	\\caption{$3}\\label{fig:$4}\n\\end{figure}\n$0\n"
			"Figure" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/figure"
			nil nil)
		       ("expval"
			"# --\n\\langle ${1:\\psi}\\rvert ${2:A}\\lvert ${1:\\psi}\\rangle $0\n"
			"Expectation value" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/expval"
			nil nil)
		       ("expect"
			"# --\n\\mathbb{E}_{${1:x \\sim D}}\\left[${2:f(x)}\\right]$0\n"
			"Expectation" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/expect"
			nil nil)
		       ("exercise"
			"# --\n\\begin{exercise}\n	$1\n\\end{exercise}\n$0\n"
			"Exercise" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/exercise"
			nil nil)
		       ("example"
			"# --\n\\begin{example}\n	$1\n\\end{example}\n$0\n"
			"Example" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/example"
			nil nil)
		       ("eset" "\\emptyset\n" "Empty Set" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/eset"
			nil nil)
		       ("equation"
			"# --\n\\begin{equation}\n	$0\n	\\label{eq:$1}\n\\end{equation}\n"
			"Equation" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/equation"
			nil nil)
		       ("equ"
			"# --\n\\begin{equation*}\n	$1\n\\end{equation*}\n"
			"Equ" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/equ"
			nil nil)
		       ("enumerate"
			"# --\n\\\\begin{enumerate}\n	\\item $0\n\\\\end{enumerate}\n"
			"Enumerate" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/enumerate"
			nil nil)
		       ("#endregion" "# --\n%#Endregion\n"
			"Region End" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/endregion"
			nil nil)
		       ("empty"
			"# --\n\\null\\thispagestyle{empty}\n\\newpage\n$0\n"
			"EmptyPage" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/empty"
			nil nil)
		       ("eeee" "\\epsilon\n" "Epsilon" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/eeee"
			nil nil)
		       ("ee" "e^{ $1 }$2\n" "Exponential" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ee"
			nil nil)
		       ("e\\xi sts" "\\exists\n" "Exists" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/e_xi_sts"
			nil nil)
		       (":e" "\\varepsilon\n" "Varepsilon" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/e"
			nil nil)
		       ("dyad"
			"# --\n\\lvert ${1:\\phi}\\rangle\\langle ${2:\\psi}\\rvert $0\n"
			"Dyad" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/dyad"
			nil nil)
		       ("dot" "\\dot{$1}$2\n" "Dot Accent" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/dot"
			nil nil)
		       ("displaymath"
			"# --\n\\begin{displaymath}\n	$1\n\\end{displaymath}\n$0\n"
			"DisplayMath" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/displaymath"
			nil nil)
		       (":" "$$\n${1:}\n$$\n$0\n" "Display math" nil
			("LaTeX local") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/display-math-shortcut"
			nil nil)
		       ("dint" "\\int_{$1}^{$2} $3 \\, d$4 $5\n"
			"Definite Integral" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/dint"
			nil nil)
		       ("desc"
			"# --\n\\\\begin{description}\n	\\item[$1] $0\n\\\\end{description}\n"
			"Description" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/desc"
			nil nil)
		       ("density"
			"# --\n\\rho = \\sum_${1:i} ${2:p_i}\\lvert ${3:\\psi_i}\\rangle\\langle ${3:\\psi_i}\\rvert$0\n"
			"Density operator" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/density"
			nil nil)
		       ("del" "\\nabla\n" "Del" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/del"
			nil nil)
		       ("defn" "# --\n#+begin_defn\n$0\n#+end_defn\n"
			"Org definition alias block" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/defn"
			nil nil)
		       ("defl"
			"# --\n\\begin{definition}{$1}\\label{def:$1}\n	$2\n\\end{definition}\n$0\n"
			"Definition (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/defl"
			nil nil)
		       ("definition"
			"# --\n\\begin{definition}{$1}\n	$2\n\\end{definition}\n$0\n"
			"Definition (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/definition"
			nil nil)
		       ("ddt" "\\frac{d}{dt}\n" "Time Derivative" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ddt"
			nil nil)
		       ("ddot" "\\ddot{$1}$2\n" "Double Dot Accent"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ddot"
			nil nil)
		       ("dddd" "\\delta\n" "Delta (lowercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/dddd-2"
			nil nil)
		       ("datechange" "# --\n\\datechange{$1}{$2}$0\n"
			"Datechange" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/datechange"
			nil nil)
		       ("dag" "^{\\dagger}\n" "Dagger" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/dag"
			nil nil)
		       ("corollary"
			"# --\n\\begin{corollary}{$1}\n	$2\n\\end{corollary}\n$0\n"
			"Corollary (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/corollary"
			nil nil)
		       ("corl"
			"# --\n\\begin{corollary}{$1}\\label{cor:$1}\n	$2\n\\end{corollary}\n$0\n"
			"Corollary (with label)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/corl"
			nil nil)
		       ("cor" "# --\n#+begin_cor\n$0\n#+end_cor\n"
			"Org corollary block" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cor"
			nil nil)
		       ("conclusion"
			"# --\n\\begin{conclusion}\n	$1\n\\end{conclusion}\n$0\n"
			"Conclusion" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/conclusion"
			nil nil)
		       ("concat" "# --\n\\mathbin{\\Vert}$0\n"
			"Concatenation" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/concat"
			nil nil)
		       ("compactitem"
			"# --\n\\begin{compactitem}\n	\\item $1\n\\end{compactitem}\n$0\n"
			"Compactitem" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/compactitem"
			nil nil)
		       ("comm"
			"# --\n\\left[${1:A}, ${2:B}\\right]$0\n"
			"Commutator" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/comm"
			nil nil)
		       ("coNP" "# --\n\\mathsf{coNP}$0\n"
			"Complexity class coNP" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/coNP"
			nil nil)
		       ("cnot" "# --\n\\operatorname{CNOT}$0\n" "CNOT"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cnot"
			nil nil)
		       ("classP" "# --\n\\mathsf{P}$0\n"
			"Complexity class P" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/classP"
			nil nil)
		       ("classNP" "# --\n\\mathsf{NP}$0\n"
			"Complexity class NP" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/classNP"
			nil nil)
		       ("cite" "# --\n\\cite{$1}$0\n" "Cite" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cite"
			nil nil)
		       ("change"
			"# --\n\\begin{change}\n	$1\n\\end{change}\n$0\n"
			"change" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/change"
			nil nil)
		       ("chal"
			"# --\n\\chapter{$1}\\label{chap:$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Chapter (with label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/chal"
			nil nil)
		       ("cha"
			"# --\n\\chapter{$1}\n${0:$TM_SELECTED_TEXT}\n"
			"Chapter (no label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cha"
			nil nil)
		       ("ceil" "\\lceil $1 \\rceil $2\n" "Ceiling" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ceil"
			nil nil)
		       ("cee" "\\ce{ $1 }\n" "Chemical Equation" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cee"
			nil nil)
		       ("cdot" "\\cdot\n" "Dot Product" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cdot"
			nil nil)
		       ("cb" "^{3}\n" "Cube" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cb"
			nil nil)
		       ("cas"
			"# --\n\\begin{cases}\n	${1:equation}, &\\text{ if }${2:case}\\\\\\\\\n	$0\n\\end{cases}\n"
			"Cases" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/cas"
			nil nil)
		       ("brk" "\\braket{ $1 | $2 } $3\n" "Braket" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/brk"
			nil nil)
		       ("bra" "\\bra{$1} $2\n" "Bra" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bra"
			nil nil)
		       ("bmatrix"
			"# --\n\\begin{bmatrix}\n$1\n\\end{bmatrix}\n"
			"\\begin{bmatrix}…\\end{bmatirx}" nil nil nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bmatrix"
			nil nil)
		       ("bmat"
			"\\begin{bmatrix}\n$1\n\\end{bmatrix}\n"
			"Bmatrix" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bmat-2"
			nil nil)
		       ("bloch"
			"# --\n\\rho = \\frac{1}{2}\\left(I + \\vec{${1:r}}\\cdot\\vec{\\sigma}\\right)$0\n"
			"Bloch form" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bloch"
			nil nil)
		       ("bk"
			"\\langle ${1:\\phi}\\rvert ${2:\\psi}\\rangle $0\n"
			"Braket" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bk"
			nil nil)
		       ("bigTheta"
			"# --\n\\Theta\\left(${1:f(n)}\\right)$0\n"
			"Big Theta" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bigTheta"
			nil nil)
		       ("bigOmega"
			"# --\n\\Omega\\left(${1:f(n)}\\right)$0\n"
			"Big Omega" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bigOmega"
			nil nil)
		       ("bigO" "# --\nO\\left(${1:f(n)}\\right)$0\n"
			"Big O" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bigO"
			nil nil)
		       ("bf" "\\mathbf{$1}\n" "Bold Face" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bf"
			nil nil)
		       ("bell"
			"# --\n\\frac{1}{\\sqrt{2}}\\left(\\lvert 00\\rangle + \\lvert 11\\rangle\\right)$0\n"
			"Bell state" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bell"
			nil nil)
		       ("begin" "# --\n\\begin{$1}\n$2\n\\end{$1}\n"
			"\\begin{}…\\end{}" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/begin"
			nil nil)
		       ("beg" "\\begin{$1}\n$2\n\\end{$1}\n"
			"Begin-End Environment" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/beg"
			nil nil)
		       ("bbmatrix"
			"# --\n\\begin{Bmatrix}\n$1\n\\end{Bmatrix}\n"
			"\\begin{Bmatrix}…\\end{Bmatirx}" nil nil nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bbmatrix"
			nil nil)
		       ("bbbb" "\\beta\n" "Beta" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bbbb"
			nil nil)
		       ("bb" "\\mathbb{${1:A}}$0\n"
			"Blackboard symbol" nil ("Noema local")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bb"
			nil nil)
		       ("bar" "\\bar{$1}$2\n" "Bar Accent" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/bar"
			nil nil)
		       ("axioml"
			"# --\n\\begin{axiom}{$1}\\label{axi:$1}\n		$2\n\\end{axiom}\n$0\n"
			"Axiom (with label)" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/axioml"
			nil nil)
		       ("axiom"
			"# --\n\\begin{axiom}{$1}\n		$2\n\\end{axiom}\n$0\n"
			"Axiom (no label)" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/axiom"
			nil nil)
		       ("avg" "\\langle $1 \\rangle $2\n"
			"Angle Brackets" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/avg"
			nil nil)
		       ("attention"
			"# --\n#+begin_attention\n$0\n#+end_attention\n"
			"Org attention block" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/attention"
			nil nil)
		       ("assumption"
			"# --\n\\begin{assumption}\n	$1\n\\end{assumption}\n$0\n"
			"Assumption" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/assumption"
			nil nil)
		       ("array" "\\begin{array}\n$1\n\\end{array}\n"
			"Array" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/array"
			nil nil)
		       ("anticomm"
			"# --\n\\left\\{${1:A}, ${2:B}\\right\\}$0\n"
			"Anticommutator" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/anticomm"
			nil nil)
		       ("answer"
			"# --\n#+begin_answer\n$0\n#+end_answer\n"
			"Org answer block" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/answer"
			nil nil)
		       ("and" "\\cap\n" "Intersection" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/and"
			nil nil)
		       ("amp"
			"# --\n\\langle ${1:\\phi}\\rvert ${2:A}\\lvert ${3:\\psi}\\rangle $0\n"
			"Transition amplitude" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/amp"
			nil nil)
		       ("ali" "\\begin{align}\n$1\n\\end{align}\n"
			"Align" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ali"
			nil nil)
		       ("algo:ref" "${1:Algorithm}~\\ref{algo:$2}$0\n"
			"Algorithm:Ref" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/algo_ref"
			nil nil)
		       ("algo"
			"# --\n% \\usepackage{algorithm,algorithmicx,algpseudocode}\n\\begin{algorithm}\n	\\floatname{algorithm}{${1:Algorithm}}\n	\\algrenewcommand\\algorithmicrequire{\\textbf{${2:Input: }}}\n	\\algrenewcommand\\algorithmicensure{\\textbf{${3:Output: }}}\n	\\caption{$4}\\label{alg:$5}\n	\\begin{algorithmic}[1]\n		\\Require \\$input\\$\n		\\Ensure \\$output\\$\n		$6\n		\\State \\textbf{return} \\$state\\$\n	\\end{algorithmic}\n\\end{algorithm}\n$0\n"
			"Algorithm" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/algo"
			nil nil)
		       ("adv"
			"# --\n\\operatorname{Adv}^{${1:ind-cpa}}_{${2:\\Pi},\\mathcal{${3:A}}}\\left(${4:\\lambda}\\right)$0\n"
			"Cryptographic advantage" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/adv"
			nil nil)
		       ("aaaa" "\\alpha\n" "Alpha" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/aaaa"
			nil nil)
		       ("ZZ" "\\mathbb{Z}\n" "Integers" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/ZZ"
			nil nil)
		       ("Vrfy"
			"# --\n\\operatorname{Vrfy}_{${1:pk}}\\left(${2:m}, ${3:\\sigma}\\right) = ${4:1}$0\n"
			"Signature verification" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Vrfy"
			nil nil)
		       ("Vmat"
			"\\begin{Vmatrix}\n$1\n\\end{Vmatrix}\n"
			"Vmatrix (double)" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Vmat"
			nil nil)
		       ("UUUU" "\\Upsilon\n" "Upsilon (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/UUUU"
			nil nil)
		       ("Tr"
			"# --\n\\operatorname{Tr}\\left(${1:A}\\right)$0\n"
			"Trace operator" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Tr"
			nil nil)
		       ("TTTT" "\\Theta\n" "Theta (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/TTTT"
			nil nil)
		       ("Sign"
			"# --\n${1:\\sigma} \\leftarrow \\operatorname{Sign}_{${2:sk}}\\left(${3:m}\\right)$0\n"
			"Signature" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Sign"
			nil nil)
		       ("SSSS" "\\Sigma\n" "Sigma (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/SSSS"
			nil nil)
		       ("Re" "\\mathrm{Re}\n" "Real Part" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Re"
			nil nil)
		       ("RR" "\\mathbb{R}\n" "Real Numbers" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/RR"
			nil nil)
		       ("QMA" "# --\n\\mathsf{QMA}$0\n"
			"Complexity class QMA" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/QMA"
			nil nil)
		       ("PSPACE" "# --\n\\mathsf{PSPACE}$0\n"
			"Complexity class PSPACE" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/PSPACE"
			nil nil)
		       ("PRG" "# --\n${1:G}\\left(${2:s}\\right)$0\n"
			"Pseudorandom generator" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/PRG"
			nil nil)
		       ("PRF"
			"# --\n${1:F}_{${2:k}}\\left(${3:x}\\right)$0\n"
			"Pseudorandom function" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/PRF"
			nil nil)
		       ("Open"
			"# --\n\\operatorname{Open}\\left(${1:c}, ${2:d}\\right) = ${3:m}$0\n"
			"Commitment opening" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Open"
			nil nil)
		       ("Ome" "\\Omega\n" "Omega uppercase (alt)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Ome"
			nil nil)
		       ("OOOO" "\\Omega\n" "Omega (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/OOOO"
			nil nil)
		       ("Norm" "\\lVert $1 \\rVert $2\n" "Norm" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Norm"
			nil nil)
		       ("NN" "\\mathbb{N}\n" "Natural Numbers" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/NN"
			nil nil)
		       ("NEXP" "# --\n\\mathsf{NEXP}$0\n"
			"Complexity class NEXP" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/NEXP"
			nil nil)
		       ("MAC"
			"# --\n${1:t} \\leftarrow \\operatorname{MAC}_{${2:k}}\\left(${3:m}\\right)$0\n"
			"Message authentication code" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/MAC"
			nil nil)
		       ("LLLL" "\\Lambda\n" "Lambda (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/LLLL"
			nil nil)
		       ("LL" "\\mathcal{L}\n" "Lagrangian" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/LL"
			nil nil)
		       ("KeyGen"
			"# --\n(${1:pk}, ${2:sk}) \\leftarrow \\operatorname{KeyGen}\\left(1^{${3:\\lambda}}\\right)$0\n"
			"Key generation" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/KeyGen"
			nil nil)
		       ("KDF"
			"# --\n\\operatorname{KDF}\\left(${1:K}, ${2:info}\\right)$0\n"
			"Key derivation function" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/KDF"
			nil nil)
		       ("Im" "\\mathrm{Im}\n" "Imaginary Part" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Im"
			nil nil)
		       ("INDCPA" "# --\n\\mathsf{IND\\mbox{-}CPA}$0\n"
			"IND-CPA" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/INDCPA"
			nil nil)
		       ("INDCCA" "# --\n\\mathsf{IND\\mbox{-}CCA}$0\n"
			"IND-CCA" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/INDCCA"
			nil nil)
		       ("HH" "\\mathcal{H}\n" "Hamiltonian" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/HH"
			nil nil)
		       ("GGGG" "\\Gamma\n" "Gamma (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/GGGG"
			nil nil)
		       ("Enc"
			"# --\n${1:c} \\leftarrow \\operatorname{Enc}_{${2:pk}}\\left(${3:m}; ${4:r}\\right)$0\n"
			"Encryption" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Enc"
			nil nil)
		       ("EXP" "# --\n\\mathsf{EXP}$0\n"
			"Complexity class EXP" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/EXP"
			nil nil)
		       ("EUFCMA" "# --\n\\mathsf{EUF\\mbox{-}CMA}$0\n"
			"EUF-CMA" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/EUFCMA"
			nil nil)
		       ("Dec"
			"# --\n${1:m} := \\operatorname{Dec}_{${2:sk}}\\left(${3:c}\\right)$0\n"
			"Decryption" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Dec"
			nil nil)
		       ("DLOG" "# --\n${1:h}=g^{${2:x}}$0\n"
			"Discrete log" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/DLOG"
			nil nil)
		       ("DDH"
			"# --\n\\left(g^{${1:a}}, g^{${2:b}}, g^{${1:a}${2:b}}\\right) \\approx_c \\left(g^{${1:a}}, g^{${2:b}}, g^{${3:c}}\\right)$0\n"
			"Decisional Diffie-Hellman" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/DDH"
			nil nil)
		       ("DDDD" "\\Delta\n" "Delta (uppercase)" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/DDDD"
			nil nil)
		       ("Com"
			"# --\n(${1:c}, ${2:d}) \\leftarrow \\operatorname{Com}\\left(${3:m}; ${4:r}\\right)$0\n"
			"Commitment" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Com"
			nil nil)
		       ("CC" "\\mathbb{C}\n" "Complex Numbers" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/CC"
			nil nil)
		       ("Bmat"
			"\\begin{Bmatrix}\n$1\n\\end{Bmatrix}\n"
			"Bmatrix (curly)" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/Bmat"
			nil nil)
		       ("BQP" "# --\n\\mathsf{BQP}$0\n"
			"Complexity class BQP" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/BQP"
			nil nil)
		       ("BPP" "# --\n\\mathsf{BPP}$0\n"
			"Complexity class BPP" nil ("Emacs migrated")
			nil
			"/Users/hc/.config/emacs/snippets/tex-mode/BPP"
			nil nil)
		       ("<->" "\\leftrightarrow\n" "Left-Right Arrow"
			nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/--2"
			nil nil)
		       ("-+" "\\mp\n" "Minus-Plus" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/-+"
			nil nil)
		       ("->" "\\to\n" "To" nil ("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/-"
			nil nil)
		       ("+-" "\\pm\n" "Plus-Minus" nil
			("Emacs migrated") nil
			"/Users/hc/.config/emacs/snippets/tex-mode/+-"
			nil nil)))


;;; Do not edit! File generated at Sun Jul 19 15:49:26 2026
