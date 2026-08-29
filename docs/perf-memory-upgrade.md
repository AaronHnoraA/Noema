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

### 2026-08-29（第九轮）：Node 时代 vs Go 时代逐行对比 —— 一次按键保存的扇出被放大了 8 倍

第五轮审计看的是**请求形状**（一次增量保存 = 一个 kernel 往返），结论没错。这一轮看的是
**保存之后发生了什么**，那里藏着整条回归链。

先把测量摆正。空闲侧确实还是地板（60 秒采样：node +0.00、Go +0.03 cpu-s，idle wakeup
约 0.3 次/秒 vs node 的 0），和 2026-08-28 的结论一致，不用再碰。但"后端已经到顶"这个
推论只对**没有客户端连接**的空闲成立。把一个客户端接上、按真实节奏（每秒一次自动保存，
对应 650 ms 防抖后的打字停顿）打字，200 篇笔记 / 1.6 MB 的临时 vault：

| 一次按键保存 | 修复前 | 修复后 |
|---|---|---|
| Node host CPU | 73 ms | **6.0 ms** |
| Go kernel CPU | 25 ms | **8.8 ms** |
| `notes-index-changed` 广播 | 2 次 | 1 次 |
| 全量 catalog 重取 | 2 次 | **0.025 次**（40 次保存共 1 次）|
| 下行 JSON | 350 KB | **4.5 KB** |

复现方式在本节末。五个独立缺陷，全部是"Node 时代有、Go 接管后丢了"：

#### 1. 增量保存没登记 self-write，于是 watcher 把内核自己的写当成外部改动

`saveNote` 的整源路径走 `writeMarkdownFile`，它在内核写完后调 `noteSelfWrite(file)`；
**增量路径**（`markdownFileProvider.writeChanges`，也就是每次按键都走的那条）没有。Node
时代写文件和看文件是同一个进程，这条不变量自动成立；Go 接管持久化之后，Node 的
`fs.watch` 看到的是一个普通的外部修改，于是每次保存都被数两遍：一遍来自保存 handler，
一遍来自 watcher。两遍各自 `markNotesDirty` + 广播 + 调度 wiki 重建。

修复：`writeChanges` 成功后同样 `noteSelfWrite(file)`。

#### 2. `notesListPayload` 绕过了快照缓存

Go 路径直接 `kernelMarkdownProvider.catalog(force)`，**每次**都是一次全量 HTTP 取
+ JSON 解析。Node 时代它走 `scanNotes()`：干净时直接返回快照，脏时只重读
`dirtyNoteFiles` 里的那几个文件。

修复：`runtime.mjs` 新增 `kernelNoteCatalog(force)`，以 `notesIndexVersion` 为键做唯一的
memo（该计数器由所有宿主 mutation 和 vault watcher 递增，正是 catalog 唯一可能变化的两个
来源），`notesListPayload`、`primaryNoteIndexPayload`、`scanNotes` 三个入口共用。
`notes:list` 13.8 ms → 3.2 ms，`notes:index` 12.9 → 2.2，`notes:graph` 12.0 → 1.6。

#### 3. `mapNote` 每篇笔记做两次 `realpathSync`

CPU profile 里 `realpath` 占 Node host 全部非空闲时间的 **54%**，调用链是
`catalog → mapNote → pathFor → kernelBoxPath → canonicalExistingPath`：为了校验内核给的
路径没跑出 box，对 root 和 file 各做一次 `existsSync` 循环加 `realpath(3)` 全路径遍历，
200 篇 = 400 次 realpath，**每次 catalog 取都做一遍**。

修复：内核自己枚举出来的 box 相对路径改成**词法校验**（不含空段 / `.` / `..` / 反斜杠，
且扩展名是 markdown），这已经是同文件里 `mapVirtualMentionPath` 早就在用的规则——现在两处
共用 `kernelRelativeBoxPath`。宿主传入的路径（`owns`/`ownsPath`/`move`）继续做完整
canonicalize，那才是真正需要解符号链接的地方，而且每请求只调一次。

#### 4. 非 wiki vault 每次保存都重建 Node 侧的 wiki 索引，还 fork 两个 git

