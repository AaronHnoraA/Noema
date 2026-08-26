# 思源 → Noema：全量代码研判（值得 merge 的功能 / 特性 / 优化）

审计日期：2026-08-25

审计对象：迁移期 SiYuan v3.8.1 checkout + Noema fork 历史、主仓库 `kernel/`、Noema `src/` 与 `aaronnote/`

审计性质：原始报告是**只读研判**。从 2026-08-26 起，Aaron 要求继续沿本报告把值得吃的项目全部推进；实时进度仍只写入权威 `plan.md`，本文只在总排序中标记对应条目的收口状态。

与 `plan.md` 的关系：`plan.md` 是唯一权威的活进度记录，本文档不替代它。本文档问的是另一个问题——**路线图上没写、但躺在思源仓库里值得吃的东西是什么**。第六节列出三条与 `plan.md` 既有决策冲突、需要 Aaron 拍板的点。

## Context

`plan.md` 记录的进度已经很深，但那些都是**沿着既定路线**做的。这份报告问的是另一个问题：**思源仓库里还躺着什么，是路线图上没写、但真的值得吃的？**

**实现跟进（2026-08-26）**：审计 backlog 已按“迁入、用 Noema-native 实现覆盖、明确不采用”三种结论全部收口。#1 host-neutral platform/hotkey/DOM/transient seam、#2 b3/CLI、#3 Office list/AV width/image pause/标题编号/格式刷/Tree/Wiki/hint、#4 declarative menu、自包含 HTML/PDF、完整 AV 类型与计算、虚拟引用、Markdown attachment 维护与内容搜索、Obsidian Markdown-native 导入以及 MCP 均进入 canonical 源树和测试。workspace layout/dock 曾进入实验实现，但经 App/Emacs 单画布复审后从生产和源码移除：原生多窗口承担平铺，按需浮层承担工具 UI。版权来源固定在 `NOTICE` 与直接改编文件头；装饰性 covers、Pandoc bundle、protyle/mobile 和已裁剪云/同步/插件运行时明确不采用。正式门禁与移除上游 checkout 后的复验记录见本文末尾。

---

# 零、先确认两个结构性事实

这两条改变了「merge」这个词的含义。

## 事实 1：Go 内核不是"要搬进来"，而是**已经全量在仓库里躺着**

迁移期比对显示 canonical `kernel/` 与上游内核只差 54 个路径（一半是 `logging.log`）。**21.4 万行 Go 已经在 `main` 分支工作树里**，能编译、能跑。

Phase 0 的裁剪**也已经做完了**（fork 历史 `baeb38bfc`..`b3fb59d39`，74 个文件 / 30,609 行）：crypto 家族 ~5,400、`repository.go`(dejavu) 3,084、`publish_access*` ~3,600、sync 三件套 1,590、`oidc*` ~2,000、caldav/carddav/dav 1,620、`kernel/plugin/`(goja) ~6,900、`updater*` ~930、mobile+harmony 765。

**所以 Go 侧的"merge"不是搬代码，是"接上一个已经在树里、但没有任何 Noema 代码调用的休眠子系统"。** 成本模型完全不同——不是"移植"，是"适配 + 接线"。

休眠资产清单（按行数）：

| 休眠子系统 | 行数 | 现状 |
|---|---|---|
| `model/attribute_view*.go` + `kernel/av/` | **~23,000** | 完整数据库引擎 |
| `kernel/mcp/` | 12,292 | MCP server + client（含 OAuth） |
| `kernel/agent/` | 10,487 | AI agent runtime |
| `kernel/cli/` | 6,084 | **cobra CLI，进程内直调 model/sql，22 个子命令** |
| `model/export.go` | 4,723 | 导出管线 |
| `bazaar/` | 4,795 | 包管理（网络已阉割） |
| `model/import_obsidian.go` | 2,466 | **分阶段、可取消、带进度的 Obsidian vault 导入** |
| `heif/` | 5,086 | 纯 Go HEIC 解码（含手写 SIMD） |
| `model/history.go` + `history_diff.go` | 2,513 | 版本历史 + 结构化 diff（自带 FTS5 库） |
| `model/flashcard.go` + `conf/flashcard.go` | 1,497 | FSRS 间隔重复 |
| `model/assets.go` + `upload.go` + `asset_content.go` | 4,212 | 资源 GC + **PDF/Office 正文 FTS5 索引** |
| `model/embedding.go` | 807 | 向量检索（含退避/失败计数/ignore 语义） |
| `model/template.go` | 753 | Go template + sprig |
| `model/virutalref.go` | 365 | **虚拟引用（Aho-Corasick + ristretto TTL）** |

## 事实 2：前端**一行都没动过**

`app/src/` 在 fork 里是**原封不动的上游 v3.8.1**（Phase 0 只碰 `kernel/`）。Noema 只搬了 `app/appearance/`（字体 13M / 语言包 3.9M / emoji / icons / themes）和 `app/stage/auth.html`。

| | 行数 |
|---|---|
| 思源 `app/src/protyle/`（判死刑） | 85,771 |
| 思源 `app/src/layout/` | 24,691 |
| 思源 `app/src/asset/`（vendored PDF.js） | 24,091 |
| 思源 `app/src/config/` | 18,343 |
| 思源 SCSS（b3 设计系统） | 17,526 |
| 思源 `app/src/util/` + `menus/` | 17,750 |
| **Noema `src/` + `aaronnote/`** | **77,519** |
| Noema 全部 CSS | 11,610 |

`--b3-*` 变量：daylight 定义 **165 个**。Noema 代码里 `b3-` 出现 **0 次** —— plan.md 把 b3 设计系统列为"要吃到的"四件事之一，目前是四件里唯一一件**完全没开工**的。

### 前端耦合的真相（实测，不是估计）

`protyle/` 外部对 `protyle/*` 的 import 共 **~370 处**，但集中在**五个根本不是 contenteditable 的模块**上：

```
95  protyle/util/compatibility   (isMac/isWindows/剪贴板/localStorage/updateHotkeyTip)
62  protyle/util/hasClosest      (138 行 DOM 上溯helper)
26  protyle/util/selection
26  protyle/ui/hideElements      (96 行)
13  protyle/wysiwyg/getBlock     ← 真·protyle
13  protyle/util/onGet           ← 真·protyle
 8  protyle/util/hotKey          (199 行 matchHotKey)
```

**把这 ~1,400 行放错地方的工具文件从 `protyle/util/` 挪进一个中立的 `core/`，70% 的耦合就蒸发了。** 这是整份研判里最重要的一个可操作结论——它把"前端要不要吃思源"从"要不要吞 86k 行 protyle"变成了"要不要吞 4 个工具文件"。

---

# 一、Go 内核逐子系统判决

判决词：**接上** / **改造后接上** / **只当规格书** / **不要** / **已决定删**

## 1.1 `kernel/model/` — 203 文件 / 82,474 行

### A. 直接接上（可移植、无 `.sy` 耦合）

| 项 | 行数 | 做什么 | 判决 |
|---|---|---|---|
| `index_fix.go` | 543 | **五段式自愈索引修复**：去重库索引 → 重置文件系统重复块 → 按文件系统修 blocktree → 按 blocktree 修库 → 去重 refs。触发条件才是精华：空闲 ≥7 分钟 + dirty flag + 距上次 ≥120 分钟，用**非阻塞 `TryLock`** 保证 goroutine 不堆积，拿到锁后**再校验一次空闲**（`:135,140`）。空闲追踪在 `util/websocket.go:651-681`（`lastActivityNs atomic.Int64`），由 `Activity` 中间件打戳 | **接上。** 崩溃恢复/数据完整性，自己写一定写不到这个成熟度 |
| `virutalref.go` | 365 | **虚拟引用**：Aho-Corasick 多模式扫描全部块正文 vs 全部文档名/别名集合，结果进 ristretto、**TTL 10 分钟**，key = `boxID\x00rootID`，10 分钟 cron 预热 | **改造后接上。** 算法层可移植，渲染层是 protyle 的。这就是 org-roam 的 unlinked mentions，Noema 现在完全没有 |
| `asset_content.go` | 978 | **附件正文全文检索**：按扩展名分派 docconv(office)/pdfcpu(PDF)/epub/纯文本 提取器，写进**独立的 `asset_content.db` + 自己的 FTS5 表** | **接上。** "搜我 PDF 里的内容"，自带独立库，不污染主索引 |
| `session.go` | 534 | 中间件栈。**`ControlConcurrency`(`:481`) 是非显然的赢点**：白名单放行读类路径（`/api/search/`、`/api/query/`、以及末段以 `get`/`list`/`search`/`render`/`ls` 开头的 handler），其余全部走**按路由路径分桶的互斥锁**串行化（`:523-533`）。一屏代码搞定全局写串行。配 `util/session.go:62-113` 的指数退避认证限流 + 常量时间比较 | **接上** |
| `push_queue.go` + `push_reload.go` | 784 | 变更通知协议：`AppendPush*Entry` 追加，`PollPushQueue`(`:131`) **合并去重后**由消费者 goroutine 排空。这是 WebSocket 前面的防抖层 | **接上队列，事件名改掉** |
| `document_stat.go` + `filesys/stat.go` | 623 | 字数统计。可取消 context，可选跟进 embed 块；`filesys/stat.go` 里是真正的计数器，CJK 感知的 rune/word 计数 | **接上** |
| `storage.go` | 975 | 前端 localStorage、**保存的搜索条件 Criterion**(`:190`)、最近文档 MRU（open/view/close 三个时间戳）、大纲折叠状态、**`TouchRefUsed`/`GetRefUsed`(`:770,805`) 追踪"最近被引用过的块 ID"用于引用补全排序** | **接上** |
| `blockinfo.go` | 946 | 面包屑 `BuildBlockBreadcrumb`(`:623`)、分页子块 `GetBlockBreadcrumbChildren`(`:644`)、`GetBlockIndex`、`GetDocsInfo`(`:178` 批量取 N 篇文档信息，可选带引用数和 AV) | **接上**（`GetDOMText` 除外） |
| `tag.go` | 436 | `RemoveTag`/`RenameTag`(`:35,126`) **全库重写 `#tag#`**，要处理 textmark 内部的 span 而不只是纯文本 | **改造后接上。** 重命名标签是真正的正确性功能 |
| `process.go` | 141 | `HandleSignal` 优雅关闭；`HookDesktopUIProcJob` 每 30s ping 桌面宿主进程，UI 死了就退内核 | **接上**（Tauri 相关） |
| `conf.go` 的两段 | — | `Close()`(`:897`) 的**有序关机序列**（flush tx → 关库 → 存 conf → 退出码）；`GetMaskedConf`/`HideConfSecret`(`:1238`) 发给前端前**脱敏** | **接上这两段** |
| `box.go` | 994 | `ClearTempFiles`(`:718` 扫 12 个临时子目录，跳过进行中的 Obsidian 导入)、`VacuumDataIndex`(`:774` VACUUM 三个库并报告回收字节)、`FullReindex`、`ReindexFTS` | **接上** |
| `markdown_watcher*.go` + assets/themes/emojis 三套 watcher | ~500 | darwin FSEvents + 非 darwin 轮询兜底 | 已在用 |
| `template.go` | 753 | Go `text/template` + **sprig 全函数集** + 思源内置函数；`RenderGoTemplateAtInBox`(`:67`) 支持注入 `now`（可测试） | **改造后接上。** 引擎可移植，返回 `*parse.Tree` 那半截是 `.sy` 的 |
| `onboarding.go` | 198 | 首次运行建笔记本 | 可选 |
| `format.go` | 87 | `AutoSpace` 中英文之间自动补空格 | 可选，CJK 相关 |

### B. 混合（一半可移植，一半 `.sy`）

