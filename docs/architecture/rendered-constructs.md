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
| **object** 角色 | 读者看到的"东西"：公式、图片、引用、图表、emoji。Vim 把它当一个字符跨过；Normal/Visual 下保持渲染；删除时整体删除 | `reveal.ts` |
| **structure** 角色 | 读者编辑的文字与语法：表格、块标题/分隔、HR、TOC、`@@` 命令、行内标记。任何模式下光标进入都显示源码 | `reveal.ts` |
| **reveal policy** | 选区何时打开源码，见下表 | `reveal.ts` |
| **pinning** | Vim 在 Normal/Visual 时让 object 保持渲染。是编辑器状态，不是 DOM 属性 | `mode.ts` |
| **literal ranges** | 代码与公式（含跨行的行内公式）内部不识别任何组件（`[^1]`、`[[链接]]`、`@@命令` 写在公式里就是文字）。所有家族用同一个答案：`literalRangesIn` / `mathRangesIn` / `literalRangesOnLine`；只有公式自身（`math.ts`）与只放块级组件的 `block-extras` 直接用底层扫描 | `literal-ranges.ts` |
| **registry** | 唯一的"哪里画着什么"。所有在源码上绘制 widget 的组件都在此登记；从状态计算的来源屏幕外也正确，视口插件经 `drawnConstructSource` 直接读其绘制结果 | `registry.ts` |
| **embedded surface** | 组件内部用自己的编辑器编辑文字的元素（公式 MathLive、图表灯箱） | `src/cm6/embedded-surface.ts` |
| **visual row** | 读者看到的折行行；仍被绘制的块整体算一行。Vim 的 `j`/`k` 与编辑器的 ↑/↓ 共用 | `src/cm6/screen-rows.ts` |

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

## 左右与词移动：光标从不被隐藏

插入模式的 ←/→ 与 Vim 的 `h`/`l`/`w`/`b`/`e` 规则不同，但都由本层决定：插入模式下光标碰到组件
时按其 reveal policy 打开（脚注、引用贴边即打开；公式到达边界后进入编辑）；Vim 的 Normal/Visual
模式下 object 保持渲染，作为一个字符跨过。两者共享一条不变量：**光标从不停在仍被绘制的组件内部**
——要么组件为它打开，要么光标落在组件边缘。守卫按屏幕上实际绘制的 widget 判断（而不是按
registry 的看法），用覆盖全部家族的示例笔记扫过 ←/→/↑/↓ 与 `l h w b e j k`。

## 删除：object 整体删除

object 是一个东西，不会被删掉半个。插入模式下，在 object 之后按 Backspace（之前按 Delete）先选中
整个 object，再按一次才删除——图片、公式（行内与块）、图表、emoji、脚注、块引用、块锚点、任务框
一律如此；Vim 的 `x`/`X` 本来就把 object 当一个字符整体删除。从前只有图片这样做，其他 object
被逐字删掉源码，往往还在绘制状态下就坏成了文字（`\(x^2`、`smile:`）。判断来自 registry 的
`objectAtEdge(view, pos, side)`：无论 object 正在绘制还是因光标贴边而打开，都算。structure
（表格、`@@` 命令、块标题、行内标记）是文字，照常逐字删除。emoji 由行内标记家族绘制，但它是一个
字形，因此登记为 object（`drawnConstructSource` 的 role 可以按 widget 决定）。

## 从组件写文档：一个入口

组件自己的控件写回文档——勾选任务框、改代码块语言、接受/保留 AI 建议、布局菜单、表格工具与
就地编辑写回、离开文末表格时补的空行——一律经 `dispatchConstructEdit(view, spec, kind?)`
（`constructs/edit.ts`）：每个动作是独立的一步撤销，标记为 `construct[.kind]`。从前这些写入有的
不加标记（两次快速勾选被 CodeMirror 历史合成一步，撤销一次看不出变化；紧接着打字的勾选和打字
合成一步），有的标成 `input`（被当成连续打字，重绘被推迟）。公式编辑会话（`math.ts`）自行管理
历史分组，是唯一的具名例外。