`scheduleWikiRefresh` 在防抖 350 ms 后**主动**跑 `buildWikiIndex`，只为让广播带上一个
没人读的 `noteCount`。而 legacy（非 wiki）布局的 `buildWikiIndex` **没有增量路径**：
`repositoryFileInventory` 重新 walk 并 stat 整个 vault，再 `git status --porcelain
--untracked-files=all`，`repositoryHeadSha` 再 `git rev-parse HEAD`——两个子进程，每次
保存。profile 里这一坨占 Node 主线程 22 ms/次保存，子进程的 fork/exec 系统时间在
profile 之外。

修复：`wikiIndexDirty` 本来就让下一个读者重建，所以主动重建纯粹是提前付账。改成
"立刻失效 + 广播，谁读谁重建"，并把 mutation 请求的 mode 交给真正提交重建的那次读取
（`coalesceWikiRefreshMode`）。代价：编辑后第一次搜索付这次重建——而它本来每次按键都在付。

#### 5. 内核侧：`updateMarkdownCatalogPath` 把整个 vault 的关系重解一遍

内核的 catalog 内部本来是增量的（按 path 替换 + `generation++`），但它同时
`noteOrdered = nil`，于是下一次 `markdownCatalogNotes` 会 `resolveMarkdownNoteRelationships`
重解全 vault 的 refs/backlinks、把每篇笔记克隆两遍、并重算 directories。这正是 Node 时代
`patchResolvedRelationships` 解决过的问题，Go 接管时没有跟上。

修复：把 Node 的算法移植成 `(*markdownBoxCatalog).patchMarkdownNoteRelationships`。
只要**全 vault 的 ref 索引不受影响**就走快路径——即笔记不是新增的、id 没变、可被引用的
值集合（id/key/title/path/link/source/file/aliases）没变；否则照旧整体失效。快路径里
只用未变的索引重解这一篇的 refs，并且只调整它**得到或失去**的那些目标的 backlinks。
顺带把响应前的多余深克隆去掉，并缓存 directories。

`BenchmarkMarkdownCatalogNotes`（`kernel/model/markdown_catalog_bench_test.go`）：

| vault | 改一篇后再读，修复前 | 修复后 |
|---|---|---|
| 200 篇 | 1.01 ms / 1.12 MB / 13.9k allocs | **0.106 ms / 0.26 MB / 1.1k allocs** |
| 1000 篇 | 5.76 ms / 5.83 MB / 69k allocs | **0.456 ms / 1.26 MB / 5.0k allocs** |

从 O(vault) 变成 O(1)。这一项在 200 篇的临时 vault 上只值 1 ms，在真实 vault 上是主项。

顺带修掉一个确定性 bug：`index` 原来在 `unique` **map** 上迭代来决定"同一个 canonical key
由谁认领"，Go 的随机 map 序意味着两篇同名笔记的 ref 解析结果在两次读取之间可能不同。
现在按 id 排序迭代（`markdownNoteRefIndex`），并被 patch 复用。

#### 6. 渲染端：自己的保存不该让自己重读整个 vault

剩下的那一次 `notes-index-changed` 是合法的，但触发它的客户端就是刚保存的那个，而
`reloadNotes()` 会重取 179 KB / 200 篇的 catalog 并重建索引状态——在 xwidget 里就是每个
打字停顿一次 JSON 解析加一次 GC。

修复：广播带上发起方 `clientId`（`note-saved` 早就带了），渲染端对**自己**引起的变更用
3 秒防抖（`SELF_NOTES_REFRESH_DELAY_MS`）而不是 500 ms；其他来源的变更节奏不变。连续打字
于是在停下之后刷新一次，而不是每次停顿刷一次。40 次保存的下行量 14.0 MB → 0.18 MB。

#### 复现

```sh
# 临时 vault + 隔离 workspace，绝不要指向真实 vault
NOEMA_ROOT=<tmp>/vault AARONNOTE_STATE_DIR=<tmp>/state \
NOEMA_KERNEL_WORKSPACE=<tmp>/ws/kernel-workspace NOEMA_KERNEL_CONFIG_DIR=<tmp>/ws/kernel-config \
AARONNOTE_WEB_PORT=39871 node web-host.mjs
```

然后：接一个 `/events` SSE 客户端并在 `notes-index-changed` 上重取 `notes:list`（模拟
渲染端），同时以 1000 ms 间隔发 `notes:save` 增量请求，用 `ps -o time=` 采样两个进程。
**间隔很关键**：500 ms 的间隔会被 wiki 防抖（350 ms）和渲染端防抖（500 ms）吞掉，
测出来假的低成本；真实打字的保存间隔 ≥650 ms，所以每一次都单独触发。
内核侧单独用 `go test ./model/ -bench BenchmarkMarkdownCatalogNotes`。

