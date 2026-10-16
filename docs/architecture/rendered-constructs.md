# 渲染组件（Rendered Constructs）统一架构

编辑器里所有"画成别的样子的 Markdown 源码"——公式、图片、脚注、块引用、任务框、表格、
图表、org 环境块、`@@` 命令、HTML 块——都通过同一层：
`src/cm6/extensions/visual/constructs/`。本文是这层的规范，开发者与 agent 新增或修改
任何渲染组件前都先读它。规则由 `tests/architecture-constructs.test.ts` 强制执行。

## 为什么只有一层

每个渲染组件都要回答同样的三个问题：

1. **何时显示源码**：光标/选区在哪里时，组件让位给可编辑的源码？
2. **画在哪里**：Vim、方向键、选区需要知道哪些源码范围被画成了一个整体。
3. **模式**：Vim 的 Normal/Visual 与 Insert 下行为是否不同？

过去每个组件各自回答，结果是 7 种互相矛盾的显示规则、3 套 Vim 的私有扫描（屏幕外的
组件 Vim 看不见）、模式存在 DOM 上导致组件慢一拍更新。`j`/`k` 在公式附近卡住、表格与
正文手感不同，都源于此。现在三个问题各有唯一答案，组件只做选择。

源码始终是唯一文档；组件只是源码的视图（见 `CLAUDE.md` Invariants）。

## 词汇

| 概念 | 含义 | 所在 |
|---|---|---|
| **construct** | 被 widget 替换绘制的一段源码 | — |
| **object** 角色 | 读者看到的"东西"：公式、图片、引用、图表。Vim 把它当一个字符跨过；Normal/Visual 下保持渲染 | `reveal.ts` |
| **structure** 角色 | 读者编辑的文字与语法：表格、块标题/分隔、HR、TOC、`@@` 命令、行内标记。任何模式下光标进入都显示源码 | `reveal.ts` |
| **reveal policy** | 选区何时打开源码，见下表 | `reveal.ts` |
| **pinning** | Vim 在 Normal/Visual 时让 object 保持渲染。是编辑器状态，不是 DOM 属性 | `mode.ts` |
| **literal ranges** | 代码与公式内部不识别任何组件（`[^1]` 写在公式里就是文字） | `literal-ranges.ts` |
| **registry** | 唯一的"哪里画着什么"。所有在源码上绘制 widget 的组件都在此登记；从状态计算的来源屏幕外也正确，视口插件经 `drawnConstructSource` 直接读其绘制结果 | `registry.ts` |
| **embedded surface** | 组件内部用自己的编辑器编辑文字的元素（公式 MathLive、图表灯箱） | `src/cm6/embedded-surface.ts` |
| **screen row** | Vim 的行 = 读者看到的折行行，不是源码行 | `aaronnote/vim-rows.ts` |

### Reveal policy

| policy | 光标（空选区） | 范围选区 | 用于 |
|---|---|---|---|
| `edge` | 在内部或贴着两端 | 一端落在内部 | 脚注、块引用、块 ID、任务框 |
| `interior` | 严格在内部 | 一端落在内部 | 公式、行内标记 |
| `caret-edge` | 在内部或贴着两端 | 从不 | 图片、`@@` 命令、块结构、HTML 块、表格 |
| `caret-interior` | 严格在内部 | 从不 | 图表、front matter |
| `never` | 从不（由自己的开关打开） | 从不 | 代码折叠 |

一个范围选区**跨过**组件时永远保持渲染：全选或拖选不会把途经的所有 widget 打开成源码、
也不会随文档规模变慢。组件可以有比自身更大的 reveal region（任务框：整行）。

## 组件一览

