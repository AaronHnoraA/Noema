# Noema × SiYuan 重构计划

> **⚠️ 2026-08-25 起，Go 内核代码位置变了**：`/Users/hc/HC/SOURCE/Noema/kernel/`（Noema 主仓库、`main` 分支），不再是 `reference/siyuan/kernel`。`app/appearance/`、`app/stage/auth.html` 作为 `kernel/` 的同级目录一起搬过来了（内核自己的相对路径和一些既有测试都假设这个同级关系）。`reference/siyuan` 还留着，保留完整的逐次 commit 历史，但不再是活跃开发的位置。详见下面 Phase 0 进度记录里的说明。

## 工作方式约定（Aaron 明确要求，持久化在这里，不要只留在对话里）

- **本文件（`/Users/hc/HC/SOURCE/Noema/plan.md`）是唯一权威、活的进度记录**，不是快照。每做完一步就更新一步（"每做一步更新一步"）——不要攒到一个大总结再补，也不要让它变成开工前那一版一次性快照后就再也不碰。
- **代码要展开进项目结构，不能只放在 `reference/` 里当参考**（"不要单单把思源代码放进 reference 里面了，而是作为项目结构展开进项目"）。`reference/siyuan` 只是原始 SiYuan checkout + fork 过程的逐次 commit 历史，不是终点。
- **搬迁方式是增量的，不是一次性大搬家**（"一点点写一点点挪"）：只把已经实际动过、验证过的部分从 `reference/siyuan` 搬进项目正式结构（目前是 `kernel/` + `app/appearance/` + `app/stage/auth.html`）；`app/pandoc/`（168MB，内核能容忍它不存在）、`app/appearance/covers/`（19MB，装饰性封面图，没有功能依赖它）、整个 `app/` 里还没碰过的 protyle/mobile 前端，都刻意留在 `reference/siyuan`，等真正开始动那部分工作时再搬，不要提前搬进来占地方。
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
- TOC 仍是原 floating popover；Page/stats 双击打开 Knowledge dock。桌面 smoke 已在 build bundle 上验证 preload、54px titlebar、五项标题栏控制、TOC、双击 Knowledge dock、八视图 Agenda、KaTeX macros 与 shared Node-owned Go kernel。正式 `make test/build/install` 与安装包 smoke 结果在清理完成后追加。

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

- **Go 侧不是搬代码，是给休眠子系统接线。** `kernel/` 与 `reference/siyuan/kernel` 只差 54 个路径，21.4 万行 Go 已经在工作树里且能编译；Phase 0 裁剪也早已完成（fork 历史 `baeb38bfc`..`b3fb59d39`，74 文件 / 30,609 行）。`kernel/cli/`(6,084)、`kernel/mcp/`(12,292)、`model/virutalref.go` 等都躺着没有任何 Noema 代码调用。
- **前端 protyle 耦合被高估。** 外部对 `protyle/*` 的 ~370 处 import 集中在四个非 contenteditable 的工具文件（`util/compatibility` 95、`util/hasClosest` 62、`ui/hideElements` 26、`util/hotKey` 8）；另外 `wysiwyg/transaction.ts:2071` 的 `transaction()` 已支持 `protyle === null` 退化成纯 REST POST，这把 `render/av/` 的 24,849 行从"不可分离"重新归类为"可用 12 字段 shim 抠出"。

研判里还有三条与本文档既有决策冲突、需要单独拍板的点（前端插件系统、文档历史 vs git、covers 19MB 的落点），见该文档第六节。

**kernel CLI 对 markdown box 可用（2026-08-25，当前工作树）**：研判把 `kernel/cli/` 列为"已在树里、路线图完全遗漏、对 Emacs 宿主是天然接口"，实测后发现它对 markdown box 基本不可用，两个缺口都是**静默失败**：

