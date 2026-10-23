#+begin meta
title: Noema × Reveal stress-test deck
date: 2026-07-12
kind: slides
tags: mathematics, quantum-computing, tcs, demo
#+end meta

# Noema × Reveal

同一个 Markdown 文件，两种视图：`Cmd+/` 在 Reveal 和普通 Noema 笔记之间切换。

\[
  \ket{\psi}=\alpha\ket0+\beta\ket1,
  \qquad |\alpha|^2+|\beta|^2=1.
\]

- ← / →：横向 slide
- ↑ / ↓：Reveal 纵向 stack
- 铅笔 → **Source view**：真正的 Markdown 源码

# Noema 数学能力

#+begin theorem Born rule
For a POVM \(\{E_i\}_i\), the probability of outcome \(i\) is
\[
  p(i)=\langle\psi|E_i|\psi\rangle,
  \qquad \sum_i E_i=I.
\]
#+end theorem

| model | witness | verifier |
|---|---:|---|
| NP | classical | deterministic polytime |
| QMA | quantum | BQP circuit |

#+begin note Shared interpreter
公式、org-env、表格和 Noema 后续升级都走普通笔记的 HTML renderer。
#+end note

## Proof sketch

#+begin proof Hybrid argument
Let \(H_0,\ldots,H_q\) be adjacent experiments. If
\[
  \left|\Pr[H_0=1]-\Pr[H_q=1]\right|\geq\varepsilon,
\]
then one adjacent pair differs by at least \(\varepsilon/q\).
#+end proof

1. Replace one oracle answer at a time.
2. Average over the hybrid index.
3. Reduce the distinguishing gap to the assumed primitive.

## Local notation <!-- omit in toc -->

这个二级标题带 `<!-- omit in toc -->`，因此仍属于 **Proof sketch** 这一页，不会生成新的纵向 slide。

Use \(\negl(\lambda)\) for a negligible function and \([n]=\{1,\ldots,n\}\).

## QC circuit view

```text
|0> ---H---@---------M---
           |
|0> -------X---H-----M---
```

For \(U_f\ket{x,y}=\ket{x,y\oplus f(x)}\), phase kickback gives
\[
 U_f\bigl(\ket{x}\ket{-}\bigr)=(-1)^{f(x)}\ket{x}\ket{-}.
\]

> A useful slide should still be readable when copied back into an ordinary note.

# Hand-written HTML

下面不是代码块，而是经过 Noema sanitizer 后的真实 HTML：

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px;text-align:left">
  <div style="padding:18px;border:1px solid #4a6075;border-radius:12px"><strong>Markdown</strong><br>编辑体验不变</div>
  <div style="padding:18px;border:1px solid #4a6075;border-radius:12px"><strong>Noema</strong><br>公式与 widgets</div>
  <div style="padding:18px;border:1px solid #4a6075;border-radius:12px"><strong>Reveal</strong><br>导航与演示引擎</div>
</div>

<p style="margin-top:30px;color:#ff819f">Inline style 应该生效；script 与危险事件属性会被清理。</p>

## Markdown vertical page

这个二级标题自动成为 **Hand-written HTML** 下方的页面。使用 ↑ / ↓ 切换；下一个一级标题继续向右。

# Long mathematical page scroll test

这一页故意超过 720p。Reveal 页面保持标准比例，内容区域可以纵向滚动。

## Graph tensor

Let \(G=(L\sqcup R,E)\) and define
\[
 U_G=\mathbb F^L,\quad V_G=\mathbb F^R,\quad W_G=\mathbb F^E,
 \qquad T_G=\sum_{(i,j)\in E}u_i\otimes v_j\otimes w_{ij}.
\]

# TCS definitions and commands

#+begin definition Promise problem
A promise problem is a pair \(\Pi=(\Pi_{\mathrm{yes}},\Pi_{\mathrm{no}})\) of disjoint languages.
#+end definition

@@todo(doing) [Tighten the soundness calculation] {ddl: 2026-07-20; effort: 45m}

- Completeness: yes instances admit an accepting witness.
- Soundness: no instances reject every alleged witness.
- Amplification: repeat coherently or by majority vote.

## Complexity inclusions

\[
  \mathsf{P}\subseteq\mathsf{BPP}\subseteq\mathsf{BQP}\subseteq\mathsf{PP}
  \subseteq\mathsf{PSPACE}.
\]

| class | resource | canonical problem |
|---|---|---|
| NP | classical witness | SAT |
| QMA | quantum witness | Local Hamiltonian |
| PSPACE | polynomial space | TQBF |

