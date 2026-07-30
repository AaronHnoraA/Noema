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
  editor-cm6.ts             稳定 Editor facade 与 standalone/embedded shell
```

`editor-cm6.ts` 只决定宿主策略（history、editable、DOM event、callback）；语言、
feature 顺序和 visual mode 由 composition root 决定。Visual mode 使用
`StateField + StateEffect + Compartment`，不再依赖闭包状态。
Pointer drag 使用独立 StateField；拖选期间复用 decoration，结束后一次刷新。

原有性能路径保持：viewport delta、8ms/16KB 解析预算、CJK line cache、近变更修补、
byte-budget caches、MeasuredWidget、async epoch 以及 worker/observer teardown。

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
继续使用各自字体，并保留原 20px 结构字号基准。Visual 的连续空行分类并入已有 `lineDecoField`：普通空行 run 只
贡献一个段落节奏，语义块吸收邻接空行，光标进入时局部展开。选择和文档更新都只修补
相关行窗口；widget 垂直留白仍用可测 padding，不在 measured root 上使用 margin。

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

## 浏览器应用

```text
aaronnote/
  features/zoom/controller.ts   缩放状态、手势 listener、timer 生命周期
  features/writing-stats/       文档/章节缓存、idle 调度与大文档延迟
  main.ts                       兼容装配入口；其他 feature 按相同边界逐步拆分
```

Controller 显式返回 `destroy()`；`window.aaronnoteApi`、宿主事件和 xwidget wire
protocol 保持不变。

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

## Emacs

```text
lisp/roam/init-aaronnote.el
  进程、buffer/session、公开命令和 UI 装配
lisp/roam/aaronnote/emacs/aaronnote-xwidget-keys.el
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