## 何时重建：一个生命周期

由 ViewPlugin 绘制的家族（行内组件工厂、图片、`@@` 命令、wiki 标题、代码块）都用
`constructs/view-plugin.ts` 的 `constructViewPlugin`：输入法组字时的选区移动不重建；打字合并时
只映射（家族可映射自己的状态，或拒绝）；鼠标拖选在松开时结算一次；文档、视口、刷新变化时重建；
选区变化只在"打开了哪些组件"（`revealKey`）改变或 Vim 固定状态切换时重建；插件重建之间经持久
缓存保留。家族只提供 `build`，以及可选的 `revealKey`、`extra`（自有状态）、`mapDuringTyping`、
`invalidates`、`beforeUpdate`、`setup`、`provide`。

三个模块保留自己的生命周期，各有理由：`live-preview`（视口增量扫描与逐行 CJK 缓存）、`math`
（公式编辑会话）、以及只做测量的 `block-extras` 轨道与 `optimal-linebreak`。

## 增量重绘：一个修补器

块级家族在整篇文档上保存装饰，每个事务只重绘变化的部分，全部经由
`constructs/decoration-patch.ts`：

- `openedKey` / `spansFromKey`：选区打开了哪些组件；键不变即无事可做。
- `rebuildForRevealChange(current, oldKey, newKey, build)`：只重绘打开或关闭的组件。
- `rebuildDecorations(current, ranges, build)`：编辑、视口刷新涉及的范围。
- `replaceDecorations(current, ranges, add)`：用别处建好的装饰替换范围。

家族只提供"如何构建一个范围"。

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
光标、按键、补全、撤销与输入法处理。表格的键盘入口正是如此；点击入口为保留就地编辑的手感，使用嵌入式编辑面——见下节。

## 表格：点击就地编辑，键盘进入源码

表格始终画成表格，带有全部结构工具：工具栏增删行列、对齐、排序、CSV、尺寸选择器、边缘添加、
拖动排序行列、框选复制/剪切/删除、布局菜单。编辑有两条入口，体验各自完整：

- **点击单元格**：就地编辑，表格保持渲染。单元格变成输入框（实时预览 Markdown 与公式），点击格内
  公式用 MathLive 编辑；补全与代码片段、输入法、Tab/Enter/方向键在格间移动、越过边缘回到正文、
  Mod-Enter 加行、Shift-Enter `<br>`、Esc 放弃。离开单元格时一次写回 Markdown（一个撤销步）。
  就地编辑器是嵌入式编辑面（`markEmbeddedSurface`），Vim、宿主按键与焦点逻辑不碰它的按键。
- **键盘进入**（方向键、Vim `j`/`k` 把光标移进表格）：表格显示 Markdown 源码，由主编辑器编辑，
  单元格按键模型由源码命令保持（`commands/index.ts`）：

| 按键 | 行为 |
|---|---|
| Tab / Shift-Tab | 下/上一个单元格并选中其文字（自动对齐列宽；最后一格之后追加一行） |
| Enter | 下一行同一列；在空的末行上离开表格 |
| ↑ / ↓ | 上/下一行同一列，跳过分隔行；越过首/末行即离开表格（表格在文末时新开一行） |
| ← / → | 在单元格文字边缘进入相邻单元格 |
| Backspace | 在单元格开头移到上一格末尾，从不删除 `|` |
| Shift-Enter | 单元格内换行 `<br>` |
| Mod-Enter | 在下方插入一行，光标进入其第一格 |

渲染状态下：从一格拖到另一格是框选；Shift-点击 选中单元格，方向键在选中的格子间移动，Enter
就地编辑该格。工具栏插入行列后，新单元格就地进入编辑。

## 上下移动：一个行模型