1. **任务队列在 CLI 下没有消费者。** `Box.Index()` 把 `removeBoxRefs`/`indexBox`/`IndexRefs` 全部走 `task.AppendTask`，而队列消费者 `ExecTaskJob` 只在 serve 的 `job.StartCron()` 下运行。CLI 是单次命令进程，从不启动 cron，于是索引永远不建立，随后 `search`/`sql`/`ref`/`outline` 只回一句 "No results found"，没有任何错误。`root.go` 的 `PersistentPostRunE` 原本已经处理了 SQL 队列并写明意图是"保证写完即可搜索"，只是漏了任务队列这一层。新增 `task.ExecSyncTasksUntilEmpty(timeout)`：循环 `popTask`+`execTask` 直到队列空，`popTask` 本身跳过异步任务（PushMsg 之类是给长驻 UI 的，一次性命令不该为其 Delay 阻塞），并带整体预算防止任务反复重新入队把 CLI 挂死。接在 `FlushTxQueue`/`FlushQueue` **之前**，因为索引任务正是往 SQL 队列写数据的那一方。
2. **`document list` 对 markdown box 恒为空。** 它走 `ListDocTree`，那是 `.sy` 的 `<parentID>/<childID>` 嵌套文档树概念（§1.4 明确延后、至今未动）。改成按 box kind 分流到已有的 `ListMarkdownDocs`——与 CM6 文档浏览器同一个数据源，不新写遍历逻辑。`.sy` 分支一字未动。

实测（隔离 workspace + 14 篇真实笔记的副本，绝不碰 `~/Documents/Noema` 原件）：修复前 `blocks` 表 0 行、`search` 无结果；修复后 `notebook open` 1.5 秒建出 124 个块，`search "Hilbert"` 与中文 `search "量子"` 都正确命中并带 `<mark>` 高亮（验证 CJK tokenizer 在 CLI 路径同样生效），`document list` 列出全部 14 篇。三轮 `shasum` 比对确认源文件字节自始至终未变。新增 `kernel/task/queue_test.go` 5 个用例：锁定"无消费者时入队任务不执行"这个前提本身、排空按入队顺序执行、跟进任务执行中新入队的任务（真实索引路径的形状）、跳过异步任务且不为其 Delay 阻塞、超预算安全退出。`go build ./...`、`go vet`、`task`/`cli`/`noema`/`filesys`/`treenode` 测试全过。

顺带抓到一个与本次改动无关的真实泄漏：桌面版 kernel workspace 里累积了 8 个 shadow box，其中 7 个的 `root` 指向已被删除的 `/private/tmp/noema-*` packaged smoke 目录。`RegisterExternalMarkdownBox` 按 repository 建 shadow，但没有任何机制回收 root 已消失的陈旧条目——每跑一次 packaged smoke 就多留一个。已记录，未擅自清理。

### 为什么必须删 protyle

protyle 无客户端文档模型：`onGet.ts:289` 直接 `wysiwyg.element.innerHTML = content`（内核返回的 HTML 字符串），编辑经 `wysiwyg/keydown.ts` 翻译成 `IOperation`（`data` = 块 `outerHTML`）→ `POST /api/transactions` → 内核回传权威 HTML → `transaction.ts:654 onTransaction()` 逐块 `outerHTML =`。整条链路依赖 `.sy` 块树和 lute WASM。

md 为真相源后这条链路没有落点，且 Noema 不变量 #1（markdown 源偏移 = 稳定坐标系）会消失 —— `vim-lite.ts`、`structural-jump.ts`、`vim-jump.ts`、`text-boundaries.ts`、`xwidget-key-guard.ts` 全部建立其上。CM6 缺的块模型是**加法**（widget + 语法层），可以补；protyle 缺的文本坐标系是**减法**，补不回来。

---

## 目标仓库结构

以 `reference/siyuan` 为新仓库底座，Noema 代码删改进去：

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

`reference/siyuan/kernel/filesys/tree.go` 是**唯一**读写 `.sy` 字节的地方：
- `LoadTree(boxID, p, luteEngine)` @ `:217` → `parseJSON2Tree` @ `:618`
- `WriteTree(tree)` @ `:378` → `prepareWriteTree` @ `:446`（`render.NewJSONRenderer` + mmap 写）

改造：引入 box kind（`sy` / `markdown`），在这两个函数分派。markdown box：
- 读：`.md` bytes → `lute.Md2Tree`（Noema 定制 engine）→ tree
- 写：Noema `FormatRenderer`（kramdown-IAL markdown）→ `.md`

参考 `kernel/util/lute.go`：`NewLute()` @ `:57` 已有 `SetKramdownIAL(true)`、`SetBlockRef(true)`、`SetTag(true)`、`SetSuperBlock(true)`；新建 `NewNoemaLute()` 在此基础上开 `YamlFrontMatter`/`Footnotes` 并注册 Noema 语法扩展。

`.sy` 字面量清理：全库 ~150 处硬编码（`model/file.go` ~15、`import.go` ~10、`export.go` ~6、`path.go`、`box.go`、`index.go`、`heading.go`、`listitem.go`、`filetree.go`、`server/serve.go:1425`、`treenode/tree.go:64`、`util/working.go:558`）→ 抽成 box-kind 感知的 helper。机械改动。**尚未做**（下面已完成的是读写接缝本身，不是这批调用点清理）。

