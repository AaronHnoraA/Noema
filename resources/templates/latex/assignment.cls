\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{assignment}[2020/09/08 Class for assignments]

%% 选项 Options
% 边数模式 Side mode
\providecommand{\Side}{oneside}% 单边 (不分奇偶数页, 默认) 或双边 (区分奇偶数页) 模式 Oneside (not distinguishing odd or even pages, default) or twoside (distinguishing odd and even pages) mode
\newif\ifTwoSide% [布尔变量] 是否为双边模式 [Bool] Whether twoside mode or not (default)
\DeclareOption{oneside}% 单边模式 Oneside mode
{
    \renewcommand{\Side}{oneside}
    \TwoSidefalse
}
\DeclareOption{twoside}% 双边模式 Twoside mode
{
    \renewcommand{\Side}{twoside}
    \TwoSidetrue
}

% 语言 Language
\newif\ifUsingEnglish% [布尔变量] 是否 (默认) 使用英语 [Bool] Whether using English or not (default)
\UsingEnglishtrue
\DeclareOption{zh}% 使用中文
{
    \UsingEnglishfalse
}
\DeclareOption{en}% Using English
{
    \UsingEnglishtrue
}
\ProcessOptions\relax

% 其余变量传递给 article 类 Other options passed to article class
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{article}}
\ProcessOptions\relax

%% 加载文档类 Load class
\LoadClass[a4paper, \Side, 10pt]{article}% 加载纸张大小为 A4, \Side 模式, 字号为 10 号的 article 类 Load article class with A4 paper, \Side style and 10pt font

%% 调用宏包 Call packages
\RequirePackage{iftex}
\ifXeTeX
    \RequirePackage{xeCJK}% 中文支持 Chinese support
    \IfFontExistsTF{Songti SC}{\setCJKmainfont{Songti SC}}{}
    \IfFontExistsTF{PingFang SC}
        {\setCJKsansfont{PingFang SC}}
        {\IfFontExistsTF{Hiragino Sans GB}{\setCJKsansfont{Hiragino Sans GB}}{}}
\else
    \RequirePackage[UTF8]{ctex}% 中文支持 Chinese support
\fi
\RequirePackage{etoolbox}% 字符串判空与兼容层 String predicates and compatibility shims
\RequirePackage{microtype}
\RequirePackage{enumitem}
\RequirePackage{titlesec}

\RequirePackage[top=.78in,bottom=.86in,left=.62in,right=.62in,headsep=16pt]{geometry}% 页边距 Page margin
\linespread{0.96}
\setlength{\parskip}{0.18em}
\setlength{\parindent}{1.2em}
\setlist{nosep,leftmargin=1.6em,topsep=.35em,partopsep=0pt,parsep=0pt,itemsep=.15em}

% 自定义页眉和页脚 Header and footer customization
\RequirePackage{fancyhdr}% 页眉和页脚 Header & footer
\RequirePackage{xparse}% 多可选参数的自定义命令 Newcommand with multiple optional arguements
\RequirePackage{lastpage}% 返回末页页码 Return page number of the last page
\RequirePackage{calc}% 返回文本宽度 Return width of text
% \RequirePackage[fit]{truncate}% 截断过长文本 Truncate overlong text

% 数学公式 Mathematical equations
\RequirePackage{amsmath, amssymb, amsthm, bm, mathtools}% 基础数学支持, 特殊数学符号, 自定义定理, 公式内加粗 Basic math support, special math symbols, theorem customization, bold in equations
\RequirePackage{mathrsfs}% 公式内花体字母 Non-CM calligraphic letters in equations
\RequirePackage{esint}% 特殊积分号 Special integral signs
\RequirePackage{siunitx}% 格式化物理量 (包括数值和单位) Formatted physical quantities (including values and units)
\RequirePackage[thicklines]{cancel}% 公式内删除线 Cancel lines in equations

% 图片 Figures
\RequirePackage{graphicx}% 插入图片 Insert graphics
\RequirePackage{float}% 强制设定图片位置 Set the positions of figures mandatorily
\RequirePackage{subfigure}% figure环境中子图 Subfigures in the figure environment
\RequirePackage{tikz}% 绘图 Create graphics
% \usetikzlibrary{quantikz}% 绘制量子电路图 (会影响 longtable 环境的正常工作) Plot quantum circuit diagrams (may affect normal performance of longtable environments)

% 表格 Tables
\RequirePackage{multirow}% 表内多行单元格合并 Tables with merged multi-row cells
\RequirePackage{booktabs}% 三线表 Three-line tables
\RequirePackage{longtable}% 表格跨页 Cross-page tables
\RequirePackage{lscape}% 横排表格 Landscape tables
\RequirePackage{diagbox}% 对角线分割单元格 Cells saperated by diagonal lines

