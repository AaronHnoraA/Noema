# Noema 性能 / 内存 / 页面清退升级

## 背景

长会话内存增长、大文档 jank、`destroy()` 清退不彻底三类问题的系统性修复。

## 进度

| # | 内容 | 状态 |
|---|---|---|
| 1 | 合并重复 math 缓存（`widgets/math.ts` + `math-render.ts`） | ✅ 完成 |
| 2 | 缓存按字节预算化（diagram / math / code-highlight） | ✅ 完成 |
| 3 | CM6 history 上限（`newGroupDelay` + `minDepth`） | ✅ 完成 |
| 4 | live-preview CJK 缓存行级化（viewport 滚动不再缓存抖动） | ✅ 完成 |
| 5 | StateField 存在性短路（mermaid / math / headings 无内容时跳过全文扫描） | ✅ 完成 |
| 6 | 页面清退完整链路（worker + 缓存 + KaTeX `<link>`） | ✅ 完成 |
| 7 | live-preview viewport 增量 token 收集（滚动只处理新滚入行）| ✅ 完成 |
| 8 | docChanged 时 CJK 缓存部分失效（仅清变更行及之后）| ✅ 完成 |
| 9 | 独立公式围栏索引增量化（编辑时不再全文扫描）| ✅ 完成 |

---

## 实施日志

### 2026-05-22

**1 — math 缓存合并**
- 删除 `src/cm6/extensions/visual/widgets/math.ts` 里的 512 条 LRU（`mathHtmlCache` / `cachedMathHTML`）
- `math-render.ts` 统一上限提升到 512，两处 `toDOM()` 改调 `renderMathHTML` 直接命中同一个 LRU

**2 — 字节预算**
- `math-render.ts`：4 MB 预算（html 字节数 × 2）
- `diagram-render.ts`：8 MB 预算（SVG 字节数 × 2）
- `code-highlight.ts`：4 MB 预算（`ranges.length × 48`）
- `code-highlight-async.ts`：8 MB 预算

**3 — history 上限**
- `editor-cm6.ts:683`：`history({ minDepth: 200, newGroupDelay: 500 })`

**4 — CJK 缓存行级化**
- 旧键：`${visibleFrom}:${visibleTo}:${text}`（每次滚动 miss）
- 新键：行号 → 行内相对偏移数组；每次 `docChanged` 清空（行号移位），纯滚动命中

**6 — 页面清退**
- `disposeMathRuntime()`：清 math cache + 移除 KaTeX `<link>` 节点
- `disposeDiagramRuntime()`：清 diagram cache
- `disposeHighlightWorker()`：terminate worker + 清 pending/listeners/asyncCache，重置 readyVersion
- `editor.destroy()` 末尾调用三个 dispose 函数

**测试**：279/279 全部通过

### 第二轮：CM6 StateField 存在性短路 + 编辑手感

**5 — StateField 存在性短路**

背景：8 个 StateField 在每次按键时都会根据改动字符决定是否重新扫描全文。问题在于"无内容文档"也同样触发，每次按 Enter/反引号/`#`/`-` 等特殊字符都会跑一遍全量扫描，然后返回空结果。

**a. `blockMathRangesField`（`math-ranges.ts`）**
- 新增 `changedLinesMightOpenMathFence()`：仅检查受影响新行是否出现 `$$` 围栏
- `ranges.length === 0` 时，若受影响行无 `$$` 围栏 → 跳过 `scanBlockMathRangesInDoc`（全文逐行）
- 受益场景：CJK IME 确认输入、粘贴、以及所有不含 math 的笔记

**b. `mermaidBlocksField`（`fenced-code.ts`）**
- 新增 `DIAGRAM_FENCE_OPENER_RE` + `docHasDiagramFence(doc)`：逐行文本检测（比 Lezer 树遍历快）
- `blocks.length === 0` 时，若全文无图表围栏 → 跳过 `collectMermaidBlocks`（全量 Lezer 遍历）
- 受益场景：**每次按 Enter、每次输入反引号**（触发频率极高）

**c. `headingsField`（`block-extras.ts`）**
- 新增 `ATX_HEADING_RE / SETEXT_UNDERLINE_RE` + `docHasHeading(doc)`：逐行文本检测
- `headings.length === 0` 时，若全文无标题 → 跳过 `collectHeadings`（全量 Lezer 遍历）
- 受益场景：输入 `#`（URL 中的锚点）、`-`（列表）、`=` 等字符时不再误触

**测试**：281/281（新增 2 个用例）

### 第三轮：live-preview 增量化

**7 — viewport 增量 token 收集**

背景：`LivePreviewPlugin.update()` 在每次 `viewportChanged`（滚动）时都对全视口重新跑 `syntaxTree.iterate` + CJK/链接扫描。对于长文档，每次滚动 10 行仍要重处理 100 行。