**进度（2026-08-24，commit `f4c174c83`）**：读写接缝已落地，比预想的更省事——不需要新建 `NewNoemaLute()`：`util.NewLute()` 已经开了 `KramdownIAL`/`TextMark`/`GFMTable`（`parse.NewOptions()` 默认 true），够用。也不需要一个专门的 `Md2Tree`：`parse.Parse(name, markdown, luteEngine.ParseOptions)` 就是这个原语，`render.NewFormatRenderer(tree, ...).Render()` 就是反向的，两者早就在 `filesys/tree.go` 的 import 里了。落地方式：
- `conf.BoxConf` 加 `Kind` 字段（`""`/`"sy"` 默认、`"markdown"`），常量 `conf.BoxKindSy`/`conf.BoxKindMarkdown`。
- `filesys/box_kind_hook.go`：`BoxKindProvider func(boxID string) string`，model 层 init 注入（`model.GetBoxKind`），与 `DEKProvider` 同一套"回调注入避免循环依赖"手法。
- `filesys/tree.go`：`LoadTreeWithFix`/`WriteTree` 顶部按 box kind 分派到新的 `loadMarkdownTree`/`writeMarkdownTree`（+`prepareWriteMarkdownTree`），彻底跳过 `.sy` 专属的 JSON 订正 (`fixTreeJSONData`)、加密租约、rootID 前置缓存这些机制——markdown box 目前总是读盘重新解析，没有接现有缓存层（缓存层假设"parse 前就知道 ID"，markdown box 恰恰是"parse 后才知道 ID"，接缓存是后续性能优化，非本次范围）。
- 树 ID 恢复：不需要自己写逻辑——lute 的 `parse.IALStart`（`inline_attribute_list.go:37`）在识别到文档级 `{: id=... type="doc"}` 时已经直接 `t.Root.ID = ial[0][1]; t.ID = t.Root.ID`；缺失时 `finalParseBlockIAL` 兜底分配新 ID。两条路径都验证了：首次解析赋新 ID，之后每次重新解析同一文件都拿到同一个 ID（幂等，见 Spike 1）。
- 已写 3 组测试（`filesys/tree_markdown_test.go`）覆盖：markdown box 落盘的确是文本不是 JSON、私有语法字节保真、ID 跨读写稳定、二次读回再写字节不变（幂等）、sy box 行为未受影响。
- 用 baseline worktree 比对确认零回归（6 个失败测试——Obsidian 导入分析器 + MIME 类型环境相关——在 Phase 0 末尾的 commit 上就已经失败，与本次改动无关）。

**同一批顺带做掉的 §1.3 修复（commit `55af9476e`）**：Spike 1 发现的"列表结尾 + `#+end` 无空行分隔"重缩进 bug，已用 `filesys/markdown_orgenv.go` 的 `normalizeOrgEndBlankLines` 解决——不是补丁 lute，而是在 `parse.Parse` 之前对原始字节做一次针对性的空行插入（已用 spike 脚本验证空行能可靠阻断 CommonMark 懒续行）。**范围收窄到真正有风险的场景**：只在 `#+end` 前一行是列表项或列表续行时插入空行；纯段落场景虽然理论上也会被"懒解析"进同一个段落节点，但 `FormatRenderer` 不会给段落续行加缩进，字节其实不受影响，插入空行反而会制造多余的一次性 diff——所以特意不碰。同时对围栏代码块内容免疫（不误改代码示例里字面的 `#+end xxx` 文本），并且能自愈磁盘上已经被旧内核写坏的历史文件。3 组测试覆盖：列表场景修复、围栏代码块豁免、已损坏文件自愈。

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

### 1.4 路径模型简化

markdown box 用真实文件名，不用 `<parentID>/<childID>.sy`：
- `Path` = 相对路径 `/subdir/note.md`
- `HPath` = 同构（不再需要 `filesys/tree.go:235-296 LoadTreeByData` 逐级打开父 `.sy` 读 title IAL）

改 `model/path.go` + `model/file.go` 的文档树导航。改名 = 文件改名 + 链接重写（Noema 现有逻辑照搬）。