% 化学式 Chemstry formulas
\RequirePackage[version=4]{mhchem}% 基础化学式 Basic chemistry equations
\RequirePackage{chemfig}% 化学结构式 Chemistry structural formulas

\RequirePackage{listings}% 程序代码 Program code

% 其他 Others
\RequirePackage[normalem]{ulem}% 各式下划线和删除标记 Various underlines & deletion notes
\RequirePackage{xcolor}% 文本颜色 Text color
\RequirePackage{hyperref}% 超链接 Hyperlink
\RequirePackage{framed}% 文本加框 Framed text
\RequirePackage{footmisc}% 脚注引用 Footnote reference
\RequirePackage[font=small,labelfont={bf},labelsep=space]{caption}% 图表标题更专业 [web:35]
\hypersetup{colorlinks=true,linkcolor=black,citecolor=black,urlcolor=black,linktoc=all}

% 标题样式（保持原有结构，可以后加颜色）[web:41]
\titleformat{\section}
    {\normalfont\large\bfseries}
    {\thesection}{0.55em}{}
\titlespacing*{\section}{0pt}{1.2ex plus .4ex minus .2ex}{0.45ex}
\titleformat{\subsection}
    {\normalfont\normalsize\bfseries}
    {\thesubsection}{0.5em}{}
\titlespacing*{\subsection}{0pt}{0.95ex plus .3ex minus .2ex}{0.25ex}
\titleformat{\subsubsection}[runin]
    {\normalfont\normalsize\itshape}
    {\thesubsubsection}{0.45em}{}[.]
\titlespacing*{\subsubsection}{0pt}{0.75ex plus .2ex minus .1ex}{0.45em}