**测试**：全量 JS **2130 passed / 16 skipped**，`npx tsc` 干净，`go vet ./model/` 干净，
`go test ./model ./api ./treenode ./noema/...` 全绿。新增护栏
`kernel/model/markdown_catalog_patch_test.go`：patch 结果必须与全量重解逐字段相等
（含 refs 重定向、refs 删除、改标题、加别名），普通正文编辑必须真的走快路径（否则
"永远拒绝快路径"这种退化会静默通过），ref 索引必须稳定。

#### 陈旧 box：事件驱动关闭，不删除注册身份

这一项已经在下一轮处理：内核启动时做一次 reconciliation；运行中由根目录的 fsnotify
remove/rename/error，或一次真实 Markdown 访问发现 `ENOENT` 来触发。处理只把 shadow conf 的
`closed` 置为 `true`，停止 watcher，并通过现有 index queue 清投影；不删除 shadow、历史或外部
内容，也没有 ticker。最终复核时现存测试 vault 根目录均仍存在，因此没有被误关；无需也没有手工
清理任何 box。

### 2026-08-29（第十轮）：共享 CM6 输入稳定性、宿主边界与真正的静止态

这一轮把用户在 Emacs/xwidget 实机上看到的四类现象拆开验证：连续输入卡顿、源码/预览切换漂移、
Space/删除后的 viewport 回弹，以及真实空行和视觉空行冲突。修复仍然落在同一套 CM6 编辑器与
`runHostCommand` 语义里；App 和 Emacs 没有两份编辑逻辑。

#### 连续输入与视觉装饰

输入突发期间不再逐键拆建整批视觉 DOM：安全的 inline 变化只映射既有 decorations，停键后合并
刷新；换行、删除块边界等结构变化仍立即重算。这个策略由共享编辑器决定，宿主只报告能力，不复制
命令或渲染实现。所有视觉 widget 也统一进入有界的 measured-observer / viewport 刷新路径，避免
xwidget 把同一轮布局工作再放大一次。

#### 真实空行只有一个布局所有者

连续空行以前同时被文档 line block 和 visual blank placeholder 表示，造成两个高度来源争夺
scroll anchor：Enter 会抽搐，大段空行会出现异常空洞。现在每个 inactive blank run 只有一个
吸收间距的 owner，其余空行折叠；光标所在的真实空行始终保留为可编辑行，大段空行的视觉高度有界。
连续 Enter 使用同一个 viewport lease，最终只做一次 anchor 恢复。

真实 xwidget 探针连续发送 5 次浏览器原生 Enter（80 ms 间隔）：产生 5 个真实换行，
`activeBlankCount=1`、空行高度冲突 0、scroll backtrack 0。连续 120 字符（35 ms 间隔）的完整输入链
均值 24.583 ms/键。

#### 光标、源码/预览切换与整张键表

源码/预览切换保存 CM6 selection、preferred caret anchor 和 viewport lease，切回时按文档位置恢复，
不依赖旧 DOM 坐标。删除、Space、Enter、模式切换等共享命令都走同一套 focus/selection 提交顺序；
Emacs key adapter 只转发，整张映射表都做了契约测试，而不是给 `dd` 写例外。

Emacs 侧 xwidget 后的占位 buffer 维持 inert：不开插件、不接收逃逸输入；同步等待式 gateway 路径被
移出按键热路径。`C-g` 能解除的卡住仍作为 Emacs 主线程/xwidget 状态问题单独诊断，不能再用失焦
解释。

#### 启动 Git 同步才是剩余的非空闲功耗

采样实际进程树后发现，host 启动会在 2 秒后给所有已知仓库各排一次 wiki autosync，并 fork Git。
大仓库的 checkpoint 可持续一分钟以上；测量进程被终止时还会遗留待恢复 lease。这不是编辑器空闲
工作，而是共享 host 的启动策略。

`createWikiAutoSync` 现在保留 `syncOnStart` 能力，但 Noema 的共享 `web-host.mjs` 传
`syncOnStart:false`：本地写入事件、显式 `syncNow` 和每日周期同步仍在，启动不再无条件扫描全部
仓库。长 settle 后 30 秒实测 Node `0.00 cpu-s`、Go `0.01 cpu-s`，Git 子进程 0。

#### 陈旧外部 Markdown box 生命周期