做法：
- `addCjkTextTokens` / `addWikilinkTokens` / `collectLivePreviewTokens` 改为接受显式 `ranges` 参数（不再硬读 `view.visibleRanges`）
- `LivePreviewPlugin` 记录上次视口包络 `lastVpFrom / lastVpTo`
- `viewportChanged` 时调 `computeDeltaRanges` 只收集新滚入的子区间，过滤掉已滚出的 token，合并排序
- 典型缓慢向下滚动（10 行）：只 iterate 新的 10 行，省去 ~90% 的 Lezer 树遍历

**8 — 部分 CJK 缓存失效（docChanged 时）**

背景：每次按键 `docChanged`，旧代码调 `cjkLineCache.clear()` 清空所有行缓存，导致下次扫描完全冷启动。

做法：
- 新增 `firstChangedLine(changes, doc)` 找到最早被修改的行号
- 仅清除该行及之后的缓存条目（行号可能因换行插入而偏移）；之前的行缓存完全保留
- 受益场景：在文档中间或末尾输入时，光标上方所有行的 CJK 缓存直接命中

**测试**：281/281

### 2026-08-07：独立公式围栏索引增量化

**9 — `blockMathRangesField` 局部更新**

- 状态中保留所有 `\[` / `\]` 围栏行（包括暂时未配对的围栏），文档修改时只重扫受影响的新旧行。
- 公式范围由围栏小索引重新配对，复杂度由 `O(正文长度)` 降为 `O(改动行 + 围栏数)`；普通合法文档中围栏数约为独立公式数的两倍。
- 不再依赖“单次 change 是否包含完整 `\[` / `\]` 字符串”，因此逐字符补全、删除或拆分围栏也能立即得到正确渲染。
- 初次加载仍需扫描一次全文；病态文档若每行都是未配对围栏，单次编辑仍与围栏数成正比，但不会读取普通正文。
- 5 MB 性能用例已从 known-scan 档移入普通 bounded 档；增量索引另以 160 轮确定性随机编辑和独立全文扫描交叉校验。

### 2026-08-28：功耗专项 —— 空闲实测 + 按键路径去平方

关注点是**功耗**，不是吞吐量。结论先行：空闲侧已经到地板，真正的电池成本全在**按键路径**上。

#### 空闲功耗实测（临时 vault，无客户端连接，60 秒采样）

| 进程 | cpu-s / 60s | RSS |
|---|---|---|
| node web-host | **0.00** | 106 MB |
| Go 内核 | **0.06** | 71 MB |

- node 空闲**零唤醒**：SSE 心跳按客户端存在与否启停，wiki 维护 6 小时且 `unref`，Copilot 只在进程存活时轮询。
- Go 内核用 `sample` 采样确认：主线程 park 在 `kevent`，其余线程 `_pthread_cond_wait`，唯一周期性的是 Go runtime 自己的 sysmon（`usleep`/`nanosleep`）。`StartCron` 里的消费者全部 channel park，`WatchSupervisorProcess` 走 kqueue `EVFILT_PROC/NOTE_EXIT`（已验证：node 退出后内核随之退出）。**运行时地板，无可优化项。**
- 渲染端 CSS 也已干净：无 `infinite` 动画，光标闪烁全局关闭，14 处 `backdrop-filter` 全部位于临时浮层。

#### 按键路径（5 MB 夹具 `synthetic_qc_note_5mb.md`，5143 标题 / ~21.5k 公式围栏）

分层归因显示 **99.6% 的每键成本来自 Noema 自己的扩展**，与 CM6 和 Lezer 无关：

| 层 | 每键 mean |
|---|---|
| 裸 CM6 | 0.08 ms |
| + Lezer Markdown | 0.23 ms |
| 完整编辑器 source 模式 | 30.4 ms |
| 完整编辑器 visual 模式 | 62.9 ms |

**10 — `heading-fold` 折叠范围去平方**

`headingFoldEntries` 对每个标题调用 `foldRangeForHeading`，而后者的内层循环**每次都从数组第 0 个开始**（靠 `lineNumber <= h.lineNumber` 跳过前缀），因此是 O(标题数²)。`buildChevronDecos` 又是先算完整份 entries、再按视口过滤。

- 内层扫描改为从 `index + 1` 起步。同级子树互不相交，一趟全量因此被 (层级数 × 标题数) 界住，而非平方。
- `buildChevronDecos` 改为在 `tocIndex.headings` 上二分定位视口（排序键是 `pos`，且 markdown 标题满足 `markerFrom <= pos`，故不会漏掉标记仍在屏内的标题），只为可见标题构造范围与 widget。
- `headingFoldEntries` / `markdownHeadingsWithLines` 按 `EditorState` 做 WeakMap 缓存（命令路径与 foldService 会重复取用同一 state）。
- 该模块此前**零测试覆盖**。新增 `tests/heading-fold.test.ts`：把原 O(H²) 实现作为语义参考实现保留，在 5 MB 夹具（>1000 个折叠范围）与 8 个嵌套/围栏/边界用例上逐一比对，另加折叠命令行为与隔离的性能护栏。

