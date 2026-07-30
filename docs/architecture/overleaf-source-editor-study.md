# Overleaf Source Editor 架构审读与 Noema 迁移矩阵

审读基线：Overleaf 官方仓库提交
`28ad3b03b71cb4311decdcb55c36b33ec10d72db`（2026-06-26）。

本文件记录一次性架构迁移的依据和边界。Noema 与 Overleaf 的产品定位不同：
Noema 继续以 Markdown 为唯一真相源，不引入 LaTeX Visual Editor、多人 OT、
编译/审阅业务或 Overleaf 主题。直接采用的 Overleaf 源码按 AGPL-3.0 分发；
改造后的 Noema 不建立自动上游同步机制。

## 1. 核心结论

Overleaf Source Editor 的主要优势不是某个 widget，而是清晰的依赖方向：

1. `components/codemirror-editor.tsx` 只创建并挂载 `EditorView`，卸载时销毁；
   外部状态同步集中在 `hooks/use-codemirror-scope.ts`。
2. `extensions/index.ts` 是显式 composition root。扩展顺序、优先级和模式边界
   在一个地方可读，具体实现各自独立。
3. 可变设置使用 `Compartment` 重配置，跨扩展通知使用 `StateEffect`，文档派生状态
   使用 `StateField`，DOM 生命周期使用 `ViewPlugin`；没有另一份可编辑文档模型。
4. 语言与视觉层分离：grammar/language、tree operations、projection、decorations、
   widgets、selection/keymap 分别位于独立层。
5. 跨行或 block replacement 由 `StateField` 提供；只影响可见内容的 mark decoration
   由 `ViewPlugin` 在 `visibleRanges` 内计算。
6. `projection.ts` 用 `ChangeSet.mapPos` 复用变更区间之外的派生项，并用
   `Pending / Partial / Complete` 表达解析不完整，而不是把旧结果直接清空。
7. parser watcher 以“需要解析到哪个 offset”为接口，消费者不轮询 parser。
8. 资源拥有者负责清退：view、DOM listener、throttle、timer、font listener、
   异步 widget destroy 都有对应 teardown。
9. 后端以 `Features / infrastructure / models` 分层；Controller 处理 transport，
   Handler 编排，Manager/Helper 承载领域逻辑。测试在 Feature 边界 mock 依赖。

## 2. 值得直接迁移的通用实现

| Overleaf 实现 | Noema 目标 | 迁移方式 |
|---|---|---|
| `utils/effects.ts` | effect/transaction 查询工具 | 直接迁移并保留来源 |
| `extensions/wait-for-parser.ts` | 按 viewport/offset 等待解析 | 直接迁移；禁止全文 `forceParsing` |
| `utils/tree-operations/projection.ts` | 增量文档投影 | 直接迁移并适配 Markdown node |
| `utils/projection-state-field.ts` | projection StateField 工厂 | 直接迁移；语言固定为 Markdown |
| `extensions/effect-listeners.ts` | effect 到外部回调的受控桥 | 直接迁移，修正数组原地修改 |
| `visual.ts` 的 `modeOnly` | visual/source-only 扩展重配置 | 抽取迁移，不复制 LaTeX provider |
| `before-change-doc.ts` | 文档切换前资源释放信号 | 直接迁移 |
| `selection.ts` 的状态建模 | 指针选择期间延迟原子装饰刷新 | 适配迁移 |

直接迁移文件必须在文件头注明 Overleaf 路径、审读提交和 AGPL-3.0。

## 3. 必须适配迁移的设计

### 3.1 Extension composition

- 建立唯一的 `createExtensions(options)`；扩展顺序和优先级只在这里决定。
- Source/Visual 模式改为 StateField + StateEffect + Compartment，不再依赖闭包布尔值。
- standalone 与 embedded 使用同一套 Markdown feature bundle；宿主差异只体现在
  history、editable、selection UI 等 shell extensions。
- theme、editable、mode 等运行时设置各自拥有 compartment 和 setter transaction。

### 3.2 Markdown language and syntax

- 标准 Markdown 继续使用 Lezer Markdown；Noema link extension 归入
  `languages/markdown`。
- `@@command`、planning DSL、trailing attrs、Markdown links 等语法集中到
  `shared/syntax`，浏览器、Node 和导出共用解析结果。
- CM6 tree 查询放入 `utils/tree-operations`；widget、command 和 app shell 不再
  散落字符串/正则式树遍历。

### 3.3 Visual rendering