**进度（2026-08-24）：尚未开始，明确延后。** 当前 `filesys.loadMarkdownTree` 已经做到 `Path` = 真实相对路径（不是 `<id>.sy`），但 `HPath` 只是"去掉扩展名的路径"占位符，还没有第 154 行说的目录标题语义；`model/path.go`（`createDocsByHPath` 等）、`model/file.go`（3039 行，文档树的创建/改名/移动）都还是彻头彻尾的 `.sy` 嵌套 ID 目录模型，完全没碰。判断：这批工作要等 Phase 2 CM6 接内核时才有真实的创建/改名/移动调用点来验证对不对，现在做是纸上谈兵——先做的这几项（读写接缝、索引管线、外部 watcher）已经让 markdown box 能被完整地读、写、增量重索引，够支撑 Phase 2 起步。`mount.go` 里挂载 markdown box 时已经绕开了 `EnsureBoxDoc`/`ListDocTree` 这两个 `.sy` 专属调用（见 §1.5 进度记录），没有留下会崩的坑，只是功能未实现。

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

**第一次真正碰 CM6（2026-08-25，Noema 主仓库 commit `c3d6639`，不是 `reference/siyuan`）**：加了一个完全独立的 Vite 入口 `aaronnote/markdown-box-lab.html`/`markdown-box-lab-main.ts`——用 `src/editor-api.ts` 的 `createEditor()`（生产环境同一个门面，手感真实）挂编辑器，直接 `fetch()` 调 Go 内核的 `loadDoc`/`saveDoc`，完全绕开 `aaronnote/api-client.ts`/`window.aaronnoteApi`（那是现有 Node 后端的通道桥，和新内核是两回事）。不碰 `aaronnote/main.ts`（10,731 行的生产编辑器壳）一个字。在真实 Chrome 里全流程验证过：起内核（`-tags fts5`）+ 起 `start:vite`、真的在浏览器里往编辑器打字、看到自动保存、看到服务端分配的文档 ID 实时同步回编辑器（`setMarkdown(..., {preserveView: true})`，光标不跳）、磁盘文件和浏览器显示的字节完全一致、刷新页面冷加载回来内容和 ID 都不变。这是这次会话第一次真正过 CLAUDE.md 要求的浏览器验证（之前全部止于 `go test`/`curl`）。

**动手时抓到一个严重 bug（不是这次新引入的，是 Phase 1 索引管线那次提交里就带着的）**：`util.NewLute()` 开着 `SetProtyleWYSIWYG(true)`，导致 lute 给源文本里**没有**显式 `{: id=...}` 的每一个块，每次解析都现场发一个**只存在于内存里、不落盘**的临时 ID（用测试直接验证过：文件字节两次解析前后完全不变）。`treenode.UpsertBlockTree`/`IndexBlockTree` 只看 `n.ID` 是否非空就当真实块索引进去——由于这个临时 ID 每次都不一样，每次重索引都会插入一批新垃圾行，上一批因为 ID 对不上永远清不掉。写了个回归测试复现：同一份没有任何引用的内容反复索引 5 次，blocktree 行数 7→13→19→25→31，线性增长、无界膨胀。修法是 `filesys.StripEphemeralMarkdownBlockIDs`，在 `WriteTree` **之后**（不能在之前——FormatRenderer 依赖这些临时 ID 的存在来决定某些块类型后面要不要多空一行，清早了会导致重复保存时字节漂移，也是测试踩出来的）清掉没有真实持久化 IAL 的块 ID，接在 `upsertIndexes`、`indexBox`、`LoadMarkdownDoc` 三个消费点。这类 bug 光靠代码审查很难发现，是"写一个会因为这个 bug 而失败的测试"这个习惯直接抓到的。

**内核 restructure：kernel/ 展开进主仓库（2026-08-25，Noema 主仓库 commit `d11dfe7`）**：见文件顶部的位置变更提示和"工作方式约定"一节。`kernel/`（8.1M）+ `app/appearance/`（18M，语言包/主题/字体/emoji）+ `app/stage/auth.html`（access-code 登录页，几个既有内核测试直接依赖它）搬进了 Noema 主仓库、`main` 分支。踩过一次坑：一开始把 `appearance/` 嵌到 `kernel/` 里面（`kernel/appearance/`），导致 `TestCustomFontLifecycle` 等测试报错——它们硬编码相对路径 `../../app/...`，假设 `kernel/` 和 `app/` 是**同级**目录（跟 SiYuan 上游自己的仓库布局、以及本计划"目标仓库结构"一节写的一样）。改成同级后全部恢复，`go build`/`go vet`/`go test`（新位置，同一套 6 个既有失败基线）、`-tags fts5` 二进制真机 boot + curl 全部重新跑过一遍确认。`app/pandoc/`、`app/appearance/covers/`、`app/` 里还没碰的 protyle/mobile 前端，按"一点点挪"原则明确不搬，留在 `reference/siyuan`。

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