| 组件 | 模块 | 角色 | policy | 进入方式 |
|---|---|---|---|---|
| 脚注、块引用、块 ID | `widgets/footnotes.ts`、`block-ref.ts`、`block-anchor.ts` | object | `edge` | `inlineConstruct` |
| 任务框 | `widgets/task-list.ts` | object | `edge`（整行） | `inlineConstruct` |
| `@@lean4`、`@@note-code` | `widgets/lean-placeholder.ts`、`note-code.ts` | structure | `edge` | `inlineConstruct` |
| 图片 / html 嵌入 | `widgets/image.ts` | object | `caret-edge` | 自有插件 + `constructSources` |
| 公式 | `widgets/math.ts` | object | `interior`，由公式编辑会话打开 | 自有字段 + `constructSources`（`revealed` 覆盖） |
| 代码折叠、图表 | `widgets/fenced-code.ts` | object | `never` / `caret-interior` | 自有字段 + `constructSources` |
| 表格 | `live-preview.ts` | structure（块） | `caret-edge`（文档开头的 0 偏移不算） | 自有字段 + `constructSources` |
| HTML 块、行内标记、emoji | `live-preview.ts` | structure | `caret-edge` / `interior` | `selectionOpensSource` / `rangeRevealsSource` |
| org 环境、TOC、HR、语义标题、front matter | `widgets/block-extras.ts` | structure（TikZ 为 object） | `caret-edge`（front matter `caret-interior`） | `selectionOpensSource` |
| `@@` 行内命令 | `widgets/inline-commands.ts` | structure | `caret-edge` | `selectionOpensSource` |
| wiki 链接标题 | `roam-link-status.ts` | structure | `edge`（任一选区） | `anySelectionRevealsSource` |

| 断行与间距 | `optimal-linebreak.ts` | structure | 由排版计算决定 | `drawnConstructSource` |

没有例外：凡是绘制在源码上的 widget 都是组件，都在登记表中。

**登记方式**：`inlineConstruct` 的家族自动登记；有自有状态的家族用
`constructSources.of({ kind, at })` 从状态回答；绘制本身已体现显示规则的家族（`block-extras`、
`inline-commands`、HTML 块、emoji/行内 HTML、wiki 标题、断行间距）用
`drawnConstructSource(kind, role, decorations)` 直接读取自己的装饰，于是登记表与屏幕按构造一致。

## 新增一个渲染组件

先判断两件事：它是 **object** 还是 **structure**？选区何时应该打开它（选上表的一个
policy；没有合适的就扩展 `reveal.ts` 并在本文登记，而不是在组件里手写比较）。

**行内组件**（一行内、从该行文本即可匹配）——用工厂，只写匹配与绘制：

```ts
export const myExtension = inlineConstruct({
  kind: "my-thing",
  reveal: "edge",
  role: "object",            // 默认 object；@@ 命令等语法用 "structure"
  maxPerViewport: 2_000,
  *match(line, state) {
    if (!line.text.includes("<<")) return;       // 廉价预检
    for (const m of line.text.matchAll(MY_RE)) {
      const from = line.from + m.index!;
      yield { from, to: from + m[0].length, widget: () => new MyWidget(m[1]!) };
    }
  },
});
```

工厂负责：跳过代码与公式、reveal 与 pinning、打字合并期间只映射、拖选结束才重建、
可视模式切换时的缓存、在 registry 中登记。把扩展加入
`extensions/visual/index.ts` 的 `createVisualMarkdownExtensions()`。

**块级或有自己状态的组件**（跨行、需要增量索引、有编辑会话）：

1. 用自己的 `StateField`/插件维护范围索引与装饰（保持现有的增量与视口预算）。
2. 每个"是否显示源码"的判断都调用 `selectionOpensSource(state, from, to, policy, role)`；
   重建判断用的 key 与绘制必须调用**同一个**判断函数（参考 `tableOpened`、
   `diagramOpened`）。
3. object 组件在 `update` 中对 `transactionChangesPinning(tr)` 做出反应（模式切换）。
4. 用 `constructSources.of({ kind, at(state, pos) })` 登记，`at` 从状态返回包含 `pos`
   的组件；若源码由会话而不是选区打开，提供 `revealed(view, construct)`。
5. 增加高度的 widget 继承 `MeasuredWidget`（见 `CLAUDE.md` Widget Rules）。

**不要**：比较 `sel.empty && sel.from ...`；读 `dataset.vimMode`；给装饰加私有标记让
Vim 识别；在 Vim 里扫描 Markdown 找组件。守卫测试会拒绝这些写法。

## 组件内部的 Markdown

widget 内部显示的 Markdown（表格单元格、todo 标签、旁注卡片、org 环境正文、嵌入查询）一律经由
`src/render-html.ts` 渲染：块级用 `renderMarkdownHTML`，行内用 `renderInlineMarkdownHTML`（去掉
外层段落，`<img>` 走共享的图片与资源解析）。同一段 Markdown 在哪个组件里都长得一样；
不要引入别的 Markdown 库或另写包装。

## 嵌入式编辑面

