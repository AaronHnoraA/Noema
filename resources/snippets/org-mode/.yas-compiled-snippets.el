;;; "Compiled" snippets and support files for `org-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'org-mode
		     '(("zzzz" "\\zeta\n" "Zeta" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/zzzz_Zeta"
			nil nil)
		       ("xx" "\\times\n" "Times" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/xx_Times"
			nil nil)
		       ("xor" "\\oplus$0\n" "XOR" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/xor_Xor"
			nil nil)
		       ("while"
			"\\While{$1}\n	\\State $0\n\\EndWhile"
			"Algorithm:While" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/while_Algorithm_While"
			nil nil)
		       ("warning"
			"#+begin_warning\n$0\n#+end_warning\n"
			"Org warning block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/warning_Org_Warning_Block"
			nil nil)
		       ("vmat"
			"\\begin{vmatrix}\n$0\n\\end{vmatrix}\n"
			"Vmatrix" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/vmat_Vmatrix"
			nil nil)
		       ("vb"
			"#+begin_src verb -n :wrap src ob-verb-response\n\n#+end_src"
			"vb" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/verb"
			nil nil)
		       ("vec" "\\vec{$1}$2" "Vector" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/vec_Vector"
			nil nil)
		       ("var"
			"\\operatorname{Var}\\left[${1:X}\\right]$0\n"
			"Variance" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/var_Variance"
			nil nil)
		       ("v(" "(${VISUAL})" "Parentheses (visual)" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/v_Parentheses_visual_"
			nil nil)
		       ("v[" "[${VISUAL}]" "Brackets (visual)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/v_Brackets_visual_"
			nil nil)
		       ("v{" "{${VISUAL}}" "Braces (visual)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/v_Braces_visual_"
			nil nil)
		       ("uuuu" "\\upsilon" "Upsilon (lowercase)" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/uuuu_Upsilon_lowercase_"
			nil nil)
		       ("und" "\\underline{$1}$2" "Underline" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/und_Underline"
			nil nil)
		       ("tttt" "\\theta" "Theta (lowercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/tttt_Theta_lowercase_"
			nil nil)
		       ("tr"
			"#+transclude: [[][]] :level 2 :lines 1-2 :src java :rest \"-n\""
			"tr" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/transclude"
			nil nil)
		       ("trace" "\\mathrm{Tr}" "Trace" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/trace_Trace"
			nil nil)
		       ("toc" "#+begin_toc\n$0\n#+end_toc\n"
			"Org toc block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/toc_Org_Toc_Block"
			nil nil)
		       ("tlink" "[[${1:target}][$2]]$0\n"
			"Org target link" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tlink_Org_Target_Link"
			nil nil)
		       ("tt"
			"#+title: `(file-name-sans-extension (buffer-name))`\n#+subtitle: this is subtitle\n#+author: `(getenv \"USER\")`\n#+date: `(format-time-string \"<%Y-%m-%d %H:%M>\")`\n#+SETUPFILE: ~/.doom.d/org-classic-head.setup"
			"title" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/title"
			nil nil)
		       ("tip" "#+begin_tip\n$0\n#+end_tip\n"
			"Org tip block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tip_Org_Tip_Block"
			nil nil)
		       ("timest"
			"`(substring (number-to-string (* (time-to-seconds) 1000)) 0 13)`"
			"timest" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/timest"
			nil nil)
		       ("tilde" "\\tilde{$1}$2" "Tilde Accent" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/tilde_Tilde_Accent"
			nil nil)
		       ("tildeO"
			"\\widetilde{O}\\left(${1:f(n)}\\right)$0\n"
			"Soft O" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tildeO_Soft_O"
			nil nil)
		       ("tikzpic"
			"#+begin_display_latex\n\\begin{tikzpicture}[scale=1]\n$0\n\\end{tikzpicture}\n#+end_display_latex\n"
			"Org TikZ picture block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tikzpic_Org_TikZ_Picture"
			nil nil)
		       ("tikzpath"
			"\\path (${1:A}) edge${2:[${3:->}]} node${4:[${5:above}]} {${6:label}} (${7:B});$0\n"
			"TikZ path" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tikzpath_TikZ_Path"
			nil nil)
		       ("tikznode"
			"\\node (${1:name}) at (${2:0,0}) {${3:label}};$0\n"
			"TikZ node" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tikznode_TikZ_Node"
			nil nil)
		       ("tikzdraw"
			"\\draw${1:[${2:thick}]} (${3:A}) -- (${4:B});$0\n"
			"TikZ draw line" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tikzdraw_TikZ_Draw_Line"
			nil nil)
		       ("tikzcd"
			"#+begin_display_latex\n\\begin{tikzcd}\n${1:A} \\arrow[r, \"${2:f}\"] \\arrow[d, \"${3:g}\"'] & ${4:B} \\arrow[d, \"${5:h}\"] \\\\\n${6:C} \\arrow[r, \"${7:k}\"'] & ${8:D}\n\\end{tikzcd}\n#+end_display_latex\n$0\n"
			"Org tikz-cd block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tikzcd_Org_TikZCD"
			nil nil)
		       ("thml"
			"\\begin{theorem}{$1}\\label{thm:$1}\n	$2\n\\end{theorem}\n$0"
			"Theorem (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/thml_Theorem_with_label_"
			nil nil)
		       ("thm" "#+begin_thm\n$0\n#+end_thm\n"
			"Org theorem alias block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/thm_Org_Theorem_Alias"
			nil nil)
		       ("theorem"
			"#+begin_theorem\n$0\n#+end_theorem\n"
			"Org theorem block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/theorem_Theorem_no_label_"
			nil nil)
		       ("text" "\\text{$1}$2" "Text Environment" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/text_Text_Environment"
			nil nil)
		       ("tayl"
			"$1($2 + $3) = $1($2) + $1'($2)$3 + $1''($2) \\frac{$3^{2}}{2!} + \\dots$4"
			"Taylor Expansion" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tayl_Taylor_Expansion"
			nil nil)
		       ("table:ref" "${1:Table}~\\ref{tab:$2}$0"
			"Table:Ref" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/table_ref_Table_Ref"
			nil nil)
		       ("table:acm:*"
			"\\begin{table*}\n	\\caption{$1}\\label{tab:$2}\n	\\begin{tabular}{${3:ccl}}\n		\\toprule\n		$4\n		a & b & c \\\\\\\\\n		\\midrule\n		d & e & f \\\\\\\\\n		\\bottomrule\n	\\end{tabular}\n\\end{table*}\n$0"
			"Table:ACM:*" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/table_acm_Table_ACM_"
			nil nil)
		       ("table:acm"
			"\\begin{table}\n	\\caption{$1}\\label{tab:$2}\n	\\begin{tabular}{${3:ccl}}\n		\\toprule\n		$4\n		a & b & c \\\\\\\\\n		\\midrule\n		d & e & f \\\\\\\\\n		\\bottomrule\n	\\end{tabular}\n\\end{table}\n$0"
			"Table:ACM" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/table_acm_Table_ACM"
			nil nil)
		       ("table"
			"\\begin{table}\n	\\caption{$1}\\label{tab:$2}\n	\\begin{center}\n		\\begin{tabular}[c]{l|l}\n			\\hline\n			\\multicolumn{1}{c|}{\\textbf{$3}} & \n			\\multicolumn{1}{c}{\\textbf{$4}} \\\\\\\\\n			\\hline\n			a & b \\\\\\\\\n			c & d \\\\\\\\\n			$5\n			\\hline\n		\\end{tabular}\n	\\end{center}\n\\end{table}\n$0"
			"Table" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/table_Table"
			nil nil)
		       ("tabl"
			"\\begin{tabular}{${1:c}}\\label{tab:$2}\n$0\n\\end{tabular}"
			"Tabular (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tabl_Tabular_with_label_"
			nil nil)
		       ("tab"
			"\\begin{tabular}{${1:c}}\n$0\n\\end{tabular}"
			"Tabular (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/tab_Tabular_no_label_"
			nil nil)
		       ("sup=" "\\supseteq" "Superset Equal" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/sup_Superset_Equal"
			nil nil)
		       ("summary"
			"#+begin_summary\n$0\n#+end_summary\n"
			"Org summary block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/summary_Org_Summary_Block"
			nil nil)
		       ("sum" "\\sum" "Sum" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sum_Sum"
			nil nil)
		       ("subsl"
			"\\subsubsection{$1}\\label{sec:$1}\n${0:$TM_SELECTED_TEXT}"
			"Sub Sub Section (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/subsl_Sub_Sub_Section_with_label_"
			nil nil)
		       ("subs"
			"\\subsubsection{$1}\n${0:$TM_SELECTED_TEXT}"
			"Sub Sub Section (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/subs_Sub_Sub_Section_no_label_"
			nil nil)
		       ("subpl"
			"\\subparagraph{$1}\\label{subp:$1}\n${0:$TM_SELECTED_TEXT}"
			"Sub Paragraph (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/subpl_Sub_Paragraph_with_label_"
			nil nil)
		       ("subp"
			"\\subparagraph{$1}\n${0:$TM_SELECTED_TEXT}"
			"Sub Paragraph (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/subp_Sub_Paragraph_no_label_"
			nil nil)
		       ("subl"
			"\\subsection{$1}\\label{sub:$1}\n${0:$TM_SELECTED_TEXT}"
			"Sub Section (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/subl_Sub_Section_with_label_"
			nil nil)
		       ("subfile" "\\subfile{$1}\n$0" "Subfile" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/subfile_Subfile"
			nil nil)
		       ("sub=" "\\subseteq" "Subset Equal" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sub_Subset_Equal"
			nil nil)
		       ("sub"
			"\\subsection{$1}\n${0:$TM_SELECTED_TEXT}"
			"Sub Section (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sub_Sub_Section_no_label_"
			nil nil)
		       ("sts" "_\\text{$1}" "Text Subscript" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/sts_Text_Subscript"
			nil nil)
		       ("state" "\\State $1" "Algorithm:State" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/state_Algorithm_State"
			nil nil)
		       ("ssss" "\\sigma" "Sigma (lowercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/ssss_Sigma_lowercase_"
			nil nil)
		       ("srcsh" "#+begin_src sh${1:}\n$0\n#+end_src\n"
			"Org shell src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcsh_Org_Src_Shell"
			nil nil)
		       ("srcsage"
			"#+begin_src sage${1:}\n$0\n#+end_src\n"
			"Org Sage src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcsage_Org_Src_Sage"
			nil nil)
		       ("srcrs"
			"#+begin_src rust${1:}\n$0\n#+end_src\n"
			"Org Rust src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcrs_Org_Src_Rust"
			nil nil)
		       ("srcpy"
			"#+begin_src python${1:}\n$0\n#+end_src\n"
			"Org Python src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcpy_Org_Src_Python"
			nil nil)
		       ("srcmmd"
			"#+begin_src mermaid${1:}\n$0\n#+end_src\n"
			"Org Mermaid src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcmmd_Org_Src_Mermaid"
			nil nil)
		       ("srcmaple"
			"#+begin_src maple${1:}\n$0\n#+end_src\n"
			"Org Maple src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcmaple_Org_Src_Maple"
			nil nil)
		       ("srclean"
			"#+begin_src lean${1:}\n$0\n#+end_src\n"
			"Org Lean src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srclean_Org_Src_Lean"
			nil nil)
		       ("srcel"
			"#+begin_src emacs-lisp${1:}\n$0\n#+end_src\n"
			"Org Emacs Lisp src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcel_Org_Src_Emacs_Lisp"
			nil nil)
		       ("srcdot"
			"#+begin_src dot${1:}\n$0\n#+end_src\n"
			"Org DOT src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcdot_Org_Src_Dot"
			nil nil)
		       ("srccpp"
			"#+begin_src C++${1:}\n$0\n#+end_src\n"
			"Org C++ src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srccpp_Org_Src_Cpp"
			nil nil)
		       ("srcc" "#+begin_src C${1:}\n$0\n#+end_src\n"
			"Org C src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/srcc_Org_Src_C"
			nil nil)
		       ("src"
			"#+begin_src ${1:python}${2:}\n$0\n#+end_src\n"
			"Org src block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/src_Org_Src_Block"
			nil nil)
		       ("sr" "^{2}" "Square" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sr_Square"
			nil nil)
		       ("sql"
			"#+BEGIN_SRC sql\nselect * from $0 limit 1\n#+END_SRC"
			"org-sql" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sql"
			nil nil)
		       ("sq" "\\sqrt{ $1 }$2" "Square Root" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/sq_Square_Root"
			nil nil)
		       ("spl"
			"\\begin{equation*}\n\\begin{split}\n$1 &= $2 \\\\\n$3 &= $0\n\\end{split}\n\\end{equation*}\n"
			"Split" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/spl_Split"
			nil nil)
		       ("solution"
			"#+begin_solution\n$0\n#+end_solution\n"
			"Org solution block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/solution_Solution"
			nil nil)
		       ("simm" "\\sim" "Similar To" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/simm_Similar_To"
			nil nil)
		       ("sim=" "\\simeq" "Approx Equal" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sim_Approx_Equal"
			nil nil)
		       ("setsubfile"
			"\\documentclass[$1]{subfiles}\n\\graphicspath{{$2}}\n$0"
			"SetSubfile" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/setsubfile_SetSubfile"
			nil nil)
		       ("set" "\\{ $1 \\}$2" "Set" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/set_Set"
			nil nil)
		       ("section:ref" "${1:Section}~\\ref{sec:$2}$0"
			"Section:Ref" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/section_ref_Section_Ref"
			nil nil)
		       ("secpar" "1^{${1:\\lambda}}$0\n"
			"Security parameter" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/secpar_Security_Parameter"
			nil nil)
		       ("secl"
			"\\section{$1}\\label{sec:$1}\n${0:$TM_SELECTED_TEXT}"
			"Section (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/secl_Section_with_label_"
			nil nil)
		       ("sec" "\\section{$1}\n${0:$TM_SELECTED_TEXT}"
			"Section (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sec_Section_no_label_"
			nil nil)
		       ("sch"
			"i\\hbar \\frac{\\partial}{\\partial t}\\lvert\\psi(t)\\rangle = H\\lvert\\psi(t)\\rangle$0\n"
			"Schrodinger equation" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sch_Schrodinger_Equation"
			nil nil)
		       ("sample"
			"${1:x} \\xleftarrow{\\mathrm{R}} ${2:S}$0\n"
			"Random sampling" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/sample_Random_Sampling"
			nil nil)
		       ("rm" "\\mathrm{$1}$2" "Roman" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/rm_Roman"
			nil nil)
		       ("remark"
			"\\begin{remark}\n	$1\n\\end{remark}\n$0"
			"Remark" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/remark_Remark"
			nil nil)
		       ("ref" "\\ref{$1: $2}$0" "Reference" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/ref_Reference"
			nil nil)
		       ("redm" "${1:A} \\le_m^p ${2:B}$0\n"
			"Polynomial many-one reduction" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/redm_Many_One_Reduction"
			nil nil)
		       ("redT" "${1:A} \\le_T^p ${2:B}$0\n"
			"Polynomial Turing reduction" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/redT_Turing_Reduction"
			nil nil)
		       ("readme"
			"Porgram kernel\n============\n\nThere are several guides for developers and users. These guides can\nbe rendered in a number of formats, like HTML and PDF. Please read\nDocumentation/admin-guide/README.rst first.\n\nPlease read the Documentation/process/changes.rst file, as it contains the\nrequirements for building and running this program, and information about\nthe problems which may result by upgrading your program."
			"readme" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/readme"
			nil nil)
		       ("rd" "^{$1}$2" "Raise to Power" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/rd_Raise_to_Power"
			nil nil)
		       ("qu"
			(progn
			  (let
			      ((text (or yas-selected-text ""))
			       (beg (point)))
			    (insert "#+begin_quote\n" text
				    "\n#+end_quote")
			    (goto-char (+ beg 14 (length text)))))
			"quote block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/quote"
			nil nil)
		       ("question"
			"#+begin_question\n$0\n#+end_question\n"
			"Org question block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/question_Org_Question_Block"
			nil nil)
		       ("qgate" "\\operatorname{${1:U}}$0\n"
			"Quantum gate" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/qgate_Quantum_Gate"
			nil nil)
		       ("qft"
			"\\operatorname{QFT}_{${1:n}}\\lvert ${2:x}\\rangle =\n\\frac{1}{\\sqrt{${3:2^n}}}\\sum_{${4:y}=0}^{${3:2^n}-1}\ne^{2\\pi i ${2:x}${4:y}/${3:2^n}}\\lvert ${4:y}\\rangle$0\n"
			"Quantum Fourier transform" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/qft_Quantum_Fourier_Transform"
			nil nil)
		       ("qcirc"
			"\\begin{quantikz}\n\\lstick{\\ket{0}} & \\gate{H} & \\ctrl{1} & \\qw \\\\\n\\lstick{\\ket{0}} & \\qw      & \\targ{}  & \\qw\n\\end{quantikz}\n$0\n"
			"Quantikz circuit" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/qcirc_Quantikz_Circuit"
			nil nil)
		       ("pu" "\\pu{ $1 }" "Physical Units" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/pu_Physical_Units"
			nil nil)
		       ("ptr"
			"\\operatorname{Tr}_{${1:B}}\\left(\\rho_{${2:AB}}\\right)$0\n"
			"Partial trace" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ptr_Partial_Trace"
			nil nil)
		       ("proposition"
			"#+begin_proposition\n$0\n#+end_proposition\n"
			"Org proposition full block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/proposition_Proposition_no_label_"
			nil nil)
		       ("propl"
			"\\begin{proposition}{$1}\\label{pro:$1}\n		$2\n\\end{proposition}\n$0"
			"Proposition (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/propl_Proposition_with_label_"
			nil nil)
		       ("property"
			"#+begin_property\n$0\n#+end_property\n"
			"Org property block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/property_Org_Property_Block"
			nil nil)
		       ("prop" "\\propto" "Proportional To" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/prop_Proportional_To"
			nil nil)
		       ("prop" "#+begin_prop\n$0\n#+end_prop\n"
			"Org proposition block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/prop_Org_Proposition_Block"
			nil nil)
		       ("pd" "■\n" "proof end" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/proof_end"
			nil nil)
		       ("proof" "#+begin_proof\n$0\n#+end_proof\n"
			"Org proof block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/proof_Proof"
			nil nil)
		       ("proj"
			"\\lvert ${1:\\psi}\\rangle\\langle ${1:\\psi}\\rvert $0\n"
			"Projector" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/proj_Projector"
			nil nil)
		       ("prod" "\\prod" "Product" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/prod_Product"
			nil nil)
		       ("problemset"
			"\\begin{problemset}\n	$1\n\\end{problemset}\n$0"
			"Problemset" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/problemset_Problemset"
			nil nil)
		       ("problem"
			"#+begin_problem\n$0\n#+end_problem\n"
			"Org problem block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/problem_Problem"
			nil nil)
		       ("ppt" "\\mathsf{PPT}$0\n" "PPT adversary" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ppt_PPT_Adversary"
			nil nil)
		       ("povm" "\\{${1:E_m}\\}_{${2:m}}$0\n" "POVM"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/povm_POVM"
			nil nil)
		       ("postulate"
			"\\begin{postulate}{$1}\n		$2\n\\end{postulate}\n$0"
			"Postulate (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/postulate_Postulate_no_label_"
			nil nil)
		       ("postl"
			"\\begin{postulate}{$1}\\label{pos:$1}\n		$2\n\\end{postulate}\n$0"
			"Postulate (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/postl_Postulate_with_label_"
			nil nil)
		       ("polylog"
			"\\operatorname{polylog}\\left(${1:n}\\right)$0\n"
			"Polylogarithmic" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/polylog_Polylogarithmic"
			nil nil)
		       ("poly"
			"\\operatorname{poly}\\left(${1:n}\\right)$0\n"
			"Polynomial" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/poly_Polynomial"
			nil nil)
		       ("pmat"
			"\\begin{pmatrix}\n$0\n\\end{pmatrix}\n"
			"Pmatrix" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/pmat_Pmatrix"
			nil nil)
		       ("ps"
			"#DARKORANGE/LIGHTORANGE/DARKBLUE/LIGHTBLUE/DARKRED/LIGHTRED/DARKGREEN/LIGHTGREEN\n!define DARKBLUE\n"
			"plantuml-style" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/plantuml-style"
			nil nil)
		       ("plaininline" "\\lstinline{$1}$0" "lstinline"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/plaininline_lstinline"
			nil nil)
		       ("plain"
			"\\begin{lstlisting}\n	$1\n\\end{lstlisting}\n$0"
			"lstlisting" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/plain_lstlisting"
			nil nil)
		       ("part" "\\begin{part}\n	$0\n\\end{part}"
			"Part" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/part_Part"
			nil nil)
		       ("parl"
			"\\paragraph{$1}\\label{par:$1}\n${0:$TM_SELECTED_TEXT}"
			"Paragraph (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/parl_Paragraph_with_label_"
			nil nil)
		       ("para" "\\parallel" "Parallel" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/para_Parallel"
			nil nil)
		       ("par"
			"\\frac{ \\partial $1 }{ \\partial $2 } $3"
			"Partial Derivative" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/par_Partial_Derivative"
			nil nil)
		       ("par"
			"\\paragraph{$1}\n${0:$TM_SELECTED_TEXT}"
			"Paragraph (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/par_Paragraph_no_label_"
			nil nil)
		       ("page" "${1:page}~\\pageref{$2}$0" "Page" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/page_Page"
			nil nil)
		       ("packages.el"
			";;; packages.el --- Description -*- lexical-binding: t; -*-\n;;\n;; Copyright (C) 2023 自杰\n;;\n;; Author: 自杰 <van@windos99.local>\n;; Maintainer: 自杰 <van@windos99.local>\n;; Created: September 27, 2023\n;; Modified: September 27, 2023\n;; Version: 0.0.1\n;; Keywords: abbrev bib c calendar comm convenience data docs emulations extensions faces files frames games hardware help hypermedia i18n internal languages lisp local maint mail matching mouse multimedia news outlines processes terminals tex tools unix vc wp\n;; Homepage: https://github.com/van/packages\n;; Package-Requires: ((emacs \"24.3\"))\n;;\n;; This file is not part of GNU Emacs.\n;;\n;;; Commentary:\n;;\n;;  Description\n;;\n;;; Code:\n\n\n\n(provide 'packages)\n;;; packages.el ends here"
			"packages.el" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/packages.el"
			nil nil)
		       ("ox" "\\otimes" "Tensor Product" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ox_Tensor_Product"
			nil nil)
		       ("overview"
			"#+begin_overview\n$0\n#+end_overview\n"
			"Org overview block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/overview_Org_Overview_Block"
			nil nil)
		       ("outlineexp"
			(progn
			  (let
			      ((text (or yas-selected-text ""))
			       (beg (point)))
			    (insert "\\[\n" text "\n\\]")
			    (goto-char (+ beg 3 (length text)))))
			"OutlineExp" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/outlineexp_OutlineExp"
			nil nil)
		       ("outer" "\\ket{$1} \\bra{$1} $2"
			"Outer Product" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/outer_Outer_Product"
			nil nil)
		       ("otarget"
			"<<eq-`(format-time-string \"%Y%m%dT%H%M%S\")`${1:-slug}>>\n$0\n"
			"Org dedicated target" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/otarget_Org_Target"
			nil nil)
		       ("orr" "\\cup" "Union" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/orr_Union"
			nil nil)
		       ("orgid"
			":PROPERTIES:\n:ID: `(format-time-string \"%Y%m%dT%H%M%S\")`${1:-slug}\n:END:\n$0\n"
			"Org ID property drawer" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/orgid_Org_ID_Property"
			nil nil)
		       ("order"
			"#+BEGIN_SRC plantuml :file ./image/time.svg\n!define LIGHTGREEN\nskinparam backgroundColor transparent\n\nA -> B: reqest\nB -> B: handle\nB -> A: response\n\n#+END_SRC\n"
			"order" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/order"
			nil nil)
		       ("oracle"
			"\\mathcal{${1:O}}\\left(${2:x}\\right)$0\n"
			"Oracle" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/oracle_Oracle"
			nil nil)
		       ("openlink"
			"http://10.31.2.53/openlink.html?link=$0"
			"NasOpenlink" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/openlink_NasOpenlink"
			nil nil)
		       ("oooo" "\\omega" "Omega (lowercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/oooo_Omega_lowercase_"
			nil nil)
		       ("ooo" "\\infty" "Infinity" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ooo_Infinity"
			nil nil)
		       ("ome" "\\omega" "Omega (alt)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ome_Omega_alt_"
			nil nil)
		       ("oint" "\\oint" "Contour Integral" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/oint_Contour_Integral"
			nil nil)
		       ("oinf" "\\int_{0}^{\\infty} $1 \\, d$2 $3"
			"Integral 0 to Infinity" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/oinf_Integral_0_to_Infinity"
			nil nil)
		       ("o+" "\\oplus" "Direct Sum" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/o+_Direct_Sum"
			nil nil)
		       ("npcomplete"
			"\\mathsf{NP}\\text{-complete}$0\n"
			"NP-complete" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/npcomplete_NP_Complete"
			nil nil)
		       ("notin" "\\not\\in" "Not Element Of" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/notin_Not_Element_Of"
			nil nil)
		       ("note" "#+begin_note\n$0\n#+end_note\n"
			"Org note block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/note_Note"
			nil nil)
		       ("norm" "\\lvert $1 \\rvert $2"
			"Absolute Value" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/norm_Absolute_Value"
			nil nil)
		       ("negl"
			"\\operatorname{negl}\\left(${1:\\lambda}\\right)$0\n"
			"Negligible" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/negl_Negligible"
			nil nil)
		       ("nabl" "\\nabla" "Nabla" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/nabl_Nabla"
			nil nil)
		       ("msun" "M_{\\odot}" "Solar Mass" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/msun_Solar_Mass"
			nil nil)
		       ("mod" "|$1|$2" "Modulus" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/mod_Modulus"
			nil nil)
		       ("mind"
			"#+BEGIN_SRC plantuml :file ./image/mind.svg\n@startmindmap\n,* A\n,**[#Orange] C\n,**[#Orange] D\n#+END_SRC"
			"mind" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/mind"
			nil nil)
		       ("math"
			(progn
			  (let
			      ((text (or yas-selected-text ""))
			       (beg (point)))
			    (insert "\\(" text "\\)")
			    (goto-char (+ beg 2 (length text)))))
			"Math" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/math_Math"
			nil nil)
		       ("mat"
			"\\begin{${1:p/b/v/V/B/small}matrix}\n$0\n\\end{${1:p/b/v/V/B/small}matrix}\n"
			"Matrix" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/mat_Matrix"
			nil nil)
		       ("me"
			"\\langle ${1:\\phi}\\rvert ${2:A}\\lvert ${3:\\psi}\\rangle $0\n"
			"matrix element" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/martix_braket"
			nil nil)
		       ("marginpar" "\\marginpar{$1}\n$0" "Marginpar"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/marginpar_Marginpar"
			nil nil)
		       ("lra" "\\left< $1 \\right> $2"
			"Left-Right Angle" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lra_Left-Right_Angle"
			nil nil)
		       ("lr(" "\\left( $1 \\right) $2"
			"Left-Right Parentheses" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lr_Left-Right_Parentheses"
			nil nil)
		       ("lr[" "\\left[ $1 \\right] $2"
			"Left-Right Brackets" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lr_Left-Right_Brackets"
			nil nil)
		       ("lr{" "\\left\\{ $1 \\right\\} $2"
			"Left-Right Braces" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lr_Left-Right_Braces"
			nil nil)
		       ("lr|" "\\left| $1 \\right| $2"
			"Left-Right Absolute" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lr_Left-Right_Absolute"
			nil nil)
		       ("llll" "\\lambda" "Lambda (lowercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/llll_Lambda_lowercase_"
			nil nil)
		       ("listing:ref" "${1:Listing}~\\ref{lst:$2}$0"
			"Listing:Ref" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/listing_ref_Listing_Ref"
			nil nil)
		       ("lim" "\\lim_{ $1 \\to $2 } $3" "Limit" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lim_Limit"
			nil nil)
		       ("lemmal"
			"\\begin{lemma}{$1}\\label{lem:$1}\n	$2\n\\end{lemma}\n$0"
			"Lemma (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lemmal_Lemma_with_label_"
			nil nil)
		       ("lemma" "#+begin_lemma\n$0\n#+end_lemma\n"
			"Org lemma block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lemma_Lemma_no_label_"
			nil nil)
		       ("lax"
			"\\begin{align*}\n$1 &= $2 \\\\\n$3 &= $0\n\\end{align*}\n"
			"latex" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/latex"
			nil nil)
		       ("lang"
			"${1:L} \\subseteq \\{0,1\\}^{${2:*}}$0\n"
			"Language over bits" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/lang_Language"
			nil nil)
		       ("kraus"
			"\\mathcal{${1:E}}(\\rho)=\\sum_${2:k} ${3:E_k}\\rho ${3:E_k}^{\\dagger}$0\n"
			"Kraus map" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/kraus_Kraus_Map"
			nil nil)
		       ("kkkk" "\\kappa" "Kappa" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/kkkk_Kappa"
			nil nil)
		       ("ket1" "\\lvert 1\\rangle $0\n" "ket1" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/ket1"
			nil nil)
		       ("ket0" "\\lvert 0\\rangle $0\n" "ket0" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/ket0"
			nil nil)
		       ("ket" "\\lvert ${1:\\psi}\\rangle $0\n" "ket"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ket"
			nil nil)
		       ("kbt" "k_{B}T" "Boltzmann Constant" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/kbt_Boltzmann_Constant"
			nil nil)
		       ("json"
			"#+BEGIN_SRC plantuml :file json-t.png\n@startjson\n<style>\ndocument {\n  BackGroundColor transparent\n}\n</style>\n#highlight \"lastName\"\n#highlight \"address\" / \"city\"\n#highlight \"phoneNumbers\" / \"0\" / \"number\"\n{\n  \"lastName\": \"Smith\",\n  \"address\": {\n    \"streetAddress\": \"21 2nd Street\",\n    \"city\": \"New York\",\n  }\n}\n@endjson\n#+END_SRC"
			"json" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/json"
			nil nil)
		       ("item" "\\item $1" "item" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/item_item"
			nil nil)
		       ("item"
			"\\begin{itemize}\n\\item $0\n\\end{itemize}\n"
			"Itemize" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/item_Itemize"
			nil nil)
		       ("iso" "{}^{$1}_{$2}$3" "Isotope" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/iso_Isotope"
			nil nil)
		       ("invs" "^{-1}" "Inverse" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/invs_Inverse"
			nil nil)
		       ("introduction"
			"\\begin{introduction}\n	$1\n\\end{introduction}\n$0"
			"Introduction" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/introduction_Introduction"
			nil nil)
		       ("int" "\\int $1 \\, d$2 $3" "Integral" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/int_Integral"
			nil nil)
		       ("inn" "\\in" "Element Of" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/inn_Element_Of"
			nil nil)
		       ("inlineexp"
			(progn
			  (let
			      ((text (or yas-selected-text ""))
			       (beg (point)))
			    (insert "\\(" text "\\)")
			    (goto-char (+ beg 2 (length text)))))
			"InlineExp" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/inlineexp_InlineExp"
			nil nil)
		       ("info" "#+begin_info\n$0\n#+end_info\n"
			"Org info block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/info_Org_Info_Block"
			nil nil)
		       ("infi"
			"\\int_{-\\infty}^{\\infty} $1 \\, d$2 $3"
			"Integral -Inf to Inf" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/infi_Integral_-Inf_to_Inf"
			nil nil)
		       ("indic"
			"\\mathbf{1}\\left\\{${1:E}\\right\\}$0\n"
			"Indicator" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/indic_Indicator"
			nil nil)
		       ("important"
			"#+begin_important\n$0\n#+end_important\n"
			"Org important block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/important_Org_Important_Block"
			nil nil)
		       ("iint" "\\iint" "Double Integral" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/iint_Double_Integral"
			nil nil)
		       ("iiint" "\\iiint" "Triple Integral" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/iiint_Triple_Integral"
			nil nil)
		       ("iiii" "\\iota" "Iota" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/iiii_Iota"
			nil nil)
		       ("if" "\\If{$1}\n\\ElsIf{$2}\n\\Else\n\\EndIf"
			"Algorithm:If" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/if_Algorithm_If"
			nil nil)
		       ("idlink" "[[id:${1:id}][$2]]$0\n"
			"Org ID link" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/idlink_Org_ID_Link"
			nil nil)
		       ("iden"
			"\\begin{pmatrix}\n1 & 0 & \\dots & 0 \\\\\n0 & 1 & \\dots & 0 \\\\\n\\vdots & \\vdots & \\ddots & \\vdots \\\\\n0 & 0 & \\dots & 1\n\\end{pmatrix}"
			"Identity Matrix" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/iden_Identity_Matrix"
			nil nil)
		       ("hybrid" "H_${1:i}: ${2:...}$0\n"
			"Hybrid game" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/hybrid_Hybrid_Game"
			nil nil)
		       ("bg" "#+ATTR_HTML: :style background: #3498db"
			"htmlbg" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/htmlbg"
			nil nil)
		       ("hlink" "[[*${1:headline}][$2]]$0\n"
			"Org headline link" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/hlink_Org_Headline_Link"
			nil nil)
		       ("hide" "\\begin{hide}\n	$1\n\\end{hide}\n$0"
			"hide" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/hide_hide"
			nil nil)
		       ("he4" "{}^{4}_{2}He" "Helium-4" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/he4_Helium-4"
			nil nil)
		       ("he3" "{}^{3}_{2}He" "Helium-3" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/he3_Helium-3"
			nil nil)
		       ("hat" "\\hat{$1}$2" "Hat Accent" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/hat_Hat_Accent"
			nil nil)
		       ("hash"
			"${1:H}: \\{0,1\\}^* \\to \\{0,1\\}^{${2:\\lambda}}$0\n"
			"Hash function" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/hash_Hash_Function"
			nil nil)
		       ("had" "H\\lvert ${1:\\psi}\\rangle$0\n"
			"Hadamard on state" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/had_Hadamard_On_State"
			nil nil)
		       ("gk"
			"* 发版\n|       时间 | 系统 | 版本 | 说明                   | 核心开发 |\n|            |      |      |                        |          |"
			"gk" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/gk"
			nil nil)
		       ("gggg" "\\gamma" "Gamma (lowercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/gggg_Gamma_lowercase_"
			nil nil)
		       ("ggbraw"
			"#+name: ggb-raw-`(format-time-string \"%Y%m%dT%H%M%S\")`\n#+begin_src latex :eval never :exports none :results none\n$0\n#+end_src\n"
			"Org GeoGebra raw TikZ block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ggbraw_Org_GeoGebra_Raw_TikZ"
			nil nil)
		       ("gat"
			"\\begin{gather*}\n$1 \\\\\n$0\n\\end{gather*}\n"
			"Gather(ed)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/gat_Gather_ed_"
			nil nil)
		       ("game"
			"\\mathsf{Game}^{${1:ind-cpa}}_{${2:\\Pi},\\mathcal{${3:A}}}\\left(${4:\\lambda}\\right)$0\n"
			"Cryptographic game" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/game_Crypto_Game"
			nil nil)
		       ("ftlink"
			"[[file:${1:path.org}::${2:target}][$3]]$0\n"
			"Org file target link" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ftlink_Org_File_Target_Link"
			nil nil)
		       ("frac" "\\frac{$1}{$2}$3" "Fraction" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/frac_Fraction"
			nil nil)
		       ("for" "\\For{i=0:$1}\n	\\State $0\n\\EndFor"
			"Algorithm:For" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/for_Algorithm_For"
			nil nil)
		       ("floor" "\\lfloor $1 \\rfloor $2" "Floor" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/floor_Floor"
			nil nil)
		       ("figure:ref" "${1:Figure}~\\ref{fig:$2}$0"
			"Figure:Ref" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/figure_ref_Figure_Ref"
			nil nil)
		       ("figure:acm:*"
			"\\begin{figure*}\n	\\includegraphics[width=0.45\\textwidth]{figures/$1}\n	\\caption{$2}\\label{fig:$3}\n\\end{figure*}\n$0"
			"Figure:ACM:*" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/figure_acm_Figure_ACM_"
			nil nil)
		       ("figure:acm"
			"\\begin{figure}\n	\\includegraphics[width=0.45\\textwidth]{figures/$1}\n	\\caption{$2}\\label{fig:$3}\n\\end{figure}\n$0"
			"Figure:ACM" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/figure_acm_Figure_ACM"
			nil nil)
		       ("figure"
			"\\begin{figure}\n	\\begin{center}\n		\\includegraphics[width=0.95\\textwidth]{figures/$1}\n	\\end{center}\n	\\caption{$3}\\label{fig:$4}\n\\end{figure}\n$0"
			"Figure" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/figure_Figure"
			nil nil)
		       ("feqlink"
			"[[file:${1:path.org}::<<eq-${2:id}>>][$3]]$0\n"
			"Org file formula target link" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/feqlink_Org_File_Formula_Target_Link"
			nil nil)
		       ("expval"
			"\\langle ${1:\\psi}\\rvert ${2:A}\\lvert ${1:\\psi}\\rangle $0\n"
			"Expectation value" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/expval_Expectation_Value"
			nil nil)
		       ("expect"
			"\\mathbb{E}_{${1:x \\sim D}}\\left[${2:f(x)}\\right]$0\n"
			"Expectation" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/expect_Expectation"
			nil nil)
		       ("exercise"
			"#+begin_exercise\n$0\n#+end_exercise\n"
			"Org exercise block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/exercise_Exercise"
			nil nil)
		       ("example"
			"#+begin_example\n$0\n#+end_example\n"
			"Org example block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/example_Example"
			nil nil)
		       ("eset" "\\emptyset" "Empty Set" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/eset_Empty_Set"
			nil nil)
		       ("equation"
			"\\begin{equation}\n$1\n\\label{eq:$2}\n\\end{equation}\n"
			"Equation" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/equation_Equation"
			nil nil)
		       ("equ"
			"\\begin{equation*}\n	$1\n\\end{equation*}"
			"Equ" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/equ_Equ"
			nil nil)
		       ("eqtarget"
			"\\[\n$0\n\\]     <<eq-`(format-time-string \"%Y%m%dT%H%M%S\")`${1:-slug}>>\n"
			"Org formula target" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/eqtarget_Org_Formula_Target"
			nil nil)
		       ("enumerate"
			"\\begin{enumerate}\n\\item $0\n\\end{enumerate}\n"
			"Enumerate" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/enumerate_Enumerate"
			nil nil)
		       ("ent"
			"entity $0 {\nID\n--\n,* Name\n}\nnote left #5DADE2 : comment"
			"entityt" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/entityt"
			nil nil)
		       ("entity"
			"#+BEGIN_SRC plantuml :file ./image/db.svg\n!define LIGHTGREEN\nscale 550 width\nskinparam backgroundColor transparent\nentity t_credit_apply_log {\n  * id\n  --\n  * 客户id\n  * 客户类型\n  * ...\n}\nnote left #red: 申请表\\n1.获取合同\\t插入\\n2.签署合同\\t更新\n\nentity t_product_info {\n  * id\n  -\n  * 产品名称\n  * 产品利率\n  * 资方id\n  * ...\n}\nnote right #6495ED: 产品信息表\n\nt_credit_apply_log }o--|| t_product_info\n#+END_SRC\n"
			"entity" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/entity"
			nil nil)
		       ("empty"
			"\\null\\thispagestyle{empty}\n\\newpage\n$0"
			"EmptyPage" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/empty_EmptyPage"
			nil nil)
		       ("eeee" "\\epsilon" "Epsilon" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/eeee_Epsilon"
			nil nil)
		       ("ee" "e^{ $1 }$2" "Exponential" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ee_Exponential"
			nil nil)
		       ("e\\xi sts" "\\exists" "Exists" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/e_xi_sts_Exists"
			nil nil)
		       ("dyad"
			"\\lvert ${1:\\phi}\\rangle\\langle ${2:\\psi}\\rvert $0\n"
			"Dyad" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/dyad_Dyad"
			nil nil)
		       ("dot" "\\dot{$1}$2" "Dot Accent" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/dot_Dot_Accent"
			nil nil)
		       ("dot"
			"#+BEGIN_SRC DOT :file image/dotgra.svg\n    digraph G {\n        node [shape=\"box\",fontcolor=\"0xfffff\"]\n        bgcolor=\"transparent\"\n        node [shape=\"box\",fontcolor=\"#c475db\"]\n        edge [color=\"#a69fe0\",fontcolor=white]\n        rankdir = TD\n         NC -> SlaughterServer1 [dir=both,minlen=2,label=\"ϟ\"]\n         NC -> SlaughterServer2 [dir=both,minlen=2,label=\"ϟ\"]\n\n        subgraph clusterD {\n            label = \"Local\";\n            SlaughterServer2 -> LocalDB2 [splines=ortho]\n            SlaughterServer2 -> SlaughterClient2 [minlen=1]\n            {rank=same;  SlaughterServer2 , LocalDB2 }\n        }\n\n        subgraph clusterM {\n            label = \"Local\";\n            SlaughterServer1 -> LocalDB1 [splines=ortho]\n            SlaughterServer1 -> SlaughterClient1 [minlen=1]\n            {rank=same;  SlaughterServer1 , LocalDB1 }\n        }\n    }\n#+END_SRC"
			"dot" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/dot"
			nil nil)
		       (";"
			(progn
			  (let
			      ((text (or yas-selected-text ""))
			       (beg (point)))
			    (insert "\\(" text "\\)")
			    (goto-char (+ beg 2 (length text)))))
			"display inline math" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/disply-inline-math"
			nil nil)
		       ("displaylatex"
			"#+begin_display_latex\n$0\n\n\n#+end_display_latex\n"
			"Org Display LaTeX Block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/displaylatex_Org_Display_LaTeX_Block"
			nil nil)
		       (":"
			(progn
			  (let
			      ((text (or yas-selected-text ""))
			       (beg (point)))
			    (insert "\\[\n" text "\n\\]")
			    (goto-char (+ beg 3 (length text)))))
			"display math" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/display-math"
			nil nil)
		       ("dint" "\\int_{$1}^{$2} $3 \\, d$4 $5"
			"Definite Integral" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/dint_Definite_Integral"
			nil nil)
		       ("desc"
			"\\begin{description}\n\\item[$1] $0\n\\end{description}\n"
			"Description" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/desc_Description"
			nil nil)
		       ("density"
			"\\rho = \\sum_${1:i} ${2:p_i}\\lvert ${3:\\psi_i}\\rangle\\langle ${3:\\psi_i}\\rvert$0\n"
			"Density operator" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/density_Density_Operator"
			nil nil)
		       ("del" "\\nabla" "Del" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/del_Del"
			nil nil)
		       ("defn" "#+begin_defn\n$0\n#+end_defn\n"
			"Org definition alias block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/defn_Org_Definition_Alias"
			nil nil)
		       ("defl"
			"\\begin{definition}{$1}\\label{def:$1}\n	$2\n\\end{definition}\n$0"
			"Definition (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/defl_Definition_with_label_"
			nil nil)
		       ("definition"
			"#+begin_definition\n$0\n#+end_definition\n"
			"Org definition block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/definition_Definition_no_label_"
			nil nil)
		       ("ddt" "\\frac{d}{dt}" "Time Derivative" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ddt_Time_Derivative"
			nil nil)
		       ("ddot" "\\ddot{$1}$2" "Double Dot Accent" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ddot_Double_Dot_Accent"
			nil nil)
		       ("dddd" "\\delta" "Delta (lowercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/dddd_Delta_lowercase_"
			nil nil)
		       ("datechange" "\\datechange{$1}{$2}$0"
			"Datechange" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/datechange_Datechange"
			nil nil)
		       ("daily"
			"* 汇报日期： `(format-time-string \"%Y-%m-%d\")`\n本周工作：\n\n下周工作："
			"daily" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/daily"
			nil nil)
		       ("dag" "^{\\dagger}" "Dagger" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/dag_Dagger"
			nil nil)
		       ("d2m"
			"# -*- mode: snippet -*-\n# name:\n# key: trigger-key\n# condition: t\n# --"
			"d2m" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/d2m"
			nil nil)
		       ("d2"
			"#+begin_src d2 :file demo.svg\ndirection  : right\nstyle.fill : transparent\nvars: {\n  nodecolor          : \"#E67E22\"\n  style-stroke       : \"#17202A\"\n  style-stroke-width : 2\n  style-fill-pattern : dots\n  style-shadow       : true\n  line-style-fill    : \"#884EA0\"\n}\n\nclasses: {\n    2dn: {\n        style.multiple     : true\n    }\n    3dn: {\n        style.3d           : true\n    }\n    2de: {\n        style.animated     : true\n        style.stroke-width : \\${style-stroke-width}\n        style.stroke       : \\${line-style-fill}\n    }\n}\n\n\nA :    { class : 2dn }\nB :    { class : 3dn }\nA -> B { class : 2de }\n\n*.style.fill         : \\${nodecolor}\n*.style.stroke       : \\${style-stroke}\n*.style.stroke-width : \\${style-stroke-width}\n*.style.fill-pattern : \\${style-fill-pattern}\n*.style.shadow       : \\${style-shadow}\n\n#+end_src"
			"d2" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/d2"
			nil nil)
		       ("corollary"
			"#+begin_corollary\n$0\n#+end_corollary\n"
			"Org corollary full block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/corollary_Corollary_no_label_"
			nil nil)
		       ("corl"
			"\\begin{corollary}{$1}\\label{cor:$1}\n	$2\n\\end{corollary}\n$0"
			"Corollary (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/corl_Corollary_with_label_"
			nil nil)
		       ("cor" "#+begin_cor\n$0\n#+end_cor\n"
			"Org corollary block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cor_Org_Corollary_Block"
			nil nil)
		       ("conclusion"
			"\\begin{conclusion}\n	$1\n\\end{conclusion}\n$0"
			"Conclusion" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/conclusion_Conclusion"
			nil nil)
		       ("concat" "\\mathbin{\\Vert}$0\n"
			"Concatenation" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/concat_Concatenation"
			nil nil)
		       ("compactitem"
			"\\begin{compactitem}\n	\\item $1\n\\end{compactitem}\n$0"
			"Compactitem" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/compactitem_Compactitem"
			nil nil)
		       ("comm" "\\left[${1:A}, ${2:B}\\right]$0\n"
			"Commutator" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/comm_Commutator"
			nil nil)
		       ("coNP" "\\mathsf{coNP}$0\n"
			"Complexity class coNP" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/coNP_Class_coNP"
			nil nil)
		       ("cnot" "\\operatorname{CNOT}$0\n" "CNOT" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cnot_CNOT"
			nil nil)
		       ("ct"
			"#+title: `(file-name-sans-extension (buffer-name))`\n#+subtitle: this is subtitle\n#+author: `(getenv \"USER\")`\n#+SETUPFILE: ~/.doom.d/org-classic-head.setup"
			"ctitle" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/classic-title"
			nil nil)
		       ("classP" "\\mathsf{P}$0\n"
			"Complexity class P" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/classP_Class_P"
			nil nil)
		       ("classNP" "\\mathsf{NP}$0\n"
			"Complexity class NP" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/classNP_Class_NP"
			nil nil)
		       ("cite" "\\cite{$1}$0" "Cite" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cite_Cite"
			nil nil)
		       ("change"
			"\\begin{change}\n	$1\n\\end{change}\n$0"
			"change" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/change_change"
			nil nil)
		       ("chal"
			"\\chapter{$1}\\label{chap:$1}\n${0:$TM_SELECTED_TEXT}"
			"Chapter (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/chal_Chapter_with_label_"
			nil nil)
		       ("cha" "\\chapter{$1}\n${0:$TM_SELECTED_TEXT}"
			"Chapter (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cha_Chapter_no_label_"
			nil nil)
		       ("ceil" "\\lceil $1 \\rceil $2" "Ceiling" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ceil_Ceiling"
			nil nil)
		       ("cee" "\\ce{ $1 }" "Chemical Equation" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/cee_Chemical_Equation"
			nil nil)
		       ("cdot" "\\cdot" "Dot Product" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cdot_Dot_Product"
			nil nil)
		       ("cb" "^{3}" "Cube" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cb_Cube"
			nil nil)
		       ("cas"
			"\\begin{cases}\n${1:f(x) = x^2}, & \\\\text{if } ${2:x > 0} \\\\\n${3:0}, & \\\\text{otherwise}\n\\end{cases}\n"
			"Cases" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/cas_Cases"
			nil nil)
		       ("cp" "#+CAPTION: caption" "cp" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/caption"
			nil nil)
		       ("bk"
			"\\langle ${1:\\phi}\\rvert ${2:\\psi}\\rangle $0\n"
			"Braket" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/brk_Braket"
			nil nil)
		       ("bra" "\\langle ${1:\\psi}\\rvert $0\n" "bra"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bra"
			nil nil)
		       ("bmat"
			"\\begin{bmatrix}\n$0\n\\end{bmatrix}\n"
			"Bmatrix" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bmat_Bmatrix"
			nil nil)
		       ("blocktarget"
			"<<${1:src}-`(format-time-string \"%Y%m%dT%H%M%S\")`>>\n#+begin_$1\n$0\n#+end_$1\n"
			"Org block target" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/blocktarget_Org_Block_Target"
			nil nil)
		       (";b"
			"`(let* ((blk (yas-choose-value\n              '(\"overview\" \"toc\" \"definition\" \"defn\" \"theorem\" \"thm\"\n                \"lemma\" \"corollary\" \"cor\" \"proposition\" \"prop\"\n                \"property\" \"proof\" \"solution\" \"answer\" \"exercise\"\n                \"problem\" \"question\" \"example\" \"attention\" \"important\"\n                \"tip\" \"summary\" \"note\" \"info\" \"warning\"))))\n   (insert (concat \"#+begin_\" blk \"\\n\\n#+end_\" blk)))`\n"
			"org special block (scripted; cached choice)"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/block-special-all"
			nil nil)
		       (";bb" "#+begin_${1:block}\n$0\n#+end_${1}\n"
			"org special block (definition/theorem/...)"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/block"
			nil nil)
		       ("bloch"
			"\\rho = \\frac{1}{2}\\left(I + \\vec{${1:r}}\\cdot\\vec{\\sigma}\\right)$0\n"
			"Bloch form" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bloch_Bloch_Form"
			nil nil)
		       ("bigTheta"
			"\\Theta\\left(${1:f(n)}\\right)$0\n"
			"Big Theta" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bigTheta_Big_Theta"
			nil nil)
		       ("bigOmega"
			"\\Omega\\left(${1:f(n)}\\right)$0\n"
			"Big Omega" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bigOmega_Big_Omega"
			nil nil)
		       ("bigO" "O\\left(${1:f(n)}\\right)$0\n" "Big O"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bigO_Big_O"
			nil nil)
		       ("bf" "\\mathbf{$1}" "Bold Face" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bf_Bold_Face"
			nil nil)
		       ("bell"
			"\\frac{1}{\\sqrt{2}}\\left(\\lvert 00\\rangle + \\lvert 11\\rangle\\right)$0\n"
			"Bell state" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bell_Bell_State"
			nil nil)
		       ("begin"
			"\\begin{${1:env}}\n$2\n\\end{${1:env}}\n"
			"\\begin{}…\\end{}" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/begin_begin_end_"
			nil nil)
		       ("beg" "\\begin{$1}\n$2\n\\end{$1}\n"
			"Begin-End Environment" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/beg_Begin-End_Environment"
			nil nil)
		       ("bbbb" "\\beta" "Beta" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bbbb_Beta"
			nil nil)
		       ("bar" "\\bar{$1}$2" "Bar Accent" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/bar_Bar_Accent"
			nil nil)
		       ("bd"
			"[[https://img.shields.io/badge/supports-Emacs_27.1_to_29.1-red.svg?logo=gnuemacs&color=7F5AB6]]"
			"badge" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/badge"
			nil nil)
		       ("axioml"
			"\\begin{axiom}{$1}\\label{axi:$1}\n		$2\n\\end{axiom}\n$0"
			"Axiom (with label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/axioml_Axiom_with_label_"
			nil nil)
		       ("axiom"
			"\\begin{axiom}{$1}\n		$2\n\\end{axiom}\n$0"
			"Axiom (no label)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/axiom_Axiom_no_label_"
			nil nil)
		       ("avg" "\\langle $1 \\rangle $2"
			"Angle Brackets" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/avg_Angle_Brackets"
			nil nil)
		       ("attention"
			"#+begin_attention\n$0\n#+end_attention\n"
			"Org attention block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/attention_Org_Attention_Block"
			nil nil)
		       ("img" "[[file:./assets/]]\n" "img" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/attach"
			nil nil)
		       ("assumption"
			"\\begin{assumption}\n	$1\n\\end{assumption}\n$0"
			"Assumption" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/assumption_Assumption"
			nil nil)
		       ("array"
			"\\begin{array}{${1:c}}\n$0\n\\end{array}\n"
			"Array" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/array_Array"
			nil nil)
		       ("anticomm"
			"\\left\\{${1:A}, ${2:B}\\right\\}$0\n"
			"Anticommutator" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/anticomm_Anticommutator"
			nil nil)
		       ("answer" "#+begin_answer\n$0\n#+end_answer\n"
			"Org answer block" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/answer_Org_Answer_Block"
			nil nil)
		       ("and" "\\cap" "Intersection" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/and_Intersection"
			nil nil)
		       ("amp"
			"\\langle ${1:\\phi}\\rvert ${2:A}\\lvert ${3:\\psi}\\rangle $0\n"
			"Transition amplitude" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/amp_Transition_Amplitude"
			nil nil)
		       ("ali"
			"\\begin{align*}\n$1 &= $2 \\\\\n$3 &= $0\n\\end{align*}\n"
			"Align" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ali_Align"
			nil nil)
		       ("algo:ref" "${1:Algorithm}~\\ref{algo:$2}$0"
			"Algorithm:Ref" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/algo_ref_Algorithm_Ref"
			nil nil)
		       ("algo"
			"% \\usepackage{algorithm,algorithmicx,algpseudocode}\n\\begin{algorithm}\n	\\floatname{algorithm}{${1:Algorithm}}\n	\\algrenewcommand\\algorithmicrequire{\\textbf{${2:Input: }}}\n	\\algrenewcommand\\algorithmicensure{\\textbf{${3:Output: }}}\n	\\caption{$4}\\label{alg:$5}\n	\\begin{algorithmic}[1]\n		\\Require \\$input\\$\n		\\Ensure \\$output\\$\n		$6\n		\\State \\textbf{return} \\$state\\$\n	\\end{algorithmic}\n\\end{algorithm}\n$0"
			"Algorithm" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/algo_Algorithm"
			nil nil)
		       ("adv"
			"\\operatorname{Adv}^{${1:ind-cpa}}_{${2:\\Pi},\\mathcal{${3:A}}}\\left(${4:\\lambda}\\right)$0\n"
			"Cryptographic advantage" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/adv_Advantage"
			nil nil)
		       ("aaaa" "\\alpha $0\n" "Alpha" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/aaaa_Alpha"
			nil nil)
		       ("a.py"
			"import os\n\n# 定义要查找和替换的特征字符串\nSEARCH_TEXT = '(when (and (not (eobp)) (looking-at \"\\n\")) (let ((inhibit-modification-hooks t)) (ignore-errors (delete-blank-lines))))'\nREPLACE_TEXT = '(when (and (not (eobp)) (looking-at \"\\n\")) (let ((inhibit-modification-hooks t)) (ignore-errors (delete-char 1))))'\n\ndef batch_replace():\n    # 获取脚本自身的文件名，避免自残\n    script_name = os.path.basename(__file__)\n    count = 0\n\n    for root, dirs, files in os.walk('.'):\n        for file_name in files:\n            # 跳过脚本自己\n            if file_name == script_name:\n                continue\n\n            file_path = os.path.join(root, file_name)\n            \n            try:\n                # 读取内容\n                with open(file_path, 'r', encoding='utf-8') as f:\n                    content = f.read()\n\n                # 如果内容中包含目标字符串，则进行替换\n                if SEARCH_TEXT in content:\n                    new_content = content.replace(SEARCH_TEXT, REPLACE_TEXT)\n                    \n                    with open(file_path, 'w', encoding='utf-8') as f:\n                        f.write(new_content)\n                    \n                    print(f\"已处理: {file_path}\")\n                    count += 1\n            except Exception as e:\n                print(f\"无法处理 {file_path}: {e}\")\n\n    print(f\"\\n任务完成！共修改了 {count} 个文件。\")\n\nif __name__ == \"__main__\":\n    batch_replace()\n"
			"a.py" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/a.py"
			nil nil)
		       (":t" "\\vartheta" "Vartheta" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_t_Vartheta"
			nil nil)
		       ("#region" "%#Region $0" "Region Start" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/_region_Region_Start"
			nil nil)
		       ("#endregion" "%#Endregion" "Region End" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_endregion_Region_End"
			nil nil)
		       (":e" "\\varepsilon" "Varepsilon" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_e_Varepsilon"
			nil nil)
		       ("\"" "\\text{$1}$2" "Text Environment (short)"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Text_Environment_short_"
			nil nil)
		       ("_" "_{$1}$2" "Subscript" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Subscript"
			nil nil)
		       ("\\\\\\" "\\setminus" "Set Minus" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Set_Minus"
			nil nil)
		       ("!=" "\\neq" "Not Equal" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Not_Equal"
			nil nil)
		       ("<<" "\\ll" "Much Less" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Much_Less"
			nil nil)
		       (">>" "\\gg" "Much Greater" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Much_Greater"
			nil nil)
		       ("!>" "\\mapsto" "Maps To" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Maps_To"
			nil nil)
		       ("<=" "\\leq" "Less or Equal" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Less_or_Equal"
			nil nil)
		       ("=>" "\\implies" "Implies" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Implies"
			nil nil)
		       ("=<" "\\impliedby" "Implied By" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Implied_By"
			nil nil)
		       (">=" "\\geq" "Greater or Equal" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Greater_or_Equal"
			nil nil)
		       ("===" "\\equiv" "Equiv" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Equiv"
			nil nil)
		       ("**" "\\cdot" "Dot" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_Dot"
			nil nil)
		       ("<->" "\\leftrightarrow " "Left-Right Arrow"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/_-_Left-Right_Arrow"
			nil nil)
		       ("ZZ" "\\mathbb{Z}" "Integers" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/ZZ_Integers"
			nil nil)
		       ("Vrfy"
			"\\operatorname{Vrfy}_{${1:pk}}\\left(${2:m}, ${3:\\sigma}\\right) = ${4:1}$0\n"
			"Signature verification" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Vrfy_Verification"
			nil nil)
		       ("Vmat"
			"\\begin{Vmatrix}\n$0\n\\end{Vmatrix}\n"
			"Vmatrix (double)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Vmat_Vmatrix_double_"
			nil nil)
		       ("U" "\\underbrace{ ${VISUAL} }_{ $1 }"
			"Underbrace" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/U_Underbrace"
			nil nil)
		       ("UUUU" "\\Upsilon" "Upsilon (uppercase)" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/UUUU_Upsilon_uppercase_"
			nil nil)
		       ("Tr"
			"\\operatorname{Tr}\\left(${1:A}\\right)$0\n"
			"Trace operator" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Tr_Trace"
			nil nil)
		       ("TTTT" "\\Theta" "Theta (uppercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/TTTT_Theta_uppercase_"
			nil nil)
		       ("Sign"
			"${1:\\sigma} \\leftarrow \\operatorname{Sign}_{${2:sk}}\\left(${3:m}\\right)$0\n"
			"Signature" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Sign_Signature"
			nil nil)
		       ("S" "\\sqrt{ ${VISUAL} }" "Sqrt (visual)" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/S_Sqrt_visual_"
			nil nil)
		       ("SSSS" "\\Sigma" "Sigma (uppercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/SSSS_Sigma_uppercase_"
			nil nil)
		       ("Re" "\\mathrm{Re}" "Real Part" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Re_Real_Part"
			nil nil)
		       ("RR" "\\mathbb{R}" "Real Numbers" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/RR_Real_Numbers"
			nil nil)
		       ("QMA" "\\mathsf{QMA}$0\n"
			"Complexity class QMA" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/QMA_Class_QMA"
			nil nil)
		       ("PSPACE" "\\mathsf{PSPACE}$0\n"
			"Complexity class PSPACE" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/PSPACE_Class_PSPACE"
			nil nil)
		       ("PRG" "${1:G}\\left(${2:s}\\right)$0\n"
			"Pseudorandom generator" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/PRG_Pseudorandom_Generator"
			nil nil)
		       ("PRF"
			"${1:F}_{${2:k}}\\left(${3:x}\\right)$0\n"
			"Pseudorandom function" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/PRF_Pseudorandom_Function"
			nil nil)
		       ("Open"
			"\\operatorname{Open}\\left(${1:c}, ${2:d}\\right) = ${3:m}$0\n"
			"Commitment opening" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Open_Commitment_Open"
			nil nil)
		       ("Ome" "\\Omega" "Omega uppercase (alt)" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Ome_Omega_uppercase_alt_"
			nil nil)
		       ("O" "\\overbrace{ ${VISUAL} }^{ $1 }"
			"Overbrace" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/O_Overbrace"
			nil nil)
		       ("OOOO" "\\Omega" "Omega (uppercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/OOOO_Omega_uppercase_"
			nil nil)
		       ("Norm" "\\lVert $1 \\rVert $2" "Norm" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/Norm_Norm"
			nil nil)
		       ("NN" "\\mathbb{N}" "Natural Numbers" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/NN_Natural_Numbers"
			nil nil)
		       ("NEXP" "\\mathsf{NEXP}$0\n"
			"Complexity class NEXP" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/NEXP_Class_NEXP"
			nil nil)
		       ("MAC"
			"${1:t} \\leftarrow \\operatorname{MAC}_{${2:k}}\\left(${3:m}\\right)$0\n"
			"Message authentication code" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/MAC_Message_Authentication_Code"
			nil nil)
		       ("LL" "\\mathcal{L}" "Lagrangian" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/LL_Lagrangian"
			nil nil)
		       ("LLLL" "\\Lambda" "Lambda (uppercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/LLLL_Lambda_uppercase_"
			nil nil)
		       ("KeyGen"
			"(${1:pk}, ${2:sk}) \\leftarrow \\operatorname{KeyGen}\\left(1^{${3:\\lambda}}\\right)$0\n"
			"Key generation" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/KeyGen_Key_Generation"
			nil nil)
		       ("K" "\\cancelto{ $1 }{ ${VISUAL} }"
			"Cancel To" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/K_Cancel_To"
			nil nil)
		       ("KDF"
			"\\operatorname{KDF}\\left(${1:K}, ${2:info}\\right)$0\n"
			"Key derivation function" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/KDF_Key_Derivation"
			nil nil)
		       ("Im" "\\mathrm{Im}" "Imaginary Part" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/Im_Imaginary_Part"
			nil nil)
		       ("INDCPA" "\\mathsf{IND\\mbox{-}CPA}$0\n"
			"IND-CPA" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/INDCPA_IND_CPA"
			nil nil)
		       ("INDCCA" "\\mathsf{IND\\mbox{-}CCA}$0\n"
			"IND-CCA" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/INDCCA_IND_CCA"
			nil nil)
		       ("HH" "\\mathcal{H}" "Hamiltonian" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/HH_Hamiltonian"
			nil nil)
		       ("GGGG" "\\Gamma" "Gamma (uppercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/GGGG_Gamma_uppercase_"
			nil nil)
		       ("Enc"
			"${1:c} \\leftarrow \\operatorname{Enc}_{${2:pk}}\\left(${3:m}; ${4:r}\\right)$0\n"
			"Encryption" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Enc_Encryption"
			nil nil)
		       ("EXP" "\\mathsf{EXP}$0\n"
			"Complexity class EXP" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/EXP_Class_EXP"
			nil nil)
		       ("EUFCMA" "\\mathsf{EUF\\mbox{-}CMA}$0\n"
			"EUF-CMA" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/EUFCMA_EUF_CMA"
			nil nil)
		       ("Dec"
			"${1:m} := \\operatorname{Dec}_{${2:sk}}\\left(${3:c}\\right)$0\n"
			"Decryption" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Dec_Decryption"
			nil nil)
		       ("DLOG" "${1:h}=g^{${2:x}}$0\n" "Discrete log"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/DLOG_Discrete_Log"
			nil nil)
		       ("DDH"
			"\\left(g^{${1:a}}, g^{${2:b}}, g^{${1:a}${2:b}}\\right) \\approx_c \\left(g^{${1:a}}, g^{${2:b}}, g^{${3:c}}\\right)$0\n"
			"Decisional Diffie-Hellman" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/DDH_Decisional_Diffie_Hellman"
			nil nil)
		       ("DDDD" "\\Delta" "Delta (uppercase)" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/DDDD_Delta_uppercase_"
			nil nil)
		       ("Com"
			"(${1:c}, ${2:d}) \\leftarrow \\operatorname{Com}\\left(${3:m}; ${4:r}\\right)$0\n"
			"Commitment" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Com_Commitment"
			nil nil)
		       ("C" "\\cancel{ ${VISUAL} }" "Cancel" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/C_Cancel"
			nil nil)
		       ("CC" "\\mathbb{C}" "Complex Numbers" nil nil
			nil
			"/Users/hc/.config/emacs/snippets/org-mode/CC_Complex_Numbers"
			nil nil)
		       ("Bmat"
			"\\begin{Bmatrix}\n$0\n\\end{Bmatrix}\n"
			"Bmatrix (curly)" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/Bmat_Bmatrix_curly_"
			nil nil)
		       ("B" "\\underset{ $1 }{ ${VISUAL} }" "Underset"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/B_Underset"
			nil nil)
		       ("BQP" "\\mathsf{BQP}$0\n"
			"Complexity class BQP" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/BQP_Class_BQP"
			nil nil)
		       ("BPP" "\\mathsf{BPP}$0\n"
			"Complexity class BPP" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/BPP_Class_BPP"
			nil nil)
		       ("->" "\\to\n" "To" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/-_To"
			nil nil)
		       ("-+" "\\mp\n" "Minus-Plus" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/-+_Minus-Plus"
			nil nil)
		       ("+-" "\\pm" "Plus-Minus" nil nil nil
			"/Users/hc/.config/emacs/snippets/org-mode/+-_Plus-Minus"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