缺失根目录按事件关闭的实现同时覆盖 App 与 Emacs workspace：启动一次检查，运行中依靠 fsnotify
和真实访问失败；去重 worker 在锁内重新 stat 当前绑定，避免仓库已经重新绑定后被旧事件误关。
写路径会明确返回根目录不可用，不会静默 `MkdirAll` 重建被删除的仓库。关闭只保留 registry shadow
并释放 watcher/index；没有轮询，也没有数据删除。

#### 最终验证

- 共享 CM6/xwidget focused：90/90；Emacs ERT：103/103。
- JS 全量：222 个文件通过、7 个跳过；2156 passed、16 skipped；TypeScript 构建干净。
- Go：`go vet ./...`，以及带 fts5 的 `model/api/treenode/noema` 全绿。
- `make test`、`make build`、`make install` 全部成功。
- 安装后的 `/Applications/Noema.app` smoke：`hostMode: "desktop"`、preload true、54 px 标题栏，
  Back / Forward / Refresh / Editor actions / Window actions 全部存在。
- Emacs `lisp/roam/Noema` 指向本仓库；snippets、templates、KaTeX macros 和 prose 词表全部解析到
  `resources/`，已退役的 `lisp/roam/aaronnote` 不存在。

### 2026-08-29（第十轮）：Node→Go 优化补齐清单，以及 git 水位设计的去向

第九轮修的是 Node 宿主侧的扇出。这一轮把 Node 实现里的**每一项优化**逐条对着 Go 内核过了一遍，
补齐缺的，并实测判断值不值得补。结论按"补了 / 不补 / 试了但退回"三类记。

#### 补了：catalog 冷构建是单线程的

Node 用 `mapLimit(files, scanConcurrency=16)` 并发扫 vault；Go 接管后变成
`for path := range catalog.docs` 的裸循环，冷启动时整个 vault 的 read+parse 全压在一个
goroutine 上。三处同形循环（notes / planning / properties）改成
`scanMarkdownDocPaths`（`markdown_catalog_scan.go`）：I/O 并发解析、结果按路径序返回，
调用方串行合并，所以 catalog 的 map 和持久索引缓存仍是单写者。`markdownSnapshots` 是
`sync.Map`，每个投影由 `sync.Once` 守，跨路径并发本来就安全；race detector 干净。

500 篇 vault：`cold-source` 23.4 → 20.2 ms，`restart-persistent` 10.3 → 9.9 ms。

**只有 ~15%，因为瓶颈不是解析而是元数据 syscall。** profile 里 `os.ReadFile` 占 49.5%
（其中 93% 是 `os.Open` 本身）、`os.Stat` 15.5%，解析只占十几个百分点。这些是内核态时间，
加 goroutine 并不能变快。基准跑在刚写完的 temp 目录上（page cache 全热），真实冷启动
（缓存冷、目录树大）并发能掩盖 I/O 延迟，收益应当更大——这一条是推理，没实测，因为
清 page cache 需要 sudo。

顺带把遍历顺序定死（`sortedMarkdownDocPaths`）：Go 的 map 序是随机的，冷构建中途出错会
留下不同的子集。

#### 补了：`Box.Unindex` 的裸 goroutine 会把内核带走

不是性能问题，但它挡住了整个 `go test ./model/`。`Box.Unindex` 起一个
fire-and-forget goroutine 调 `sql.FlushQueue()`，**没有 `defer logging.Recover()`**——
内核里其他每一个后台 goroutine 都有。而 `sql.beginTx` 直接 `db.Begin()`，`*sql.DB` 为 nil
时段错误。两者叠加：任何在 `InitDatabase` 之前/之后到达的 unindex 都会让**整个内核进程**
崩掉，而不只是这次 unindex 失败。

补了 `logging.Recover()` 和 `beginTx` 的 nil 判断。这是别的会话正在写的代码
（`external_markdown_box.go` 新增的 `box.Unindex()` 调用点触发的），我只动了这两处守卫。

**还留着一个 data race**（之前被段错误掩盖，加了 Recover 才显形）：
`TestMarkdownAccessToMissingExternalRootFailsAndSchedulesClose` 的 `Cleanup` 与
`Unindex` goroutine 里的 `ResetVirtualBlockRefCache()` 抢同一个全局。根因还是那个
不可 join 的 goroutine。怎么改是那份工作的主人决定，我没动。

#### 试了但退回：把索引在一次打字会话里合并

