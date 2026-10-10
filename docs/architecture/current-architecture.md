# Noema 当前架构

本结构在 Overleaf Source Editor 的分层原则上改造，但 Noema 仍以 Markdown
为唯一真相源；不包含 LaTeX Visual Editor、OT、编译或 Overleaf UI。

## 编辑器

```text
src/cm6/
  commands/                 Markdown 编辑命令
  extensions/index.ts       唯一 feature composition root
  extensions/visual/        Visual/Source mode 与 visual features
    widgets/                数学、proof/org-env、表格、图片、Jupyter 等
  languages/markdown/       Lezer Markdown 配置与 Noema 扩展
  utils/tree-operations/    增量 change/viewport 查询
  utils/                    effect 与 projection 基础设施
  editor-cm6.ts             稳定 Editor facade 与 Emacs-owned host adapter
```

`editor-cm6.ts` 只决定宿主策略（history、editable、DOM event、callback）；语言、
feature 顺序和 visual mode 由 composition root 决定。Visual mode 使用
`StateField + StateEffect + Compartment`，不再依赖闭包状态。
Pointer drag 使用独立 StateField；拖选期间复用 decoration，结束后一次刷新。

原有性能路径保持：viewport delta、8ms/16KB 解析预算、CJK line cache、近变更修补、
byte-budget caches、MeasuredWidget、async epoch 以及 worker/observer teardown。

外层滚动宿主的视口锚定只有一个所有者：`viewport-stability.ts`。光标离开一个块时该块会
重新折叠（公式、环境块、表格的源码与渲染高度不同）；若它在视口上方，屏幕内容会整体位移，
表现为“滚动后点击，内容跳走”。按下指针时在此记录被按位置的屏幕高度，这次按压引起的
重排（含松开后 250ms 内才上报高度的 widget）都把该位置钉回原处，每次按压只读一次布局。
它只对抗重排：滚轮、拖选边缘自动滚动、滚动条、点击处理器自己发起的跳转（链接、大纲、
Emacs 滚动命令）一律优先，包括尚未派发 `scroll` 事件的写入。不要在应用层为点击另加
滚动修正；需要新的豁免时扩展这个类。

两种不是“读者在滚动”的位移也归这个类处理。其一，点击文末附近的已渲染块会重建它的
widget，未测量前文档瞬间变短，浏览器自己把 `scrollTop` 夹到新的最大值（没有任何输入或
代码写入）；这被识别为重排（位移向下且正好落在最大值上），高度恢复后把被按位置钉回去。
其二，Vim 层“接管别处设好的选区”（`syncSelectionFromEditor`：点击、拖选、已经滚动过的
跳转）时只调整选区、不滚动视口：Normal 模式下落在已渲染的表格/公式/图片上的光标会被吸附
到该块的起点，若再去“显示”这个起点，刚点过下半部分的高块就会被拉回顶部。选区是谁设的，
视口就归谁；Vim 自己发起的移动（`j`/`k`/`w` 等）照常滚动。

打开笔记后光标上方的图片、公式、图表会陆续拿到真实高度，所以“把光标带进视口”要在短时间
内重复几次（`aaronnote/settled-reveal.ts`）。这些重复是对视口的一次占用，只属于打开笔记
的那一刻：读者一旦滚动、点击、触摸或按键，或者选区、文档已经不是当时的那个，后续的定时
居中全部作废。不要再写“延时若干毫秒后再滚一次”的裸定时器；需要等布局稳定时用这个函数。
已经显示在本窗格里的笔记不会因为宿主再次要求打开而重开（那会清空撤销历史并把视图拉回
光标），从磁盘取内容用 `refresh`。

### LiveTeX 的写回保真

Markdown 源码是文档，LiveTeX 只是它的一个编辑视图，所以“打开再关闭”必须得到原来的公式。
MathLive 不会报告它表示不了什么，只会悄悄改写：不认识的环境（`alignat`、`flalign`、
`CD`、`drcases` 等）被删掉 `\begin` 并把每个 `&` 写成字面的 `\&`；`align`/`split`
把第三个单元格折成新的一行；`gather`/`multline` 把每个单元格变成一行。
`visualTexWritebackIssue` 在挂载编辑器之前拦下这些公式，走 `onUnavailable` 回退到源码
编辑。可往返的环境名单是对 MathLive 0.110 实测得到的，升级 MathLive 后要重新核对。