**11 — `math-ranges` 增量更新去分配**

每次按键 `updateBlockMathIndex` 要：filter 21.5k 围栏 → spread 重建全部对象（~43k 次 `mapPos`）→ **对 21.5k 元素做完整排序** → `rangesFromFences` 再为 ~10.7k 个公式各建一个 `from:to:contentFrom:contentTo` 字符串键塞进 Map（又 ~43k 次 `mapPos`）。合计约 86k 次 `mapPos` + 21k 个字符串 + 32k 次对象分配，CPU 与 GC 双重压力。

- 新增 `firstChangedOffset`：完全位于首个改动之前的围栏/范围映射即恒等，直接复用对象、跳过 `mapPos`。
- 幸存围栏与改动行重扫结果都是有序的，用 `mergeFences` 线性归并取代全量 `sort`。
- `rangesFromFences` 用单游标双指针取代字符串键 Map（两侧同为文档序），字符串与 Map 全部消除。
- 由既有的 160 轮随机编辑对全文重扫交叉校验守住语义。

#### 效果（同机、同夹具）

| 场景 | 之前 | 之后 |
|---|---|---|
| 5 MB visual @开头 | 60.8 ms/键（120 键 7.3 s） | **13.3 ms**（1.6 s） |
| 5 MB visual @末尾 | 72.2 ms/键（8.7 s） | **28.8 ms**（3.5 s） |
| 5 MB source 模式 | 30.4 ms/键 | **1.8 ms** |
| 40 KB | 1.25 ms/键 | 1.05 ms |

`heading-fold` 层单独看：28.93 → 1.74 ms；`blockMathRanges` 层：20.22 → 5.25 ms。

**测试**：2088 passed（此前 2082，净增 6）。

**12 — 动图暂停链路修复**（本轮定位，实现由作者完成）

原缺陷：`src/image-animation.ts` 的 class 开关与 idle 接线都正确，但 CSS 侧只有
`image-animation: paused`，而**没有任何浏览器实现该属性**，动图在 idle/后台仍持续
解码合成。既有测试只断言 class 开关，故长期未被发现。

现方案：`nativeImageAnimationControlAvailable()` 用 `CSS.supports` 探测原生 CSS Image
Animation，不支持时启用 `createImageAnimationFreezeFallback()` —— 把当前帧画进一张
canvas 插在 `<img>` 前、原图 `display:none`，恢复时移除 canvas 还原原元素。canvas
像素数有上限（默认 2M）以免大图冻结本身变成开销。仅对 `.gif/.apng/.webp` 及对应
data URL 生效，普通 PNG/JPEG 不受影响。已配 `.noema-image-animation-freeze-frame`
样式与单元测试。

#### 后端负载路径复核

空闲之外也复核了保存响应路径（`go test -tags fts5 -bench SaveResponsePhases`，
M2 Max，60 KB 文档）：atomic-write 376 µs / scan 408 µs / signature 84 µs /
document-identity 30 µs，合计约 0.9 ms，与 2026-08-26 那轮的结论一致。**后端空闲与
负载两条路径现在都有实测支撑**，不是只凭空闲采样下的结论。

#### 排除的假线索（记下来避免重复踩）

- **`livePreview` 的 52 ms 是配置假象。** 分层叠加时出现非单调（单独 52 ms，叠加
  `blockExtras` 后回落到 16 ms）。用「热身 10 次 + 100 次采样」重测发布配置：
  common 4.64 ms → +widgets 8.68 ms → **+livePreview 12.27 ms**，即 livePreview 在
  真实栈里只值 **+3.6 ms/键**。52 ms 只在「有 `livePreview` 但不加 widget 层」这种
  产品中不存在的组合下出现（widget 层会把大段公式替换成替换型 widget，改变 CM6 的
  视口构成）。**分层基准必须以发布配置为准，单层数字会误导。**
- happy-dom 里 CM6 视口是正常的小范围（575–627 B）而非全文档，所以 live-preview 的
  token 收集本来就是视口有界的——"happy-dom 无 layout 导致视口等于全文"这个猜想是错的。
- 效果表「@末尾」一档部分是基准假象：光标在文档末尾而视口仍在顶部，真实使用中视口
  跟随光标（即「@开头」那一档 13.3 ms 才是贴近真实的数字）。

### 2026-08-28（第二轮）：前端请求审计 —— 用真实浏览器客户端实测

前一轮的空闲采样有个盲区：**没有客户端连接**。补测「连着客户端」的场景，并逐条记录
前端发出的请求（在页面里包 `fetch`，按 channel 归类）。

#### 空闲仍然干净（盲区已闭合）

- 800 篇笔记的 vault，浏览器客户端连接并打开一篇笔记，静置：**前端 0 个请求**，
  node 0.00 cpu-s/40s，Go 内核 0.03。批量新增 800 个文件时 node 短暂到 0.24 cpu-s/30s
  （fs watcher + 一次性索引），随后回到 0.00。
