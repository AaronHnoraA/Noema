# Noema × SiYuan 重构计划

> **⚠️ 2026-08-25 起，Go 内核的唯一代码位置是** `/Users/hc/HC/SOURCE/Noema/kernel/`（Noema 主仓库、`main` 分支）。`app/appearance/`、`app/stage/auth.html` 作为 `kernel/` 的同级目录一起迁入，以保持内核相对路径契约。原始上游 checkout 只用于迁移期取证，终态不属于 Noema 源树。

## 工作方式约定（Aaron 明确要求，持久化在这里，不要只留在对话里）

- **本文件（`/Users/hc/HC/SOURCE/Noema/plan.md`）是唯一权威、活的进度记录**，不是快照。每做完一步就更新一步（"每做一步更新一步"）——不要攒到一个大总结再补，也不要让它变成开工前那一版一次性快照后就再也不碰。
- **代码必须进入 canonical 项目结构，不能靠仓库内的上游副本运行。** 原始 checkout 与 fork 历史只用于迁移期取证，不是产品组成。
- **最终必须删除整份上游 checkout，让 Noema 彻底独立**（Aaron 2026-08-26 明确要求）。删除前把决定保留的源码、测试、规格和必要版权信息迁入正式树，并证明源码、构建、测试、文档及安装包都不依赖该 checkout。
- **搬迁方式是增量的，不是一次性大搬家**（"一点点写一点点挪"）：只把实际采用并验证过的部分迁入正式结构。`app/pandoc/`、装饰性 covers 和未采用的 protyle/mobile 前端经审计明确不迁移；这是一项产品决定，不是遗留待办。
- 这些要求本身也要留在这份文档里，供以后的会话/协作者直接看到，不用重新问一遍。

## Context

Noema 现在是：CM6 编辑器（Markdown 为唯一真相源）+ App/Emacs 共用的 Node web host + Go/SQLite/FTS5 数据 kernel + Emacs xwidget 宿主 + Electron 桌面系统适配层。Electron 只做窗口、菜单、preload、拖放和系统对话框；Jupyter/Copilot、API facade 与 Go supervisor 都只存在于共享 Node host，不在两个宿主重复开发。

SiYuan 恰好把这几件事做到了工业级：`.sy` 块树 + `blocktree.db` + `siyuan.db`（FTS5，自定义 tokenizer）+ 601 个 API + 成熟的 b3- 设计系统。但它的存储格式（`.sy` JSON，文件名即块 ID）和编辑器（protyle，contenteditable + 内核回传 HTML 打补丁）都和 Noema 的核心约束互斥。

**本次重构的目标**：以思源仓库为底座，删掉与 Noema 冲突的层（protyle / mobile / 云 / 快照同步），把 Noema 的 CM6 编辑面、私有语法、roam/agenda 语义搬进去，后端统一成 Go。要拿到的是：块引用 + SQLite/FTS5 索引与搜索 + 属性视图 + 思源的 UI 设计。要守住的是：**md 文件 + org-env(meta) 结构为真相源、git 分发、Emacs 直接编辑、CM6 手感零回归**。

---

## 关键决策（已定）

| 项 | 决定 |
|---|---|
| 存储 | `.md` + 现有 org-env/meta 结构为唯一真相源；Lute/SiYuan 块树只是可丢弃的内存/索引投影，Markdown 路径禁止 `WriteTree` |
| 页面身份 | 只认前 12 行内完整 `#+begin meta` 的 `id`；旧文档 IAL 仅回读，不创建、不更新 |
| 块身份 | 新内容使用 Noema `{#UUIDv7}`；org-env 的身份写在 opening line；旧 SiYuan 时间戳 ID 仅回读兼容 |
| 块引用 | 新内容使用 `((UUIDv7 "label"))`；旧时间戳引用可读，但 UI/内核不再生成 |
| 编辑面 | **保留 CM6，删除 `app/src/protyle/`（85,771 行）** |
| 外壳 | Emacs xwidget + SiYuan-derived Electron 独立窗口；Electron 只承担 UI/系统适配 |
| 后端 | App/Emacs 统一进入 Node web host；Node 持有 Jupyter/Copilot 与 Go kernel supervisor，Go 负责 Markdown 数据面 |
| 云 | 全部移除（`cloud_service.go` / `sync.go` / `lan_sync.go` / `repository.go`+dejavu / bazaar 网络层） |
| 版本历史 | git（沿用现有 `wiki-sync` / `roam-git` 语义），不用 dejavu 快照 |
| 要吃到的 | 块引用、SQLite/FTS5 索引与搜索、属性视图(attribute view)、b3- 设计系统 |

### Electron 外壳切换（2026-08-25，当前权威状态）

此前所有 Tauri/Rust 打包记录保留为历史验收，但不再代表当前架构。用户已明确撤销 “Electron forbidden” 决策，原因是 Rust/Tauri 冷编译慢且 `src-tauri/target` 曾膨胀到 17GB。当前桌面外壳改为复用 SiYuan Electron 的窗口生命周期、菜单和多窗口经验，并保留 Noema 已有的安全边界：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，渲染层只见窄 `window.noemaDesktop` preload API。

- `desktop/main.mjs` 只启动共享 `web-host.mjs`（Electron executable 以 `ELECTRON_RUN_AS_NODE=1` 运行）；Node supervisor 再发现、启动、重连和回收 Go kernel。Emacs 仍启动同一 web host，xwidget/Appine、gateway、buffer/key adapter、Jupyter 和 Copilot 路径不变。
- 本地 `make` / `make build` 只构建 renderer + FTS5 Go binary，并从锁定的 Electron runtime 组装链接 App；没有 Cargo/Rust。Electron Framework regular files使用 hard link，symlink 保持原链接，主 executable 使用 APFS clone；Chromium 只在 `node_modules/electron` 保留一份物理数据。
- `make install` 只允许 link 模式：在 `/Applications` 创建真实的事务 App 外壳，Framework 文件继续 hard-link，仓库 `Resources/app`、Go binary 和 icon 保持链接，主 executable APFS clone；安装完成删除 `build/electron` staging，不再复制第二份完整 App。
- TOC 仍是原 floating popover；Page/stats 双击打开 Knowledge dock。桌面 smoke 已在 build bundle 上验证 preload、54px titlebar、五项标题栏控制、TOC、双击 Knowledge dock、八视图 Agenda、KaTeX macros 与 shared Node-owned Go kernel；正式 `make test/build/install` 与安装包 smoke 已完成，并在本节及 Phase 4 的最新门禁记录中持续复验。

**Electron 切换正式门禁与空间清理完成（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下最终顺序执行 `make test`（163 files passed / 7 skipped，1576 tests passed / 16 skipped）、`make build`、`make install` 全过；完整 Electron 桌面构建约 5 秒且没有 Cargo/Rust。安装包 smoke 报告 `hostMode:desktop`、`preload:true`、54px、五项标题栏、独立 TOC popover、Knowledge 双击入口、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 以及 Node-owned/listening Go kernel。Emacs `jupyter-test` 四组 87+24+18+12 共 141 项全过。安装后的 Framework 与 `node_modules/electron` 对应文件 dev/inode 完全相同，`Resources/app`、kernel、icon 都指向仓库唯一真相源，staging 与安装事务目录为空；去重物理统计中 `/Applications/Noema.app` 仅增加 44KB。

空间方面已永久删除可再生且无人持有的 17GB `src-tauri/target`、1.1GB 旧 `release`、139MB 旧 sidecar、541MB 旧 lowercase Electron profile（539MB 为 Cache/Code Cache）、92MB Tauri WebKit cache、193MB Node sidecar 下载缓存、18MB dual-sidecar 临时副本以及旧测试日志，总计确认约 19GB；`src-tauri/` 和两个 Tauri 构建脚本已退役。保留 131MB canonical `com.noema.desktop` 状态（主要为 Jupyter state 与 Go workspace）、76MB Go binary、19MB renderer 和唯一一份 pinned Electron runtime。Electron `sessionData` 已迁到系统 Cache，smoke 自动清理旧 profile；Makefile 新增 link-only install、staging/legacy release 清理、`clean-cache` 与 hard-link-aware `disk-audit`。默认笔记根无 `.siyuan`，Emacs full-project link、7 个 shared resource links 和 retired lowercase path 规则通过，退出后无 packaged Electron/Node/Go PID，`git diff --check` 干净。

### 身份模型校正与当前实现（2026-08-25，当前工作树）

Phase 1 早期实现曾把 Lute 生成的 SiYuan 文档/块 IAL 重新格式化回 Markdown。这个方向与 Noema 已确定的 portable identity 冲突，下面 §1.1、§1.2 和 Phase 2 进度记录里关于“写回文档 IAL”“新建 kramdown IAL 徽章”的叙述只保留为历史调查记录，**不再代表当前实现或后续方向**。当前权威规则如下：

- `kernel/filesys/markdown_identity.go` 从完整的 leading meta 读取 `meta.id`，把 UUIDv7 确定性投影成合法的 SiYuan-shaped 内部 root key；没有 meta 的页面从 `box + path` 得到 provisional key。投影只服务现有 blocktree/SQL 接口，绝不写入 Markdown。
- `filesys.LoadTree` 在内存里移除 Lute 合成的文档 IAL并清掉临时块 ID；`filesys.WriteTree` 对 Markdown box 明确返回 `ErrMarkdownTreeWriteUnsupported`。`LoadMarkdownDoc`、增量索引、全量索引、watcher 都不再调用格式化写回，因此读盘、索引和 watcher 只读源文件。
- CM6 Visual 模式显示 Noema `{#UUIDv7}` 块锚点；`((UUIDv7 "label"))` 是原生引用。旧 `20260825095344-8w75nfv` 形式仍能显示和进入既有反链索引，但不会被新建。原先尚未提交的 `kramdown-ial.ts` 已删除，避免把兼容格式塑造成产品语法。
- 已有聚焦门禁：CM6 block-anchor/block-ref 13 个用例、`tsc --noEmit`、filesys identity/load/write 测试、FTS5 save/watcher/backlink 测试均通过。身份测试覆盖前 12 行边界、完整 meta、summary 隔离、legacy fallback、canonical/provisional 投影稳定性和源字节不变。

**external Markdown box registry 已落地（2026-08-25，当前工作树）**：

- `conf.BoxConf` 新增 `root` 与 `repositoryId`；`data/<internalBoxID>/.siyuan/conf.json` 是只含注册信息的 shadow，外部仓库里不创建 `.siyuan/`。
- `filesys.BoxRootPath` 统一路由物理内容根；Markdown load/save/list、全量与增量索引、darwin/non-darwin watcher、mount 都访问原仓库。路径校验仍把读写限制在注册 root 内，隐藏 Git/Noema 状态目录不会进入文档列表或索引。
- `RegisterExternalMarkdownBox` 自动读取 managed `noema.toml repository_id`，请求值与 manifest 不一致时拒绝；同一 repository UUID 换路径会更新既有 shadow，不产生第二个内部 box。删除 box 只删除 shadow/索引，绝不删除外部仓库。
- HTTP 出口：`/api/noema/markdown/registerExternalBox` 与 `listExternalBoxes`。默认测试覆盖原地 load/list、隐藏目录隔离、移动后身份复用与 manifest 冲突；FTS5 测试覆盖原地 save → blocktree/sql 索引 → unregister 后源文件仍完整。

**Go 原生 UUIDv7 块定义/引用已落地（2026-08-25，当前工作树）**：

- `kernel/noema/identity` 统一 UUIDv7 校验和确定性、可丢弃的 SiYuan-shaped projection；页面与块不再各写一份投影算法。
- `kernel/noema/markdown` 是窄 source scanner，不复制 CommonMark parser：只识别 trailing `{#UUIDv7}`、语义 org-env opening identity、`((UUIDv7 "label"))`，并屏蔽 fenced/indented/inline code、数学区和非语义 org-env；同文档重复定义产生 diagnostics，不进入块索引。
- `filesys.LoadTree` 在清理 Lute 临时 ID 后，把 canonical block UUID 映射到最小对应 AST block，canonical ID 仅留在内存 IAL；SQL refs 在入库边界映射到 disposable ID。load/save API 返回 canonical ID，新增 `/api/noema/markdown/resolveBlock` 把 canonical UUID 解析为 `notebook/path/line`。
- markdown-box lab 已消费 block widget 的 `aaronnote:open-block-ref` 事件：调用 resolve API，跨文档打开目标，并由 CM6 把 1-based line 转成源 offset 后滚动。widget 仍保持 host-agnostic。
- 新 FTS5 端到端测试验证：canonical UUID target/ref → blocktree + refs → canonical `GetBacklink` → resolve path/line；SQL ref 的 Markdown 保留原 UUID，两个源文件字节不变且没有 SiYuan IAL。旧时间戳引用兼容测试继续通过。

阶段性门禁：`noema/... filesys/... treenode/... sql/... api/...` 全过；`model/...` 仍是既有 5 个环境基线失败（1 个加密资产期望差异 + 4 个 macOS 临时目录/Obsidian symlink 判断），新增聚焦与 FTS5 测试全部通过。CM6 + lab navigation 15 个用例和 `tsc --noEmit` 通过。

**正式 Tauri 双 sidecar 打包已落地，运行生命周期现已统一（2026-08-25，当前工作树）**：

- Go kernel 现在与官方 Node 26.5.0 一样作为 `externalBin` 打进 `Noema.app`；`app/` appearance/stage 资源进入 bundle。最初实现曾由 Tauri 先启动 Go 再启动 Node；按后面的“双宿主后端边界重新收敛”，当前 Tauri 只启动 Node web host，Go 的发现、启动、端口、box、重连和退出全部由这份共享 web host 管理。现有页面、Jupyter、Copilot、Emacs adapter 均未删除或替换。
- 共享 Node supervisor 等待 kernel `bootProgress=100` 后把本地笔记根注册成原地 external Markdown box；`/health` 和 HTML adapter 注入统一报告动态 base/status，markdown-box lab 不要求手填打包态端口。App/Emacs 都使用同一状态机；正常退出与异常失联都会回收 Go，Rust 不再维护重复的 `kernel_status` command 或第二套关机逻辑。
- `prepare-tauri-sidecar.mjs` 用 `-tags fts5` 构建目标 triple 的 Go sidecar；macOS 构建脚本新增真实 Rust 链接探针，避开“SDK 声称支持 arm64、但固定 Rust 1.85 + macOS 11 实际无法链接”的新版 SDK。正式包已确认同时含 arm64 `noema-node`、`noema-kernel` 与 18MB `Resources/app`。
- 验收：Rust 6 个宿主单测、TypeScript、Go 聚焦测试、独立双进程 smoke 均通过；`make build`、`make test`（144 files passed / 7 skipped，1503 tests passed / 16 skipped）、`make install` 全过。安装包 smoke 报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、五项标题栏控件齐全，另有 `kernel.state: listening`；默认笔记根没有 `.siyuan`，shadow 只在 App Data 的 kernel workspace。Emacs `lisp/roam/Noema` 和 7 个共享资产入口均解析到本仓库/`resources/`，retired `lisp/roam/aaronnote` 不存在。

**生产 Markdown load/save facade 已落地（2026-08-25，当前工作树）**：

- `server/lib/kernel-markdown-provider.mjs` 把默认笔记根内的 `.md`/`.markdown` 安全映射为 external box 相对路径，生产 `loadDoc`/`saveDoc` 都经 Go；realpath 边界会拒绝相邻目录、非 Markdown 和逃逸 symlink，kernel 返回的保存字节只要与 CM6 送入内容不同就报错，禁止静默格式化源文件。
- Node 的 `readNote`/`saveNote` 只注入了底层 source provider，原有空覆盖保护、`baseVersion`/mtime 冲突检查、同客户端 seq 过期抑制、保存队列、note summary/index 失效和宿主广播全部保留。provider 仅在 `hostMode=desktop` 且 kernel/box ready 时安装；Emacs、Server reader、`/fs:` gateway 和默认笔记根外的 standalone Markdown 没有改路。
- kernel 读取失败时保存失败关闭，不会退化成未经版本校验的 Node 直写；Go `filelock.WriteFile` 本身仍是临时文件 + rename + fsync 的 safer write。新增 provider 路径/逐字节协议测试与 Node policy 集成测试，精确 Node 26.5.0/npm 11.17.0 下 29 个相关测试通过。
- 真实双进程端到端：生产 `/api` 打开并保存一个带 UUIDv7 `meta.id` 的文档，随后 Go `loadDoc` 返回完全相同的 Markdown、1 个 document block 和原 canonical UUID；停掉 kernel 后同一生产打开请求返回 HTTP 500 `fetch failed`，证明生产流量确实经过 Go、没有磁盘回退假阳性。

**生产搜索 facade 已落地（2026-08-25，当前工作树）**：

- desktop 的 `aaronnote:api:knowledge:search` 与 `wiki:search` 普通词项查询现在调用 Go `/api/search/fullTextSearchBlock`，限定到已注册 external box；Go 的 `box/path` 命中再与生产 Wiki catalog 合并，UI 继续收到既有 `WikiNote`、facets、分页与高亮 excerpt 形状。
- 空查询/related 推荐仍用 Node 关系排序；`tag:`、`title:`、`repo:`、`namespace:`、`path:`、`kind:`、`linksto:`、`is:`（含负过滤）仍用现有 Wiki SQLite 查询，避免第一步 FTS 迁移破坏结构化搜索。Server reader 也完全不受影响。
- 路径合并只接受当前 box 且同时存在于生产 catalog 的 Markdown 页面，不把 stale/其他 box 命中暴露给 UI。精确 Node/npm 下，与 load/save 一起的 32 个聚焦测试通过。
- 真实生产 API 验证：`production facade` 经 Go FTS5 返回 `Facade integration` 和 Go `<mark>` 转换后的 excerpt；停掉 kernel 后普通词项查询 HTTP 500，而 `repo:legacy` 仍由 Node 返回 HTTP 200，证明新路由和兼容分流都实际生效。

**生产反链与图谱 relationship facade 已落地（2026-08-25，当前工作树）**：

- 新增只读 `/api/noema/markdown/listRelationships`：Go 在 flush SQL queue 后用 root blocks + refs 一次返回当前 Markdown box 的去重、稳定排序 `fromPath → toPath` 页面边，不把 disposable SiYuan projection ID 暴露给 Node。现有 canonical UUIDv7 FTS5 反链测试同时锁定 `/citing.md → /target.md`。
- desktop Node 以 realpath-safe box path 把这些边合并回 notes/Wiki catalog 的 portable page ID；采用 union 而非覆盖，因此 Go 原生 `((UUIDv7 "label"))`、Node `[[Wiki Link]]`、tag/dependency 关系可共存。bootstrap/list/index/roam-index/knowledge 与 workspace graph 都消费 overlay；Emacs/Server 没有 kernel overlay。
- `notes:graph` 的节点/标签/缺失页与 UI payload 形状仍由现有稳定投影负责，但引用边来自 overlay，并报告 `relationshipSource: kernel-refs`。这一步同时让浮动 TOC backlink、related 推荐、本地图谱和 workspace graph 读到 Go native ref，不引入 N+1 `getBacklink` 请求。
- 真实生产验证：Go endpoint 返回 `/citing.md → /target.md`；`notes:list` 的目标页出现来源页面 UUID backlink；`notes:graph` 返回同一条 source page UUID → target page UUID 有向边，`edgeCount: 1`、`relationshipSource: kernel-refs`。

**生产 planning/todos/agenda 只读数据面已落地（2026-08-25，当前工作树）**：

- 新增 `kernel/noema/planning` span-aware parser，结构契约对齐 `shared/planning-dsl.mjs`：保留 todo/itodo/project/milestone/clock、inline/bare/block/plain-title 形式、原始 attrs/raw、诊断顺序和 meta-summary 隔离。Go 内部按 UTF-8 字节安全切片，对外 `from/to/column` 转成 JavaScript/CodeMirror 的 UTF-16 code units，中文与 emoji 前缀不会让后续 patch 坐标漂移。
- `shared/planning-fixtures.json` 由 JS 测试和 Go 测试共同消费，当前覆盖 quoted comma、转义括号、inline math、UTF-16 span、块属性、title forms、无效 date/repeater/duration/unknown key 诊断及未闭合 block 抑制；不是各自维护两份看起来相似的 parser 测试。
- 新增只读 `/api/noema/markdown/listPlanning`，可按单个 `.md`/`.markdown` 路径或整个 external box 返回稳定排序的 planning documents/nodes；扫描不写源文件、索引或 shadow。`ListMarkdownDocs` 同步补齐大小写无关的 `.md`/`.markdown` 识别。
- desktop 安装 `kernel-planning-provider.mjs` 后，生产 `getTodos` 与 `buildAgenda` 会对当前 Markdown box 做一次 bulk Go scan，再由 Node 只投影既有 note/Wiki 元数据和 agenda/gantt/clocktable 返回形状；单文件请求走 Go 单文档 API。Emacs/Server reader 不安装 provider；kernel 暂时故障时保留 JS scanner 兼容回退。agenda persistent cache schema 升到 2，避免升级后的第一次请求误用旧 JS-parser payload 绕开 Go。
- focused 门禁已通过：Go shared fixtures + planning model/API，TypeScript planning/provider/runtime 及完整 todo/agenda/clock 聚焦组共 102 个用例。随后全量与安装包门禁也已完成，见下面“planning 批正式门禁”。

**生产 planning 写入数据面第一批已落地（2026-08-25，当前工作树）**：

- 新增带 `expectedVersion` 前置条件的 `/api/noema/markdown/mutatePlanning`。Go 在同一 external box/path 锁内重读当前源文件、校验 SHA-256 version，再按 UTF-16 span + 原始 source（或 stable id/title/open clock 兼容 selector）定位节点；支持 exact `replace`、`insert-after` 和 `append`，版本或节点已经变化时明确冲突，不会在旧坐标上盲写。
- mutation 只替换所选 planning source，UTF-16 坐标会安全换回 UTF-8 byte boundary；真正变化后复用 `SaveMarkdownDoc` 的临时文件 + rename + fsync 路径并刷新 blocktree/FTS5。返回值带 from/to、旧/新 source、next version/mtime 和重新扫描后的 node，调用方无需用猜测的 offset 更新本地状态。
- `shared/planning-mutation-fixtures.json` 同时由 Go model 测试和纯 JS contract helper 消费，现覆盖 emoji 前缀后的 UTF-16 replace、inline todo 所在线后的 clock 插入和新文档 append；另有真实 `-tags fts5` 集成测试锁定“落盘字节正确且索引重建”，不是只测内存字符串。
- desktop `kernel-planning-provider.mjs` 已接入 mutation API。生产 `updateTodoStatus`、`patchTodo`、`completeTodo`、stable todo id 补写、`createTodo`、`clockIn`、`clockOut` 仍保留原有 Node per-file save queue/global clock queue 和返回协议，但 read-locate-write 已改为 Go versioned mutation；遇 409 只刷新并重算一次，第二次冲突交给现有错误通道，不吞掉并发编辑。Emacs/Server reader和未提供 mutation 能力的自定义 provider 继续走原兼容路径。
- `createTodo` 在 desktop 下会先读取 missing/empty document 的 Go version，再提交一次 `append-todo` semantic mutation；payload 只有 title/status/canonical attrs，没有预渲染 `source` 或 `initialContent`。Go 在同一 CAS 与全局 ID 临界区内扫描当前 Markdown box、用 crypto-random base36 分配无冲突的 6 位 planning ID，规范化 status/date/prio/progress/repeat，生成 todo source；缺失/空文档同时由 Go 创建 UUIDv7 `meta.id`、文件标题/meta 与首个 todo，已有文档只追加。Node 保留 per-file queue、409 单次重试和返回投影，Emacs/Server 未安装 provider 时仍走原兼容 writer。
- `shared/planning-semantic.mjs` 把原先藏在 runtime 内的 canonical patch/repeater serializer 抽成 Node fallback 与 fixture 共用的显式契约；`kernel/noema/planning/semantic.go` 镜像同一语义。desktop provider 现在提交 `patch-todo`（canonical attrs/status/op/now）、`patch-node`（clock close attrs）和 `insert-clock`（from/task），不再提交预渲染 replacement/clock source；Go 负责保留源中已有 `due`/`deadline`/`scheduled` 等 alias、日期/优先级/progress/repeat 规范化、repeater 滚动及 done/log、inline/block attrs 和 clock title/source 序列化。
- `shared/planning-semantic-fixtures.json` 同时被 JS、Go serializer 和 Go atomic model 消费，覆盖 alias/order、repeater completion、block shape、clock close 与 clock insert；真实 FTS5 测试也已改为执行 semantic `patch-todo` 后检查落盘与重索引。desktop provider 集成明确断言 patch/complete/id payload 没有 `mutation.source`，并覆盖 clock-in/out；6 个相关 TypeScript 文件 114 项及 Go semantic/model/FTS5 聚焦组全过。
- `append-todo` 聚焦门禁已通过：Go source semantic、collision retry、UUIDv7 新文档、model CAS/save/reindex（含真实 `-tags fts5`）与 Node provider boundary 共 64 项相关测试全过；provider 集成明确断言 desktop payload 没有 `mutation.source`/`initialContent`。当前 planning create/read-locate-write/serializer/落盘边界至此都在 Go；下一批继续按 Phase 3 清单削减 Node 非 Jupyter/Copilot 数据职责，而不是再保留一层 source writer。

**本批正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（148 files passed / 7 skipped，1513 tests passed / 16 skipped）；`make build` 重新编译 FTS5 Go sidecar并生成 release Noema.app，`make install` 安装成功。安装包确认包含三个 facade 模块；packaged smoke 再次报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、五项标题栏控件以及 `kernel.state: listening`。笔记根没有 `.siyuan`，shadow conf 只在 App Data；Emacs full-project link、7 个共享资产入口与 retired path 规则全部复核通过。smoke 退出时发现 `public/AI`、`public/Bio`、`private/research` 有既有 Git `index.lock`，因此这些仓库的自动同步会重试；本批没有擅自删除可能仍被其他 Git 进程持有的锁。

**planning 批正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（150 files passed / 7 skipped，1516 tests passed / 16 skipped）；`go test ./noema/... ./api/...` 全过，planning model/API 聚焦组全过；固定 Rust 1.85.1 + 构建脚本同款兼容 SDK 下 6 个 Tauri 宿主测试全过。`make build` 已重新编译 FTS5 Go sidecar和 Node host，`make install` 安装成功，安装包内确认存在 `kernel-planning-provider.mjs`。packaged smoke 报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、Back/Forward/Refresh/Editor actions/Window actions 以及 `kernel.state: listening`。在 smoke 的真实 bundled kernel 上直接请求 `listPlanning`，当前 external box 返回 29 篇 Markdown、41 个 live planning nodes（含中文 title 和 UTF-16 span）；不是测试 stub。默认笔记根仍无 `.siyuan`，shadow 只在 App Data；Emacs full-project link、7 个 shared asset 入口和 retired path 规则再次通过。smoke 子进程已退出，无遗留 packaged Node/kernel 进程；本轮 `git diff --check` 干净。

**planning 写入批正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（151 files passed / 7 skipped，1519 tests passed / 16 skipped）；`go test ./noema/... ./api/...`、planning mutation model/API/shared fixtures 和 `-tags fts5` 的真实 save/reindex 测试全过；固定 Rust 1.85.1 + macOS 15.4 SDK 下 6 个 Tauri 宿主测试全过。`make build` 重新生成 arm64 Node sidecar、FTS5 Go sidecar 与 release app，`make install` 安装成功，安装包内确认两个 Mach-O arm64 sidecar和 `kernel-planning-provider.mjs` 都存在。packaged smoke 再次报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、五项标题栏控件及 `kernel.state: listening`。随后在正常启动的真实 bundled kernel 上对当前 planning node 发同 source 的 versioned replace，返回 `changed: false`；使用全零旧 version 返回明确 conflict，复读确认 document version 与 node source 均未改变，因此验证没有改写用户笔记。默认笔记根仍无 `.siyuan`；Emacs full-project link、7 个 shared asset 入口和 retired path 规则通过；本轮 packaged PID/Resources sidecar 均已退出，`git diff --check` 干净。

**agenda + portable 属性视图批正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（153 files passed / 7 skipped，1529 tests passed / 16 skipped）；`go test ./noema/... ./api/...`、属性视图 shared fixtures/API 以及 `-tags fts5` planning mutation/save-reindex 全过；固定 Rust 1.85.1 + macOS 15.4 SDK 的 6 个 Tauri 宿主测试全过。`make build` 重编译两个 arm64 sidecar和 release app，`make install` 成功。packaged smoke 报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、五项标题栏控件和 `kernel.state: listening`。随后正常启动安装包，通过真实 Node facade 请求 portable AV，当前 box 返回 27 个 todo、3 行有界结果且 `evaluationSource: kernel-attribute-view`；同一进程的两日 agenda 返回 `evaluationSource: kernel-agenda`、Gantt/clocktable/projectModel 齐全，证明两条新读模型都来自 bundled Go，不是测试 stub。默认笔记根无 `.siyuan`，shadow 仅在 App Data；安装包内两个 sidecar 均为 Mach-O arm64，shared AV contract/provider 均存在。Emacs full-project link、7 个 shared asset 入口与 retired path 规则通过；验证没有写用户笔记，安装包进程已退出，`git diff --check` 干净。

**agenda dependency/urgency Go 读模型已落地（2026-08-25，当前工作树）**：

- 新增 `kernel/noema/agenda` 与只读 `/api/noema/agenda/evaluate`。输入是 Node 已从 Go planning nodes 投影并补齐 page metadata 后的一次性 todo batch；Go 按输入 ordinal 返回 stable/duplicate ID 处理、`after`/`blocks` 双向 deps、exact/prefix/substring 与 `[[Note]]::text` 解析、broken/ambiguous lints、`effectiveStatus`/`blockedBy` 和 org-style priority/deadline/warn/doing/blocked urgency。过渡期只往返一批轻量字段，不做 N+1，也不把 Node 的 Wiki/Git 页面形状塞进内核。
- `shared/agenda-evaluation-fixtures.json` 被现有 JS reference tests 与 Go package tests 共同消费，覆盖 stable ID 和 reverse blocks、duplicate ID positional fallback、文本歧义、跨笔记标题歧义、lint 顺序、deadline warning window、doing bonus 与 blocked penalty。日期解析复用 `kernel/noema/planning` 的 wall-clock grammar，不另写第三套日期格式。
- desktop `kernel-planning-provider.mjs` 只发送 `id/status/text/file/noteTitle/index/line/canon` 的 bounded projection；`buildAgenda` 合并 ordinal 结果并报告 `evaluationSource: kernel-agenda`。没有 evaluator 的 Emacs/Server provider 或临时 Go 故障仍执行原 JS `resolveTodoDeps`/`todoUrgency`，不会让 agenda 消失。persistent agenda cache schema 从 2 升到 3，升级后的第一次请求不能用旧 payload 绕过 Go。
- 同一 evaluator 已继续接管 Gantt、clocktable 与 projectModel：请求按需追加 bounded projects/milestones/clocks（含 raw args，不含页面正文），返回 tasks/backlog/milestones/lanes/cycle 与缺日期 lint、ordinal clock→todo resolution、task/day/project minutes、running clock、clock span quality lints，以及项目 open/doing/done/cancelled/blocked/progress/effort/clocked 汇总。Node 只把这些模型装回既有 payload；Go 返回 shape/ordinal 不完整时整批回退 JS，避免半套模型混用。
- shared fixture 已扩展到 6 组，除 dependency/urgency 外还覆盖 project lane 派生日期、partial Gantt backlog、milestone lint、clock stable/text refs、duration/effort 汇总、broken clock ref、reversed/overlapping spans 和“有数据问题仍保留聚合”。现有 JS `buildGanttModel`/`resolveClockRefs`/`buildClockModel`/`buildProjectModel`/`lintClocks` 与 Go 消费同一 expected；不是只验证 Go 自己前后一致。
- 聚焦门禁：provider/runtime/agenda/clock 4 个 TypeScript 文件 67 项通过，shared agenda reference 单文件 51 项通过；`go test ./noema/... ./api/...` 全过，API success/missing-body 及共享对拍通过，`git diff --check` 干净。下一轮正式 build/install/package 门禁与 day-bucket/repeat/stats 投影一起收口。
- agenda 最后一段日视图也已下沉：同一 `/api/noema/agenda/evaluate` 可按 `from/days` 返回 `view.range`、day buckets、deadline warning、overdue/scheduled carry、带时间排序、repeat occurrences、completion `logByDay` 和 open/doing/done/cancelled/blocked/overdue stats。desktop production 命中 `kernel-agenda` 后直接消费整批 view，不再执行这段 Node 日期循环；Emacs/Server 或 evaluator 故障仍走原 JS 兼容实现。
- 共享 fixture 增至 7 组，新组在固定 AEST wall-clock 下同时覆盖 overdue + carry、warning、timed scheduled、deadline/scheduled 双锚点重复、done/log 去重和 blocked/stat 汇总。Go package 与真实 Node `buildAgenda` fallback 消费同一 expected；provider 请求和 production runtime 的内核 view 装配另有集成断言。聚焦门禁再次通过：4 个 TypeScript 文件 67 项、`go test ./noema/... ./api/...` 与 `git diff --check` 全绿。

agenda 读模型至此完成；semantic + day-view 这一整批仍需与下面的属性视图首批一起跑正式 `make test/build/install` 和 packaged smoke。Emacs/Server 继续兼容现有 JS 计算，Jupyter/Copilot sidecar 与两个宿主 adapter 都不能为了“看起来完成迁移”提前删除。

**portable 属性视图最小纵切已落地（2026-08-25，当前工作树）**：

- external Markdown box 不再采用旧计划里“块只存 `av-id`、真数据藏在 kernel workspace `data/storage/av/*.json`”的做法；那会让 Git/Emacs 搬走笔记时丢掉视图定义，也违背 Markdown 为唯一真相源。新契约把 query 本身放进 `#+begin av Title … #+end av`：首批支持 `source`（planning/todo/project/milestone/clock）、`columns`、可重复 `filter`（`=`/`!=`/`contains`/`in`/`empty`/`not-empty`）、`sort` 和有界 `limit`。SiYuan 原 AV 存储/API 仍留给 `.sy` box，没有删除或伪装成 Markdown 真相源。
- 新增 `shared/attribute-view.mjs` 与 `kernel/noema/attributeview`；同一组 shared fixtures 锁定 source/column/filter/sort/limit、canonical attrs、稳定排序/截断以及 invalid directive 的非破坏诊断。只读 `/api/noema/attribute-view/evaluate` 接收 bounded planning item projection，返回 columns/rows/total/diagnostics，不接触 `.sy` transaction 或 sidecar JSON。
- desktop production `buildAttributeView` 复用 Go planning bulk scan 后把 todo/project/milestone/clock 送进 Go evaluator，报告 `evaluationSource: kernel-attribute-view`；Emacs/Server 和 transient kernel failure 使用 shared JS evaluator。web-host channel、浏览器 bridge 与 typed API client 已贯通，不删原 agenda/host adapter。
- CM6 的 `#+begin av` 现在在光标离开 source 时渲染异步只读 table widget；widget 只发 host-agnostic `aaronnote:attribute-view-request`，App adapter 负责 API，Source/Refresh 可用，诊断和空值有明确 UI。光标进入 block 会恢复普通 Markdown 源编辑，fenced code 内的字面量不会被截获。当前 Go API/shared、provider/runtime/fallback 和 CM6 共 10 个聚焦用例加 `tsc --noEmit` 已通过。

**portable 属性视图第二纵切已落地（2026-08-25，当前工作树）**：todo 行的 `status` 与已有 canonical attrs（dates/priority/repeat/deps/project/area/phase/goal/effort/progress/owner/tags/context）可在 table cell 内双击编辑；App adapter 通过新的 cell-patch channel 调现有 `patch-todo` semantic mutation，desktop 仍在 Go snapshot version 上做 CAS + 一次冲突重算，Emacs/Server 仍用 per-file queue fallback。text/id/done/log、project/milestone/clock 行保持只读，不能借 widget 绕开对应语义。

row model 现在携带 stable/positional id、source index、file/line。非 editable cell 双击会发 host-agnostic open-row event，App 跨文档打开后把 1-based line 转成 CM6 source offset。实现时抓到一个真实 selector/patch 歧义：`patchTodo` 的 `id` 既曾是 locator 又是 canonical 写入字段，若把 id-less 行的 `#/path:offset` 直接作为 `id` 传入，会把 positional fallback 错写成持久属性。新增只作定位的 `selectorId`，semantic payload 不再把它当 attr；stable id 在外部插行造成 offset 漂移后仍能定位，id-less positional row 漂移则明确 404、不会误改新位置上的另一任务。CM6/server/kernel mutation 聚焦组 16 项、TypeScript 与 diff 门禁通过。

**portable 属性视图第二纵切正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（153 files passed / 7 skipped，1532 tests passed / 16 skipped）；`go test ./noema/... ./api/...`、planning mutation/save-reindex 的 FTS5 聚焦组全过，固定 Rust 1.85.1 + macOS 15.4 SDK 的 6 个 Tauri 宿主测试全过。`make build` 重新生成 release app，`make install` 安装成功；packaged smoke 再次报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、五项标题栏控件和 `kernel.state: listening`。随后用 `NOEMA_ROOT` + 独立 state 目录启动真实安装包，并显式 bootstrap 到只含一篇测试文档的临时 external box：Node facade 返回 `evaluationSource: kernel-attribute-view` 和 stable `#tempav` 行；cell-patch 经 bundled Go CAS 将 `@@todo` 改为 `doing`，直接复读 Go `listPlanning` 得到同一新状态；全零旧 version 的 direct mutation 返回明确 conflict，复读确认没有覆盖新内容。测试全程没有写默认用户笔记，两个临时目录验证后移入废纸篓。安装包三个 Mach-O 均为 arm64，默认根无 `.siyuan`；Emacs full-project link、7 个 shared asset 入口与 retired path 规则通过，packaged 进程全部退出。

门禁同时暴露的宿主 scope 边界已收紧：App adapter 本来已经把 `currentFile` 放进 AV 请求，runtime 现在真正消费它，并用局部 root 做一次 bounded file scan；不再从进程级“最后一次 open”推断当前窗口范围。回归测试先故意打开 note-root 外的 standalone 文件改变 legacy 全局游标，再并发请求 note-root 与 standalone 两个 AV，二者各自只返回自己的任务。desktop scope 内的 planning 仍由 provider 一次 bulk Go scan；Emacs/standalone 与 transient kernel failure 使用同一局部文件集合的 JS fallback。3 个相关文件 13 项、TypeScript 与 diff 门禁通过。

**portable UUIDv7 block properties 只读纵切已落地（2026-08-25，当前工作树）**：权威源语法扩展为 `{#UUIDv7 key=value owner="Aaron He"}`；prose 放在行尾，org-env 放在 opening line，仍是一份可由 Git/Emacs 搬走的 Markdown 真相源，不复活历史 `{: ...}` IAL，也不写 `data/storage/av/*.json`。`shared/block-properties.mjs` 与 `kernel/noema/markdown` 消费同一 shared fixtures，屏蔽 code/math/non-semantic org-env、按 UTF-16 返回 line/index/text/properties，并把重复 UUID 视为 ambiguous、从 AV rows 排除。Visual 模式沿用原 ID badge，但现在收起整个 property anchor；光标触碰仍显示原始可编辑 Markdown。

Go 新增 bulk read-only `listPropertyBlocks`（单文档/整 external box），provider 一次请求映射 absolute files，不做 N+1；production `buildAttributeView` 把 Go property blocks 与 Go planning projection 一起送给同一个 Go evaluator。AV source 新增 `block`（prose + org-env）、`prose`、`org-env`，planning source 明确只包含 todo/project/milestone/clock，二者不会互相泄漏；任意 property key 可直接用于 columns/filter/sort。Emacs/Server 使用 shared JS scanner/evaluator。7 个 TS 文件 29 项、`tsc --noEmit`、`go test ./noema/... ./api/...` 及 property model/filesys 精确组全过；完整 `model` 包仍只有既有 5 个环境基线失败。

**portable UUIDv7 block properties 可编辑纵切已落地（2026-08-25，当前工作树）**：prose/org-env 行的任意合法 property column 现在可双击编辑；`id/text/title/kind/type/env/file/line/note` 始终只读，todo 仍只开放原 canonical whitelist。空值删除属性。shared fallback 与 Go 都按 stable UUID 重新扫描完整源；重复 identity、重复目标 key、畸形 property token、丢失 anchor 全部失败关闭，不接受 positional selector。补丁只替换/插入/删除 anchor 内单一 key，保留正文、其他属性顺序和已有单双引号风格。

desktop 新的 `mutatePropertyBlock` 与 planning mutation 共用 per-box/path 锁和 SHA-256 `expectedVersion`；冲突时 runtime 只重读并重算一次，第二次冲突显式返回。真正变化后仍走 `SaveMarkdownDoc` 的 atomic source write + blocktree/FTS5 reindex；Emacs/Server 走现有 per-file save queue + atomic rename。provider 提供单文档 snapshot/mutation 与 bulk read 两种边界，写入不需要全 box scan。聚焦门禁：7 个 TS 文件 33 项、`tsc --noEmit`、`go test ./noema/... ./api/...`、model/filesys 精确组及真实 `-tags fts5` property write/reindex 全过，`git diff --check` 干净。

**portable UUIDv7 block properties 正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（154 files passed / 7 skipped，1542 tests passed / 16 skipped）；`go test ./noema/... ./api/...`、property/planning/save-reindex 的真实 FTS5 聚焦组全过，固定 Rust 1.85.1 + macOS 15.4 SDK 的 6 个 Tauri 宿主测试全过。`make build` 重新生成 release app，`make install` 安装成功；packaged smoke 报告 `hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px、Back/Forward/Refresh/Editor actions/Window actions 以及 `kernel.state: listening`。

随后用 `NOEMA_ROOT` + 独立 state 目录启动真实安装包，并显式 bootstrap 到只含一篇测试文档的临时 external box：Node facade 的 `source: block` 返回 `evaluationSource: kernel-attribute-view`，精确投影一行 prose 与一行 org-env；分别把 `owner="Aaron He"` 写成 `owner="Noema Team"`、把 `phase=proof` 写成 `phase=review`，direct Go `listPropertyBlocks` 复读得到两项新值和新的 SHA-256 document version；全零旧 version 的 direct `mutatePropertyBlock` 返回明确 conflict，复读确认 `status=draft` 没有被覆盖。测试没有写默认用户笔记，两个临时目录验证后移入废纸篓；安装包 Noema/Go/Node 三个 Mach-O 均为 arm64，默认根无 `.siyuan`；Emacs full-project link、7 个 shared asset 入口与 retired path 规则通过，packaged 进程全部退出。

**portable AV presentation contract 已落地（2026-08-25，当前工作树）**：同一 `#+begin av` source 新增 `view: table|gallery|kanban`；table 仍是默认值，kanban 用 `group: <property>`，省略时默认 `status`，group property 不必出现在可见 columns 里。Go/JS evaluator 继续只做一次 filter/sort/limit，保留同一 rows/cells/stable identity，并仅增加 `view`、`groupBy`、`row.group` presentation metadata；因此 gallery/kanban 不会产生第二套数据源、写入逻辑或 sidecar store。两个新 shared fixtures 已通过 Node 与 Go 对拍。

**portable AV gallery/kanban renderer 已落地（2026-08-25，当前工作树）**：CM6 widget 根据同一 Go/JS model 在 table、responsive gallery cards、horizontal kanban lanes 三种 presentation 间切换；没有复制 query 或 mutation 层。三种 renderer 共用同一 `configureValueCell`，因此 stable row dataset、双击/Enter open-row、todo status select、任意 block property input 与失败回退语义一致。kanban lane 顺序沿用 query sort 后首次出现顺序，空 group 有明确占位；group column 若列入 columns 仍可原位编辑，patch 成功后的既有 refresh 会把卡片移入新 lane。CSS 只新增 widget-local card/lane 样式，没有改 CM6 feature 顺序或编辑器排版变量。新增 gallery/kanban DOM 与事件回归后，CM6 + server 聚焦组 14 项、`tsc --noEmit`、Go shared/API 组及 `git diff --check` 全过。

**portable AV presentation 正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（154 files passed / 7 skipped，1544 tests passed / 16 skipped）；Go shared evaluator/API 聚焦组、`tsc --noEmit` 和 `git diff --check` 全过。`make build` 重新生成 bundled Node、FTS5 Go 与 release app，`make install` 成功；packaged smoke 继续满足 `hostMode: desktop`、preload、54px、五项系统标题栏控件和 listening kernel。

随后用临时 `NOEMA_ROOT` 启动真实安装包：同一篇 portable Markdown 的 kanban 请求由 bundled Go 返回 `view: kanban`、`groupBy: status` 和 `doing`/`todo` 两组 stable rows，gallery 请求返回 `view: gallery` 与 UUIDv7 prose card；经 Node facade 把 `#board-a` 从 `doing` patch 为 `done` 后，Markdown 源变为 `@@todo(done)`，再次 Go 求值得到 `row.group: done`，证明 lane 移动复用真实 CAS/write/reindex/refresh 路径，不是 renderer 私有状态。临时 root/state 已移入废纸篓，无残留 packaged 进程；安装包三个 Mach-O 均为 arm64，默认根仍无 `.siyuan`。

**external Markdown embed kernel probe 已完成（2026-08-25）**：用临时 external box 启动真实安装包，直接请求 bundled `/api/search/searchEmbedBlock`，带 `notebook` 约束的只读 SQL 能同时命中文档根与带 UUIDv7 identity 的 prose block。返回含正确 box/path/hPath、document/projection ID、breadcrumb、Markdown 与 kernel-rendered block DOM；synthetic、格式合法但不在 blocktree 中的 embedBlockID 也能执行查询，异步 query-content index 对不存在的 query block 安全 no-op。因此不需要把 portable embed 伪装成 `.sy` query transaction，也不需要重写 Go 搜索；Node facade 只需生成稳定 synthetic ID、投影结果并把 API 错误显式传回。探针 root/state 已移入废纸篓，未写默认笔记。

**portable `#+begin embed` 纵切已落地（2026-08-25，当前工作树）**：计划里的 compact `#+begin embed :sql SELECT ...` 保持可读；canonical 形式为有标题/UUIDv7 anchor 的 fenced block，body 用 `sql: SELECT ...`（也接受直接以 `SELECT`/`WITH` 开头）。`shared/embed-query.mjs` 负责 identity/options 与 fail-closed 诊断；inline/body 混用、空 query、非 SELECT/WITH 都不会发请求，`heading=0|1|2`、`breadcrumb=false` 作为 portable anchor properties。

desktop planning provider 现直接调用官方 `/api/search/searchEmbedBlock`，传 external notebook 约束、官方只读 SQL 检查所需参数和由 file/block/query hash 生成的稳定合法 synthetic embed ID；返回只投影 absolute Markdown file、path/hPath、canonical/projection/root identity、safe Markdown 和 breadcrumb，kernel Protyle DOM 明确不穿过 facade。runtime 单结果限 200,000 字符、单查询限 100 items；无 Go kernel 的 Emacs/Server 对 raw-SQL embed 显式 501 unavailable，不偷换成另一套搜索含义。

CM6 新 `EmbedQueryWidget` 沿用 measured whole-block/source-reveal 模式，支持 refresh、计数、safe Noema Markdown renderer、结果路径打开与错误/诊断；选择进入 block 时恢复 portable 源码，fenced code lookalike 免疫。专用 CSS 不动既有 feature 顺序。共享 parser/provider/runtime/widget 4 个文件 14 项、额外 sanitizer/source-reveal 回归、`tsc --noEmit`、三个 Node syntax checks 与 `git diff --check` 全过。

**portable embed 正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（157 files passed / 7 skipped，1552 tests passed / 16 skipped）；`tsc --noEmit`、Node syntax checks、focused self-match regression 与 `git diff --check` 全过。`make build`/`make install` 重新生成并安装 bundled Node + FTS5 Go + release app；最终产物 smoke 报告 `hostMode: desktop`、preload、54px、五项系统标题栏控件和 listening kernel。

packaged 临时 external box 中，Node facade 执行一段真实 fenced SQL，返回 `evaluationSource: kernel-search-embed`、唯一 target、正确 canonical absolute file、UUIDv7 canonical ID 与 projection/root IDs；第一次探针还抓到 query SQL 字面量会让承载它的 org-env paragraph 自匹配，现按 query block 自身 canonical UUID 精确排除，并补 runtime 回归后重打包复测为唯一 target。直接 `DELETE` 在 portable parser 层变成 diagnostic，`SELECT ...; DELETE ...` 由 bundled kernel 明确拒绝为 `SQL statement is not single`，两篇 Markdown 字节未变。临时 root/state 已移入废纸篓、无残留 packaged 进程；三个安装包 Mach-O 均为 arm64，默认根仍无 `.siyuan`。

**App Knowledge dock 第一批已落地（2026-08-25，当前工作树）**：数据面无需新增 API——生产 `notes:list` 已把 Go `kernel-refs` overlay 合并进 portable `refs/backlinks`，现有 local/workspace graph 与 knowledge search 也已经消费同一 facade。本批只在 App adapter 中把原浮动 graph panel 编排成固定右侧 Knowledge dock，提供 Backlinks / Graph / Search 三个 tab；Backlinks 展示可解析来源页、路径、摘要和标签并支持主修饰键新窗口打开，状态明确标出 `kernel refs`。Graph 保留 Local / Workspace、depth/ref/back/tag、搜索与 group 控件；切走 tab 会销毁/暂停隐藏图实例，切回再按最新 indexVersion 求值。Search 复用 `aaronnote:api:knowledge:search` 与现有键盘/新窗口语义，没有第二套查询实现。

桌面 dock 打开时宽屏编辑区为其让位，窄屏退化为覆盖层；系统 Editor Actions 与 Navigate 菜单新增 Backlinks，并把 Local Graph 文案校正为 Knowledge Graph。`knowledge-search` 在 App 中打开 dock Search，插入 `roam` link 时仍保留原专用全局选择器。新 `desktop-knowledge-dock.ts` 独立管理 tab、backlink projection、graph 生命周期和 body layout state；Emacs/Server 不创建该控制器，继续使用原 graph 浮层、header/buffer 与搜索 adapter。outline 仍由 CM6 `toc-index`/floating TOC 提供，没有增加 kernel outline 往返。聚焦门禁：dock + local graph + desktop shell 3 个文件 13 项、生产 web bundle、`tsc --noEmit`、`cargo fmt --check` 与 `git diff --check` 全过。

packaged smoke 也已扩展并进入最后复测：只有 Markdown editor route 存在 `.noema-knowledge-dock` 时，它才通过真实 `aaronnote:command` 触发 Backlinks，并报告 `visible/view/tabs/backlinksStatus/top/bottom/width/editorClearsDock`；Wiki route 保持 `knowledgeDock:null`，不会拿静态 DOM 冒充编辑器验收。第一次安装包尝试发现 WKWebView 被 macOS 标记为 occluded 时不派发 `requestAnimationFrame`，原 smoke 因“等两帧”永远不报告，已改为普通 timer。第二次真实报告已确认 desktop/preload、54px、五项标题栏、三 tab、Backlinks view、`top:54`、`bottom:920`、`width:382.8`；当时 `editorClearsDock:false` 是在 160ms editor margin 动画刚开始时取到的中间态，现明确等待 220ms 后再测最终几何。这样下一轮以显式 Markdown 参数启动安装包时，可以同时锁定原 titlebar contract、kernel source 状态和 dock 的实际 WebView 几何。

packaged dock 检查顺带抓到并修了 macOS symlink-root 当前页身份缺口：Rust 打开参数会把 `/tmp/...` canonicalize 成 `/private/tmp/...`，portable note index 则有意保留配置 root 的 `/tmp/...`，原 `currentNote()` 只做字符串全等，导致正文能打开但 Backlinks/Graph 认不出当前页。新 `note-index.ts` 保持 exact file/path/link 最高优先级，仅在失败时用 portable relative path 做唯一 suffix 匹配；多个候选时失败关闭，只有 title 再能唯一消歧才接受。生产 API 已复读证明 `notes:list` 返回 `relationshipSource: kernel-refs`、source→target refs/backlinks 正确；5 个 dock/path 集成文件 22 项、`tsc --noEmit` 与 `git diff --check` 全过。

**App Knowledge dock 第一批正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下最终 `make test` 为 159 files passed / 7 skipped、1559 tests passed / 16 skipped；`make build` 重建 4000-module production renderer、official Node sidecar、FTS5 Go sidecar 与 release app，`make install` 更新 `/Applications/Noema.app`。显式 legacy 临时 root 的 packaged smoke 打开 canonical `/private/tmp` target，通过真实 host command 得到 `backlinksStatus:"1 backlink · kernel refs"`、Backlinks/Graph/Search、`view:backlinks`、`visible:true`、`top:54`、`width:430`、`editorClearsDock:true`，同时保留 desktop/preload、54px、五项系统标题栏和 listening kernel。AGENTS.md 原样 smoke 也通过同一宿主/titlebar/kernel contract。

三个安装包 Mach-O 均为 arm64；默认 `~/Documents/Noema` 与临时 external root 都无 `.siyuan`。Emacs full-project link、7 个 shared asset 链接均解析到本仓库 `resources/`，retired lowercase path 不存在；无残留 packaged 进程，临时 root 与 API 探针 JSON 已移入废纸篓，`git diff --check` 干净。

**App Knowledge dock 第二批已落地（2026-08-25，当前工作树）**：同一 App-only dock 现扩展为 Backlinks / Outline / Graph / Search / Tags 五个 tab。Outline 直接从当前 CM6 document 的 `toc-index` 投影 heading 文本、层级、位置与光标所在项，点击用现有 editor selection/reveal/focus 语义定位，不请求 kernel outline。Tags 从当前 Markdown meta 与 portable `notes:list` 汇总去重计数，区分 Current note / Workspace，点击复用 `openTagFilter`；没有新 tag store 或私有查询。dock controller 增加统一 state callback，切 tab、Close 和 host command 都会同步 Outline 按钮状态；原生 Editor Actions / Navigate 菜单增加 Tags，Page Outline 原命令在 App 里打开 dock，Emacs/Server 仍走原 floating TOC、tag modal 与 host adapter。

**第二批聚焦门禁已过（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 dock/note-index/local-graph/floating-toc/desktop-shell/Tauri migration 6 个文件共 35 项全过；新增回归锁定 Outline 层级、active 位置与导航，以及 Tags 分组、计数与 portable filter 导航。`tsc --noEmit`、`cargo fmt --check` 与 `git diff --check` 干净。

**第二批全量测试门禁已过（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 159 files passed / 7 skipped、1561 tests passed / 16 skipped；相比第一批正式门禁新增的 2 项正是 Outline / Tags DOM 与导航 contract。

**第二批 release 构建门禁已过（2026-08-25）**：`make build` 重新生成 4000-module production renderer、official Node 26.5.0 sidecar、FTS5 Go kernel sidecar 和 Tauri release `Noema.app`；Rust release compile 与 app bundle 完成。

**第二批安装门禁已过（2026-08-25）**：`make install` 已用上述 release bundle 更新 `/Applications/Noema.app`，运行时依赖继续使用本地可复现链接。

**第二批 packaged smoke 首轮已过且验收约已加固（2026-08-25）**：隔离 legacy external root 中的真实 block ref 经 bundled kernel 投影为 `1 backlink · kernel refs`；安装包报告 Backlinks/Outline/Graph/Search/Tags 五 tab、Backlinks view、`top:54`、`width:430`、`editorClearsDock:true`，同时保持 desktop/preload、54px、五项 titlebar 与 listening kernel。为了不只验证 tab label，smoke harness 现会先通过真 host command 打开 Outline 与 Tags，采集 status/items，再回到 Backlinks 检查几何。该 harness 改动的 Tauri migration + dock 2 个文件 10 项、`tsc --noEmit` 与 `git diff --check` 已过；因为它进入 production bundle，下面会重跑完整三道门禁后再取最终报告。

smoke harness 加固后的第二轮全量 `make test` 仍为 159 files passed / 7 skipped、1561 tests passed / 16 skipped，没有因生产报告编排引入回归。

加固后的第二轮 `make build` 也已通过：4000-module renderer、official Node、FTS5 Go kernel 和 release app 已全部重生成，新 production `tauri-bridge` chunk 已包含 Outline/Tags 报告逻辑。

加固后的第二轮 `make install` 已成功更新 `/Applications/Noema.app`，最终 packaged smoke 将从这一安装产物取证。

**App Knowledge dock 第二批正式门禁（2026-08-25）**：加固后的最终安装包在隔离 legacy external root 上通过真 host command 依次验证三个生产视图：Outline 报告 `2 headings · CM6 index` 且条目为 `Dock Target` / `Outline child`；Tags 报告 `3 current · 4 workspace tags` 且条目为 `#knowledge/#outline/#smoke/#backlink`；Backlinks 报告 `1 backlink · kernel refs`。最终状态仍为五 tab、Backlinks view、`visible:true`、`top:54`、`width:430`、`editorClearsDock:true`，并保留 desktop/preload、54px、Back/Forward/Refresh/Editor actions/Window actions 与 listening kernel。AGENTS.md 原样 smoke 也通过同一 titlebar/kernel/dock contract。

最终卫生检查：安装包 Noema/Node/Go 三个 Mach-O 均为 arm64；默认 `~/Documents/Noema` 与临时 root 均无 `.siyuan`；Emacs full-project link 和 7 个 shared resource 链接全部指向本仓库，retired `lisp/roam/aaronnote` 缺席；安装包可执行文件无被残留进程打开，临时 root 已移入废纸篓，`git diff --check` 干净。

**App Agenda workbench 纵切已落地（2026-08-25，当前工作树）**：评估确认旧小 Agenda 只是当前文件 `notes.todos` modal，而 week/list/month/log/gantt/projects/clocktable/lints 八视图、编辑与刷新语义已全部集中在共享 `agenda-view.ts`。App 的 `toggle-agenda` 现直接把这一 renderer 挂为底部 fixed workbench；editor 在宽屏为它让出高度，与右侧 Knowledge dock 同时打开时互不覆盖，窄屏退化为 overlay。Close / `q` / `Esc` 会恢复 editor 布局和焦点；跨文件 todo 导航复用现有 source/index/line target，`notes-index-changed` / `agenda-changed` 会刷新打开的 workbench。renderer 把数据面来源显式标为 `kernel-agenda`。Emacs/Server 仍使用原当前文件 quick Agenda，没有改 `my/noema-*` 入口。聚焦 Agenda/desktop/planning 组 6 个文件 43 项全过，后续与构建链改造合并的主组 4 个文件 36 项也全过；`tsc --noEmit`、脚本语法、Make dry-run 与 `git diff --check` 干净。

**本地构建/安装链接模式已改造（2026-08-25，当前工作树）**：`make` / `make build` 继续只走 Tauri + Go kernel + official Node 新模式，并在 macOS 默认 `NOEMA_PORTABLE=0`。Node 仅保留下载/解压缓存，`src-tauri/binaries/noema-node-*` 链接过去；Go 仅保留 `build/kernel/<platform-arch>/noema-kernel`，Tauri input 同样链接。Tauri 出包后把 bundle 内 Node/Go sidecar 与 `web-host/server/shared/dist/js/agents/plugins/jupyter/resources/app/themes/package.json/node_modules` 全部替换为指向仓库真相源的链接。`make install` 默认原子替换为 `/Applications/Noema.app -> release bundle` 整包链接，不再复制第二份 App。`make build NOEMA_PORTABLE=1` 与 `make install LOCAL_APP_MODE=copy` 保留真正可分发的全自包含/复制语义。

**链接构建实包验证已过（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下真实 `make build` 完成 4000-module renderer、Go/Node sidecar 与 Rust release bundle；Tauri 能从 linked sidecar input 正常出包，随后 bundle 内 16 项资源/sidecar 全部改为绝对链接。三个入口用 `file -L` 均确认为 arm64 Mach-O。开发 bundle 从改造前 269MB 降到 18MB，`src-tauri/binaries` 从 214MB 实体副本降到 0B（仅两条链接）；Go kernel 只在 `build/kernel/darwin-arm64/noema-kernel` 保留唯一实体。此时 `/Applications/Noema.app` 仍是 284MB 旧复制版，下一步先直启 linked bundle smoke，再用 `make install` 原子替换并清除该旧副本。

**linked bundle 直启 smoke 已过（2026-08-25）**：Go/Node 两个链接 sidecar 均由 release App 正常拉起，报告保持 `hostMode:desktop`、`preload:true`、54px、五项系统标题栏与 listening kernel。新 App Agenda 为底部 `desktop-dock`，来源 `kernel-agenda`，Week/List/Month/Log/Gantt/Projects/Clock/Lints 八视图齐全；首次报告在 160ms shell 高度动画未结束时过早取样，已把 smoke 改为等 kernel 数据和 220ms 最终几何，23 项 Agenda/Tauri 聚焦测试与 TypeScript 门禁通过。重建后最终报告为 `height:520`、`editorClearsDock:true`、`clearsKnowledgeDock:true`；右侧 Knowledge dock 同时保持五 tab、`top:54`、`width:430`、`editorClearsDock:true`。下一步执行链接安装事务，删除旧 284MB 实体 App。

**旧复制清理完成，整包 symlink/hard-link 两个陷阱均经实机排除（2026-08-25）**：第一轮真实 `make install` 通过事务目录原子换入整包链接，确认旧 284MB 实体 App 只在新入口验证后删除，且没有 `.Noema.app.install-*` 残留。但随后严格从 `/Applications` 执行 AGENTS smoke 时发现：`.app` 外层本身是 symlink 会触发 macOS LaunchServices 接管/重启，shell 注入的 `NOEMA_DESKTOP_SMOKE` 被丢失；若主 executable 也只是 symlink，Tauri 则因无法解析 bundle 报 `unknown path`。真实 App 外壳 + hard-linked executable 虽能直接运行，但 `/Applications` 与 source bundle 共用 inode 后 LaunchServices 又会把安装入口折叠回 source bundle，同样丢环境。最终默认 link mode 采用 macOS 正确且节省物理块的形态：事务创建真实的极小 `.app` 外壳，只复制几 KB `Info.plist`；主 `Noema` 用 macOS 原生 `/bin/cp -c` 做 APFS copy-on-write clone，取得独立 inode但共享数据块；Resources 与 Go/Node sidecar 全部 symlink。构建 bundle 的主程序同样从 Cargo release executable 做 APFS clone，避免普通深复制。Node 的通用 `COPYFILE_FICLONE_FORCE` 在本机真实构建里不支持，已由日志抓出并换成实际验证成功的 `clonefile` 路径；clone 不可用时才退化为仅复制主程序，绝不复制 runtime/resources。新安装事务测试、Tauri/Agenda 23 项、脚本语法、TypeScript、Make dry-run 与 diff 门禁均通过；下一步重建安装并从 `/Applications` 取最终运行证据。

**APFS clone 安装实包与 `/Applications` smoke 已过（2026-08-25）**：真实构建明确报告 `APFS-cloned executable and linked 16 local resources and sidecars`，安装明确报告 `linked app shell`、`executable APFS-cloned`、runtime linked。Cargo release、bundle、`/Applications` 三个主程序 inode 彼此独立，安装 App 是真实目录；其 Resources 和两个 sidecar 都是绝对链接，没有安装事务残留，三个入口仍为 arm64 Mach-O。AGENTS.md 原样命令这次保留 smoke 环境并完整退出：报告 `hostMode:desktop`、`preload:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、listening kernel；Agenda 为 `desktop-dock`、`source:kernel-agenda`、八视图、`height:520`、`editorClearsDock:true`、`clearsKnowledgeDock:true`，Knowledge 同时为五 tab、`top:54`、`width:430`、`editorClearsDock:true`。下一步只剩最终顺序全量 `make test` / `make build` / `make install` 与卫生复核。

**最终全量测试门禁已过（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 159 files passed / 7 skipped、1563 tests passed / 16 skipped；相比 Knowledge 第二批最终基线新增的两项覆盖 Agenda desktop dock 和真实 App shell/APFS clone 安装事务。

**TOC 按最终交互要求恢复 popover（2026-08-25，当前工作树）**：用户明确要求“TOC 恢复 pop，不要抽出的 UI”。因此 App 不再把 `toggle-toc` / Page Outline 映射到右侧 Knowledge dock：Outline 已从 dock 的 view type、tab、pane、controller renderer、CSS 和专属测试中完整删除，`togglePageOutline()` 在 Desktop/Emacs/Server 统一只调用原 `floatingTocPanel`，状态栏 Page 按钮和原生 Page Outline 菜单都恢复既有 popup 语义。Knowledge dock 保留 Backlinks/Graph/Search/Tags 四 tab。packaged smoke 不再从 dock 取假 Outline 结果，而是通过真 host command 打开原 `.aaronnote-floating-toc`，独立报告 `tocPopover.visible/status/items`，关闭后再验 Tags/Backlinks/Agenda。desktop dock/floating TOC/Tauri/Agenda 聚焦 4 个文件 38 项、TypeScript、Rust fmt 与 diff 门禁全过；这项改动使上一轮全量门禁失效，下面重新按 `make test` / `make build` / `make install` 顺序验收。

TOC popover 最终全量测试门禁已过：`make test` 为 159 files passed / 7 skipped、1562 tests passed / 16 skipped；比撤回前少的一项正是已删除的 dock Outline 专属测试，原 floating TOC 测试组仍完整通过。

TOC popover 最终 release 构建门禁已过：4000-module renderer、Go/Node sidecar 和 Rust release app 全部重建，构建端继续明确报告 `APFS-cloned executable and linked 16 local resources and sidecars`。

TOC popover 最终安装门禁已过：`make install` 事务更新 `/Applications/Noema.app`，日志确认 `linked app shell`、`executable APFS-cloned`、runtime dependencies linked。

**Knowledge dock 双击入口已补回（2026-08-25，当前工作树）**：在保持“单击 Page/TOC = 原 floating popover”的前提下，tools 的 Page 按钮和状态栏 Page/stats 控件现在都支持双击；双击会先收起可能打开的 TOC，再用 dock controller 的 `show("backlinks")` 强制打开右侧 Knowledge dock，不会把 TOC 重新塞进 dock，也不会因当前已在其他 tab 而误关闭。title 明示 single-click/double-click 语义。packaged smoke 改为真实对 `[data-stats-toggle]` 派发 `dblclick` 并报告 `knowledgeDock.openedByDoubleClick`。同一组 desktop dock/floating TOC/Tauri/Agenda 4 文件 38 项、TypeScript 与 diff 门禁通过；因 production renderer 再变，下面再次跑最终三道门禁。

双击入口最终全量测试门禁已过：`make test` 仍为 159 files passed / 7 skipped、1562 tests passed / 16 skipped。

双击入口最终 release build 已过：production renderer 与双 sidecar 重建完成，日志仍确认 APFS-cloned executable + 16 local links。

双击入口最终 `make install` 已过：`/Applications/Noema.app` 再次事务更新为真实 linked shell，executable APFS-cloned、runtime linked。

**TOC popover + dock 双击入口最终 packaged smoke 已过（2026-08-25）**：AGENTS.md 原样安装入口报告 `tocPopover.visible:true`、`12 headings · 4 tags`，证明单击仍打开原 popover；同一 smoke 对状态栏 Page 控件真实派发双击后报告 `knowledgeDock.openedByDoubleClick:true`，dock 为 Backlinks/Graph/Search/Tags 四 tab、Backlinks view、`top:54`、`width:430`、`editorClearsDock:true`。Agenda 同时保持 `source:kernel-agenda`、八视图、520px、`editorClearsDock:true`、`clearsKnowledgeDock:true`；desktop/preload、54px、五项系统标题栏和 listening kernel 全部保留。

**本轮最终空间/卫生验收（2026-08-25）**：改造前 `Noema.app` release bundle 269MB、`/Applications/Noema.app` 284MB、`src-tauri/binaries` 214MB；现在前两者各只显示 18MB 的 clone executable 逻辑大小且由 APFS 写时复制共享物理块，`src-tauri/binaries` 为 0B 的两条链接，16 项 runtime/resources 均不再复制。旧 284MB 安装实体、旧 sidecar/resource 副本和安装事务目录均已删除；本轮两个实验外壳也从废纸篓精确永久删除（目录视图共 36MB，不可恢复）。smoke 后被 LaunchServices 延迟拉起的三个验证进程已按 PID 清理，复查无 packaged App/Node/kernel 残留。默认 `~/Documents/Noema` 无 `.siyuan`；Emacs full-project link 与 7 个 shared asset links 全部解析到本仓库/`resources/`，retired lowercase path 不存在；`git diff --check` 干净。

**Go `append-todo` 最终正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下 `go test ./noema/... ./api/...` 全过，semantic/model/真实 `-tags fts5` save+reindex 聚焦组全过；`make test` 保持 159 files passed / 7 skipped、1562 tests passed / 16 skipped。`make build` 重建 4000-module renderer、official Node、FTS5 Go 和 Rust release app，继续报告 `APFS-cloned executable and linked 16 local resources and sidecars`；`make install` 事务更新真实 `/Applications/Noema.app` linked shell。

用独立临时 `NOEMA_ROOT` 启动真实安装包后，经生产 Node facade 调 `create-todo`：返回 `@@todo(doing)`、Go 分配的 6 位 stable id、规范化后的 `tomorrow → 2026-08-26`、`priority → prio=A` 和带空格 tags；新 `inbox.md` 的 `meta.id` 是 UUIDv7，且根内没有 `.siyuan`，证明不是测试 stub 或 Node fallback。AGENTS.md 原样 smoke 随后再次报告 TOC popover、双击 Backlinks dock、八视图 `kernel-agenda`、desktop/preload、54px、五项系统标题栏和 listening kernel 全绿。测试 note root 已精确永久删除（不可恢复）；它注册的 external-box shadow 经真实 `removeNotebook` 正常 unindex/unregister，API 自动生成的对应删除历史也精确清掉。复查无临时 root/shadow/history、安装事务、实体 sidecar 副本或 packaged PID 残留；bundle/安装 App 仍各 18MB、`src-tauri/binaries` 仍为 0B links，三个主程序 inode 独立。默认笔记根无 `.siyuan`，Emacs project + 7 shared asset links 与 retired path 规则通过，`git diff --check` 干净。

**KaTeX macros Go 数据面已落地（2026-08-25，当前工作树）**：新增 `kernel/noema/katexmacros`，读取稳定排序的 `*.tex` 并支持 `newcommand`/`renewcommand`/`providecommand`、`DeclareMathOperator` 和 `def`，保留注释、嵌套 brace、override 与 malformed error 形状；`shared/katex-macro-fixtures.json` 同时由 Go 和 JS parser 消费，避免再维护两份看起来相似的契约。新只读 `/api/noema/config/katexMacros` 与 desktop provider 让 App 首屏数学环境及 LaTeX export 的宏包生成优先走 bundled Go，并报告 `source: kernel-katex-macros`；Emacs/Server 以及 desktop kernel 短暂故障继续用原 Node parser，不阻塞首屏。Go package/API、Node transport/runtime fallback 和 shared fixture 共 15 项聚焦测试全过，Node syntax checks 通过；本批生产 bundle 已变化，下面继续跑全量与真实安装包门禁。

**KaTeX macros Go 数据面正式门禁（2026-08-25）**：最终 `make test` 为 161 files passed / 7 skipped、1567 tests passed / 16 skipped；`go test ./noema/... ./api/...`、`tsc --noEmit`、生产 renderer build 和 `git diff --check` 全过。`make build` 再次生成 linked 4000-module renderer、official Node、FTS5 Go 与 Rust release app，`make install` 更新真实 linked shell。正常启动的安装包经生产 facade 返回 bundled `resources/katex-macros`、0 errors 和明确的 `source: kernel-katex-macros`；随后把该断言写进永久 smoke，AGENTS.md 原样命令最终报告 `katexMacros.count:102`、`errors:0`、`source:kernel-katex-macros`，同时 TOC popover、Knowledge 双击入口、八视图 `kernel-agenda`、desktop/preload、54px、五项标题栏与 listening kernel 全绿。最终卫生复核无 packaged PID、临时测试根、安装事务或实体 sidecar，bundle/安装 App 仍各 18MB、`src-tauri/binaries` 仍为 0B links，三个主程序 inode 独立；默认笔记根无 `.siyuan`，Emacs project + 7 shared links 与 retired path 规则通过。

**Markdown asset 写入 Go 数据面第一批已落地（2026-08-25，当前工作树）**：新增 `model.StoreMarkdownAssetBytes` / `StoreMarkdownAssetFromPath` 与 `/api/noema/markdown/storeAsset*`，desktop 粘贴 base64 和原生拖入路径现在由 Go 完成 note-local `images/<note>/` / `attachments/<note>/` 选址、NFKC 文件名清洗、MIME/图片判断、重名避让和 Markdown 相对路径返回；路径导入不再先在 Node 做 base64 中转。分配与落盘处于同一临界区，并拒绝非 Markdown/逃逸路径及通过 symlink 指向仓库外的目标目录；字节写入走 `filelock.WriteFile`，本地文件走流式 `filelock.Copy`。`kernel-assets-provider.mjs` 只在 ready desktop kernel 安装，写入失败关闭以避免“Go 已成功但 Node 重试又复制一份”，Emacs/Server 未安装 provider 时保留原逻辑。当前 model/API 6 项及 Node transport/runtime + 既有 asset 行为 11 项聚焦测试、ESM import、`tsc --noEmit`、syntax 和 `git diff --check` 全过；这批生产代码已变化，下面继续跑完整正式门禁。孤儿扫描/系统废纸篓仍由 Node 持有，是 asset 数据面下一批，不在本写入事务中假装完成。

**Markdown asset 写入第一批正式门禁（2026-08-25）**：`make test` 最终为 162 files passed / 7 skipped、1570 tests passed / 16 skipped；`go test ./noema/... ./api/...`、`make build`（4000 modules、FTS5 Go、official Node、Rust release、APFS clone + 16 links）与 `make install` 全过。真实 `/Applications/Noema.app` 用隔离 `NOEMA_ROOT` 经生产 `aaronnote:api:assets:upload` 写入 6-byte PNG，明确返回 `source:kernel-assets`、`./images/topic/packaged-asset.png`，磁盘只出现这一份 asset；随后用同一正式 kernel API unregister 临时 external box，并精确删除 `/tmp/noema-assets-packaged.*` 与该 shadow 自动生成的单一 delete-history，没有污染默认根或 App Data。AGENTS.md 原样 smoke 再次报告 desktop/preload、54px、五项标题栏、TOC popover、Knowledge 双击入口、八视图 `kernel-agenda`、`kernel-katex-macros` 与 listening kernel 全绿。链接模式仍为 0B sidecar links、18MB bundle/安装 App，三个主程序 inode 独立；`git diff --check` 通过。直接运行整个上游 `model` 包仍只有计划已记录的 5 个环境基线失败（1 encrypted-asset + 4 Obsidian symlink），新增聚焦用例无失败。

**Markdown asset 孤儿扫描 Go 数据面已落地（2026-08-25，当前工作树）**：新增只读 `model.ListUnusedMarkdownAssets` 与 `/api/noema/markdown/listUnusedAssets`，desktop 的 `assets:scan-orphans` 和“移入废纸篓”前后的候选重验都改走当前 external Markdown box 的 Go scanner；macOS Finder / Windows Recycle Bin 移动仍留在 host adapter，不把平台 UI 责任硬塞进 kernel。scanner 与旧契约一致地扫描 `.md/.markdown/.typ`，识别 Markdown destination、HTML `src/href/poster/data-src`、`srcset`、CSS `url()`、Org `[[file:...]]` 与 `#+include`，过滤外部协议/越界路径/隐藏与生成目录，只把 `images/`、`attachments/` 中非 note/Lean 文件列为候选；`public/` 是否为真实 Wiki partition 由 desktop wiring 显式传入。`shared/asset-reference-fixtures.json` 同时约束 Go 与 Node fallback 的路径解码、nested destination、root/roam 和外链过滤；Go 写入/并发/symlink/扫描/model/API 及 Node provider/runtime + fallback 聚焦组全绿（Node 13 项），`tsc --noEmit` 与 `git diff --check` 通过。生产代码再次变化，下面继续正式门禁与实包 orphan scan。

**Markdown asset 第二批正式门禁（2026-08-25）**：最终 `make test` 为 162 files passed / 7 skipped、1572 tests passed / 16 skipped；`go test ./noema/... ./api/...`、`make build`、`make install` 再次全过。真实安装包在隔离根经生产 facade 用 Go 写入一个 PNG 和一个 PDF，随后 `assets:scan-orphans` 稳定返回按路径排序的两个候选（正确 MIME/size/image flag），证明 scan 不是 Node fallback；源根只各有一份资产。验证后在 App 尚运行时经真实 kernel `removeNotebook` 正常注销/反索引，再精确永久清理临时根与唯一自动 delete-history。AGENTS.md 原样 smoke 继续报告 TOC popover、Knowledge 双击 Dock、八视图 `kernel-agenda`、desktop/preload、54px、五项标题栏、`kernel-katex-macros` 和 listening kernel 全绿。最终无本批 PID、temp/shadow/history、实体 sidecar 或默认根 `.siyuan` 残留；bundle/安装 App 各 18MB、sidecar links 0B、三份主程序 inode 独立，Emacs project + 7 shared resource links 和 retired path 规则通过，`git diff --check` 干净。

**双宿主后端边界重新收敛（2026-08-25，当前工作树）**：用户明确要求 Tauri 只做 UI/系统适配，App 与 Emacs 必须共用同一个 web-host 后端，不能在 Rust 与 Emacs Lisp 各维护一套 Go 启动/重连逻辑。审计确认此前实现确有分叉：Rust 先 spawn Go、解析端口、再用 `NOEMA_KERNEL_BASE` spawn Node，而 `web-host.mjs` 又把所有 Go provider 硬限制为 `hostMode=desktop`；Emacs 虽然启动同一 Node host，却永远落回 JS 数据面。当前边界已定为：Node web host 统一拥有 Go 数据 kernel 的发现、启动、健康检查、external Markdown box 挂载、provider 切换、故障降级/重连和优雅退出；Tauri 只启动 Node sidecar并提供窗口/菜单/拖放/原生对话框适配，Emacs 继续只启动 Node 并提供 xwidget/Appine、gateway、buffer/key adapter。Jupyter/Copilot 继续由现有 Node registry/gateway 持有，绝不经 Go 数据 kernel 或 Tauri 重写。`hostMode` 只选择宿主适配器，不再选择两套数据后端；远程 `/fs:` 仍走 Emacs gateway，本地 Markdown root 才接统一 Go 数据面。kernel 缺失或重启期间两个宿主同样保留 Node 兼容路径，单次已进入 Go 的写操作失败关闭，避免重复落盘。上面各纵切中“desktop-only provider / Emacs 永远 fallback”的表述只记录当时里程碑，均由本节当前边界取代。

**统一 web-host kernel supervisor 第一批已落地（2026-08-25，当前工作树）**：新增 `server/lib/kernel-supervisor.mjs`，同一份状态机现在负责 external `NOEMA_KERNEL_BASE` 接管或 canonical binary 自动发现、分块 discovery line 解析、独立 workspace、`bootProgress`、external Markdown box 注册、provider 动态安装/卸载、健康降级、指数退避重启、SIGTERM 优雅退出和进程退出兜底。Go `serve` 新增 `--supervisor-pid`，连续确认 Node PID 消失后自行 `Close`，覆盖 Tauri/Emacs 强杀 Node 时来不及执行 JS cleanup 的孤儿场景。Rust 已删除 `kernel_child`/`kernel_url`/`start_kernel` 与重复 `kernel_status` command，只给统一 Node host 传 canonical kernel binary/workspace/wd 并立即启动 host；桌面 smoke 改从统一 `/health` 取状态。Emacs Lisp 只显式传 `AARONNOTE_HOST_MODE=emacs`，没有新增任何 Go lifecycle；现有 Node gateway/Jupyter/Copilot/xwidget/split-client 路径未改。远程 `/fs:` 被 supervisor 明确判为非本地 root，不会误交给 Go，markdown-box lab 则会从 `/health` 动态发现重启后的端口。聚焦 Node supervisor + 六个 Go provider + Tauri 合约为 8 files / 31 tests，TypeScript、Go compile、Rust 5 tests 全过；Emacs `jupyter-test` 四组 87+24+18+12 共 141 项全过，覆盖 gateway、分栏 client、xwidget、Jupyter broker/notebook/LSP/board。真 Emacs-mode Node 进程用隔离 root 启动后，先快速报告 web URL，再由自身拉起 Go；`/health` 返回 `hostMode:emacs`、owned/listening kernel 与正确 box，生产 `create-todo` 经 Go 分配 stable id/UUIDv7 并写入 Markdown。随后又从完整 Emacs init 真正调用 `my/noema--start-server`，不是手工模拟环境；同样在隔离 state/root 上得到 `hostMode:emacs`、owned/listening kernel，`my/noema-stop` 正常回收两层进程。真机还抓到单次 2 秒健康探针可能撞上索引繁忙，已改成连续三次失败才降级，避免手感抖动。两个测试 root/shadow 均已精确永久删除；另清掉一个已孤儿 11 小时、占 18MB 的旧 Claude scratch kernel workspace 和 PID 195（不可恢复），没有动三个既有 Vite dev server或用户会话。

**统一 supervisor 正式门禁完成（2026-08-25）**：新增 owned-kernel crash/restart 用例已证明旧端口退出后 provider 会先进入 degraded，再随新进程 discovery 到新端口并恢复 listening；supervisor 聚焦组现为 5 项，连同六个 provider 与 Tauri 合约共 31 项。精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过：163 files passed / 7 skipped、1577 tests passed / 16 skipped；`go test ./noema/... ./api/... ./cli/cmd`、supervisor PID model 聚焦组及固定 Rust + 兼容 SDK 的 5 个宿主测试也通过。正式 `make build` 完成 4000-module renderer、official Node、FTS5 Go 与 Rust release app，明确报告 `APFS-cloned executable and linked 16 local resources and sidecars`；`make install` 用真实 App shell + APFS-cloned executable + linked runtime 事务更新 `/Applications/Noema.app`。AGENTS.md 原样 packaged smoke 日志显示 `owner=web-host`：Tauri 启动共享 Node，Node 再拥有 Go；报告 `hostMode:desktop`、preload、54px、五项标题栏、独立 TOC popover、Knowledge 双击入口、八视图 `kernel-agenda`、`kernel-katex-macros` 与 owned/listening kernel 全绿，关机后 Node/Go 均无遗留。安装 App 是 18MB 真实目录，Cargo/bundle/install 三个主程序 inode 独立，Resources 与 sidecar 都是链接，`src-tauri/binaries` 为 0B links；默认笔记根无 `.siyuan`，Emacs full-project + 7 个 shared resource links 和 retired path 规则通过，两个仓库 `git diff --check` 干净。另精确永久清理了无进程持有的 `/private/tmp/noema-kernel-facade.quonPq` 旧 facade 测试副本（141MB）及 0B baseline 日志；不可恢复，没有触碰其他临时目录或用户会话。

**思源全量代码研判已完成（2026-08-25）**：见 `docs/siyuan-merge-audit-2026-08.md`。逐子系统过了一遍思源整个仓库（Go 内核 + 前端非 protyle + protyle 内可抠出的层），每项给判决，包含已决定删的部分。两条结论改变了后续"merge"的成本模型：

- **Go 侧不是搬代码，是给休眠子系统接线。** 迁移期比对表明 canonical `kernel/` 已包含所需的 21.4 万行 Go；Phase 0 裁剪也早已完成（fork 历史 `baeb38bfc`..`b3fb59d39`，74 文件 / 30,609 行）。`kernel/cli/`(6,084)、`kernel/mcp/`(12,292)、`model/virutalref.go` 等当时仍没有 Noema 消费者，后续均按审计结论接线或裁决。
- **前端 protyle 耦合被高估。** 外部对 `protyle/*` 的 ~370 处 import 集中在四个非 contenteditable 的工具文件（`util/compatibility` 95、`util/hasClosest` 62、`ui/hideElements` 26、`util/hotKey` 8）；另外 `wysiwyg/transaction.ts:2071` 的 `transaction()` 已支持 `protyle === null` 退化成纯 REST POST，这把 `render/av/` 的 24,849 行从"不可分离"重新归类为"可用 12 字段 shim 抠出"。

研判里还有三条与本文档既有决策冲突、需要单独拍板的点（前端插件系统、文档历史 vs git、covers 19MB 的落点），见该文档第六节。

**kernel CLI 对 markdown box 可用（2026-08-25，当前工作树）**：研判把 `kernel/cli/` 列为"已在树里、路线图完全遗漏、对 Emacs 宿主是天然接口"，实测后发现它对 markdown box 基本不可用，两个缺口都是**静默失败**：

1. **任务队列在 CLI 下没有消费者。** `Box.Index()` 把 `removeBoxRefs`/`indexBox`/`IndexRefs` 全部走 `task.AppendTask`，而队列消费者 `ExecTaskJob` 只在 serve 的 `job.StartCron()` 下运行。CLI 是单次命令进程，从不启动 cron，于是索引永远不建立，随后 `search`/`sql`/`ref`/`outline` 只回一句 "No results found"，没有任何错误。`root.go` 的 `PersistentPostRunE` 原本已经处理了 SQL 队列并写明意图是"保证写完即可搜索"，只是漏了任务队列这一层。新增 `task.ExecSyncTasksUntilEmpty(timeout)`：循环 `popTask`+`execTask` 直到队列空，`popTask` 本身跳过异步任务（PushMsg 之类是给长驻 UI 的，一次性命令不该为其 Delay 阻塞），并带整体预算防止任务反复重新入队把 CLI 挂死。接在 `FlushTxQueue`/`FlushQueue` **之前**，因为索引任务正是往 SQL 队列写数据的那一方。
2. **`document list` 对 markdown box 恒为空。** 它走 `ListDocTree`，那是 `.sy` 的 `<parentID>/<childID>` 嵌套文档树概念（§1.4 明确延后、至今未动）。改成按 box kind 分流到已有的 `ListMarkdownDocs`——与 CM6 文档浏览器同一个数据源，不新写遍历逻辑。`.sy` 分支一字未动。

实测（隔离 workspace + 14 篇真实笔记的副本，绝不碰 `~/Documents/Noema` 原件）：修复前 `blocks` 表 0 行、`search` 无结果；修复后 `notebook open` 1.5 秒建出 124 个块，`search "Hilbert"` 与中文 `search "量子"` 都正确命中并带 `<mark>` 高亮（验证 CJK tokenizer 在 CLI 路径同样生效），`document list` 列出全部 14 篇。三轮 `shasum` 比对确认源文件字节自始至终未变。新增 `kernel/task/queue_test.go` 5 个用例：锁定"无消费者时入队任务不执行"这个前提本身、排空按入队顺序执行、跟进任务执行中新入队的任务（真实索引路径的形状）、跳过异步任务且不为其 Delay 阻塞、超预算安全退出。`go build ./...`、`go vet`、`task`/`cli`/`noema`/`filesys`/`treenode` 测试全过。

顺带抓到一个与本次改动无关的真实泄漏：桌面版 kernel workspace 里累积了 8 个 shadow box，其中 7 个的 `root` 指向已被删除的 `/private/tmp/noema-*` packaged smoke 目录。`RegisterExternalMarkdownBox` 按 repository 建 shadow，但没有任何机制回收 root 已消失的陈旧条目——每跑一次 packaged smoke 就多留一个。已记录，未擅自清理。

**external Markdown stale shadow 自动回收已落地（2026-08-25，当前工作树）**：`registerExternalMarkdownBox` 现在先让当前 portable repository 按 `repositoryId` 完成原 box identity 的路径重绑，再调用 `PruneMissingExternalMarkdownBoxes(activeID)`；因此仓库搬家仍复用既有内部 ID，其他只有在 `os.Stat` 明确证明 root 已不存在时才清掉 shadow 与索引。权限错误、瞬时 I/O 错误或当前 active registration 一律保留，避免把暂时离线的外部盘误判成垃圾。external Markdown unregister/prune 同时不再复制 shadow conf 到 source deletion history——真实外部仓库从未被删除，这类 history 只会制造第二份 stale metadata。API 响应新增 `pruned` 证据，统一 App/Emacs web-host 每次 attach 现有注册端点时都会自动完成回收，不在 Electron/Emacs adapter 复制生命周期逻辑。真实 FTS5 model + API 聚焦用例已通过，覆盖 missing stale root 被删、live/active root 保留、shadow 消失、外部根不变且不生成 delete-history；本批生产 Go 代码已变化，下面继续扩大门禁并用隔离 workspace 实测旧 shadow 收敛。

stale shadow 批全量测试门禁已过：精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 163 files passed / 7 skipped、1576 tests passed / 16 skipped；`go test ./noema/... ./api/... ./cli/cmd ./filesys/... ./treenode/... ./sql/...` 及真实 `-tags fts5` prune/model/API 聚焦组全过。下一步重建 Electron release、链接安装并从 `/Applications` 取真实 workspace 回收与宿主 smoke 证据。

stale shadow 批 `make build` 已过：3991-module production renderer、FTS5 Go kernel 与 SiYuan-derived Electron shell 全部重建，日志确认 Framework hard links、App/kernel/icon links 与 APFS-cloned shell；下一步执行事务安装。

首轮 `make install` 与 packaged smoke 已过：真实 `/Applications/Noema.app` 继续报告 `hostMode:desktop`、`preload:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、独立 TOC、Knowledge 双击入口、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 Node-owned/listening Go kernel。随后用 Electron 同款环境短暂启动共享 `web-host.mjs` 连接 canonical `com.noema.desktop/kernel-workspace`：7 个 root 已不存在的 `/private/tmp/noema-*` shadow 被回收，API 与磁盘复读都只剩原 `~/Documents/Noema` box（ID 保持 `20260825115637-yczwmzv`），`/health` 正常，SIGINT 后 Node/Go 均优雅退出。

这次真实回收还抓到一个统计竞态细节：`util.DataSize` 的 `Walk` 已读到 shadow entry 后，下一次 `d.Info()` 可能恰逢该目录被 prune，原实现会把正常的 `ENOENT` 记成 `size of data failed`。现在 walk callback 的入口错误与 entry `Info` 错误都对 `os.IsNotExist` 一致静默跳过，其他错误仍保留日志/失败语义；新增 fake disappearing `DirEntry` 回归测试精确锁定该窗口。`util/noema/api/cli/filesys/treenode/sql` 全组及 FTS5 prune 聚焦门禁再次通过。因为 Go production 又变化，下面重跑最终 `make test/build/install` 与 packaged smoke。

统计竞态修复后的最终 `make test` 保持 163 files passed / 7 skipped、1576 tests passed / 16 skipped（精确 Node 26.5.0/npm 11.17.0）；下一步重建并安装最终 Go binary。

统计竞态修复后的最终 `make build` 已过：3991 modules、FTS5 Go kernel 与 Electron shell 重建完成，仍采用 APFS clone + hard/link-only runtime；下一步最终事务安装和 smoke。

**stale shadow 回收批正式门禁（2026-08-25）**：最终 `make install` 已事务更新 `/Applications/Noema.app`，AGENTS.md 原样 smoke 报告 `hostMode:desktop`、`preload:true`、54px、五项标题栏、TOC popover、Knowledge 双击入口、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 Node-owned/listening kernel 全绿。canonical kernel workspace 复读只剩 `20260825115637-yczwmzv → ~/Documents/Noema`，7 个已删除临时 root 的 shadow 已消失且没有新增 delete-history；默认根无 `.siyuan`。Emacs full-project link、7 个 shared resource links 全部解析到本仓库，retired lowercase path 缺席；`make disk-audit` 仍报告安装 App 仅 44KB unique physical accounting，runtime/framework 未重复复制；`git diff --check` 干净。

**bibliography Go 数据面最小完整纵切已落地（2026-08-25，当前工作树）**：新增 `kernel/noema/bibliography` 与 `/api/noema/markdown/loadBibliography`。Go 在 external Markdown box realpath 边界内解析当前未保存 metadata、YAML/`#+begin meta`、递归 `extend`（保留声明文件的路径 provenance）、默认 `<note>/bib` 与显式 `.bib`/目录，拒绝越界 bibliography/extend；随后解析 braced/quoted/bare values、`@string` forward refs、`#` concatenation、月份宏、TeX accents/ligatures、duplicate/cycle/unknown/malformed diagnostics，投影稳定 SHA-1 entry ID、full/short namespace，并在 short namespace 冲突时只保留 full alias。浏览器侧 citation protected-range/UTF-16 source offsets、编号、widget 与 LaTeX 返回形状仍由原 Node/CM6 层负责，不把编辑器语义重复进 Go。

`kernel-bibliography-provider.mjs` 已接统一 web-host kernel state，App 与本地 Emacs 因而使用同一 Go loader；standalone/Server 或 transient kernel failure 保留原 Node file/parser fallback。`shared/bibliography-fixtures.json` 同时被 Go 与 JS 消费，覆盖 Unicode、TeX accent、forward macro、concatenation、month、duplicate/cycle/unknown/malformed 和 emoji 前缀后的 UTF-16 diagnostic offset；Go package/library/API 与 Node parser/provider/citation integration 聚焦组当前 25 项全过，`tsc --noEmit` 和脚本 syntax 通过。下一步扩大 Go/Node 门禁，并用隔离 external root 从生产 facade 验证 `source:kernel-bibliography` 后再跑正式 build/install/smoke。

bibliography 批扩大门禁已过：`go test ./noema/... ./api/... ./cli/cmd ./filesys/... ./treenode/... ./sql/... ./util/...` 全绿，bibliography/provider/citation/LaTeX export 8 个 TypeScript 文件 98 项全绿；精确 Node 26.5.0/npm 11.17.0 的 `make test` 为 165 files passed / 7 skipped、1584 tests passed / 16 skipped。下一步正式 build/install 与隔离生产 facade 取证。

bibliography 批正式 `make build` 已过：3991-module production renderer、FTS5 Go kernel 与 SiYuan-derived Electron shell 全部重建，仍采用 APFS clone + Framework hard links + App/kernel/icon links。下一步安装该确定产物，并从真实生产 facade 验证 `source:kernel-bibliography` 后执行 packaged smoke。

**bibliography Go 数据面正式门禁（2026-08-25）**：精确 Node 26.5.0/npm 11.17.0 下最终 `make test` 为 165 files passed / 7 skipped、1584 tests passed / 16 skipped；Go 扩大组、bibliography/provider/citation/LaTeX export 8 个 TypeScript 文件 98 项、`tsc --noEmit`、Node syntax 与 `git diff --check` 全过。`make build` 重建 3991-module renderer、FTS5 Go 与 Electron shell，`make install` 事务更新 `/Applications/Noema.app`。随后以安装包 Electron runtime + bundled kernel 启动真实生产 web-host，对现有只读 `GraphTensor.md` 的 `@@cite(iso) [Str87]` 返回 `source:kernel-bibliography`、1 citation / 1 reference、稳定 SHA-1 ID、正确 full/short namespace、编号 `[1]` 且 diagnostics 为空。AGENTS.md 原样 packaged smoke 同时报告 desktop/preload、54px、五项标题栏、TOC popover、Knowledge/Agenda、`kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿；没有写用户笔记，进程均已优雅退出。

**Noema kernel 用户级状态隔离开始（2026-08-25，当前工作树）**：上述真实启动顺手暴露出 upstream kernel 会把已删除的 `noema-desktop-smoke-*` workspace 写入全局 `~/.config/siyuan/workspace.json`，下一次启动因此先打印 stale workspace 警告；这不是 external Markdown shadow 回归，而是本计划 Phase 3 已列出的 SiYuan 工作区字面路径债务。现在 `kernel/util.UserConfigDir()` 统一承接 workspace registry、kernel/app log、port、cookie、shortcuts 与 fonts；shared Node supervisor 为每个宿主注入 `<stateRoot>/kernel-config`，因此 App 与 Emacs 的 kernel 状态彼此独立，smoke 的 registry 随 smoke state 一起回收，且不再读写外部 SiYuan 配置。历史 `~/.config/siyuan` 保留为非 Noema 直接启动 kernel 的兼容 fallback，本批不擅自修改用户旧文件。Go override/registry 聚焦测试、model/server compile-only、supervisor/adapter/bibliography 4 文件 18 项、TypeScript 和 syntax 当前全过；下一步用重建后的真实 smoke 对比全局 registry 校验零污染。

隔离修复第一次正式重建/安装与 smoke 已证明全局 registry SHA-256 前后同为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`，正常 App state 的 registry 只含 canonical `~/Library/Application Support/com.noema.desktop/kernel-workspace`；生产启动不再打印 stale workspace warning，bibliography facade 仍返回同一 `kernel-bibliography` 结果。退出卫生检查同时发现 Chromium 会在 Node `exit` hook 删除 userData 后又重建 12KB cache 壳，因此 Electron adapter 新增 detached Node cleanup helper：等待实际主进程消失后精确删除本次 `noema-desktop-smoke-<pid>`，不再依赖下次 smoke 清上次。相关 Electron/supervisor 2 文件 10 项和 syntax 已过；该小改动再次使正式产物门禁失效，下面最后重跑 test/build/install/smoke 并要求没有本次或上次 smoke temp。

**Noema kernel 状态隔离与 smoke 自清理正式门禁（2026-08-25）**：最终精确 Node 26.5.0/npm 11.17.0 下 `make test` 仍为 165 files passed / 7 skipped、1584 tests passed / 16 skipped；Go Noema/API/CLI/filesys/treenode/sql/util 扩大组、UserConfigDir registry 聚焦组、model/server compile-only、Electron/supervisor 2 文件 10 项、TypeScript/syntax/diff 全过。最终 `make build` 重建 3991-module renderer、FTS5 Go 与 Electron shell，`make install` 更新真实 `/Applications/Noema.app`。AGENTS.md 原样 smoke 报告 desktop/preload、54px、五项标题栏、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿；`~/.config/siyuan/workspace.json` SHA-256 前后完全一致，退出 drain 后本次及历史 `noema-desktop-smoke-*` 目录均为零。正常生产 App state 的 `<stateRoot>/kernel-config/workspace.json` 只列 canonical kernel workspace，启动无 stale warning；不修改历史 SiYuan 配置。

**强杀中断索引自动恢复已落地（2026-08-26，当前工作树）**：`DataIndexState=1` 原本在 `InitConf` 刚读出时就被清零，后续只重放 `index.queue`；但 box 全量索引的并行扫描可能在某些源文件被发现并入队前崩溃，而 `InitBoxes` 又把任意非零 blocktree 计数当成“全部 box 已初始化”，所以重启能在只有部分 Markdown/FTS 数据时宣告 boot 完成。现在中断标志跨过配置初始化一直保留，`InitBoxes` 在正常 boot 路径内同步调用既有 box-kind-aware 全量重建，从 external Markdown/`.sy` 源真相重新发现所有已打开 notebook；只有 SQL/FTS 队列完整提交后才把 runtime + persisted marker 清为 0。进程若在恢复中再次退出，标志仍为 1，下一次继续恢复；Node supervisor 在此期间只能看到 `starting`，不能提前发布 `listening`。新增真实 FTS5 回归构造“一篇已入库、一篇存在于源目录但从未进入持久队列”的中断形状，锁定重启后两篇均进入 blocktree/SQL、遗漏词可搜索、源字节不变、完成后标志清零。

真实进程证据使用隔离的 98MB external root：30 篇文档各有独立路径与唯一词，注册返回后 250ms 对 Go kernel 发 `SIGKILL`；落盘 `dataIndexState` 为 1，而 `index.queue` 仅 115 bytes / 2 operations。以同一 workspace 交给 shared Node supervisor 重启后，`/health` 在扫描与 71.376s SQL/FTS transaction 全程保持 `kernel.state:starting`；内核日志完成 `tree/block count [30/30] after interrupted-index recovery` 后才切到 `listening`。真实 SQL 返回 30 blocks / 30 distinct paths，FTS 精确命中最后一篇 `/note-30.md`，marker 为 0；源目录聚合 SHA-256 前后同为 `5abb426e42f6f7c7809c2bdd3d9481f80341dc660db506cd83612a81e3770ba0`。Go 核心扩大组、FTS5 聚焦回归和精确 Node 26.5.0/npm 11.17.0 的 `make test`（165 files passed / 7 skipped，1584 tests passed / 16 skipped）已过；下一步重建、安装并跑 packaged restart/smoke 最终门禁。

**强杀中断索引恢复正式门禁（2026-08-26）**：最终 `make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务链接更新 `/Applications/Noema.app`。安装包 kernel 直接解析到 canonical `build/kernel/darwin-arm64/noema-kernel`，两条路径 SHA-256 同为 `87db7711630d95b91bcf0ac7a8b6dc9746e5319e287eeb57183b02e1a986b25e`，且产物包含 interrupted-index recovery 日志路径；上面的严格强杀证明因此针对安装包实际使用的同一构建目标。AGENTS.md 原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 `~/.config/siyuan/workspace.json` smoke 前后 SHA-256 均为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；退出后无 packaged PID、`noema-desktop-smoke-*` 或 `noema-fts-*` 临时目录，默认根无 `.siyuan`。Emacs full-project link、7 个 shared asset links 和 retired lowercase path 规则通过；`make disk-audit` 继续报告安装 App 仅 44KB unique physical accounting，`git diff --check` 干净。

**首次 external root readiness 缺口已修（2026-08-26，当前工作树）**：继续审计上面的恢复时序时发现，全新 external Markdown box 的 `Mount()` 只把 `removeBoxRefs → indexBox → IndexRefs` 放进后台 task queue，`registerExternalBox` 立即返回；shared supervisor 因而会在首轮扫描/FTS 尚未完成时发布 `listening`。现在只为 standalone registration 增加 `MountExternalMarkdownBoxAndWait`：external root 启动 watcher 后同步执行同一组既有 box-kind-aware 索引任务并 `sql.FlushQueue`，普通内部 Markdown 与 `.sy` notebook 的 `Mount` 仍保留原异步契约。API 对并发注册串行化，第二个 App/Emacs attach 必须等第一个完成；supervisor 的 registration 请求使用剩余 boot budget，而不是普通 2s API timeout，长索引不会被误判为 kernel failure。FTS5 API 回归不执行任何额外 task/flush 就直接断言新文件已在 SQL 与 FTS；supervisor 回归把普通 request timeout 压到 5ms、registration 延迟 40ms，锁定完成前始终 `starting`、之后只发布一次 `listening`。扩大测试同时抓到并纠正一次范围漂移：最初把所有 Markdown `Mount` 同步化会让不初始化 SQL 的内部 `createNotebook(kind=markdown)` 测试 panic，现已由专用 external 方法收窄并由该旧回归锁定。

真实首次启动证据使用隔离的 32MB/20-document root：启动后立即读取 `/health` 得到 `kernel:starting, box:null`；20 篇扫描 0.50s，SQL/FTS 两次 transaction 共约 19.1s，全部提交后才出现 `owner=web-host` 与 `listening`。随后真实 SQL 返回 20 blocks / 20 distinct paths，FTS 唯一词精确命中 `/note-20.md`，源聚合 SHA-256 前后同为 `f36c536e3062525c64258de0b816e812bbccf47386f76cd905fe864dcd193144`。临时 root/state 已移入废纸篓。Go Noema/filesys/treenode/sql/api/CLI 扩大组、FTS5 API/model 聚焦组、`git diff --check` 全过；精确 Node 26.5.0/npm 11.17.0 的 `make test` 为 165 files passed / 7 skipped、1585 tests passed / 16 skipped。下一步再次重建、安装与 packaged smoke。

**首次 external root readiness 正式门禁（2026-08-26）**：最终 `make build` 再次重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 更新 `/Applications/Noema.app`；安装包与 canonical kernel SHA-256 同为 `8dfd2a46953f2ab0d38a414ce1feb9ec2eb252ce1d2ca438b167af45aeedb0e8`。AGENTS.md 原样 packaged smoke 在默认已索引 root 上快速重连，继续报告 desktop/preload、54px、五项标题栏、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 workspace registry hash 仍为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；退出后无 packaged PID、smoke/first-ready/FTS 临时目录，默认根无 `.siyuan`，Emacs project + 7 shared links 与 retired path 规则保持通过，`git diff --check` 干净。

**显式 kernel workspace 不再回退 SiYuan（2026-08-26，当前工作树）**：真实诊断探针暴露 `noema-kernel serve --workspace <missing>` 会沿用 upstream 逻辑，因末级目录尚不存在而静默改用 `~/Library/Application Support/SiYuan`；即使 desktop supervisor 正常会预建目录，CLI/人工启动仍可能打开并刷新另一个应用的数据。`initWorkspaceDir` 现在区分来源：用户显式给出的 workspace 缺失时原地 `MkdirAll`，创建失败就按既有 fatal 语义退出，绝不换目标；只有 workspace registry/default 自己选出的陈旧路径继续保留历史 fallback。纯函数回归锁定显式嵌套目录被创建且 SiYuan fallback 不存在。

真实 FTS5 kernel 以不存在的 `<isolated>/brand-new/kernel-workspace` 启动，第一条日志即 `created specified workspace [...]`，boot API 达到 100，实际 workspace realpath 与请求一致；隔离 `<state>/kernel-config/workspace.json` 只含该路径，全局 `~/.config/siyuan/workspace.json` SHA-256 仍为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`。进程优雅退出，探针移入废纸篓。Go Noema/filesys/treenode/sql/api/CLI/util 扩大组、FTS5 readiness/recovery 聚焦组、`git diff --check` 与精确 Node/npm 的 `make test`（165 files passed / 7 skipped，1585 tests passed / 16 skipped）全过；下一步最终 rebuild/install/smoke。

**显式 workspace 安全创建正式门禁（2026-08-26）**：最终 `make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 更新真实 App；安装包与 canonical kernel SHA-256 同为 `7182e34daeb0fb77e379bf0fa520243b4660f6f27e8d653414b2383f2532058e`。AGENTS.md 原样 packaged smoke 继续报告 desktop/preload、54px、五项标题栏、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿；全局 registry hash 不变。最终无 packaged PID 或本轮 probe/smoke/FTS/first-ready 临时目录，默认根无 `.siyuan`，Emacs full-project link、7 个 shared asset links 与 retired lowercase path 规则通过；`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。

**Markdown 启动/重连完整性继续收口（2026-08-26，当前工作树）**：顶层 box-document 功能开启时，`InitBoxes`/`RefreshBoxDocFeature` 仍会把 external Markdown box 送进共享 `EnsureBoxDoc`，存在往影子目录生成 `boxDoc.json`/原生 `.sy` 笔记本文档的条件路径。现在 guard 落在 `ensureBoxDoc0` 这个共享 primitive，而不是只修某个调用点：任何 Markdown box 永远拒绝 `.sy` box-document 语义；回归显式开启全局功能后调用 `EnsureBoxDoc`，断言返回空且 metadata/`.sy` 均不存在。

首次注册的同步索引还暴露固定 120s boot deadline 的规模上限：健康内核处理大库超过两分钟会被 supervisor 误杀并无限重启。registration 现在同时具备两层界限：独立 `/api/system/bootProgress` 探活成功会续租较短的 120s **失联** deadline，因此正在工作的长索引不会被杀；30 分钟总 deadline 保证 handler 自身死锁时仍有硬上限。三组 Node 回归分别锁定“索引时间超过 boot deadline 但健康 → 保持 starting 后 listening”“健康端点仍活但 registration 永不返回 → 总上限 degraded”“索引中 kernel 失联 → 中止 registration 且绝不 listening”。

恢复完整性也从“成功路径证明”升级为“失败不能伪装成功”：全量索引先用保留 error 的递归扫描区分空目录和不可读目录，再统计线程池调度/逐文件加载失败（并修正 pool invoke 失败时漏 `WaitGroup.Done` 的潜在死锁）。`FullReindexDirect`/`InitBoxes` 传播错误；任何源失败都在 SQL flush 之后重新持久化 `dataIndexState=1`，`serve` 以非零状态退出，不能执行 `SetBooted`。跨平台回归用损坏 `.sy` 构造确定性解析失败，断言 runtime/persisted recovery marker 均保留。

最后补齐第二次及后续启动：旧逻辑看到 persisted box 已 open 就直接返回，既不恢复进程内 watcher，也不核对 App 关闭期间的 Git/Emacs 修改。现在每次 standalone attach 都先建立 watcher，再把 external root 与 blocktree/SQL 做源真相对账：逐篇解析并比较 SQL 实际保存的根块 payload，只对新增/修改树排 `upsert`，删除已消失路径，暖启动不再整库 delete/reinsert。FTS5 API 回归先完成首轮注册，再关闭 watcher 模拟 App 退出，离线修改一篇、新增一篇、删除一篇并二次注册；handler 返回时新词均唯一可搜，旧正文和删除文档词项均为零。该测试进一步抓到 SQL 根块的旧 hash 不含 Markdown 聚合全文，导致 `upsertTree` 把正文-only 修改误判不变；Markdown 文档根 hash 现纳入最终 `content/fcontent/markdown/IAL`，与实际 FTS payload 同源。当前精确 Node 26.5.0/npm 11.17.0 `make test` 为 165 files passed / 7 skipped、1587 tests passed / 16 skipped；Go recovery/API/SQL/CLI 聚焦组全绿。下一步用真实冷/暖 repository 取证，并重跑正式 build/install/packaged smoke。

真实进程冷/暖证据使用隔离 repository + shared `web-host.mjs` + 当前 FTS5 production kernel：冷启动注册 2 篇后得到 2 trees / 2 SQL paths；优雅退出并停掉全部进程内 watcher，直接在磁盘把 `alpha.md` 正文改词、删除 `beta.md`、新增 `gamma.md`。复用同一 kernel workspace 的第二次启动在同一秒内完成 warm reconciliation 并发布 `listening`，box ID 保持 `20260826010126-2qm3qv1`；SQL 精确为 `/alpha.md,/gamma.md` 两条，FTS 对 `warmreconcileupdated`/`warmreconcileadded` 各唯一命中对应路径，对两个旧词均为 0。external root 无 `.siyuan`/`.sy`，源文件哈希复读稳定；进程优雅退出，整个 probe 已移入 macOS 废纸篓（可恢复）。watcher 的增量 `UpsertIndexes/RemoveIndexes` 也纳入同一 database-index mutex：attach 对账期间发生的实时写入会排队并在其后重放，不会与 warm scan 交错覆盖。下面进入正式产物门禁。

**Markdown 启动/重连完整性正式门禁（2026-08-26）**：最终精确 Node 26.5.0/npm 11.17.0 `make test` 为 165 files passed / 7 skipped、1587 tests passed / 16 skipped；Go FTS5 recovery、warm registration、watcher、save/reindex、SQL 与 CLI 聚焦组全绿，`git diff --check` 干净。`make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新真实 `/Applications/Noema.app`；installed/canonical kernel SHA-256 同为 `cc998635ac45ceaddb7e58fe25fda3c659ca91a981fc75af6896b1dd5da6cc66`。AGENTS.md 原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 `~/.config/siyuan/workspace.json` smoke 前后 SHA-256 均为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；退出后无 packaged PID、smoke/reconcile 临时目录或默认根 `.siyuan`。Emacs 两条 full-project compatibility link 都解析到本仓库，7 个历史 shared asset 入口全部解析到 `resources/`，retired lowercase path 缺席；`make disk-audit` 继续报告安装 App 44KB unique physical accounting。

### 为什么必须删 protyle

protyle 无客户端文档模型：`onGet.ts:289` 直接 `wysiwyg.element.innerHTML = content`（内核返回的 HTML 字符串），编辑经 `wysiwyg/keydown.ts` 翻译成 `IOperation`（`data` = 块 `outerHTML`）→ `POST /api/transactions` → 内核回传权威 HTML → `transaction.ts:654 onTransaction()` 逐块 `outerHTML =`。整条链路依赖 `.sy` 块树和 lute WASM。

md 为真相源后这条链路没有落点，且 Noema 不变量 #1（markdown 源偏移 = 稳定坐标系）会消失 —— `vim-lite.ts`、`structural-jump.ts`、`vim-jump.ts`、`text-boundaries.ts`、`xwidget-key-guard.ts` 全部建立其上。CM6 缺的块模型是**加法**（widget + 语法层），可以补；protyle 缺的文本坐标系是**减法**，补不回来。

---

## 目标仓库结构

以迁入 Noema 主仓库的 canonical 源码为底座：

```
noema/
  kernel/                  Go 内核（module github.com/aaronhe/noema/kernel）
    filesys/               ★ 新增 markdown box 序列化层
    treenode/ sql/ cache/ search/ av/ conf/ util/
    model/                 裁剪至 ~35 个文件
    noema/                 ★ Noema 专属 Go 包：planning/ agenda/ latex/ vaultgit/ katexmacros/
    api/ server/
  app/
    src/
      editor/              ★ Noema CM6（源自 src/cm6/ + src/*.ts）
      noema/               ★ Noema 应用层（源自 aaronnote/）
      layout/ menus/ dialog/ boot/ config/ search/ assets/   思源外壳，保留 + 改名
      protyle/             ✗ 删除
      mobile/              ✗ 删除
    appearance/langs/      裁剪至 en / zh-CN
    stage/
  desktop/                 SiYuan-derived Electron UI/系统适配层（main/preload）
  web-host.mjs + server/   App/Emacs 共用 Node host：Jupyter/Copilot + Go supervisor
  shared/                  双端解析器（.mjs），Go 侧镜像在 kernel/noema/
```

---

## Phase 0 — Fork、裁剪、改名（约 2–4 周）

**代码删除**（依据探索结论，全部是干净切口）：

| 目标 | 位置 | 说明 |
|---|---|---|
| `kernel/mobile/`、`kernel/harmony/` | 447 + 318 行 | 无任何入边，直接删 |
| `kernel/heif/` | 5,086 行 | 只被 `server/serve_heif_accept.go` + `serve.go` 引用 |
| `kernel/mcp/`、`kernel/agent/`、`kernel/plugin/` | 30k 行 | 在 `server/serve.go:171-190` 的 `serveX` 处摘除 |
| 云三角 | `model/cloud_service.go`、`sync.go`、`sync_dedup.go`、`lan_sync.go`、`repository.go` | `cloud_service.go` 先 stub 成 no-op（解耦 ~7 个文件），再逐步删净 |
| bazaar 网络层 | `kernel/bazaar/` | **保留** manifest struct（`Theme`/`Icon`/`Plugin`/`Widget`/`Template`），本地包加载器依赖它 |
| 其他 | `caldav.go`/`carddav.go`/`dav.go`、`publish_access.go`、`updater*.go`、`elevator*.go`、`ocr.go`、`flashcard.go`、`embedding.go`、`rerank.go`、`oidc*`、`crypto*`（加密笔记本） | 路由层逐行删（`api/router.go` 是扁平 `ginServer.Handle` 列表，无 group 纠缠） |
| 前端 | `app/src/protyle/`、`app/src/mobile/`、`app/src/card/`、`app/src/ai/`、`app/src/sync/`、`app/src/asset/pdf/`(可选) | mobile 需处理 **66 处非 ifdef 保护的跨引用**（`menus/protyle.ts:56`、`protyle/gutter/index.ts`、`plugin/API.ts`、`protyle/index.ts` 顶层 `import {setEmpty}` 等） |
| 语言包 | `app/appearance/langs/` 21 种 → 2 种 | 每个 2,136 键 |

**改名清单**（按成本降序，全部机械替换）：
1. Go module `github.com/siyuan-note/siyuan/kernel` → `github.com/aaronhe/noema/kernel`（~1,052 处 import，`gofmt -r`）
2. `window.siyuan` → `window.noema`（**8,207 处**，`src/types/index.d.ts:304` 的 `ISiyuan`）
3. **`b3-` 前缀（7,809 处）与 `--b3-*` CSS 变量：不改。** 它是社区主题的公开契约，改了就吃不到思源主题生态 —— 这正是"大量引入思源好设计"的落点
4. `fn__`（4,357）、`protyle-`（1,412）、`av__`（1,606）：`protyle-` 可留（编辑器 chrome class 会被 CM6 复用一部分），其余不动
5. 工作区约定：`util/working.go:279 initWorkspaceDir`、`DBName`(`:265`)、`~/.config/siyuan/{port,workspace,windowState}.json`、每笔记本 `.siyuan/` 目录字面量 → Noema 命名
6. 身份串：gin session name(`serve.go:168`)、JWT issuer(`model/auth.go:47-49`)、`siyuan://` scheme、`org.b3log.siyuan` appId、service-worker cache
7. **FTS5 tokenizer 名 `"siyuan"`（`sql/database.go:294,389,463,2069`）：改名会作废所有已建 FTS 索引。** 因为是全新 vault，Phase 0 一次性改掉，之后冻结
8. 每个 `.go` 文件头的 AGPL 头 → 保留 AGPL（法律要求）+ 加 Noema 归属与思源出处

**云端点中和**：`kernel/util/cloud.go:68-83` 六个 `b3logfile.com` 地址集中在一个文件，直接置空。

**验证**：`go build ./...` 通过；`kernel serve --port 0 --workspace <tmp>` 能起来并响应 `/api/system/version`；`pnpm run build:desktop` 通过。

---

## Phase 1 — Markdown Box：让内核以 .md 为真相源（约 4–8 周，本项目的真正难点）

这是全部工作的地基。切口很窄，思源所有磁盘 IO 都汇聚在两个函数。

### 1.1 格式接缝

迁入前的上游 `kernel/filesys/tree.go` 是**唯一**读写 `.sy` 字节的地方：
- `LoadTree(boxID, p, luteEngine)` @ `:217` → `parseJSON2Tree` @ `:618`
- `WriteTree(tree)` @ `:378` → `prepareWriteTree` @ `:446`（`render.NewJSONRenderer` + mmap 写）

改造：引入 box kind（`sy` / `markdown`），在这两个函数分派。markdown box：
- 读：`.md` bytes → `lute.Md2Tree`（Noema 定制 engine）→ tree
- 写：Noema `FormatRenderer`（kramdown-IAL markdown）→ `.md`

参考 `kernel/util/lute.go`：`NewLute()` @ `:57` 已有 `SetKramdownIAL(true)`、`SetBlockRef(true)`、`SetTag(true)`、`SetSuperBlock(true)`；新建 `NewNoemaLute()` 在此基础上开 `YamlFrontMatter`/`Footnotes` 并注册 Noema 语法扩展。

`.sy` 字面量清理：全库 ~150 处硬编码（`model/file.go` ~15、`import.go` ~10、`export.go` ~6、`path.go`、`box.go`、`index.go`、`heading.go`、`listitem.go`、`filetree.go`、`server/serve.go:1425`、`treenode/tree.go:64`、`util/working.go:558`）→ 抽成 box-kind 感知的 helper。**已按可达性完成（2026-08-26）**：不是机械删除所有字面量；box-kind 共用接缝已统一到 source-format helper，仍存在的 `.sy` 均属于下面记录并由 guard/测试锁住的原生格式兼容契约。

**进度（2026-08-24，commit `f4c174c83`）**：读写接缝已落地，比预想的更省事——不需要新建 `NewNoemaLute()`：`util.NewLute()` 已经开了 `KramdownIAL`/`TextMark`/`GFMTable`（`parse.NewOptions()` 默认 true），够用。也不需要一个专门的 `Md2Tree`：`parse.Parse(name, markdown, luteEngine.ParseOptions)` 就是这个原语，`render.NewFormatRenderer(tree, ...).Render()` 就是反向的，两者早就在 `filesys/tree.go` 的 import 里了。落地方式：
- `conf.BoxConf` 加 `Kind` 字段（`""`/`"sy"` 默认、`"markdown"`），常量 `conf.BoxKindSy`/`conf.BoxKindMarkdown`。
- `filesys/box_kind_hook.go`：`BoxKindProvider func(boxID string) string`，model 层 init 注入（`model.GetBoxKind`），与 `DEKProvider` 同一套"回调注入避免循环依赖"手法。
- `filesys/tree.go`：`LoadTreeWithFix`/`WriteTree` 顶部按 box kind 分派到新的 `loadMarkdownTree`/`writeMarkdownTree`（+`prepareWriteMarkdownTree`），彻底跳过 `.sy` 专属的 JSON 订正 (`fixTreeJSONData`)、加密租约、rootID 前置缓存这些机制——markdown box 目前总是读盘重新解析，没有接现有缓存层（缓存层假设"parse 前就知道 ID"，markdown box 恰恰是"parse 后才知道 ID"，接缓存是后续性能优化，非本次范围）。
- 树 ID 恢复：不需要自己写逻辑——lute 的 `parse.IALStart`（`inline_attribute_list.go:37`）在识别到文档级 `{: id=... type="doc"}` 时已经直接 `t.Root.ID = ial[0][1]; t.ID = t.Root.ID`；缺失时 `finalParseBlockIAL` 兜底分配新 ID。两条路径都验证了：首次解析赋新 ID，之后每次重新解析同一文件都拿到同一个 ID（幂等，见 Spike 1）。
- 已写 3 组测试（`filesys/tree_markdown_test.go`）覆盖：markdown box 落盘的确是文本不是 JSON、私有语法字节保真、ID 跨读写稳定、二次读回再写字节不变（幂等）、sy box 行为未受影响。
- 用 baseline worktree 比对确认零回归（6 个失败测试——Obsidian 导入分析器 + MIME 类型环境相关——在 Phase 0 末尾的 commit 上就已经失败，与本次改动无关）。

**同一批顺带做掉的 §1.3 修复（commit `55af9476e`）**：Spike 1 发现的"列表结尾 + `#+end` 无空行分隔"重缩进 bug，已用 `filesys/markdown_orgenv.go` 的 `normalizeOrgEndBlankLines` 解决——不是补丁 lute，而是在 `parse.Parse` 之前对原始字节做一次针对性的空行插入（已用 spike 脚本验证空行能可靠阻断 CommonMark 懒续行）。**范围收窄到真正有风险的场景**：只在 `#+end` 前一行是列表项或列表续行时插入空行；纯段落场景虽然理论上也会被"懒解析"进同一个段落节点，但 `FormatRenderer` 不会给段落续行加缩进，字节其实不受影响，插入空行反而会制造多余的一次性 diff——所以特意不碰。同时对围栏代码块内容免疫（不误改代码示例里字面的 `#+end xxx` 文本），并且能自愈磁盘上已经被旧内核写坏的历史文件。3 组测试覆盖：列表场景修复、围栏代码块豁免、已损坏文件自愈。

**`.sy` 调用点清理增量（2026-08-26）**：完成了两条真实 Markdown 可达链路，不把仍属原生 SiYuan 导入/导出、加密历史和嵌套文档树的 `.sy` 字面量冒充为已迁移。`Box.GetInfo` 现在按 box kind 分派：Markdown box 通过 `ListMarkdownDocs` 只统计仓库内可见的 `.md/.markdown`，文档数、总字节和最新修改时间不再恒为零，`.git` 内文件也不会污染统计；sy box 保留原有 node-ID `.sy` 语义。另一方面，`normalizedMarkdownDocPath` 已成为 load/save、planning 查询与变更、portable property 查询与变更、附件目标和 bibliography 加载的共同入口，统一规范成 `/...` 路径，并在任何读写前拒绝非 Markdown 扩展名、仓库根、越界及任意隐藏路径。因此 `/api/noema/markdown/saveDoc` 不再可能“成功”写出随后被索引忽略的 `.sy` 幽灵文件，也不能进入 `.git/...`。聚焦 model/API 测试覆盖 `.md/.markdown`、大小/mtime、隐藏文件隔离、路径规范化和落盘前拒绝；其余 `.sy` 硬编码仍按可达性继续审计，不能把本增量记成 §1.1 全库机械清理完成。

**`.sy` 字面量最终可达性审计（2026-08-26，当前工作树）**：新增 filesys 层唯一 source-format seam：`IsMarkdownDocumentPath`、`IsNativeDocumentPath`、`IsDocumentPathForKind`、`IsBoxDocumentPath` 与可由 `errors.Is` 判别的 `ErrBoxDocumentPathKind`。通用 `LoadTree`、原生 `WriteTree`、增量 upsert/remove、全量索引、box 统计/子树枚举现在都通过该 seam 或显式 box-kind 分支判断，不再凭调用方传入的扩展名猜格式；`.markdown` 与 `.md` 也首次在增量索引上完全同义。审计由此修出两个真实索引漏洞：Markdown 仓库中的外来 `.sy` 曾会被 Markdown parser/SQL 接受；更严重的是，删除名为 `<live-projection-ID>.sy` 的外来文件曾会按文件名推导 root ID，误删另一篇真实 Markdown 投影。真实 FTS5 回归现断言两种请求均不会产生/删除 blocktree 或 SQL 行，且外来文件和 Markdown source 的字节保持不变。

同一 seam 还关闭了 `Box.Ls` 的格式串线：Markdown 仓库同时有 `foo.sy` 与 `foo/` 时，前者不再触发原生“文档同名目录即子文档树”的映射；原生 box 的旧映射由反向回归保留。剩余生产 `.sy` 字面量逐类核对后只存在于三种明确原生契约：`.sy.zip` 导入/导出协议、加密文档/历史的文件名与 AAD，以及已由 `RequireNativeDocumentTree` 在任何副作用前隔离的 node-ID 嵌套文档树；MIME 注册等格式声明也必须保留。用这些兼容字面量替换为 Markdown 路径既不正确，也会破坏原生 host。filesys/model 聚焦组、真实 FTS5 回归、全 kernel compile-only 与 `git diff --check` 已过；正式宽门禁、build/install 与 packaged smoke 见本批后续记录。

**`.sy` source-format seam 正式门禁（2026-08-26）**：filesys/model 聚焦组、真实 FTS5 upsert/remove 回归和 API/Noema/CLI/MCP/filesys/treenode/SQL/util 扩大组全绿；完整 `go test ./model/...` 仍精确只有既有 5 个环境基线失败（1 个 encrypted-asset 排序断言、4 个 macOS temp/Obsidian symlink 判定），没有本批新增失败。扩大组顺带抓到 clipboard math 测试用裸 `"456"` 定位正文，在节点 ID 时间戳恰为 `xx:xx:45.6` 时会误命中；断言现定位真实 DOM text node，连续 20 次与 API 全组均通过。精确 Node 26.5.0/npm 11.17.0 的 `make test` 为 176 files passed / 7 skipped、1643 tests passed / 16 skipped；`make build` 重建 3996-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 成功。

AGENTS.md 原样 packaged smoke 最终报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、21/21 b3 surfaces 且零 unadopted、95ch/4% typography contract、TOC、四 tab Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。canonical、installed `Resources/bin` 与 linked `Resources/app` 三处 kernel SHA-256 同为 `537df18467bf00033bea54b25f73701b7c3879f573e19ed59699e6ba9d1c32bc`；默认 root 无 `.siyuan`/`.sy`，全局 SiYuan registry SHA-256 保持 `d74d1e564c27b55ec3a8e67287b06fba385939e2efe3dd791ffa554ac1771f3b`，Emacs 两个 full-project 入口与 7 个 shared resource links 正确、retired lowercase path 缺席。退出后无 packaged Electron/web-host/kernel 或 smoke/probe temp；`make disk-audit` 仍为安装 App 44KB unique physical accounting，早先泄漏的单一 `file_test.go` fixture 目录已精确移入 `/Users/hc/.Trash/noema-test-artifact-20260718000000-abcdefg-20260826-1219`（可恢复），`git diff --check` 干净。

**本增量正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（169 files passed / 7 skipped，1607 tests passed / 16 skipped）；Markdown path/stat model 聚焦组和 bibliography/Markdown API 组全过，`go test ./noema/... ./api/... ./cli/cmd ./filesys/... ./treenode/... ./sql/... ./util/...` 全绿。完整 `go test ./model` 仍只有计划中已记录的 5 个环境基线失败（1 个 asset 断言、4 个 macOS 临时目录 symlink/Obsidian 校验），本批相关测试没有失败。`make build` 重建 3991-module renderer 与 FTS5 Go kernel，`make install` 成功；canonical、Resources/app 与 Resources/bin 三处 kernel SHA-256 同为 `f94aa92daf5f864bc51488a427076a72167264f862876f502a35bbc480d0ed19`。AGENTS.md 原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。默认根无 `.siyuan`/`.sy`；Emacs full-project link 和 7 个 shared resource links 全部解析到 canonical repository/`resources/`，retired lowercase path 缺席；smoke 退出后无 packaged 进程，本批审计临时文件已清除，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。

**原生文档树隔离增量（2026-08-26，当前工作树）**：继续审计发现，风险不止 `heading2Doc` / `li2Doc` 的 `.sy` 路径拼接；通用 block transaction 能凭 external Markdown 的投影 block ID 加载 tree，最终进入 `WriteTree` 的 FormatRenderer，可能把 CM6/Emacs 提交的源字节整篇格式化重写。现新增统一、可由 `errors.Is` 判别的 `ErrMarkdownNativeDocumentTree`，在 model 边界把 Markdown box 与 node-ID/.sy 文档树操作隔开：create/createWithMarkdown/daily-note、remove、rename、move、duplicate、doc↔heading、list-item→doc 均在任何文件或索引写入前失败关闭；HTTP、CLI 与 MCP duplicate/transaction 调用会原样返回错误，不再报告假成功。`PerformTransactions` 现先检查 operation tree 和所有常见 block/parent/sibling/source ID，再入异步队列；`loadTree` 与 commit 仍各保留一道纵深防线，覆盖未来漏接的调用方。Markdown 的保存、路径移动、planning/property CAS 等 repository-native API 不经过该 guard，sy notebook 则保持原行为。聚焦回归覆盖九类入口零写入、无 `.sy` 泄漏、transaction 同步拒绝和 sy compatibility；正式宽门禁与安装包取证见下。

**原生文档树隔离正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（169 files passed / 7 skipped，1607 tests passed / 16 skipped）；native guard、原生 transaction/database transaction、create/move/remove/heading/list-item model 聚焦组全绿，`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全过。完整 model 包仍精确为计划已记录的 5 个环境基线失败，没有新增失败。`make build` 重建 3991-module renderer 与 Go kernel，`make install` 成功；canonical、Resources/app 与 Resources/bin 三处 kernel SHA-256 同为 `63e081182cf28fe81885a191da5a4e942b3c95df64a37f477e356c9d1f998789`。AGENTS.md 原样 packaged smoke 报告 desktop/preload、54px、五项标题栏、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。默认根无 `.siyuan`/`.sy`，Emacs full-project + 7 个 shared resource links 全部指向本仓库，retired lowercase path 缺席；退出后无 packaged Electron/kernel，安装 App unique physical accounting 保持 44KB，`git diff --check` 干净。

**`.sy` 只读/维护路径隔离增量（2026-08-26，当前工作树）**：继续从字面量转向“真实 Markdown 可达性”审计，修出两个此前会静默返回错误结果、其中一个会主动清空正确索引的缺口。通用 idle/sync index-fix 原先对每个已打开 Box 固定扫描 shadow `data/<boxID>/*.sy`；Markdown shadow 只有 conf，空扫描随后进入 `ClearRedundantBlockTrees`，会把 external root 的有效 blocktree/SQL/FTS 投影当冗余删除。现在 duplicate-ID 文件修复只处理原生 Box，blocktree 修复则按 kind 分派：Markdown 复用 `reconcileMarkdownBoxChecked` 从注册的真实 root 对账，失败会保留 dirty/recovery 标志供下次重试，不能再以部分成功清标。真实 FTS5 回归在 repair pipeline 前后锁定 2 篇 source、blocktree 数量、唯一 FTS 命中和源字节全部不变。

同一审计补齐 Full Reindex 的引用第二阶段：`IndexRefs` 对 Markdown 通过 box-kind-aware 文件枚举加载 external `.md/.markdown`，不再分页 shadow `.sy`；回归先显式清空 refs，再证明全量 pass 可从真实 source 重建反链。旧 `.sy.zip` notebook/doc 导出现在在 model 层返回 `ErrMarkdownNativeDocumentTree`，HTTP 不再产出空或来源错误的归档；原始 `listDocTree` 与 `ListDocTree` 也在磁盘遍历前明确拒绝 Markdown，CLI/MCP 列表改走 `ListMarkdownDocs`，block-info/reload 的 subdocument 统计明确只在原生 Box 读取 `.sy` 子目录。聚焦 FTS5、model、API、CLI、MCP 测试与 `git diff --check` 已过；正式宽门禁、build/install 与 packaged smoke 见下一条。

**`.sy` 只读/维护路径隔离正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（169 files passed / 7 skipped，1607 tests passed / 16 skipped）；新增 FTS5 repair/ref rebuild、native export/list guard 及 API/CLI/MCP 聚焦组全绿，`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全过。完整 `go test ./model` 仍精确只有已记录的 5 个环境基线失败（1 个 encrypted-asset fixture、4 个 macOS temp symlink/Obsidian 校验），没有新增失败。`make build` 重建 3991-module renderer 和 FTS5 kernel，`make install` 成功；canonical 与 installed `Resources/bin` kernel SHA-256 同为 `b9c08f8590428f9d34a3b88ca4a0c2b7040e6b92b463ac1c4a079aaaa8da1499`。AGENTS.md 原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。默认 root 无 `.siyuan`/`.sy`，Emacs full-project link 与 7 个 historical shared asset links 全部解析到 canonical repository/`resources/`，retired lowercase path 缺席；无 Electron/web-host/kernel PID，审计临时文件已删除，`make disk-audit` 保持安装 App 44KB unique physical accounting，`git diff --check` 干净。

**原生导入/资产/历史与公共写入原语隔离增量（2026-08-26，当前工作树）**：继续审计“最终会被 `WriteTree` 拒绝、但此前已经产生副作用”的路径。`.sy.zip` 与通用 Markdown→原生文档导入现在先检查目标 box，再读取或解压来源；HTML→BlockDOM/Tree 的 base64 资源提取也在创建 assets 目录之前拒绝 Markdown，HTTP extension/lute 入口显式传播错误。通用 upload、`InsertAssetBytes`/`InsertLocalAssets`、network-assets 下载、box asset store 与文档 AI 图片生成均在目录、网络请求或付费生成之前按 blocktree/box 失败关闭；repository-native 的 `StoreMarkdownAsset*` 仍是独立允许路径。原生 file history 定时生成、显式 document history、format history 与 rollback 同样跳过或拒绝 Markdown，不再从 external root 复制伪 `.sy` 历史。

四个共享 tree write/index/rename queue helper 现统一做 nil 与 box-kind 检查，而且检查位于 blocktree/SQL mutation 之前；这把 tag/bookmark/search/template/AV 等遗漏调用方也收敛到同一不变量。`AutoSpace` 进一步在加载/格式化 AST、生成历史和触发 UI loading 之前拒绝；原生 create 内部不再丢弃 transaction 入队错误，闪卡 eligibility、reset 与旧内部 transaction 调用也会拒绝 Markdown 并逐层传播，不会再出现“没有落盘却报告成功”或先改 deck 的半事务。聚焦 model/API/CLI/MCP、FTS5 repair/ref/search 回归与 `git diff --check` 已全绿；这批改过生产 Go，上一条安装 hash 已明确失效，正式扩大门禁、build/install 与 packaged smoke 见下一条。

**原生副作用隔离正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 全过（169 files passed / 7 skipped，1607 tests passed / 16 skipped）；导入/HTML、upload/assets、history/format、公共写队列、create transaction 与 flashcard guard 聚焦组，以及 FTS5 repair/ref/search 回归均全绿。`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全过；完整 `go test ./model` 仍精确只有计划已记录的 5 个环境基线失败（1 个 encrypted-asset fixture、4 个 macOS temp symlink/Obsidian 校验），没有新增失败。`make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 成功；canonical 与 installed `Resources/bin` kernel SHA-256 同为 `b89f59df660ddc3a4b3aec87a2fb7d444c4552e941da1bfef4838c8f72840659`，installed `Resources/app` 继续链接 canonical repository。

AGENTS.md 原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。默认 `~/Documents/Noema` 无 `.siyuan`/`.sy`；全局 SiYuan registry SHA-256 保持 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`，Emacs full-project link 与 7 个 historical shared asset links 全部解析到 canonical repository/`resources/`，retired lowercase path 缺席；`/private/tmp` 无 `noema-*` 残留，`make disk-audit` 保持安装 App 44KB unique physical accounting，`git diff --check` 干净。

**Markdown 搜索、冷恢复与剩余原生副作用隔离增量（2026-08-26，当前工作树）**：生产全文搜索的 `paths[]` 现在真正接受 external box 内的 `/dir/page.md` 与安全目录前缀，继续拒绝无前导斜杠、隐藏路径和越界；SQL `LIKE` 参数对反斜线、`%`、`_` 做 literal escaping，真实 FTS5 回归用 `100%_needle.md` 与近似兄弟路径证明不会把文件名通配符误当查询语法。blocktree 冷恢复也不再只在 shadow `.sy` 中按原始字节找 ID：新 finder 按 box kind 扫描，Markdown 从真实 root 加载投影树并验证内部 UUIDv7 projection，原生 box 则保留 `.sy` byte prefilter + AST 确认；缺失子块不再因根块仍存在而跳过修复，加载失败也不再被当成命中。`loadParentTree` 明确不把 repository 目录当嵌套文档；invalid-ref、unused-AV、rename/unused/missing native asset 三类维护扫描显式跳过 Markdown，避免再次把空 shadow 当内容面。

继续按“副作用发生点”审计后，原生属性变更原语 `setNodeAttrs0` 现会在改 AST、cache、广播前拒绝 Markdown，堵住过去“源文件最终没写，但运行态已被污染”的半失败；block attr 单条/批量、block-ref transfer/swap、heading children append、shorthand 消费、非预览 template 应用、native flashcard notebook 查询和 attribute-view render/carrier/filter/sort/key/new-item 均在各自读取或写入 `storage/av`、移动快捷输入、调用远端提醒或改树之前检查 block/box 归属。全局 native tag/bookmark rename/remove 会在批量处理前预检 SQL 命中的 box，不能部分改完原生文档后才撞到 Markdown；box-doc/flashcard 的 `.sy` 根扫描也明确排除 Markdown。统一回归现在使用一篇真实 external `note.md`（而非伪造 `.sy` blocktree），逐项断言全部返回可由 `errors.Is` 识别的 `ErrMarkdownNativeDocumentTree`，源字节、文档集合、shadow `.sy` 与 `storage/av` 均零变化。上述生产 Go 改动使上一条 `b89f59…` 安装 hash 明确失效；聚焦 model/API 与 `git diff --check` 已过，正式扩大门禁、重建、安装和 packaged smoke 仍待本批完成后追加。

属性视图随后从“入口带一个 Markdown block ID 才拒绝”继续收紧到完整状态预检：每次 native AV mutation 会先解析显式行 ID 对应的真实 bound block、所有 carrier/mirror，以及一跳 relation/source AV；混入任意 Markdown projection 时，在 JSON、反向关系、载体 AST 或 history 发生变化前统一拒绝。该预检现覆盖 transaction 入队与 commit、row add/remove/replace/cell update、key/view/layout/filter/sort、duplicate、new-item、两向 relation refresh、template 克隆、asset link rewrite、删除同步与 AV history rollback；`PerformBlockUpdates` 也改为先从 blocktree/loaded tree 判断 box kind，再解析用户更新内容。历史回滚会先解密并验证 AV file ID 与完整 bound state，transaction commit 则在第一棵 tree 落盘前预检全部 related AV，避免“文档已经写入、关联库随后才拒绝”的半提交。动态块引用刷新只允许改写 native 引用目标；Markdown 定义仍可驱动 native target 更新，但 Markdown target projection 永不进入 AST write queue。

最后一轮 primitive 反查补出了两个只读/底层旁路。AV 查询中的 legacy compatibility repair（补默认 view、刷新 key order、规范 block-ref subtype、重建 mirror relation）现在只有完整 AV state 为 native 时才允许持久化；混合/悬空 AV 仍可读取，但查询不会暗改 `storage/av`。Markdown 全量索引也不再把任何 `NodeAttributeView` 投影写进 `storage/av/blocks.msgpack`，portable `#+begin av` 始终只属于源文件。底层 `Box.Mkdir/MkdirAll/Move/Remove` 现自身拒绝 Markdown，不能依赖上层恰好先拦；目录枚举也不再删除 external root 中看似陈旧的 `*.tmp` 用户文件。AV detached-row 批量追加增加整批前置结构校验，空行、nil value、缺失 key 或缺失 block data 返回错误而不是 panic，并保证拒绝时未写持久数据。真实 Markdown guard、AV/model/index/box 聚焦组与 `git diff --check` 已全绿；正式扩大门禁、安装和 packaged smoke 仍待下述本批最终证据。

**Markdown source/native shadow 隔离最终正式门禁（2026-08-26）**：真实 FTS5 的 search/path escaping、强杀恢复、Markdown save/reindex、watcher、planning/property mutation、两类 backlink、native metadata 与 vaultgit restore 共 13 条生产链路全绿；`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全过。完整 `go test ./model` 仍精确只有已记录的 5 个环境基线失败（1 个 encrypted-asset fixture、4 个 macOS 临时目录 symlink/Obsidian 校验），没有新增失败。精确 Node 26.5.0/npm 11.17.0 的 `make test` 为 169 files passed / 7 skipped、1607 tests passed / 16 skipped；随后按规定顺序 `make build`、`make install`，重建 3991-module renderer、FTS5 Go kernel 与 Electron shell并更新真实 App，canonical/installed kernel SHA-256 同为 `4fa36be3d38e35f4dbad4ea2daea842039501a7521297edea6b6924d5f6e82b0`，installed `Resources/app` 继续链接 canonical repository。

AGENTS.md 原样 packaged smoke 最终报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px 与 Back/Forward/Refresh/Editor actions/Window actions，TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 及 owned/listening kernel 全绿。默认 `~/Documents/Noema` 无 `.siyuan`/`.sy`；全局 SiYuan registry SHA-256 仍为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`。Emacs full-project link 精确指向本仓库，markdown/tex snippets、noema/latex/tex templates、KaTeX macros 与 accepted-words 共 7 个 historical links 全部解析到 `resources/`，retired lowercase path 缺席；无 Electron/web-host/kernel PID 或 `/private/tmp/noema-*` 残留，`make disk-audit` 保持安装 App 44KB unique physical accounting，`git diff --check` 干净。

**Phase 3 meta mutation 数据面纵切（2026-08-26，当前工作树）**：逐项核对 Phase 3 旧清单后确认 portable embed、UUIDv7 block ref 与 asset store/scan 已经由此前纵切接管；下一个仍真实存在的双后端是 `meta.mjs`——production 虽经 `SaveMarkdownDoc` 落盘，但 `add/remove/tag/hide-roam/activate-roam` 仍由 Node 解析、重建整段 meta。现新增纯 Go `kernel/noema/metadata` 与 `/api/noema/markdown/mutateMeta`：逐行 source scanner 会跳过 Markdown code fence，只接受唯一且闭合的顶层 meta block，重复/未闭合结构失败关闭；嵌套 summary、未知 plugin field、注释、原有字段、CRLF 和正文都保持字节稳定，只改目标字段。新页面 identity 由 Go 生成并校验 UUIDv7，旧 identity 原样可读；`hide-roam` 不会凭空注册页面，`activate-roam` 才分配身份。title/tag/project 的换行被约束在单行，不能注入第二个 metadata 字段。

model mutation 与 planning/property 共用逐文件锁，支持 disk-version precondition；live editor snapshot 即使 metadata intent 本身是 no-op 也会被保存，不能在 facade reload 时丢失未保存正文。所有真实写入继续只走 `SaveMarkdownDoc`，同步更新 source、blocktree、SQL/FTS 与 reload；受保护路由保留 auth/admin/readonly。shared Node host 的既有 `aaronnote:api:meta:*` facade 不变，kernel provider 只把 path/action/live Markdown/字段意图转发给 Go，并验证 `source:kernel-meta`；生产 App 与 Emacs 共用这一条 provider，Node compatibility fallback 不再参与已注册 external Markdown box 的 meta 语义。

**Phase 3 meta mutation 正式门禁（2026-08-26）**：纯 Go scanner/model/API 聚焦组、provider/runtime/tag/refs 5 文件 50 项与真实 FTS5 meta save/reindex 全绿；包含 search、恢复、watcher、planning/property、backlink、vaultgit 和 meta 的 14 条 FTS5 生产链路全过。`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全绿；完整 `go test ./model` 顺序重跑仍精确只有已记录的 5 个环境基线失败，没有新增失败。精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 169 files passed / 7 skipped、1609 tests passed / 16 skipped；`tsc --noEmit`、Node syntax 与 `git diff --check` 全过。

随后 `make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 更新真实 App；canonical/installed kernel SHA-256 同为 `1495b1afb59294f2ffa51c0a73fdebdca1e7429418d86019523a6290b146a827`。AGENTS.md 原样 packaged smoke 报告 desktop/preload、54px、五项标题栏、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。安装包 bundled kernel 又在隔离 external root 上真实执行 add → tag → loadDoc → SQL：返回 `source:kernel-meta`，UUIDv7 identity 在二次 mutation 后稳定，live editor suffix 保留且进入索引；probe root/workspace 已移入 `/Users/hc/.Trash/noema-meta-probe-{root,workspace}-20260826-0905` 可恢复。默认 root 仍无 `.siyuan`/`.sy`，全局 registry hash 保持 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`，Emacs full-project + 7 个 shared resource links 正确、retired path 缺席；无残留进程/本批 temp，安装 App unique physical accounting 仍为 44KB。

**CM6 保存原子 CAS 细节修复（2026-08-26，当前工作树）**：继续沿 Phase 3 的统一写入边界审计，确认 renderer 原有 `baseVersion` 校验只在 Node facade 完成；Node 重读磁盘并判定可写之后，到 Go kernel 真正覆盖文件之前仍存在 TOCTOU 窗口，外部编辑可能在这一段被静默覆盖。`/api/noema/markdown/saveDoc` 现接受 SHA-256 `expectedVersion` 与显式 `force`，Go 在逐 box/path 锁内重读当前字节、比较 version 并完成 canonical save/reindex；普通全文保存、planning、property、meta 和 vaultgit restore 共享同一把文档锁，语义 writer 在持锁后调用共同的内部保存原语，不会递归加锁。前置条件失败返回当前 source/version/mtime/size 且完全不写文件、不刷新索引；force 保持已有明确覆盖语义。

desktop kernel provider 会把 version 前置条件传入 Go，并把 kernel conflict 当作正常 CAS 结果而非“kernel 改写源字节”的协议错误；Node save queue 保留原有同客户端连续保存判定，但在最后一次 precheck 后把刚读到的精确 digest 交给 kernel，因此竞态窗口已在实际写入所有者处闭合。model/API 回归锁定陈旧 version 零写入，provider/runtime 回归模拟 Node precheck 后才落地的外部编辑；真实 FTS5 并发回归让两个 writer 同时携带同一 base version，证明只出现一个 winner、另一个收到 winner 的 source/version，最终磁盘、blocktree 与 SQL 内容均指向同一 winner。该并发链在 `go test -race -tags fts5` 下也通过；聚焦 Go 与精确 Node 26.5.0/npm 11.17.0 的 4 文件 35 项测试全绿。正式全量 test/build/install、安装包探针与 packaged smoke 见下一条门禁记录。

**CM6 保存原子 CAS 正式门禁（2026-08-26）**：包含 search、冷恢复、save/CAS、watcher、planning/property/meta、两类 backlink、native metadata、external box、index remove 与 vaultgit restore 的 14 条真实 FTS5 生产链路全绿；CAS 并发链另在 race detector 下通过。`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全过；完整 `go test ./model` 仍精确只有已记录的 5 个环境基线失败，没有新增失败。精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 169 files passed / 7 skipped、1611 tests passed / 16 skipped；`tsc --noEmit`、Node syntax 与 `git diff --check` 全绿。

随后 `make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 更新真实 App；canonical/installed kernel SHA-256 同为 `546db2244c3e5b200d24f5d60284265d62b4649bd7dd8bdf6b430934a4e7d586`。AGENTS.md 原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。安装包 bundled kernel 在隔离 external root 上用正确 base version 提交 `winner-marker`，再用同一个旧 version 提交 `stale-marker` 时返回 `conflict:true`、胜者 version `24a334c3ab5de606c80bd239849a94c9d7cbe43487b4a4510e9a769cc9555278` 与相同 mtime；`loadDoc` 复读仍只有 winner。

首次手动探针启动遗漏了 host 正常设置的 `NOEMA_KERNEL_CONFIG_DIR`，因此隔离 workspace 被追加到全局 SiYuan registry；审计当场发现后只移除该精确条目，并通过正常 kernel registry writer 恢复原有 7 条顺序与无尾换行序列化。随后在同一 probe 上带独立 config 目录重启，隔离 registry 只含 probe workspace，全局 registry 启停前后 SHA-256 均为 `d74d1e564c27b55ec3a8e67287b06fba385939e2efe3dd791ffa554ac1771f3b`。root/workspace 最终均移入 `/Users/hc/.Trash/noema-cas-probe-{root,workspace}-20260826-0918` 可恢复；默认 root 无 `.siyuan`/`.sy`，Emacs full-project 与 7 个 shared asset links 全部解析到 canonical repository/`resources/`，retired lowercase path 缺席，无 packaged/kernel/web-host PID 或本批 `/private/tmp` 残留，安装 App unique physical accounting 仍为 44KB。

**Phase 3 session 状态数据面纵切（2026-08-26，当前工作树）**：迁移表中的 `session.mjs` 原先仍由 Node 在 `stateRoot/recent.json` 与 `positions.json` 做 read-normalize-write。现新增 kernel Markdown session state 与 `/api/noema/session/{read,touchRecent,touchPosition}`：已注册 external box 的 recent/cursor 以 notebook-relative Markdown path 存进 kernel workspace 的 shadow `data/storage/noema-session/<box>.json`，不把绝对 root 写入状态，也不触碰 external source。recent 仍按最新 openedAt 去重并限制 24 条；cursor 仍按 file + client slot 去重、限制 240 条，保留 Emacs split client 与无 client fallback 两个位置，mode/from/to/scrollY/updatedAt 的归一化与旧 SessionManager 一致。损坏的可选 UI state 读作空并在下一次 touch 自愈，意外 IO 错误继续失败；同一锁内 read-normalize-atomic-write，两个分屏同时保存不会互相覆盖。

新的 kernel session provider 只负责既有 absolute-file facade 与 portable notebook/path 互译，并验证 `source:kernel-session`、notebook identity 与返回路径 containment；shared host 在 kernel ready 时安装它，App 与 Emacs 走同一边界。standalone Markdown、Typst/其他非 box 文件及无 kernel Server reader 继续使用 Node compatibility state；session 本身只是可选 UI 状态，瞬时 kernel outage 也允许落回 Node，而不会阻断编辑。Go model/API、race detector、provider/runtime/fallback 与旧 SessionManager 聚焦回归全绿，TypeScript、Node syntax 和 `git diff --check` 已过；正式扩大门禁、build/install 与 packaged production session 探针见下一条。

**Phase 3 session 状态数据面正式门禁（2026-08-26）**：Go model/API session 聚焦组与 `go test -race ./model -run '^TestMarkdownSession'` 全绿，`go test ./noema/... ./api/... ./cli/cmd ./mcp/tools ./filesys/... ./treenode/... ./sql/... ./util/...` 全过；完整 `go test ./model` 仍精确只有已记录的 5 个环境基线失败，没有新增失败。kernel provider/runtime/fallback 与旧 SessionManager 的 3 个 Node 文件 8 项聚焦回归全过；精确 Node 26.5.0/npm 11.17.0 下最终 `make test` 为 171 files passed / 7 skipped、1615 tests passed / 16 skipped。`make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 更新真实 App；canonical/installed kernel SHA-256 同为 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`。

AGENTS.md 原样 packaged smoke 最终报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿；全局 registry 启停前后 SHA-256 均为 `d74d1e564c27b55ec3a8e67287b06fba385939e2efe3dd791ffa554ac1771f3b`。随后用独立 root/workspace/config 启动安装包 bundled kernel，真实写入一条 recent 与 left/right 两个 pane cursor；复读为 `source:kernel-session`、一个 notebook-relative `/paper.md`、两个 client slot 及由较新的 right slot 更新的无 client fallback。shadow JSON 不含 external root，源 Markdown 前后 SHA-256 均为 `a2324e74295bfb6ca0f7beb38e98b6314a7b313b663c64a246259bfcba42af88`。探针已移入 `/Users/hc/.Trash/noema-session-probe-{root,workspace}-20260826-1002`（可恢复）；默认 root 无 `.siyuan`/`.sy`，Emacs full-project + 7 个 shared resource links 正确、retired lowercase path 缺席，无 packaged/web-host/kernel PID 或本批 `/private/tmp` 残留，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。

### 1.2 块 ID 策略：惰性 IAL（org-roam 模型）

markdown 无法承载稳定块 ID，这是 md 为真相源的核心代价。方案：

- **文档级 ID**：写进已有的 `#+begin meta` 块（Noema 现成结构，`src/org-meta.ts` + `shared/meta-summary.mjs` 已在解析）
- **块级 ID：按需分配**。普通块不带 ID；当某块**第一次被引用 / 被嵌入 / 被设属性 / 进入属性视图**时，才在该块尾部写入 `{: id="20260824153000-a1b2c3d"}`。lute 用 `SetKramdownIAL(true)` 已能原样解析与渲染这一行
- 理由：git diff 干净，Emacs 里看到的仍是普通 markdown，且语义与 org-roam 的 `:ID:` property 完全一致 —— 用户已经在这个心智模型里

**必须先做 spike 验证**：`md(带 IAL) → lute.Md2Tree → FormatRenderer → md` 字节级往返稳定。这一条不成立，整个 Phase 1 要换方案（退路：sidecar ID 映射，代价是外部编辑后失效）。

**进度（2026-08-24）**：Spike 通过（见下方 Spike 小节），已落地。惰性 IAL 对列表项不成立（lute/SiYuan 块模型的必然代价，见 §1.1 进度记录），对段落/标题成立——只有真正被引用/设属性的块才会带上 `{: id=...}`。

**✅ 已解决（2026-08-24，发现于 commit `f8dcb6ff7` 之后测 `/api/search/*` 时，方案定于用户决策，实现于 commit `9765a4861`）**：惰性 IAL 和"要吃到 SQLite/FTS5 索引与搜索"这两个目标**直接冲突**，不是实现细节问题，是架构层面的矛盾。Aaron 选了方案 B（文档级搜索）。

证据链：写了个端到端测试，往一个 markdown box 存一篇"# 标题\n\n包含一个独特搜索词的段落。"这样的普通文档（标题、段落都没有显式 `{: id=...}`），`SaveMarkdownDoc` 返回的块列表里**只有文档根节点**，标题和段落完全不在里面——这是设计如此（§1.2 的"惰性 IAL"）。查到 `sql/database.go:684`：`if "" == n.ID || !n.IsBlock() { return ast.WalkContinue }`——这是 `fromTree`（往 `blocks`/`blocks_fts` 表插数据的入口）对没有专属 case 的节点类型（标题、段落等都在其中）的兜底逻辑，**没有 ID 的块根本不会变成一行索引数据**。这不是我这次改动引入的 bug，是思源本来的设计——在 `.sy` 世界里每个块永远有 ID，这条判断从来不会触发；只有 markdown box 的"惰性 IAL"才会真的制造出大量没有 ID 的块。实测：文档根节点在 `blocks` 表里那一行的 `Content`/`Markdown`/`FContent` 全部是空字符串（`NodeDocument` 在 `buildSpanFromNode` 里也没有专门构造内容，只处理封面图和标签），全文检索对这类文档**什么都搜不到**。

也就是说：**任何一篇没有主动加引用/属性的普通笔记，标题和正文段落都不会进入可搜索的索引**——而这恰好是任何真实 vault 里占比最大的内容。惰性 IAL 是为了 git diff 干净特意做的（org-roam 心智模型），但代价是牺牲了这份计划本身列出的"要吃到的"核心收益之一（块引用、**SQLite/FTS5 索引与搜索**）。

三个可能的方向，各有真实代价，需要用户拍板，不是我能单方面替 Aaron 决定的产品取舍：

- **方案 A：markdown box 里也让每个块都有真实持久化 ID**（放弃"惰性"，向 `.sy` 的"每块必有 ID"看齐）。优点：搜索/反链/属性视图全部原生可用，不用改索引层。代价：完全放弃 §1.2 的 git-diff-干净目标——每篇笔记第一次被内核碰过之后，每个段落/标题都会多一行 `{: id=...}`，org-roam 式的心智模型不成立了。
- **方案 B：markdown box 用"文档级"索引，不追求块级颗粒度**——把整篇文档的 markdown 正文塞进文档根块自己的 `Content`/`Markdown`/`FContent` 字段（目前 `fromTree` 对 `NodeDocument` 完全没有填充这几个字段，需要专门加逻辑），全文检索退化成"搜到哪篇笔记命中"，而不是"搜到哪一段命中"。优点：保住 git diff 干净、保住惰性 IAL；搜索仍然可用，只是精度粗一级——命中文档后，跳转到文档内的具体位置可以让 CM6 自己再做一次本地文本查找/高亮（不需要内核给出块级坐标，本来 Phase 2 的 from/to 澄清就是这个思路）。代价：搜索结果列表没法像思源原生那样按块摘要展示上下文片段，需要另外设计。
- **方案 C：只在检索索引层用临时/派生 ID（不落盘），不当成真正的块 ID**——本质上是把这次刚修掉的"临时 ID"bug 反过来，只是限定在一个明确知道会失效、会重建、不参与 blocktree/反链稳定性保证的独立检索索引里。复杂度最高，两套身份体系并存，容易再踩坑，不推荐在没有更强需求（比如反链也需要块级精度）之前做。

个人倾向 B（先把"文档级搜索"做对，块级精度作为后续按需引用时自然获得的增量能力——这恰好和"按需分配 ID"的哲学一致：搜索先按文档定位，用户如果想要块级引用/属性，本来就要显式给那个块加 ID，那时候它自然也会变成可精确检索/反链的单元）。

**实现（commit `9765a4861`）**：改动全部在共享的 `sql` 包，按 box kind 分流，不影响 `.sy` box：
- `sql.IsMarkdownBoxFn func(boxID string) bool`（`sql/database.go`）——新的注入式回调，跟 `IsEncryptedBoxFn` 同一个模式，`model/filesys_init.go` 里 `init()` 注入。
- `buildBlockFromNode`（`sql/database.go`）的 `NodeDocument` 分支：markdown box 时不再只取 `n.IALAttr("title")`（对 markdown 文档永远是空的），改成 `markdown` 字段塞 `treenode.ExportNodeStdMd(n, luteEngine)` 渲染的整篇正文，`content`/`fcontent` 字段手动遍历根节点的直接子节点、逐个取 `nodeStaticContent` 拼起来。
- 踩了一个坑：`nodeStaticContent`（`sql/block.go`）自己对 `NodeDocument` 类型也有一个独立的特判（同样只返回 `title` IAL，不会走到下面通用的 `ast.Walk` 正文提取逻辑），所以不能直接把 Root 节点传给它——这也是为什么改成手动遍历子节点而不是直接调用一次。这个函数被很多地方调用，没有改它的签名去穿透 boxID，范围收窄在调用点更安全。
- 还踩了一个纯测试层面的坑（不是产品代码的 bug）：`buildTypeFilter` 把非 nil 的空 `map[string]bool{}` 当成"每个类型都显式设为 false"，不是"不过滤、用 `Conf.Search` 默认值"（那是传 `nil` 才有的行为）——第一版测试传了空 map，搜索永远查不到东西，排查了一路才发现是测试参数传错。
- `TestFullTextSearchFindsMarkdownBoxContent`（上一个 commit 加的、故意 skip 的）去掉 skip 后直接通过，和另外三个 fts5 端到端测试一起跑、以及 `sql` 包自己的默认测试套件都确认无影响。

### 1.3 非 CommonMark 节点的 markdown 载体 = org-env

思源有若干 markdown 表达不了的节点类型。用 Noema 现有的 `#+begin/#+end` org-env 语法承载（`shared/command-syntax.mjs` 已是双端规范解析器）：

| 思源节点 | Noema markdown 载体 |
|---|---|
| `NodeSuperBlock` (`{{{col`) | `#+begin superblock :layout col` |
| `NodeAttributeView` | external Markdown 使用 portable `#+begin av Title` query body（`source/columns/filter/sort/limit`）；`.sy` box 继续使用原 `data/storage/av/*.json`，两种真相源不混用 |
| `NodeBlockQueryEmbed` | `#+begin embed :sql <...>` |
| 块引用 `((id "anchor"))` | 原样保留，lute 已解析 |
| IAL 属性 | 行尾 `{: key="value"}` |

这条映射是本方案最自然的一处：**Noema 的 org-env 语法正好是思源重块类型的 markdown 编码**，两边都不用迁就。

**Spike 1 实测发现（2026-08-24）**：`#+begin/#+end` body 若以列表结尾（无空行分隔即接 `#+end`），lute 的 CommonMark 列表续行规则会把 `#+end xxx` 吞成列表最后一项的续行并加两格缩进（`  #+end note`）—— 这不影响 `shared/command-syntax.mjs::isBlockCommandCloseLine`（其 `^\s*#\+end...` 本就容忍前导空白），但意味着**内核第一次 FormatRender 任何这种文档就会重写该行的缩进**，制造语义无关的 git diff，违反 §1.5 验收标准"git diff 只显示语义改动"。结论：kernel 侧的 `#+begin/#+end` 解析（至少 av/superblock/embed 这三种保留 kind）不能依赖 lute 默认的段落/列表延续规则收尾，必须仿照 lute 现有的围栏代码块/数学块模式，做成显式逐行扫描的 fenced-container block（开闭行独立匹配，不参与列表续行判定）。非保留 kind 的普通 `#+begin note` 块若仍走默认解析，同样的重缩进问题会出现，因此这个 fenced-container 扫描规则应该覆盖所有 `#+begin/#+end`，不只是三个保留 kind。

**当前实现校正（2026-08-26）**：上面的结论建立在“Markdown tree 仍会被 Lute FormatRenderer 回写”这个 Spike 阶段前提上；当前 source-authoritative 架构已经从 primitive 层禁止该路径，`filesys.WriteTree` 对任何 Markdown box 固定返回 `ErrMarkdownTreeWriteUnsupported`，所有写入只允许全文 text protocol 或有界 source patch，因此列表后的 `#+end` 不可能再被 AST formatter 写坏。`loadMarkdownTree` 只为可丢弃的索引 AST 在内存中插入阻断 lazy-continuation 的空行，磁盘原始字节另行读取并原样返回；语义 org-env（identity/property/planning/AV/embed）由 `kernel/noema/markdown` 等窄 source scanner 直接扫描原字节，不依赖 Lute 把它伪装成原生块节点。回归同时锁定 list-tail close 在索引 parse 中保持独立、代码围栏内字面量不动、Markdown `WriteTree` 失败关闭和 load/save 字节保真。因此不再修改上游 Lute parser 增加一套只为防 formatter 的私有 fenced node；那会在风险已由更强的不变量消除后重新制造双语法源。

### 1.4 路径模型简化

markdown box 用真实文件名，不用 `<parentID>/<childID>.sy`：
- `Path` = 相对路径 `/subdir/note.md`
- `HPath` = 同构（不再需要 `filesys/tree.go:235-296 LoadTreeByData` 逐级打开父 `.sy` 读 title IAL）

改 `model/path.go` + `model/file.go` 的文档树导航。改名 = 文件改名 + 链接重写（Noema 现有逻辑照搬）。

**进度（2026-08-26）：生产路径纵切已完成。** `filesys.loadMarkdownTree` 现在令 `Path` 与 `HPath` 都等于带扩展名的真实仓库相对路径（例如 `/subdir/note.md`）；目录只是目录，不再逐级打开父 `.sy` 或把扩展名从 HPath 中抹掉。旧 `model/path.go` / `model/file.go` 仍是 `.sy` notebook 的兼容实现，但 App 与 Emacs 共用的 web-host 对 external Markdown box 已不再进入那些 API：创建/保存走 `SaveMarkdownDoc`，单文档改名/移动走 `MoveMarkdownDoc`，真实目录改名/移动走 `MoveMarkdownPath`，复制和 metadata/tag 改写也都经同一个 kernel Markdown provider；`.sy` adapter 的既有行为不变。

`MoveMarkdownDoc` 只接受已打开的同一 Markdown box 内 `.md`/`.markdown` 文件，真实 rename 后重载 source、保留 canonical `meta.id`，原子替换 blocktree/SQL/FTS 路径投影；解析失败会先把文件名回滚再报错。Node 的 rename/move 先调用该端点，完成后复用既有全库来链重写；跨目录移动还会按旧/新基准目录重算被移动文档内部所有相对 Markdown 链接（含图片/附件、query/fragment），绝对/roam/外部协议不动。因为文件移动已经提交，后续链接修复若失败会在成功响应里明确返回 repair error，而不会返回一个诱导调用方重试旧路径的假事务失败。

目录操作也不再旁路：`MoveMarkdownPath` 在同一个 database-index 临界区内扫描目录中的 `.md/.markdown`、拒绝 symlink source/隐藏路径/移入自身，原子 rename 整个真实目录（所以图片等非 Markdown 资产一起移动），全部新文档解析成功后才删除旧 root projections 并同步 upsert 新 Path/HPath；任一解析失败先回滚目录。provider 返回确定的 old/new document map，Node 据此只读每篇 source 一次：目录内部互链/图片保持相对位置不变，指向目录外且因深度变化的链接重算，目录外指向被移动文档或资产的来链按 old/new prefix 在一次 vault scan 中更新。目录聚焦回归覆盖 `.md` + `.markdown` + PNG、内部 doc/image links、外部 doc/asset links、query/fragment、不同目录深度和 self-move 失败关闭。

同时补齐了两个路径边界：此前 watcher、冷索引与暖对账只接受 `.md`，而 list/provider 已接受 `.markdown`，现在三条索引路径统一使用同一扩展名判定；暖启动回归用真实 `added.markdown` 锁定 SQL/FTS。`ValidateBoxRelativePath` 也从纯词法包含升级为“解析最长已存在前缀”的 realpath 边界：仓库内 symlink 可以使用，指向仓库外或 dangling symlink 的直接 Go API 路径会失败关闭，不能绕过 Node provider 写到根外。

本批真实 FTS5 回归验证 `/notes/new.md → /archive/renamed.markdown` 后源字节与文档身份不变、旧 blocktree/SQL 路径消失、新 Path/HPath 同构且 unregister 不碰外部源；Node 集成验证 create/copy/metadata/rename/move 全经 provider、来链与内部相对链接精确重写。扩大 Go 组全绿；精确 Node 26.5.0/npm 11.17.0 的独占 `make test` 为 165 files passed / 7 skipped、1590 tests passed / 16 skipped。首次并行门禁中唯一失败是既有 HTML renderer 的 1 秒性能阈值在同时跑 Go 压测时耗时 1.337s；独占复跑为 582ms，随后完整门禁全过，不是功能回归。下面重建、安装并用 bundled kernel 做真实路径移动与 packaged smoke。

**路径模型正式门禁（2026-08-26）**：`make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新真实 `/Applications/Noema.app`；installed link 与 canonical kernel SHA-256 同为 `e89c0533413d321faafd0adebac68dcc7e76fa41fd63b93c4aaff3992e2bf225`。隔离 external root 上由安装包 Electron runtime 启动 shared web-host，再由 bundled kernel 持有 box；生产 facade 创建三篇笔记后把 `drafts/old.md` 移到 `archive/old.md`，响应报告内部相对引用 2 条、来链 1 条。复读确认 `[peer](../drafts/peer.md#part)`、`![plot](../drafts/images/plot.png?raw=1#view)` 与 `[old](archive/old.md#section)`，Go `listDocs` 精确为新路径 + 两个未移动路径，`kernel-fts5` 唯一命中新路径，旧文件不存在且 external root 无 `.siyuan`/`.sy`。

AGENTS.md 原样 packaged smoke 同时报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC popover、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 SiYuan registry SHA-256 保持历史值 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；probe 已移入 `/Users/hc/.Trash/noema-path-probe-20260826-013022`（可恢复），无 packaged/web-host/kernel PID 或 smoke/probe 临时目录遗留。默认根无 `.siyuan`/`.sy`，Emacs full-project link 与 7 个 shared resource links 全部解析到本仓库，retired lowercase path 缺席；`make disk-audit` 仍报告安装 App 44KB unique physical accounting，`git diff --check` 干净。

目录移动补齐后的扩大 Go 组继续全绿；精确 Node 26.5.0/npm 11.17.0 的独占 `make test` 更新为 165 files passed / 7 skipped、1591 tests passed / 16 skipped。该生产增量使上一个 file-only build hash 失效，下面重新执行最终 build/install、隔离 directory move 取证和 packaged smoke。

**目录路径模型正式门禁（2026-08-26）**：最终 `make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新 `/Applications/Noema.app`；canonical 与 installed kernel SHA-256 同为 `edd182e67cf2b93eaebf95a17bae658e6d0acf5fa386a780e87901216c5d444e`。随后由安装包 Electron runtime 启动 shared web-host，并由 bundled kernel 持有全新隔离 external root：把含 `a.md`、`b.markdown` 和真实 PNG 的 `drafts/topic` 移到更深一层的 `archive/deep/topic`，生产 facade 返回 `fs-moved`，被移动文档内部跨目录引用重算 1 条、目录外 source 的 doc/image prefix 来链重写 2 条且只写 1 篇文档；复读确认内部 `b.markdown`/PNG 相对链接保持不变、指向根级 peer 的链接变为 `../../../peer.md`，目录外链接保留 fragment/query。Go `listDocs` 精确为 `/archive/deep/topic/a.md`、`/archive/deep/topic/b.markdown`、`/peer.md`、`/source.md`，FTS 查询只返回新 `a.md` 路径，旧目录消失、PNG 八个探针字节完整，external root 无 `.siyuan`/`.sy`。

AGENTS.md 原样 packaged smoke 再次报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 `~/.config/siyuan/workspace.json` SHA-256 保持 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；最终探针已移入 `/Users/hc/.Trash/noema-directory-probe-20260826-014908`（可恢复），客户端 harness 首次相对 open 检查产生的隔离探针也移入废纸篓，`/private/tmp` 无残留且无 packaged/web-host/kernel PID。默认根无 `.siyuan`/`.sy`，Emacs full-project link 与 7 个 shared resource links 全部解析到本仓库，retired lowercase path 缺席；`make disk-audit` 仍报告安装 App 44KB unique physical accounting，`git diff --check` 干净。

**Phase 3 LaTeX 确定性数据面最小完整纵切已落地（2026-08-26，当前工作树）**：新增 `kernel/noema/latex`，把生产 Pandoc 前的 YAML/Noema metadata、隐私块与私有命令剔除、语义 outline、环境/TikZ/callout、citation/revision/comment、数学与代码保护、`@@latexmk` 校验，以及 Pandoc LaTeX 的 whitespace/code-environment 后处理迁进纯 Go；模板也先由 Go 校验 placeholder 并返回 immutable segments plan，Node 可在 Codex 多轮编译中同步重复装配。Pandoc、TeX、Codex 子进程、模板/源文件 IO 与 bibliography 集成继续只由共享 Node host 持有，Electron adapter 没有复制任何导出逻辑。

四个只读 endpoint（`preparePandoc`、`extractMetadata`、`postprocessPandoc`、`planTemplate`）已通过统一 kernel state 接到 shared-host provider；App 与本地 Emacs 在 kernel ready 时使用同一 Go transform，Server reader/无 kernel 场景继续使用保留的 JavaScript 兼容实现。任何已配置 provider 的 production export 必须同时具备 Go prepare/postprocess，否则失败关闭，不能形成一半 Go、一半 Node 的混合结果；成功响应显式报告 `transformSource: kernel-latex`。`shared/latex-transform-fixtures.json` 同时由 Go 与 JavaScript 消费，当前 11 组成功契约覆盖 BOM/folded YAML、semantic/setext、嵌套隐藏块、multiline private、HTML/code/math/link 保护、proof 词边界、annotation/citation、custom env/TikZ、callout 与全部 page-flow mark；4 组非法 mark 逐字节对齐 error。Go package/API 全组与 LaTeX/provider/export 5 个 TypeScript 文件 61 项已过；下一步扩大 Go/Node 门禁、执行真实安装包机械导出取证，再重跑正式 build/install/smoke。

LaTeX 批扩大门禁已过：`go test ./noema/... ./api/... ./cli/cmd ./filesys/... ./treenode/... ./sql/... ./util/...` 全绿；LaTeX/bibliography/citation 14 个 TypeScript 文件 137 项、`tsc --noEmit`、Node syntax 与 `git diff --check` 全过。精确 Node 26.5.0/npm 11.17.0 的仓库级 `make test` 更新为 168 files passed / 7 skipped、1598 tests passed / 16 skipped。下一步正式 build/install，并从安装包 Electron runtime + bundled kernel 完成 production mechanical export 取证和 AGENTS.md 原样 smoke。

LaTeX 批正式 `make build` 已重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 已事务更新 `/Applications/Noema.app`；canonical/installed kernel SHA-256 同为 `db5c035ba5579bdab332ed11bf8c1e43e0575dc01fead4b7c26075989ca1b8c7`。随后用安装包 Electron runtime 启动 shared web-host 与 bundled owned kernel，注册全新隔离 external root，从 production `aaronnote:api:latex:export` 发起 mechanical task；任务完整经历 Pandoc conversion、final PDF verification、atomic commit，结果为 `transformSource:kernel-latex`、`engine:pandoc`、warnings 空，生成 1545-byte `.tex` 与有效 PDF。产物含 semantic section/subsubsection、Markdown child `subparagraph`、directional proof、inline math、`newpage` 与公开正文；private project attrs 和整个 hidden source block 的三个探针字符串均不存在，证明生产隐私过滤实际走 Go 而非仅单测通过。下一步执行 AGENTS.md 原样 packaged smoke 与退出/链接/磁盘卫生最终核验。

**Phase 3 LaTeX 确定性数据面正式门禁（2026-08-26）**：AGENTS.md 原样 `NOEMA_DESKTOP_SMOKE=1 /Applications/Noema.app/Contents/MacOS/Electron` 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 SiYuan registry SHA-256 仍为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；production export probe 已移入 `/Users/hc/.Trash/noema-latex-probe-20260826-022128`（可恢复），`/private/tmp` 无本批 probe/smoke，Electron/web-host/kernel PID 均已退出。默认 `~/Documents/Noema` 无 `.siyuan`/`.sy`；Emacs full-project link 指向本仓库，7 个 shared asset links 全部解析到 `resources/`，retired `lisp/roam/aaronnote` 缺席；`make disk-audit` 继续报告安装 App 44KB unique physical accounting，`git diff --check` 干净。

**Phase 3 vaultgit 首个生产纵切已落地（2026-08-26，当前工作树）**：新增 `kernel/noema/vaultgit` 与 `/api/noema/vaultgit/{status,action}`，由 Go 在注册 external Markdown box 的 realpath 边界内直接执行有界 Git CLI，显式关闭交互认证并限制 stdout/stderr 为 8 MiB；status 保持旧 `--porcelain=v1 --branch`、当前分支与 origin URL 契约，写操作保持 `pull --ff-only`、push 和 selected-path commit，pull 继续返回 HEAD 前后 NUL 分隔 diff 的精确 repository-relative changed paths。action endpoint 受 auth + admin + readonly middleware 保护；越界仓库、非直接 `.git`、隐藏/父级 pathspec、空 commit message 与不支持 action 全部失败关闭。

shared-host 新 provider 已接入统一 kernel lifecycle：App 与本地 Emacs 的 kernel listening 时，生产 `wikiRepositoryStatus` / `runWikiGitAction` 走 Go 并报告 `source:kernel-vaultgit`；kernel 未配置的 Server reader 继续走旧 Node compatibility implementation 并报告 `source:node-vaultgit`。Node 仍唯一持有 repository discovery/manifest、auto-sync policy、checkpoint/integration worktree、conflict UI 与 ungit 进程，不把这些宿主编排复制进 Go 或 Electron adapter。Go 核心真实仓库测试覆盖 dirty status、selected commit、fast-forward pull 精确路径和非法请求；API 真实 external box 测试再锁定 box boundary 与 HTTP shape；provider/wiki/desktop 三个 TypeScript 文件 29 项、`tsc --noEmit`、Node syntax 与 `git diff --check` 已过。

vaultgit 批扩大门禁已过：`go test ./noema/... ./api/... ./cli/cmd ./filesys/... ./treenode/... ./sql/... ./util/...` 全绿；精确 Node 26.5.0/npm 11.17.0 的最终 `make test` 为 169 files passed / 7 skipped、1601 tests passed / 16 skipped。审阅中把两种路径重新拆开：用户 commit pathspec 继续拒绝父级/隐藏状态目录并做旧兼容 normalization；Git 自己的 `diff --name-only -z` 输出则保持 byte-exact，不会把合法的 `.noema/...` 或首空格文件名误判成用户越界输入。Go/Node 两层都只对 absolute、空 segment 与 `.`/`..` 做 containment 防御，新增回归锁定隐藏路径、首空格和正常 nested path。

**Phase 3 vaultgit 首个生产纵切正式门禁（2026-08-26）**：`make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新 `/Applications/Noema.app`；canonical/installed kernel SHA-256 同为 `6a1a28e972962970347a85c6a67da8772f290fee72e45600f62bdc0ef118e39a`。随后由安装包 Electron runtime 启动 shared web-host 与 bundled owned kernel，在隔离 Wiki root + bare remote 上从 production `aaronnote:api:wiki:*` facade 完成 clean/dirty status、selected-path commit、push 与 fast-forward pull：全部显式报告 `source:kernel-vaultgit`，Git commit tree 只有选中的 `a.md`，未选 `b.md` 保持 working-tree dirty；collaborator 推入 `incoming.md` 后，pull 的 `changedPaths` 精确只有该文件的仓库绝对路径，最终 HEAD 与 origin/main 相等。

生产探针同时把兼容边界实测清楚：自动 sync 开启时，现代 checkpoint/sync 数据面会主动切到无 upstream 的 `noema/<device>-*` work branch，所以 legacy direct pull 不是该模式的同步入口（当前 UI 只用 direct status，Local commit/Commit & sync 分别走 checkpoint/sync）；因此 direct-action 取证明确用 `NOEMA_WIKI_AUTO_SYNC=0` 隔离。机器全局 `pull.rebase=true` 且仍有未提交文件时，旧 Node 与新 Go 同样让 `git pull --ff-only` 原样失败，未吞错或偷偷 stash；恢复隔离探针的未提交文件后 fast-forward 成功。两份 probe 均已可恢复地移入 `~/.Trash/noema-vaultgit-{autosync-audit,probe}-20260826-*`，无临时目录或残留进程。

AGENTS.md 原样 packaged smoke 最终报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 SiYuan registry SHA-256 仍为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；默认 root 无 `.siyuan`/`.sy`，Emacs full-project link 与 7 个 shared resource links 全部解析到本仓库 `resources/`，retired lowercase path 缺席；`make disk-audit` 继续报告安装 App 44KB unique physical accounting，`git diff --check` 干净。

**vaultgit page history/diff/restore 纵切已落地（2026-08-26，当前工作树）**：`kernel/noema/vaultgit` 新增有界 file history、commit diff 与 historical blob 读取，三个只读/写 endpoint 通过同一 provider 接到生产 `wikiPageHistory` / `wikiPageDiff` / `restoreWikiPageVersion`；无 kernel 的 Server reader 保留 Node compatibility 路径并显式报告 `source:node-vaultgit`。restore 不再由 Node 用会 `.trim()` 的 helper 直接写文件：Go 保留 `git show <sha>:<path>` 的原始尾换行字节，API 再经 `model.SaveMarkdownDoc` 同步 parse/upsert SQL/FTS，因此 UI 复开页面时不必等待 watcher 才能看到恢复版本。auth/admin/readonly、box realpath、repository-relative path 与 commit SHA 边界保持失败关闭。

Go 核心/API 与 provider/wiki 三层聚焦测试已过；真实 Git 契约覆盖 author/email/subject history、80-line commit diff、非法 SHA 和 historical blob 尾换行逐字节保真。单独的真实 `-tags fts5` API 回归进一步从第二版恢复第一版，断言旧版本唯一词立即可搜、被替换版本词项为零；provider/wiki/desktop 三个 TypeScript 文件更新为 31 项全绿，`tsc --noEmit`、Node syntax 与 `git diff --check` 通过。下一步扩大门禁，并用重建后的安装包对 production page history/diff/restore 做完整取证。

**vaultgit page history/diff/restore 正式门禁（2026-08-26）**：Go 扩大组 `go test ./noema/... ./api/... ./cli/cmd ./filesys/... ./treenode/... ./sql/... ./util/...` 与真实 `-tags fts5` restore/reindex 回归全绿；restore handler 在响应前显式 flush SQL queue，测试不再靠调用方补 flush。精确 Node 26.5.0/npm 11.17.0 的最终 `make test` 为 169 files passed / 7 skipped、1603 tests passed / 16 skipped；`make build` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新真实 App，canonical/installed kernel SHA-256 同为 `227bbb270183e1c6dd58b140c9ffa0bf91d3b9360c36ee5c62c8ec463f263e5d`。

安装包 Electron runtime + bundled owned kernel 的隔离 production facade 探针返回两条按新到旧排列的真实 commit（`d459c31c…`、`dcaa0296…`），history/diff/restore 全部显式报告 `source:kernel-vaultgit`，commit diff 含第二版唯一词；恢复第一版后磁盘文件与 `git show dcaa0296…:versioned.md` 逐字节相等（202 bytes 且保留尾换行），同一个 restore 响应后的第一次搜索即得到旧词 total=1/精确 page id、新词 total=0。探针已可恢复地移入 `/Users/hc/.Trash/noema-vaultgit-history-probe-20260826-030000`。

AGENTS.md 原样 packaged smoke 再次报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿；退出信号完整关闭 database/kernel。全局 registry SHA-256 保持 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`，默认 root 无 `.siyuan`/`.sy`，Emacs full-project link 与 7 个 shared asset links 均解析到 canonical repository/`resources/`，retired lowercase path 缺席；无 packaged/web-host/kernel PID 或本批 `/private/tmp` 残留，`make disk-audit` 仍报告安装 App 44KB unique physical accounting，`git diff --check` 干净。

**vaultgit rename-aware history 细节修复与正式门禁（2026-08-26）**：审阅发现 `git log --follow` 原本会把改名前的提交列进 history，但 diff/restore 仍拿当前新路径去读旧 commit，形成“列表可见、操作失败”。Go 现在用 NUL-framed metadata + `--name-only -z` 在最多 200 条页面历史内记录每个 commit 当时的真实 path；diff/blob read 先把 7–64 位请求 SHA canonicalize，再确认其属于当前页面的 follow history，并只在 Git 内部使用对应旧路径，HTTP/Node 返回仍保持当前 page path。内部 tracked path 与用户 commit pathspec 已分离，前者逐字节保留合法的 leading/trailing whitespace 与隐藏目录，后者继续执行旧安全过滤；不属于该页面历史的 commit 失败关闭。

Go 核心回归覆盖 leading-space 新文件名、rename commit、旧路径上的 initial diff/blob、短 SHA 与 unrelated commit 拒绝；默认 API 回归从新文件名查看旧路径提交，真实 `-tags fts5` 回归再从改名后的当前文件恢复改名前的第一版，断言字节、当前新路径和即时搜索投影。扩大 Go 包组全绿；精确 Node 26.5.0/npm 11.17.0 的 `make test` 保持 169 files passed / 7 skipped、1603 tests passed / 16 skipped，随后 `make build`/`make install` 完成，canonical/installed kernel SHA-256 同为 `bd165f88140e790ba31075bcf17f241e3ceefe6e92f92061edcb8c6ee3e1d378`。

安装包 Electron runtime + bundled kernel 的隔离 production facade 对 `old-name.md → renamed-page.md` 三提交历史返回 `rename page / second version / first version`；从当前新文件名请求第一版时 history/diff/restore 均报告 `source:kernel-vaultgit`，diff 命中旧路径唯一词，restore 后当前 `renamed-page.md` 与 `git show <first>:old-name.md` 逐字节相等、保留尾换行，旧/新词搜索 total 为 1/0。probe 已可恢复地移入 `/Users/hc/.Trash/noema-vaultgit-rename-probe-20260826-031020`。最终 AGENTS.md 原样 smoke、全局 registry、默认根、Emacs links、retired path、PID/temp、44KB disk audit 与 `git diff --check` 全部再次通过。

**vaultgit modern checkpoint 数据面纵切已落地（2026-08-26，当前工作树）**：`/api/noema/vaultgit/checkpoint` 在 Node 已取得 repository lease、恢复孤儿 lock 并切到目标 `noema/<device>` work branch 后，由 Go 原子执行 `git add -A`、NUL 路径 staged 计数、仓库 identity/Noema fallback identity 选择、commit 与 HEAD 读取；分支必须与当前 checkout 精确一致，消息、device identity、输出和 context 都有界，不属于当前 branch 的请求失败关闭。Node 继续唯一持有跨进程 lease、working-file quarantine、worktree/merge/conflict、retry 与 durable sync state，这些宿主恢复策略没有复制进 kernel。

shared-host 对同一个 kernel lifecycle 实例同时配置 Wiki read/action 与 sync checkpoint provider；desktop/本地 Emacs ready 时独立 checkpoint 报告 `source:kernel-vaultgit`，完整 sync 只把其首尾 checkpoint 标作 `checkpointSource:kernel-vaultgit`，不把仍由 Node 承担的 merge/push/conflict 编排伪称为 Go。kernel 请求给大仓库保留独立 5 分钟 deadline。Server reader/无 kernel 场景保留旧 Node compatibility commit 并报告 `source:node-vaultgit`；provider 调用失败不会回退后重复 commit。当前真实 Git core/API 测试覆盖全工作树 add、修改+删除计数、configured/fallback identity、默认/显式消息、clean no-op 和 branch mismatch；provider/wiki-sync/workspace/desktop 四个 TypeScript 文件 50 项、`tsc --noEmit`、Node syntax 与 `git diff --check` 已过。下一步扩大 Go/Node 门禁，并从重建后的安装包 production checkpoint facade 证明 work branch、commit tree、identity 和 source。

**vaultgit modern checkpoint 正式门禁（2026-08-26）**：扩大 Go Noema/API/CLI/filesys/treenode/sql/util 包组全绿；精确 Node 26.5.0/npm 11.17.0 的最终 `make test` 为 169 files passed / 7 skipped、1604 tests passed / 16 skipped。最终顺序 `make build`/`make install` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell并事务更新真实 App，canonical/installed kernel SHA-256 同为 `d5799675d86f0cc4997ab7ecc04a5d3f565e08759fa7bb5e5e78bc8403a1d5da`。

安装包 Electron runtime + bundled owned kernel 在隔离 Wiki root 上从 production `aaronnote:api:wiki:checkpoint` 把一篇修改和一篇新增一次提交到 `noema/aaronmac-local-019fb75f`：facade 与随后复读的 durable sync state 均为 `source:kernel-vaultgit`、`phase:idle`、`committed:true`、`changedFiles:2`、HEAD 精确一致，commit tree 只有 `new-page.md`/`page.md`，working tree clean；仓库本地 name/email 显式置空后使用 `Noema (aaronmac-local) <noema-019fb75f@local>` fallback identity，自定义 subject 原样保留，`NOEMA_WIKI_AUTO_SYNC=0` 未触发额外同步。probe 已可恢复地移入 `/Users/hc/.Trash/noema-vaultgit-checkpoint-probe-20260826-032102`。

最新 AGENTS.md 原样 packaged smoke 再次报告 desktop/preload、54px、五项标题栏、TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 与 owned/listening kernel 全绿。全局 registry SHA-256 仍为 `7111ceb2288c262b75c30889bdba8a9631ccb215412f2731336a038f78444ed4`；默认 root、Emacs full-project + 7 shared asset links、retired lowercase path、PID/temp 与 44KB unique disk accounting 全部复核通过，`git diff --check` 干净。

**vaultgit origin/main transport 纵切已落地（2026-08-26，当前工作树）**：Go `kernel/noema/vaultgit` 现在负责三个固定、可审计的网络动作：空/仅 Noema 分支远端的 `main` 引导、`origin/main` fetch，以及把调用方给出的 canonical commit 精确推到 `refs/heads/main`。API 只接受 `ensure-main` / `fetch-main` / `push-main`，继续经过 auth/admin/readonly 与 external Markdown box realpath 边界；Git prompt 禁用、context 取消和 8 MiB 输出上限沿用同一个 runner。引导语义保持旧实现：已有远端 main 不改写；远端没有 main 但含无关分支时失败关闭；本地已有 main 时从该分支引导，push 同时发生的远端竞态以新出现的 main 为准。

Node 仍唯一负责 repository lease、设备 work branch、integration worktree、merge/conflict、三次 remote-race retry、working-file quarantine 与 durable state；Provider 完整能力可用时，正常同步和冲突解决后的再发布都通过 Go transport，否则整套传输走 Node compatibility 路径，不会半套混用。完整 sync 不再伪装成单一 `source`：首尾 commit 记录 `checkpointSource`，远端传输记录 `transportSource`。真实 Go core/API 回归已覆盖空远端 bootstrap、既有 main、协作者推进后的 fetch、精确 commit push、非快进拒绝和无关分支保护；Node 组合回归已证明 Go Provider 的非快进错误会被分类为 remote race，再次通过 Go fetch、合并双方后第二次精确 push 成功。

**vaultgit origin/main transport 正式门禁（2026-08-26）**：扩大 Go Noema/API/CLI/filesys/treenode/sql/util 包组全绿；精确 Node 26.5.0/npm 11.17.0 的最终 `make test` 为 169 files passed / 7 skipped、1607 tests passed / 16 skipped。末轮审阅再锁死两处 fail-closed contract：`fetch-main` 拒绝任何多余 commit，Provider 同时要求 push 返回的 `commit` 与 `remoteHead` 都精确等于请求 SHA；对应 core/API/provider/wiki 聚焦组复跑全绿。最终顺序 `make build`/`make install` 重建 3991-module renderer、FTS5 Go kernel 与 Electron shell并事务更新真实 App，canonical/installed kernel SHA-256 同为 `f562fc307d865946a88a05a2b2c08439c192769cc46beb1d2a5cec3a041de771`。

安装包 Electron runtime + bundled owned kernel 在隔离 Wiki root + bare origin 上从 production `aaronnote:api:wiki:sync` 完成两文件 dirty checkpoint、fetch、integration 与精确 publish：返回 `phase:idle`、`committed:true`、`changedFiles:2`、`checkpointSource:kernel-vaultgit`、`transportSource:kernel-vaultgit`，且没有会误导职责归属的顶层 `source`。`snapshotHead` / `publishedHead` / 本地 HEAD / origin main 精确同为 `cd2435b1bd3862516347ac304e75394f9917f36f`；commit tree 只有 `new-page.md` / `page.md`，设备分支为 `noema/production-transport-01a03a00`，working tree clean，空仓库 identity 走 `Noema (production-transport) <noema-01a03a00@local>` fallback。probe 已可恢复地移入 `/Users/hc/.Trash/noema-vaultgit-transport-probe-20260826-033852`。

AGENTS.md 原样 packaged smoke 最终再次报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px 与 Back/Forward/Refresh/Editor actions/Window actions，TOC、Knowledge、八视图 `kernel-agenda`、102 个 `kernel-katex-macros` 及 owned/listening kernel 全绿。默认 note root 无 `.siyuan`/`.sy`；Emacs full-project link 与 7 个 historical shared asset links 全部解析到 canonical repository/`resources/`，retired lowercase path 缺席；无 Electron/web-host/kernel PID 或本批 `/private/tmp` 残留，`make disk-audit` 保持安装 App 44KB unique physical accounting，`git diff --check` 干净。

### 1.5 外部编辑感知（Emacs / git）

思源只监听 assets/themes/emojis，**不监听 `data/`**。新增 data 目录递归 watcher（对齐 `server/lib/watch.mjs` 的语义）：变更 → 重解析 → `treenode.UpsertBlockTree` + `sql.UpsertIndexes`（`kernel/sql/queue.go` 的异步索引队列）→ WS 推 `reloadProtyle` 等价事件。

`kernel/model/import_obsidian.go` 是 md 摄取的最佳模板，用来做首次 `.roam/` vault 冷启动导入。

**验证**：把现有 `.roam/` vault 挂成 markdown box；`FullReindex` 后 `siyuan.db` 的 `blocks`/`refs`/`spans` 表填满；`/api/search/*` 能命中；Emacs 改一个 `.md` 文件后索引在 1s 内更新；`git diff` 只显示语义改动，无 ID 噪音。

**进度（2026-08-24，commit `f2094fc24` + `523a2d6c7`）**：已实现，比预想的分两层：
1. **索引管线 box-kind 感知化**（`f2094fc24`）——发现 `UpsertIndexes`/`RemoveIndexes`/`indexBox` 全部硬编码 `.sy` 后缀 + `util.GetTreeID(path)`（文件名去后缀当 ID），markdown box 两条假设都不成立。改成按路径反查 box kind 分派；markdown 文件的 rootID 从已加载的 `tree.ID` 拿（读），或从 `treenode.GetBlockTreeRootByPath` 反查（删，此时文件已经不存在了）。顺带抓到一个真实 bug：外部编辑器写的全新 `.md` 文件第一次索引时，lute 只在内存里分配了文档 ID，不写回磁盘的话下次重索引会换一个新 ID——`upsertIndexes`/`indexBox` 现在都会在 markdown 首次索引后无条件调一次 `filesys.WriteTree`（`writeMarkdownTree` 内容不变时是发现磁盘字节相同就跳过落盘，代价可忽略）。
2. **watcher 本体**（`523a2d6c7`）——分平台：darwin 用 `radovskyb/watcher`（轮询，思源已有的 assets/themes/emojis darwin watcher 就是这个库，但那些是 10 秒间隔，笔记正文改成 1 秒间隔以满足下面验证标准里的"1s 内更新"）；非 darwin 用 fsnotify + 手动递归目录跟踪（fsnotify 不会自动跟进新建的子目录，需要在 Create 事件里补 `Add`）+ 300ms 防抖（用 map 收集变更路径，不是像现有 assets_watcher.go 那样只记"最后一个事件"——那种做法在 git checkout 一次性改一堆文件时会丢事件）。挂载点在 `mount.go`：`Mount`/`unmount0` 里按 box kind 调 `WatchMarkdownBox`/`CloseWatchMarkdownBox`。**非 darwin 版本没有在本机（darwin）编译验证过**——这台机器的 sqlite/cgo 配置交叉编译不干净，仔细审查过但没跑起来，标记为待补：需要在真实 Linux 环境跑一遍。
3. **测试覆盖的边界（后续已补上，见下）**：一度以为 `sql.InitDatabase` 硬依赖 `-tags fts5` 且这个环境跑不了，所以 watcher→索引这条链路的端到端集成测试当时没跑通。**后续更正**：`-tags fts5` 在这台机器上其实能正常编译运行（`go test -tags fts5 ./model/... -run <单个测试>` 验证过 3 遍：`TestSaveMarkdownDocWritesAndIndexes`、`TestWatchMarkdownBoxIndexesExternallyWrittenFile`、`TestUpsertThenRemoveIndexesRoundTripsMarkdownBoxWithRealSQL`，全部通过，含真正的 `treenode`+`sql` 落库，不再是"测到 sql 层之前"）。唯一的限制：这几个新测试必须**单独**用 `-run` 跑，不能和整个 `model` 包的默认测试集一起跑 `-tags fts5`——会撞上一个跟这次改动无关的既有问题：某些老测试在 fts5 tag 下和这些新测试共享 sql/blocktree 全局状态会互相冲突（`file_index_test.go` 自己当初用子进程重新执行来规避的正是这个问题，只是它自己那一个文件用了这个技巧，其他文件没有）——不在这次的修复范围内。

---

## Phase 2 — CM6 接内核（约 3–6 周）

**不使用** `/api/transactions` 的块操作协议（那是 protyle 的），改用文本协议：

- **加载**：新 API 返回 `{markdown, blocks: [{id, from, to, type, level}]}` —— 块表以**源偏移**为键。Noema 不变量 #1 保持

  **实现方式的重要澄清（2026-08-24 发现，动手前的架构核对，不是走了弯路才发现）**：查过 `github.com/88250/lute/ast.Node` 结构体——**没有任何源字节偏移字段**（`CodeBlockFenceOffset` 是围栏代码块专属的一个小例外，不是通用机制）。lute 不是像 Lezer 那样偏移原生的解析器。这意味着 `from`/`to` **不应该在 Go 内核这边算**——那等于把 CM6 的 Lezer 语法层（`src/cm6/languages/markdown/`）在服务端重新实现一遍一次，既重复劳动又违背这份计划反复强调的分工原则（"内核只需识别块边界与块 ID，不必理解语法内部结构；CM6/Lezer 继续独占语义层"，见 Phase 1 Spike 3 结论）。正确的分工：内核 API 只需要返回 `{markdown, blocks: [{id, type, level}]}`（**不含 from/to**，或者干脆不单列 blocks，前端从 markdown 正文里已经能读到 `{: id=...}` 字面量）；`from`/`to` 由 CM6 侧拿到 markdown 文本后用 Lezer **自己解析一遍**顺带算出来——Lezer 解析本来就是偏移原生的，这是免费的。内核唯一要保证的是它吐出来的 markdown 字节和 CM6 Lezer 认的是同一份语法（已经在 Phase 1 验证过：`#+begin/#+end`、`@@cmd`、`{attrs}`、数学公式全部字节保真）。落地时把这一条的 API 形状按此改掉，不要照字面去写一个服务端 from/to 计算器。
- **保存**：CM6 文本 transaction → 防抖全文保存 → 内核重解析 → tree diff → blocktree/sql 增量更新。撤销仍在 CM6（现状不变）
- **保留** `/api/transactions` 仅用于属性视图操作（`insertAttrViewBlock` / `updateAttrViewCell` 等 AV 类 `TOperation`）
- **删除** `kernel/model/transaction.go`(2,630) 的块操作分支 + `undolog.go`

**进度（2026-08-24，commit `a13ed54d5` + `f8dcb6ff7`）**：加载/保存两个 Go 函数已经实现并通过完整端到端测试（含真实 sql/blocktree 落库），按上面澄清的形状——`model.LoadMarkdownDoc(boxID, path)` 返回 `(markdown string, blocks []MarkdownBlockRef, err error)`（`MarkdownBlockRef{ID, Type, Level}`，没有 from/to）；`model.SaveMarkdownDoc(boxID, path, markdown)` 落盘 + 复用 `LoadMarkdownDoc` 的规范化路径 + 调 `UpsertIndexes` + 推 `PushReloadFiletree`。

**HTTP 出口已完成（2026-08-25，commit `dd4fd3946`）**：`POST /api/noema/markdown/loadDoc` `{notebook, path}` → `{markdown, blocks}`；`POST /api/noema/markdown/saveDoc` `{notebook, path, markdown}` → `{markdown, blocks}`。挂在新命名空间 `/api/noema/` 下，不复用 `/api/filetree/getDoc`（那是 protyle 的块 DOM HTML 端点，架构上不适合 CM6 文本协议）。鉴权跟其他写端点一致：`saveDoc` 走 `CheckAuth+CheckAdminRole+CheckReadonly`，`loadDoc` 只读，只要 `CheckAuth`。这是 Phase 2 目前唯一落地的部分——**CM6 侧还完全没有代码去调用它**，接下来这两个端点要等真正开始改 `src/cm6/` 才会有消费者，那部分工作需要浏览器验证，跟这次会话一直在用的纯 Go 测试方法论不是一回事。

**真机冒烟测试（2026-08-25，commit `e299dc568`）**：在此之前所有验证都只经过 `go test`，从没跑过真正启动的进程。`go build -tags fts5` 出二进制、`kernel serve --wd .../app --workspace <scratch>` 起服务、curl 全流程走了一遍：挂载 box → `saveDoc` 存文档 → `loadDoc` 读回字节一致 → 通过**真正的** `/api/search/fullTextSearchBlock`（不是测试里绕过鉴权直接调 handler，是完整路由链）搜到内容、`<mark>` 高亮正常 → 直接往磁盘写一个新文件模拟 Emacs → watcher 在 1-2 秒内探测到、索引、把分配的 ID 写回磁盘。全链路在真实进程里走通。

顺带抓到一个真实缺口：`createNotebook` 原来只接受 `name`，没有办法通过 API 建 markdown box——这次会话所有测试都是直接手写 `.siyuan/conf.json` 绕过 API 建的。已修：`model.CreateMarkdownBox(name)`（设 `Kind=markdown`，跳过 `ensureBoxDoc0`）+ `createNotebook` 新增可选 `kind` 字段（`"markdown"` 走新函数，其余/缺省行为不变，`CreateBox` 本身未改动，老 `conf.json` 字节不受影响）。

**第一次真正碰 CM6（2026-08-25，Noema 主仓库 commit `c3d6639`）**：加了一个完全独立的 Vite 入口 `aaronnote/markdown-box-lab.html`/`markdown-box-lab-main.ts`——用 `src/editor-api.ts` 的 `createEditor()`（生产环境同一个门面，手感真实）挂编辑器，直接 `fetch()` 调 Go 内核的 `loadDoc`/`saveDoc`，完全绕开 `aaronnote/api-client.ts`/`window.aaronnoteApi`（那是现有 Node 后端的通道桥，和新内核是两回事）。不碰 `aaronnote/main.ts`（10,731 行的生产编辑器壳）一个字。在真实 Chrome 里全流程验证过：起内核（`-tags fts5`）+ 起 `start:vite`、真的在浏览器里往编辑器打字、看到自动保存、看到服务端分配的文档 ID 实时同步回编辑器（`setMarkdown(..., {preserveView: true})`，光标不跳）、磁盘文件和浏览器显示的字节完全一致、刷新页面冷加载回来内容和 ID 都不变。这是这次会话第一次真正过 CLAUDE.md 要求的浏览器验证（之前全部止于 `go test`/`curl`）。

**动手时抓到一个严重 bug（不是这次新引入的，是 Phase 1 索引管线那次提交里就带着的）**：`util.NewLute()` 开着 `SetProtyleWYSIWYG(true)`，导致 lute 给源文本里**没有**显式 `{: id=...}` 的每一个块，每次解析都现场发一个**只存在于内存里、不落盘**的临时 ID（用测试直接验证过：文件字节两次解析前后完全不变）。`treenode.UpsertBlockTree`/`IndexBlockTree` 只看 `n.ID` 是否非空就当真实块索引进去——由于这个临时 ID 每次都不一样，每次重索引都会插入一批新垃圾行，上一批因为 ID 对不上永远清不掉。写了个回归测试复现：同一份没有任何引用的内容反复索引 5 次，blocktree 行数 7→13→19→25→31，线性增长、无界膨胀。修法是 `filesys.StripEphemeralMarkdownBlockIDs`，在 `WriteTree` **之后**（不能在之前——FormatRenderer 依赖这些临时 ID 的存在来决定某些块类型后面要不要多空一行，清早了会导致重复保存时字节漂移，也是测试踩出来的）清掉没有真实持久化 IAL 的块 ID，接在 `upsertIndexes`、`indexBox`、`LoadMarkdownDoc` 三个消费点。这类 bug 光靠代码审查很难发现，是"写一个会因为这个 bug 而失败的测试"这个习惯直接抓到的。

**内核 restructure：kernel/ 展开进主仓库（2026-08-25，Noema 主仓库 commit `d11dfe7`）**：见文件顶部的位置变更提示和"工作方式约定"一节。`kernel/`（8.1M）+ `app/appearance/`（18M，语言包/主题/字体/emoji）+ `app/stage/auth.html`（access-code 登录页，几个既有内核测试直接依赖它）搬进了 Noema 主仓库、`main` 分支。踩过一次坑：一开始把 `appearance/` 嵌到 `kernel/` 里面（`kernel/appearance/`），导致 `TestCustomFontLifecycle` 等测试报错——它们硬编码相对路径 `../../app/...`，假设 `kernel/` 和 `app/` 是**同级**目录（跟 SiYuan 上游自己的仓库布局、以及本计划"目标仓库结构"一节写的一样）。改成同级后全部恢复，`go build`/`go vet`/`go test`、`-tags fts5` 二进制真机 boot + curl 全部重新跑过一遍确认。`app/pandoc/`、装饰性 covers 和未采用的 protyle/mobile 前端经审计明确不迁移。

**"可用"里程碑：WS 实时刷新（2026-08-25，Noema 主仓库 commit `7fa16b5`）**：lab 页接上内核已有的 `/ws` 端点（`?app=...&id=...&type=main`），监听 `reloaddoc` 推送（只来自 `markdown_watcher.go` 的外部编辑探测，不来自这个页面自己的保存——`SaveMarkdownDoc` 从不直接调 `PushReloadDoc`），命中当前打开文档的 rootID 时自动重新加载；只有编辑器当前内容仍等于"上次确认与服务端同步"的内容时才自动刷新，本地有未保存改动时改成提示而不是静默覆盖。**在真实 Chrome 里验证过端到端全链路**：加载一个文档，直接在磁盘上改这个文件（模拟 Emacs，完全不碰浏览器），~3 秒内编辑器内容自动更新，零手动交互——这正是这次 fork 存在的核心理由（"Emacs 和 CM6 看到同一份文档，而且是实时的"），现在证明真的跑通了：内核存储 → 索引 → 搜索 → 外部 watcher → WS 推送 → 浏览器实时更新，全部在真实进程/真实浏览器里验证过，不只是 `go test`。副作用：自己的保存也会触发一次 `reloaddoc`（watcher 分不清"自己保存"和"外部编辑"，两者都是磁盘写入），已知、无害，只是状态栏文字会从"saved"再闪回一次"loaded"，不是 bug。

**文档浏览器（2026-08-25，Noema 主仓库 commit `ab8f7e1`）**：之前 `ListMarkdownDocs`/`listDocs` 端点建了但没人用——lab 页一直要求手敲路径。现在接上了：侧栏列出当前 notebook 下所有 `.md` 文件，点击直接打开；一个"new doc path" 输入框 + `+` 按钮可以在任意路径新建（复用 `LoadMarkdownDoc` 已有的"路径不存在就给空文档"行为，不用另写新建逻辑）；每次保存后自动刷新列表，新建的文档立刻出现在侧栏并高亮为当前项。真实 Chrome 里验证过：连接一个用 curl 预先塞了两篇文档的 notebook，两篇都正确显示、可点击打开；用 `+` 按钮新建第三篇、输入内容、看到保存后自动出现在侧栏并高亮——全程没有手动输入过路径。

**`plan.md` 本身开始被追踪进 git（2026-08-25，Noema 主仓库 commit `45ca765`）**：这个文件之前是开工前 plan 模式批准时留下的一份快照，没有纳入版本控制，也没有跟着后续进展更新。现在补齐到当前进度，纳入 git 追踪，并且这份文档往后**每做一步就更新一步**——不是等一大段工作做完再补总结。

**顶层 Makefile 接上 kernel-build/kernel-install（2026-08-25）**：`kernel/` 搬进主仓库后一直没有对应的构建入口，只能手敲 `cd kernel && go build -tags fts5 ...`。新增 `make kernel-build`（`check-go` 门禁 + `CGO_ENABLED=1 go build -tags fts5 -ldflags "-s -w"` 出二进制到 `build/kernel/<GOOS>-<GOARCH>/noema-kernel`）和 `make kernel-install`（把二进制 `ln -sfn` 到 `$(HOME)/.local/bin/noema-kernel`，可用 `KERNEL_BIN_LINK` 覆盖）。**踩了一个坑并已验证解决**：`resolveWorkingDir()`（`kernel/cli/cmd/root.go`）用 `os.Executable()` + `EvalSymlinks` 拿到的是**二进制符号链接解析后的真实路径**，所以 `app/` 这个同级目录的符号链接必须放在 `build/kernel/<GOOS>-<GOARCH>/`（真实二进制所在目录）旁边，放在 `$(HOME)/.local/bin/` 那层符号链接旁边是找不到的——已按此在 `kernel-build` 里做 `ln -sfn app build/kernel/<GOOS>-<GOARCH>/app`，本机实测过双层符号链接（`~/.local/bin/noema-kernel` → `build/kernel/.../noema-kernel`，同目录下 `app` → repo `app/`）下 `kernel serve --port 0 --workspace <tmp>` 正常起、`POST /api/system/version` 返回 `{"code":0,...,"data":"3.8.1"}`。二进制（79M）和 `app/`（18M）全程只 link 不 copy，符合"节约空间"的要求。**`kernel-deploy` 明确暂不做**（Aaron 决定）：kernel 还在 Phase 0，没接入任何生产流量、没有 `/health` 端点、也没有 systemd 单元；`server-deploy` 靠 rsync 源码 + 远端 `npm ci` 避开了 CGO 交叉编译问题，kernel 若要走类似路子需要远端也有 Go 工具链现场编译——等 kernel 真正要上线服务时再设计，不提前做。

CM6 侧新增（都是 widget/decoration 层加法，不动现有 feature 顺序 `src/cm6/extensions/index.ts`）：
- 块 ID gutter + 块引用 `((id "text"))` 的 live-preview widget（复用 `roam-link-status.ts` 的 hover/解析模式）
- `#+begin av` widget → 渲染思源 AV（复用 `app/src/protyle/render/av/` 的 ~50 个文件，这部分是**独立于 protyle 编辑面的纯渲染层**，可以单独抽出）
- `#+begin embed` widget → 走 `/api/search/searchEmbedBlock`
- 反链/大纲/图谱面板改用内核 API（`model/backlink.go`、`model/outline.go`、`model/graph.go`），删掉 `aaronnote/local-graph.ts` 的本地实现

**块 ID 徽章已落地（2026-08-25）**：上面这条的前半（"块 ID gutter"）已实现。新文件 `src/cm6/extensions/visual/widgets/kramdown-ial.ts`：viewport-scoped `ViewPlugin`，逐行正则扫描内核写回的 kramdown 尾随 IAL（`{: id="20260825095344-8w75nfv" updated="..."}`），把它替换成一个小徽章（显示 ID 末 7 位、`title` 悬浮显示完整属性、点击复制完整 ID 到剪贴板），完全照抄 `footnotes.ts` 的既有形状（viewport 扫描 + 数学/代码块排除 + 光标触碰即显示原文这一整套机制），**不是新发明的模式**。挂载点是 `extensions/visual/index.ts` 的 `createVisualMarkdownExtensions()`（生产列表，`visualMode(...)` 包裹，Source 模式不受影响）——之所以敢直接进生产列表而不是只在 lab 页试验，是因为这个语法（`{: id="..."}`，冒号紧跟花括号）跟 Noema 自己的 `{key: value}` trailing-attrs 语法（`src/attrs-syntax.ts`，花括号后没有冒号）在语法层面完全不相交，对现有文档是可证明的零风险空操作（已写测试锁定这条边界）。验证：`tsc --noEmit` 干净；新测试 `tests/cm6/kramdown-ial.test.ts`（6 个用例：徽章替换、悬浮属性、光标触碰显示/隐藏原文、Source 模式不受影响、不与 Noema 自己的 attrs 语法冲突、围栏代码块里的字面 IAL 文本免疫）全过；真实 Chrome 里连上前面搭的 markdown-box-lab + 内核，加载一篇有 4 个真实内核分配 ID 的文档，肉眼确认徽章正确渲染（`#8w75nfv`/`#i40x2sr`/`#vt3zo5j`/`#rfknlki`），并用页面脚本内省确认点击徽章会以完整 ID 调用 `navigator.clipboard.writeText`。

**块引用 live-preview 也已落地（2026-08-25，同一批）**：上面那条的后半。语法真相先从真实跑着的内核里取，不是照文档猜的——往内核 `saveDoc` 一篇含 `((<id> "text"))` 和裸 `((<id>))` 的文档，`loadDoc` 读回逐字节确认了两种形态（含双引号锚文本、纯 ID 无引号）都能稳定往返。新文件 `src/cm6/extensions/visual/widgets/block-ref.ts`：结构上是 `kramdown-ial.ts` 的姊妹文件（同样的 viewport 扫描 + 排除区间 + 光标触碰显示原文骨架），正则 `\(\((\d{14}-[0-9a-z]{7})(?:\s+(["'])((?:\\.|(?!\2)[\s\S])*)\2)?\)\)` 匹配后替换成一个下划线链接样式的 chip——有锚文本就显示锚文本，没有就退化成跟 `kramdown-ial.ts` 一致的 `#末7位` 短标记。**故意没做**的两件事，都写进了文件头注释里，不是遗漏：(1) 不区分"有效/失效"引用——`roam-link-status.ts` 那种校验依赖一个外部注入的已知 ID 集合，而内核侧的块 ID 索引现在还没有任何东西在维护/查询这个集合，现在编一个会是纯装饰、没有真实依据；(2) 点击不做跳转——只是照 `editor-cm6.ts` 里 `aaronnote:open-url`/`aaronnote:preview-url` 现成的模式，从 widget 自己的 DOM 节点 `dispatchEvent` 一个冒泡、可 `preventDefault` 的 `aaronnote:open-block-ref`（`detail: {id, text}`），至于点了之后跳到哪、要不要跨文档索引，是应用壳层的事，CM6 这一层不该替它做主。挂载点同样是生产 `createVisualMarkdownExtensions()` 列表，同样靠"内核 ID 格式（14 位时间戳-7 位小写字母数字）跟现有文档任何语法都不相交"论证零回归。验证：`tsc --noEmit` 干净；新测试 `tests/cm6/block-ref.test.ts`（6 个用例：锚文本渲染、裸引用退化成短标记、点击派发事件且 payload 正确、光标触碰显示/隐藏原文、普通英文括号 `((不是块引用))` 不被误判、围栏代码块免疫）全过；`tests/cm6/` 全量 401 个测试零回归；真实 Chrome 里用内核里一篇临时文档（引用了 `hello.md` 里已有的两个块 ID，验证完删掉了，没留垃圾数据）肉眼确认两种引用形态都正确渲染成链接样式，并用页面脚本内省确认点击后 `aaronnote:open-block-ref` 事件带着正确的 `{id, text}` 冒泡到了 `.cm-editor`。

**上面这份“还没做”清单现已清零（2026-08-26）**：`#+begin av` 已有 table/gallery/kanban 三布局、portable kernel read model 与有界 cell mutation；`#+begin embed` 已通过 shared host 调 kernel search；Backlinks/Graph/Search/Tags 已进入 App Knowledge dock，大纲按最终交互要求保留 CM6 `toc-index` 的 floating TOC。对应实现与正式门禁见本文“当前进度”中的 portable 属性视图、embed query、Knowledge dock 与 TOC 记录；这里保留原始阶段顺序，但不能再把它们列作未完成项。

**块引用点击导航已接入正式编辑器（2026-08-26，当前工作树）**：widget 继续只派发 host-agnostic `aaronnote:open-block-ref`，但生产 `aaronnote/main.ts` 和独立 lab 现在都消费该事件。共享 Node host 新增窄通道 `aaronnote:api:notes:resolve-block`；runtime 只接受 UUIDv7 或兼容 timestamp ID，再委托已注册的 Markdown kernel provider 调 `/api/noema/markdown/resolveBlock`。provider 会核对 ID、notebook、kernel path、box containment、真实路径和普通 Markdown 文件，renderer 只拿到有界的 `{id,file,path,line,blockType}`，没有新增 Electron/preload 能力。正式 CM6 跨文档跳转复用现有 `openFile`、Back/Forward cursor stack、selection/reveal/focus；同文档有未保存行位移时优先扫描 live UUID anchor，重复定义或 legacy ID 才退回 kernel 的 1-based line，避免拿旧索引行号跳错位置。

聚焦验证覆盖 provider 的成功、非法 ID 零 transport、kernel escape 的 502 拒绝，runtime 的 400/501 边界、typed browser facade、CM6 widget event 和 live-source 定位；既有 Go FTS5 block resolver 回归也通过。真实安装版进一步以独立 root/state 启动 `/Applications/Noema.app` 内的 Electron-as-Node shared host 与 bundled Go kernel，公开 `/api` channel 把 `0198fc34-7b32-7a11-8cb4-6c40e3b33d68` 解析为 canonical `target.md`、`/target.md:1`、`blockType:"p"`、`source:"kernel-block-index"`；target/citing 源文件 SHA-256 分别为 `ead00f16c1aa23face705950203c06e95521a18785e0423d91b635ff6515f2f0` / `bacf664d62483feca903258c86bf1ed20668902cb7d877ab8368660f60dabf73`，进程收到 SIGINT 后由 supervisor 干净关闭数据库与 kernel，root/state 已整体移入 `/Users/hc/.Trash/noema-block-ref-navigation-20260826-1040`（可恢复）。

**生产块引用导航正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 175 files passed / 7 skipped、1633 tests passed / 16 skipped；`make build` 重建 3992-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 更新真实 `/Applications/Noema.app`。canonical/installed kernel SHA-256 同为 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`。AGENTS.md 原样 packaged smoke 报告 `protocolRegistered:true`、`hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿；Info.plist 的 `noema` scheme 声明保持不变。全局/Noema registry SHA-256 分别为 `d74d1e564c27b55ec3a8e67287b06fba385939e2efe3dd791ffa554ac1771f3b` / `3c421c68f03604fd265bd2599ddc79bcc39c3fcc027476e5193e5738072286c7`，默认 root 无 `.siyuan`/`.sy`，Emacs full-project + 7 个 shared resource links 正确、retired lowercase path 缺席；`make disk-audit` 仍为安装 App 44KB unique physical accounting。

**反链/大纲/图谱三个内核 API 逐一在真内核上验证过（2026-08-25）**：Aaron 要求先确认这几个 API 对 markdown box 到底能不能用，再决定要不要接 UI。结果：

- **大纲（`getDocOutline`）：开箱可用**，但意义不大——它给没有持久化 ID 的标题现场发一个临时 ID 用于定位，这件事 CM6 自己的 `toc-index.ts` 已经从当前打开文档的 markdown 正文里免费拿到（标题文本 + 层级），不需要往返内核。大纲面板**大概率不需要接内核**，除非以后要做"跨文档大纲"这种 CM6 单文档视角看不到的东西。
- **反链（`getBacklink`/`getBacklink2`）：发现并修了两个真实 bug，两个都不报错，都是安安静静返回空结果**，属于这类会话里反复出现的那种"测出来才发现，代码审查看不出来"的问题——写了一个会因为它们失败的回归测试（`model/backlink_markdown_fts5_test.go`）：
  1. `treenode.GetBlockRef`（`treenode/node.go`）只读 `n.TextMarkBlockRefID`/`TextMarkTextContent`——这是 lute 把 `((id "text"))` 拍平成 `NodeTextMark` 之后（`parse.NestedInlines2FlattedSpansHybrid`，protyle/`.sy` 那条流水线专用）才有的字段。Noema markdown box 读盘走的是原生 `parse.Parse`（§1.1 定的，理由是不想在内核里重新实现一遍 Lezer 的语法层），**从来没跑过这趟拍平**，所以拿到的是未拍平的 `ast.NodeBlockRef`，真正的 ID/锚文本挂在 `NodeBlockRefID`/`NodeBlockRefText` 子节点上。`GetBlockRef` 对这个节点形状完全没有处理，永远返回空——上游 `sql.buildRef` 因此拿到空 `DefBlockID`，直接被 `sql.insertBlockRefs` 的非空校验挡在插库之前，这条 ref 从来没进过数据库。修法照抄 lute 自己 `render/protyle_renderer.go: renderBlockRef` 处理同一种节点形状的方式（`idNode.TokensStr()` + `refTextNode.Text()`），不是新发明的读法，纯加法（原有 `NodeTextMark` 分支不动）。**这一个改动是 P0**——不修，markdown box 下任何块引用都不可能进反链索引，跟这条不相关的 `#+begin embed` 反而没受影响（`treenode.GetEmbedBlockRef` 从写下来就是直接读子节点，不依赖 TextMark，本来就是对的）。
  2. 就算 (1) 修好，`sql.buildRef`/`buildEmbedRef` 把 `Ref.BlockID`（引用**所在**的那个块，"谁引用了它"）设成了 `parentBlock.ID`——在惰性 IAL 下，一段没被专门引用/设属性的普通文字（绝大多数真实引用都长这样）没有持久化 ID，这个 ID 在落盘前已经被 `filesys.StripEphemeralMarkdownBlockIDs` 清空，`BlockID` 留空会让这条 ref 在 `GetBacklink` 里因为查不到对应的 `blocks` 行被静默丢弃（`model/backlink.go`: `refSQLBlocksCache[""]` 永远查不到）。修法：markdown box 且 `parentBlock.ID` 为空时，退化用文档根 ID（永远持久化）——跟 §1.2 给"markdown box 搜索"选的粒度取舍（方案 B，文档级而非块级）保持一致，不是我另拍的新方案。
  两个修完，`go test -tags fts5 ./model/... -run TestGetBacklinkFindsMarkdownBoxRefFromUnidentifiedCitingParagraph` 通过；在真实跑着的内核上用 curl 复现过完整链路（存两篇引用 `hello.md` 里一个块的文档、`POST /api/system/rebuildDataIndex`、`POST /api/ref/getBacklink` 拿到 `linkRefsCount:2`，两条反链路径都对）；`go build ./...`、`go test ./treenode/... ./sql/... ./model/...` 全过，新增的 0 个失败——`model` 包既有的 5 个失败（Obsidian vault 符号链接相关）和 `server` 包既有的 1 个失败，`git stash` 掉这次改动后一样失败，确认是这台机器的既有基线，不是这次引入的。
- **图谱（`getGraph`）：开箱可用，且直接受益于上面反链的两个修复**（图的边就是 refs 表）——在真内核上 `POST /api/graph/getGraph` 验证过：一篇引用 `hello.md` 里某个块的新文档，正确地在返回的 `nodes`/`links` 里画出了一条 `citing doc → hello.md` 的边。

**强杀后 FTS 缺失后续状态：已解决（2026-08-26）**：原始现象是手动 `pkill` 内核并复用 workspace 后，FTS 对已有内容返回空，显式调用 `POST /api/system/rebuildDataIndex` 才恢复。根因不是 FTS 虚表的独立持久化，而是中断标志被启动过早清零、持久队列无法发现崩溃前尚未入队的源文件、非零 blocktree 又让启动跳过全量扫描。现在中断启动会从所有已打开 notebook 的源真相同步全量重建，并在 SQL/FTS 完整提交前保持宿主 `starting`；实现、回归与严格 250ms 强杀真机证据见本文当前进度顶部。

**手感门禁（不可退让）**：要求的是既有 CM6 行为零回归，不再以“文件字节零改动”冒充验收。vim-lite、typography（`extensions/visual/typography.ts` + `src/styles/typography.css`）、`visualtex-inline.ts`、`math.ts`、`close-brackets-vscode.ts`、`ordered-list-renumber.ts`、`heading-fold.ts`、`structural-jump.ts`、`MeasuredWidget`、`text-boundaries.ts` 都必须保留现有语义；块能力优先以独立 extension/widget 加入。若真实缺陷必须修改既有扩展（例如 MathLive native suggestion timer 的 teardown 泄漏），须有对应聚焦回归并通过整套 CM6/MathLive 门禁，不能借重构顺手替换交互。

**双路由**：同一 Vite bundle 保留两个 renderer 入口 —— `/`（Noema.app 的 Electron 窗口，加载 desktop titlebar/dock/workbench adapter）与 `/embedded`（Emacs xwidget，保留 header-line、buffer/gateway/key-adapter 语义）。宿主差异只在 adapter；两者进入同一 `web-host.mjs` 和 Node-owned Go supervisor。

**验证**：`npm test -- tests/cm6/` 全绿；5MB 大文档不回归；Emacs xwidget ERT 通过；vim 模式、数学 snippet、排版宽度算法逐条人工对拍。

---

## Phase 3 — Noema server 语义迁进 Go（约 4–8 周）

`server/lib/runtime.mjs`（8,185 行）拆三类处理：

**A. 被思源内核直接取代 —— 删掉，不迁移**
`notesIndexPayload` / `graphPayload` / `tagIndexPayload` / `wantedPages` / `roamDbRefsFromContent` / `aliasesFromContent` / `wikiLinkRefs` / `scanNotes` 全内存扫描 → 换成 `sql/block_query.go` + `sql/block_ref_query.go` + `model/graph.go` / `backlink.go` / `tag.go` / `search.go`。**这是本次重构最大的净收益**。

**B. 必须移植到 Go（`kernel/noema/`）**

| 源 | 目标 | 说明 |
|---|---|---|
| `shared/planning-dsl.mjs` + `shared/planning-values.mjs`（~2,200 行） | `kernel/noema/planning/` | @@todo/@@project/@@milestone/@@clock 的结构解析、值文法、patch/serialize。**JS 侧 `.mjs` 保留**（CM6 需要同一份语法），Go 侧镜像 + 共享 fixture 保证双端一致 |
| `runtime.mjs` agenda 部分 + `aaronnote/agenda-view.ts` 的数据面 | `kernel/noema/agenda/` | week/list/month/log/gantt/projects/clocktable/lints 视图模型；`patchTodo`/`clockIn`/`clockOut` 落回 markdown |
| `server/lib/latex-export*.mjs`（~2,400 行） | `kernel/noema/latex/` | Pandoc 预处理 + 模板 + 后处理编排；Codex agent 段落作为子进程调用保持不变 |
| `server/lib/wiki-workspace.mjs`(1,978, 用 `node:sqlite`) + `wiki-sync.mjs`(1,543) + `wiki-git-ui.mjs` + `roam-git.mjs` | `kernel/noema/vaultgit/` | git 分发。用 go-git 或直接 shell 出 git |
| `server/lib/katex-macros.mjs` + `shared/katex-macros.mjs` | `kernel/noema/katexmacros/` | 平凡 |
| `server/lib/bibliography.mjs`(791)、`meta.mjs`、`assets.mjs`、`media.mjs`、`save.mjs`、`session.mjs`、`task-core.mjs`、`tmp.mjs` | 并入对应 `model/` 集群 | 思源已有 `model/assets.go`(2,620)、`model/storage.go`、`kernel/task/`，多为合并而非新写 |

**C. 保留为 Node sidecar（按你的要求，JS/TS 插件形态）**
- **Jupyter**：`server/jupyter/`(3,049) + `server/lib/jupyter-cell.mjs`(2,623) + `jupyter-kernel-ws.mjs` + `jupyter-output-router.mjs` + 浏览器侧 `src/jupyter-rendermime.ts` / `jupyter-widget-runtime.ts`。已经隔离在 API + WebSocket 后面，把 raw-ZMQ 线协议和 ipywidgets 桥重写成 Go 是数月弯路且无用户可见收益 —— **不做**
- **Copilot**：`server/lib/copilot.mjs` + `src/copilot/`，LSP bridge，同上
- Node web host 是 App 与 Emacs 共用的后端入口，并统一持有 Jupyter/Copilot 与 Go 数据 kernel 生命周期；Electron/Emacs 只负责各自 adapter 的启动与系统桥接，不复制后端 supervisor

**API 通道映射**：Noema 现有 ~160 个 `aaronnote:api:*` 通道（wiki 31 / notes 26 / jupyter-cell 25 / jupyter 9 / emacs 8 …）迁到思源的 `POST /api/*` + `{code,msg,data}` 形状。`aaronnote/api-client.ts`(1,697) 作为唯一 facade 改一次，上层调用点不动。`server/infrastructure/api-router.mjs` 的 channel 注册模式弃用。

**验证**：agenda 全部 8 个视图与旧实现输出逐条对拍；LaTeX 导出产物字节对比；`git status` 语义与旧 wiki-sync 一致。

---

## Phase 4 — SiYuan-derived Electron 系统适配（已完成；tray/global shortcut 按真实需求扩展）

不再把思源 Electron 能力翻译成 Rust/Tauri。复用其成熟窗口生命周期、single-instance、native menu、文件打开和多窗口决策，但不继承上游渲染进程直接 `require("electron")` / `@electron/remote` 的宽权限模型。Noema 保持窄 preload、context isolation 和 sandbox。

**已完成 P0**：共享 Node host 启动、Node-owned Go supervisor、原生窗口/菜单、window state、文件打开、拖放、clipboard/dialog/path APIs、VS Code/new-window 行为、packaged smoke；Emacs xwidget 完全不经过 Electron。

**P1 print-to-PDF 已完成（2026-08-26，当前工作树）**：File 与 Editor Actions 原生菜单现共享 `runHostCommand("export-pdf")`；renderer 在结束临时 inline-math 编辑后，从当前 CM6 完整内存 Markdown 生成 PDF 专用 publication HTML，而不是抓取虚拟化的编辑器 DOM。该 HTML 沿用现有 note asset resolver，图片与绝对 note CSS 继续经 loopback host 读取；KaTeX CSS 改为内嵌 data stylesheet，不再让打印或 published HTML 运行时依赖 jsDelivr。窄 preload 只新增一个 `exportPdf` IPC：main process 显示原生 save dialog，再用隐藏 BrowserWindow（context isolation、sandbox、无 Node、禁止 popup/外部导航）加载私有 staging HTML，等待 fonts/images 后调用 Electron `printToPDF`。请求有空/NUL/32MiB 上限，输出先验证 `%PDF-`，再以同目录 0600 temp + rename 原子替换，成功或失败均销毁窗口与 staging；旧的零调用 Pandoc/XeLaTeX runtime PDF helper 已移除，LaTeX export 保持独立。smoke-only 显式输出覆盖必须同时具备 `NOEMA_DESKTOP_SMOKE=1`，普通 App 无静默写路径。

**P1 print-to-PDF 正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 PDF/Electron/render/security 聚焦组为 5 files、71 tests 全绿，`tsc --noEmit`、三份 Electron 脚本 syntax 与 `git diff --check` 通过；最终 `make test` 为 172 files passed / 7 skipped、1619 tests passed / 16 skipped。`make build` 重建 3991-module production renderer、Go kernel 与 Electron shell，`make install` 更新真实 `/Applications/Noema.app`；本批没有改 Go，canonical/installed kernel SHA-256 均保持 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`。

安装包由真实 renderer 提供一篇 7104-byte、远超首屏的 Markdown（含 Unicode、canonical `\(...\)` 数学和第 40 段后的唯一末尾 marker），原生导出得到有效 PDF 1.4、A4、3 pages、88869 bytes；`pdftotext` 同时读到 `数学 · γράφημα · ∫₀¹x²dx`、数学文本层 `eiπ + 1 = 0` 与 `NOEMA_PRINT_END_20260826_1007`，证明打印的是完整内存文档而非 CodeMirror viewport。三页进一步用 Poppler 以 300dpi 重渲染并逐页视觉检查：KaTeX 上标/字形、Unicode、标题层级、段落、页边距和末尾 marker 清晰，无裁切、重叠、黑块或失效字体；源 Markdown SHA-256 前后均为 `781cc185bac105ea68e01f8281753c6b2a2cf6b8f4c817addbd5a7e1da4023b0`。probe root/PDF 已整体移入 `/Users/hc/.Trash/noema-native-print-packaged-20260826-1007`（可恢复），300dpi review renders 也已移入 Trash，print staging 为空。AGENTS.md 原样 packaged smoke 随后继续报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。全局 registry SHA-256 仍为 `d74d1e564c27b55ec3a8e67287b06fba385939e2efe3dd791ffa554ac1771f3b`，Noema registry 探针前后均为 `3c421c68f03604fd265bd2599ddc79bcc39c3fcc027476e5193e5738072286c7`；默认 root 无 `.siyuan`/`.sy`，Emacs full-project + 7 个 shared resource links 正确、retired lowercase path 缺席，无 packaged/web-host/kernel PID 或 smoke/probe temp，`make disk-audit` 仍为安装 App 44KB unique physical accounting。

**P1 `noema:` protocol handler 已完成（2026-08-26，当前工作树）**：安装壳的 `CFBundleURLTypes` 现声明 `noema` scheme，main process 在 ready 后注册系统 handler，并在 ready 之前就监听 macOS `open-url`；冷启动 argv、运行中 `open-url` 与 `second-instance` 都汇入同一队列/分发器，不会让显式 deep link 被 session restore 覆盖。公开面刻意保持很小：`noema://open?path=<workspace-relative.md>`、`noema://open?file=<absolute.md>`（可选 fragment/`hash` 或 `dom`，以及 `disposition=new`）、`noema://wiki`、`noema://graph`。解析器有 16KiB 总长与字段长度上限，只接受白名单 command/参数并拒绝重复/歧义参数、credentials/port、控制字符、非 Markdown、相对 absolute-file、workspace traversal、隐藏路径、目录/缺失文件；打开前再以 `realpath` + `stat` 验证普通文件，workspace 路径同时做 canonical containment，阻断 symlink escape。协议没有新增 preload 能力；已打开文档的 anchor/DOM 跳转复用共享 `runHostCommand("open-location")`，新窗口则由原有 host URL 传递定位参数，Wiki/Graph 仍走既有 Electron window adapter。

**P1 protocol 正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 parser/Electron 聚焦组为 2 files、11 tests 全绿，MathLive 66 项测试连续三轮稳定；后者顺手发现并修掉了一个全量 teardown 细节——直接初始化既有 MathLive 字段时也必须关闭其原生 suggestion provider，避免第三方 32ms popover timer 在测试 DOM 销毁后访问 `document`。最终 `make test` 为 173 files passed / 7 skipped、1625 tests passed / 16 skipped；`make build` 重建 3991-module renderer、Go kernel 与 Electron shell，`make install` 更新真实 `/Applications/Noema.app`，Info.plist 的 `CFBundleURLTypes` 读回为 `com.noema.desktop.noema` / `Viewer` / `noema`，canonical/installed kernel SHA-256 均为 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`。真实 macOS LaunchServices warm-open 用 `/usr/bin/open 'noema://open?path=target.md'` 投递到已运行安装版，main 明确报告 `source:"open-url"`、canonical target 正确，renderer 报告 `protocolProbe.matched:true` 并显示目标文档的两个标题；同份 smoke 继续报告 `hostMode:desktop`、`preload:true`、54px 标题栏与五个规定控件全绿。安装模型的 app resource 是 canonical source link，Electron 会报告 `app.isPackaged=false`；实测据此修正了错误的注册条件，安装版现在 `protocolRegistered=true`，开发 Electron bundle 无对应 plist 时则安全返回 false。

AGENTS.md 原样无附加变量 smoke 最终再次报告 `protocolRegistered:true`、`hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、五个规定控件、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。protocol probe 的源 Markdown SHA-256 保持 `1f099dbe8addc592d0d39a65064741a1c7f35a646a62bd57af37ebff41a7dd80`，root/database 已整体移入 `/Users/hc/.Trash/noema-protocol-probe-20260826-1020`（可恢复）。全局/Noema workspace registry SHA-256 分别保持 `d74d1e564c27b55ec3a8e67287b06fba385939e2efe3dd791ffa554ac1771f3b` / `3c421c68f03604fd265bd2599ddc79bcc39c3fcc027476e5193e5738072286c7`；默认 root 无 `.siyuan`/`.sy`，Emacs full-project 与 7 个 shared resource links 全部解析到 canonical repository/`resources/`，retired lowercase path 缺席，无 Electron/web-host/kernel PID 或 smoke/probe temp，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。

**后续 P1**：仅在确认真实需求时再做 tray/global shortcut；必须继续通过 preload 窄通道，不能把 Node/Electron globals 暴露给 renderer。

**P2（可延后）**：多工作区、自动更新、代理/header、原生拼写、rich clipboard、powerMonitor。多工作区若实现，仍是一工作区一份共享 web host + kernel，两个宿主只连接，不复制后端。

**验证**：Electron 窗口能起共享 host/kernel、开文档、TOC popup 与 Knowledge dock 语义正确；Emacs 侧 `my/noema-*`、Jupyter 和 gateway 行为全部不变。

---

## Phase 5 — 收口与手感对拍（已完成）

- [x] sidecar 接入：Jupyter `@@cell` 端到端与 Copilot 内联补全链路已接入共享 Node host（详见下方生产取证）
- [x] 属性视图在 CM6 中可编辑：`#+begin av` widget 已接 portable kernel read model 与有界 cell mutation（详见当前进度记录）
- [x] 思源 UI 设计落地：b3- 组件系统用于 Noema 的所有对话框/菜单/面板；反链、图谱、搜索、标签保持 Knowledge dock，大纲按已确认的最终交互保留独立 TOC popover
- [x] 主题：`daylight`/`midnight` 与 Noema 现有 `src/styles/themes/` 合并，`--b3-*` 变量保留以吃思源主题生态（详见下方生产取证）
- [x] 手感回归门禁：逐条对拍 vim 模式、排版宽度（4%–8% 自适应 + 95ch）、数学 snippet、bracket 行为、有序列表重编号、heading fold、结构跳转、Emacs 按键桥、5MB 大文档性能（详见下方正式门禁）
- [x] 安装包生产手感探针：隔离 scratch CM6 通过真实 keydown/input-handler 验证 Enter、bracket/type-over、选区包裹、Unicode grapheme 删除、undo/redo 与 programmatic-load opt-out，且不触碰当前笔记

**Phase 5 sidecar 收口（2026-08-26，当前工作树）**：安装版 Electron runtime 启动 shared `web-host.mjs` 的真实探针发现，desktop Jupyter 曾优先读源码 `jupyter/.jupyter/data` 中由历史 Emacs compatibility link 生成的同名 `python3` kernelspec，`argv` 因而落到 `~/.emacs.d/lisp/roam/Noema/...`；这违反 standalone App 不得运行时依赖 Emacs 的边界。现在 desktop 的 data/config/runtime 全部落到 `<stateRoot>/jupyter`，只在 desktop 模式让 source-owned `python3`/`bash`/`sagemath` 模板先占稳定名称，Emacs broker/generated-spec 顺序保持不变，其他用户 kernelspec 仍可发现。Python/Sage launcher 与 bootstrap/doctor/install-kernelspec 脚本已删除隐式 `EMACS_ROOT`/central Emacs runtime 发现，只接受显式 runtime metadata；三个模板把 Jupyter/IPython/Sage/log/tmp 路径明确注入 host state。隔离 maintenance probe 在精确 Node 26.5.0/npm 11.17.0 下实际完成 Python + Sage bootstrap/doctor，生成的三个 specs 全部指向 canonical Noema launcher 与独立 state，源码 `jupyter/.jupyter` 无新增写入。

修复后再次用 `/Applications/Noema.app/Contents/MacOS/Electron` 的 production Node runtime、隔离 external root/state 和 bundled Go kernel 走公开 Jupyter channel：`open-script` 选择 canonical `jupyter/bin/python-jupyter-kernel`，执行 `value = 6 * 7` 后返回 stdout marker 与 `42`；`.cell/sidecar.python.python3.ipynb` 按 nbformat 4.5 持久化 source、`execution_count:1`、两项 outputs、Noema cell/kernel/session metadata，tasks 明确报告 owned generation 1，shutdown API 随后移除 registry、Python PID、connection file 与 owned sidecar。相同 production host 的 bundled `@github/copilot-language-server` 启动为独立 PID并进入 `Ready/Normal`；完整安装版 smoke 又确认 always-active `noema.copilot@1.0.0` plugin 已加载并注入独立 plugin storage。renderer focus/document/inline/shown/accept/partial-accept/close 与 server/plugin boundary 的 41 项测试全过；实际补全文本仍由用户 GitHub 登录和网络决定，release gate 不以擅自消耗账户配额为条件。

**Phase 5 sidecar 正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下 Jupyter finder/service/lifecycle/raw-kernel、Copilot server/renderer 与 desktop plugin 聚焦组全绿；最终 `make test` 为 175 files passed / 7 skipped、1636 tests passed / 16 skipped。`make build` 重建 3992-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新 `/Applications/Noema.app`；canonical/installed kernel SHA-256 同为 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`。AGENTS.md 原样 packaged smoke 报告 Copilot bundled plugin ready、`hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/Forward/Refresh/Editor actions/Window actions、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。默认 root 无 `.siyuan`/`.sy`，Emacs full-project + 7 个 shared resource links 正确、retired lowercase path 缺席；退出后无 Electron/web-host/Go/Jupyter/Copilot PID 或 smoke temp，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。探针 root/state 与 maintenance state 已整体移入 `/Users/hc/.Trash/noema-sidecar-production-20260826-1112`（可恢复）。

**Phase 5 主题收口（2026-08-26，当前工作树）**：审计发现 `app/appearance/themes/daylight/theme.css` 与 `midnight/theme.css` 本来都完整定义了 165 个 `--b3-*` 变量，但运行时 manifest 只暴露 Aaronnote/Claude/Mediki，两个上游主题既不可选择，也没有进入 Noema renderer。现在 Daylight/Midnight 已加入主题清单并通过 source-owned wrapper 接入；上游 CSS 使用“原生 SiYuan 无 `data-noema-theme` 时兜底 + Noema 选中主题显式作用域”，同一 bundle 同时包含两套 CSS 时不会串色。Aaronnote/Midnight 共用暗色语义，Claude/Daylight 共用暖色语义，Mediki 在 Daylight 完整变量集上覆盖自己的核心 palette。永久测试会递归解析 CSS imports，要求 manifest 中五套主题都有完整 Noema token palette、恰好 165 个有效 `--b3-*` 定义，并逐项校验 Daylight/Midnight 与 `app/appearance` 真相源同构。

**Phase 5 主题正式门禁（2026-08-26）**：主题/config/Electron 聚焦组为 4 files、19 tests 全绿，`tsc --noEmit` 通过；安装版真实切换取证读到 Daylight `light/#f4f0e8/#2f2c28`、Midnight `dark/#141a27/#e2eaff`，对应 b3 background/primary/border 分别为 `#f4f0e8/#c15f3c/#c9c0b2` 与 `#141a27/#7ee7ff/#435574`；Mediki 为 `#f5f9f8/#087f78/#aebfbd`，默认 Aaronnote 也读到完整 Midnight b3 值。最终精确 Node 26.5.0/npm 11.17.0 `make test` 为 175 files passed / 7 skipped、1637 tests passed / 16 skipped；`make build` 重建 3994-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新真实 App。AGENTS.md 原样 smoke 同时报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、五个规定控件、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿，并从 production computed style 读回 Aaronnote/Noema/b3 三组一致值。canonical、Resources/bin 与 Resources/app 三处 kernel SHA-256 均为 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`；默认 root 无 `.siyuan`/`.sy`，Emacs 两个 full-project 入口与 7 个 shared resource links 正确、retired lowercase path 缺席，无 Electron/web-host/kernel 或本批 temp 残留，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。隔离主题探针已移入 `/Users/hc/.Trash/noema-theme-production-20260826-1121` 与 `/Users/hc/.Trash/noema-theme-mediki-production-20260826-1125`（可恢复）。

**Phase 5 b3 组件系统收口（2026-08-26，当前工作树）**：新增 source-owned `b3-component-system.ts` 与 `b3-components.css`，按 SiYuan 现有 `b3-dialog` / `b3-menu` / `b3-list` / `b3-button` / `b3-text-field` / `b3-select` / `b3-slider` / `b3-switch` / `b3-card` 契约，把 dialog host/container、menu/listbox、panel/popover/dock 及其动态控件统一映射到 b3 class；所用 30 个 `--b3-*` token 在 Daylight/Midnight 的 165-variable 真相源中逐项有定义。适配器已进入 editor、Wiki、Jupyter、Configuration、Agenda 五个拥有交互 chrome 的 route；MutationObserver 只处理新出现的语义 surface 或已接入 surface 的后代，普通 CM6 文档 churn 明确不进入扫描热路径。b3 层只拥有 palette、边框与交互状态，各 host/page CSS 继续拥有位置和尺寸，因此 LiveTeX、原生 dialog、右/下 dock 与 floating TOC 的几何没有被组件层替换。

大纲没有为了字面上的“dock 化”而逆转此前已确认的用户要求：单击 Page/TOC 继续打开独立 floating popover，双击才打开 Backlinks/Graph/Search/Tags 四 tab Knowledge dock；Agenda 仍是独立底部 dock。永久测试同时锁定这一例外、动态 modal/menu 接入、危险/取消/主按钮 variant、表单控件、卡片、零 editor DOM 误接、全 route 安装以及 b3 CSS 不得声明 dialog/panel geometry。

**Phase 5 b3 正式门禁（2026-08-26）**：b3/Electron 聚焦组 2 files、10 tests 与 `tsc --noEmit` 全绿；最终精确 Node 26.5.0/npm 11.17.0 `make test` 为 176 files passed / 7 skipped、1642 tests passed / 16 skipped。`make build` 重建 3996-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新真实 `/Applications/Noema.app`。AGENTS.md 原样 smoke 的 production audit 报告 `surfaces:21`、`candidates:21`、2 dialogs、3 dialog hosts、4 menus、12 panels、110 controls、`unadopted:[]`，并明确确认 Knowledge dock、TOC popover、Agenda dock 都命中 `b3-panel`；同一报告继续保持 desktop/preload、54px、五个规定控件、四 tab Knowledge、八视图 `kernel-agenda`、102 macros、完整 Aaronnote b3 computed values 与 owned/listening kernel 全绿。三处 kernel SHA-256 均为 `3c0101ee68aadd16d6953f8b03bf3fcbdc5de8373ac2bdd3ef7a16487a2bbd67`；默认 root 无 `.siyuan`/`.sy`，Emacs 两个 full-project 入口与 7 个 shared resource links 正确、retired lowercase path 缺席，无 Electron/web-host/kernel 或 smoke temp 残留，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。

**Phase 5 手感逐项收口（2026-08-26，当前工作树）**：没有用“既有文件未改”代替验收，而是沿用户可见的真实输入链逐项复核。Vim normal/visual/insert、多光标、Unicode grapheme、`s`/`S` jump、`z` fold 与销毁清理由 `roundtrip`、`vim-jump`、`vim-unhandled-key` 锁定；数学 snippet 从 source `SnippetSession`、嵌套 tabstop 到 LiveTeX/MathLive commit、undo/redo 与 Cmd-bracket handoff 由 snippet/MathLive/CM6 回归锁定；VS Code 式 bracket type-over、成对删除、selection wrapping、TeX source pair 与 xwidget control-byte 去重走真实 `keydown`/`beforeinput`。有序列表 Enter/嵌套提升会经过 canonical key dispatch 再重编号，programmatic load 与 undo/redo 保持 opt-out；heading fold 的 `zc`/`zo`/`zM`/`zR` 和按文件恢复、结构跳转的 Markdown block/inline math/display math 有界作用域也都有行为断言。Emacs 侧同时运行 renderer xwidget guard 与 `init-aaronnote.el` ERT，证明前缀键、client/source-window、undo/redo、focus release 和 gateway key event 仍由 `my/noema-*` 适配器处理。

排版宽度是本轮发现的唯一证据缺口：实现已有 `clamp(max(floor, 4%), (width - 95ch) / 2, 8%)`，但旧测试只验证扩展启停。现在该式提为单一 source-owned 常量，并以同一纯函数覆盖 gutter floor、4% 下限、95ch 居中和 8% 上限；packaged smoke 还会无修改地测量 production CM6 的 computed style。真实安装版在 919px 内容宽度下读到左右 gutter 均为 36.76px，95ch 为 1102px，计算期望同为 36.76px，`installed:true`、`matchesContract:true`，说明当前窄视口正确落在 4% 分支而不是伪造固定宽度。

**Phase 5 手感正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下，CM6/MathLive/snippet/xwidget 聚焦组 22 files、578 tests 全绿；5,295,985-byte fixture 的 5MB 独立性能组 11 tests 全绿（19.24s），覆盖普通键入、Enter、table/heading/math marker、已知 fence/`@@cell` 扫描、snippet transaction 与 1,200 display-formula 局部更新。Emacs `make jupyter-test` 四组共 141 ERT 全绿。最终 `make test` 为 176 files passed / 7 skipped、1643 tests passed / 16 skipped；`tsc --noEmit`、`make build`（3996 modules）、`make install` 均通过。AGENTS.md 原样 smoke 继续报告 `hostMode:desktop`、preload、54px、Back/Forward/Refresh/Editor actions/Window actions、21/21 b3 surfaces、TOC popover、四 tab Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿，并新增上述 production typography audit。

**Phase 5 安装包生产手感加固（2026-08-26，当前工作树）**：旧门禁的键盘行为仍主要来自测试 DOM；现在新增 source-owned `production-handfeel-audit.ts`，只在 desktop smoke 中创建一个位于视口外、没有 `onChange`/持久化 bridge 的 scratch CM6，并在返回前销毁。探针不是检查模块是否存在，而是实际向 production extension stack 发送 `keydown` 和 CM6 `inputHandler`：确认有序列表 Enter 得到 `2. `、标点前括号自动闭合且 closer type-over、非空选区包裹、一次 Backspace 删除完整 ZWJ family grapheme、真实 undo/redo，以及 `setMarkdown(..., history:skip, preserveView:true)` 不把刻意的 `5./9.` 编号自动改写。永久回归同时用 live-note sentinel 锁定 scratch host 清理与当前内容零触碰。

精确 Node 26.5.0/npm 11.17.0 下 audit/desktop adapter 聚焦组 2 files / 6 tests、`tsc --noEmit` 与最终 `make test`（177 files passed / 7 skipped、1644 tests passed / 16 skipped）全绿；`make build` 重建 3997-module renderer，`make install` 成功。AGENTS.md 原样安装版 smoke 明确返回 `productionHandfeel.installed:true`、`scratchOnly:true`、七项行为全 true、`passed:true`；同一报告继续保持 desktop/preload、54px 五控件、21/21 b3 surfaces、95ch/4% typography、TOC、Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿。

本批终检时仓库 HEAD 已推进到 `384b4940d029c995af8c5bbea4373d8d269e80f1`，Go 默认嵌入新 VCS revision，因此当前 canonical、installed `Resources/bin` 与 linked `Resources/app` 三处 kernel SHA-256 同步更新为 `bbdbda7fcb157c1e45677ed32511a95b3795adc8758319129853fa1718a29e39`，不是同一安装内的不一致。默认 root 无 `.siyuan`/`.sy`，Emacs 两个 full-project 入口正确、retired lowercase path 缺席；退出后无 packaged Electron/web-host/kernel 或 smoke/probe temp，`make disk-audit` 仍为安装 App 44KB unique physical accounting，`git diff --check` 干净。

**SiYuan 审计 backlog 开始逐项收割（2026-08-26，当前工作树）**：按 `docs/siyuan-merge-audit-2026-08.md` 总排序继续推进尚未落地的项目，第一批从 #3 中挑零依赖、已有上游测试且能进入真实产品链的三件。`officeList.ts` 已迁入 source-owned `src/office-list.ts` 并接在 `htmlToMarkdown` 的 sanitizer 之前：Word 的 `mso-list` 与 PowerPoint 的 `mso-special-format` 尚在时先重建语义化 `ol`/`ul`/task list，随后仍经过 Noema 既有 DOMPurify 与 Turndown 边界；普通 HTML 和超过 900,000 字符的降级策略不变。移植覆盖大小写/引号/括号安全的 inline-style 解析、Word list identity、PowerPoint pt/in/px/pc/cm/mm 层级、数字/字母/罗马序号、Wingdings/Unicode task marker、跳级嵌套、编号重启和普通段落分组。

同批 `columnWidth.ts` 迁为中立 `src/attribute-view-column-width.ts`，portable AV table 以稳定 column key 收集内容，先用 CJK=14px / 大写宽字符=9px / 空白=4px / 普通字符=7px 的确定性估算生成 `<colgroup>`，挂载后再用真实 cell 计算字体与 canvas `measureText` 重测，最终夹在 64–480px；resize 的 4px 吸附和等宽分配纯函数也一起保留。`imageAnimation.ts` 则迁为 `src/image-animation.ts` 并接到 CM6 的真实 `scrollDOM`：滚动时 O(1) 暂停动画，256ms 空闲后恢复，destroy 会解绑 listener；CSS 使用 Noema 自有 class，不泄漏 protyle 命名。Noema 已有的 `captureEditorPasteTarget`/state field 会让异步插入点跨 CM6 transaction 映射、文档替换失效并支持多光标，严格强于上游 24 行 DOM Range 检查，因此 `upload/insertPosition.ts` 记为语义已吸收，不复制较弱实现。当前五个聚焦文件 31 tests 全绿，默认 `tsc --noEmit` 也已在并行 Vim 改动完成接线后恢复通过；本批未覆盖或重写那组 Vim 工作。

**SiYuan 审计首批正式门禁（2026-08-26）**：精确 Node 26.5.0/npm 11.17.0 下最终 `make test` 为 183 files passed / 7 skipped、1753 tests passed / 16 skipped；`make build` 重建 4000-module renderer、FTS5 Go kernel 与 Electron shell，`make install` 事务更新 `/Applications/Noema.app`。AGENTS.md 原样安装版 smoke 返回 `hostMode:"desktop"`、`preload:true`、`titlebarVisible:true`、54px 和 Back/Forward/Refresh/Editor actions/Window actions 五控件，另有 21/21 b3 surfaces、production handfeel 全项、TOC、四 tab Knowledge、八视图 `kernel-agenda`、102 macros 与 owned/listening kernel 全绿；退出后无 Electron/web-host/kernel 进程。默认 note root 无 `.siyuan`/`.sy`，Emacs full-project link 与 7 个 shared resource links 全部指向 canonical repository/`resources/`，retired lowercase path 缺席；`make disk-audit` 保持安装 App 44KB unique physical accounting。当前 `git diff --check` 唯一未清项是并行 Vim 工作正在修改的 `tests/synthetic_qc_note_5mb.md:1621` 尾随空格，本批不越界改写该 fixture，待并行工作稳定后必须复跑清零。

**纯函数收割继续：hint/slash 生产接线（2026-08-26，当前工作树）**：`src/hint-core.ts` 已 source-own 思源 `slashMenu`、`blockHintRange` 和 entry-slot reorder 的中立语义：稳定 key 去重、已知条目在原 slot 内排序、可见性过滤、多语言 filter、空分组 separator 修复、多字符闭合符内编辑、block/tag/slash 触发互斥与右侧最新触发器。真实 `aaronnote/main.ts` 不另造第二个弹层，而把 `/` 与中文 `、` 接入既有 CM6 snippet listbox；条目来自每编辑器 `QuickInsertRegistry`，支持 localStorage 的 enabled/order/hidden 偏好，并补齐常用命令的中文、全拼和缩写过滤。选择条目时先按 Markdown 源偏移删除触发串，再调用 canonical `runQuickInsert`；失败会恢复原串。代码/HTML/数学上下文、URL/path slash、转义 slash 和非空选区不会误触。现有补全链的 `Epoch + CoalescedTimer` 已覆盖并强于 `search/request.ts` 的晚到响应守卫，现有 popup key state 已覆盖 `upDownHint.ts` 的上下/Home/End/分页/滚动可见性；这两项因此记为语义已吸收而不是复制平行实现。hint/editor/CM6 聚焦组 3 files、72 tests 与默认 `tsc --noEmit` 全绿。

**纯函数收割继续：标题自动编号（2026-08-26，当前工作树）**：审计把 `headingNumberCore.ts` 称作零依赖，但其上游实现实际硬编码 protyle `data-node-id`/contenteditable DOM；Noema 没有照搬这层，而是把同一仓库更权威的 `kernel/model/heading_number.go` 层级/格式语义迁成 `src/heading-number.ts`，再由独立 `src/cm6/heading-number.ts` 消费既有 incremental `tocIndexField`，避免每次键入重新扫描长文档。现在支持 decimal/alpha/roman/Greek hierarchical、full-width parenthesized 和 Chinese-document 全套格式，正确处理跳级标题、全角标点后不加空格及 fenced code 排除；编号是 CM6 widget，切到 Source 自动撤下，Markdown 源和 HTML 导出都不被物化污染。公共 Editor API、Tools、右键菜单和 Noema.app 原生 Editor Actions 都有开关，enabled/format 跨窗口用 `noema.headingNumbering.*` 本地偏好同步。纯模型、直接 CM6 和公共 Editor API 共 5 tests 全绿；连同 hint/editor/Electron 聚焦组为 4 files、43 tests，默认 `tsc --noEmit` 通过。

**中立前端工具与纯函数清单进一步收口（2026-08-26，当前工作树）**：新增 source-owned `src/platform-compat.ts`、`src/hotkey.ts`、`src/dom-ancestry.ts` 与 `src/transient-surfaces.ts`，把审计 #1 所指的错误 protyle 归属改造成 Noema 自己的 host-neutral seam：平台主修饰键同时供生产快捷键和 CM6 link-open 使用，热键 parser/matcher/tip 支持符号、Electron `CmdOrCtrl` 和 `Primary` 语法且默认精确拒绝额外修饰键；DOM helper 对 text node、边界、最近/最外层匹配都有测试；具名 transient registry 已真实接管 context menu 的 outside/viewport/Escape 关闭和换文档时 snippet/math/prose/menu 的集中清场。它只复用 Noema 既有 Electron narrow bridge、`src/clipboard.ts`/paste 与 localStorage 数据面，没有搬入思源的 Android/iOS/HarmonyOS 分支。

同批把 `formatPainterCore.ts` 迁为 `src/format-painter.ts` 并完成生产纵切：保留多段选择样式交集、once/continuous 和提示策略，但把 contenteditable span/CSS 手术改为 Markdown delimiter transaction，支持 strong/em/strike/highlight/sup/sub/code、现有 mark 清除、多光标、Source/visual 两种选区边界以及 code literal 互斥。公共 Editor API、右键惰性子菜单、Tools、Noema.app 原生 Editor Actions 和 Escape 取消均已接线，body 状态还提供明确 painter cursor。`Tree.ts` 则迁成 accessible `src/tree-view.ts`（递归折叠、roving focus、方向键/Home/End/Enter、modifier activation、右键和 drag/drop hooks），并替换 Wiki Folders 原平铺列表为可持久化的真实 repository/directory 树。`setPosition.ts` 已由上一批菜单 positioning core 覆盖；`dynamicLoadState.ts`/`loadAll` 属于 protyle 把单篇服务端 DOM 分块拉取的协议，Noema 的权威 Markdown 全文已在 CM6 immutable document，视口只由 `visibleRanges` + 增量 decoration delta 虚拟化，另有 `EditorViewportStabilizer` 保证 transaction 后锚点，因此该协议明确判为不适用、不能倒灌第二个部分文档状态机。当前 tree/core/format/menu/wiki/Electron 聚焦组均绿（最近一组 4 files / 34 tests；格式/菜单组 4 files / 20 tests），默认 `tsc --noEmit` 通过。

**审计总排序 #4 菜单系统接入（2026-08-26，当前工作树）**：新增 source-owned `src/menu-system.ts`，不是只留一个模型文件，而是替换生产 `aaronnote/main.ts` 的旧 button-only context menu renderer。声明项支持 stable id、accelerator/detail、checked/current、warning/danger/disabled、ignore/index、custom/readonly/empty/separator/submenu、同步子菜单和 `loadSubmenu()`；异步子菜单先显示 loading，按 parent render token、button connectivity 和 controller identity 拒绝晚到结果，空态/错误态有界。连续段会在过滤后重新标 group-first/group-last；键盘可循环 ↑↓、Home/End、→ 打开并聚焦子菜单、← 返回父级、Enter/Space 激活、Escape 关闭整棵树。定位函数上下翻转、水平/垂直钳制、sticky 锁边，并把 desktop 54px title bar 作为顶边界。Bibliography 自定义预览与所有既有 editor/link/math/Jupyter 动作已转用共享 controller；普通块的 Insert… 是真实异步惰性 Quick Insert 子菜单，动作仍回到 canonical `runQuickInsert`，命令语义没有搬进 UI 层。菜单/Editor/Electron/heading/hint 聚焦组 5 files、48 tests 与默认 `tsc --noEmit` 全绿。

最终终态同步升级：审计中判定“接上 / 拿 / 高价值”的剩余项必须逐项完成，明确“不要 / 暂不开工 / 可选”的项目要留下最终产品决策与独立证据；全部完成并跑过正式门禁后移除迁移期上游 checkout，再以全仓库引用扫描、构建/测试、安装包 smoke 和版权审计证明 Noema 不再依赖它。

---

## 需要先做的三个 Spike（在承诺 Phase 1 之前）—— 全部完成，2026-08-24

1. **lute markdown 往返保真**：`md(含 kramdown IAL) → Md2Tree → FormatRenderer → md` 是否字节稳定？含 Noema 的 `#+begin` 块、`@@cmd`、`$...$` 数学、`{attrs}`。**这条不过，整个方案要改**
   **结果：PASS（有条件）。** 实测用 `github.com/88250/lute@v1.7.8-0.20260816044801-e16e8e268504`（kernel 实际锁定的 fork 版本），14 组用例全部往返、二次 format 幂等。核心结论：
   - Noema 全部私有语法（`#+begin/#+end`、`@@cmd(...)`、`{attrs}`、`$$...$$` 数学）字节级不变 —— lute 把它们当不认识的段落文本原样保留，这也直接印证了 Spike 3 的结论（见下）。
   - 两个自动注入行为，一次性、幂等，非破坏性：文档根节点首次 format 会被追加 `{: id="..." updated="..." type="doc"}`；`KramdownBlockIAL` 开启后每个列表项首次 format 也会被无条件注入 `{: id="..."}`（源码见 `parse/list.go: listFinalize`，硬编码、无独立开关，与文档根 ID 注入同源于 `parse/parse.go: finalParseBlockIAL`）。这意味着 §1.2"惰性 IAL"策略对列表项不成立——SiYuan 的块模型把每个列表项都当一等可引用对象，这是继承 lute/SiYuan 语义的必然代价，不是缺陷。
   - **一个真实的破坏性发现**（不是幂等噪音，是结构错位）：`#+begin/#+end` body 若以列表结尾，`#+end` 行会被 CommonMark 列表续行规则吞并、重新缩进——已写入 §1.3，需要 kernel 侧做显式 fenced-container 扫描而非依赖默认解析。
   - 结论：Phase 1 的"md 为真相源"整体方案成立，无需推翻；但 §1.2（列表项做不到惰性 ID）与 §1.3（`#+begin/#+end` 需要专用扫描器）需要在实现前更新，已更新。

2. **AV 渲染层可否脱离 protyle**：`app/src/protyle/render/av/` 的 ~50 个文件对 `IProtyle` 状态包的依赖深度。若过深，属性视图要重做而非复用
   **结果：PASS，中等耦合，可通过适配层复用。** 实测：70 个文件中 37 个引用 `IProtyle`（130 处）。耦合分三类：(a) 平凡数据/标志位（`disabled`/`id`/`block.rootID`/`notebookId`/`app.appId`）—— 可用 shim 对象直接满足；(b) DOM 作用域查询（`wysiwyg.element.querySelectorAll` 等）—— 这些查询只扫描 AV 块自身子树，换成 AV widget 自己的根 DOM 元素即可；(c) `protyle.toolbar.range`（选区状态）—— 需要一个 CM6 selection → Range 的适配器；(d) **3 处、3 个文件**依赖 protyle 客户端自带的 lute WASM 实例（`blockAttr.ts: Md2BlockDOM`、`action.ts: SpinBlockDOM`、`cell.ts: GetLinkDest`）—— 都是有界、单用途调用，可直接改为调用内核 API（内核本来就有非 WASM 的完整 lute），`GetLinkDest` 甚至可以用几行正则本地重写掉，不需要网络往返。
   结论：不需要重做，需要一个 protyle-shim 适配层（(a)(b)(c) 三类）+ 3 处 WASM 调用改内核 API/本地重写，工作量在"适配"量级，不到"重写"量级。

3. **lute 语法扩展成本**：Noema 私有语法要教给 lute（Go 侧解析 + 3.6MB WASM 重新编译）还是在 CM6 侧单独解析（Lezer，现状）。倾向后者 —— 内核只需识别块边界与块 ID，不必理解 `@@todo` 内部结构；但 agenda 的 Go 实现需要 `kernel/noema/planning/` 独立解析，两边靠共享 fixture 对齐
   **结果：确认倾向成立，且被 Spike 1 直接证实。** lute 未经任何扩展就已经把 `@@cmd(...)`、`{attrs}`、通用 `#+begin note` 当作不透明段落文本原样保留（不解析、不报错、不丢字节）——内核完全不需要教会 lute 理解这些语法的内部结构，CM6/Lezer 继续独占语义层。唯一需要教给 lute（kernel 侧扩展）的是一个封闭小集合：`#+begin av/superblock/embed` 这三种保留 kind 的**边界识别**（不是内容语义），且必须按 Spike 1 发现的 fenced-container 扫描方式实现，不能指望默认段落/列表解析正确收尾。

---

## 基础行为审计与修复（2026-08-26，当前工作树）

一次针对"基本手感"的横向审计：版本管理同步、Markdown 渲染、Vim hjkl/上下左右、输入。方法是先跑基线（1643 项全绿，靠读代码找不出问题），再对每个领域写探针测试打出真实行为，只修有证据的缺陷。基线到收尾：**1643 → 1810 项通过，无回归**；`tsc --noEmit` 干净。

### 修掉的 bug

- **`dd` 会把光标留在文档末尾之外**（`aaronnote/vim-lite.ts`）。`deleteLines` 用 `changes.mapPos(range.from, -1)` 定位光标；当删除借用了*前一个*换行符（删最后一行时必然如此），映射结果是存活行的**行尾**——Normal 模式没有这个合法位置。后果不是"看着别扭"而已：紧接着按 `i` 会在最后一个字符之后进入 Insert，按 `x` 删错字符。修法是新增 `linewiseLandingPosition`，按 Vim 的规则落在"顶上来那一行的第一个非空白字符"。普通 `dd`（normal → normal）此前完全没经过 `normalizeNormalSelections`，Visual-line 的 `dd` 因为 `setMode` 会归一化所以没暴露这个问题。
- **块锚点 `{#id}` 与块引用 `((id "label"))` 会原样泄漏进导出/发布 HTML**（`src/render-html.ts`）。编辑器早就把两者投影成徽章和 chip（`block-anchor.ts` / `block-ref.ts`），`renderOrgEnv` 也给 org-env 身份做了同样的事，但普通段落/标题/列表项没有对应规则——每个带锚点的块发布出去都带着一串 `{#0198fbac-…}`。新增 `noema_block_identity` core rule 补齐。三个实现细节值得记：(1) 必须是 **core rule 而不是 inline rule**，因为 markdown-it 的 `text` 规则只在终结符集合上停下，而 `(` 不在其中——`((id))` 的 inline rule 永远走不到；(2) 扫描 inline token 的**原始 `content`** 而不是已经切好的 children，否则 `"a*b*c"` 这种标签会被 emphasis 拆散、再也拼不回来，非身份片段用 `parseInline` 重新 token 化（和 `aaronnoteCalloutsRule` 同一套做法）；(3) 用 `matchAll` 而不是 `exec` 循环——`parseInline` 会递归重入这条规则并把共享 `g` 正则的 `lastIndex` 归零，`exec` 写法会**死循环**（这个 bug 是自己引入又当场被测试抓住的）。代码/数学区间由 `literalInlineRanges` 排除，与两个 widget 的 `excludedRanges` 对齐。发布页的 `<article>` 本来就带 `class="cm-editor"`，所以复用 `cm-noema-block-id` / `cm-block-ref` 两个类名即可，**不需要新增任何 CSS**。
- **`[[wiki link]]` 的 `noema-internal-link` 类名重复输出两遍**：`wikiLinkRule` 已经打了这个类，`link_open` 又 `attrJoin` 了一次。新增 `joinNewClasses` 把 class 列表当集合处理。
- **同步的瞬时 5xx 被误判成不可重试的 internal 错误**（`server/lib/wiki-sync.mjs`）。`classifyGitFailure` 的 network 分支只认 `http 5xx`——那是 Git 智能 HTTP 的 RPC 措辞。`git fetch`/`ls-remote` 走 curl 时报的是 `The requested URL returned error: 503`，匹配不上，于是落进 `internal`：只给一次免费重试，第二次就变成 `phase: "error"`、`retryable: false`、要求人工介入——而这本质上是服务端的临时故障。补齐 curl 措辞、429 限流、`failed to connect to` / `bad gateway` / `early EOF` 等形态，让它们回到 network 的 1m/5m/30m/2h 退避。同时把 `classifyGitFailure` 导出以便直接测试。

### 补齐的 Vim 基本动作

审计发现 Normal 模式此前只有 `dd`/`yy` 两个操作符组合，且**完全没有计数前缀**——每个数字键都走 `reportUnhandled`。以下全部补齐并测试：

- **计数前缀**：`3j`、`2dd`、`d3d`、`2d3d`（按 Vim 语义相乘）、`5w`、`3x`、`3~`、`3J`。`0` 在没有计数时仍是行首动作，有计数时才是数字。计数上限 `MAX_VIM_COUNT = 10_000`——每次重复都是真实工作量，卡键卡出的 `999999999j` 不能冻死编辑器。
- **动作**：`e`/`E`（词尾）、`^`（首个非空白）、`{`/`}`（段落，整段空行算一个停靠点而不是每行一个）、`f`/`F`/`t`/`T` + `;`/`,`（只在光标所在行内搜索；`;` 重复 `t` 时要多跳一格，否则会卡在同一个邻居上）、`G`/`gg` 带计数变成"跳到第 N 行"。
- **操作符 + 动作**：`d`/`c`/`y` 现在接受上述所有动作。exclusive/inclusive 的区分是这里的全部要害——`dw` 停在下一个词之前，`de` 要吃掉当前词最后一个字符。另外实现了两个 Vim 特例：`cw` 在非空白上等价于 `ce`（不吞掉词间空格），`dw` 在行尾最后一个词上停在行尾而不是吞掉换行。
- **行尾操作与其他**：`D`、`C`、`Y`、`cc`（清空行内容但保留行和缩进）、`J`（合并行，折叠缩进为单个空格）、`~`（换大小写并前进）。Visual / Visual-line 模式同样接入计数与新动作。

`aaronnote/xwidget-key-guard.ts` 无需改动：`handleXwidgetVimKeydown` 对非 insert 模式的键是原样透传的，没有白名单，新键在 Emacs 宿主里自动生效。

### 审计过但没有发现缺陷的部分

- **输入 / 列表续行**（`runEditorEnter`）：无序/有序/任务/引用列表的续行与空项退出、嵌套缩进、行中拆分、有序列表重编号，探针全部正确。
- **Markdown 渲染的通用部分**：表格与对齐、嵌套列表、任务列表、删除线、硬换行、setext 标题、脚注、自动链接、实体、XSS（`<script>`、`onerror`、`javascript:` href 与 img src）全部正确。`$…$` 不渲染是**设计如此**——Noema 的行内数学是 `\(…\)`（见 `src/inline-math.ts` 的说明），不是 bug。
- **保存冲突检测**（`runtime.mjs` 的 `saveNote`）：`baseVersion`/mtime 前置条件、同客户端连续保存链的识别、空覆盖保护、保存队列，逻辑自洽。
- **`wiki-sync` 的主流程**：租约、孤儿 index.lock 恢复、隔离（quarantine）、集成 worktree、冲突三方暂存，都有真实 git 仓库的端到端测试覆盖（703 行），除上面那条分类问题外没找到能证实的缺陷。

### 新增测试

`tests/vim-normal-mode.test.ts`（7）、`tests/vim-motions.test.ts`（64）、`tests/vim-operators.test.ts`（44）、`tests/render-block-identity.test.ts`（19）、`tests/wiki-sync-failure-classes.test.ts`（12）。`tests/vim-unhandled-key.test.ts` 里原先把"计数前缀"和 `dw`、`c`、`f` 钉成"未绑定"的用例已改写——它们现在都能用了，该文件继续守住"未绑定和弦必须有反馈"这条真正的契约。

---

## 基础行为审计第二轮（2026-08-26，当前工作树）

接着上一轮，把只浅尝过的两块挖到底：**编辑器内的实时渲染（live-preview）**和**非 insert 模式的 hjkl**。方法同前——先探针打出真实行为，只修有证据的缺陷。**1860 → 1917 项通过，`tsc --noEmit` 全干净。**

### 修掉的 bug

- **平台探测把 macOS 认成 Windows，Cmd+click 打不开链接**（`src/platform-compat.ts`）。陷阱是 **`"darwin".includes("win")` 为真**：`detectNoemaPlatform` 的 `win` 分支排在 Apple 分支之前，于是任何拼出 Darwin 内核名的平台串都被判成 `win32`。而 `navigator.platform` 恰恰就这么拼——Emacs xwidget 宿主和测试环境里都报 `"X11; Darwin arm64"`。后果是 `primaryModifierDown` 反过来要求 Ctrl，macOS 上 Cmd+click 直接失效，`tests/cm6/roundtrip.test.ts` 12 个链接用例同时红掉。抽出 `classifyPlatformHint` 统一两条分支（explicit 与 navigator 都有这个洞），并把顺序固定成 Apple → Linux/BSD → Windows。顺带修正了 explicit 分支的同类问题：`detectNoemaPlatform("Darwin x64")` 此前也会返回 `win32`（`value === "darwin"` 精确匹配救不了带后缀的串）。
- **每个 Markdown 链接被包进 5 层同名嵌套 span**（`src/cm6/live-preview.ts`）。`[label](url)` 有 5 个 delimiter 节点（`[`、`]`、`(`、URL、`)`），每个都带着**整段**链接的 `linkClass`，而 `buildDecorations` 对每个 delimiter 都 push 一次整段 mark。`color` 和 `underline` 在嵌套下幂等，所以一直没被发现；但内部链接 `:hover` 的半透明底色 `color-mix(…, transparent 91%)` 会叠 5 层（约 9% → 37%），而且每次选区变化 CM6 都要重做 5 倍的 decoration 与 DOM 工作。按 `(spanFrom, spanTo, linkClass)` 去重后降为 1 层。
- **Tab 缩进 2 格、Backspace 只退 1 格，缩进不可逆**（`src/cm6/input-commands.ts`）。`runEditorTab` 插入一个 indent unit（默认 2），但删除链最后落到逐字素删除，于是 Tab 之后 Backspace 会让行比原来浅 1 格。新增 `deleteIndentUnitBackward` 插在 `deleteMarkupBackward` 与字素删除之间：只在**纯行首空白**里生效，退到上一个 tab stop（这正是 CM6 自己 `deleteCharBackward` 的规则，Noema 的删除链因为不走那条命令所以得自己补）。列表标记 outdent、括号对删除、词间空格、字面 tab、选区删除、前向 Delete 全部不受影响。

### 让不可测的导航逻辑变得可测

`moveScreenLine` 的**像素路径**（真实布局下按屏幕行移动，再由 `crossedVisualEntry` 判断是否跨过了 Visual 层折叠掉的东西）在无头 DOM 下从不执行——`getBoundingClientRect()` 返回零尺寸，测试永远只走逻辑行 fallback。`crossedVisualEntry` 自己并不测量任何东西，只是调用方需要布局，所以把它导出后可以直接用显式 start/target 测：现已覆盖行间公式、org-env 标题、被块吸收的空行三类吸附点，以及"没跨过就不吸附""Source 模式不吸附"两条边界。

审计中一度怀疑像素路径有单位错配——`goalColumn` 被塞进的是 `coords.left - rect.left`（内容相对），而 CM6 的 `posAtCoords` 吃的是视口坐标。核对 CM6 源码后确认**不是 bug**：`moveVertically` 内部就是 `goal = startCoords.left - rect.left`，再 `resolvedGoal = rect.left + goal`，Noema 连无坐标时的 `defaultCharacterWidth * column` 兜底都跟 CM6 的约定一致。

### 审计过、确认无缺陷的部分

- **非 insert 模式 hjkl（46 个探针，全对）**：`h`/`l` 不跨行、停在末字符不越界、空行上是 no-op、按字素簇整体跨越 CJK / ZWJ emoji 家族 / 组合字符 / tab、行内公式按边界原子进入；`j`/`k` 的 goal column 跨短行与空行都保持、水平移动会正确重置、`3j`/`3k` 计数正确、首末行不动、CJK 列宽按字素算；Visual 模式 inclusive 语义（含反向跨锚点、`o` 换端不改选区）；Visual-line 整行选取与 `h`/`l`/`0`/`$` 被吞掉不塌陷选区。已固化为 `tests/vim-vertical-motion.test.ts`（21）与 `tests/vim-visual-motion.test.ts`（17）。
- **live-preview 其余构件**：粗体/斜体/删除线/行内代码/标题/wikilink 的 `syntax-hidden` 隐藏与光标触碰转 `syntax-hint` 全部正确；转义 `\*` 正确保留 `*` 只隐藏反斜杠；嵌套强调、链接套粗体、代码里的 `**`、脚注、引用式链接、表格、任务列表等 16 种构件均无多余嵌套 span，源码往返全部无损。唯一剩下的两层 `cm-link-text` 是 `[](#slug)` 空锚点——URL 被有意当作可点文本渲染，`color`/`underline` 幂等，无视觉影响。
- **source ↔ preview 切换**：纯文本、行内数学、表格、org-env、围栏代码五种构件切过去再切回来字节稳定。
- **括号与输入**：自动配对（`(`/`[`/`{`/`"`）、配对后 overtype、配对删除、选区包裹（`(`、反引号、`*`、`"`）、词前不配对、数学区内仍配对（这是 `close-brackets-vscode.ts` 有意放宽的 VSCode 规则）全部正确。

### 新增测试

`tests/vim-vertical-motion.test.ts`（21）、`tests/vim-visual-motion.test.ts`（17）、`tests/live-preview-link-spans.test.ts`（10）、`tests/editor-indent-delete.test.ts`（14）、`tests/platform-compat-detection.test.ts`（13）。

---

## Vim 模式专项审计（2026-08-26 第三轮，当前工作树）

专门针对 vim 模式，把前两轮没覆盖的面全部过掉：模式切换与 Escape 语义、insert 入口变体、寄存器与 `p`/`P`、`r`、undo/redo、fold 与缩进、多光标、`s`/`S` avy 跳转、公式感知的行操作、嵌入式输入框内的 vim。**1917 → 1985 项通过，`tsc --noEmit` 干净。**

### 修掉的 bug

- **Visual 模式 `y` 之后光标停在错误的一端**（`aaronnote/vim-lite.ts`）。`normalizeNormalSelections` 的 collapse 分支写成 `if (collapse && !range.empty)`，无条件覆盖 `position`——把调用方通过 `mainOverride` 传进来的落点直接丢掉。同一个函数紧接着的 `fromInsert` 分支有 `&& !overridden` 守卫，两相对照可以确定是疏漏而非设计。后果：`yankSelection` 明明设了 `visualHead = 选区起点`（Vim 的 `y` 就是把光标留在被复制文本的开头），但因为退出 Visual 时选区还在，落点被改写成 `head - 1`，光标停到了另一端。补上 `!overridden` 即可；`d` 不受影响是因为删除后选区已经塌陷。
- **`3rz` 只替换一个字符**。计数在其他地方都通了，唯独 `r` 没接。新增 `countedCharacterRange`：按字素推进 N 个，行内长度不够时**整个命令不执行**（Vim 就是这个语义，不是"能替几个替几个"）。同时修正落点——Vim 把光标留在**最后一个**被替换的字符上，原实现固定映射 `range.from`。改成从映射后的区间末尾回退一个字素，count=1 时结果与原来完全一致。
- **`3>>` 只缩进一行**。`>`/`<` 连 `pendingCount` 都没有 bank。宿主的缩进命令作用于选区，所以计数的正确表达是把选区临时展开到 N 行、调一次 `onIndent`、再把光标还原到首行第一个非空白字符（Vim 的落点）。已验证对普通行与列表项都正确，超出文档时钳制。
- **行式 `p` 在文件末尾多长出一个空行**（`src/cm6/editor-cm6.ts`）。粘贴到最后一行之后时，代码既保留了寄存器自带的结尾换行、又补了一个前导换行分隔符——但末尾没有下一行来承接那个结尾换行，于是每次 `yy p`/`dd p` 在文件最后一行都留下一个空行。这不是显示问题：它会被**存盘**，然后出现在 git diff 里。修法是把那个换行"花"在分隔符上（末尾追加时去掉一个结尾换行）。文档中部粘贴、`P`、以及本来就以换行结尾的文档三条路径均不受影响，已分别锁定。
- **Normal 模式下嵌入式 `<input>` 里的 Backspace 会真的删字**。`editableNormalCommand` 的非富文本分支用 `key.length === 1` 吞掉可打印键，但 `Backspace`/`Delete` 不是可打印键，于是原样透传给控件。同一函数的富文本分支把 Backspace 当作左移动作——又是两个分支不一致。Normal 模式不该破坏文本，现已吞掉。

### 审计过、确认无缺陷的部分

- **insert 入口变体**：`i`/`I`（首个非空白）/`a`/`A`/`o`/`O` 落点全对，`a` 在行尾进入行尾后一位（Insert 的合法位置）。
- **Escape 语义**：insert → normal 的"左移一格"规则、行首不越界、从 Visual / Visual-line 退出时的落点、连按两次 Escape 不动、`Ctrl+[` 等价 Escape。
- **`r`**：CJK 单字替换、`r` 后接 Escape 静默取消、Visual 模式整段替换。
- **undo/redo**：`u` 与 `Ctrl+R`（大小写皆可）正确往返。
- **fold 与 `/`**：`zc`/`zo`/`za`/`zM`/`zR` 与 `/` 全部正确派发到宿主回调。
- **多光标**：`l`、`x`、`dd`、`3l` 在双光标下均正确；`syncSelectionFromEditor` 对外部选区的采纳与塌陷正确。
- **`s`/`S` avy 跳转**：唯一匹配立即跳转、反向 `S`、无匹配不动、Escape 取消、多匹配时挂起等待标签——全部正确（注意 needle 有 500ms 超时，测试须显式 settle）。
- **公式感知的行操作**：`dd` 在块级公式上删掉整个公式、在已展开的行内公式里只删 TeX 正文（这是 `logicalLineAt` 的既定语义，不是 bug）、`x` 原子删除整个行内公式对象、`D` 与 `J` 与公式共存正确。
- **嵌入式控件守卫**：`data-aaronnote-vim="native"` 的完全退出（连 Escape 都不拦）、Cmd 组合键留给控件、host 之外的目标一律不碰、`.cm-content` 不算"嵌入控件"。

### 新增测试

`tests/vim-editing-commands.test.ts`（31）、`tests/vim-paste-and-jump.test.ts`（15）、`tests/vim-embedded-editables.test.ts`（15）。另外 `o`/`O` 的续行修复（见上一轮）新增了共享的 `markdownContinuationPrefix`，由 `o`/`O` 与 Enter 共用。

---

## 规模与风险

| Phase | 估算 |
|---|---|
| 0 裁剪改名 | 2–4 周（Go 238k→~70k，TS 190k→~90k） |
| 1 Markdown Box | **4–8 周（最高风险）** |
| 2 CM6 接内核 | 3–6 周 |
| 3 Noema 迁 Go | 4–8 周 |
| 4 Tauri 宿主 | 3–5 周 |
| 5 收口对拍 | 3–4 周 |

总计约 **5–7 个月**专注工作量。

**最大风险按序**：
1. Phase 1 的 md 往返保真 —— Spike 1 是 go/no-go 闸门
2. 惰性 IAL 在外部编辑（Emacs/git merge）下的 ID 稳定性
3. mobile 的 66 处非保护跨引用 + 584 处 `ifdef-loader` 指令，迁 Vite 前必须先替换该 loader
4. Phase 3 的双端语法一致性（`.mjs` 与 Go 两份 planning DSL 实现）

**许可**：思源与 Noema 同为 AGPL-3.0，兼容。fork 必须保持 AGPL 并保留 b3log 版权头 + 标注思源出处。


更多开发想法在docs/siyuan-merge-audit-2026-08.md

---

## Phase 6 — 审计 backlog 与独立化终态（2026-08-26，完成）

审计总排序 #1–#13 已逐项收口：host-neutral core、b3、纯函数生产纵切、菜单、CLI、HTML/PDF 导出、完整 portable AV 语义、virtual references、hint、附件维护/正文 FTS5、MCP 与 Obsidian Markdown-native 导入均已进入 canonical 树并有生产或端到端证据；layout/dock 实验在后续单画布复审中撤销并移除，covers、Pandoc bundle、protyle/mobile 及已裁剪云/同步/加密/插件/DAV/OIDC 明确不采用。必要版权与来源保存在 `NOTICE` 和直接改编文件头。

迁移期上游 checkout 已从仓库移除；最终复核时废纸篓中的历史 reference 副本也已不存在。在其完全缺席的状态下完成最终门禁：`make test` 为 206 files passed / 7 skipped、2004 tests passed / 16 skipped；`go test ./...` 全树通过，三个 FTS5 纵切通过；`make build`、`make install` 成功。该次 smoke 中的 workspace layout/docks 结论已由下方 UI 单画布校正取代；仍有效的证据是 `hostMode:desktop`、preload、54px 标题栏、五项系统控制、owned/listening kernel 与 `mcpUrl`。Emacs full-project link、7 个 shared asset links 和小写旧入口规则通过。源码/构建/文档路径扫描无 checkout 依赖，Noema 达到独立终态。

### UI 单画布校正（2026-08-26，当前工作树）

用户否决了上段记录中的 workspace layout/docks 产品方向：App 不应默认出现 tabbar，
也不需要左、右、下三条 dock/card。生产入口现已撤掉 layout iframe、三边 rail 和
Knowledge/Agenda 对正文的尺寸挤压；Window Actions 的 Split 改为新的原生 Noema 窗口
平铺。App 与 Emacs 均直接挂载同一次 `createEditor(host)`，共享同一份
`dist/aaronnote`；两者只保留标题栏/header-line 等宿主适配差异。

B3 自动装饰器原先把所有 `<aside>` 和 `-panel` 后缀都当 raised panel，导致 status
HUD、References、Emacs 顶部区域出现整块异色背景。分类现改为显式 UI surface 白名单；
Meta cover、Properties、planning/TODO 与 References 同时回到透明 Noema 画布和细分隔
语义。`make build` 的依赖关系显式先构建 App/Emacs 共用 renderer，再组装 App；
`make install` 仅安装 App。

Knowledge 的初始化与 Agenda 的 presentation 也已去掉 desktop-only/dock 分支：App 与
Emacs 共享同一套按需浮层，server reader 只保留自身只读适配。聚焦
B3/双宿主/Electron/Knowledge/Agenda 测试 35/35 通过；精确 Node 26.5.0、npm 11.17.0
下正式 `make test` 为 204 files passed / 7 skipped、1996 tests passed / 16 skipped。
新的显式共享构建链 `make build` 已通过：先生成 `dist/aaronnote`，再组装 Electron App
和 Go kernel；`make install` 仅更新 `/Applications/Noema.app` 并成功。

安装版 smoke 返回 `hostMode:desktop`、preload、54px 标题栏与五个规定系统控件；生产
DOM/computed style 进一步证明只有 1 个 editor mount、0 iframe、无 workspace wrapper、
0 persistent dock rails，body/shell 背景均为原 Aaronnote/Noema Midnight 的
`rgb(20, 26, 39)`。status HUD 为透明且不属于 B3 panel，References 也不属于 panel。
Emacs full-project link 与 canonical repository 的 `dist/aaronnote/index.html` inode 相同，
7 个历史 asset links 全部解析到 `resources/`，retired lowercase path 缺席；Emacs
`make jupyter-test` 四组共 141/141 通过。仓库中不再存在迁移期 `reference/` 或
`references/` 目录，Noema 的源码、构建和桌面运行时均不依赖外部 checkout。

**TOC KaTeX 与对齐校正（2026-08-26）**：浮动 Page TOC 和文内 `[toc]` 现在共用
Noema 既有 `renderMathHTML`/宏环境渲染标题及 org-env 标题中的 canonical
`\(...\)`；普通文本只走 text node，公式错误回退原始源码。B3 的通用 button flex
样式曾让 `text-align:left` 失效，TOC 标题与 Org blocks 因而视觉居中；两个控制现显式
使用 `justify-content:flex-start`，标签继续提供 ellipsis。聚焦 TOC/CM6 275/275、
完整 `make test` 1999 passed / 16 skipped，`make build`、`make install` 与安装版 smoke
全部通过；App 和 Emacs 继续消费同一份 `dist/aaronnote`。

TOC 打开动作随后补齐当前位置跟随：根据编辑器 selection 选择最后一个不晚于光标的
标题，仅展开遮住该标题的祖先链，保留其他手动折叠分支，再用 `scrollIntoView` 将 active
项置于目录视口中央；该过程不改变正文 selection，也不抢焦点。两个定位/折叠边界测试
已加入，最终 `make test` 为 2001 passed / 16 skipped，`make build`、`make install` 与
安装版 smoke 再次通过。

### 编辑保存与 idle 热路径收口（2026-08-26，当前工作树）

对照思源原生 block transaction、Node 全文 CAS 与 CM6 `ChangeSet` 后，普通编辑保存已
从“Node 向 Go 预读正文 + stat/read + 全文 CAS”的三次后端往返改为一笔 CM6 composed
change-set + `baseVersion` 的 Go CAS。Go 新增 UTF-16 code-unit 到 UTF-8 byte 的严格
单遍应用器，拒绝 surrogate 中点、越界、乱序、长度不符与 stale version；空内容覆盖
保护也归 Go。成功只返回 mtime/size/version，只有冲突/拒绝才回传当前全文。保存进行中
的新编辑保留为后缀，失败后与 in-flight 前缀重新 compose，坐标空间失效时才回退一次
全文；keepalive、remote/server 与首次无版本文档继续使用兼容全文入口。

Go 提交原语改为直接接收 `[]byte`，不再做 patched bytes → string → bytes 的整篇复制；
增量成功响应不需要 block refs，因此同步路径也不再扫描 Noema projection 或运行 Lute。
解析/SQL/blocktree 进入按文档合并的后台队列，`sql.FlushQueue`/shutdown 仍是严格 barrier，
worker 解析出的 immutable tree 会种回对应 snapshot。4ms 合并窗避免后台解析与下一笔
保存争抢 GC；大文档已有 ChangeSet 时不再等待最长 2.5s 的旧 `requestIdleCallback`，
idle gate 只留给真实全文回退。约 60KB 的单字符请求从 61,644B 降至 287B（214.8x），
512KB 从 524,492B 降至 291B（1802.4x）；Apple M2 Max 上 60KB/128-section 的真实
atomic-write/CAS 响应约 0.39–0.42ms、215.8KB/167 allocs，后台索引不计入响应。

聚焦 TypeScript 41/41、Go incremental/API/FTS5、并发 CAS 与 race 均通过；默认
`go test ./...` 全树通过。精确 Node 26.5.0/npm 11.17.0 下 `make test` 为 205 files
passed / 7 skipped、2005 tests passed / 16 skipped，`make build`、`make install` 与
AGENTS.md 原样 packaged smoke 全过；smoke 报告 desktop/preload、54px、五项标题栏、
owned/listening Go kernel。Emacs full-project link 和 7 个 shared asset links 均解析到
canonical repository/`resources/`，retired lowercase path 缺席，`git diff --check`
干净。终态边界按产品要求明确为单向依赖：Go kernel 自身零 Node 依赖，笔记/编辑/
索引核心数据面只在 Go；Jupyter、Copilot、MCP 可作为独立可选 Node 插件调用 kernel，
其故障不得影响核心编辑。下一步只移除 Node 中剩余的笔记业务实现与兼容转发。

### 编辑打开与 idle 刷新收口（2026-08-26，当前工作树）

继续按“核心 Go、可选 Node 插件单向调用 Go”的边界处理用户最能感知的打开与 idle。
`loadDoc` 新增 source-only 投影：桌面/Emacs provider 明确传 `includeBlocks: false`，Go 从
同一个 immutable snapshot 返回原始 Markdown、SHA-256 version、mtime 和 size，不再为了
一个调用方会丢弃的 `blocks` 先做 Lute 全文解析；Node 也不再额外 `stat` 或重算全文摘要。
兼容/MCP 调用省略该字段时仍默认返回 blocks，原协议未降级。约 60KB/128 段冷打开由
5.66–6.25ms、12.31MB/56.7k allocations 降至 0.104–0.112ms、146KB/133 allocations，
约 50–60 倍；打开正文仍然必须完整交给 CM6，省掉的是重复解析、重复 stat/hash，而
不是引入第二套局部文档状态机。

首屏 `bootstrap` 不再串行等待整库 notes/目录和无人消费的 templates 扫描。snippet 是
编辑器可用契约的一部分：正文与缓存/小型 snippet catalog 并行读取，二者齐备后才安装
CM6，避免首批输入看到空 completion；当前 1450 项真实 catalog 冷扫约 104ms、命中内存
cache 约 0.055ms。App 配置、KaTeX 宏和正文/snippet 也改为并行取得，只在安装正文前等
配置/宏完成；可选 LanguageTool 设置完全退出首屏关键路径。首次空 notes catalog 放到浏览器
idle 窗口执行，但 1.5 秒 deadline 后必须运行，不能被连续输入无限饿死。普通切换笔记不再
无条件重拉 notes list，外部变化继续由 kernel/host watcher 事件失效。增量自动保存的
metadata-only 响应也不再触发全库路径重算、Knowledge Dock、本地图、Agenda、幻灯片和
模式 UI 刷新；只有响应真正携带 notes/note 或 kind 时才刷新对应投影。

Markdown 异步索引 barrier 改为严格的 channel 驱动：普通保存仍保留 4ms idle 合并窗；
搜索、flush、关机等一致性读会立即打断延迟并等待 blocktree/SQL 入队完成。移除了
200µs polling 和“5 秒后放弃一致性”的路径。增量保存仍为 0.404–0.419ms；两项 FTS5
保存/并发 CAS 索引测试连续 20 轮及 race 通过，默认 `go test ./...` 全树通过；精确
Node 26.5.0/npm 11.17.0 的 `make test` 为 205 files passed / 7 skipped、2008 tests
passed / 16 skipped；snippet/启动/索引聚焦组 79/79 通过。

本轮 `make build`、`make install` 与 AGENTS.md 原样 packaged smoke 同样通过；报告为
`hostMode: desktop`、`preload: true`、`titlebarVisible: true`、54px，并包含 Back、
Forward、Refresh、Editor actions、Window actions，Go kernel owned/listening。Emacs
full-project link 与 7 个历史 asset link 仍全部解析到 canonical repository/`resources/`，
retired lowercase path 缺席，smoke 进程树已退出，`git diff --check` 干净。

### Go rich catalog 与 standalone 大文件保存修复（2026-08-26，当前工作树）

用户在 `tests/synthetic_qc_note_5mb.md` 的 Appine 编辑现场暴露了一个能力边界回归：该文件
位于 canonical `NOEMA_ROOT` 外，open 正确标为 standalone，但新 CM6 队列仍无条件发送
ChangeSet；旧 host 只允许 Go-owned 文件增量保存，于是连续返回
`Go kernel incremental Markdown persistence is unavailable`。现在 open/saved 协议显式携带
`incrementalSave`，renderer 只在 host 声明能力后发增量；旧 host/启动过渡期安全回退全文，
不再报 503。新 host 对 standalone 不把约 5MB 正文塞回 JSON，而是在原 per-file save
queue 内按 JavaScript/CM6 原生 UTF-16 坐标严格应用 ChangeSet、校验 SHA-256 baseVersion、
保留空覆盖保护和原子 rename；canonical note root 仍只走 Go CAS，不会静默降级到 Node。
约 5.5MB、emoji/UTF-16、连续两次版本推进与外部修改冲突均有回归测试。

原 idle 后首次 `notes:list` 虽已移出首屏，却仍会让 Node 对全库执行 walk、每文件
stat/read、metadata/refs/backlinks/DOM target 重算，并额外扫描 renderer 不消费的非笔记
files。Go 现新增 `/api/noema/markdown/catalog`：rich row 语义对齐 Node 的
id/title/kind/date/group/source/project/aliases/summary/tags/inlineTags/blocks/refs/backlinks/
roam/domTargets，meta summary、围栏、嵌套 Markdown label、wiki/roam/file refs、CRLF 与
UTF-16 block offset 都有测试。投影挂在 immutable snapshot 上，并以原 cache schema 的
可选字段持久化；升级不会使既有 planning/property cache 整体失效。save/watcher 只重算
变化文件，关系只在内存重连。

Node provider 现在只验证 Go 路径并映射旧 payload；canonical root 的 `notes:list`、
`notes:index`、roam completion/index、Graph、Agenda planning metadata、related Knowledge
和其他 `scanNotes()` 调用都消费 Go catalog。standalone 打开的 sibling catalog 仍保留
Node 兼容扫描。500 篇带 metadata、链接和 DOM target 的同夹具测得：Node 冷 rich scan
约 78.4ms；Go 冷源解析约 24.4ms，进程重启命中持久摘要约 9.1ms，进程内 warm 返回约
0.18ms。此前 Node warm `notesIndexPayload` 仍需约 2.31ms 扫 auxiliary filesystem，这一
往返现从 canonical 编辑 idle 路径移除。

门禁：Go `go test ./...` 全树通过；精确 Node 26.5.0/npm 11.17.0 下 `make test` 为
206 files passed / 7 skipped、2016 tests passed / 16 skipped；`make build` 与
`make install` 成功。安装包 smoke 报告 `hostMode:desktop`、preload、54px、Back/Forward/
Refresh/Editor actions/Window actions、41 workspace tags、102 个 kernel KaTeX macros，
以及 owned/listening Go kernel。Emacs full-project link、7 个 shared asset links 与 retired
lowercase path 规则复核通过，安装包进程树已退出。Node 中尚未迁移的 explicit structured
structured Knowledge query 和 standalone 兼容实现仍是后续反向优化项；canonical virtual-reference
正文扫描已由下节 Go 纵切接管。只读 server reader 继续保留隔离的 Node 实现；
Jupyter/Copilot/MCP/kernel supervisor 按产品要求继续作为可选 Node 插件，不列入删除范围。

### Go workspace projection 性能对比与 Node kernel 去重（2026-08-26，当前工作树）

**原问题与删除判断**：Attribute View 的 canonical 正常路径仍残留一段迁移期混合内核：
Node 先递归 `walk` 全库，对每篇 Markdown 做 `stat + readFile` 并解析 note/planning/property，
随后再用两次 HTTP 分别取得 Go planning nodes 与 property blocks，最后把投影发回 Go evaluator。
Agenda/Todo 也会先拿 rich catalog，再发一次 bulk planning。也就是说 Go 已拥有相同数据时，
Node 仍固定重复文件发现、全文 I/O 和结构解析；kernel 瞬时失败时还会悄悄恢复 canonical
Node parser，使 App/Emacs 实际存在两套核心语义。

**修复思路**：Go 新增只读 `/api/noema/markdown/workspaceProjection`，在同一 box catalog 锁、
同一 persistent cache decode 和同一 per-file stat/snapshot 上一次联结 planning 所需 note metadata、
planning nodes 与可选 UUID property blocks。latency-sensitive note row 不携带 refs/backlinks/DOM/
summary 等 Agenda 不消费的 rich 字段；snapshot 和 schema-1 additive persistent cache 都单独缓存这份
窄投影。首次构建由“一类投影一遍 cache/stat/save”收敛成全类型一遍，进程内完整 map 则直接 clone，
不再碰 persistent JSON 或文件系统。Node provider 只验证 box path、把相对路径映射为绝对路径；旧
`readMany`/`readPropertyBlocks` bulk 方法和“Node 预读全文后以 Go 覆盖”实现已删除。

**可复现基准**：Apple M2 Max，Go `darwin/arm64`，Node `26.5.0`。夹具固定为 500 篇 Markdown，
每篇各含 meta id/title/tags/project、一条 todo 和一个 UUIDv7 property block。旧 Node 命令为
`node scripts/benchmark-node-planning-projection.mjs 500 20`；它走已退休的 walk/stat/read/parse
加既有 JS Attribute View response model，首轮为 cold，随后 20 轮取 OS-warm 分布。Go model 命令为
`go test ./model -run '^$' -bench '^BenchmarkMarkdownWorkspaceProjection$' -benchmem -benchtime=3x -count=5`；
`warm` 是进程内 snapshot/catalog，`restart-persistent` 每轮清进程内 catalog 但保留持久摘要，
`cold-source` 同时删除持久摘要。另用
`go test ./api -run '^$' -bench '^BenchmarkListMarkdownWorkspaceProjectionAPI$' -benchmem -benchtime=5x -count=3`
计入 request decode、response JSON encode 与实际 wire payload。Node 数值含 JS evaluator，而 Go model
数值不含 evaluator，因此真正接近宿主边界的是 Go API 行；所有原始数值仍完整保留，不混称端到端 UI。

| 路径 | 原始结果（500 docs） | 相对旧 Node |
| --- | ---: | ---: |
| 旧 Node cold | 55.797ms | baseline |
| 旧 Node OS-warm | min 27.890ms / median 28.577ms / p95 35.635ms | baseline |
| Go model warm，5 次样本 | 0.058945 / 0.063806 / 0.059681 / 0.060722 / 0.065500ms | median 约 470.6x faster |
| Go restart-persistent，5 次样本 | 9.186 / 9.030 / 8.985 / 9.036 / 9.289ms | median 比 Node warm 约 3.16x、比 Node cold 约 6.17x faster |
| Go cold-source，5 次样本 | 20.688 / 20.709 / 19.441 / 19.499 / 19.910ms | median 比 Node cold 约 2.80x faster |
| Go warm API（含 JSON） | 0.998–1.032ms，510,830 wire bytes，约 1.38MB/op、6043 allocs | 比 Node warm median 约 27.7x faster |

**Node kernel 删除边界**：local App/Emacs configure 现在显式 `requireGoCore`；shared host 在 Go 首次
`listening` 且 external Markdown box 注册完成前不开始监听。canonical root 的 Markdown open/save/
catalog、planning/property projection、Agenda evaluator 与 Attribute View evaluator 缺能力或请求失败时
统一 503/fail closed，不再落回 Node 业务内核。保留的 JS note/planning parser 只服务两个不与 Go box
重叠的边界：只读 server reader，以及 canonical note root 外的 standalone sibling/edit compatibility。
`web-host.mjs`、narrow provider、kernel supervisor 仍必须保留，因为它们是 App/Emacs 共用的协议宿主和
Go 生命周期所有者；Jupyter/Copilot/MCP 继续作为独立 Node 插件。structured Knowledge 与 explicit
virtual-reference 扫描尚无等价 Go structured API，仍列入下一阶段迁移，而不是伪装成已删除或擅自砍掉功能。

**本阶段最终门禁（2026-08-26）**：Go `go test ./...` 全树通过；kernel supervisor、Markdown
provider、planning provider、strict canonical boundary、standalone compatibility、Agenda/Attribute
View 聚焦组为 6 files / 46 tests 全绿。精确 Node 26.5.0/npm 11.17.0 的 `make test` 最终为
206 files passed / 7 skipped、2018 tests passed / 16 skipped；`make build` 与 `make install` 均成功，
4015-module renderer、Go kernel 和 Electron shell 已重建并更新 `/Applications/Noema.app`。AGENTS.md
原样 packaged smoke 报告 `hostMode:desktop`、`preload:true`、`titlebarVisible:true`、54px、Back/
Forward/Refresh/Editor actions/Window actions、102 个 `kernel-katex-macros` 与 owned/listening Go kernel
全绿，退出前 supervisor 正常关闭窗口与宿主。Emacs full-project link 指向 canonical repository，
Markdown/TeX snippets、Noema/LaTeX/TeX templates、KaTeX macros 与 accepted-words 共 7 个历史链接
全部解析到 `resources/`，retired lowercase project path 缺席。排除用户正在维护且早已记录的
`tests/synthetic_qc_note_5mb.md` 尾随空格后，本阶段 `git diff --check` 干净。

### Go virtual references 与 Node 全库正文扫描去重（2026-08-26，当前工作树）

**原问题**：Knowledge Dock 打开 Mentions 时，local App/Emacs 虽已拿到 Go rich catalog，Node 仍会
截取最多 5000 篇 note，对每篇重新 `stat + readFile`（单篇最多 8MB、总计最多 64MB），再在 JS
清理 frontmatter/fence/inline code/link、为全库所有标题与别名编译 Aho–Corasick，最后只取当前
target 的一项结果。10 分钟 cache 或 catalog generation 失效后重复整套 I/O/扫描；这是 canonical
Go box 内最后一条明显的 Node 全文读取内核。

**Go 修复与删除边界**：新增只读 `/api/noema/markdown/virtualReferences`。Go 为 virtual reference
单独保存 narrow id/title/path/source/aliases/refs metadata，snapshot 与 schema-1 additive persistent
cache 共享源身份；首次不再被迫构造 summary/DOM targets/blocks/backlinks。refs 在 Go 内按 rich
catalog 同一 canonical reference 规则解析。扫描只为当前 target 的无歧义标题/别名编译 matcher，
仍保持 NFC、case sensitivity、Unicode word boundary、重叠计数、snippet、self/linked/ambiguous
排除与 5000 docs / 8MB each / 64MB total 界限。结果按 target/case 放入 16-entry、10 分钟 LRU，
save/watcher/catalog generation 变化立即精确失效。常见无 fence/code/link 的 prose 先检查 literal
opener，避免 Go regexp 对不可能命中的文档做三次完整 backtracking pass。

local `web-host.mjs` 现在只调用 Go provider；endpoint 缺失统一 503，不再取得 knowledge index 后交给
Node scanner。provider 不信任 Go absolute path：target 做 canonical box 校验，mention 只转发验证过的
relative Markdown path。renderer 本来就按 sourceId 从已加载 catalog 解析 note，因此 Go 响应不再为
每个 mention 重复编码整份 rich note row。Node `server/lib/virtual-references.mjs` 仅保留给隔离的只读
server reader，不属于 App/Emacs canonical kernel，也没有删除 server 功能。

**可复现基准**：Apple M2 Max，Go `darwin/arm64`，Node 26.5.0；500 篇 Markdown，每篇 title + alias，
499 篇各出现目标 title/alias 64 次。旧 Node 命令：
`node scripts/benchmark-node-virtual-references.mjs 500 10 30`。它预先持有 index，但每个 cold round
清结果 cache，仍重新 stat/read/clean/scan 全库；warm 是其 structuredClone cache。Go 命令：
`go test ./model -run '^$' -bench '^BenchmarkMarkdownVirtualReferences$' -benchmem -benchtime=3x -count=5`；
`cold-target-scan` 只清 target result、保留同进程 snapshot/catalog，`restart-persistent` 同时清内存
catalog/snapshot，`cold-source` 再删除持久窄 metadata。API 命令：
`go test ./api -run '^$' -bench '^BenchmarkListMarkdownVirtualReferencesAPI$' -benchmem -benchtime=5x -count=3`，
包含 request decode、完整 response JSON encode 与 wire bytes。Node cold 不含 index 构造，因此不拿它
与 Go `cold-source` 做伪端到端倍率。

| 路径 | 原始结果（500 docs / 499 mention sources） | 对比 |
| --- | ---: | ---: |
| 旧 Node cache-cold，10 次 | 50.411 / 42.241 / 35.412 / 41.411 / 38.577 / 39.951 / 39.029 / 33.661 / 33.975 / 34.877ms；median 39.029ms | baseline |
| 旧 Node warm | min 0.698ms / median 0.767ms / p95 0.906ms | baseline |
| Go cold-target-scan，5 次 | 24.456 / 24.511 / 24.542 / 25.187 / 24.547ms；约 13.1MB、17,129–17,140 allocs | median 1.59x faster；Go 最慢仍比 Node 最快约 1.34x faster |
| Go warm-target，5 次 | 0.019778 / 0.018695 / 0.028653 / 0.023278 / 0.021875ms；73,856B、506 allocs | median 约 35.1x faster |
| Go restart-persistent，5 次 | 41.842 / 39.830 / 41.164 / 41.977 / 41.655ms | 包含窄 catalog + snapshot 重建；落在 Node cold 分布内 |
| Go cold-source，5 次 | 67.240 / 68.097 / 67.871 / 66.976 / 67.697ms | 同时构建持久 metadata；Node 行未包含对应 index 构造，不宣称倍率 |
| Go warm API（含 JSON） | 0.261–0.311ms，median 0.284ms；210,453 wire bytes、约 508KB/op、547 allocs | 即使计入 HTTP JSON 仍比 Node warm function median 约 2.70x faster |

**收尾门禁**：virtual-reference 语义/model/API/provider/路径逃逸/Knowledge Dock 聚焦组为
5 files / 27 tests 全通过，`go test ./...` 全通过；完整 `make test` 为 206 files passed、7 skipped，
2020 tests passed、16 skipped。`make build` 与 `make install` 均成功，安装后的
`NOEMA_DESKTOP_SMOKE=1 /Applications/Noema.app/Contents/MacOS/Electron` 报告
`hostMode: "desktop"`、`preload: true`、`titlebarVisible: true`、54px title bar、Back/Forward/Refresh/
Editor actions/Window actions 全部存在，Go kernel 为 `listening`，并正常 beforeQuit/windowClosed。
Emacs full-project link 与 7 个 shared asset links 全部指向当前仓库/`resources/`，retired lowercase
`lisp/roam/aaronnote` 缺席。排除用户已有的 `tests/synthetic_qc_note_5mb.md:2982` 尾随空格后，
`git diff --check` 干净。按用户要求，本波到此暂停，不继续展开 structured Knowledge query。

**暂停后的性能待办（不在本波实施）**：

- 将 structured Knowledge 的 `tag/title/repo/namespace/path/kind/linksto/is` 过滤、related ranking、
  facets 与 typo suggestion 逐项翻译为 Go；先建立 shared fixtures 与 Node/Go differential benchmark，
  等所有查询语义和排序完全对齐后再删除 local Node evaluator。普通 lexical query 已走 Go FTS5，
  不重复迁移。
- 复核 note root 外 standalone sibling/edit compatibility 是否值得做独立 Go transient box；只有能在
  不污染 canonical box registry、且 5MB 编辑/打开基准明确获益时才迁移。只读 server reader 可长期
  保留 Node，不把部署场景误算为 desktop kernel 重叠。
- virtual references 若未来 workspace 超过当前 64MB 扫描上限，再评估按 snapshot generation 维护
  per-document normalized prose/token cache，避免扩大上限后线性复制；先以真实大库 profile 为准，
  不提前增加另一套索引状态。

---

## Emacs xwidget 专项：剪贴板与拖选卡顿（2026-08-28，当前工作树）

用户报告两件事：Noema 里复制/粘贴根本进不到系统剪贴板（"点击 copy 按钮都没反应"），
以及鼠标拖选正文文字时非常容易卡死。剪切键位维持现状——Cmd+X 仍然是 Emacs 的 `M-x`，
这是用户明确保留的决定，本轮没有改。

### 根因一：macOS xwidget 根本无法回放 Emacs 按键

`xwidget-webkit-pass-command-event` 在 GTK 之外没有实现。对 Emacs 31 的这份
`--with-ns --with-xwidgets` 构建做 `nm`，只有
`nsxwidget_{init,init_view,resize,webkit_execute_script,webkit_goto_uri,...}`，
**没有 `nsxwidget_perform_lispy_event`**。所以 `init-browser.el` 里绑到该命令的每个键
（`M-c`/`M-v` 在内）在 xwidget buffer 中都被 Emacs 吞掉且什么都不做：当 Emacs 持有键位时，
复制和粘贴根本不会发生。

`emacs/noema-xwidget-keys.el` 因此改为把 `M-c`/`M-v` 路由到 Noema 自己的 `copy`/`paste`
命令（与既有 `M-z`→undo 同一条通道），由页面执行复制、经 web host 的 pasteboard 通路落盘。
键位安装抽成 `my/noema--install-xwidget-keys`，并额外挂在 `xwidget-webkit-mode-hook` 上——
通用浏览器配置也在抢同一批键，两个 `with-eval-after-load 'xwidget` 之间没有确定顺序。
非 Noema 页面的回退路径未改动。

### 根因二：页面内的剪贴板写入在 WKWebView 里一律被拒

`navigator.clipboard.writeText` 与 `execCommand("copy")` 都需要 transient user activation，
而 Emacs 拥有的这个 WKWebView 经常没有：Emacs 转发的键、已经 await 过的工具栏命令、
没有自己 DOM 事件的 Vim yank，全部落空且静默失败。原先 `main.ts`、`fenced-code.ts`、
`commands/index.ts`、`vim-lite.ts` 各写了一份"先 clipboard API 再 textarea+execCommand"的
回退，四份都在这个宿主下失效——这正是"点击 copy 按钮没反应"。

新增 `src/system-clipboard.ts` 作为唯一出口：默认仍是浏览器路径，宿主可以注册一个 writer。
`aaronnote/host-clipboard.ts` 只在 `hostMode() === "emacs"` 时注册，走已有的
`POST /api/clipboard`（web host 里的 `pbcopy`）。Electron 与只读 server host 不注册，保持原生
剪贴板不被降级成纯文本。装了 writer 时两条路都跑，但对外报告的成功与否以宿主那条为准——
用户能从别的应用观察到的就是它。

粘贴侧补上另一半：`pasteDataTransfer` 过去在 DataTransfer 为空时直接放弃。WKWebView 恰恰会
派发 paste 事件却不把 pasteboard 暴露给页面，于是 Cmd+V 什么都不做。现在空事件会退到
`readSystemClipboardFallback`（`pngpaste`/`pbpaste`），与显式 paste 命令同一条路。

CM6 侧新增 `src/cm6/copied-text.ts`（复刻 CodeMirror 自己的 copiedRange 规则：非空区间用行分隔
拼接，全空则按行去重复制光标所在行），并在 `editor-cm6.ts` 的 `copy`/`cut` DOM 事件上做镜像——
仅在宿主注册了 writer 时才写，避免在 Chromium 里用纯文本覆盖浏览器更丰富的 flavor。

### 根因三：拖选时按帧重算整段选区

拖选正文卡死的实际来源有两处按帧执行的无界工作：

- `writing-stats` 控制器在选区变化后 80ms 重算一次，`updateNow` 对选区调用同步的
  `countWritingStats(from, to)`。文档尺度早就走 idle 分块了，选区尺度没有：在几 MB 的笔记上
  拖选，等于每 80ms 同步扫描几 MB，而结果又被下一个拖动事件丢弃。现在选区与 subtree 走和
  文档同一套尺寸规则（`renderLargeDocumentScopes` + `scanRange`，epoch 可取消）；顺带
  把 subtree cache 的命中检查补进大文档路径——之前那条路只写不读。
- `activeEditorSelection()` 为了给浮动工具栏定位，每次 `selectionchange` 都
  `editor.textBetween(from, to)` materialize 整个选区。定位只需要 rect，文本改成 thunk，
  由真正需要它的命令调用；空白选区的判断保留，但只在选区 ≤4096 字符时才做那次读取。
  另外拖动进行中不再更新工具栏（`isPointerSelecting`），`mouseup` 负责最后一次，
  与 `live-preview.ts` 已有的做法一致。

### 验收

- 新增 `tests/system-clipboard.test.ts`（11 项）覆盖 copiedText 三种形态、host writer 优先级与
  失败上报、`installHostClipboard` 的宿主门槛、空 DataTransfer 回退；
  `tests/writing-stats-controller.test.ts` 新增大选区分块回归（已确认在修复前失败）。
- 真实浏览器端到端（`AARONNOTE_HOST_MODE=emacs` 的 web host + Chrome，
  把 `navigator.clipboard.writeText` 改为 reject、`document.execCommand` 改为返回 false，
  复现 WKWebView 的限制）：`copy` 命令、选区工具栏 Copy 按钮、原生 `copy` 事件镜像三条路都写进了
  macOS pasteboard；`paste` 命令与空 DataTransfer 的 paste 事件都把系统剪贴板内容插进了正文。
  `POST /api/clipboard` 单独用 curl 验证过 204 与中文/emoji 往返。
- `make test` 口径：`npm test` 210 files passed / 7 skipped、2062 tests passed / 16 skipped，
  唯一失败的 `tests/renderer-build-watch.test.ts` 单跑通过，是该用例 5ms sleep 在满载下的既有抖动。
  `npm run build:aaronnote`（含 `tsc`）通过。

### 本轮未做

- Cmd+X 仍转发为 Emacs `M-x`，页面内没有剪切键位；`cut` 命令已具备，等用户决定绑哪个键。
- Emacs 侧 `remote-gateway-request-sync` 的 8 秒阻塞 + roam-cli.mjs 兜底进程仍在。用户本轮把卡死
  归因于鼠标拖选，所以没有动这条路；如果之后 minibuffer 选择也卡，这里是下一个目标。