| 项 | 行数 | 拆法 |
|---|---|---|
| `file.go` | 3,039 | **接上**：`ResolveDocTreeSortMode`(`:402` 笔记本覆盖全局覆盖默认的三层解析)、`MoveDocs`(`:1735`) 配 `util/path.go:271,283` 的**防止把文档移进自己子孙**、`RenameDoc`(`:2186`) 级联 hPath 更新、`CreateDailyNote`(`:1474`)、`GetIDsByHPath`/`GetFullHPathByID`、手动排序。**不要**：`GetDoc`(`:695`，600 行，protyle 分页加载） |
| `block.go` | 1,864 | **接上**：`CheckBlockRef`(`:135`)、`CheckDocsRef`/`CheckNotebookRef`(`:269,294` "你要删的东西还有谁在指着它"）、`TransferBlockRef`/`SwapBlockRef`、`RecentUpdatedBlocks`。**不要**：heading transaction builders、`GetHeadingChildrenDOM` |
| `heading.go` + `listitem.go` + `heading_number.go` | 991 | **接上概念**：`Doc2Heading`/`Heading2Doc`(`:175,344` 标题↔独立文档互转，含子树搬迁 + 引用重写 + 路径记账)、`ListItem2Doc`。这在 Markdown 世界完全成立。事务管道那层是 `.sy` 的 |
| `export.go` | 4,723 | **接上**：pandoc/docx 管线、`ProcessPDF`(`:1577` 后处理 pdfcpu 输出注入书签大纲/页脚/水印)、include-subdocs / include-related-docs 的遍历、资源收集与路径重写、`ExportAv2CSV`。**不要**：`.sy`→Markdown 渲染器（源本来就是 Markdown） |
| `import.go` | 2,221 | `ImportFromLocalPath`(`:1125`) 走目录建树并下载/重定位资源；`HTML2Tree`(`:87`) 带数学检测 |
| `undolog.go` | 534 | **概念极好**：服务端 undo/redo，按 `rootID` 分栈，**跨文档条目按指针钉在每个受影响 root 的栈上**，撤销一边就从其他边移除引用（`:24-30`）。payload 是 `.sy` Operation。CM6 有本地 undo，但多窗口/agent 发起的编辑需要服务端日志 |
| `tree.go` | 454 | `LoadTreeByBlockIDWithReindex`(`:211`) —— blocktree 查不到就**自愈式重索引**再查。这个模式值得留 |

### C. 明确不要（protyle / `.sy` 事务绑定）

- `transaction.go`(2,630) —— `PerformTransactions` 分派 **~60 种 operation action**，每个 op 改内存 `*parse.Tree` 再整篇重写 `.sy`。**不要整体**；但 `FlushUpdateRefTextRenameDocJob`(`:2569`，3s cron，"文档改名 → 批量重写所有指向它的动态锚文本"）的**批量+防抖思路要留**
- `render.go`(591)、`block_update.go`(337)、`md2html.go`(60)、`api/lute.go`(395) —— 全部产出 protyle DOM
- `blockial.go`(548) —— IAL 属性批量设置；Noema 的对应物是 `{#UUIDv7 key=value}`，**改造**

### D. 已决定删的（但里面有零件）

| 已删 | 里面值得单独抠的零件 |
|---|---|
| `repository.go`(3,084, dejavu 快照) | **依赖 `github.com/siyuan-note/dejavu` 在 `go.mod:75` 声明但全仓库无 import —— 死依赖，可以直接删掉 go.mod 那行** |
| `history.go` + `history_diff.go`（**注意：这两个还没删**） | 值得单独看：(a) 亚分钟级自动存档粒度，git 给不了；(b) **历史记录自带 FTS5 库**（`history.db`/`histories_fts_case_insensitive`），能全文搜自己的历史；(c) `history_diff.go:147 DiffDocVersions` 结构化版本 diff；(d) `validateHistoryPath`(`:558`) 基于 `filepath.Rel` 的目录穿越防御。**判决：存储层用 git 取代，但这三样在做 git-log-backed 历史之前值得读一遍** |
| `crypto*.go`（加密笔记本） | `util/kdf.go`(246) 仍在：Argon2id + AES-GCM，`DeriveSubKey(dek, purpose)` 域分离子密钥、`EncryptWithAAD`。`filesys/crypto_hook.go`(185) 的 **DEK 租约**设计很讲究：整个文件操作期间持读锁，返回 DEK 的**副本**，release 时清零副本且**发布缓存后才解锁**；AAD 构造成 `siyuan:file:<boxID>:<basename>` **故意不含父目录**，这样 box 内移动能改名密文而不重新加密。**要不要加密笔记本是产品决策；这套实现本身是可以信任的** |
| `plugin/`(goja 沙箱) | 前端插件系统（§二）是**独立的**，不依赖这个被删的 Go 侧 goja runtime |
| `oidc*` / `publish_access*` / caldav / updater / sync | 无可救药的零件。`emersion/go-ical` + `go-vcard` + `go-webdav` 依赖没有活跃 importer 了，**可清 go.mod** |
| `mobile/` + `harmony/` | 无 |

### E. 尚未删、需要单独决策的

| 项 | 行数 | 判决 |
|---|---|---|
| `kernel/mcp/` | 12,292 | **接上（高价值）**。Noema 作为 MCP server 挂在 `/mcp`；37 个 tool（block/database/file/image/search/document/asset/inbox/skill/template/history/export/sql/web_fetch/web_search…）；外加 `mcp/client/`（1,040+793 行，含完整 OAuth flow + token store）作为 MCP **客户端**。传输层和 OAuth 层零 `.sy` 耦合。**对一个 Emacs + agent 工作流的用户，这是整棵树里最被低估的资产** |
| `kernel/agent/` | 10,487 | **零件式接**。整个 agent loop 未必要（Noema 已有 Copilot），但 `tokens.go`(337，tiktoken + **CJK ~1.5 字符/token 的字符级兜底估算**) 和 `compaction.go`(336，**按 provider 错误字符串识别上下文溢出** 再做带哈希/版本的摘要压缩) 是通用的 |
| `kernel/cli/` | 6,084 | **接上（高价值，被路线图完全遗漏）**。Cobra CLI，`main.go` 直接分派进去，**进程内直调 `model`/`sql`/`treenode`**，不走 HTTP。22 个子命令。`root.go` 的 `PersistentPostRunE` 处理了 CLI 没有 cron flush 的问题（命令跑完统一落库）。**对 Emacs 宿主这是天然接口——`noema-kernel search ...` 直接在 elisp 里调，不用起 HTTP** |
| `heif/` | 5,086 | **接上（低风险）**。纯 Go HEIC 解码，amd64/arm64/riscv64 手写 SIMD 色彩转换。`convert.go:26-39` 的安全模型很硬：`MaxInputBytes 32MB`、`maxDimension 65535`、桌面 5000 万像素上限、**显式内存预算**（16 字节/像素 vs 960MB 预算 + 96MB 输出保留）、`conversionSlots` 单槽并发限制。iPhone 照片直接可用，否则要 CGo |
| `bazaar/` | 4,795 | **只留 `local.go`(202)**：`ExtractLocalPackage`(`:48`) 是唯一无网络入口（侧载 .zip 主题/插件），加上 `package.go` 的 manifest 形状（`LocaleStrings` 多语言名称解析 + `MinAppVersion` 门禁）。其余**不要** |
| `model/flashcard.go` + riff | 1,497 | **可选接上**。FSRS 调度器是第三方库白拿；卡片只绑块 ID，自包含。三种复习模式 + 新/旧卡额度 + 校验层 |
| `model/embedding.go` | 807 | **接上（工程质量高）**。`block_embeddings` 表带 `fail_count`/`last_tried`/`ignored_type`；**指数退避 `30s << (failCount-1)` 封顶 30 分钟，8 次失败永久放弃**；`.siyuan/embeddingignore`（gitignore 语法）；`embeddingErrNotified atomic.Bool` 去重用户可见的错误提示；余弦相似度用 `unsafe` 做 byte→float32 重解释。**这套 schema 是第一次写一定会写错的东西** |
| `model/ai.go` / `ai_editor.go` / `rerank.go` | 698 | 与 Noema 的 Copilot 重叠，**低优先级** |
| `model/assets.go` 家族 | 4,212 | **接上（强烈）**。`UnusedAssets`/`MissingAssets`(`:1767,1932`) 全库引用分析、`RenameAsset`(`:1523`) 重写所有引用、`NetAssets2LocalAssets`(`:559`) 远程图片落本地、缩略图生成、`upload.go:519,590` 的**磁盘名↔原始名映射**（保住人类可读文件名又不踩文件系统雷）。**每个笔记应用都需要、且都做得太晚的东西** |
| `model/ocr.go` + `util/ocr.go` | 556 | Tesseract 子进程桥，带坐标的词框。**可选** |

## 1.2 `kernel/sql/` — 38 文件 / 12,249 行

**这是整份研判里"优化"密度最高的地方。**

- **Schema**：六张表，**全部无类型列**（SQLite 动态类型）。`blocks` 的 `fcontent` = "first-child content"，让容器块能被它第一个叶子的内容搜到。索引里两个是**启动时幂等惰性创建**而非写死在 schema：`idx_blocks_doc_hpath ON blocks(hpath) WHERE type='d'`（**部分索引**，`:1504`）和 `idx_refs_def_block_id`。
- **FTS5**：`blocks_fts` 是 **external-content 表**（`content='blocks'`），大部分列标 `UNINDEXED`，只分词 `hpath,name,alias,memo,tag,content,fcontent,ial`。
- **tokenizer 是硬约束**：`"siyuan"` tokenizer 是 **C 代码，在 fork 的 `github.com/88250/go-sqlite3` 里**（`go.mod:240 replace`），做 CJK bigram/unigram 分词 + OpenCC 繁简折叠。`:524` 的注释记了一个刀口：tokenizer 参数在 `CREATE VIRTUAL TABLE` 时冻结，改大小写/繁简敏感度**必须全量重建 FTS**。**这是整个代码库里最硬的一条"不能换 SQLite 驱动"的理由——换掉就丢中文搜索**
- **连接调参**（可直接抄的数字）：`WAL` + `synchronous=OFF` + `mmap_size=4GiB` + `cache_size=-128000`(128MB) + `page_size=32768` + `busy_timeout=7000` + `temp_store=MEMORY`；`MaxIdleConns/MaxOpenConns` 都是 20。**故意牺牲持久性——因为库是可重建的索引，不是真相源。** 这正好是 Noema 的立场
- **Schema 版本迁移**（`:110-161`）：`stat` 表存 `siyuan_database_ver`，不匹配就**整库删了重建**。但 `:131-142` 有个逃生舱：版本**匹配**时仍跑幂等增量迁移（`PRAGMA table_info` 检查后加列），**明确是为了让"加一列"不至于毁掉算得很贵的 embeddings**。⭐ **这个"不升版本号的加法式迁移"模式是这里最非显然的赢点**
- **写队列**（`queue.go`，624 行）：3 秒 ticker 排空。几个不寻常的行为：
  - **自适应 rename 合并**（`:227-249`）：若一个 `rename` 影响的路径前缀下 blocktree > 512 条，**故意 sleep `log2(count/512+1)` 秒**（钳在 1–12s），让更多 rename 攒进来一起合并
  - 超过 512 op 时**整段禁用缓存**（`:252`）
  - 每 128 个 op 调一次 `debug.FreeOSMemory()`（`:308-313`）—— 显式还内存给 OS
  - 循环内 `if util.IsExiting.Load() { return }` —— flush 中途也能协作式关机
  - `beginTx()` 遇到 "database is locked" **直接 `os.Exit(ExitCodeUnavailableDatabase)`** —— 快速失败而不是写坏
- ⭐ **崩溃恢复 WAL**（`index_queue.go`，326 行）：每个入队 op **同时**作为一行 JSON 追加到 `<QueueDir>/index.queue`，用 `gofrs/flock` **跨进程文件锁** + 进程内 mutex 保护。启动时 `recoverIndexQueue()`(`:237`) 重放上次没 flush 完的；`clearIndexQueue(snapshotSize)`(`:137`) **只截断到 flush 开始时快照的字节偏移**，所以 flush 期间追加的 op 不会丢。**这是给索引做的一套正经 WAL**
- **批量 upsert**（`upsert.go`）：每种表一条多 VALUES 的 `INSERT`，chunk 大小在 `init()`(`:41`) 里**按 SQLite 999 参数上限 ÷ 列数**算出来。`tx.Prepare` 在 commit **和** rollback 两条路径上都关闭
- `.siyuan/indexignore`（gitignore 语法）排除索引路径（`:547`）
- `stmt_validate.go`(258)：给用户可见的 `/api/query/sql` 做防注入。`tailIsOnlyWhitespaceOrSQLComments`(`:29`) **重新实现了 SQLite 自己的尾随分号解析规则**（行注释到 EOL/EOF、块注释含未闭合吞到 EOF），所以 `SELECT 1; DROP TABLE x` 被拒但 `SELECT 1; -- 注释` 放行
- `cache.go`(212)：块缓存带 `enableCache`/`disableCache` 开关 + **`id → key 集合`的二级索引**，因为 ristretto 不能枚举 key，按 ID 失效时得自己找到所有 box 变体
- ⚠️ **已知限制（`database.go:503-510` 的注释）**：Markdown box 把**整篇正文塞进文档根块**的 `content`/`markdown` FTS 列，因为惰性 IAL 让大多数段落没有稳定 ID。搜索精度从"哪一段"降到"哪一篇"。**这是当前 Noema 内核里活着的限制，plan.md §1.2 方案 B 的代价，值得标出来**

**判决：`sql/` 整体接上，且 `index_queue.go`、`queue.go` 的自适应合并、`database.go:131-142` 的加法式迁移这三处是"抄不到就自己踩坑"的东西。**

## 1.3 `kernel/search/` — 6 文件 / 1,154 行

- `mark.go`(184)：`EncloseHighlighting` 把关键词包成高亮；`compileHighlightingRegexp`(`:132`) 把所有关键词编成**一条 alternation 正则**，并**把每个 CJK 字符展开成字符类**来实现繁简不敏感
- `hanconv.go`(82) + `hanconv_table.go`(382)：OpenCC 繁→简表 + 自动构建的反向索引；`hanInsensitiveRegexp`(`:52`) 把 `"诗经"` 变成 `"[诗詩][经經]"`；`NormalizeSearchText` 同时注册为 SQLite 的 `search_normalize` 函数。⚠️ **`:48-50` 的注释是关键跨语言不变量：这张 Go 表必须和编进 C tokenizer 的那张字节一致，否则匹配和高亮会分叉。这条约束在别处没有任何文档**
- `find.go`(221)：`FindAllMatches` 用**首字节索引** `patternIndex map[byte][][]byte` 做流式多目标扫描，一遍扫完整棵树找 N 个字面量，不用正则

**判决：接上。搜索的查询解析其实不在这个包，在 `model/search.go`(3,445)——四种方法：0 纯文本 / 1 查询语法(FTS5 MATCH) / 2 SQL / 3 正则。摘要用 FTS5 自带 `snippet()`，且按列给不同窗口（hpath/name/content 用 512 字符，tag 用 64）。`FindReplace`(`:620`) 的全库替换处理了 textmark 各类型和"跨反斜杠转义的文本"(`replaceTextAcrossBackslashes`, `:753`)——真实的正确性边界。**

## 1.4 `kernel/treenode/` — 12 文件 / 3,522 行

- `blocktree.go`(1,217)：**第二个 SQLite 库**，一行一块，故意和 `siyuan.db` 分开以便独立重建。全批量 API；`execInsertBlocktrees`(`:812`) **只写变更过的节点**
- ⭐ `heading.go`(353)：**"标题是兄弟不是父节点"这个问题解对了一次**。`HeadingChildren`(`:213`) 算"这个标题下到下一个 ≤ 同级标题为止的一切"、`IsInFoldedHeading`、`FoldHeadingStack` 单遍遍历正确处理嵌套。**Markdown 有一模一样的问题，Noema 的 heading-fold 迟早撞上**
- `block_structure.go`(245)：容器合法性校验 `CanContainBlock` + **修复** `FixInvalidListChildren`(`:96`)、`normalizeOrderedListItems`(`:193`)
- `node.go`(570)：两字母块类型码（`d/h/p/l/i/c/m/t/b/s/av`）；`ParentNodesWithHeadings`(`:270`) 上溯时**穿过标题兄弟**；`RefreshUpdated`(`:554`) 沿祖先链传播 `updated`
- `tree.go`(200)：`NodeHash`(`:37`) 内容哈希用于变更检测；`CheckSpec`/`UpgradeSpec`(`:147-192`) **读时格式迁移阶梯**

**判决：接上。`heading.go` 是最高价值的单文件。**

## 1.5 `kernel/av/` — 32 文件 / 12,190 行 —— **和 Noema portable AV 的差距**

Noema 的 portable AV：`shared/attribute-view.mjs` 191 行 + `kernel/noema/attributeview/` 392 行 = **583 行**。思源：`kernel/av/` 12,190 + `model/attribute_view*.go` ~10,700 = **~23,000 行**。

| 能力 | 思源 | Noema portable |
|---|---|---|
| 字段类型 | **17 种**（block/text/number/date/select/mSelect/url/email/phone/mAsset/template/created/updated/checkbox/relation/rollup/lineNumber） | 无类型系统 |
| 过滤操作符 | **17 种** × 每种字段类型各自的正确性分支（`filter.go` 1,817 行就是因为相对日期 / 多选集合语义 / rollup-of-relation 每个都是独立 case） | 6 种（`=`/`!=`/contains/in/empty/not-empty） |
| 聚合 calc | **22 种**（Unique/Count 五变体/Percent 三变体/Sum/Average/Median/Min/Max/Range/Earliest/Latest/Checked/Unchecked/Percent checked 二变体/Template） | 无 |
| 分组 | 7 种方法（值/数值区间 start-end-step/相对日期/日/周/月/年）× 4 种排序（含"按 select 选项自身顺序"和手动） | kanban 按 group property |
| 布局 | table / gallery / kanban / card，统一在 `Collection`/`Field`/`Item` 接口后 | table / gallery / kanban |
| 关系 | **双向 relation 注册表**（按 box 持久化）+ **rollup 可用 Go template 聚合**（`calc_template.go` 暴露 `values/strings/raw/count/sum/avg/min/max/median/nonEmptyCount`） | 无 |
| 镜像 | 同一 AV 在多篇文档渲染（`mirror.go`） | 无 |
| 自愈 | `av_fix.go`(333) 孤儿值 / 缺失 key / 失效选项引用 | 无 |
| 缓存 | `cache/av.go` **版本号 + generation 计数器**，派生索引 O(1) 失效（`GetAVSearchDataInBox[T]` 泛型版本化 memo） | 无 |

**判决：Noema 自己重写 portable AV 是对的（思源把数据存 `data/storage/av/*.json`，与 Markdown 为真相源根本冲突）。但 `av/filter.go` 和 `av/calc.go` 应当当作 *规格书* 逐条读**——空值 vs 零值、相对日期窗口、多选集合语义，这些边界 583 行里一条都没覆盖。**这是全报告里"最值得吃但只能吃语义不能吃代码"的一项。**

## 1.6 `kernel/cache/` — 5 文件 / 761 行

四个缓存，三个用 `dgraph-io/ristretto`（TinyLFU 准入 + 成本淘汰）。共同技巧：**ristretto 不能枚举 key，所以每个缓存都自己维护一个 `rootID → key 集合` 的旁路索引**，才能按 ID 失效掉所有 box 变体。除 `virtualBlockRefCache`（10 分钟 TTL）外**全部显式失效，没有 TTL**。`cache/asset.go` 是普通 map 不是 ristretto（`path → *Asset` + `hash → path`）。**判决：接上。**

## 1.7 `kernel/task/` + `kernel/job/` — 542 行

- ⭐ **按 action + 参数深比较去重**（`task/queue.go:85,104`）：往队列里追加一个已经在排队的相同任务是 no-op。**这就是防抖机制本身**——542 行替掉一个调度器依赖
- `AppendTaskWithTimeout` 每任务超时；`AppendAsyncTaskWithDelay` 延迟调度；`ContainIndexTask()`(`:256`) 让其他子系统在索引进行中主动退让
- `job/cron.go` 用 25 行写完整个时间表。`every()` 启动时 `util.RandomSleep(50,200)` **去同步 goroutine 唤醒**，先立即跑一次再进 ticker，每次调用内 `defer logging.Recover()` 保证一个 job panic 不会杀掉 ticker

**判决：接上。**

## 1.8 `kernel/util/` — 90 文件 / 18,787 行

值得单独点名的（全部可移植）：

| 文件 | 行 | 关键内容 |
|---|---|---|
| `path.go` | 614 | ⭐ `IsSensitivePath`/`IsPartitionRootPath`（拒绝把工作区设在系统目录或卷根）、**`ResolveLongestExistingParent`(`:586`) 解析最深的已存在祖先，所以叶子还不存在时也能抓到 symlink 逃逸**、`FilterSelfChildDocs`、`TimeFromID`/`NodeIDByTime` |
| `file.go` | 494 | ⭐ 全是"不抄就要踩"的：`TruncateLenFileName`(`:343` 按字节预算截断且不切碎 rune)、`IsReservedFilename`(`:492` CON/PRN/AUX/NUL/COM1…)、`IsOfficeTempFile`(`:42` `~$` 锁文件——否则会污染 watcher)、`GetUniqueFilename`、`IsSymlinkPath` 家族、`GetMimeTypeByPath`(内容嗅探) |
| `runtime.go` | 617 | ⭐ **`CheckFileSysStatus`(`:325`) 周期性验证工作区可写并报致命 FS 错误**；⭐ **`IsCloudDrivePath`(`:437`) 拒绝把工作区放在 iCloud/OneDrive/Dropbox/Google Drive 上（真实的数据损坏来源）**，配 `icloud_darwin.go` |
| `misc.go` | 530 | ⭐ **`SanitizeSVG`(`:339`，~190 行 XML 级清洗**：script/foreignObject/事件处理器/外部引用，自带 121 行测试)、`SanitizeHTML`(bluemonday)、`GetDuplicateName`("foo" → "foo (2)") |
| `rune.go` | 112 | `ContainsCJK`、`RemoveEmojiInvisible`(剥 ZWJ/VS-16)、`RemoveInvalid`(剥非法 UTF-8 和控制字符) |
| `sort.go` | 133 | `NaturalCompare`("file10" 排在 "file9" 后)、`PinYinCompare`(CJK 拼音排序)、`EmojiPinYinCompare`(emoji 前缀按其后文本排)；12 种排序模式，`SortModeUnassigned = 256` 哨兵表示"继承笔记本设置" |
| `time.go` | 246 | `ISOWeek`/`ISOYear`/`ISOWeekDate`（ISO-8601 周日期算术，极易写错）、`HumanizeDiffTime`。**与 agenda/planning 直接相关** |
| `net.go` | 521 | ⭐ **`SSRFSafeDialer`(`:152`)** + `CheckHostSSRF`、`IsLocalOrigin`；以及一层泛型 JSON 参数提取 `ParseJsonArg[T]`/`BindJsonArg[T]` |
| `websocket.go` | 682 | 推送协议（`olahol/melody`）。按 **type + app id** 分桶；`BroadcastByTypeAndExcludeApp`(`:44`) 让发起方不收自己的回声；`HasDuplicateQueryValues`(`:193`) 拒绝参数走私；空闲/dirty 追踪在 `:651-681` |
| `working.go` | 684 | 工作区布局权威 + **启动进度状态机**（`IncBootProgress`/`SetBootDetails`），驱动 `/api/system/bootProgress` 的 SSE 变体 |
| `cmux.go` | 64 | ⭐ `:17-19` 的注释本身值这个文件：cmux 派生的 listener 内嵌根 listener，关一个就关全部，所以 HTTP 和 HTTPS **必须用两个独立的 `*http.Server`** |
| `pandoc.go` | 306 | `InitPandoc` 发现/解包 pandoc，`IsValidPandocBin`(`:232`) 在信任用户提供的路径前先验证 |
| `lute.go` | 166 | `MarkdownSettings`(`:29`) 是**唯一控制 Markdown 方言的地方**——round-trip 出问题就查这里 |
| `mmap.go` / `etag.go` / `kdf.go` / `cert.go` | 804 | mmap 写、分块哈希 etag、Argon2id+AES-GCM、自签 CA + 热重载证书管理器 |
| `skill.go` | 691 | 文件系统 skills 注册表（Claude Code 风格的 markdown 指令文件），`DiscoverSkills`/`InstallSkill(url)` |
| `font.go` 家族 | 1,112 | 系统字体枚举（darwin/windows/linux 各自实现）+ 用户字体安装 |
| `openai*.go` | 2,071 | 多 provider LLM 客户端（OpenAI/Gemini/通用），流式、多模态、tool call |

**死的**：`rhy.go`(b3log 更新检查)、`cloud.go`、`crypt.go`(硬编码 AES key，只用于配置混淆)、`working_mobile.go`。

## 1.9 `kernel/api/` — 87 文件 / 30,175 行 / 528 路由

中间件模式是**逐路由显式列举**而非 group：`ginServer.Handle("POST", "/api/…", model.CheckAuth, model.CheckAdminRole, model.CheckReadonly, handler)`。免鉴权路由集中在顶部注释块下。有 `deprecated` handler + 带日期的移除注释。

单独点名：

- ⭐ **`api/broadcast.go`(838)**：一个**同时支持 WebSocket 和 SSE 两种传输的通用 pub/sub 频道服务器**。`BroadcastChannel` 带订阅者计数、字符串/二进制广播、销毁；`EventSourceServer.Subscribe(c, retry, channels...)`；单调 `MessageID.Next()`；可配 SSE `retry:` 间隔；`Stream` helper 检测客户端断开。**完全 app-agnostic，是 CM6↔内核实时更新的好底座**
- `api/lute_wps_presentation.go`(968) + `lute_clipboard_math.go`(478) + `lute_wps_comment.go`(358)：剪贴板互操作（WPS/PowerPoint OOXML、OMML 数学、Word 批注）。⭐ 硬化得很到位：`maxArchiveEntries 256`、`maxUncompressed 32MB`、`maxXMLDepth 128` —— **zip 炸弹和 billion-laughs 防御的参考实现**
- `api/network.go`(625)：给前端用的出站 HTTP 代理，走 SSRF 检查

## 1.10 `kernel/server/` — 11 文件 / 3,050 行

`serve.go`(1,760) 里可直接抄的：
- `SetTrustedProxies(["127.0.0.1","::1"])` + `ForwardedByClientIP`
- ⭐ **gzip 带排除表**：已压缩媒体（`.pdf .mp3 .wav .ogg .mov .weba .mkv .mp4 .webm .flac`）+ heic/heif 正则排除
- ⭐ **静态文件不用 `gin.Static`**：`registerStaticFileHandlers`(`:521`) + `cleanStaticRelativePath` + `serveStaticFile`(`:548`) 做路径清洗 → 包含性检查 → **解析 symlink 后再次确认真实路径仍在根内**（`:605` 服务 `targetRealPath`）+ 可选的每请求 `accessCheck` 回调。**有 4 个专门的测试文件（`serve_assets_test.go` 298 行等）—— 这告诉你这里住过多少个 CVE**
- 端口选择：请求端口被占就绑 `:0`，再 `rewritePortJSON(pid, port)` 把真实端口写进以 pid 为键的 JSON，供桌面宿主发现
- `serveDebug` **仅在 `util.EnablePprof` 时**注册 pprof
- `server/proxy/fixedport.go`(78)：钉在 6806 的反向代理，让浏览器扩展有稳定端点

## 1.11 `kernel/conf/` — 37 文件 / 3,866 行

纯数据模型。值得点名：
- `conf/editor.go`(134)：50+ 字段。注意 `*bool`/`*int` 指针字段（`DatabaseAttrShow`/`FloatWindowDelay`/`BacklinkSort`）—— **故意做成三态，让"未设置"能和"false/0"区分开**，用于迁移
- ⭐ `conf/secrets.go`(217)：命名 secret 带**每 secret 的 `AllowedHosts`**(`:35`)，一个 token 只能发给指定 host。AI/MCP 配置按名字引用。**小而设计良好**
- `conf/box.go` 已被 Noema 扩展了 `Kind`/`Root`/`RepositoryID`
- `conf/layout.go`：`UILayout`/`Keymap` 是不透明的 `map[string]any` —— **内核从不解释 keymap，只负责持久化**
- 死的但仍反序列化（老 conf.json 兼容）：`publish.go`/`sync.go`/`repo.go`/`user.go`/`account.go`

## 1.12 `kernel/filesys/` — 16 文件 / 2,364 行

- `tree.go`：`DocIAL(absPath)`(`:341`) **流式读文件头只取文档 IAL，避免整篇解析**；`ValidateBoxRelativePath`(`:151`)；⭐ `removeUnescapedUnicodeNull`(`:529`) 只在前面有**偶数个反斜杠**（即真正未转义）时才删字面 `\\0` —— 真实的损坏修复边界
- ⭐ `markdown_ephemeral_ids.go`(61)：`:24-41` 的注释是这个 fork 里最重要的一条设计笔记（`util.NewLute()` 开 `SetProtyleWYSIWYG(true)` → lute 给每个无显式 IAL 的块现发随机 ID → 下游按非空 `n.ID` 当稳定块 → **每次重索引插一批新垃圾行，上一批 ID 对不上永远清不掉：索引无界增长**）。已解决
- ⭐ `markdown_orgenv.go`(114)：CommonMark 懒续行吞掉块终止符的陷阱，**只在前一行是列表项/列表续行时**插空行（`riskyPrecedingLine`, `:84`），**故意不对段落做**（过度插入会在干净文档里制造一次性 diff），还能自愈旧内核写坏的文件、跳过围栏代码块。**round-trip 保真工作的范本**
- 文件锁不在这里，在外部依赖 `github.com/siyuan-note/filelock`（**62 个文件 import**），提供路径→RWMutex 注册表 + 写临时文件后 rename 的原子写

## 1.13 `kernel/cli/` — 30 文件 / 6,084 行

见 §1.1E。`rejectEncryptedNotebookCLI`(`root.go:126`) 在存在加密笔记本时禁用 CLI（CLI 没有解锁路径）。**判决：接上（高价值，路线图遗漏）。**

## 1.14 依赖层面的清理机会

- `github.com/siyuan-note/dejavu`（`go.mod:75`）**已声明但全仓库零 import —— 死依赖可删**
- `emersion/go-ical` + `go-vcard` + `go-webdav`：caldav/carddav 删了之后**没找到活跃 importer，可删**
- `replace github.com/mattn/go-sqlite3 => github.com/88250/go-sqlite3`：**不能删**（CJK FTS5 tokenizer + SQLCipher）
- `replace github.com/pdfcpu/pdfcpu => github.com/88250/pdfcpu`：导出管线用的补丁版
- 仍活跃：`riff`(闪卡)、`filelock`(62 importer)、`ristretto`(全部缓存)、`ClarkThan/ahocorasick`(虚拟引用)、`Masterminds/sprig/v3`(模板+rollup)、`soheilhy/cmux`、`olahol/melody`、`gofrs/flock`、`edsrzf/mmap-go`、`sabhiram/go-gitignore`(indexignore + embeddingignore)、`dop251/goja_nodejs`、`araddon/dateparse`

---

# 二、前端逐子系统判决（app/src，protyle & mobile 之外）

## 2.1 ⭐⭐ `app/appearance/` + `app/src/assets/scss/` —— b3 设计系统

**最高价值、最低风险的一项。零 JS 耦合。**

| 层 | 文件数 | 行数 | 判决 |
|---|---|---|---|
| `component/`（去掉 typography） | 14 | **2,251** | ✅ 全要 |
| `component/_typography.scss` | 1 | 907 | ✅ 单独有用（Noema 的预览/导出） |
| `util/`（`_reset` 347 / `_function` 234 / `_responsive` 150 / `_keyframes` 72 / `_scroll` 20） | 6 | 831 | ✅ |
| `business/_layout` + `_resize` + `_search` + `main/_main` | 4 | 1,108 | ✅（配套 layout 引擎） |
| `business/_config.scss` | 1 | 1,192 | ✅（配套设置框架） |
| `protyle/` + `_av.scss` + `pdf/` + `pickr/` + `viewerjs/` | ~15 | ~7,500 | ❌ |

**CSS 变量**：daylight/midnight 各 165 个 `--b3-*`（两边变量集完全一致）。SCSS 里实际用到 141 个 / 1,368 处。其中 **76 个是通用 UI**（主题色、on-* 文本色、字体、边框/圆角、滚动条、list、menu、tooltip、mask、card、switch、阴影、过渡、高亮、select 箭头 SVG、toolbar），**89 个是领域专用**（protyle 行内样式、PDF 批注色 ×7×2、图谱节点/连线色 ×22、AV、callout、表格、字体前景/背景色板各 13）。

命名是 Material-3 风格：`--b3-theme-{primary,primary-light,primary-lighter,primary-lightest,secondary,background,surface,surface-light,surface-lighter,error,success}` + `--b3-theme-on-{…}`。几何：圆角 6/3/12px，`--b3-layout-space` 4px。动效：`--b3-transition: all .2s cubic-bezier(0,0,.2,1)`。`:root:lang(zh-CN|zh-TW|ja)` 重排 CJK 字体栈（`theme.css:227-238`）。

**组件覆盖**（每项都带完整变体）：

| 组件 | 行 | 变体 |
|---|---|---|
| `_list.scss` | 416 | `.b3-list` + `--background --border --empty`；子元素 `__toggle __icon __graphic __arrow __text __number __meta __action __switch __showall __hinttext __hinticon`；修饰 `--focus --narrow --big --two --hide-action` |
| `_menu.scss` | 590 | 三种模式（普通 / `--fullscreen` / `--sheet` / `--list`），完整 BEM 子元素 |
| `_form.scss` | 250 | `.b3-form`(`__icon __icon-input --inner --noborder`)、`.b3-label`、`.password-strength` |
| `_button.scss` | 184 | 15 个变体（`--outline --text --white --cancel --remove --icon --progress --small --mid --big --error --warning --success --info --pink`） |
| `_tooltips.scss` | 155 | `.tooltip` + `--error` |
| `_chip.scss` | 152 | **拖拽重排状态内建**（`--dragging --dragclone --insert-after --current`）+ 7 个语义色 |
| `_card.scss` / `_dialog.scss` / `_snackbar.scss` / `_switch.scss` / `_slider.scss` / `_select.scss` / `_text-field.scss` / `_svg.scss` | 653 | 各自完整 |

**工具类**：`.fn__`（flex/flex-1/flex-center/flex-column/none/hidden/block/space/hr/ellipsis/hidescrollbar/pointer/grab/rotate/loading/code/kbd/list/progress/size200/size96）和 `.ft__`（breakword smaller center on-background on-surface primary secondary success error pink selectnone）。⚠️ `util/_responsive.scss` **必须最后加载**（SCSS 特异性顺序，`base.scss:41`）。

**图标**：`appearance/icons/litheness/icon.js` 是一个 **102KB 的 JS 文件**，`insertAdjacentHTML` 塞进一个 `<svg style="position:absolute;width:0;height:0">`，内含 **255 个 `<symbol>`**，统一 `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"` —— 即 Lucide 风格描边集。用法 `<svg><use xlink:href="#iconFoo"></use></svg>`。第三方图标包叠在 litheness 之上，加载器会剪掉过期的 `<svg>` 根。

**App 外壳**：`src/assets/template/app/index.tpl` **只有 ~55 行 HTML**：`#loading` 启动图、`#toolbar`、`#dockLeft`/`#layouts`/`#dockRight`、`#status`、`#commonMenu`、`#message`、`#tooltip`。整个 chrome 就这些。

**判决：⭐⭐ 整包拿。** 具体包：两个 `theme.css`（可裁到 ~76 个通用变量 + 你要用的 graph/callout）+ `component/*`（去 typography，2,251 行）+ `util/*`（831 行）+ `_layout/_resize/_search/_main`（1,108 行）≈ **4,200 行 SCSS + 2 个 CSS + 1 个 102KB 图标 sprite**，换来完整的明暗设计系统、内建拖拽态的 chip、三模式菜单、15 种按钮。`_typography.scss`（907 行）单独对 Noema 的渲染输出有用。

## 2.2 ⭐ `app/src/layout/` —— dock / tab / 分屏引擎

64 文件 / 24,691 行，但**引擎很小**，大头是 dock 面板内容（AgentChat 4,147 / Files 2,154 / Backlink 1,506 / Outline 1,439 / graph 2,400）。

- 核心引擎：`index.ts`(128) + `Wnd.ts`(1,132) + `Tab.ts`(274) + `Model.ts`(~140) + `util.ts`(1,218) + `tabUtil.ts`(502) + `getAll.ts`(210) + `tabDrag.ts`(~50) = **3,632 行**
- Dock 引擎：`dock/index.ts`(1,051) + `dock/util.ts`(316) + hotkey/Custom/pluginDockState = **1,537 行**

**怎么工作的**：

- `Layout` 是递归分割节点 `{direction:"tb"|"lr", size, type:"normal"|"center"|"left"|"right"|"bottom", children:Array<Layout|Wnd>}`。尺寸纯 flexbox：`size==="auto"` → `.fn__flex-1`，否则内联 px
- `Wnd` 是叶子：一个 tab bar + 一个面板容器。`Wnd.split(direction, after)`(`:1024`) 分三种情况——与父同向就直接 `addWnd`；父只有一个子就改父的 `direction`；否则插一个中间 `Layout` 并把自己移进去。`Wnd.remove()`(`:1087`) 向上塌缩单子 layout 并把幸存者重新 flex-1
- `Tab`(`:53`) **干净得出奇**：一个 `<li>` 头 + 一个 `<div class="fn__flex-1">` 面板 + `addModel(model)`。唯一的 protyle import 是 `hasClosestByTag`
- ⭐ **`Model` 不是编辑器抽象，是 WebSocket 连接包装器**（3 秒退避重连，`Model.ts:88`）+ `mainMessageQueue` 缓冲直到 `isReady` + `parent: Tab`。子类：Editor / Asset / Search / Files / Outline / Backlink / Graph / Tag / Bookmark / Inbox / Custom / AgentChat
- **持久化**：`layoutToJSON()`(`util.ts:638`) 走树并按 `instance` 发判别联合；`JSONToLayout()`/`JSONToCenter()` 重建。两个巧思：(a) ⭐ **惰性 tab 水合**——非激活 tab 把自己的 model JSON 存在 header 的 `data-initdata` 属性上，只在首次 `switchTab` 时实例化（`Wnd.ts:561`, `util.ts:857`）；(b) `isSensitiveTab` 过滤，加密笔记本 tab 永不落盘
- ⭐ **拖拽 tab**：`dragstart` 把整个子树 JSON 序列化进 `dataTransfer`；tab bar 上 `dragover` 用占位克隆实时重排；**拖到面板体上用两条直线的半平面命中测试**（`isPointWithinLines` + `updateDragElement`, `Wnd.ts:471-506`）用斜率/截距对切出角落三角区，避免左边缘和上边缘区域打架。拖出窗口外会开新 Electron 窗口
- **Resize**：`addResize(obj)`(`util.ts:943`) 注入 `.layout__resize` 并驱动 mousemove，带最小尺寸钳制（普通 232px、有 graph/backlink/inbox 面板时 320px、底部 dock 64px、center 148px），**双击分隔条重置默认值**
- **Dock**：绑在三个固定 Layout 槽上，每个有上/下两组图标 + 一个 spacer。特性：**pin/unpin → 浮动模式**（hover 进出定时器）、手写 mousedown 拖拽在两条 rail 之间重排/移动图标（带幽灵元素和插入标记）、每 dock 独立 resize 手柄、插件 dock 及其位置持久化

**耦合**：64 个文件里 24 个提到 protyle，78 处 import。但真正的编辑器专用胶水只有 `Wnd.switchTab`/`removeTab` 里**约 60 行**，全部由 `instanceof Editor` 守卫；`layoutToJSON` 里一个 `Editor` 分支。Electron 在 5 个文件（开新窗口、跨窗口 tab 拖拽 IPC）。

**CM6 能当 Tab Model 吗？能，几乎是平凡的。** `Model` 就是"WebSocket + 父 Tab"，写 `class CMEditor extends Model`，`element = tab.panelElement`，`layoutToJSON` 加一个分支发 `{instance:"CMEditor", path, scrollTop}`，`JSONToCenter` 加一个分支 `new CMEditor(...)`。惰性 `data-initdata` 水合原样可用。那 60 行 `.editor.protyle` 胶水换成 `view.focus()` / `view.scrollDOM.scrollTop`。

**判决：⭐ 顶级候选。** ~5,200 行引擎换来 Zed/VSCode 级的分屏、拖拽分屏、带浮动模式的侧边 dock、JSON 布局持久化。Noema 现在的 Knowledge dock + Agenda workbench + doc browser 已经在往这个方向长，但是手写的、不能分屏、不能拖拽、不能持久化。

## 2.3 ⭐ `app/src/menus/` —— 菜单系统

20 文件 / 8,566 行，**核心只有 1,698 行**（`Menu.ts` 979 + `index.ts` 127 + `util.ts` 278 + `tab.ts` 283 + `dock.ts` 31）。其余是领域内容（`protyle.ts` 2,699 丢弃 / `navigation.ts` 1,253 / `commonMenuItem.ts` 1,039 / `workspace.ts` 668）。

声明式 `IMenu` 规格 20 个字段：`label`、`icon`/`iconHTML`/`iconClass`、`accelerator`（自动经 `updateHotkeyTip` 渲染）、`action`+`actionLabel`（右对齐的次级图标按钮）、`checked`、`current`、`type: separator|submenu|readonly|empty`、`disabled`、`warning`、`submenu`、⭐ **`loadSubmenu: () => Promise<IMenu[]>`（异步惰性子菜单，带加载占位和空态，`Menu.ts:731-760`）**、`bind(element)` 任意自定义行、`index` 有序插入、`id` 用于可见性过滤、`ignore` 条件跳过。

- ⭐ **自动分组**：`updateMenuItemGroupClasses`(`Menu.ts:17`) 扫子元素，给每段 separator 分隔的连续块的首尾打 `--group-first`/`--group-last`，CSS 就能给视觉分组切圆角。**且跳过 `fn__none` 隐藏项**，所以过滤后分组仍然正确
- ⭐ **定位**：`setPosition.ts`(66 行) 上下翻转 + 视口钳制 + 尊重 `getTopBarHeight()`，并有 **`sticky` 模式锁住底边或 x 坐标**，避免菜单变高时抖动
- ⭐ **完整键盘导航**（`bindMenuKeydown`, 144 行）：↑↓ 跳过 separator/readonly/零高度项；→ 打开**并惰性加载**子菜单并聚焦首项；← 退回父级；↩ 激活/聚焦内联输入框/点击内联开关；对含 `<input>` 的菜单行特殊处理（`ATTRIBUTE_MENU_KEYMAP`）避免打字劫持方向键
- 三种模式：普通、`--list`、`--fullscreen`（带 scrim）、`--sheet`（移动端底部抽屉，触摸下拉关闭）
- 全局分派：一个 `contextmenu` 监听从 `event.target` 上溯匹配 `data-type`（`tab-header`/`navigation-file`/`search-item`/`dock__item`/`textMenu`）。桌面端右键文本输入框会委托给 Electron 原生菜单
- 单个共享 DOM 节点 `#commonMenu` 复用于所有菜单

**耦合**：`Menu.ts` 只 import `compatibility`(热键提示)、`hasClosest`、`electronUndo`(2 行)、`entryVisibility/runtime`。**没有一个是 contenteditable。**

**判决：⭐ 顶级候选，整体拿。** `Menu.ts` + `MenuItem` + `subMenu` + `setPosition.ts` + `_menu.scss` ≈ **1,650 行**，只需要 `hasClosest`/`isMobile`/`updateHotkeyTip`/`escapeAttr`/`getTopBarHeight`。`loadSubmenu` 异步模式、分隔符自动分组、sticky 定位、完整方向键模型，这些都是"自己写三遍才对"的东西。

## 2.4 ✅ `app/src/dialog/` —— 对话框 / toast / tooltip

6 文件 / 1,184 行。

- `index.ts`(143)：scrim + 容器 + `resize__move` 标题栏 + body + **八个 resize 手柄**。⭐ 每对话框 `positionId` 把 left/top/width/height 存进 localStorage，**只在仍能装进视口时才恢复**；z-index 走全局计数器；`bindInput(el, enterEvent)` 带 **IME 组字守卫**和重复触发防抖
- `moveResize.ts`(157)：拖动 + 八向缩放，通用
- `message.ts`(137)：`showMessage(msg, timeout, type, id)` snackbar 栈，`timeout:0` = 手动关，`-1` = 永不关。⭐ **启动前兜底**：`#message` 还不存在时写进临时 div，`initMessage()` 再重放
- ⭐ `tooltip.ts`(160)：`data-position` 属性上的**小型放置 DSL**——`parentE`/`parentW`/`<n>west`/`<n>east`/`<n>north`/`<n>south`，`<n>` 是像素偏移。处理**多矩形锚点**（换行的行内元素）——挑光标下的那个矩形或最宽的；被裁剪时自动翻转并设 `maxHeight`；支持 `data-delay` 每元素悬停延迟；DOMPurify 消毒；发 `before-show-tooltip`/`before-hide-tooltip` 插件事件
- `processSystem.ts`(524)：思源内核专用进度层（bootSync/processSync/lockScreen/exitSiYuan…）

**判决：✅ 拿 `index.ts` + `moveResize.ts` + `message.ts` + `confirmDialog.ts` + `tooltip.ts` ≈ 660 行。** `data-position` tooltip DSL 单独就值——app 里每个图标都在用，Noema 的 dock/agenda 需要同样的东西。`processSystem.ts` 只当参考。

## 2.5 ✅ `app/src/search/` —— 全局搜索 UI

10 文件 / 3,863 行。`genSearch()` 用一个 ~150 行的模板字符串生成整个面板。

**面板结构**：顶部图标条（上/下一个命中、命中计数、当前路径 chip 带 ✕ 清除、含子文档开关、路径选择、更多菜单、在 tab 中打开、**列出失效引用的块**、**搜索附件正文**）→ 查询行（输入框 + 历史下拉 `⌥↓` + 块类型过滤 + **搜索方法指示器** + 替换开关 + 刷新 + 展开/折叠全部分组）→ 替换行（自己的历史 + 替换类型过滤）→ ⭐ **Criteria 条**（服务端保存的具名查询条件集，以 chip 形式切换）→ 分栏视图（结果 list + 可拖分隔条 + 预览）→ 底部**键盘提示条**。同容器里还有两个兄弟面板：`#searchAssets`（附件正文搜索）和 `#searchUnRefPanel`（悬空引用块）。

**暴露的查询语法**：`method` 0 关键词 / 1 查询语法（FTS5 MATCH：AND/OR/NOT/NEAR/引号短语/前缀 `*`）/ 2 原始 SQL / 3 正则 / 4 语义检索（仅在 embedding 启用时显示）。排序 0–7（块类型、创建↑↓、更新↑↓、正文顺序、相关度↑↓），分组 0 平铺 / 1 按文档。类型过滤 18 种块类型 + **子类型过滤** h1–h6 和有序/无序/任务列表。

**可偷的工程**：
- ⭐ `request.ts`(106)：**带 `AbortController` + 单调递增 `version` + 单槽 `queued` 任务 + `onIdle` 钩子的每元素请求调度器**。这正是"输入即搜索不打架"的原语
- `toggleHistory.ts`(253)：搜索/替换/附件历史下拉，去重 + `⌥↓`
- `util/upDownHint.ts`(232)：⭐ **通用列表键盘导航**（`upDownHint`/`UDLRHint`），跳过零高度/错类的行并滚动到可见。搜索、命令面板、emoji 选择器、文件树全在用
- `menu.ts:411 saveCriterion`：持久化具名搜索

**耦合**：硬依赖只有**预览面板是一个 `Protyle` 实例**。预览之上的一切（工具栏、过滤、criteria、历史、请求调度、键盘导航、分栏拖动）都与预览无关。

**判决：✅ 拿外壳，换预览。** ~1,200 行 + `_search.scss`(187) 干净迁移；两个 `new Protyle(...)` 预览换成 CM6 只读视图，`getArticle` 的块 DOM 渲染换成 markdown 片段渲染。**`request.ts` 和 `upDownHint.ts` 无论如何都该立刻拿走。**

## 2.6 ✅ `app/src/config/` —— 设置 UI

73 文件 / 18,343 行。**这个 fork 有一套正经的设置框架**，不是上游那种手写 HTML tab。

- `setting/builder.ts`(535)：`SettingBuilder` DSL。两种 tab：`setting.tab({id,icon,title,defaultSave}, register)` 注册表渲染 / `setting.panel({id,icon,title,searchStrings,mount})` 手动挂载。控件规格：`switch`、`number`(min/max/step/unit)、`range`、`select`、`text`(input-text/password/textarea)、`slot`(裸 HTML + afterMount)、`composite`、`switchQuery`、`textPair`、`stack`。每控件可选 `save`/`readConfig`/`afterMount`/`searchAvailability`
- `setting/{control,item,group,mount,domIO,save,tabs}.ts`：⭐ **委托式保存**（`bindSettingSaveDelegation`），没有每字段监听器
- ⭐ `search/{dialog,scan,normalize}.ts`：**设置内搜索**——每个 tab 声明 `searchStrings()`，`scanSettingTabSearch` 建索引，输入时**跨 tab 过滤并自动切到匹配的 tab**
- `entryVisibility/`(1,016 行目录 + 741 行 UI + 3 个测试)：**全 app 菜单条目的目录**，带 simple/advanced 标记，用户可隐藏和重排菜单项；`runtime.applyMenuEntryVisibility()` 从 `Menu.ts:51` 调用
- ⭐ **Keymap 编辑器**（`tabs/keymapUi.ts`, 676）：每行 = 标签 + 渲染后的按键 + 一个隐藏的 `<input inputmode="none">` 捕获下一个组合键。**两个搜索框：文本搜索 + 按键反查（按一个组合键，看它绑了什么）**。工具栏有 Refresh 和 Reset。强制 `isReservedKeymap`/`isDisallowedTextInputHotkey` 策略。桌面端边编辑边注册/注销 Electron 全局快捷键
- ⭐ **主题切换**（`util/assets.ts loadAssets`, 497）：设 `<html data-theme-mode|data-light-theme|data-dark-theme|data-frontend|data-backend|lang>`，换 `#themeDefaultStyle` 时**先插入新 `<link>`，等 `onload` 之后才移除旧的**——避免闪烁；`modeOS` 时跟随系统 `prefers-color-scheme`；加载 `theme.js`；加载图标 sprite。`setInlineStyle()`(`:272`) 写一个计算出的 `<style>` 控制字体/字号/行距
- **Snippets 编辑器**（`config/util/snippets.ts`, 273）：按 id 注入 `<style id="snippetCSS{id}">`/`<script id="snippetJS{id}">`，**按 `textContent` 差异比对**，未变的不重新注入。启动时带超时地 await 它，**在构建布局之前**，这样用户 CSS 先生效再测量布局

**判决：✅ 拿框架（`setting/` + `render/` + `search/` ≈ 1,600 行）+ keymap 编辑器（676）+ `util/assets.ts` 主题加载（497）。** 面板本身（都是思源的配置形状）和 `bazaar.ts` 跳过。`entryVisibility` 目录很惊艳但是思源菜单专用——**拿模式，不拿那 1,016 行目录**。

## 2.7 ⚠️ `app/src/boot/` —— 启动与全局事件

14 文件 / 4,863 行。

- `onGetConfig.ts`(415)：启动编排。顺序值得注意：Electron 初始化 + 缩放 + 交通灯位置 → `ensureUILayout()` → `initWindowEvent` → `renderSnippet(超时)`（promise）→ ⭐ **await snippets，然后才 `JSONToLayout()`**（用户 CSS 先生效再测量布局），且 `try/catch → resetLayout()` 兜底 → 全局快捷键 → 顶栏 → 状态栏 → 外观 → 防抖 resize 处理器
- `globalEvent/event.ts`(315)：⭐ **一个地方安装所有 window 监听器**。含鼠标 3/4 键 → 前进/后退；blur/focus 清理粘住的修饰键标志并暂停 GIF；**长按 → 合成 `contextmenu`**（带 `isLastPointerMouse()` 守卫避免慢速鼠标点击误触）
- `globalEvent/keydown.ts`(1,897)：**90 处 `matchHotKey` 调用**。一半是编辑器命令
- ⭐ `globalEvent/command/panel.ts`(502)：**命令面板**（`⌥⇧P`）——Dialog + 搜索框 + `b3-list` + kbd 提示条，枚举 keymap 里的通用命令（按平台白名单）+ 插件命令，实时过滤，`upDownHint` 方向键
- `globalEvent/dragover.ts`(82)：⭐ rAF 驱动的**拖拽边缘自动滚动**

**判决：⚠️ 拿模式 + 挑文件。** 拿 `command/panel.ts`（命令面板 ~500 行，只需 Dialog + upDownHint + 热键提示）、`dragover.ts`、以及 `event.ts` 的**结构**（一个函数拥有全部 window 监听器）。**重写 `keydown.ts`**——1,900 行 90 处 keymap 查找不值得移植；复用 `matchHotKey` + `SIYUAN_KEYMAP` 的形状，自己写一个紧凑分派器。

## 2.8 ✅ `app/src/util/` —— 杂物间

55 文件 / 9,184 行（含 12 个 `.test.ts`）。该拿的：

| 文件 | 行 | 内容 |
|---|---|---|
| `Tree.ts` | 365 | ⭐ **通用可折叠树控件**（基于 `b3-list`）：折叠箭头、`blockExtHTML`/`topExtHTML` 插槽、click/ctrlClick/altClick/shiftClick/toggleClick/rightClick 处理器、拖拽钩子、标签里渲染 emoji 和数学、`ariaLabel` tooltip。Outline/Backlink/Tag/Bookmark 全在用 |
| `upDownHint.ts` | 232 | 见 §2.5 |
| `backForward.ts` | 345 | 导航历史栈（`goBack/goForward/pushBack`），鼠标 3/4 键 + `⌘[`/`⌘]` |
| `touchDragBridge.ts` | 560 | ⭐ **从触摸事件合成鼠标拖拽事件**，让所有 mousedown/mousemove 拖拽代码在平板上直接可用。自包含 |
| `setPosition.ts` | 66 | 见 §2.3 |
| `fetch.ts` | 156 | `fetchPost/fetchSyncPost/fetchGet` 统一错误 toast + `AbortSignal` |
| `hotKeyPolicy.ts` | 64 | 保留键集合（`⌘A ⌘X ⌘C ⌘V ⌘/ ⌫ Escape…`）、`isDisallowedTextInputHotkey`（裸可打印字符）、插件热键规范化 |
| `heightAnimation.ts` | 83 | `expandHeight`/`collapseHeight` 带**活动注册表**，重叠动画能干净取消 |
| `escape.ts` / `functions.ts` / `addClearButton.ts` / `customFont.ts` / `imageURL.ts` | 494 | 各种小工具 |

**i18n**：`util/` 里**没有 i18n 模块**——就是 `window.siyuan.languages.<key>`，启动时从 `appearance/langs/<lang>.json` 注入。**`en.json` 2,136 键 / 153KB，21 种语言。没有 ICU、没有复数规则、没有构建步骤。** 唯一的"格式化"是 `updateHotkeyTip` 把 `⌘⇧⌥⌃` 字形在非 Mac 上转成 `Ctrl+Shift+Alt+`。

**判决：✅ 挑 ~1,500 行。** `touchDragBridge.ts` 仅在 Noema 要支持平板时。

## 2.9 ⭐ `app/src/plugin/` —— 插件 API

12 文件 / 2,185 行。

- **加载**（`loader.ts`, 300）：`POST /api/petal/loadPetals` 返回 `[{name, displayName, js, css, i18n}]`。⭐ 每个用 `window.eval("(function anonymous(require, module, exports){…})\n//# sourceURL=plugin:<name>")` 执行 —— **`sourceURL` 让插件栈帧可调试**。`require` 被 shim：`"siyuan"` → `API` 对象，其余落回 Electron 的 `window.require`。CSS 注进共享 `#pluginsStyle`。`onload()` 被 await（首次启动时 fire-and-forget 以加快启动）
- ⭐ **EventBus**（`EventBus.ts`, 55 行）：**优雅得离谱**——`document.appendChild(document.createComment(name))` 当 `EventTarget`，然后 `on/once/off/emit` 走 `CustomEvent`。**34 种事件类型**。`emitOpenMenu()`(`:27`) 是协作 helper：把 `subMenu` 递给每个插件，收集条目，最后追加一个"Plugin ▸"子菜单
- **插件面**：`i18n/eventBus/kernel/data/setting/commands/models/docks/topBarIcons/statusBarIcons/protyleSlash/customBlockRenders/agentCapabilities/protyleOptions`。方法：`onload/onunload/uninstall/onLayoutReady/onDataChanged`、`addCommand`（含 keymap 注册 + Electron 全局快捷键）、`addIcons(svg)`、`addTopBar`、`addStatusBar`、`addTab`（→ Tab 里的 `Custom` Model）、`addDock`、`addFloatLayer`、`loadData/saveData/removeData`（文件在 `/data/storage/petal/<name>/`，路径消毒）、`getSecret`/`getVariable`（从设置的 secrets 保险库）、⭐ `addAgentCapability`（fork 特有：注册一个 LLM 可调用的前端工具，带 JSON schema + effects）
- `Setting.ts`(104)：基于 Dialog 的表单构建器；`Menu.ts`(117)：包核心 Menu，带 `independent` 模式克隆 `#commonMenu` 成独立节点

**耦合**：`EventBus.ts` = 0，`Setting.ts` = 0，`Menu.ts` = 0，`loader.ts` = 1，`kernel.ts` = 0。protyle 相关的部分（`Protyle` 重导出、`protyleSlash`、`updateProtyleToolbar`、`customBlockRenders`、`addFloatLayer`）都是**可移除的字段，不是结构**。

**判决：⭐ 拿。** ~900 行无 protyle 代码给 Noema 一套完整插件系统。⚠️ **但注意 plan.md 明确写过"插件运行时 + roamlookup：移除；Copilot 是内建"——所以这项与既有决策冲突，需要 Aaron 重新判。** 我的看法：Go 侧的 goja 沙箱插件（已删）和这套前端插件是两回事；前端这套本质是"用户脚本 + 事件总线 + dock/tab 注册"，成本 900 行，和"移除插件运行时"的理由（安全沙箱复杂度）并不冲突。

## 2.10 其余目录

| 目录 | 行数 | 内容 | 判决 |
|---|---|---|---|
| `emoji/` | 2,301 | 完整 emoji 选择器：分类栏、最近使用、按 keywords/description 模糊搜索、懒加载、**`/data/emojis/` 自定义 emoji**、`WeakMap` HTML 缓存、键盘导航、**动态日期图标**（工作日/日期 emoji 给 daily note）。`unicode2Emoji()` 是渲染原语。耦合：1 文件 2 处 import | ✅ **拿**（1,650 自包含行，Noema 需要文档图标） |
| `business/openRecentDocs.ts` | 161 | ⭐ `⌘E` 最近文档切换器：最近查看/关闭/打开三个列表 + 模糊过滤 + `upDownHint` | ✅ **拿**（160 行换一个 Ctrl-E quick switcher，性价比极高） |
| `editor/` | 1,744 | ⭐ **不是编辑器，是文档打开路由器**。`openFile(IOpenFileOptions)`/`openFileById`(~490 行) 决定复用当前 tab / 在指定 Wnd 打开 / 右分屏 / 下分屏 / 新窗口 / 聚焦已开 tab；`updatePanelByEditor` 把 outline/backlink/graph dock 同步到当前文档。`index.ts`(217) 是 `class Editor extends Model`——**Tab 与 Protyle 之间约 200 行的适配器**，含 `IntersectionObserver`+`MutationObserver` 惰性挂载底部反链面板 | ⭐ **`Editor`(217 行) 就是写 Noema `CMEditor extends Model` 时该逐行读的文件**；`openFile` 的 tab 复用/分屏路由是想要的行为 |
| `history/` | 3,042 | 三个 UI：工作区历史（笔记本选择 + 操作过滤 + 类型过滤 + 分页 + 分栏预览）、文档历史 + 结构化 diff、快照 diff（文件分 10 类 × 3 操作，聚合成 all/data/extension/other 桶）。⭐ `docDiffCore.ts`(45) 和 `snapshotDiffCore.ts`(9) 是**纯的、有单测的核心**：版本引用联合(`current`\|`history`\|`snapshot`)、状态集(`left-only`\|`right-only`\|`modified`\|`moved`)、过滤器 | ⚠️ **拿模型，重写视图**。Markdown 为真相源意味着真正的文本 diff（CM6 merge view / diff-match-patch）比块 ID diff 更好，但这套**分类法**是免费的 |
| `block/` | 1,971 | `popover.ts`(665) 全局 mouseover 委托，检测 hover 在块引用/文件标注/反链/标签/书签上，延迟后显示 tooltip 或 `BlockPanel`（可拖拽、可缩放、**可嵌套**的"窥视被引用块"浮窗）。⭐ `popover.ts:24` **鼠标移出时 abort 进行中的 fetch** | ❌ **不拿代码，偷交互**。hover-带可中止请求 + 嵌套浮动预览正是 Noema 的 `[[wikilink]]` hover 预览想要的，但在 CM6 decoration 上重写约 200 行 |
| `window/` | 535 | `window/index.ts`(225) 是**第二个入口点**——精简 App 类，自己的 WebSocket、Menus、插件加载，只有一个 `centerLayout`（无 dock 无顶栏）。跨窗口 IPC | ✅ 读**双入口模式**（webpack `main` + `window` 共享 `common` chunk），Tauri 的分离窗口可以照做 |
| `types/` | 4,983 | `config.d.ts`(2,843) 全内核配置 schema 带文档注释；`index.d.ts`(1,552) `IMenu`/`IPosition`/`ITab`/`ILayoutJSON`/`ITabDragData`/`IWebSocketData`/`TEventBus`/`IOpenFileOptions` | ✅ 拿 layout/menu/tab/eventbus 接口 |
| `ai/` | 1,280 | `AIChat`/`AIActions` 内联 AI 写作。⭐ `editorSSE.ts`（`createAIEditorSSEParserState`/`parseAIEditorSSE`/`fetchAIEditorSSE`）是**干净的、有单测的 SSE 行解析器** | ⚠️ 只拿 `editorSSE.ts`(~90 行) 给 Copilot 流式用 |
| `card/` | 1,982 | 闪卡 UI。`flashcardMode.ts` 是可抽出的小状态机 | ❌ 除非要 SRS |
| `asset/` | 24,091 | ⭐ **这是 vendored 的 PDF.js**（54 文件 / ~21,800 行上游 `web/` 代码）+ 思源自己的 `anno.ts`(1,040，矩形/文本批注变成文件标注引用) | ❌ **跳过**。要 PDF 就直接 vendor 当前版 PDF.js。唯一有趣的：`Asset extends Model` 证明 Tab/Model 抽象能装非编辑器内容 |
| `sync/` | 358 | 云同步引导 | ❌ **已决定删** |
| `onboarding/` | 209 | 首次运行引导 | ⚠️ 只拿模式 |

## 2.11 `app/electron/` —— 主进程（Noema 用 Tauri，仅供参考）

`main.js` 2,763 行。值得复刻的：
- **窗口状态持久化**到 `windowState.json`，**带损坏恢复**（写 `{}` 继续跑）
- **macOS 交通灯**：`titleBarStyle:"hidden"` + `trafficLightPosition` **按缩放级别重算**，隐藏工具栏时偏移
- `printToPDF` 委托给隐藏窗口的 `webContents`
- 协议处理器 `app.setAsDefaultProtocolClient("siyuan")`，**带 dev 模式的 `process.execPath + [mainScript]` 变体**
- 单实例锁 → 第二实例转发 URI/工作区
- **托盘菜单在语言变更时重建**
- `powerMonitor` 挂起/恢复
- 全局快捷键由渲染进程的 keymap 编辑器驱动，`hotKey2Electron()` 把 `⌘⇧⌥⌃` 字形翻成 Electron accelerator
- ⭐ **跨窗口 tab 拖拽**：`siyuan-send-windows` 广播 `setTabDragData`/`resetTabsStyle`，从窗口 A 拖出 tab 会在窗口 B 高亮投放区

## 2.12 构建配置

- **4 个 webpack 配置**，每目标一个。⭐ **`ifdef-loader` 多目标模式**：源码里散布 `/// #if !MOBILE … /// #endif` 和 `/// #if !BROWSER … /// #endif`，每个配置设 `{BROWSER, MOBILE}` 布尔。**一份代码出 desktop/mobile/browser/export 四个 bundle，零运行时分支。直接适用于 Noema 的 xwidget-vs-Tauri 分裂**
- `splitChunks`：`runtimeChunk:"single"`（业务代码改动不作废 vendor hash）+ `common` 组 `minChunks:2`（去重 `main` 和 `window` 之间 ~90% 的重叠）
- 测试：`node --import tsx --test`（原生 node test runner，无 jest），**~25 个 `.test.ts` 与源码同目录**

---

# 三、protyle 内可抠出来的层

## 3.0 规模实测

85,771 行 = 79,615 非测试 + 6,156 测试。

| 目录 | 非测试文件 | 非测试行 | 测试行 |
|---|---|---|---|
| `render/av/` | 61 | **24,849** | 1,339 |
| `util/` | 54 | 17,409 | 2,094 |
| `wysiwyg/` | 25 | 17,299 | 1,471 |
| `gutter/` | 4 | 3,885 | 349 |
| `toolbar/` | 13 | 3,859 | 124 |
| `hint/` | 5 | 2,052 | 199 |
| `header/` | 5 | 1,959 | 0 |
| `export/` | 3 | 1,387 | 0 |
| `render/`（非 av） | 18 | 1,453 | 99 |
| `breadcrumb/` | 2 | 1,284 | 0 |
| `preview/` | 4 | 1,067 | 82 |
| `scroll/` | 8 | 690 | 245 |
| `undo/` | 2 | 646 | 0 |
| `ui/` | 4 | 601 | 86 |
| `upload/` | 2 | 505 | 68 |

**`render/av/` 一个目录就占 31%，比整个 `wysiwyg/` 还大。**

## 3.1 ⚠️ 关键发现：protyle 的耦合有**三个独立的轴**，混为一谈会丢掉能用的代码

**轴 1 —— contenteditable / Range。** 凡是 import `util/selection.ts`、`wysiwyg/getBlock.ts`，或操作 `Lute.Caret`/`<wbr>`/`ZWSP` 的。**这是 Noema 要删的那条轴。**

**轴 2 —— `.sy` 事务协议。** `wysiwyg/transaction.ts:2071`：

```ts
export const transaction = (protyle: IProtyle, doOperations: IOperation[], ...) => {
    ...
    if (!protyle) {
        // 文档树中点开属性->数据库后的变更操作 & 文档树添加到数据库
        fetchPost("/api/transactions", {session, app, transactions:[{doOperations}]}, options?.callback);
        return;
    }
```

⭐ **这是整份审计里最重要的一条事实**：`transaction()` **已经支持 `protyle === null`**，此时退化成一次纯 REST POST——没有编辑器、没有 undo 栈、没有 DOM。**所有 AV 变更路径都能无头运行。** 对 protyle 的依赖只是为了乐观 undo 和焦点恢复。

**轴 3 —— 内核 HTML 管道。** `util/onGet.ts:289` `wysiwyg.element.innerHTML = options.content`。这条印证了 plan.md 的前提。

**结论：`render/av/*` 只坐在轴 2+3 上，不在轴 1 上。这把 ~25,000 行从"不可分离"重新归类为"可用 shim 抠出来"。**

另一个证明：`render/method.ts`（39 行）把十个渲染器挂成 `window.Protyle = {...}`，**思源本来就把它们打成一个独立 UMD bundle**（`stage/build/export/protyle-method.js`）给导出的 HTML 用，**在没有编辑器的环境里运行**。整个图表层的解耦是构造性证明，不是推测。

## 3.2 `render/`（非 AV）—— 18 文件 / 1,453 行

| 文件 | 行 | 内容 | 判决 |
|---|---|---|---|
| `method.ts` | 39 | 十渲染器的 UMD 契约 | **C** 直接抄这个模式给 Noema 导出用 |
| `mermaidRender.ts` | 134 | 布局插件 + zenuml + 图标包 + DOMPurify | **C** Noema 全缺 |
| `mathRender.ts` | 140 | KaTeX + **mhchem**，`looseJsonParse` 宏，**`fitMathWidth`(`:9`) 溢出公式自动缩放** | **B** mhchem 和自动缩放值得拿；`:86-118` 是纯 caret hack，丢 |
| `highlightRender.ts` | 184 | hljs + `third-languages.js`；`lineNumberRender`(`:120`) 克隆到离屏 div 复制计算字体来量折行高度 | **B** CM6 白送行号；值得拿的是 `setCodeTheme` 和每块 `linewrap`/`ligatures`/`linenumber` 属性覆盖 |
| `chartRender.ts` | 56 | ECharts + echarts-gl；⭐ **复用已有实例，只在 series 类型变化时 `clear()`**(`:40-47`) | **C** Noema 无 ECharts |
| `graphvizRender.ts` | 40 | viz.js 3.11 WASM | **C** 真实缺口 |
| `plantumlRender.ts` | 41 | plantuml-encoder → `<object type="image/svg+xml">`，可配服务器，出错回落 `<img>` | **C** ~40 行零额外依赖 |
| `abcRender.ts` | 50 | abcjs；⭐ **`%%params {json}` 首行约定**做每图配置 | **C** 这个约定可推广到任意图表语言 |
| `mindmapRender.ts` | 87 | ECharts tree series，源由 `Lute.EChartsMindmapStr` 解析 | **B** 换成 markdown 列表→树的解析器即可 |
| `searchMarkRender.ts` | 129 | **CSS Custom Highlight API**（`new Highlight()`）+ TreeWalker 累积偏移表，零 DOM 变更高亮 | **C** 模式好（CM6 有自己的 decoration） |
| `speechRender.ts` | 97 | `SpeechSynthesisUtterance` 悬浮播放条 | **B** 小、自包含、朗读是真需求 |
| `util.ts` | 67 | `genIconHTML`(编辑/更多/刷新浮层)、`setCodeTheme`(`:46`) 明暗 hljs 样式表切换带白名单兜底 | **B** |
| `mermaidSanitize.ts` | 6 | `MERMAID_SANITIZE_OPTIONS` 现成白名单 | **C** |
| `blockRender.ts` / `setLute.ts` / `luteMarkdownSyntax.ts` | 315 | `.sy` 专属 | **A**（但 `setLute.ts:37` 的"给 AI 输出用一个所有行内语法硬开启的独立解析器实例"值得留） |

**懒加载机制**（`util/addScript.ts:21`）：`addScript(url, id)` —— `document.getElementById(id)` 存在就立即 resolve，否则 append `<script async>` 并在 onload 时打 id。**缓存粒度是 script 标签 id**；每元素缓存只有一个 `data-render="true"` 属性，且**在异步开始前就设**（注释："必须在请求返回前设置，否则快速滚动会重复加载"）。

⭐ **但思源没有渲染输出缓存**——没有 source→SVG 的 keyed memo。**Noema 的 `src/diagram-render.ts:19-98` 的字节预算 LRU（`mermaidCache`/`MERMAID_CACHE_LIMIT`/`MERMAID_CACHE_BYTES`）严格优于思源。这一项 Noema 已经做得更好，不要倒过来吃。**

⭐ **思源有而 Noema 大概率没有的一条**（`mermaidRender.ts:71-96`，`flowchartRender.ts:21-46` 重复）：`firstElementChild.clientWidth === 0` 的元素（在折叠标题里或隐藏的闪卡里）**推迟渲染，挂一个 `MutationObserver` 监听 `fold`/`class`，等它显示出来再渲染**。宽度 0 时渲染 mermaid 会出垃圾图，这是修法。

## 3.3 `render/av/` —— 属性视图渲染器（深挖）

### 架构：**服务端渲染的视图模型 → HTML 字符串生成器**

`avRender`(`render.ts:543`)：① 快照运行时 DOM 状态（选中单元格、选中行、拖填锚点、活动单元格、横向滚动、粘性表头/表尾变换、搜索框焦点、每组页大小、每组虚拟滚动窗口，`:573-640`）→ ② 空时画 3 行脉冲骨架 → ③ `fetchSyncPost("/api/av/renderAttributeView", {...})` → ④ 按 `viewType` 分派 gallery/kanban/groupTable/table → ⑤ 重建 `outerHTML` 并恢复快照。

⭐ **过滤、排序、分组、rollup 求值、聚合、分页、搜索全部在 Go 内核里发生。这 24,849 行完全是 UI**：菜单面板、单元格编辑器、拖拽交互、虚拟滚动、HTML 模板字符串。

**它需要 `IProtyle` 的什么**（全量普查）：`disabled`×38、`app`×11、`wysiwyg.element.querySelectorAll`×9、`id`×9、`block.rootID`×9、`contentElement.scrollTop`×8、`databaseAttributePanel`×7、`options.history`×6、`element`×6、`toolbar.range`×4、`notebookId`×3、`lute`×3。

**即一个 ~12 字段的 shim**。`toolbar.range` 只用在 4 处，`lute` 3 处。**所有写操作都走 `transaction()`，而它支持 `protyle=null`（§3.1）。耦合判决：B，不是 A。**

### 能力清单（这 24,849 行买到什么）

| 维度 | 内容 |
|---|---|
| 视图 | table / gallery(`gallery/` 851 行) / kanban(`kanban/` 392 行)，加 `layout.ts`(432)、`view.ts`(594)、`viewVisibility.ts`(47) |
| **列类型 17 种** | text, number, select, mSelect, date, phone, email, url, template, relation, rollup, created, updated, mAsset, checkbox, block, lineNumber |
| **单元格编辑器** | `cell.ts:423 popTextCell` 分派：文本类→**绝对定位 textarea 且复制单元格的计算字体/行高/padding 做到视觉无缝**(`:457`)；number→`<input type=number>`；select/mSelect→`select.ts`(784，选项 CRUD + 拖拽重排 + 每选项颜色和描述 + 从输入文本即时建选项)；mAsset→`asset.ts`(537，上传/拖拽上传/链接 vs 文件/逐项改名)；date→`date.ts`(221)+`dateFormat.ts`(179)+`dateFormatMenu.ts`(61)，**支持结束日期/区间**和"仅日期 vs 带时间"；checkbox→即时切换无弹窗；relation→`relation.ts`(980，跨库搜索 + 双向反链开关 + 候选选择器)；rollup→`rollup.ts`(266，目标关系 + 目标列 + 聚合算子) |
| **过滤** | `filter.ts`(1,378) + `filterTree.ts`(14)：⭐ **嵌套过滤组 + AND/OR 组合子**，路径寻址的树操作；每类型的算子集(`:371`)；⭐ **相对日期**(`:657-680`) 方向(过去/未来) × 数量 × 单位(日/周/月/年)，即"最近 3 周内"；rollup 列解析到其**目标列类型**再渲染正确控件(`:454`) |
| **排序** | `sort.ts`(166)，可拖拽重排的多键排序 |
| **分组** | `groups.ts`(402)：按列分组 + 分组日期分桶 + 分组排序 + 数值区间分组；`groupFold.ts` 持久化每组折叠 |
| **聚合页脚** | `calc.ts`(644)，22 个算子 |
| **行详情抽屉** | `openDatabaseRow.ts`(257) + `attributePanel.ts`(303) + `attributeValue.ts`(254) + `blockAttr.ts`(650) + `batchEdit.ts`(240 多行字段批量编辑) |
| **选择/交互** | `rangeSelect.ts`(328 shift 点选单元格区域)、`selectionState.ts`(214 跨重渲染存活)、`dragFillValue.ts`+`cell.ts:1319`（**Excel 式填充柄**）、`keydown.ts`(392 方向键/Tab 网格导航)、`paste.ts`(206 **粘贴 TSV 进单元格区域**) |
| **列宽** | ⭐ `columnWidth.ts`(101) **纯函数、零依赖**：用真实单元格的计算字体建 `canvas.getContext("2d")` 做精确 `measureText`，带 ASCII/CJK 宽度启发式兜底（CJK=14px、大写=9px、空格=4px），`getAVColumnFitWidth` 钳在 [64,480]，`getAVColumnResizeWidth` 4px 内吸附上一次宽度。**100 行，可直接复制** |
| 其他 | `newItemTemplate.ts`(**1,261**! 新行默认值模板，含建关联文档)、`cover.ts`/`coverPosition.ts`(345 每卡封面图 + 拖拽重定位)、`locate.ts`(404 跨分页/虚拟化滚动到某行)、`number.ts`(283 货币/百分比格式化)、`action.ts`(1,393 点击+右键分派)、`row.ts`(1,021 含粘性行和分页) |
| 虚拟滚动 | `virtualScroll.ts`(967) + `groupTableVirtual.ts`(165) |

### 与 Noema 的差距

Noema `src/cm6/extensions/visual/widgets/attribute-view.ts` = **446 行**：table/gallery/kanban 切换、列隐藏、`todo.status` 用 `<select>` 否则 `<input>`、kanban 单键 `groupBy`。

**比例：446 : 24,849 = 1 : 56。**

具体缺失：17 种列类型里的 15 种、嵌套 AND/OR 过滤树、相对日期过滤、多键排序、分组（全部）、rollup、relation、聚合页脚（22 算子）、行详情抽屉、拖填、单元格区域选择、键盘网格导航、列宽调整/自适应、分页、虚拟滚动、每视图持久化配置、资源单元格、封面图、新行模板、TSV 粘贴。

⚠️ **但**：Noema 的版本**锚定在 markdown 源偏移上**，思源的锚定在**不在 markdown 里的、内核拥有的 `.av` JSON blob** 上。上面每一项思源能力都假设"有个服务器拥有这份数据"。

**判决：表现/交互层是 B，凡是假设 `/api/av/*` 的是 A。现实的收获清单**：`columnWidth.ts`、`filter.ts` 的算子表和相对日期模型、`calc.ts:592` 的算子词汇表、`dateFormat.ts`、`gallery/style.ts`+`cardLayout.ts`、`virtualScroll.ts`+`groupTableVirtual.ts`，以及 `openMenuPanel.ts:87` **11 种面板类型的形状**作为"一个完整数据库 UI 需要什么"的规格。**UI 词汇表比代码本身更值钱。**

## 3.4 `hint/` —— slash / 自动补全引擎（5 文件 / 2,052 行）

**触发模型**（`index.ts:1185 getKey`）**不是解析器**：在光标前的当前行文本里对所有注册的 `IHintExtend` key 做 `lastIndexOf`，取**最右**的匹配。注册的 key 有 `/`、⭐ **`、`（中文顿号）**、`:`(emoji)、`#`(tag)、`((`(块引用)、`{{`(嵌入)，加插件 key。

朴素实现做不到的九件事：

1. ⭐ **多字符触发器 + 闭合符感知**（`blockHintRange.ts:1`）：如果光标**之后**的文本已经以闭合符开头，就用普通 `lastIndexOf`；否则还要考虑 `(((` 三连并取 min。**这处理的是"在已有 `((ref))` 内部编辑"**
2. ⭐ **触发器优先级 / 互斥**（`:15 shouldIgnoreHintTrigger`）：块提示（`((`/`{{`）激活时 `:`/`#`/`/` 不能抢；`#` 激活时 `/` 不能抢
3. **粘性会话**（`index.ts:1208`）：已经开着提示时，新算出的不同触发器会被拒绝，除非是 `:` 打断 `/`
4. **上下文抑制**（`:250`）：代码块内不出提示；`:258` 标题行首的 `#` 不触发标签提示（这样 `### ` 不会误触）
5. **整文本节点光标偏移**（`:93 getWholeTextOffset`）：向前遍历 `previousSibling` 文本节点求 `.wholeText` 内的偏移，因为 Chrome 会任意切分文本节点
6. **粘贴恢复**（`:216-236`）：粘贴后光标可能落在空文本节点，向前合并再折叠
7. ⭐ **加载态 + 陈旧响应守卫**：`prepareCreateTarget`(`:171`) 按 (notebookId, path) 记忆异步检查，用单调递增的 `renderID`，`isCurrent()`(`:203`) 在晚到的 resolve 时若会话/文档/可见性变了就拒绝。**异步菜单内容的正确陈旧守卫**
8. ⭐ **用户可配置的顺序 + 可见性**（`slashMenu.ts`，**52 行纯函数，直接可用**）：按 `entryKey` 去重 → `reorderEntrySlots` 重排 → 按可见性配置过滤 → 按 `item.filter[]` 子串匹配 → `normalizeSlashMenuSeparators` 折叠相邻/尾部分隔符
9. ⭐ **多语言模糊过滤**：每个条目带 `filter: [本地化名, "english", "中文名", "quanpin", "abbrev"]`，如 `["模板","template","模板","moban","muban","mb"]`。**这就是为什么中文用户打拉丁字母也能用 slash 菜单**。另外每行右侧用 `getHotkeyOrMarker` 显示绑定的快捷键或 markdown 标记

**内置 slash 目录 66 条**（`extend.ts:43`）：template, widget, assets, ref, blockEmbed, aiWriting, database, newFileRef, newSubDocRef, heading1-6, list, orderedList, check, quote, calloutNote/Tip/Important/Warning/Caution, code, table, line, math, html, databaseTable/Kanban/GalleryView, emoji, link, bold, italic, underline, strike, mark, sup, sub, inlineCode, kbd, tag, inlineMath, insertAsset/HTMLFile/IframeURL/ImgURL/VideoURL/AudioURL, staff, chart, flowChart, graph, mermaid, mindmap, UML, info/success/warning/errorStyle, clearFontStyle。

**键盘**：`Enter` 填充；上下 → `upDownHint`；⭐ **左右方向键 dismiss 但不 `preventDefault`**，光标仍然移动。

**对比 Noema**：`src/cm6/commands/index.ts:1131 QuickInsertRegistry` 是 register/getItems/run 的 provider 集合。**思源做得更好的**：多字符+闭合符触发、触发器优先级与粘性、多语言+拼音过滤数组、用户可配置顺序与每条可见性、行内快捷键提示、分隔符规范化、异步条目加载的陈旧守卫、真正的 emoji 浏览器。

**判决**：`render()`/`fill()` 是 Range 绑定 → A。`getKey`、`blockHintRange.ts`、`slashMenu.ts`、`createTargetContext.ts`、过滤/排序模型、条目目录、异步陈旧模式 → **B/C，值得吃**。

## 3.5 `scroll/` —— 长文档加载（8 文件 / 690 行）

⚠️ **这不是视口虚拟化**，是**窗口式增量拉取且从不卸载**：块被 append/prepend 后永远留在 DOM 里。没有回收、没有 spacer、文档主体没有高度估算。（**文档内虚拟化只存在于 AV 块里**，见下。）

- `loadDynamic(protyle, mode, ...)`：mode 1 = prepend（锚点 `firstElementChild`），mode 2 = append。`data-eof`/`data-bottom-eof` 时退出
- ⭐ **序列化 + 中止**：`dynamicLoadState.ts`（**44 行纯函数 + 48 行测试**）单槽 token 机：`begin()` 有在途请求就返回 `undefined`；**`isCurrent(request, rootID, anchorID)` 在响应之后重新校验文档和边界块都没变**；`invalidate()` 走 `AbortController`
- **滚动阈值**：`scrollTop < clientHeight` 时 prepend；`scrollTop > scrollHeight - clientHeight*1.8` 时 append。⭐ **防抖动**：prepend 期间把 `contentElement.style.width` 冻结成当前 px 并 `overflow:hidden`
- ⭐ **滚动条拖拽识别**：`lastScrollTop > 768 && scrollTop > lastScrollTop*2` 时**回弹而不是加载**——区分"用户拽了原生滚动条"和"用户滚动"
- `loadAll.ts`（26 行纯函数 + 111 行测试）：`loadUntilDocumentBoundary` 循环加载直到边界，**边界 ID 不再变化就中止（活锁守卫）**
- `saveScroll.ts`：持久化 `{rootId, startId, endId, scrollTop, focusId, focusStart, focusEnd, zoomInId}`；⭐ **恢复时用 `{startID, endID}` 重新请求同一个窗口的块**，而不是重新分页

**AV 内的真虚拟化**（`render/av/virtualScroll.ts` 967 行）：`IBodyState` 存在 `WeakMap<HTMLElement,...>`；`BUFFER_RATIO = 1` 个视口的过扫描；⭐ **显式缓存 `rowHeight` 以避免每帧读 `offsetHeight`**（注释直接写"强制重排来源"）；⭐ `measureHeightDiff` 用 `scrollHeight` 差值测量真实移除高度**以包含 CSS grid gap**；选中行 ID 在 trim 前快照、trim 后重放。`groupTableVirtual.ts`（165 行纯函数 + 测试）从视口中心算窗口，`rowsPerViewport*3`。

⭐ **批处理**（`scroll/event.ts:26-42`）：每个 `.av` 块每帧一个 `requestAnimationFrame`，用 `WeakSet` 守卫，**先跑 `stickyRow`（读）再跑 `trimAVRowsSync`（写）**，注释明确说拆成两个 rAF 会交错读写强制重排。

**判决**：`dynamicLoadState.ts` / `loadAll.ts` / `scrollRequest.ts` / `visibility.ts` / `preventScroll.ts` / `groupTableVirtual.ts` = **C**（纯函数、有测试、共 ~250 行）。`index.ts`+`event.ts` = **B**——**策略**（锚点 ID 窗口拉取、单飞 token、响应后重校验、滚动条拖拽识别、保存 `{startID,endID}` 窗口恢复）才是价值所在，**CM6 没有等价物**。`saveScroll.ts` 的焦点偏移持久化是 A（contenteditable 偏移），但概念映射到 CM6 位置——**在 Noema 的模型里是源偏移，严格更容易**。

## 3.6 `export/` —— 3 文件 / 1,387 行 ⭐ 高价值

### 自包含 HTML（`onExport`, `index.ts:921`）

生成一个完整的 `<!DOCTYPE html>` 字符串，含：`<base href>` 让相对资源路径解析；`base.css` + 当前主题 CSS + `data-theme-mode`/`data-light-theme`/`data-dark-theme` 属性（**导出后主题仍能切换**）；内联计算 CSS 变量 + 插件样式 + 所有 `<style id="snippetCSS*">` 原样复制；⭐ **内联 SVG sprite 注入器**（`getIconScript`）让 `<use xlink:href="#iconX">` 仍然工作；`protyle-method.js` + `lute.min.js`；然后是关键的一段——

⭐ **一个桩 `window.siyuan`**（`:971-985`），只含渲染器真正读的字段：`appearance.mode/codeBlockThemeDark/codeBlockThemeLight`、`editor.{codeLineWrap, fontSize, codeLigatures, plantUMLServePath, codeSyntaxHighlightLineNum, katexMacros}`、`languages.copy`。**15 行，这就是让那些渲染器独立运行的最小契约——正是 Noema 要写的那个 shim。**

最后调十个 `Protyle.*Render(previewElement, "stage/protyle")`，加一个复制按钮处理器（写剪贴板前剥掉 ` ` 和 `‍`）。

### PDF（`renderPDF`, `index.ts:181`）—— 三个必踩的坑

Electron 专属，开一个新 BrowserWindow。三个关键函数：

1. ⭐ `fixBlockWidth()`(`:461`)：把选定页面尺寸按 96dpi 转 px，减去边距，除以缩放，设 `#preview` 宽度；然后**用强制 `linewrap` 在钳定宽度重渲染代码块**并 `highlightRender(el, path, scaleValue)`（**第三个 `zoom` 参数就是为了让 `lineNumberRender` 在 CSS zoom 下量得对**）；`mathRender(el, path, maxWidth=true)`——**`maxWidth` 标志让 mathRender await `fitMathWidth`，把溢出公式在打印前按字号缩放**；mermaid SVG 的 `max-height` 钳到页高；溢出表格 zoom 到合适
2. ⭐ `waitForImages()`(`:763`)：给每个 `<img>` 设 `loading="eager"` 并 await load/error，30 秒超时。**不做这个 Electron 会打印出空白图片**
3. ⭐ **非分页模式**(`:790-812`)：`#paged` 关闭时算 `scrollHeight/96`，传一个**自定义 `pageSize: {width, height}`**，让整篇文档变成一张巨大的单页，没有分页符

暗色模式会先弹确认框，因为 PDF 永远用亮色主题渲染。

### 图片导出（`util.ts:30`）

⭐ 三个硬赚来的 workaround：**PlantUML 的 `<object>` 元素要先 `fetch()` SVG 内联**（html-to-image 无法栅格化 `<object>`）；`imagePlaceholder` 1×1 base64 PNG + `onImageErrorHandler`；⭐ **iOS/Safari 上要调 `toBlob` 四次**（html-to-image 已知的字体加载竞态）。水印文本自身先 `toCanvas` 栅格化再当重复背景图。

### Markdown 导出（`exportMd.ts:28`）

13 项选项对话框，**从 `window.siyuan.config.export` 读默认值但不改全局**（每次调用独立）。

**脚注**在内核侧处理（`blockRefMode` 把块引用转成脚注）。

**判决：`onExport` 的 HTML 模板 + `window.siyuan` 桩 + `getIconScript`/`getSnippetCSS` 模式 = B，高价值**——这是一份可用的、离线仍保留主题/数学/代码主题/十种图表的单文件 HTML 导出配方。**`fixBlockWidth`/`waitForImages`/非分页自定义页尺寸三件套 = B，高价值**——这正是 Electron PDF 导出会出问题的三处。

## 3.7 `toolbar/` —— 13 文件 / 3,859 行

- `index.ts`(2,373)：行内标记引擎是 **A**（纯 contenteditable span 手术）。但 ⭐ **`showRender`(`:1196`) 是通用的"编辑某个已渲染节点的源码"面板**——一个浮动可缩放 textarea + 预览，用于 mermaid/echarts/flowchart/graphviz/mindmap/plantuml/abc/math/html/blockEmbed/行内备注，带刷新/前插/后插/导出图片/固定/关闭按钮。**这正是 Noema 需要的"在侧面板编辑围栏图表块"—— B，价值好**
- ⭐ `formatPainterCore.ts`(49 行，**纯函数**)：`FORMAT_PAINTER_TYPES`(strong/em/u/s/mark/sup/sub/code/kbd)，`getCommonFormatPainterSnapshot` 对多段选区求样式交集，once/continuous 两种模式。**~50 行零依赖，可直接移植到 CM6 marks —— C**
- ⭐ `util.ts:275-303`：`resolveLinkDest` + `genLinkText`，URL→显示文本，剥 scheme、可选 `decodeURI`。纯函数 **C**
- `Link.ts`(78)：⭐ 无选区插入链接时**读剪贴板**，依次尝试 `lute.GetLinkDest` → 解析剪贴板 HTML 里的 `a` → `resolveLinkDest(纯文本)` → 在最后一个空格处切分。**~40 行的好 UX**
- `Font.ts`(517)：`convertFontSize` px↔em、`limitRecentFontStyleRows` 最近颜色 MRU。**B**

## 3.8 `wysiwyg/` —— 25 文件 / 17,299 行 —— **全部 A**

`index.ts`(4,867) 在可编辑元素上注册 21 个监听器；`keydown.ts`(2,508)；`transaction.ts`(2,380) 是 `.sy` op 协议。

唯一真正可移植的碎片：`blockquote.ts`(39)、`taskListMarker.ts`(22)、`codeBlockUtil.ts`(57)、`listContext.ts`(180)——都小、都有测试，但 **Noema 已经有等价物**（`src/cm6/commands/index.ts:342 continueMarkdownMarkup`、`:373 continueMarkdownQuote`），**价值低**。

⭐ 例外：`renderBacklink.ts`(261) —— 反链面板渲染器，`WeakMap<IProtyle, Map<id,{revision, anchor}>>` 做**按 revision 键控的增量 DOM 复用**：收集两个 `.protyle-breadcrumb__bar[data-backlink-id]` 标记之间的兄弟节点段，**只拆掉变化的反链组**。**B——这个"按 revision 键控的兄弟段落协调"模式适用于任何重渲染服务端 HTML 的面板。**

## 3.9 `gutter/` `breadcrumb/` `header/`

- `gutter/index.ts`(3,788) 是 **A**，但三个抽出来的助手是**纯函数 + 有测试**：`layout.ts`(16，用 `fontSize*1.625` 给 1-2 行块居中把手)、`multiSelect.ts`(60)、`button.ts`(21) —— **C**
- `breadcrumb/`(1,284)：面包屑是 `IBreadcrumb[]` 的纯函数 —— **B**
- ⭐ `header/Background.ts`(929)：**封面图 + 文档图标**。上传/链接/资源选择器/内置随机/拖拽重定位，加 ~30 个硬编码 CSS 渐变作为内置封面。全部由块属性驱动（`title-img`/`icon`），**在 Noema 里映射到 frontmatter —— B，美学价值高**
- ⭐ `header/coverData.ts`(70)：**C，纯函数**——取 `/appearance/covers/manifest.json`，按分类缓存并保留 manifest 顺序，带摄影师/Pexels 署名字段。干净的"内置图库选择器"模块。（注：plan.md 明确把 `app/appearance/covers/`(19MB) 留在 reference 没搬——如果要这个功能，那 19MB 就有了落点）

## 3.10 `preview/` —— 4 文件 / 1,067 行

⭐ **`platformCopy.ts`(556) 是意外之喜**：`prepareWechatCopy` / `prepareZhihuCopy` 把预览 DOM 改写成那些平台编辑器能接受的形状——`getPlatformListMarker`(`:46`) 把 `<ul>/<ol>` 转成**字面文本标记**（因为微信剥列表语义），每层不同的项目符号和任务态字形；`buildExpandedTableGrid`(`:73`) 把 `rowspan`/`colspan` 展开成稠密网格。加上 `index.ts:311-327`：微信版把 KaTeX 转成 **MathJax SVG**（`tex2svg`，删 `mjx-assistive-mml`，SVG 宽度 ×8），知乎版把数学转成 `<img class="Formula-image" src="//www.zhihu.com/equation?tex=">`。

**B —— 550 行无法便宜地重新推导出来的平台导出知识。如果 Noema 以后要"复制为富文本到 X"，这就是地图。**

另有 `preview/index.ts:88-127` 的 copy 处理器：检测选区里有图片/数学/表格时，写一个**带标记注释的** `text/html`（`<!--siyuan-rich-clipboard='<id>'-->`）+ 纯文本，再交给 `enhanceRichClipboard` 解析本地资源路径成真实图片数据。⭐ **"这份剪贴板载荷是不是我们自己的"用标记注释往返，设计干净。**

## 3.11 `ui/` —— 4 文件 / 601 行

⭐ `padding.ts`(20 行，**纯函数**)：`getEditorHorizontalPadding(width, fullWidth)` 实现**黄金比例正文居中**（超过 `SIZE_EDITOR_WIDTH` 时用 `width * .382 / 1.382`）。**20 行让长文阅读的版心看起来对。** （注：Noema 有自己的 4%–8% 自适应 + 95ch 算法，且 plan.md 把排版列为不可退让的手感门禁——**这一条是参考，不是替换**）

`hideElements.ts`(96)：`hideElements(["hint","toolbar","gutter","select",...], protyle)` 集中式关闭分派器。**B —— 模式值得采纳**（一个具名面板关闭函数，而不是散落各处的 `.classList.add("fn__none")`）。

⚠️ **tooltip / spinner / 反链面板都不在这里**：tooltip 在 `dialog/tooltip`（protyle 外），由 `class="ariaLabel" aria-label data-position` 约定驱动（protyle 内 141 处）；spinner 是 `.fn__loading`；反链面板是 `wysiwyg/renderBacklink.ts`。

## 3.12 `util/` —— 54 非测试文件 / 17,409 行

### 真正独立（C，共 ≈1,500 行白捡，大多带测试）

| 文件 | 行 | 内容 | 依赖 |
|---|---|---|---|
| ⭐ `officeList.ts` | 562 (+146 测试) | **零 import。** 把 Word/PowerPoint 粘贴来的 HTML 列表还原成真正的 `ul/ol/task`：`parseWordListStyle`、`parsePptSpecialFormat`、`parseOrderedMarker`(罗马/字母/十进制)、**`detectTaskMarker`(Wingdings 字形 + 字体启发式)**、`groupConsecutiveOfficeListItems`、`convertOfficeLists(html)` | 无 |
| ⭐ `headingNumberCore.ts` | 292 (+350 测试) | **零 import。** 自动标题编号：生成作用域 CSS、宽度测量记忆在 `WeakMap`、`headingNumberNeedsSpacing` 处理 `、`/`）` 后缀、`cleanHeadingNumberHTML` 持久化前剥编号 | 无 |
| `caretRect.ts` | 81 (+99) | `getCaretRect` 带零高矩形兜底和 RTL 边缘选区 | 无 |
| `hasClosest.ts` | 138 | `hasClosestByClassName/Tag/Attribute`，⭐ `hasTopClosest*` **返回最外层匹配而非最内层**（嵌套超级块用） | 仅 Constants |
| `escape.ts` | 45 | `escapeHtml`(只转 `&` 和 `<`)、⭐ `escapeAriaLabel` **双重转义 `<`**（因为 tooltip 按 HTML 渲染）、`escapeSearchHighlight`(转 `<` 但放过 `</?mark>`) | 无 |
| ⭐ `imageAnimation.ts` | 58 (+75) | `createImageAnimationController(setTimer, clearTimer)` —— **依赖注入以便测试**；滚动时用 CSS class 暂停 GIF/APNG 动画，延迟后恢复 | 无 |
| `transactionQueue.ts` | 12 | `WeakMap<IProtyle, Promise>` 串行任务队列 | 无 |
| `hotKey.ts` | 199 | `matchHotKey` | Constants |
| `normalizeText/merge/docInfo/selectionBoundary/parentDocument/officeMath/pasteResponse/blockDOMClipboard/tableColumnWidth` | 各 10–35 | 纯 helper，全有测试 | 无 |

### 可用 shim 抠出（B）

- ⭐ `compatibility.ts`(960)：**平台/剪贴板抽象层**。Electron vs 浏览器 vs Android vs iOS vs HarmonyOS：`readClipboard`、`writeClipboardData`、`saveExportFile`、`getLocalFiles`、`getEventName`、`isOnlyMeta`/`isNotCtrl`、15 个平台谓词、`updateHotkeyTip`(`:624`) 按 OS 渲染 `⌘`/`Ctrl`、`getLocalStorage`/`setStorageVal`，以及 `isSensitiveSearchConfig`/`sanitizeClosedTabs`(`:820-854`) 把加密笔记本数据从持久化布局里剥掉
- ⭐ `tableControl.ts`(2,708)：**代码库里最好的表格 UX**——浮动行/列拖拽把手、悬停加行/加列按钮、带 px 标签的缩放、投放指示器、单元格区域选择、`ResizeObserver` 粘性表头，全部由 `MutationObserver` + rAF 调度驱动，用 `AbortController` 干净拆除。**~90% 是几何，~10% 是事务。** 配套纯函数 `tableSelection.ts`(152+237 测试)、`tableResize.ts`(51+71 测试)
- `table.ts`(1,511)：`transposeTable`、⭐ `buildTableGrid`(`:939`，rowspan/colspan 解析)、`getTableRangeCells`。**网格模型对 markdown 管道表可复用**
- `richClipboard.ts`(645)、`resize.ts`(85 跨窗口 resize 的滚动锚点保持)、`blockFold.ts`(307)、`RecordMedia.ts`(289 音频录制)

### 不可分离（A）

`selection.ts`(1,268)、`insertHTML.ts`(1,610)、`paste.ts`(1,084)、`editorCommonEvent.ts`(3,125，整套块拖放系统)、`onGet.ts`(665)。⭐ 例外：`processCode.ts` 的 `RENDER_MAP`(`:49`) 和 `processRender`(`:61`) 是 **C**——一个 25 行的 `data-subtype` → 渲染器分派器。

## 3.13 `undo/`(646) 和 `upload/`(505)

⭐ `undo/index.ts:34` 的架构注释：**权威 undo 栈在内核**（`GlobalUndoLog`），按 `rootID` 键控，**跨窗口共享**。前端只做乐观本地应用和按钮状态。`globalUndo.ts`(386) 维护一个 `Map<rootID,{canUndo,canRedo}>` **镜像**让按钮启用零请求，在编辑/undo 响应/WebSocket 广播时更新，带重入守卫。**A（协议），但"镜像换零请求按钮状态"的想法是 B/C。**

⭐ `upload/insertPosition.ts`(24 行 + 68 行测试，**纯函数**)：`createUploadInsertPosition(range, context)` / `isUploadInsertPositionAvailable(editorElement, position)`——**捕获异步上传该落在哪里，完成时校验目标仍存在**。**C —— 这个"捕获插入点 → 异步 → 重校验"模式正是 Noema 的 CM6 异步插入需要的。**

## 3.14 可访问性 / i18n / 性能

**可访问性（整体弱，不要照抄）**：141 处 `class="ariaLabel" aria-label` + `data-position` 其实是**自定义 tooltip 系统借用了 aria-label**，不是真 a11y。⚠️ aria-label 的值里含标记（`render/av/col.ts:139` 里是 `<div class='ft__on-surface'>…`），**对屏幕阅读器是有害的**。没有 ARIA role、没有 `aria-live`、菜单没有焦点陷阱、AV 表格没有 `role="grid"`。**Noema 的 a11y 不要以此为范本。**

**i18n（真的强）**：1,479 处 `window.siyuan.languages.*`，UI 字符串零硬编码英文。`updateHotkeyTip` 一份 keymap 字符串在 macOS 渲染 `⌘⇧M`、别处渲染 `Ctrl+Shift+M`。⭐ 每个菜单条目的多语言+拼音过滤数组。⭐ **模板字符串日期格式**（`render/av/dateFormat.ts:16`）：`${year}/${month}/${day}` 占位符 + `|` 分隔的月份名，**外加一个从同一模板重建正则的反向解析器**（`parseFullDate:47`，月份名按最长优先排序避免前缀冲突）。**~80 行干净的双向 i18n 日期处理。** 中文输入被当一等公民：`、` 与 `/` 并列做触发器；每条输入路径都有 `compositionstart/end` 守卫。

**性能——好东西**（17 条，与 §四合并）。

## 3.15 protyle 侧购物清单

**几乎可以逐字拿走（C，~2,000 行，大多带测试）**：
`render/method.ts` + 8 个图表渲染器 + `util/addScript.ts` + `render/util.ts:46 setCodeTheme` · `util/officeList.ts` · `util/headingNumberCore.ts` · `render/av/columnWidth.ts` · `render/av/groupTableVirtual.ts` · `scroll/{dynamicLoadState,loadAll,scrollRequest,preventScroll}.ts` · `hint/{slashMenu,blockHintRange,createTargetContext}.ts` · `toolbar/formatPainterCore.ts` · `toolbar/util.ts:275-303` · `util/imageAnimation.ts` · `util/transactionQueue.ts` · `util/caretRect.ts` · `util/escape.ts` · `ui/padding.ts` · `gutter/{layout,multiSelect,button}.ts` · `upload/insertPosition.ts` · `header/coverData.ts` · `util/processCode.ts:49-75` · `render/av/dateFormat.ts`

**带 shim 移植（B，高价值）**：
`export/index.ts:921 onExport` HTML 模板 + `window.siyuan` 桩 · `export/index.ts:461/763/790` PDF 三件套 · `render/av/virtualScroll.ts` · `scroll/index.ts`+`event.ts` 的窗口拉取策略 · `toolbar/index.ts:1196 showRender` 图表源码编辑面板 · `preview/platformCopy.ts` 微信/知乎导出 · `util/compatibility.ts` 平台层 · `util/tableControl.ts` 表格几何 · `header/Background.ts` 封面+图标 · `hint/` 触发模型+目录+异步陈旧模式 · `wysiwyg/renderBacklink.ts` revision 键控协调

**留下（A）**：整个 `wysiwyg/` · `util/{selection,insertHTML,paste,editorCommonEvent,onGet}.ts` · `gutter/index.ts` · `toolbar/index.ts` 的行内标记引擎 · `render/setLute.ts`+`blockRender.ts` · `undo/` · `render/av/` 里所有调 `/api/av/*` 的部分（可惜是它 24.8k 行里的大多数——**UI 词汇表比代码更值钱**）

---

# 四、最值得偷的 20 条非显然工程

按"自己写一定写不对"排序：

1. **`sql/index_queue.go`** —— flock 保护的 JSONL 索引 WAL，按 flush 起始快照的字节偏移截断，flush 期间追加的 op 不丢
2. **`model/index_fix.go` + `util/websocket.go:651-681`** —— 空闲触发 + 冷却门禁 + TryLock 守卫的自愈索引修复
3. **`sql/queue.go:227-249`** —— 自适应 sleep 合并大规模 rename 风暴；`:308-313` 周期性 `debug.FreeOSMemory()`
4. **`sql/database.go:131-142`** —— 不升版本号的加法式 schema 迁移，避免加一列毁掉算得很贵的 embeddings
5. **`filesys/markdown_ephemeral_ids.go`** —— lute 现发随机 ID → 索引无界增长的陷阱（已解决，但注释是活的文档）
6. **`filesys/markdown_orgenv.go`** —— CommonMark 懒续行吞掉块终止符，只在真正有风险的场景外科式修复
7. **`search/hanconv.go:48-50`** —— Go 高亮表必须与 C tokenizer 的 OpenCC 表字节一致，这条跨语言不变量别处无文档
8. **`filesys/crypto_hook.go:39,121`** —— DEK 租约含清零 release；AAD 故意不含父目录以支持免重加密的 box 内移动
9. **`model/session.go:481`** —— 读白名单 + 按路由路径分桶互斥的写串行化
10. **`util/runtime.go:325,437`** —— 周期性文件系统可写检查；拒绝把工作区放在云盘路径上
11. **`util/path.go:586` + `server/serve.go:548-605`** —— 解析最深已存在祖先 + 静态服务的 symlink 逃逸防御（4 个专门测试文件）
12. **`model/embedding.go:42-58`** —— 指数退避 + 永久失败计数 + 类型化的 `ignored_type`（"为什么没被 embed"）
13. **`treenode/heading.go`** —— "标题是兄弟不是父节点"，解对了一次
14. **`cache/av.go:64-191`** —— 版本号 + generation 计数器，派生索引 O(1) 失效
15. **`sql/stmt_validate.go:29`** —— 重新实现 SQLite 自己的尾随注释规则，安全地允许尾随分号
16. **`util/cmux.go:17-19`** —— 共享根 listener 的关闭陷阱
17. **`heif/convert.go:26-39`** —— 显式每像素内存预算 + 单槽并发的解压炸弹防御
18. **`api/lute_wps_presentation.go:35-45`** —— 剪贴板 OOXML 的 zip 炸弹与 XML 深度限制
19. **`sql/upsert.go:41`** —— 按 SQLite 999 参数上限算出的批量插入 chunk 大小
20. **`task/queue.go:85,104`** —— 按 action + 参数深比较去重，即防抖机制本身

**前端（非 protyle）另有五条**：`Wnd.ts:471-506` 的两直线半平面拖放命中测试；`util.ts:857` 的 `data-initdata` 惰性 tab 水合；`Menu.ts:17` 的 separator 自动分组（且跳过隐藏项）；`search/request.ts` 的 version + AbortController + 单槽队列；`util/assets.ts` 换主题时先插新 link、等 onload 再删旧 link。

**protyle 内另有十条**（都是渲染/滚动性能，与 CM6 世界直接相关）：

1. `scroll/event.ts:26-42` —— rAF 合并 + `WeakSet` 守卫 + **显式的"先读后写"顺序**，注释说明拆成两个 rAF 会交错读写强制重排
2. `render/av/virtualScroll.ts:16` —— 缓存 `rowHeight` 避免每帧读 `offsetHeight`（注释直书"强制重排来源"）
3. `virtualScroll.ts:35 measureHeightDiff` —— 用 `scrollHeight` 差值而非算术，**才能把 CSS grid gap 算进去**
4. `render/av/render.ts:643` —— 请求前先画骨架屏防布局抖动
5. `render/blockRender.ts:35` —— 替换嵌入内容前把 `height` 冻结成 `clientHeight - 4`
6. `scroll/event.ts:103` —— prepend 期间冻结 `width` + `overflow:hidden`
7. `scroll/dynamicLoadState.ts` —— 单飞 + **响应后重校验**（文档和边界块都没变才应用）
8. `render/setLute.ts:14` —— 共享解析器单例，注释明确说把初始化从 O(编辑器数) 降到 O(1)
9. `render/av/openMenuPanel.ts:112` —— 只要元数据的菜单发 `ignoreRows: true`，**让内核完全跳过行渲染**
10. `mermaidRender.ts:71-96` —— `clientWidth === 0` 的元素（折叠标题内）**推迟渲染并挂 `MutationObserver`**，因为宽度 0 渲染 mermaid 出垃圾图

还有一条**反向**的：⭐ **思源没有渲染输出缓存**（只有 script 标签级的懒加载缓存 + `data-render="true"` 标志）。**Noema 的 `src/diagram-render.ts:19-98` 字节预算 LRU 严格更好。这一项不要倒过来吃。**

---

# 五、总排序（如果只能做几件事）

| 序 | 项 | 规模 | 为什么排这里 |
|---|---|---|---|
| 1 | **把 `protyle/util/` 的 4 个文件挪进中立 `core/`**（生产已接线） | 极小 | 已落为 Noema source-owned platform/hotkey/DOM ancestry/transient registry；没有复制移动端或 contenteditable 分支 |
| 2 | **b3 设计系统**（SCSS 4,200 行 + 2 个 theme + 图标 sprite） | 小 | plan.md 列的"要吃到的"四件事里唯一完全没开工的；零 JS 耦合，纯拷贝；165 变量 + 15 种按钮 + 3 模式菜单 + 255 图标 |
| 3 | **纯函数收割**（生产清单已收口；待正式实包门禁） | 小 | Office/heading/column/image/hint/format painter/Tree 已迁入生产；insert target/request/key navigation/position/viewport loading 均有更强 Noema 等价物与明确边界证据 |
| 4 | **菜单系统**（生产已接线；待本批正式实包门禁） | 小 | 独立、无耦合；source-owned controller 已替换旧 context menu，`loadSubmenu` 异步 + 分隔符自动分组 + sticky/54px 定位 + 完整方向键均进入真实产品链 |
| 5 | **`kernel/cli/`**（已在树里，只需接线） | 极小 | Emacs 宿主的天然接口，进程内直调不走 HTTP；**路线图完全遗漏** |
| 6 | **layout/dock 引擎**（5,200 行） | 中 | 分屏 + 拖拽分屏 + 浮动 dock + 布局持久化 + 惰性 tab 水合；Noema 的 dock/workbench 正在手写这些的劣化版。`editor/index.ts`(217) 是写 `CMEditor extends Model` 时该逐行读的文件 |
| 7 | **导出三件套**（自包含 HTML 配方 + `window.siyuan` 15 行桩 + PDF 三个坑） | 中 | `onExport` 模板让离线 HTML 仍保留主题/数学/代码主题/十种图表；`fixBlockWidth`/`waitForImages`/非分页自定义页尺寸正是 PDF 导出必踩的三处 |
| 8 | **`av/filter.go` + `av/calc.go` + `render/av/` 的 UI 词汇表当规格书** | 中（读，不写） | 17 算子 × 17 类型 / 22 聚合 / 嵌套 AND-OR 树 / 相对日期的边界语义；Noema 的 446+583 行里一条没覆盖。**比例 1:56。代码不能吃（假设服务器拥有数据），语义必须吃** |
| 9 | **虚拟引用**（Aho-Corasick + TTL 缓存） | 小 | org-roam 的 unlinked mentions，Noema 完全没有，算法层已在树里 |
| 10 | **hint 触发模型**（多字符+闭合符、优先级互斥、拼音过滤、异步陈旧守卫） | 小 | Noema 的 `QuickInsertRegistry` 缺这全部；中文用户打拉丁字母能用 slash 菜单靠的就是那个 filter 数组 |
| 11 | **资源 GC + 附件正文 FTS5** | 中 | 未用/缺失资源分析、改名重写引用、搜 PDF 正文 |
| 12 | **`kernel/mcp/`**（已在树里） | 中 | 对 agent 工作流的用户是全树最被低估的资产 |
| 13 | **Obsidian 分阶段导入** | 中 | Obsidian vault 就是 Markdown-as-truth，与 Noema 数据模型最近 |

**明确不要**：`asset/pdf/*`（要 PDF 直接 vendor 上游）· `menus/protyle.ts` · `block/{Panel,util}.ts` · `config/bazaar.ts` · `sync/syncGuide.ts` · `scss/protyle/*` · `scss/business/_av.scss` · `scss/pdf/*` · `types/protyle.d.ts` · 整个 `wysiwyg/` · `util/{selection,insertHTML,paste,editorCommonEvent,onGet}.ts` · `gutter/index.ts` · `model/transaction.go` 整体 · `model/render.go`/`block_update.go`/`md2html.go`/`api/lute.go`（全部产 protyle DOM） · 思源的可访问性做法（`aria-label` 里塞 HTML，对屏幕阅读器有害）。

**不要倒过来吃**：Noema 的 mermaid LRU 缓存（思源没有渲染输出缓存）、Noema 的排版宽度算法（plan.md 已列为不可退让门禁）、Noema 的 CM6 undo/list/quote 续行（已有等价物）。

**可清理**：`go.mod` 里的 `dejavu`（声明但零 import）、`go-ical`/`go-vcard`/`go-webdav`（caldav 删后无 importer）。

---

# 六、三条与既有决策冲突的点：结论

三条都判为**不做破坏性动作**，因此可以先落定、后续要改随时能改。

## 6.1 前端插件系统 —— 明确不迁移上游 runtime

`plan.md` 写过"插件运行时 + roamlookup：移除；Copilot 是内建"。但那条决策针对的是 **Go 侧的 `kernel/plugin/` goja 沙箱**（6,900 行，已在 Phase 0 删除），理由是安全沙箱的复杂度。

前端 `app/src/plugin/` 是另一回事：本质是"用户脚本 + 事件总线 + dock/tab 注册"，900 行无 protyle 耦合，不含任何沙箱。它与那条决策的**理由**不冲突，但也不在关键路径上——Noema 目前没有第三方扩展的需求方。

**最终结论：不迁移。** layout/dock 已由 Noema-native 引擎落地；当前只有 bundled Copilot 的明确需求，不引入上游第三方脚本 runtime 或其 API 兼容负担。未来若出现真实扩展需求，应围绕 Noema 的安全 preload、Markdown 数据面与双宿主契约重新设计，不以旧 runtime 为依赖。

## 6.2 文档历史 —— 保留，不删

`model/history.go` + `history_diff.go`（2,513 行）**目前还在树里**。`plan.md` 定的是"版本历史用 git，不用 dejavu 快照"——但那条针对的是 `repository.go`（dejavu，3,084 行，已删）。这套按时间戳存文件的自动存档是**另一个东西**，git 替代不了其中三样：

- 亚分钟级自动存档粒度（`Conf.Editor.GenerateHistoryInterval`），git 只有用户显式 commit 的时点
- 历史记录自带独立 FTS5 库（`history.db` / `histories_fts_case_insensitive`），能全文搜自己的历史版本
- `history_diff.go:147 DiffDocVersions` 的结构化版本 diff

**结论：不删。** 它当前是完全休眠的（没有任何 Noema 代码调用），零维护成本，删掉却是不可逆的。真要做 git-log-backed 历史时，这三样是现成的参考实现。⚠️ 注意 `plan.md` 顶部"删除清单"里没有列它，所以这里不存在推翻决策，只是把"它还在"这件事记下来。

## 6.3 `app/appearance/covers/`（19MB）—— 明确不迁移

`plan.md` 按"一点点挪"原则没有迁入这批装饰性封面图。Noema 没有任何代码引用它。

`header/Background.ts`(929) + `coverData.ts`(70) 那套封面图/文档图标系统确实会给这 19MB 一个落点，但那是一个尚未排期的前端功能。**在功能真的开工之前搬进来，正是"提前搬进来占地方"——恰好是那条原则要避免的。**

**结论：不迁移。** 若未来产品需要封面系统，应从产品规格和许可清单重新选材，不依赖已退役的上游 checkout。

---

# 七、终态收口（2026-08-26）

审计总排序已全部得到产品终态，不再有“只因上游代码还在就算完成”的条目：

| 序 | 终态 | canonical 证据 |
|---|---|---|
| 1 | 完成 | `src/platform-compat.ts`、`hotkey.ts`、`dom-ancestry.ts`、`transient-surfaces.ts` 已接生产与测试 |
| 2 | 完成 | b3 component/theme 系统进入 renderer；安装版 smoke 为 22/22 surfaces、`unadopted: []` |
| 3 | 完成 | Office list、AV 列宽、图片暂停、标题编号、格式刷、Tree/Wiki 和 CM6 等价边界均有聚焦测试 |
| 4 | 完成 | `src/menu-system.ts` 已替换生产 context menu，并接异步 submenu、键盘模型和 54px 定位 |
| 5 | 完成 | canonical `kernel/cli/` 已支持 Markdown box、同步任务排空和文档列表 |
| 6 | 不采用 | 实验版 layout/dock 曾接入，后因制造 App/Emacs 外壳分叉、默认 tabbar 和三边常驻卡片而完整移除；Split 使用原生新窗口平铺 |
| 7 | 完成 | 自包含 HTML、图片等待/宽度修复与 Electron 原生 PDF 全文档打印均进入生产 |
| 8 | 完成 | portable AV 覆盖 17 类型、17 算子、嵌套 AND/OR、相对日期与 22 种聚合，Go/Node fixtures 对拍 |
| 9 | 完成 | Aho-Corasick virtual references、10 分钟有界 cache 与 Knowledge Mentions 已接线 |
| 10 | 完成 | 多字符/闭合符、触发互斥、多语言过滤、晚到响应与完整键盘状态均由 Noema-native hint 链覆盖 |
| 11 | 完成 | Markdown attachment 缺失/未用扫描、安全改名与引用重写、PDF/Office/text FTS5 搜索已接生产 |
| 12 | 完成 | MCP descriptor、Noema 品牌、Markdown-native document tools 与生命周期测试已完成 |
| 13 | 完成 | Obsidian vault 以 staged/atomic、可取消的 Markdown-native 导入落地，保留结构、资源、wiki/block refs |

装饰性 covers、Pandoc bundle、protyle/mobile、云/同步/加密、goja 插件 runtime、DAV 与 OIDC 明确不采用；这是产品裁决，不是延期任务。`go mod tidy` 同步清除了这些已裁剪子系统留下的 144 行模块记录。SiYuan/Overleaf/Jupyter 等实际改编来源继续由 `NOTICE` 和直接改编文件头保存，不需要保留完整 checkout 才能履行。

迁移期上游 checkout 已在全部功能与首次正式门禁通过后移出仓库，保存在废纸篓 `Noema-reference-20260826` 以便人工恢复。移除后重新验证：

- 路径扫描没有任何源码、构建配置或文档依赖；剩余英文 `is-reference` 包名与 footnote reference 只是语义同名。
- `make test`：206 files passed / 7 skipped，2004 tests passed / 16 skipped。
- `go test ./...`：全树通过；attachment FTS5、Obsidian import、MCP Markdown 三条聚焦 FTS5 端到端测试通过。
- `make build` 与 `make install`：在 checkout 缺席状态下成功。
- 安装版 smoke：`hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px，Back / Forward / Refresh / Editor actions / Window actions 齐全；共享编辑器只挂载一次、无 workspace iframe/三边 rail；owned kernel listening 且发布 `mcpUrl`。
- Emacs full-project link 正确，小写旧入口缺席；7 个历史资产入口全部解析到 canonical `resources/`。

因此 Noema 的源码、构建、测试、安装包、运行时与兼容资产均已独立。