LiveTeX Studio 的逐行编辑器给每一行一个独立公式，而独立公式没有列。行里带列的文档
（矩阵、`cases`、手写的多列对齐、以 `&` 开头的续行）因此作为一个整体公式编辑
（`visualTexRowsCarryColumns`）。对齐环境里只有“关系符前的那一个 `&`”可以在编辑时去掉、
写回时重建；作者手放的其余标记原样保留。

### 元数据块是文档事实

笔记有没有 `#+begin meta` 块由文档决定：YAML front matter 在最开头，否则是开头
`ORG_META_PREAMBLE_LINE_LIMIT` 行内的第一个 `#+begin meta`（`shared/meta-summary.mjs`）。
索引、标签/元数据编辑（`note-tag-transaction.ts`）和“文档属性”命令共用这条规则。不要用
“是否在第 0 个字符”或“面板是否在 DOM 里”来判断：前者在块前有空行时、后者在源码模式或
块滚出视口时都会得出“没有”，然后在顶部再插入一个块，索引读到的就是那个只有一个字段的
新块，页面的 id 和标题随之丢失。

## 排版内核

```text
src/cm6/extensions/visual/typography.ts   Visual-only 几何宽度与主题入口
src/styles/typography.css                 唯一正文 font/rhythm 所有者
src/styles/fonts/                         Latin Modern Latin-only WOFF2
```

Visual 排版是 composition root 的核心扩展，不是应用层 CSS 修补。宽度算法直接适配
Overleaf `visual-theme.ts`：只在 CM6 `geometryChanged` 且文档未修改时读取一次
`contentDOM.offsetWidth`，通过 `Compartment + Facet + Annotation` 写入
`--content-width` 并阻止自触发循环。正文 padding 为
`clamp(max(32px, width * 4%), (width - 95ch) / 2, width * 8%)`。窄屏留白在
32px 处停止收缩（约对应 800px 容器宽度），中等窗口维持 95ch 阅读测度；宽屏的
单侧留白最多为窗口的 8%，所以正文至少占 84% 并继续随窗口增长。因此无需 window
resize listener。

Visual 编辑面的最小排版宽度为 800px；低于该宽度后停止重排，由既有 editor host
横向滚动。发布网页不继承此编辑器下限，继续对移动端响应式排版。

正文默认 23.2px/1.5（原 20px 的 116%），英文使用 Latin Modern Roman；heading、数学、代码与 UI
继续使用各自字体，并保留原 20px 结构字号基准。Visual 的连续空行分类并入已有 `lineDecoField`：
首个空行呈现段落节奏，后续空行以较紧的固定行高保留编辑位置；光标移动不改变高度。
源文件换行在编辑视图中保持换行，最优断行只处理单条源文件行。文档更新只修补相关行窗口；
widget 垂直留白仍用可测 padding，不在 measured root 上使用 margin。

发布长文复用同一 4%–8% 自适应连续流；PDF 页面与 Reveal slide 只复用字体和节奏，
保留各自的纸张/舞台宽度模型。

## 元数据封面

```text
shared/meta-summary.mjs                            浏览器/Node 共用的前导区范围与等长遮罩
src/org-meta.ts                                      meta/嵌套 summary 的纯语法层
src/render-html.ts                                  共享 HTML/发布渲染
src/cm6/extensions/visual/widgets/block-extras.ts   单一只读 MetaWidget 投影
src/styles/widgets.css                              论文首页、topics 与 Abstract 排版
```

`#+begin meta` 仍由 depth-aware org-env scanner 作为一个稀疏顶层块缓存，内部
`#+begin summary` 不注册第二个 widget。`org-meta.ts` 只解析一次并把 summary 从
key/value 元数据中隔离；CM6 与 HTML 导出消费同一个结果。Visual 模式只读投影，编辑
统一切到 Source，因此不会出现嵌套输入框回写时丢字段或破坏块边界的问题。

Meta 只在文档前 12 行识别。共享范围扫描器将内嵌 summary 作为封面的
局部文档：它会渲染 Abstract，但其内部标题、标签、Org 块、TODO、图引用与
字数都不进入外部 TOC/索引/统计。Node 端用保留换行和偏移的等长遮罩，
浏览器端在已有增量索引 StateField 中跳过该范围；范围外编辑仍走局部修补。

## Emacs 内的 CM6 组件