- 单一 block/atomic StateField 负责跨行 replacement 和 block widget。
- 单一 inline/mark ViewPlugin 在 `visibleRanges` 内完成强调、链接、inline math、
  inline command 等装饰，避免每个 feature 独立遍历同一 syntax tree。
- line decorations 独立 StateField；它们不能安全地由 ViewPlugin 提供。
- headings、fences、tables、math、HTML、org-env、commands 建立可复用 projection；
  未受影响项 map position，只重扫变更窗口或受影响结构块。
- selection、keymap、click-to-source、widget DOM 和样式保持独立模块。

### 3.4 App/server organization

- 浏览器入口只装配 EditorSession 和 feature controllers；每个 controller 明确返回
  `destroy()`，不在 `main.ts` 遗留匿名全局 listener/timer。
- `window.aaronnoteApi` 保持兼容，但实现按 feature client 拆分。
- Node host 只负责 HTTP/SSE、静态资源和 router 装配；API handlers 由各 Feature
  注册。`runtime.mjs` 最终只保留兼容 re-export。
- Node Feature 采用 Controller → Handler → Manager；共享文件系统、安全路径、
  原子写入、事件和配置属于 infrastructure。
- Emacs 入口只做模块加载、公开命令和 keymap 装配；process、buffer/session、
  xwidget input、UI、Jupyter 分别拥有资源生命周期。

## 4. 不复制的内容

| 内容 | 原因 |
|---|---|
| `lezer-latex`、LaTeX grammar/token | Noema 坚持 Markdown；解析成本和扩展方向不符 |
| LaTeX atomic/mark widget 业务分支 | 对应命令和 environment 不属于 Noema 语义 |
| React/Angular context shell | Noema 是轻量原生 TS + Emacs 宿主，不为结构迁移引入 UI 框架 |
| realtime OT、track changes、review、compile | 产品功能不在范围内 |
| Overleaf visual theme | Noema 主题、proof/自定义块外观必须保持 |
| 初次显示前强制全文解析 | 大文档性能退化；Noema 只等待 viewport + overscan |
| atomic/mark decoration 全量重建 TODO | Overleaf 源码仍有未完成增量化；Noema 采用 projection 修补 |
| 动态第三方插件运行时 | Noema 已移除此能力；仅使用静态内部 feature registry |

## 5. 当前 Noema 差距

- `aaronnote/main.ts` 约 8,300 行：编辑会话、保存、bibliography、Jupyter、导航、
  zoom、context menu 和宿主事件互相穿插。
- `src/cm6/extensions/visual/widgets/block-extras.ts` 约 3,800 行：语法扫描、StateField、widgets、
  Jupyter/TikZ runtime 和 DOM 生命周期混合。
- `src/cm6/live-preview.ts` 约 1,800 行：inline tokens、table model、line classes、
  HTML blocks 和增量算法在同一文件。
- `server/lib/runtime.mjs` 约 8,000 行，`web-host.mjs` 约 1,700 行：领域逻辑、
  缓存、文件系统与 transport 边界不清。
- `init-aaronnote.el` 约 2,100 行：进程、buffer、输入桥、UI 和公开命令集中。
- 多个 viewport ViewPlugin 重复调用 `syntaxTree.iterate`；多个 StateField 各自实现
  相似的 change-window/map/fallback 算法。

## 6. 性能与正确性约束

- 普通字符、Enter、表格和标题编辑不得触发全文 syntax tree walk。
- viewport scroll 只扫描新进入范围；选择变化只更新相交的可视/原子范围。
- 结构变化允许扫描“变更点到匹配边界”；未闭合结构最坏到文档末尾属于正确性成本。
- parser 未完成时保留并 map 已知 projection，不能闪空或阻塞编辑。
- Markdown source offset 始终是跨浏览器、Node、Emacs 的坐标；DOM/widget 不持有
  独立可保存状态。
- 所有 timer、listener、observer、worker、异步渲染和 server task 必须由明确的
  owner 清退。

## 7. 兼容性约束

- Markdown 文本、保存协议、API channel、SSE command、Editor facade 与 Emacs
  公开命令保持不变。
- Noema 只接管 `.md`、`.markdown` 和 README；`.tex` 恢复原 Emacs 打开流程。
- 主题 class、proof/自定义块、数学、表格、图片、Jupyter 和 source/visual 交互
  必须通过行为与 WebKit 视觉回归测试。
- xwidget/Appine 输入桥覆盖字符、IME、Enter、Tab/Shift-Tab、方向键、删除、
  Undo/Redo 以及转发回 Emacs 的组合键。