- 打开一篇笔记：2 个请求 / 338 B。`notes:save` 走增量 ChangeSet，556 B。

#### 找到的真问题：一次打字 → 17 个请求 / 175 KB

在 800 笔记的 vault 里敲 73 个字符，8 秒内：

```
prose-check:run      11372 B
copilot:request     128092 B   ← 整篇笔记
prose-check:cancel     102 B
prose-check:run      11372 B
prose-check:cancel     102 B
notes:save             556 B
prose-check:run      11016 B
prose-check:run      11040 B
prose-check:cancel     103 B
```

**13 — Copilot 补全上下文窗口**

`largeBufferThresholdKb` 默认 **512**，意味着 512 KB 以下的笔记**每次补全都整篇上传**。
窗口化代码（游标前 72% / 后 28%）一直存在，只是阈值高到实际永不触发。语言服务器
只从游标附近取几千 token 建 prompt，多发的部分是纯浪费：前端序列化 + HTTP + 服务端
重新解析。改为 **64 KB**（约 16k token，仍远超模型消耗），`plugins/noema-copilot/renderer.ts`
的默认值与 `aaronnote/main.ts` 的 `getSettings` 同步。

覆盖缺口是这个默认值从没被测过——既有的窗口化测试都显式传 `largeBufferThresholdKb`
（1 或 512），所以默认值走的分支无人验证。新增用例故意**不传**该项，让插件默认值生效，
断言 120 KB 笔记的载荷 ≤64 KB。回归验证：把默认值改回 512 时该用例失败并报
`expected 132007 to be less than or equal to 65536`。

**测试**：2096 passed（此前 2092）。

#### 尚未处理

- **prose-check 空转**：一次打字触发 4 次 `run` + 3 次 `cancel`（各 ~11 KB）。载荷本身
  是窗口化的（32 KB 上限）没问题，浪费在「起了又取消」——每次 run 都让服务端真的开始
  LanguageTool 工作，1 秒后才被取消。应让空闲防抖真正等到停止输入再发起，而不是发起后
  再撤。量级远小于 Copilot 那条，但同属「前端不合理请求造成后端负载」。
- 浏览器端滚动实测：真实滚轮 20 tick 只有 1 个 58 ms 长任务；程序化滚动 32000 px（80 帧）
  零长任务、中位帧 12 ms、p95 30 ms。12 ms 中位帧对功耗仍偏高（滚动时约占一个核心的
  70%），但没有发现病理性尖峰。**注意**：`.cm-scroller` 不是滚动容器，真正的滚动宿主是
  `section.aaronnote-focused-editor`；在错的元素上做滚动基准会得到完全虚假的数字
  （我一度测出 564 ms/帧，全是假的）。
- Emacs xwidget 宿主下的功耗无法用 Chrome 复现（Emacs 要用自己的 redisplay 重绘 xwidget，
  每帧成本翻倍），上述浏览器数字只是下界。


### 2026-08-28（第三轮）：prose-check 空转的根因是语义装反了

上一轮把「4 次 run + 3 次 cancel」归为防抖不够狠。实际读代码后，问题不是防抖时机，
而是**自动检查的触发条件被写反了**。

`ProseCheckLifecycle.setQuiescent(true)` 会 `clearAutoTimer()`、取消**正在飞行**的
自动请求，并把它重排成 `dueAt = now`；`pump()` 又在 `this.quiescent` 时直接返回。于是：

- 共享渲染器活动门在**最后一次输入后 1 秒**进入 quiescent；
- 自动检查的防抖是 1000 / 1800 / 3000 ms（responsive / balanced / quiet）——**都晚于
  或等于那 1 秒**；
- 所以在 `balanced` 下，该跑的检查在空闲期**从来跑不到**，它被挂起；
- 直到用户**再次敲键**，`setQuiescent(false)` → `pump()` → `remaining = 0` → **立刻**
  发起一个全量 LanguageTool 请求；
- 下一个按键换了 signature，这个请求随即被 cancel。

两头都亏：服务端每段输入的第一个按键上真的开始干活然后被丢弃，而用户真正停手时
反而永远拿不到结果。

**修复**：quiescence 不再压制自动 prose 工作。`pump()` 去掉 `this.quiescent` 短路，
`setQuiescent` 只记录状态、不再 clear/cancel/重排。防抖定时器成为唯一的启动权威，
signature 去重本来就把它限制在每个文档修订一次。真正省电的闸门是 `setPaused`
（宿主表面隐藏时），它仍然取消一切——这和 `focus-quiescence.ts` 里 `setQuiescent`
早已被改成 no-op 的结论是同一个：quiescent 是调度状态，不是「停掉一切」。

改动：`aaronnote/prose-check-lifecycle.ts`。