组件内部若用自己的编辑器编辑文字（公式 MathLive、图表灯箱、meta 摘要编辑器），在根元素上
调用 `markEmbeddedSurface(el)`。之后 Vim 不解释其中的
按键、编辑器不在指针事件上抢回焦点、滚动稳定器与 Emacs 按键转发都放行。需要区分
"嵌入面"与"文档"的代码一律使用 `EMBEDDED_SURFACE_SELECTOR` /
`isInEmbeddedSurface`，不要手写属性选择器。

**先问能否不要嵌入面。** 能编辑为文档文字的内容就编辑为文档文字：嵌入面意味着另一套
光标、按键、补全、撤销与输入法处理。表格正是这样改造的——见下节。

## 表格：渲染的结构，编辑的文字

表格是 structure：光标不在里面时画成表格，带有全部结构工具（工具栏增删行列、对齐、排序、
CSV、尺寸选择器、边缘添加、拖动排序行列、框选复制/剪切/删除、布局菜单）；光标进入时
（方向键、Vim `j`/`k`、点击单元格）显示 Markdown 源码，用主编辑器编辑。于是 Vim、公式、
补全与代码片段、输入法、撤销在单元格里与段落中完全一样。

单元格的编辑模型由源码命令保持（`commands/index.ts`，经 `input-commands.ts` 与
`editor-cm6.ts` 的按键绑定）：

| 按键 | 行为 |
|---|---|
| Tab / Shift-Tab | 下/上一个单元格并选中其文字（自动对齐列宽；最后一格之后追加一行） |
| Enter | 下一行同一列；在空的末行上离开表格 |
| ↑ / ↓ | 上/下一行同一列，跳过分隔行；越过首/末行即离开表格（表格在文末时新开一行） |
| ← / → | 在单元格文字边缘进入相邻单元格 |
| Backspace | 在单元格开头移到上一格末尾，从不删除 `|` |
| Shift-Enter | 单元格内换行 `<br>` |
| Mod-Enter | 在下方插入一行，光标进入其第一格 |

渲染状态下：点击单元格（按下并在格内松开）把光标放进该格源码；从一格拖到另一格是框选；
Shift-点击 选中单元格，方向键在选中的格子间移动，Enter 进入该格源码。工具栏插入行列后，
光标进入新单元格的源码。

## Vim 与屏幕行

- Vim 的行是屏幕折行行（`aaronnote/vim-rows.ts`）。判断一个字符画在哪一行时，用它
  自身的结束边缘 `coordsAtPos(next, -1)`：CodeMirror 把行首 widget 前的光标位置
  报告在上一行末尾。行首是公式或隐藏标记（`**`）时，这个位置归属它真正显示的行。
- Vim 通过 `renderedConstructAt(view, pos)` 知道哪里画着什么，只把 **object** 当作一个字符
  （在公式上按 `i`/`a` 进入其 TeX 源码）；**structure**（表格、块标题、`@@` 命令）在光标
  落上时打开，Vim 按文字移动。
- 模式通过 `publishMode` 一处发布：写 DOM 属性（供主题/宿主）并在状态中设置 pinning。

## 守卫与测试

| 测试 | 保证 |
|---|---|
| `tests/architecture-constructs.test.ts` | 静态规则（无允许列表）：渲染模块必须经由 constructs 层决定显示并向 registry 登记、组件内 Markdown 只经共享渲染器、不得手写选区比较、不得读 DOM 模式、Vim 不得扫描、嵌入面只在一处拼写、表格不得有自己的单元格编辑器；运行时双向一致：示例笔记（覆盖全部家族）中 registry 报告的每个组件都被绘制，绘制在源码上的每个 widget 都被 registry 报告 |
| `tests/rendered-constructs.test.ts` | policy 语义、registry、pinning、代码/公式内不识别、Vim 逐行穿过表格 |
| `tests/cm6/table-keyboard.test.ts`、`table-interaction.test.ts` | 表格以源码编辑时的单元格按键模型、撤销步骤 |
| `tests/vim-row-geometry.test.ts` | 折行处以组件开头时的屏幕行 |

守卫没有允许列表。失败时修代码；规则本身需要改变时，先改本文，再改守卫。

## 已知差距与路线

- **表格的源码形态**是对齐后的 Markdown（Tab 会对齐列宽），而不是网格；需要所见即所得的
  网格编辑时，下一步是在源码行上用行装饰与 CSS 绘制网格，键位模型不变。
- **行内 Markdown 标记**（`**`、`` ` ``、链接括号）使用统一 policy，但不进 registry：它们是
  structure，被打开时就是普通文本。