**这两个 widget 之后，Phase 2 "CM6 侧新增" 清单里明确还没做的**：`#+begin av`（属性视图渲染，依赖 Spike 2 定的 protyle-shim 适配层，工作量最大）、`#+begin embed`（走 `/api/search/searchEmbedBlock`）、反链/大纲/图谱面板（依赖 `model/backlink.go`/`outline.go`/`graph.go` 这几个内核 API，目前 Go 侧本身可能都还没针对 markdown box 验证过）。这三个里任何一个都比这次的两个 widget 大一截，需要单独排。

**反链/大纲/图谱三个内核 API 逐一在真内核上验证过（2026-08-25）**：Aaron 要求先确认这几个 API 对 markdown box 到底能不能用，再决定要不要接 UI。结果：

- **大纲（`getDocOutline`）：开箱可用**，但意义不大——它给没有持久化 ID 的标题现场发一个临时 ID 用于定位，这件事 CM6 自己的 `toc-index.ts` 已经从当前打开文档的 markdown 正文里免费拿到（标题文本 + 层级），不需要往返内核。大纲面板**大概率不需要接内核**，除非以后要做"跨文档大纲"这种 CM6 单文档视角看不到的东西。
- **反链（`getBacklink`/`getBacklink2`）：发现并修了两个真实 bug，两个都不报错，都是安安静静返回空结果**，属于这类会话里反复出现的那种"测出来才发现，代码审查看不出来"的问题——写了一个会因为它们失败的回归测试（`model/backlink_markdown_fts5_test.go`）：
  1. `treenode.GetBlockRef`（`treenode/node.go`）只读 `n.TextMarkBlockRefID`/`TextMarkTextContent`——这是 lute 把 `((id "text"))` 拍平成 `NodeTextMark` 之后（`parse.NestedInlines2FlattedSpansHybrid`，protyle/`.sy` 那条流水线专用）才有的字段。Noema markdown box 读盘走的是原生 `parse.Parse`（§1.1 定的，理由是不想在内核里重新实现一遍 Lezer 的语法层），**从来没跑过这趟拍平**，所以拿到的是未拍平的 `ast.NodeBlockRef`，真正的 ID/锚文本挂在 `NodeBlockRefID`/`NodeBlockRefText` 子节点上。`GetBlockRef` 对这个节点形状完全没有处理，永远返回空——上游 `sql.buildRef` 因此拿到空 `DefBlockID`，直接被 `sql.insertBlockRefs` 的非空校验挡在插库之前，这条 ref 从来没进过数据库。修法照抄 lute 自己 `render/protyle_renderer.go: renderBlockRef` 处理同一种节点形状的方式（`idNode.TokensStr()` + `refTextNode.Text()`），不是新发明的读法，纯加法（原有 `NodeTextMark` 分支不动）。**这一个改动是 P0**——不修，markdown box 下任何块引用都不可能进反链索引，跟这条不相关的 `#+begin embed` 反而没受影响（`treenode.GetEmbedBlockRef` 从写下来就是直接读子节点，不依赖 TextMark，本来就是对的）。
  2. 就算 (1) 修好，`sql.buildRef`/`buildEmbedRef` 把 `Ref.BlockID`（引用**所在**的那个块，"谁引用了它"）设成了 `parentBlock.ID`——在惰性 IAL 下，一段没被专门引用/设属性的普通文字（绝大多数真实引用都长这样）没有持久化 ID，这个 ID 在落盘前已经被 `filesys.StripEphemeralMarkdownBlockIDs` 清空，`BlockID` 留空会让这条 ref 在 `GetBacklink` 里因为查不到对应的 `blocks` 行被静默丢弃（`model/backlink.go`: `refSQLBlocksCache[""]` 永远查不到）。修法：markdown box 且 `parentBlock.ID` 为空时，退化用文档根 ID（永远持久化）——跟 §1.2 给"markdown box 搜索"选的粒度取舍（方案 B，文档级而非块级）保持一致，不是我另拍的新方案。
  两个修完，`go test -tags fts5 ./model/... -run TestGetBacklinkFindsMarkdownBoxRefFromUnidentifiedCitingParagraph` 通过；在真实跑着的内核上用 curl 复现过完整链路（存两篇引用 `hello.md` 里一个块的文档、`POST /api/system/rebuildDataIndex`、`POST /api/ref/getBacklink` 拿到 `linkRefsCount:2`，两条反链路径都对）；`go build ./...`、`go test ./treenode/... ./sql/... ./model/...` 全过，新增的 0 个失败——`model` 包既有的 5 个失败（Obsidian vault 符号链接相关）和 `server` 包既有的 1 个失败，`git stash` 掉这次改动后一样失败，确认是这台机器的既有基线，不是这次引入的。
