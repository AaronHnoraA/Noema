/** Click-to-insert math structures. Ordinary keys belong to the physical keyboard. */
export type LiveTexPaletteItem = {
  label: string;
  latex: string;
  name: string;
  keywords?: string;
};

export type LiveTexPaletteCategory = {
  id: string;
  label: string;
  items: readonly LiveTexPaletteItem[];
};

const item = (label: string, latex: string, name: string, keywords = ""): LiveTexPaletteItem => (
  { label, latex, name, keywords }
);

export const liveTexPaletteCategories: readonly LiveTexPaletteCategory[] = [
  { id: "structure", label: "结构", items: [
    item("▤", "\\frac{\\placeholder{}}{\\placeholder{}}", "分式", "fraction frac"),
    item("⁄", "\\tfrac{\\placeholder{}}{\\placeholder{}}", "行内分式", "small fraction tfrac"),
    item("(ⁿₖ)", "\\binom{\\placeholder{}}{\\placeholder{}}", "二项式系数", "binomial choose combination"),
    item("⎛ⁿₖ⎞", "\\dbinom{\\placeholder{}}{\\placeholder{}}", "展示型二项式系数", "display binomial dbinom"),
    item("√", "\\sqrt{\\placeholder{}}", "平方根", "root sqrt"),
    item("ⁿ√", "\\sqrt[\\placeholder{}]{\\placeholder{}}", "n 次根", "nth root"),
    item("xⁿ", "^{\\placeholder{}}", "上标", "superscript power"),
    item("xₙ", "_{\\placeholder{}}", "下标", "subscript index"),
    item("ⁿxₙ", "^{\\placeholder{}}_{\\placeholder{}}", "上下标", "scripts"),
    item("(  )", "\\left(\\placeholder{}\\right)", "自适应圆括号", "parentheses delimiter"),
    item("[  ]", "\\left[\\placeholder{}\\right]", "自适应方括号", "bracket delimiter"),
    item("{  }", "\\left\\{\\placeholder{}\\right\\}", "自适应花括号", "brace delimiter"),
    item("|  |", "\\left|\\placeholder{}\\right|", "绝对值", "absolute value"),
    item("‖  ‖", "\\left\\|\\placeholder{}\\right\\|", "范数", "norm"),
    item("⌈ ⌉", "\\left\\lceil\\placeholder{}\\right\\rceil", "上取整", "ceiling"),
    item("⌊ ⌋", "\\left\\lfloor\\placeholder{}\\right\\rfloor", "下取整", "floor"),
    item("⟨ ⟩", "\\left\\langle\\placeholder{}\\right\\rangle", "尖括号", "angle bracket"),
    item("a⃗", "\\vec{\\placeholder{}}", "向量", "vector"),
    item("ā", "\\bar{\\placeholder{}}", "上划线", "bar overline"),
    item("â", "\\hat{\\placeholder{}}", "帽子", "hat accent"),
    item("ã", "\\tilde{\\placeholder{}}", "波浪线", "tilde accent"),
    item("ȧ", "\\dot{\\placeholder{}}", "一阶导数点", "dot accent"),
    item("ä", "\\ddot{\\placeholder{}}", "二阶导数点", "ddot accent"),
    item("⏞", "\\overbrace{\\placeholder{}}", "上大括号", "overbrace"),
    item("⏟", "\\underbrace{\\placeholder{}}", "下大括号", "underbrace"),
    item("ᵃx", "\\overset{\\placeholder{}}{\\placeholder{}}", "上方标注", "overset annotation"),
    item("ₐx", "\\underset{\\placeholder{}}{\\placeholder{}}", "下方标注", "underset annotation"),
    item("文本", "\\text{\\placeholder{}}", "公式文字", "text upright"),
  ] },
  { id: "calculus", label: "微积分", items: [
    item("∑", "\\sum", "求和", "sum"), item("∑ₐᵇ", "\\sum_{\\placeholder{}}^{\\placeholder{}}", "带上下限求和", "sum limits"),
    item("∏", "\\prod", "连乘", "product"), item("∐", "\\coprod", "余积", "coproduct"),
    item("∫", "\\int", "积分", "integral"), item("∫ₐᵇ", "\\int_{\\placeholder{}}^{\\placeholder{}}", "定积分", "definite integral"),
    item("∬", "\\iint", "二重积分", "double integral"), item("∭", "\\iiint", "三重积分", "triple integral"),
    item("∮", "\\oint", "环路积分", "contour integral"), item("lim", "\\lim_{\\placeholder{}}", "极限", "limit"),
    item("∯", "\\oiint", "闭曲面积分", "closed surface integral oiint"),
    item("∰", "\\oiiint", "闭体积分", "closed volume integral oiiint"),
    item("lim sup", "\\limsup_{\\placeholder{}}", "上极限", "limsup"),
    item("lim inf", "\\liminf_{\\placeholder{}}", "下极限", "liminf"),
    item("∂", "\\partial", "偏导数", "partial derivative"), item("∇", "\\nabla", "梯度", "nabla grad"),
    item("∞", "\\infty", "无穷大", "infinity"), item("′", "\\prime", "撇号", "prime"),
    item("…", "\\dots", "省略号", "dots"), item("⋯", "\\cdots", "居中省略号", "cdots"),
    item("⋮", "\\vdots", "竖向省略号", "vertical dots"),
    item("⋱", "\\ddots", "斜向省略号", "diagonal dots"),
  ] },
  { id: "greek", label: "希腊字母", items: [
    ...([
      ["α", "alpha"], ["β", "beta"], ["γ", "gamma"], ["δ", "delta"], ["ε", "epsilon"],
      ["ϵ", "varepsilon"], ["ζ", "zeta"], ["η", "eta"], ["θ", "theta"], ["ϑ", "vartheta"],
      ["ι", "iota"], ["κ", "kappa"], ["λ", "lambda"], ["μ", "mu"], ["ν", "nu"],
      ["ξ", "xi"], ["π", "pi"], ["ϖ", "varpi"], ["ρ", "rho"], ["ϱ", "varrho"],
      ["σ", "sigma"], ["ς", "varsigma"], ["τ", "tau"], ["υ", "upsilon"], ["φ", "phi"],
      ["ϕ", "varphi"], ["χ", "chi"], ["ψ", "psi"], ["ω", "omega"],
      ["Γ", "Gamma"], ["Δ", "Delta"], ["Θ", "Theta"], ["Λ", "Lambda"], ["Ξ", "Xi"],
      ["Π", "Pi"], ["Σ", "Sigma"], ["Υ", "Upsilon"], ["Φ", "Phi"], ["Ψ", "Psi"], ["Ω", "Omega"],
    ] as const).map(([glyph, command]) => item(glyph, `\\${command}`, command, "greek 希腊")),
  ] },
  { id: "relations", label: "关系与运算", items: [
    item("≠", "\\ne", "不等于", "neq"), item("≈", "\\approx", "约等于", "approx"),
    item("≃", "\\simeq", "同伦等价／相似", "simeq homotopy equivalence"),
    item("≅", "\\cong", "同构／全等", "congruent isomorphic isomorphism"),
    item("≡", "\\equiv", "恒等", "equivalent"), item("≤", "\\leq", "小于等于", "leq"),
    item("≥", "\\geq", "大于等于", "geq"), item("≪", "\\ll", "远小于", "much less"),
    item("≫", "\\gg", "远大于", "much greater"), item("∝", "\\propto", "正比", "proportional"),
    item("∼", "\\sim", "相似／等价关系", "similar equivalence relation"),
    item("≍", "\\asymp", "渐近同阶", "asymptotic comparable"),
    item("≐", "\\doteq", "定义相等／点等于", "doteq defined equal"),
    item("≲", "\\lesssim", "小于或近似", "lesssim"),
    item("≳", "\\gtrsim", "大于或近似", "gtrsim"),
    item("≺", "\\prec", "先于", "precedes order"),
    item("≼", "\\preceq", "先于或等于", "preceq order"),
    item("≻", "\\succ", "后于", "succeeds order"),
    item("≽", "\\succeq", "后于或等于", "succeq order"),
    item("∣", "\\mid", "整除／条件竖线", "divides such that conditional"),
    item("∤", "\\nmid", "不整除", "not divides"),
    item("⊢", "\\vdash", "可推导", "proves entails turnstile"),
    item("⊣", "\\dashv", "左断言符", "dashv turnstile"),
    item("⊨", "\\models", "语义蕴含", "models semantic entailment"),
    item("±", "\\pm", "正负", "plus minus"), item("∓", "\\mp", "负正", "minus plus"),
    item("×", "\\times", "乘号", "times"), item("÷", "\\div", "除号", "division"),
    item("·", "\\cdot", "点乘", "dot product"), item("∘", "\\circ", "复合", "composition"),
    item("⊗", "\\otimes", "张量积", "tensor"), item("⊕", "\\oplus", "直和", "direct sum"),
    item("∧", "\\land", "逻辑与", "and wedge"), item("∨", "\\lor", "逻辑或", "or vee"),
    item("¬", "\\neg", "逻辑非", "not negation"), item("∀", "\\forall", "任意", "forall"),
    item("∃", "\\exists", "存在", "exists"), item("∄", "\\nexists", "不存在", "not exists"),
    item("∴", "\\therefore", "因此", "therefore"), item("∵", "\\because", "因为", "because"),
  ] },
  { id: "algebra", label: "代数与群论", items: [
    item("⋊", "\\rtimes", "右半直积", "semidirect semi-direct semi group product group extension right 半直积"),
    item("⋉", "\\ltimes", "左半直积", "semidirect semi-direct semi group product group extension left 半直积"),
    item("≀", "\\wr", "花环积", "wreath product wr"),
    item("⋈", "\\bowtie", "领结积", "bowtie zappa szep product"),
    item("⊲", "\\triangleleft", "左正规子群关系", "normal subgroup triangleleft"),
    item("⊳", "\\triangleright", "右正规子群关系", "normal subgroup triangleright"),
    item("⊴", "\\trianglelefteq", "正规子群或等于", "normal subgroup trianglelefteq unlhd"),
    item("⊵", "\\trianglerighteq", "右正规子群或等于", "normal subgroup trianglerighteq unrhd"),
    item("⋬", "\\ntrianglelefteq", "不是正规子群", "not normal subgroup"),
    item("⨁", "\\bigoplus", "大直和", "big direct sum"),
    item("⨂", "\\bigotimes", "大张量积", "big tensor product"),
    item("⊞", "\\boxplus", "方框加", "box plus"),
    item("⊠", "\\boxtimes", "方框乘", "box times"),
    item("⊛", "\\circledast", "圈星积", "circled asterisk convolution"),
    item("⨀", "\\bigodot", "大圈点积", "big circled dot"),
    item("⊘", "\\oslash", "圈除", "circled slash quotient"),
    item("Hom", "\\operatorname{Hom}", "态射集 Hom", "homomorphism morphisms"),
    item("End", "\\operatorname{End}", "自同态 End", "endomorphism"),
    item("Aut", "\\operatorname{Aut}", "自同构 Aut", "automorphism"),
    item("Gal", "\\operatorname{Gal}", "伽罗瓦群 Gal", "galois group"),
    item("GL", "\\operatorname{GL}", "一般线性群 GL", "general linear group"),
    item("SL", "\\operatorname{SL}", "特殊线性群 SL", "special linear group"),
    item("Spec", "\\operatorname{Spec}", "素谱 Spec", "prime spectrum algebraic geometry"),
    item("Tor", "\\operatorname{Tor}", "Tor 函子", "derived tensor functor"),
    item("Ext", "\\operatorname{Ext}", "Ext 函子", "extension functor"),
  ] },
  { id: "sets", label: "集合与数域", items: [
    item("∈", "\\in", "属于", "element"), item("∉", "\\notin", "不属于", "not element"),
    item("∋", "\\ni", "包含元素", "owns"), item("⊂", "\\subset", "真子集", "subset"),
    item("⊆", "\\subseteq", "子集", "subseteq"), item("⊄", "\\nsubseteq", "非子集", "not subset"),
    item("⊃", "\\supset", "真超集", "superset"), item("⊇", "\\supseteq", "超集", "supseteq"),
    item("∪", "\\cup", "并集", "union"), item("∩", "\\cap", "交集", "intersection"),
    item("⋃", "\\bigcup", "大并集", "big union"), item("⋂", "\\bigcap", "大交集", "big intersection"),
    item("∖", "\\setminus", "差集", "set difference"), item("∅", "\\varnothing", "空集", "empty set"),
    item("⊊", "\\subsetneq", "严格子集", "proper subset subsetneq"),
    item("⊋", "\\supsetneq", "严格超集", "proper superset supersetneq"),
    item("⊔", "\\sqcup", "不交并", "disjoint union coproduct"),
    item("⨆", "\\bigsqcup", "大不交并", "big disjoint union coproduct"),
    item("∁", "\\complement", "补集", "complement"),
    item("𝒫", "\\mathcal{P}(\\placeholder{})", "幂集", "power set powerset"),
    item("ℕ", "\\mathbb{N}", "自然数", "natural numbers"), item("ℤ", "\\mathbb{Z}", "整数", "integers"),
    item("ℚ", "\\mathbb{Q}", "有理数", "rational numbers"), item("ℝ", "\\mathbb{R}", "实数", "real numbers"),
    item("ℂ", "\\mathbb{C}", "复数", "complex numbers"),
    item("𝔽", "\\mathbb{F}", "黑板粗体 F／有限域", "finite field galois field"),
    item("ℙ", "\\mathbb{P}", "黑板粗体 P", "probability measure projective space"),
  ] },
  { id: "arrows", label: "箭头与逻辑", items: [
    item("→", "\\rightarrow", "右箭头", "to right arrow"), item("←", "\\leftarrow", "左箭头", "left arrow"),
    item("↔", "\\leftrightarrow", "双向箭头", "both arrow"), item("⇒", "\\Rightarrow", "蕴含", "implies"),
    item("⇐", "\\Leftarrow", "反向蕴含", "implied by"), item("⇔", "\\Leftrightarrow", "当且仅当", "iff"),
    item("↦", "\\mapsto", "映射到", "maps to"), item("↪", "\\hookrightarrow", "单射箭头", "hook"),
    item("↠", "\\twoheadrightarrow", "满射箭头", "surjection"), item("↑", "\\uparrow", "上箭头", "up arrow"),
    item("↓", "\\downarrow", "下箭头", "down arrow"), item("↗", "\\nearrow", "东北箭头", "ne arrow"),
    item("↘", "\\searrow", "东南箭头", "se arrow"), item("↗标注", "\\xrightarrow{\\placeholder{}}", "带标注右箭头", "labeled arrow"),
    item("⟵", "\\longleftarrow", "长左箭头", "long left arrow"),
    item("⟶", "\\longrightarrow", "长右箭头", "long right arrow"),
    item("⟷", "\\longleftrightarrow", "长双向箭头", "long both arrow"),
    item("⟼", "\\longmapsto", "长映射箭头", "long maps to"),
    item("←标注", "\\xleftarrow{\\placeholder{}}", "带标注左箭头", "labeled left arrow"),
    item("⇒标注", "\\xRightarrow{\\placeholder{}}", "带标注蕴含箭头", "labeled implies arrow"),
    item("⇀", "\\rightharpoonup", "右半箭头", "right harpoon partial map"),
    item("↽", "\\leftharpoonup", "左半箭头", "left harpoon"),
    item("↩", "\\hookleftarrow", "左钩箭头", "hook left arrow"),
    item("↞", "\\twoheadleftarrow", "左满射箭头", "twohead left arrow"),
    item("⇄", "\\rightleftarrows", "反向双箭头", "right left arrows equilibrium"),
    item("⇆", "\\leftrightarrows", "同向双箭头", "left right arrows"),
  ] },
  { id: "functions", label: "函数", items: [
    item("sin", "\\sin", "正弦", "sine"), item("cos", "\\cos", "余弦", "cosine"),
    item("tan", "\\tan", "正切", "tangent"), item("cot", "\\cot", "余切", "cotangent"),
    item("arcsin", "\\arcsin", "反正弦", "inverse sine"), item("arccos", "\\arccos", "反余弦", "inverse cosine"),
    item("arctan", "\\arctan", "反正切", "inverse tangent"), item("sinh", "\\sinh", "双曲正弦", "hyperbolic sine"),
    item("cosh", "\\cosh", "双曲余弦", "hyperbolic cosine"), item("tanh", "\\tanh", "双曲正切", "hyperbolic tangent"),
    item("log", "\\log", "对数", "logarithm"), item("ln", "\\ln", "自然对数", "natural logarithm"),
    item("exp", "\\exp", "指数函数", "exponential"), item("det", "\\det", "行列式函数", "determinant"),
    item("arg", "\\arg", "辐角", "argument"), item("dim", "\\dim", "维数", "dimension"),
    item("ker", "\\ker", "核", "kernel"), item("max", "\\max", "最大值", "maximum"),
    item("min", "\\min", "最小值", "minimum"), item("gcd", "\\gcd", "最大公约数", "greatest common divisor"),
  ] },
  { id: "physics", label: "几何与物理", items: [
    item("ℏ", "\\hbar", "约化普朗克常数", "h bar"), item("ℓ", "\\ell", "小写手写 l", "ell"),
    item("ℑ", "\\Im", "虚部", "imaginary"), item("ℜ", "\\Re", "实部", "real part"),
    item("∠", "\\angle", "角", "angle"), item("⊥", "\\perp", "垂直", "perpendicular"),
    item("∥", "\\parallel", "平行", "parallel"), item("∦", "\\nparallel", "不平行", "not parallel"),
    item("△", "\\triangle", "三角形", "triangle"), item("□", "\\square", "正方形", "square"),
    item("°", "^{\\circ}", "角度", "degree"), item("†", "\\dagger", "厄米共轭标记", "dagger adjoint"),
    item("‡", "\\ddagger", "双剑号", "double dagger"), item("∇²", "\\nabla^2", "拉普拉斯算符", "laplacian"),
    item("⊙", "\\odot", "圈点", "circled dot"), item("⊖", "\\ominus", "圈减", "circled minus"),
  ] },
  { id: "arrays", label: "矩阵与分段", items: [
    item("2×2", "\\begin{matrix}\\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{}\\end{matrix}", "二阶矩阵", "matrix"),
    item("(2×2)", "\\begin{pmatrix}\\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{}\\end{pmatrix}", "圆括号矩阵", "pmatrix"),
    item("[2×2]", "\\begin{bmatrix}\\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{}\\end{bmatrix}", "方括号矩阵", "bmatrix"),
    item("|2×2|", "\\begin{vmatrix}\\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{}\\end{vmatrix}", "行列式", "determinant vmatrix"),
    item("‖2×2‖", "\\begin{Vmatrix}\\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{}\\end{Vmatrix}", "双线行列式", "Vmatrix"),
    item("3×3", "\\begin{pmatrix}\\placeholder{} & \\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{} & \\placeholder{}\\end{pmatrix}", "三阶矩阵", "3x3 matrix"),
    item("{ 分段", "\\begin{cases}\\placeholder{} & \\placeholder{} \\\\ \\placeholder{} & \\placeholder{}\\end{cases}", "分段函数", "cases piecewise"),
    item("⟨ 向量", "\\begin{pmatrix}\\placeholder{} \\\\ \\placeholder{}\\end{pmatrix}", "列向量", "column vector"),
  ] },
  { id: "style", label: "文字与标记", items: [
    item("𝐱", "\\mathbf{\\placeholder{}}", "数学粗体", "bold"),
    item("x", "\\mathrm{\\placeholder{}}", "正体", "upright roman"),
    item("𝒙", "\\mathit{\\placeholder{}}", "数学斜体", "italic"),
    item("𝔁", "\\mathfrak{\\placeholder{}}", "哥特体", "fraktur"),
    item("𝒳", "\\mathcal{\\placeholder{}}", "花体", "calligraphic"),
    item("𝕏", "\\mathbb{\\placeholder{}}", "黑板粗体", "blackboard"),
    item("𝖝", "\\mathsf{\\placeholder{}}", "无衬线", "sans serif"),
    item("↗", "\\overrightarrow{\\placeholder{}}", "长向量箭头", "vector arrow"),
    item("￣", "\\overline{\\placeholder{}}", "长上划线", "overline"),
    item("＿", "\\underline{\\placeholder{}}", "下划线", "underline"),
    item("∼", "\\widetilde{\\placeholder{}}", "宽波浪线", "wide tilde"),
    item("⌢", "\\widehat{\\placeholder{}}", "宽帽子", "wide hat"),
    item("☐", "\\boxed{\\placeholder{}}", "方框标注", "boxed"),
  ] },
];

