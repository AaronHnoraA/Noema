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
