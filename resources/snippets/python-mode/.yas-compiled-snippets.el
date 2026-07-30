;;; "Compiled" snippets and support files for `python-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'python-mode
		     '(("year"
			"ps.add_argument(\"--year\", choices=[\"16\", \"17\", \"18\"])\nps.add_argument(\"--pol\", choices=[\"Down\", \"Up\"])\nyear = args.year\npol = args.pol\n"
			"yearpol" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/year_yearpol"
			nil nil)
		       ("th2d"
			"ROOT.TH2D(\"${1:h}\", \"${2:h}\", ${3:binning})\n"
			"th2d" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/th2d_th2d"
			nil nil)
		       ("th1d"
			"ROOT.TH1D(\"${1:h}\", \"${2:h}\", ${3:binning})\n"
			"th1d" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/th1d_th1d"
			nil nil)
		       ("ryaml"
			"with open(${1:yamlfile}, 'r') as f:\n	${2:content} = yaml.safe_load(f)\n	${0}\n"
			"Read Yaml" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/ryaml_Read_Yaml"
			nil nil)
		       ("root"
			"import ROOT\nROOT.gROOT.SetBatch(True)\n"
			"Import ROOT" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/root_Import_ROOT"
			nil nil)
		       ("paras"
			"import os\nimport sys\nsys.path.append(os.environ[\"MAJORANA\"])\nfrom paras import *\n"
			"paras" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/paras_paras"
			nil nil)
		       ("numcpu" "ROOT.RooFit.NumCPU(${1})\n" "numcpu"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/numcpu_numcpu"
			nil nil)
		       ("mtd" "ROOT.DisableImplicitMT()\n"
			"Multithreading Disable" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/mtd_Multithreading_Disable"
			nil nil)
		       ("mt" "ROOT.EnableImplicitMT()\n"
			"Multithreading" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/mt_Multithreading"
			nil nil)
		       ("mpl"
			"import matplotlib as mpl\nmpl.use(\"Agg\")\n"
			"import matplotlib" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/mpl_import_matplotlib"
			nil nil)
		       ("main"
			"def main():\n	${0}\n\n\nif __name__ == \"__main__\":\n	main()\n"
			"main" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/main_main"
			nil nil)
		       ("jtimeit" "%%timeit\n$0\n"
			"Jupyter cell magic: timeit" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jtimeit_Jupyter_Cell_Timeit"
			nil nil)
		       ("jtime" "%%time\n$0\n"
			"Jupyter cell magic: time" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jtime_Jupyter_Cell_Time"
			nil nil)
		       ("jraw" "# %% [raw]\n$0\n" "Jupytext raw cell"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jraw_Jupyter_Raw"
			nil nil)
		       ("jmd" "# %% [markdown]\n$0\n"
			"Jupytext markdown cell" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jmd_Jupyter_Md"
			nil nil)
		       ("jcode" "# %%\n$0\n" "Jupytext code cell" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jcode_Jupyter_Code"
			nil nil)
		       ("jcell" "# %%\n$0\n" "Jupytext cell split" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jcell_Jupytext_Cell"
			nil nil)
		       ("jcap" "%%capture\n$0\n"
			"Jupyter cell magic: capture" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jcap_Jupyter_Cell_Capture"
			nil nil)
		       ("jbash" "%%bash\n$0\n"
			"Jupyter cell magic: bash" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/jbash_Jupyter_Cell_Bash"
			nil nil)
		       ("histo1d"
			"df.Histo1D((${1:binning}), \"${2:branch}\")\n"
			"df.Histo1D" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/histo1d_df.Histo1D"
			nil nil)
		       ("cwd" "cwd = get_cwd(__file__)\n" "cwd" nil
			nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/cwd_cwd"
			nil nil)
		       ("canvas"
			"c = ROOT.TCanvas(\"c\", \"c\", 800, 600)\n${2}\nc.SaveAs(\"${1:test.pdf}\")\n"
			"canvas" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/canvas_canvas"
			nil nil)
		       ("argg"
			"from argparse import ArgumentParser as AP\nfrom argparse import ArgumentDefaultsHelpFormatter as ADHF\nps = AP(formatter_class=ADHF)\nps.add_argument(\"--test\", action=\"store_true\")\nargs = ps.parse_args()\n"
			"argg" nil nil nil
			"/Users/hc/.config/emacs/snippets/python-mode/argg_argg"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