/** Match every search term across glyphs, names, commands and aliases. */
export function liveTexPaletteMatches(entry: LiveTexPaletteItem, query: string): boolean {
  const normalize = (value: string): string => value.toLocaleLowerCase().replace(/[-_‐‑‒–—]+/g, " ");
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean);
  const content = normalize(`${entry.label} ${entry.name} ${entry.latex} ${entry.keywords ?? ""}`);
  return terms.every((term) => content.includes(term));
}

/** Search names, commands and aliases; empty searches keep the active category. */
export function searchLiveTexPalette(query: string, categoryId: string): readonly LiveTexPaletteItem[] {
  const categories = query.trim()
    ? liveTexPaletteCategories
    : liveTexPaletteCategories.filter((category) => category.id === categoryId);
  return categories.flatMap((category) => category.items)
    .filter((entry) => liveTexPaletteMatches(entry, query));
}

export function liveTexMatrixTemplate(
  rowCount: number,
  columnCount: number,
  environment: "matrix" | "pmatrix" | "bmatrix" | "Bmatrix" | "vmatrix" | "Vmatrix",
): string {
  const rows = Math.max(1, Math.min(10, Math.trunc(rowCount) || 1));
  const columns = Math.max(1, Math.min(10, Math.trunc(columnCount) || 1));
  const body = Array.from({ length: rows }, () => (
    Array.from({ length: columns }, () => "\\placeholder{}").join(" & ")
  )).join(" \\\\ ");
  return `\\begin{${environment}}${body}\\end{${environment}}`;
}