内核每次保存的 CPU 里，**约三分之二是 SQL 索引流水线**——活体 profile（45 次保存、60 KB
笔记）归因：`sql.FlushQueue → execOp → upsertTree` 42%、`indexMarkdownJob` 14%、
`sql.fromTree` 11%、`LoadMarkdownTreeByData` 10%，`runtime.cgocall`（就是 SQLite）单项 22%。
单次索引任务的实测成本（`BenchmarkMarkdownIndexJob`，保留在树里）：

| 笔记 | 一次索引 |
|---|---|
| 0.5 KB | 0.06 ms |
| 7.4 KB | 0.54 ms |
| 60 KB | **4.69 ms / 11.2 MB 分配** |

`markdownIndexDelay = 4ms` 只能合并**背靠背**的保存，而打字不是这个形状：自动保存在最后
一次按键后 650 ms 触发，所以每个打字停顿都单独跑一遍完整索引。于是做了个"打字保持窗口"：
同一文档在 2 s 内再次保存就按 800 ms 防抖延后，从首次入队起最多压 3 s。单元测试里它确实
工作——**8 次 650 ms 节奏的保存只跑 2 次索引**。

**但活体内核上它没有生效，而且稳定慢 8%**（60 KB 笔记、40 次保存 @1s，两两对照各跑 2–3 轮：
对照组 30.1 ms/save，开启后 33.0 ms/save）。开启后再抓 profile，`indexMarkdownJob` 的
cum% 不降反升（14% → 19%），证明合并根本没发生。

查到一条机制：`sql.RegisterPreFlushHook(WaitMarkdownIndex)` 让**每一次** `FlushQueue`
都成为屏障，而 SQL 队列的空闲消费者（`consumeQueueNotifications`，50 ms 防抖）也走
`FlushQueue`。于是链条闭环：索引任务 N → 写 SQL 队列 → 50 ms 后空闲 flush → pre-flush
钩子 `WaitMarkdownIndex` → 立刻抽干被压住的任务 N+1 → …… 两个队列互相把对方的合并窗口
取消掉。把空闲 flush 拆成不跑钩子的 `flushQueue`（读者用的 `FlushQueue`/`WaitFlushTx`
保留屏障）之后再测——**还是 33.0 ms/save，`indexMarkdownJob` 仍是 19%**。说明还有别的
路径在每次保存时抽干队列，我没找到。

所以两处改动都**退回了**：拿不到收益，却实测倒退 8%，还增加了"索引落后打字最多 3 秒"
的行为复杂度。保留的是证据：`BenchmarkMarkdownIndexJob` 和上面这段归因。

**下次要接着做的话**，先回答"活体内核里每次保存是谁抽干了 markdown 索引队列"——
`WaitMarkdownIndex` 的调用点只有 8 个（conf/backlink×3/markdown_doc/asset_content/path），
`FlushQueue` 的有二十几个；在 `WaitMarkdownIndex` 里打一行带 `logging.ShortStack()` 的日志
跑一次保存就能定位。合并这条路的天花板是 4×，值 ~20 ms/save（60 KB 笔记），是目前内核侧
最大的单项。

#### 不补：另外两处同形的串行循环

`markdown_workspace_projection.go` 和 `markdown_virtual_references.go` 的循环和上面三处
同形，但每条路径的判断要读 `catalog.notes` / `workspaceNotes` / `planning` 三张表并在同一
循环里写回，拆并发要更小心。鉴于并发本身只值 ~15%（瓶颈是 syscall），先不动。

#### 不补：基于 git 水位的增量设计——Go 里没有，而且基本是冗余的

**先回答问题：没进来。** Node 侧 `chooseWikiPersistence`（`wiki-workspace.mjs`）有一整套：

1. 每个仓库在索引时把 `head_sha` 记进 `repository_index_state`；
2. 下次构建跑 `git merge-base --is-ancestor 旧HEAD 新HEAD`，**不是祖先**（rebase / reset /
   切分支 / force pull）就强制全量重建；
3. `last_full_at` 水位 + 7 天间隔，定期全量自愈；
4. 仓库数量或 uid 变化 → 全量；schema 版本不符 → 全量。

Go 内核这边只有 `markdownIndexCache` 的 `Schema` 版本号和 root 路径校验，**没有 git 水位、
没有拓扑守卫、没有定期自愈**。