```text
aaronnote/
  features/zoom/controller.ts   缩放状态、手势 listener、timer 生命周期
  features/writing-stats/       文档/章节缓存、idle 调度与大文档延迟
  main.ts                       兼容装配入口；其他 feature 按相同边界逐步拆分
```

Controller 显式返回 `destroy()`；`window.aaronnoteApi`、宿主事件和 xwidget wire
protocol 保持不变。

### Emacs 单一 UI 契约

`web-host.mjs` 向 Emacs xwidget/Appine 提供 `dist/aaronnote`，页面只执行一次
`aaronnote/main.ts -> createEditor(host)`。Emacs 是唯一第一方 UI/UX：window、buffer、
minibuffer、Graph Board、JuText、Inspector、Attention、agent-shell、vterm、审批、输入和
Proposal 复核都由 Emacs 拥有。CM6 只负责私有 Markdown 文档面及其 document widgets，
不得出现第二套工作流 GUI、应用标题栏、原生窗口菜单或 Electron preload API。

只读 server reader 可以复用同一渲染器，但它是发布面，不是控制面：不能审批、回答、
复核 Proposal 或控制 run。Chrome 扩展也只有 capture 能力。B3 组件装饰使用显式 surface
白名单，不能依据 `<aside>` 或 `-panel` 后缀把 status HUD、References 等正文区域提升成卡片。

`make build-web` 生成 Emacs 消费的 renderer；`make`/`make build` 再构建 headless Go
kernel，`make install` 只把 kernel 链接到 `~/.local/bin`。renderer 成功构建后会原子写入
generation 回执；本地 Node host 监听该回执，并让运行中的 xwidget/Appine 在保存本地修改
后整页 reload。长期存活的 Emacs WebKit 页面因此不会继续执行旧 hashed bundle；
EventSource 重连也会比较 generation。未保存的 remote note 或 scratch 会阻止自动 reload。

## Node host

```text
server/
  Features/*/api.mjs            feature controller / channel registration
  Features/Session/manager.mjs  可独立测试的 session 领域逻辑
  infrastructure/api-router.mjs transport-neutral router 与冲突检查
  lib/runtime.mjs               旧 public facade 与尚待迁移的领域实现
web-host.mjs                    HTTP/SSE、静态资源、router composition
```

HTTP handler 不再直接拥有 Jupyter、Assets、Session、Tasks、Filesystem、Prose、
Emacs channel 表。Session manager 通过注入合法路径和原子写策略与 runtime 解耦。

Node host 对 canonical note root 只保留协议与插件装配：Markdown 打开、CM6 ChangeSet
CAS 保存、rich note catalog、planning/property 和 FTS5 都由其监督的 Go kernel 提供。
`server/lib/kernel-markdown-provider.mjs` 只做 box/path 边界校验与 JSON 形状映射；
Jupyter、Copilot、MCP 可以继续作为独立 Node 插件单向调用 kernel，不能成为编辑核心
的反向依赖。

编辑器只在打开响应明确声明 `incrementalSave` 时发送 ChangeSet。这样旧 host 或 kernel
尚未 ready 时会安全回退全文，而不会把能力缺失误报成保存失败；canonical box ready
后是一趟 Go UTF-16/CAS 保存。note root 外的 standalone Markdown 仍是明确兼容边界，
由 Node 在保存队列内直接应用同一 UTF-16 ChangeSet、校验 SHA-256 baseVersion 并原子
rename，因此大文件也不需要从 renderer 发送全文。

Go rich catalog 把 title/id/kind/date/project/tags/aliases/summary、blocks、DOM targets、
refs/backlinks 和 mtime/size 缓存在 immutable Markdown snapshot 及持久索引 cache 中。
watch/save 每次只替换变化路径，再在内存重连关系；`notes:list`、completion、Agenda、
Graph 和 related Knowledge 共用该投影。standalone 文件打开后仍扫描其本地 sibling root，
不会错误复用 canonical note-root catalog。
host 还复用笔记库的单个递归 watcher，把 250 ms 合并后的 Markdown 变更路径推送给已连接页面；
Emacs 内的 ACP agent 完成一轮时，Noema 订阅 agent-shell 的 `turn-complete` 事件，
包括裸启动的 Claude 会话；对已打开的 Markdown 页面各查一次文件时间戳，只有变化时
才让页面读取正文。可见和最近的 JuText buffer 同时由自己的磁盘同步器检查一次；
无草稿时重新投影外部正文变更，有草稿时保留本地内容并合并运行输出。
ACP 回合完成只先查 JuText 文件时间戳；没有变化就不读取或哈希整份 `.noema`。
本地文件通知携带实际写入信号，即使时间戳相同也核对内容修订。
Emacs 网关的 `aaronnote.command` 只把 `detail` 内的 `file`、`mtimeMs`、`clientId`
转发给页面；顶层 `command`、`client` 属于 host 路由协议。
页面仅在无草稿时自动重读当前文件；所有重读在异步结果返回时再次核对文件与
页面版本，自动重读还核对期间是否收到新的文件事件。没有为库外
独立 Markdown 新增常驻 watch 或轮询。自身保存事件依文件身份和高精度时间戳过滤，
紧随其后的外部改动仍会触发通知。