- **图谱（`getGraph`）：开箱可用，且直接受益于上面反链的两个修复**（图的边就是 refs 表）——在真内核上 `POST /api/graph/getGraph` 验证过：一篇引用 `hello.md` 里某个块的新文档，正确地在返回的 `nodes`/`links` 里画出了一条 `citing doc → hello.md` 的边。

**顺带发现一个跟这次改动无关、还没深究的环境现象**：手动 `pkill` 掉跑着的内核进程再用同一个 workspace 目录重新起一个新进程后，FTS 全文搜索（`/api/search/fullTextSearchBlock`）对已有内容返回空，要显式调一次 `POST /api/system/rebuildDataIndex` 才恢复（反链/图谱倒是不受影响，可能是 FTS5 虚表和 blocktree/refs 表的持久化路径不完全一致）。只在手动杀进程重启这种非正常关闭路径上见到过，真机冒烟测试（commit `e299dc568`）当时是全新 workspace 冷启动，没有这个问题；不在这次任务范围内，先记录，之后要设计真正的进程生命周期/优雅关闭时留意。

**手感门禁（不可退让）**：`src/cm6/**` 的全部 feature 零改动 —— vim-lite、typography（`extensions/visual/typography.ts` + `src/styles/typography.css`）、`visualtex-inline.ts`(4,560)、`math.ts`、`close-brackets-vscode.ts`、`ordered-list-renumber.ts`、`heading-fold.ts`、`structural-jump.ts`、`MeasuredWidget`、`text-boundaries.ts`。CM6 只增加"块感知"的新扩展，不修改既有扩展。

**双路由**：同一 bundle 出两个入口 —— `/`（Tauri 窗口，加载思源 layout/dock/tab 外壳）与 `/embedded`（Emacs xwidget，裸编辑器，等价现状）。复刻思源 `webpack.desktop.js` / `webpack.mobile.js` 的多入口模式，但换成 Vite（Noema 现有工具链）。

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

## Phase 4 — SiYuan-derived Electron 系统适配（当前进行中）

不再把思源 Electron 能力翻译成 Rust/Tauri。复用其成熟窗口生命周期、single-instance、native menu、文件打开和多窗口决策，但不继承上游渲染进程直接 `require("electron")` / `@electron/remote` 的宽权限模型。Noema 保持窄 preload、context isolation 和 sandbox。

**已完成 P0**：共享 Node host 启动、Node-owned Go supervisor、原生窗口/菜单、window state、文件打开、拖放、clipboard/dialog/path APIs、VS Code/new-window 行为、packaged smoke；Emacs xwidget 完全不经过 Electron。

**后续 P1**：print-to-PDF、protocol handler、需要时的 tray/global shortcut；必须继续通过 preload 窄通道，不能把 Node/Electron globals 暴露给 renderer。

**P2（可延后）**：多工作区、自动更新、代理/header、原生拼写、rich clipboard、powerMonitor。多工作区若实现，仍是一工作区一份共享 web host + kernel，两个宿主只连接，不复制后端。

**验证**：Electron 窗口能起共享 host/kernel、开文档、TOC popup 与 Knowledge dock 语义正确；Emacs 侧 `my/noema-*`、Jupyter 和 gateway 行为全部不变。

---

## Phase 5 — 收口与手感对拍（约 3–4 周）

- sidecar 接入（Jupyter `@@cell` 端到端、Copilot 内联补全）
- 属性视图在 CM6 中可编辑（`#+begin av` widget ↔ `/api/av/*`）
- 思源 UI 设计落地：b3- 组件系统用于 Noema 的所有对话框/菜单/面板；dock 化反链、大纲、图谱、搜索、标签
- 主题：`daylight`/`midnight` 与 Noema 现有 `src/styles/themes/` 合并，`--b3-*` 变量保留以吃思源主题生态
- **手感回归门禁**：逐条对拍 vim 模式、排版宽度（4%–8% 自适应 + 95ch）、数学 snippet、bracket 行为、有序列表重编号、heading fold、结构跳转、Emacs 按键桥、5MB 大文档性能

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