但 (1)(2) 在 Go 的设计里基本是冗余的，因为两边的失效粒度不同：Node 是**按仓库**判断整份索引
还能不能增量，所以需要一个粗粒度的"历史被改写了"信号；Go 是**按文件** `mtimeNs + size`
判断（`entry.matchesSource`），git checkout 一定会写新的 mtime，所以内容变化本来就会被逐个
文件抓到，连同目录重走带来的增删。真正漏掉的只有"内容变了但 mtime 和 size 都一模一样"，
git 不会产生这种情况（`cp -p` / `rsync --times` 才会）。

**唯一确实缺的是 (3) 定期全量自愈**：Go 的逐文件缓存一旦某条目悄悄错了，除非 bump schema，
否则永远错下去。但直接照搬 Node 的 7 天 ticker 违反 [[feedback-no-polling-loops]]。
Noema 形状的写法是：把上次全量构建的时间写进 `markdownIndexCache`，**在 box 首次打开时**
判断是否超期，超期就当作 schema 不符走全量——一次性判断，没有任何 timer。
要不要加、超期阈值多少，是行为和成本的取舍，等你定，没有擅自加。

**测试**：Go 全绿（model/api/sql/treenode/noema/... 全部 ok，catalog 相关 `-race` 干净），
JS 全量 **2156 passed / 16 skipped**。

### 2026-08-29（第十一轮）：为什么索引不是增量的——因为一篇笔记在索引里只有**一行**

第十轮里我试着"少跑几次索引"，方向就错了。正确的问题是用户问的那个：**这种东西不是增量维护
热更新吗?** 是的，应该是。查下去发现 Go 这边根本没有可增量的粒度。

#### 事实

`upsertTree`（`kernel/sql/upsert.go`）**看起来**是增量的：它比对新旧块哈希，只重写变化的块。
但对 Noema 的 markdown 笔记，这个机制完全空转。查活体数据库（200 篇 vault）：

```
blocks:  201 行，全部 type='d'，content 长度 6206 – 64095
spans:   0    assets: 0    attributes: 0    refs: 0
```

**一篇笔记 = 一行，content 是整篇文档。** 那篇 60 KB 的笔记就是一行 64095 字符的 `content`。
派生表全空。

原因在 `filesys.StripEphemeralMarkdownBlockIDs`：`util.NewLute()` 开着
`SetProtyleWYSIWYG(true)`，任何没有显式 `{: id=...}` 的块，lute 会现场发一个**每次解析都不同**
的 ID。这些 ID 不写回磁盘，下游若当真会让索引无限膨胀，所以 Noema 直接把它们清空。而
`fromTree` 里 `if "" == n.ID || !n.IsBlock() { continue }` —— 于是除了文档根，**没有任何块
进入索引**，spans/assets/attributes 挂在 `parentBlock.ID`（空串）上，一个也建不出来。

所以每次自动保存做的是：删掉那一行 64 KB 的 `blocks` 行和它的 `blocks_fts` 行，
再整篇重新插入、重新分词。块哈希短路永远命中不了，因为那个"块"就是整篇文档，一个字符都会变。

#### 代价

单次索引任务（`BenchmarkMarkdownIndexJob`）**随文档大小线性增长，约 78 µs/KB**：

| 笔记 | 一次索引 | 分配 |
|---|---|---|
| 0.5 KB | 0.06 ms | — |
| 7.4 KB | 0.54 ms | 1.4 MB |
| 60 KB | **4.69 ms** | **11.2 MB** |

活体内核归因（60 KB 笔记、45 次保存）：`FlushQueue → execOp → upsertTree` **42%**（就是这一行的
删+插+FTS 重新分词），`indexMarkdownJob` 14% + `fromTree` 11% + `LoadMarkdownTreeByData` 10%
（整篇重新解析）。单次索引任务自身的 micro-profile 里 **41% 是 GC**，来自那 11.2 MB。

#### 两半，性质不同

- **SQL 那一半（~42%）是可以修的。** 给 markdown 块**确定性的 projection ID**
  （Noema 已经有这套：`noemaidentity.ProjectionID` / `filesys.MarkdownProjectionID`，
  锚定块 `markdown_blocks.go:123` 就是这么发 ID 的），块就有了真实粒度，
  `upsertTree` 现成的哈希短路立刻生效：打一个字只重写那一个段落的行、只重新分词那一段，
  而不是 64 KB。粗估这一项能从 4.69 ms 降到几十微秒量级。