**行为变化（如实记录）**：滚动也会 `scheduleAutomaticProseCheck(scrollMs)`，且
`proseAutoSignature()` 含 `visibleRanges`。修复前，纯阅读式滚动产生的检查全部被挂起、
再被后续按键顶掉；修复后它们会在滚动停稳后真正发出。这是该特性本来的设计（检查新
进入视口的文本），且仍受 `automaticEnabled`、`paused`、`document.hidden` 三重门控——
在 Emacs 里后台窗格本来就是 paused。总请求数不增加，区别是原先发了就扔的请求现在有用。

**测试**：`tests/prose-check-lifecycle.test.ts` 里两个把「装反的行为」固化下来的用例已
重写为守护正确语义，新增一个断言「防抖而非 quiescence 决定启动时刻」。全量 2110 passed
（`tests/drag-select-cost.test.ts` 的 p95 门限在整套并发下偶发 17.4 ms > 16 ms，单跑通过，
与本轮改动无关）。

### 2026-08-29：Emacs xwidget 真机闭环 + Unicode 请求预算

#### 锁定运行时下的整链功耗

用 `scripts/measure-xwidget-idle.sh` 启动隔离 GUI Emacs，打开真实 108 KB GraphTensor
夹具；脚本同时断言 xwidget、Node 和 Go 存活，并按本次新增 PID 归属 WebKit 辅助进程。
运行时严格为 Node 26.5.0 / npm 11.17.0，30 秒 settle 后采样 60 秒：

| 进程 | 前台 cpu-s/60s | 后台 paused cpu-s/60s |
|---|---:|---:|
| Emacs | 0.05 | 0.05 |
| Node web-host | 0.00 | 0.00 |
| Go kernel | 0.08 | 0.07 |
| WebKit GPU | 0.00 | 0.00 |
| WebKit Networking | 0.00 | 0.00 |
| WebKit WebContent | 0.11 | 0.09 |
| **整链** | **0.24** | **0.21** |

后台不再出现前台 renderer 被兄弟 pane 的 pause 广播误伤；同时后台确实进入 paused，
不是核心进程退出造成的假低值。测量脚本只清理自己启动的精确 Emacs/Node/Go PID，禁止
全局 `pgrep/pkill`，避免伤及用户正在运行的 Jupyter kernel。

#### 原生连续输入与多 pane 隔离

- macOS System Events → Emacs xwidget → WebKit → CM6 连续输入 1040 字符：1040 次
  `beforeinput`、1040 次 `input`，顺序完全一致并成功保存；实际事件流 11.563 秒，最大
  间隔约 61 ms，没有 Long Task，页面未误暂停、焦点未丢、Node 状态保持 `run`。
- 该 xwidget 端口不产生普通 `keydown`，因此恢复活动不能依赖 keydown；可信
  `beforeinput`/composition/pointer/paste 是必要的原生能力。
- 两个 retained xwidget 同时存在时，向选中 split pane 输入 104 字符：前台收到
  104/104，后台 canonical pane 保持 `paused=true` 且收到 0/0，证明客户端寻址和输入
  生命周期均严格隔离。
- Node 同端口替换后，强制 SSE 重连会重放每客户端最后的 pause/resume；路径身份先做
  native `file-truename`，`/tmp` 与 `/private/tmp` 不再生成两个 canonical 客户端。

#### 请求量复测

在真实 xwidget 的窄桥接 API 边界记录 73 字符编辑，停稳 10 秒后只有：

| 调用 | 次数 | 载荷 | 结果 |
|---|---:|---:|---|
| `notes.save` | 1 | 421–423 B | 12–14 ms |
| `proseCheck.run` | 1 | 7.8 KB（正文约 7.1 KB） | 493–561 ms |
| `proseCheck.cancel*` | **0** | 0 | — |

即旧基线的 Prose 4 run + 3 cancel 已降为一次真正有结果的检查；本次光标后有正文，
Copilot 按 eligibility 规则不发请求。

#### Copilot UTF-8 窗口与生命周期内存上界

`largeBufferThresholdKb` 原先实际按 UTF-16 字符数裁剪：少于 64K 字符的中文或 emoji
笔记仍可产生 3–4 倍于设置的网络载荷。现改为按 Unicode code point 精确计算 UTF-8
字节，在保持 CM6 UTF-16 `from/to/offset` 坐标的同时确保 `content <= 64 KiB`；大文档
只调用 `markdownBetween` 读取光标两侧最多一个预算，不再为了裁剪先分配整篇字符串。
30,000 个中文字符和 20,000 个 emoji 的回归均验证载荷上界、needle/offset 和零次
`getMarkdown()` 全文读取。TeX 虚拟文档也使用同一预算；超大的公式源区不再绕过窗口
整段上传。

异常关闭的 WebKit 可能来不及发送 `client-close`。Node 的生命周期重放 Map 现在是
最近 256 客户端的 LRU；正常关闭仍立即删除，崩溃/断网也不会让 canonical path key 在
数周运行的 web-host 中无界增长。

#### Go 保存热路径复测