## Working note <!-- omit in toc -->

This heading stays on the inclusions slide. Inline comment syntax is also shared:
@@comment [Check whether the containment used here is relativizing.]

## Algorithmic sample

```python
def hybrid_gap(probabilities):
    return max(
        abs(right - left)
        for left, right in zip(probabilities, probabilities[1:])
    )
```

The code block, surrounding prose and formula \(\max_i|p_{i+1}-p_i|\) are all rendered by Noema.

# Mixed layout stress test

<div style="display:grid;grid-template-columns:1.1fr .9fr;gap:24px;text-align:left">
  <div>
    <h3>Left: assumptions</h3>
    <ul><li>finite-dimensional spaces</li><li>uniform circuit families</li><li>bounded error</li></ul>
  </div>
  <div style="border-left:2px solid #ff819f;padding-left:20px">
    <h3>Right: target</h3>
    <p>Find the smallest exponent <strong>ω</strong> compatible with the degeneration.</p>
  </div>
</div>

## Tensor degeneration

For \(T\unrhd S\), choose polynomial families \(A(\epsilon),B(\epsilon),C(\epsilon)\) such that
\[
 (A(\epsilon)\otimes B(\epsilon)\otimes C(\epsilon))T
   = \epsilon^d S + O(\!\epsilon^{d+1}).
\]

## Caveat <!-- omit in toc -->

This is deliberately dense local commentary rather than another vertical page. It tests wrapping, punctuation, inline mathematics \(x\mapsto Ax\), and ordinary **bold** / *italic* emphasis together.

## Questions

1. Which restrictions preserve border rank?
2. How does support rank behave under graph products?
3. Can degeneration witnesses be checked symbolically?
4. Which parameters are monotone under tensor restriction?
5. Where does asymptotic subrank become multiplicative?
6. How should a proof assistant encode the bases?

## More material to force overflow

For every edge \((i,j)\in E\), take \(u_i=e_i\), \(v_j=e_j\), and let \(w_{ij}\) be the standard basis of \(\mathbb F^E\). The support remembers the combinatorics while coefficients encode the chosen realization. This paragraph is deliberately long enough to test wheel and trackpad scrolling without changing slides.

\[
 \widetilde R(T)=\lim_{n\to\infty}R(T^{\otimes n})^{1/n},
 \qquad \widetilde Q(T)=\lim_{n\to\infty}Q(T^{\otimes n})^{1/n}.
\]

# Native Reveal: fragments

@@slides(reveal) []

<section data-auto-animate data-background-gradient="linear-gradient(135deg,#111827,#271331)">
  <h2 data-id="title">Reveal controls this page</h2>
  <p class="fragment">fragment one</p>
  <p class="fragment fade-up">fragment two, with <code>fade-up</code></p>
  <p class="fragment highlight-red">fragment three highlights</p>
</section>

# Native Reveal: vertical stack

@@slides(reveal) []

<section>
  <section data-background-color="#101722"><h2>Vertical 1 / 3</h2><p>Press ↓.</p></section>
  <section data-background-color="#172036" data-transition="convex"><h2>Vertical 2 / 3</h2><p class="fragment">Nested sections provide up/down navigation.</p></section>
  <section data-background-color="#22162d"><h2>Vertical 3 / 3</h2><p>Press → for the next horizontal page.</p></section>
</section>

# Native Reveal: layout and code

@@slides(reveal) []

<section data-background-color="#0d1117">
  <h2>Two-column hand-authored layout</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;text-align:left">
    <div><h3>Protocol</h3><ol><li class="fragment">Prepare</li><li class="fragment">Entangle</li><li class="fragment">Measure</li></ol></div>
    <pre><code data-trim data-line-numbers="1|2-3">function verify(x, witness) {
  const outcome = measure(run(x, witness));
  return outcome === 1;
}</code></pre>
  </div>
</section>

# Editing round trip

在任意横向 slide 或纵向 stack 中按 `Cmd+/`：

1. 退出 Reveal，回到完整、连续的 Noema 所见即所得笔记；
2. 光标自动落到当前横向 slide 对应的 `#` 标题；
3. 铅笔工具里的 **Source view** 仍能进入真正源码；
4. 再按 `Cmd+/` 回到 Reveal，并保留当前位置。

这个 demo 的目的不是漂亮，而是尽早暴露字号、溢出、HTML、数学和导航的弱点。