% 页眉和页脚 Header & footer
\providecommand{\Name}{Name}% "Name" at the right of the header
\providecommand{\StudentID}{Student ID}% "Student ID" at the right of the header
\providecommand{\ContentsName}{Contents}
\makeatletter
\providecommand{\AssignmentPlaceholder}{\_\_\_\_}
\providecommand{\AssignmentMaybeLink}[2]{\ifstrempty{#1}{#2}{\href{#1}{#2}}}
\providecommand{\@assignmentinstitution}{}
\providecommand{\@assignmentcoursecode}{}
\providecommand{\@assignmentterm}{}
\providecommand{\@assignmentprojecttitle}{}
\providecommand{\@assignmentdisplaydate}{}
\providecommand{\@assignmentstudentname}{}
\providecommand{\@assignmentauthorurl}{}
\providecommand{\@assignmentstudentid}{}
\providecommand{\@assignmentaffiliation}{UNSW}
\newcommand{\assignmentinstitution}[1]{\gdef\@assignmentinstitution{#1}}
\newcommand{\assignmentcoursecode}[1]{\gdef\@assignmentcoursecode{#1}}
\newcommand{\assignmentterm}[1]{\gdef\@assignmentterm{#1}}
\newcommand{\assignmenttitle}[1]{\gdef\@assignmentprojecttitle{#1}}
\newcommand{\assignmentdate}[1]{\gdef\@assignmentdisplaydate{#1}}
\newcommand{\studentname}[1]{\gdef\@assignmentstudentname{#1}}
\newcommand{\authorurl}[1]{\gdef\@assignmentauthorurl{#1}}
\newcommand{\studentid}[1]{\gdef\@assignmentstudentid{#1}}
\newcommand{\assignmentaffiliation}[1]{\gdef\@assignmentaffiliation{#1}}
\newcommand{\coursename}[1]{\assignmentinstitution{#1}}
\newcommand{\coursecode}[1]{\assignmentcoursecode{#1}}
\newcommand{\semester}[1]{\assignmentterm{#1}}
\newcommand{\assignmentsubtitle}[1]{\assignmentdate{#1}}

% ================= 顶部三块区域 =================

% 左侧：课程名 / 课程代码 / 学期（课程代码右对齐一点点）
\newcommand{\AssignmentFirstPageLeft}[3]
{
    {\small
    \begin{tabular}[t]{@{}l@{}}
        #1\\
        \multicolumn{1}{@{}r@{}}{\textsf{#2}}\\ % 课程代码稍微靠右
        #3
    \end{tabular}}
}

% 中间：标题必须留在中栏；短标题保持 28pt，意外的长标题按宽度缩小兜底。
\newsavebox{\AssignmentTitleBox}
\newcommand{\AssignmentFitTitle}[1]{%
    \sbox{\AssignmentTitleBox}{{\fontsize{28}{30}\selectfont\bfseries #1}}%
    \ifdim\wd\AssignmentTitleBox>.46\textwidth
        \resizebox{.46\textwidth}{!}{\usebox{\AssignmentTitleBox}}%
    \else
        \usebox{\AssignmentTitleBox}%
    \fi
}
\newcommand{\AssignmentFirstPageCenter}[2]
{
    \begin{tabular}[t]{@{}c@{}}
        \AssignmentFitTitle{#1}\\[1pt]
        {\small #2}
    \end{tabular}
}

% 右侧：Name / StudentID / Affiliation 整块右对齐
% 两列布局：左列标签右对齐，右列内容右对齐
\newcommand{\AssignmentFirstPageRight}[4]
{
    {\small
    \begin{tabular}[t]{@{}r@{\;}l@{}}
        \multicolumn{2}{r}{\textsf{#4}}\\[4pt] % 顶部 UNSW 整行右对齐
        \Name{}: &
            \makebox[3.0cm][r]{\AssignmentMaybeLink{#2}{#1}}\\
        \StudentID{}: &
            \makebox[3.0cm][r]{#3}
    \end{tabular}}
}

\newcommand{\AssignmentPageRef}
{
    \ifcsname r@LastPage\endcsname
        \thepage\ / \pageref{LastPage}
    \else
        \thepage
    \fi
}
\pagestyle{fancy}% 全局页眉和页脚风格 Global header and footer style
\fancyhf{}% 清除预设的页眉和页脚 Clear default header and footer

% #1 课程名称 Course name
% #2 课程代码 Course code
% #3 年份与学期 Year and season
% #4 项目标题 Project title
% #5 日期 Date
% #6 姓名 Student name
% #7 姓名上的超链接 Hyperlink on student name
% #8 学号 Student ID
% #9 学校/机构 Affiliation
\NewDocumentCommand{\ProjectInfos}{ m m m m m m O{} m m }
{
    \fancyhead[C]{#4}% 页眉中 The center of the header
    \ifTwoSide
        \fancyhead[LE]{#1}% 偶数页眉左 The left of even page header
        \fancyhead[RE]{\AssignmentMaybeLink{#7}{#6}}% 偶数页眉右 The right of even page header
        \fancyhead[LO]{#8}% 奇数页眉左 The left of odd page header
        \fancyhead[RO]{#2}% 奇数页眉右 The right of odd page header
    \else
        \fancyhead[L]{\AssignmentMaybeLink{#7}{#6}}% 页眉左 The left of the header
        \fancyhead[R]{#8}% 页眉右 The right of the header
    \fi
    \setlength{\headheight}{14pt}% 页眉高 Height of the header
    \fancypagestyle{FirstPage}% 首页页眉和页脚风格 First-page header and footer Style
    {
        \fancyhf{}% 清除预设的页眉和页脚 Clear default header and footer
        \setlength{\headheight}{52pt}% 页眉高 Height of the header
        \fancyhead[L]{\AssignmentFirstPageLeft{#1}{#2}{#3}}% 页眉左 The left of the header
        \fancyhead[C]{\AssignmentFirstPageCenter{#4}{#5}}% 页眉中 The center of the header
        \fancyhead[R]{\AssignmentFirstPageRight{#6}{#7}{#8}{#9}}% 页眉右 The right of the header
        \fancyfoot[R]{\AssignmentPageRef}% 页脚右: <当前页码> / <总页数> The right of the footer: <current page number> / <total page number>
    }
    \thispagestyle{FirstPage}% 设置首页页眉风格为 FirstPage Set header style of the first page as FirstPage
}

\AtBeginDocument
{
    \ifdefempty{\@assignmentinstitution}{\gdef\@assignmentinstitution{\AssignmentPlaceholder}}{}
    \ifdefempty{\@assignmentcoursecode}{\gdef\@assignmentcoursecode{\AssignmentPlaceholder}}{}
    \ifdefempty{\@assignmentterm}{\gdef\@assignmentterm{\AssignmentPlaceholder}}{}
    \ifdefempty{\@assignmentprojecttitle}
        {\ifdefempty{\@title}
            {\gdef\@assignmentprojecttitle{\AssignmentPlaceholder}}
            {\global\let\@assignmentprojecttitle\@title}}
        {}
    \ifdefempty{\@assignmentdisplaydate}
        {\ifdefempty{\@date}
            {\gdef\@assignmentdisplaydate{\AssignmentPlaceholder}}
            {\global\let\@assignmentdisplaydate\@date}}
        {}
    \ifdefempty{\@assignmentstudentname}
        {\ifdefempty{\author}
            {\gdef\@assignmentstudentname{\AssignmentPlaceholder}}
            {\global\let\@assignmentstudentname\@author}}
        {}
    \ifdefempty{\@assignmentstudentid}{\gdef\@assignmentstudentid{\AssignmentPlaceholder}}{}
    \ifdefempty{\@assignmentaffiliation}{\gdef\@assignmentaffiliation{UNSW}}{}

    \renewcommand{\contentsname}{\ContentsName}
    \renewcommand{\figurename}{Figure}
    \renewcommand{\tablename}{Table}
    \renewcommand{\refname}{References}
    \renewcommand{\proofname}{Proof}
    \setcounter{tocdepth}{2}
    \setcounter{secnumdepth}{3}
    \setlength{\abovedisplayskip}{7pt plus 2pt minus 4pt}
    \setlength{\belowdisplayskip}{7pt plus 2pt minus 4pt}
    \setlength{\abovedisplayshortskip}{5pt plus 2pt}
    \setlength{\belowdisplayshortskip}{5pt plus 2pt minus 2pt}
}
\renewcommand{\maketitle}
{
    \ProjectInfos
        {\@assignmentinstitution}
        {\@assignmentcoursecode}
        {\@assignmentterm}
        {\@assignmentprojecttitle}
        {\@assignmentdisplaydate}
        {\@assignmentstudentname}
        [\@assignmentauthorurl]
        {\@assignmentstudentid}
        {\@assignmentaffiliation}
    \vspace*{.35\baselineskip}
    {\small\tableofcontents}
    \vspace*{.7\baselineskip}
    \hrule
    \vspace*{.8\baselineskip}
}
\makeatother
\ifTwoSide
    \fancyfoot[RO]{\AssignmentPageRef}% 奇数页脚右: <当前页码> / <总页数> The right of odd page footer: <current page number> / <total page number>
    \fancyfoot[LE]{\AssignmentPageRef}% 偶数页脚左: <当前页码> / <总页数> The left of even page footer: <current page number> / <total page number>
\else
    \fancyfoot[R]{\AssignmentPageRef}% 页脚右: <当前页码> / <总页数> The right of the footer: <current page number> / <total page number>
\fi

\allowdisplaybreaks[4]% 公式跨页 Cross-page equations
\providecommand{\abs}[1]{\left\lvert#1\right\rvert}% 绝对值 Absolute value
\providecommand{\norm}[1]{\left\lVert#1\right\rVert}% 范数 Norm
\DeclareMathOperator{\arcsinh}{arcsinh}% 反双曲正弦 Inverse hyperbolic sine
\DeclareMathOperator{\arccosh}{arccosh}% 反双曲余弦 Inverse hyperbolic cosine
\DeclareMathOperator{\arctanh}{arctanh}% 反双曲正切 Inverse hyperbolic tangent
\DeclareMathOperator{\re}{Re}% 复数的实部 Real part of complex number
\DeclareMathOperator{\im}{Im}% 复数的虚部或映射的像 Imaginary part of complex number or image of mapping
\DeclareMathOperator{\sgn}{sgn}% 符号函数 Sign function
\DeclareMathOperator{\sinc}{sinc}% 辛格函数 Sinc function
\DeclareMathOperator{\rect}{rect}% 矩形函数 Rectangular function
\DeclareMathOperator{\tr}{Tr}% 矩阵的迹 Trace of matrix
\DeclareMathOperator{\res}{Res}% 留数 Residue

% 题目和题解风格 Problem and solution style
\newtheoremstyle{Problem}% Theorem style name
{}% Space above theorem, being left empty means default
{}% Space below theorem, being left empty means default
{}% Theorem body font
{}% Theorem indent amount
{\bfseries}% Theorem head font
{.}% Punctuation after theorem head
{ }% Space after theorem head, whitespace means normal interword space
{\thmname{#1}\thmnumber{ #2}\thmnote{ (#3)}}% Theorem head spec
\theoremstyle{Problem}% Set theorem style
\newtheorem{prob}{Problem}% Problem
\providecommand{\Solution}{Solution}% "Solution" in solution environment (sol)
\providecommand{\Answer}{Answer}% "Answer" in answer environment (ans)
\providecommand{\Proof}{Proof}% "Proof" in proof environment (pf)
\newtheoremstyle{Solution}% 定理风格名称 Theorem style name
{}% 定理上方空间尺寸, 留空为默认 Space above theorem, being left empty means default
{}% 定理下方空间尺寸, 留空为默认 Space below theorem, being left empty means default
{}% 定理主体文本字体 Theorem body font
{}% 定理缩进量 Theorem indent amount
{\bfseries}% 定理开头字体 Theorem head font
{:}% 定理开头后所接标点 Punctuation after theorem head
{ }% 定理开头后所接空间尺寸, 空格为默认词间距 Space after theorem head, whitespace means normal interword space
{\thmname{#1}}% 定理开头格式 Theorem head spec, being left empty means default
\makeatletter
\def\@endtheorem{\qed\endtrivlist\@endpefalse}% 题解末尾添加 QED 符号 (黑色空心小正方形)% Add QED symbols (black hollow small square) to the end of solutions
\makeatother
\theoremstyle{Solution}% 设定定理风格 Set theorem style
\newtheorem*{sol}{\Solution}% 题解 Solution
\newtheorem*{ans}{\Answer}% 回答 Answer
\newtheorem*{pf}{\Proof}% 证明 Proof

\providecommand{\muline}[1]{\text{\uline{$#1$}}}% 公式内下划线 Underlines in equations
\providecommand{\muuline}[1]{\text{\uuline{$#1$}}}% 公式内双下划线 Double underlines in equations
\providecommand{\muwave}[1]{\text{\wave{$#1$}}}% 公式内波浪下划线 Wavy underlines in equations
\providecommand{\msout}[1]{\text{\sout{$#1$}}}% 公式内删除线 Strickout in equations
\providecommand{\mxout}[1]{\text{\xout{$#1$}}}% 公式内删除标记 (多条斜线) Deletion notes (multiple slashes) in equations
\providecommand{\mdashuline}[1]{\text{\dashuline{$#1$}}}% 公式内虚下划线 Dashed underlines in equations
\providecommand{\mdotuline}[1]{\text{\dotuline{$#1$}}}% 公式内点状虚下划线 Dotted underlines in equations

\graphicspath{{Figures/}}% 图片路径 Figure path

% ========== 代码样式增强：assignmentcode（更深背景+明显高亮） ==========
\definecolor{assignmentCodeBg}{rgb}{0.95,0.95,0.98}
\definecolor{assignmentCodeFrame}{rgb}{0.75,0.75,0.85}
\definecolor{assignmentCodeKeyword}{rgb}{0.0,0.2,0.55}
\definecolor{assignmentCodeComment}{rgb}{0.35,0.45,0.45}
\definecolor{assignmentCodeString}{rgb}{0.6,0.15,0.15}

\lstset
{
    upquote=true,
    showtabs=false,
    showspaces=false,
    showstringspaces=false,
    numbers=left,
    breaklines=true,
    breakatwhitespace=true,
    frame=single
}

\lstdefinestyle{assignmentcode}{% [web:37][web:38]
    basicstyle=\ttfamily\small,
    keywordstyle=\color{assignmentCodeKeyword}\bfseries,
    commentstyle=\color{assignmentCodeComment}\itshape,
    stringstyle=\color{assignmentCodeString},
    numberstyle=\tiny\color{gray},
    backgroundcolor=\color{assignmentCodeBg},
    rulecolor=\color{assignmentCodeFrame},
    xleftmargin=1.2em,
    xrightmargin=0.3em,
    frame=single,
    framerule=0.7pt,
    tabsize=4
}

% 你可以在文档里这样用：
% \lstset{style=assignmentcode}
% 或 \begin{lstlisting}[style=assignmentcode,language=Python] ...

% 超链接自动换行 Hyperlink automatic line wrapping
\makeatletter
\def\UrlAlphabet{%
      \do\a\do\b\do\c\do\d\do\e\do\f\do\g\do\h\do\i\do\j%
      \do\k\do\l\do\m\do\n\do\o\do\p\do\q\do\r\do\s\do\t%
      \do\u\do\v\do\w\do\x\do\y\do\z\do\A\do\B\do\C\do\D%
      \do\E\do\F\do\G\do\H\do\I\do\J\do\K\do\L\do\M\do\N%
      \do\O\do\P\do\Q\do\R\do\S\do\T\do\U\do\V\do\W\do\X%
      \do\Y\do\Z}
\def\UrlDigits{\do\1\do\2\do\3\do\4\do\5\do\6\do\7\do\8\do\9\do\0}
\g@addto@macro{\UrlBreaks}{\UrlOrds}
\g@addto@macro{\UrlBreaks}{\UrlAlphabet}
\g@addto@macro{\UrlBreaks}{\UrlDigits}
\makeatother