`go test -tags fts5 -run '^$' -bench SaveResponsePhases -benchmem ./...`（M2 Max，约 60 KB）：
atomic write 180 µs、self-write 24 µs、scan 156 µs、signature 55 µs、identity 8 µs，
合计约 **0.42 ms**。Node 空闲为零、Go 保存低于 1 ms；当前高价值优化仍在 renderer
请求量和 WebKit 生命周期，而不是把后端亚毫秒阶段继续微调。

### 2026-08-29（第四轮）：quiescent 被当成「杀掉工作」，而它只该是「不再开新工作」

第三轮修 prose 时看到的不是个案。共享活动门 `createRendererActivityGate` 在最后一次输入
后 **1 秒**进入 `quiescent`，而多个参与者把这个状态当成「停机」。逐个查完，同一个错配出现
在四处，全部集中在**用户停手的那一秒**——恰恰是这些工作本该完成的时刻。

**1. `writing-stats/controller.ts`：大文档字数扫描永远跑不完**

`canRunBackgroundWork()` 只认 `active`/`recently-active`；`setActivity("quiescent")` 会
`workEpoch++` + `cancelIdle()`。而全文扫描是 `requestIdleCallback` 分块的，大笔记需要远超
1 秒。于是「敲一段 → 停一下 → 再敲」的正常节奏里，扫描每轮都从零重启，**永远到不了终点**，
每轮的 CPU 全部白烧。分块本身已经用 `isInputPending()` 让路，quiescence 压制它换不到任何
响应性。改为只有 `hidden`/`destroyed` 才停。

**证伪**：新增护栏「a chunked large-document scan survives quiescence instead of restarting」，
在旧行为下 `expected 0 to be greater than 0`——quiescent 之后一个 idle 分块都不再排队。

**2. `measured-observer.ts` / `viewport-refresh.ts`：接线错配**

这两个参与者只实现了 `setPaused`，于是走活动门的兼容回退 `setPaused(isHidden || isQuiescent)`。
但它们的 pause 语义是给「宿主隐藏」设计的：`ViewMeasureScheduler.ensureFrame()` 在 paused 时
直接 return，`viewport-refresh` 把待办挪进 `pausedDirtyViews`——**都是攒着不做、等 resume 再冲**。
结果空闲 1 秒后 widget 高度重测全停：图片解码完成、KaTeX 渲染完成、Jupyter 输出到达都不会被
测量，CM6 高度图一直失准到用户下次敲键。在 Emacs xwidget 里表现为光标和滚动漂移。

修在接线处（`aaronnote/main.ts` 的 `hiddenSurfaceOnly`），不改这两个模块自身的语义。它们空闲
且静止时本来就不排帧，所以这不增加任何空闲开销。

**3. `updateTitle()`：每个按键 6 次 DOM 写 + 一次 IPC**

它在 `onChange` 里无条件跑。但同一篇笔记里只有 `document.title` 的脏标记 `*` 会变，另外 5 处
文本/属性写入是恒定的。写入相同字符串不是免费的——仍会替换文本节点并让布局失效，而在 xwidget
里每次重绘 Emacs 要用自己的 redisplay 再画一遍。全部加上读比较；`updateWindowState` 也按序列化
后的 key 去重，避免每个按键穿过 preload 边界（Emacs 下 `noemaDesktop` 不存在，直接短路）。

**4. prose-check**（第三轮已修，同一根因）。

#### 结论

`quiescent` 是调度状态，不是停机信号。真正省电的闸门是 `hidden`（宿主表面不可见），它仍然取消
一切。`focus-quiescence.ts` 的 `setQuiescent` 早已被改成 no-op，这轮把剩下三处对齐到同一结论。

**测试**：全量 **2117 passed**（此前 2110）。两条新护栏都做了证伪验证：还原旧实现后确实失败。

### 2026-08-29（第五轮）：Go kernel 路径审计 —— 热路径已经是干净的

把 Node host → Go kernel 的全部调用面过了一遍（`server/lib/kernel-*.mjs`，7 个 provider、
约 30 个端点），结论分两部分。

#### 打字热路径：无缺陷，固化成护栏

CM6 的每次保存走 `markdownFileProvider.writeChanges` → **单次** POST
`/api/noema/markdown/applyChanges`，请求体带 ChangeSet 和 `expectedVersion`，由 Go 侧做
唯一一次权威的 compare-and-swap。Node 侧**没有** read-before-write，也就没有在 Node 里
重建 read/compare/write 竞态。这正是它该有的样子，所以补一条护栏把「一次增量保存 = 一个
kernel 往返」和请求形状钉住（`tests/kernel-markdown-provider.test.ts`），避免以后有人为了
「先校验一下」把它变成两个往返。

连接复用也没问题：provider 只构造一次，用默认的 `globalThis.fetch`（undici 全局 agent，
默认 keep-alive）。

#### 找到的一处：`includeIndex` 路径把三件独立的事串起来等

`readNote(file, { includeIndex: true })` 里：

```js
Object.assign(payload, await notesIndexPayload());
payload.snippets = await scanSnippets();
payload.templates = await scanTemplates();
```