/** Turn a MathLive palette template into editable Markdown math source. */
export function liveTexPaletteSourceTemplate(template: string, selected = ""): { text: string; caret: number } {
  const marker = "\\placeholder{}";
  let text = "";
  let caret = -1;
  let usedSelection = false;
  let offset = 0;
  while (true) {
    const next = template.indexOf(marker, offset);
    if (next < 0) break;
    text += template.slice(offset, next);
    if (selected && !usedSelection) {
      text += selected;
      usedSelection = true;
    } else if (caret < 0) {
      caret = text.length;
    }
    offset = next + marker.length;
  }
  text += template.slice(offset);
  return { text, caret: caret < 0 ? text.length : caret };
}

/** WebKit may report Return as text input instead of a keyboard event. */
export function liveTexPaletteBeforeInputKey(
  inputType: string,
  data: string | null,
): "Enter" | "Tab" | null {
  if (inputType === "insertParagraph" || inputType === "insertLineBreak") return "Enter";
  if (inputType === "insertText" && (data === "\n" || data === "\r")) return "Enter";
  if (inputType === "insertText" && data === "\t") return "Tab";
  return null;
}

/** Follow a saved palette caret across a document edit without moving it to an unrelated selection. */
export function rebaseLiveTexPaletteRange(
  before: string,
  after: string,
  range: { from: number; to: number; formulaFrom: number | null },
): { from: number; to: number; formulaFrom: number | null } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
      && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const shift = after.length - before.length;
  const map = (position: number): number => {
    if (position < prefix) return position;
    if (position >= oldEnd) return position + shift;
    return newEnd;
  };
  return {
    from: map(range.from),
    to: map(range.to),
    formulaFrom: range.formulaFrom == null ? null : map(range.formulaFrom),
  };
}