Vim 的 `j`/`k` 与编辑器的 ↑/↓（原生按键与 xwidget 宿主都经由 `runEditorMovement`）走同一套
视觉行（`src/cm6/screen-rows.ts`：`visualRowAt`、`nextVisualRow`、`prevVisualRow`、
`moveByVisualRow`）：

- 一行是读者看到的折行行；**仍被绘制的块**（公式、图表、元数据封面、未打开的表格）整体算一行。
- ↑/↓ 越过 object 块时落在其后（越过显示公式即进入公式）；进入 structure 块（表格）时落在近端，
  它随即打开为文字。Vim 落在块行上时落在块的开头，从不落进隐藏源码。
- 行内 object 不能容纳光标：落点在其开头；若它恰好开启一行，落在其后（CodeMirror 把它之前的
  位置画在上一行末尾）。
- 无布局时（脱离文档的编辑器、测试）行退化为源码行，目标列用字符列。
- CodeMirror 的 `moveVertically` 不再使用。

## Vim 与屏幕行

- Vim 的行是屏幕折行行（`src/cm6/screen-rows.ts`）。判断一个字符画在哪一行时，用它
  自身的结束边缘 `coordsAtPos(next, -1)`：CodeMirror 把行首 widget 前的光标位置
  报告在上一行末尾。行首是公式或隐藏标记（`**`）时，这个位置归属它真正显示的行。
- Vim 通过 `renderedConstructAt(view, pos)` 知道哪里画着什么，只把 **object** 当作一个字符
  （在公式上按 `i`/`a` 进入其 TeX 源码）；**structure**（表格、块标题、`@@` 命令）在光标
  落上时打开，Vim 按文字移动。
- 模式通过 `publishMode` 一处发布：写 DOM 属性（供主题/宿主）并在状态中设置 pinning。

## 守卫与测试

| 测试 | 保证 |
|---|---|
| `tests/architecture-constructs.test.ts` | 视口家族共用一个生命周期；字面范围只有一个答案；光标从不被隐藏（插入模式方向键与 Vim 移动扫过全部家族）；在 object 旁删除先整体选中、再整体删除（扫过示例笔记中所有绘制的 object）；组件写文档只经 `dispatchConstructEdit`；静态规则（无允许列表）：只有一个行模型（不调用 `moveVertically`）、只有一个装饰修补器、渲染模块必须经由 constructs 层决定显示并向 registry 登记、组件内 Markdown 只经共享渲染器、不得手写选区比较、不得读 DOM 模式、Vim 不得扫描、嵌入面只在一处拼写、表格就地编辑器必须是嵌入式编辑面；运行时双向一致：示例笔记（覆盖全部家族）中 registry 报告的每个组件都被绘制，绘制在源码上的每个 widget 都被 registry 报告 |
| `tests/rendered-constructs.test.ts` | policy 语义、registry、pinning、代码/公式内不识别、Vim 逐行穿过表格 |
| `tests/cm6/table-keyboard.test.ts`、`table-interaction.test.ts` | 表格以源码编辑时（键盘进入）的单元格按键模型、撤销步骤 |
| `tests/cm6/table-cell-input.test.ts`、`table-cell-input-interaction.test.ts`、`table-cell-assist.test.ts` | 点击就地编辑：输入框、格内公式 MathLive、补全、格间移动、写回与撤销 |
| `tests/vim-row-geometry.test.ts` | 折行处以组件开头时的屏幕行 |
| `tests/rendered-constructs.test.ts`（vertical motion） | ↑/↓ 进入表格的首/末行 |

守卫没有允许列表。失败时修代码；规则本身需要改变时，先改本文，再改守卫。

## 已知差距与路线

- **表格的源码形态**是对齐后的 Markdown（Tab 会对齐列宽），而不是网格；需要所见即所得的
  网格编辑时，下一步是在源码行上用行装饰与 CSS 绘制网格，键位模型不变。
- **行内 Markdown 标记**（`**`、`` ` ``、链接括号）使用统一 policy，但不进 registry：它们是
  structure，被打开时就是普通文本。