三者互不依赖——一个索引投影加两次目录扫描——却顺序 await，于是**新建笔记**和**改标签/元数据**
要付三次往返的和，而不是最慢那一次。`bootstrapNote` 早就因为同样的理由把 catalog 扫描和源码
读取重叠起来了。抽成 `attachNoteIndexPayload()` 用 `Promise.all`，三个调用点共用。

不在打字路径上，但是用户能直接感觉到的交互延迟。

**测试**：全量 **2118 passed**。

### 2026-08-29（第六轮）：把 quiescent 审计做完 —— 8 个参与者逐个过

第四轮只查了部分参与者就下了结论，这轮把 `createRendererActivityGate` 的全部 8 个参与者过完。
用一个判据分类：**quiescence 是在「扣住一件迟早必须发生的工作」，还是在「停掉一件本来就持续
进行的可选工作」？** 前者是 bug，后者是取舍。

| 参与者 | 判定 | 处理 |
|---|---|---|
| `focusQuiescence` | — | 早已是 no-op |
| `proseLifecycle` | 扣住 | 第三轮已修 |
| `writingStatsController` | 扣住 | 第四轮已修 |
| `measured-observer` / `viewport-refresh` | 扣住 | 第四轮改接线 |
| `assistScheduler` | **扣住** | 本轮修 |
| `graphOverlayActivity` | **扣住** | 本轮修 |
| `mathSnippetIndex` | **扣住** | 本轮修 |
| `localGraphPanel` | **扣住** | 本轮修 |
| `imageAnimation` | 取舍 | **保留不改**，见下 |

**`assistScheduler`** — 把一帧里合并的用户可见更新（片段弹窗、公式预览、光标工具、大纲）在
quiescent 时取消，并且 `schedule()` 在 quiescent 时直接不排帧。于是空闲期间发起的任何更新
（索引变更刷新大纲、滚动停稳、异步查询返回）都被扣到用户下次敲键才渲染。一帧不是动画链，
可见页面照样有帧；该停的是隐藏表面，`setPaused` 仍然管着。顺带删掉了因此变成死字段的 `quiescent`。

**`mathSnippetIndex`** — 和字数扫描完全同构：`IDLE_BUDGET_MS` 分块的全文数学命令扫描，在
quiescent 被 `generation++` + `cancelIdle` 杀掉。数学密集的大笔记（GraphTensor.md 那一类）
在「敲一段→停一下→再敲」的节奏里扫描永远到不了终点，于是**数学片段补全静默失效**，而 CPU
全花在被丢弃的重扫上。

**`graphOverlayActivity`** / **`localGraphPanel`** — 同样是「攒着等 resume」。图谱叠层的更新
本来就已经排进 `requestIdleCallback` 并在 `isInputPending()` 时自我延后，空闲正是它该跑的时候。

#### 一处审计后**决定不改**的

`imageAnimationActivityParticipant` 在 quiescent 时 `pauseImageAnimation`。按上面的判据它属于
第二类：动图没有「完成」这个概念，暂停它不扣住任何迟早要发生的工作，只改变可见行为。代价是
可见页面上的 GIF 会在停手 1 秒后冻结——从阅读者角度是缺陷；收益是动图不再持续烧 CPU/GPU，
而在 xwidget 里这个成本是双倍的。

考虑到本轮的首要诉求就是功耗，**保留现状**，只把这个取舍记在这里。如果要改，正确做法是做成
设置项，而不是把它当成上面那类 bug 顺手"修"掉。

**测试**：全量 **2118 passed**。`tests/assist-scheduler.test.ts` 里那条把旧语义固化下来的用例
已重写为守护正确语义，并补上「隐藏表面仍然是真正的闸门」。

**关于全量跑的抖动**：`drag-select-cost`（5 MB 夹具 p95 < 16 ms 的挂钟门限）和
`renderer-build-watch`（fs watcher）在 225 个文件并发下会偶发失败，两次跑出的是**不同**的用例。
两者单跑均稳定通过（drag-select 连跑 3 次全过），且 `drag-select-cost` 从不调用 `setActivity`，
控制器停在默认 `active` 状态，本轮改动只影响 `quiescent`，够不到它。

### 2026-08-29（第七轮）：反问 —— 让工作穿过 quiescent，是不是反而更耗电？

前几轮解开了 6 处 quiescence 压制。这必然引出一个反问：**空闲期间现在做的事变多了，空闲功耗
是不是升高了？** 之前只是断言「工作有限且去重」，这轮把它证明出来。

安全的前提是：解开之后跑的工作必须是**有限**的——跑完就停，页面回到真正的静止态。一个会自我
重排的调度器，或者跑完还挂着 rAF / idle 链的调度器，会把「空闲」变成持续绘制，而在 xwidget 里
每一帧要付两次（Emacs 用自己的 redisplay 再画一遍）。