- **解析那一半（~25%）修不了**，除非换一个增量解析器。lute 每次都要整篇重解，CM6 已经把
  ChangeSet 发过来了但内核这边用不上。

#### 这是设计决定，没有擅自做

给 markdown 笔记加块级行会改变索引的**语义**，不只是性能：搜索结果会从"文档"变成"段落"、
块引用和反链的目标粒度、`blocks` 表规模（200 篇 → 从 201 行涨到上万行）都跟着变。
是不是想要，取决于 Noema 想让搜索返回什么。所以只报告，等你定。

另外注意 `StripEphemeralMarkdownBlockIDs` 的注释里写清楚了为什么不能直接留着 lute 的 ID
（不稳定 → 索引无限膨胀）；真要做，必须换成**确定性**的 ID，不能只是不 strip。

#### 顺带试了一下并退回：把 spans/assets/attributes 按块作用域化

在发现"派生表全空"之前，我先按块 ID 把这三张表的删+插缩到变化的块上（`refs` 保留全量重写，
因为 ref 行带的是**目标**的 box/path，可能因为别的文档移动而失效，不能用本文档的块哈希判断）。
改动本身是对的，对 `.sy` 文档有用——但 Noema 的 markdown 笔记这三张表是空的，**完全空转**。
不值得在核心索引函数里留这份复杂度，已退回。

**测试**：Go 全绿（sql/model 含 `-tags fts5`）。

### 2026-08-29（第十二轮）：块级增量索引 —— 一次按键从"重写整篇"变成"重写两行"

第十一轮查明了根因：一篇 markdown 笔记在索引里只有**一行**，content 是整篇文档，所以
`upsertTree` 现成的块哈希短路永远空转。这一轮把粒度做出来。

#### 做了什么

**1. 确定性块投影 ID**（`filesys/markdown_block_projection_ids.go`）

`AssignMarkdownBlockProjectionIDs` 在 `ApplyNoemaBlockProjection` 之后跑，给每个**顶层**块
一个从它自己内容派生的内存 key。锚定块保留 `{#uuid}` 给的规范投影不动。

内容派生（而不是按序号）是关键，因为它匹配编辑的真实形状：

- 在块里打字 → 只有这个块的 key 变 → 删一行插一行；
- 在别处插入/删除块 → 其余块内容没变、key 没变 → 一行都不动。按序号的方案会因为一次
  顶部插入而重编号整篇。

seed 里带 `tree.Path`：块的行携带 path，重命名必须让整篇失效，而带 `{#uuid}` 的文档
根 key 在移动时不变。

**2. ID 空间必须先加宽**（`noema/identity/block_projection.go`）

不能复用 `ProjectionID`：它的 14 位前缀是从规范身份派生的合成时间戳，而绝大多数 Noema
笔记没有 `{#uuid}`，前缀恒为 `20000101000000` —— 整个 key 只剩 28 bit 的十六进制后缀。
一个 key/文档够用，一个 key/块必然碰撞：10 万块的 vault 期望碰撞数 >18，而碰撞不是良性的
（`deleteBlocksByIDs` 会让一篇文档的保存删掉另一篇的行）。

所以两半都从摘要派生，后缀用 id 形状允许的全部小写字母数字（而非十六进制），在
`ast.IsNodeIDPattern` 要求的 22 字符里拿到约 68 bit。时间戳是日期形状的，`util.TimeFromID`
照常工作，但和 `ProjectionID` 的 `20000101000000` 一样，它是 key 的产物、**不是创建时间**。

**3. 让 `fromTree` 跳过未变的块**（这一步才是真正省下来的地方）

只有 ID 还不够：加了粒度之后单次索引反而从 4.69 ms 涨到 15 ms，因为
`buildBlockFromNode` 会把**每个**块渲染成 markdown（`ExportNodeStdMd`），300 个块就跑 300 次，
分配从 12 MB 涨到 26.7 MB，GC 占 36%。

利用一条性质：**内容派生的 ID 本身就是变更检测器**。ID 已经索引在这个 root 下 ⟹ 内容逐字节
相同 ⟹ 那一行是对的。于是 `upsertTree` 在调 `fromTree` 之前就能分类完
（`contentDerivedBlockState`），`fromTree` 对未变块直接 `ast.WalkSkipChildren`，整棵子树的
投影都省掉。`.sy` 文档的 ID 是持久的、不含内容信息，继续走原来的哈希比较
（`IsContentDerivedBlockIDFn` 注入判断，sql 不能 import filesys）。