Agenda/Todo/Attribute View 的 canonical workspace projection 也只由 Go 生成。kernel 在一次
request 中联结窄 note metadata、planning nodes 与可选 property blocks；Node 不再先 walk/stat/read
全库，也不存在旧的 `readMany`/`readPropertyBlocks` 覆盖链。Emacs host 启动时等待 Go 完成首次
box 注册后才监听，并对 canonical core 声明 `requireGoCore`：后续 provider 缺失或 degraded 时
失败关闭，不允许静默恢复第二套 Node note/planning/evaluator kernel。server reader 和 note root
外 standalone 仍使用明确隔离的兼容 parser；它们不属于 Go box 数据面。

Knowledge Dock 的 canonical virtual references 同样只由 Go 生成。kernel 从 additive persistent
narrow metadata 与 immutable source snapshot 取得 id/title/aliases/resolved refs，在目标专用的
Aho–Corasick pass 中排除 fenced/inline code、显式链接、自引用、已链接引用和歧义别名；catalog
generation 变化会精确清空 10 分钟有界 LRU。Node 只转发窄 mention/path 并做路径验证，renderer
再用已加载的 rich catalog 按 source id 解析可打开笔记，因此响应不重复携带整份 note row。
只读 server reader 仍保留自身 Node scanner；Emacs host 缺 Go endpoint 时 503，不回退读盘。

## Emacs

```text
lisp/roam/init-aaronnote.el
  进程、buffer/session、公开命令和 UI 装配
site-lisp/noema/lisp/noema-xwidget-keys.el
  md/xwidget 输入、焦点、Undo/Redo、Shift-Tab 与 Emacs windmove 焦点修复
```

按键桥迁移时保留了原命令名和调用协议。Cmd+方向键不经 Emacs/windmove
转发，由 CodeMirror/WebKit 保持原生编辑行为。

## 输入与 Vim

```text
src/cm6/text-boundaries.ts       共享 Unicode grapheme 边界
aaronnote/vim-lite.ts            Vim mode、operator/register、visual selection、s-jump glue
src/cm6/vim-jump.ts              viewport 候选、prefix-free 标签与 decorations
aaronnote/xwidget-key-guard.ts   Emacs/xwidget 事件归一化；编辑动作仍落到 CM6 source
```

普通/Visual 模式的 `j/k` 委托 `EditorView.moveVertically`，因此按 CM6 折行后的
屏幕行移动并保留像素目标列；编辑模式的方向键完全交给 CM6。不可测量的隐藏/脱离 DOM
编辑器才退回逻辑行。字符移动、选择、`x/X/r` 和 xwidget 删除共用 grapheme 边界，避免
拆开 emoji、组合字符或 CJK surrogate pair。Visual 选区内部保存 Vim 的 inclusive
anchor/head，CM6 边界只在 dispatch 时转换；鼠标和 Shift-click 选区在 mouseup 后反向
同步到该模型。

## 兼容与性能门禁

- `.md`、`.markdown` 与 README 仍由 Noema 处理；`.tex` 不由 Noema 接管。
- Markdown source offset、Editor facade、API channel、SSE command 和 Emacs 公开命令不变。
- Noema UI chrome、proof/custom block class 与颜色语义不变；正文排版由 typography core 统一。
- TeX delimiter 在不完整块公式及剪切/粘贴过渡态保持可见；普通 Markdown escape 仍按原规则折叠。
- CM6 roundtrip/command/editor API、5MB 大文档、Node feature、xwidget ERT 必须通过。