新增 `tests/idle-rest-state.test.ts`，三个用例都在 **quiescent 状态下**把工作驱动到完成，然后
断言静止：

- **assistScheduler**：排一帧，跑完，`pending()` 为空——合并的 flags 被消费而不是重排。
- **writingStatsController**：大文档分块扫描跑完，`requestIdleCallback` 队列归零；再空转 60 秒
  不产生新的扫描。
- **proseLifecycle**：settled 检查跑一次；再空转 120 秒不重试、不轮询、不复查，且同 signature
  的 `scheduleAuto` 返回 `false`（去重生效）。

drain 循环带上限（100 帧 / 5000 idle 块）：一个自我重排的调度器会撞到上限，之后队列非空，断言
随即失败。所以这是真守得住的护栏，不是走过场。

**结论**：空闲期间多做的是**一次性收尾**，不是新增的常驻工作。做完之后页面比修复前更安静——
修复前那些被扣住的工作会在用户下次敲键时**重新开始**，反复烧 CPU 却永远不产出结果。

**测试**：全量 **2121 passed**（226 个文件）。

#### 一个未处理的测试套件稳定性问题（先记录，不擅自改）

`tests/drag-select-cost.test.ts` 的 `expect(p95).toBeLessThan(16)` 是**挂钟**阈值，在 226 文件
并发下会偶发失败（观测到 17.4 ms 和 24.7 ms）。单独跑连续 5 次全部通过。它**早于**本轮改动就
存在，而且该用例从不调用 `setActivity`，控制器停在默认 `active`，本轮只改 `quiescent` 分支，
结构上够不到它。

值得注意的是这个用例在同一次运行里已经测了 `minimalP95` / `sourceP95` / `languageP95` 三条基线。
并发负载会同比抬高所有配置，所以**相对基线**才是载荷无关的真信号，绝对值只是在空载机器上恰好
成立的代理指标。可行的修法是把断言改成相对基线的倍数上限（并保留绝对值作为空载时的附加检查）。

没有擅自改：放宽一条别人写的性能护栏的门限，应该由它的作者决定，而不是顺手改掉让自己的全量跑
变绿。

### 2026-08-29（第八轮）：每次按键都重建的共享 UI —— 图谱面板

用户在实机上定位到 Knowledge dock 即使折叠也每个输入帧重建 backlinks DOM。那条由另一个会话
在 dock 内部修。本轮查同一条链的**上游和兄弟**，确认这不是孤例。

`onChange` 每次按键都 `scheduleAssistUpdate({ toc: true })`，assist 帧里 `updateFloatingToc()`
同时驱动两个东西：

- **`floatingTocPanel.update()` —— 已经做对了**。折叠时第一行就 return；展开时用 `renderKey`
  签名去重；heading/anchor 缓存按不可变 `doc` 身份命中。这正是 dock 缺的那套，也是修 dock 时
  应该照抄的形状。
- **`localGraphPanel` —— 有缺陷，本轮修**。

#### 图谱面板：每敲一个字符一次完整 cytoscape 重排

两个问题叠在一起：

1. `dataSignature()` 把 `getMarkdownLength()` 折进签名。它是"文档变了"的代理，但**每个字符
   都会变**，而图谱真正画的东西（`markdownRefs()` 的链接、`currentRoamTags()` 的标签）只在
   写下 `[[链接]]` 或改 meta `tags:` 时才变。
2. 文档变更路径调的是 `localGraphPanel.update(true)`，`force` 把签名检查**整个跳过**。

于是图谱面板展开时，每个编辑停顿都做一次完整 `renderGraph()` + cytoscape 布局，产出和上一帧
完全相同的图。

**修复**：签名改成折入图谱**实际使用的派生值**（refs / tags），缓存在 memoized Markdown 字符串
的身份上，并与 `buildGraph` 共用——所以每个修订只扫一次，而不是每次渲染扫一次。文档变更路径
去掉 `force`（`onGraphVisible` 和 resize 路径保留：它们改布局而不改数据）。

净效果：一次全文扫描**取代**一次全文扫描加一次 cytoscape 布局，严格更省。

**证伪**：新增护栏「typing prose does not rebuild the graph; typing a link does」。还原成旧的
length 签名后失败并报 `expected 6 to be 1`——5 次普通按键产生了 5 次额外的完整重建。

#### 记一条约束

用户明确：**Emacs 和 app 维护同一套逻辑，不做单独适配**。这也解释了为什么这些问题在 Emacs 里
才暴露：Chromium 掩盖热路径浪费，xwidget 把它放大成卡顿——所以 xwidget 暴露出来的几乎总是
**共享层的真实缺陷**。本轮以及前几轮的修复全部落在共享模块，没有任何宿主分支。

**测试**：受影响的 7 个文件 41 passed。

**注**：`npx tsc` 目前在 `src/cm6/extensions/visual/typing-burst.ts` 报
`TS1294 erasableSyntaxOnly`——那是另一个会话正在写的新文件，不属于本轮改动，我没有动它。
