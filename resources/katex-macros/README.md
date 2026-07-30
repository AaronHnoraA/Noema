# KaTeX 全局宏环境

这个文件夹里的 `.tex` 文件定义了 **Noema 编辑器与导出/发布** 共用的 KaTeX 自定义宏,
**全局自动生效**于每篇笔记的每个公式(行内 `$...$` 与块级)。无需在笔记里再 `\newcommand`。

## 怎么用

直接在笔记里写,例如:

```
$\R^n,\quad \ket{\psi},\quad \NP \subseteq \AM,\quad \tens{A}\in \cV$
```

## 文件组织

| 文件 | 内容 |
|---|---|
| `common.tex` | 数域/集合 `\R \C \Z \N \Q \F \K \A \B \Pset`、定界符 `\abs \norm \set \floor \ceil \ip`、`\poly \polylog \sgn` |
| `quantum.tex` | Dirac 记号 `\bra \ket \braket \ketbra \proj \expval` |
| `linalg.tex` | `\vec \tens \spa` 及 `\tA.. \cA.. \vA..`、`\tr \Tr \rk \rank \im \linspan \End \M \T \Gr` |
| `groups.tex` | `\GL \SO \U \Sym \Aut \Iso \aut \Cent` |
| `complexity.tex` | `\class \probsty` + `\NP \coNP \GI \TI \AM \SZK ...` 与决策问题 `\MSE \AMTC ...` |
| `probability.tex` | `\E \Var` |

新增宏:在任意 `.tex` 里加 `\newcommand`,或新建一个 `.tex` 文件即可(目录下所有 `.tex` 都会被加载)。

## 书写格式(KaTeX 可解析子集)

- `\newcommand{\name}[argc]{body}` / `\renewcommand` / `\providecommand`(可带 `*`)。
- `\newcommand\name{body}`(不带花括号的名字)也支持。
- `\DeclareMathOperator{\name}{op}` → 自动转成 `\operatorname{op}`。
- `\def\name{body}`、`\def\name#1#2{body}`。
- 参数用 `#1..#9`;宏可以引用别的宏(会递归展开)。
- `%` 行注释会被忽略。

## 从 LaTeX preamble 移植时的规则

- `\NewDocumentCommand \X {m}{...}`(xparse)→ `\newcommand{\X}[1]{...}`。
- 删掉 `\xspace`、`\ensuremath{...}`(KaTeX 永远在数学模式)。
- `\DeclareMathOperator{\X}{op}` → `\newcommand{\X}{\operatorname{op}}`(或直接写 DeclareMathOperator,解析器会转)。
- **不要**移植非数学宏:`\todo`、`\textcolor` 注释宏、`theorem` 环境、`marginnote`、`tikzcd`、`adjustbox`、`align` 环境、`\genfrac` 复杂排版。

## KaTeX 不支持 / 谨慎的指令

- 不支持:`\xspace`、`\ensuremath`、LaTeX 可选参数默认值、`tikzcd`、`align`/`equation` 环境内联定义。
- 会覆盖 KaTeX 内置、易出问题、本环境**故意未定义**:`\P \S \L \O \H \to \dim \exp \binom \dots \d \i \j`(需要时请改名,如 `\PClass`)。

## 改了宏之后怎么生效

- 宏经服务端读取目录实时提供;**刷新浏览器 / 重开笔记**即可看到更新。
- 完整重载:先执行 `M-x my/noema-stop`,再重新打开笔记。
- 渲染缓存以“宏集合的哈希版本”为 key,换宏不会读到旧渲染。

底层接线见 `lisp/roam/aaronnote/src/katex-macros.ts` 与 `shared/katex-macros.mjs`。
