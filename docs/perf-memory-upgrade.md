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

#### 尚未处理

- `blockMathRanges` 每键仍是 O(全文围栏数) 的一趟遍历（5 MB/21.5k 围栏上约 3 ms）。
  要做到真正亚线性需把围栏索引换成 CM6 `RangeSet`（持久化 B 树，`map` 只触及变动
  子树），但那会改动所有消费者（`getBlockMathRanges` 的数组语义 + 二分查找）。
  在 40 KB 量级的真实笔记上整机已是 1.05 ms/键，收益递减，暂不做。