**4. 拆掉为"没有粒度"而存在的两个补偿**

`buildBlockFromNode` 不再把整篇正文塞进根块；根块回到和 `.sy` 一样只带 title。
折叠聚合内容的那个根哈希特判也一并去掉——`NodeHash` 不含子块内容这件事现在是对的。

**5. 补一个会致命的泄漏**（`treenode/blocktree.go`）

`upsertBlockTree` 只 DELETE 它即将重插的 ID，**从不删消失的块**。文档是单行时 root ID 永不变，
看不出来；换成内容派生的块 key（编辑即更换）就会让 blocktree.db 无限膨胀——正是
`StripEphemeralMarkdownBlockIDs` 注释里警告的那个失败。现在按"旧行集 − 本次仍存在的 ID"
一并删除。

**6. 合成 ID 不许越过 API 边界**

`markdownBlockRefs` 过滤掉 `filesys.MarkdownIndexProjection` 的块。编辑器看到的仍然精确是
锚定块，Noema"只有真正被引用的块才带持久化 anchor、笔记字节保持 git-diff 干净"这条规则
完全不变——这些 key 从不落盘，和文档根 key 是同一类内部投影。

#### 实测

索引形状（200 篇合成 vault，实查数据库）：

| | 改前 | 改后 |
|---|---|---|
| 全库行数 | 201（全部 `type='d'`） | 6943（6241 段落 / 261 标题 / 201 文档 / 120 列表 / 60 公式 / 60 代码）|
| 那篇 60 KB 笔记 | **1 行 × 64095 字符** | **543 行，最宽 565 字符** |

成本（同一基准、同一台机器，baseline 从 HEAD 建独立 worktree 跑）：

| | baseline | 块级增量 | |
|---|---|---|---|
| 单次索引（改一个字，含 flush）0.5 KB | 0.78 ms | 0.61 ms | −22% |
| 同上 7.4 KB | 2.54 ms | 1.61 ms | −37% |
| 同上 60 KB | 15.2 ms | **11.0 ms** | −28% |
| 同上 60 KB 分配 | 22.8 MB | **17.0 MB** | −25% |
| 端到端每次保存内核 CPU（60 KB、40 次 @1s、全新 workspace）| 58.6 ms | **54.1 ms** | −8% |

活体 profile 里 `sql.FlushQueue → upsertTree` 已经**跌出热点前 14 名**（改前是 42%）。
端到端只有 −8% 是因为索引只是每次保存的一部分：现在最大的单项变成了同步路径上的
`markdownNoteFromSnapshot`（catalog 的 note summary，36.6%），那是下一个目标，和索引无关。

**注意一个测量陷阱**：早先我拿"30.1 ms/save"当基线得出"改完更慢了"的错误结论——那次用的是
**热 workspace**（之前的运行已经索引过），而新代码跑在全新 workspace 上。两边都必须用
全新 workspace 才可比。

#### 护栏

`kernel/model/markdown_index_incremental_fts5_test.go`：

- **改一个段落只能动 ≤8 行**（实测 202 行里动 2 行）——没有这条，退化会静默发生；
- 改后的文本必须能搜到、**旧文本必须搜不到**（只数行数的护栏会被"什么都不写"骗过）；
- 删掉一个段落，行数必须正好减一，且旧文本消失（防 blocktree/blocks 累积孤儿行）。

`kernel/model/markdown_index_job_bench_fts5_test.go` 的 `reindex` / `after-one-edit` 两档
是这条路径的常驻基准；**注意 `indexMarkdownJob` 只入队，SQL 重写在 `FlushQueue` 里**，
基准必须把 flush 算进去，否则量到的是解析而不是索引。

#### 还剩什么

整篇**解析**（`LoadMarkdownTreeByData`）仍是每次保存 O(文档)，lute 没有增量解析器，CM6 已经把
ChangeSet 送过来了但内核用不上。这是索引之外的另一半，短期无解。

`sort` 列对未变块会滞后（内容没变但序号变了时不重写）。Noema 的搜索走 `orderBy: 7` +
`method: 0`，走的是 rank 分支不读 `sort`，所以不影响；如果将来要按块序排序，需要重新考虑。

**测试**：Go 全绿（model/api/sql/treenode/filesys/noema，含 `-tags fts5` 与 `-race`），
JS 全量 **2156 passed / 16 skipped**。
