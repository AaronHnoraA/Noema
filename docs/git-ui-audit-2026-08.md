# 版本控制 UI 审计（2026-08-30）

> **状态：A1、A3、B1–B5、C1–C5、C7、D1、E1–E5、F1–F5 已在同日修复**（见文末「已修复」）。
> A2、C6、G1–G3 仍然成立，未做。

范围：Wiki 页面的 Git 管理面（`aaronnote/wiki-main.ts` 中约 250 行）、其后端
（`server/lib/wiki-sync.mjs`、`server/lib/wiki-workspace.mjs`、
`server/lib/wiki-git-ui.mjs`）与二者之间的 API 边界
（`web-host.mjs` 的 `aaronnote:api:wiki:*` 通道、`aaronnote/api-client.ts`）。

结论：**后端的能力明显强于 UI 能表达的**。合并/上传/同步的模型（8 个阶段、
错误分类、租约、隔离 worktree、恢复归档）在 `wiki-sync.mjs` 里是完整的；UI 把
它压成了一张卡片、四个按钮和一个 `<pre>`。"根本不能充分管理"是准确的描述——
不是配色问题，是信息架构和能力暴露的问题。

---

## A. 信息架构

| # | 问题 | 位置 |
|---|---|---|
| A1 | 侧栏 `Sync` 与 `Repositories` 两个导航项渲染**完全相同**的视图，只有标题不同 | `wiki-main.ts:1503` |
| A2 | Git 管理只存在于 `/wiki` 页。编辑器 shell 遇到冲突只能提示"open Wiki repositories to resolve it"——没有状态栏指示、没有命令面板项、没有快捷键 | `main.ts:11555` |
| A3 | server reader 模式用 CSS 隐藏了 `wanted`/`reports`/各对话框，但**没有**隐藏 `[data-view="sync"]` 和 `[data-view="repositories"]`；`renderRepositories`/`repositoryCard` 也没有 `serverReaderMode` 分支。公网读者能进到仓库页，每张卡片的 `syncStatus` 被 `server-policy.mjs` 403 掉，`<pre>` 里逐个显示 "This operation is unavailable in Server reader mode"，下面还挂着 Status / Local commit / Commit & sync / Advanced Git 四个必定失败的按钮 | `wiki.css:78-86`、`wiki-main.ts:1445`、`server/lib/server-policy.mjs:38` |

## B. 仓库卡片表达不出来的东西

- **B1 远端地址不显示。** 卡片只有 `repository.name` 和 `repository.id`。
  `wikiRepositoryStatus` 明明返回了 `remote`（`wiki-workspace.mjs:1478`），UI 丢掉了。
  物理路径同样不显示。
- **B2 ahead/behind 已经拿到了，但被扔掉。** status 是按
  `--porcelain=v1 --branch` 跑的（`wiki-workspace.mjs:1470`），首行
  `## branch...origin/branch [ahead N, behind M]` 只被用来算 `clean`，然后整块
  原样倒进 `<pre>`。全 UI 没有任何一处显示领先/落后多少个提交。
- **B3 脏状态要手动点 `Status` 才知道。** 卡片默认态是一段换行拼接的句子
  （`wiki-main.ts:1307-1324`）。
- **B4 `Local commit` 的成功反馈是 `JSON.stringify(result, null, 2)`**
  直接倒进 `<pre>`（`wiki-main.ts:1243`）。给用户看原始 API JSON。
- **B5 错误分类白做了。** `WikiSyncState` 有
  `errorKind: busy|network|authentication|configuration|remote-race|workspace|conflict|internal`
  和 `actionRequired`，UI 把它们和其它句子一起拼进同一段灰色等宽文本。没有分级
  配色，没有对应的补救入口（比如 `authentication` 该给一个凭据说明的按钮）。

## C. 后端有、UI 没有的操作

- **C1 `aaronnote:api:wiki:git` 是一条死通道。** 它支持 `pull`、`push`、以及带
  显式 `paths` 数组的 `commit`（`wiki-workspace.mjs:1485-1534`），
  但在 `api-client.ts` 里**没有任何绑定**，全仓库零调用者。
  也就是说：**按文件选择性提交、单独 pull、单独 push，后端全实现了，UI 完全够不到。**
- **C2 提交前没有 diff。** 页面级 diff 存在（`api.wiki.pageDiff`），但只在
  单页历史里。没有仓库级的"我这次要提交什么"。
- **C3 完全没有分支 UI。** 不能建、不能切、不能列，看不到设备工作分支与
  `origin/main` 的关系。
- **C4 远端只能在创建时设一次**（`wiki-main.ts:181`），之后没有任何改/加/删
  `origin` 的界面。
- **C5 没有仓库级历史。** 只有 `renderPageHistory` 的按页历史。
- **C6 stash / revert / reset / `.gitignore` / submodule 全部外包给 ungit iframe。**
- **C7 自动同步策略只能靠环境变量。** `NOEMA_WIKI_AUTO_SYNC`
  （`web-host.mjs:898`）。Configuration 页没有 Git 分区；UI 只把
  "Automatic startup and daily batch sync enabled" 当成一句不可操作的说明文字。

## D. 过程反馈

- **D1 8 个阶段一个都没露出来。** 同步引擎把
  `checkpointing / fetching / merging / pushing / applying / waiting / conflicted / idle`
  逐个写进状态文件（`wiki-sync.mjs:294`），但 `web-host.mjs:941` 只在**终态**广播
  一次。UI 因此从头到尾只显示一句静态的
  "Committing local changes, fetching, merging, and pushing…"。
- **D2 进行中的同步不能取消。** 唯一的 abort 是针对已冲突的合并。

## E. 渲染缺陷（真 bug）

- **E1 串行瀑布。** `renderRepositories` 在 `for` 里 `await repositoryCard()`
  （`wiki-main.ts:1455`），每张卡片一次 `syncStatus` 往返 → N 次串行往返。
- **E2 每次同步状态广播都全量重建。** `wiki-main.ts:1897` 直接调 `render()`，
  而 `render()` 会 `viewEl.replaceChildren()` 后重建所有卡片并重新拉取所有状态。
  一次同步会广播多次 → 反复整屏拆建。
- **E3 竞态会把仓库列表变成空白。** `render()` 同步 append 了 toolbar 和 `list`
  之后才 `await` 每张卡片的状态；此时第二次 `render()` 的 `replaceChildren()` 把
  第一次的 `list` 摘掉，第一次的卡片随后被 append 进这个已脱离文档的节点，
  静默丢失。初次渲染仓库页时恰好收到同步广播，页面就是空的，直到手动切换视图。
- **E4 同一次拆建会打断进行中的按钮。** `finally` 里的 `sync.disabled = false`
  写在已脱离文档的按钮上，"Committing…"的状态文字中途消失。
- **E5 冲突按钮挤在同一行。** `Resolve <path>` 被 append 进和
  Status / Local commit / Commit & sync 同一个 flex 行（`wiki-main.ts:1326-1333`），
  数量无上限——20 个冲突就是一行 20 个按钮。

## F. 冲突解决流程

- **F1 一次只能看一个文件**，且由 `state.conflicts[0]` 驱动。对话框里没有冲突
  文件列表、没有"第 3 / 共 12 个"、不能跳过、不能回退。
- **F2 中栏种的是 merge base，不是 git 的合并草稿。**
  `editor.ctr = conflict.base`（`wiki-main.ts:1373`）。两侧**不冲突**的 hunk 也
  必须手工逐个接受一遍，而保存前没有任何校验。
- **F3 保存路径缺护栏。** `finishConflict("result")` 发的是
  `activeConflict.editor?.ctr || ""`（`wiki-main.ts:1394`）——编辑器取值为空时会把
  **空文件**作为解决结果提交。
- **F4 "全部用我的/全部用远端"是串行的**，每个文件一次往返，只有一句静态提示，
  没有计数。
- **F5 `window.prompt` / `window.confirm`** 用于提交信息和批量解决
  （`wiki-main.ts:1239`、`1418`），和自建的 dialog 体系混用。

## G. "Advanced Git" = ungit iframe

- 每个仓库拉起一个 Node 子进程（`wiki-git-ui.mjs`），最多等 12 秒就绪，
  `autoShutdownTimeout` 4 小时。等于在 iframe 里塞了**另一个完整 web 应用**，
  自带一套视觉语言。
- ungit 在 `dependencies` 里，因此进了生产服务端包。
- iframe 头部还提供 "Open in browser"——逃生口是**第三套** UI。

---

## 建议（按性价比排序）

1. **合并 `Sync` 和 `Repositories` 为一个「版本控制」视图**，删掉重复导航项；
   同时在 reader 模式的 CSS 隐藏列表里补上它。
2. **解析 porcelain 的 `##` 行**，把卡片默认态从 `<pre>` 换成真正的摘要行：
   `branch · ↑N ↓M · X 个改动 · remote`。数据已经在手上了。
3. **给 `api.wiki.git` 补上 client 绑定，做暂存列表**：`--porcelain` 出文件行、
   勾选框、逐文件 diff、提交所选。这一项单独就能把面板从"全部提交"变成真正的管理。
4. **广播每一次 `writeSyncState`**，卡片上渲染阶段进度行，顺带给出取消入口。
5. **修渲染生命周期**：仓库视图改成按 `repositoryId` 增量更新，不要走 `render()`；
   初始状态拉取改并行。这一条同时解掉 E1–E4。
6. **冲突对话框**：显示完整冲突列表 + 计数；中栏改种 git 的合并结果；
   仍有未解决标记时禁用 Save。
7. **把自动同步开关和间隔搬进 Configuration 页**。

---

## 已修复（2026-08-30）

新增 `aaronnote/wiki-version-control.ts`：仓库视图自己持有 DOM，按 `repositoryId`
增量更新，不再走 `render()` 整屏重建。

| 审计项 | 处理 |
|---|---|
| A1 | `Sync` / `Repositories` 合并为一个「Version control」导航项；两个旧 view id 都路由到它 |
| A2 | 未做（编辑器仍只给文字提示，见下） |
| A3 | 导航项进入 reader 模式隐藏列表；`navigateTo` 与初始 view 解析都拦截，视图本身也有 reader 分支 |
| B1 | 卡片显示 `origin <remote>`、物理路径、HEAD 短 sha |
| B2 | 新增 `server/lib/git-status.mjs` 解析 porcelain（`-z` 与换行两种形态）；ahead/behind 成为徽章。设备工作分支没有 upstream，改为对 `origin/main`（回退 `origin/master`）测距，徽章显示 `→ origin/main` |
| B3 | 变更文件数、冲突数、clean 直接以徽章呈现，不必先点 Status |
| B4 | 不再倒 JSON；成功/失败走一行消息区，原始 porcelain 收进折叠的「Raw git status」 |
| B5 | `errorKind` 映射为消息前缀（Authentication / Network / Configuration / Workspace / Busy / Remote moved），错误态单独配色 |
| C1 | 暂存列表：每个变更文件一行、复选框、状态码、逐文件 diff；提交信息内联输入；`Commit N files` 只提交所选。Pull / Push 各自独立成键，无 origin 时禁用并给出 title |
| C2 | 新增 `aaronnote:api:wiki:repository-diff` 通道与 `wikiRepositoryDiff`：已跟踪文件对 HEAD 出 diff，未跟踪文件对空树出 diff |
| D1 | `wiki-sync.mjs` 新增 `onWikiSyncStateChange`，`writeSyncState` 每次落盘都通知；`web-host.mjs` 转成 `live: true` 广播。卡片实时显示 `Committing local changes / Fetching origin / Merging remote work / Publishing to origin / Applying the published result` 与 `step N of 5` |
| E1 | 初始状态并行拉取，不再串行 await |
| E2/E3/E4 | 同步广播改为 `applySyncState(repositoryId, …)` 局部更新；`live` 事件不触发状态回查。整屏拆建、竞态丢卡片、按钮脱离文档三个问题一并消失 |
| E5 | 冲突移进独立的 `.noema-vc-conflicts` 区块（带计数与 Abort），不再挤进操作行 |
| F1 | 对话框顶部有冲突文件标签栏与「file N of M」 |
| F2 | `readWikiConflict` 增加 `merged`（git 自己的合并输出）；中栏改种它而非 merge base，两侧不冲突的 hunk 不再需要手工重接 |
| F3 | 保存前拦截：编辑器未就绪、仍含冲突标记、或结果为空而草稿非空，都不发请求 |
| F4 | 批量解决显示「Resolving i of N — path」并同步刷新文件标签栏 |
| F5 | 提交信息改为内联输入框，不再 `window.prompt` |

顺带修掉的：`api.wiki.pageHistory` / `pageDiff` / `restorePage` 三个方法在
`api-client.ts` 里有绑定，但 `web-host.mjs` 的 adapter 脚本没有桥接，页面历史
功能实际上是死的——已补上。

测试：`tests/git-status.test.ts`（8）、`tests/wiki-version-control.test.ts`（9）、
`tests/wiki-workspace.test.ts` +5、`tests/wiki-sync.test.ts` +2。

### 仍然没做

- **A2**：编辑器 shell 里依然没有版本控制入口（状态栏、命令面板、快捷键）。
- **C3 分支 UI**、**C4 远端管理**、**C5 仓库级历史**、**C6 stash/revert/reset**：
  仍然只能靠 ungit。
- **C7**：自动同步开关仍是 `NOEMA_WIKI_AUTO_SYNC` 环境变量，Configuration 页没有
  Git 分区。这一条要动 `server/lib/app-config.mjs` 的 schema（含版本号）、配置页、
  以及启动期 `wikiAutoSyncEnabled` 的读取时机，是独立一块，没有塞进这次改动。
- **G1–G3**：Advanced Git 仍是 ungit iframe。


## 第二轮（同日）

### 自动同步的失败预算

用户反馈：一次失败之后调度器在疯狂重试，而笔记本要带出门，不能让它一直空转。

原来的行为：`run()` 把**抛出的异常**当成未知情况——既不 `blocked`，也不排重试。于是
每次保存笔记触发的 `mark()` 都会把同一个必然失败的同步再跑一遍。可重试的结果
（网络类）则按 `[60s, 5m, 30m, 2h]` **无限**退避下去，离线时永远醒着。

现在每个仓库有一份**连续失败预算**（默认 3 次，`maxConsecutiveFailures`）：

- 失败签名由 `errorKind` + 错误文本构成。签名变了，预算重新计数；成功则清零。
- `busy`（被另一台主机占用）和 `conflicted` 不计入——前者不是失败，后者已由既有
  逻辑挂起等用户处理。
- 预算用尽 → 仓库 `blocked`，挂起的定时器清掉。之后的 `mark()` 只记进
  `blockedDirty`，**不再触发任何 git 进程**。通过 `onExhausted` 上报一次。
- 恢复只有两个信号，都不是轮询：用户点 **Commit & sync**（`syncNow` 立即清空预算），
  或者**下一次周期性 pass**（每天一次）发还一份新预算。冲突挂起的仓库不在此列，
  它仍然等用户。

配套的分类修正：`fetch failed`（内核 HTTP 端点中断时 undici 抛的不透明错误）原本
落到 `internal`，一次内核重启就能吃掉整份预算——现在归为 `network`。

### 卡死的 integration worktree

用户截图里 `private/research` 领先 255 个提交却同步不动：

```
fatal: 'noema-integration/aaronmac-local-019fb75f' is already used by
worktree at '.noema/worktrees/019fb75f-96ce-733d-8d29-0e1555a1cba6'
```

`git worktree add` 在初始化期间会给新 worktree 加锁（`locked` 文件内容就是
`initializing`），成功后解锁。8-29 那次 add 被中断，留下一个**已锁定、目录已不存在**
的注册。`git worktree prune` **会跳过锁定的注册**，`worktree remove --force` 也拒绝
锁定的 worktree，而 `prepareIntegrationWorktree` 只在 `existsSync(path)` 为真时才做
清理——目录不在，整段跳过。于是那条 integration 分支被永久占住，此后每次同步都撞同
一堵墙。

`releaseIntegrationBranchHolders` 现在会在 `worktree add` 之前扫一遍注册表：任何持有
该 integration 分支（或占着目标路径）的非主 worktree 都先 `unlock`、再
`remove --force`、最后 `prune`。目录还在的先把工作文件隔离进 `.noema/recovery/git/`
再删。目标路径自己的清理也补上了 `unlock`。回归测试先断言原始
`git worktree add` 确实失败，再断言同步能自愈。

### 分支与远端管理（C3/C4）

仓库卡片新增折叠的「Branches and remotes」（按需加载，一次两个往返）：

- 分支列表带 upstream、最后提交日期、current 标记、`Noema-managed` 标记、以及
  「被别的 worktree 占用」状态；可创建/切换/删除。
- 远端列表可改 URL、可移除。

护栏都在服务端：切换分支要求工作区干净且没有进行中的合并；被其它 worktree 占用的
分支不能切也不能删；不能删当前分支；`noema/` 和 `noema-integration/` 两个命名空间
需要显式 force；分支名与远端名做字面校验（拒绝 `-` 开头、`..`、`@{`、控制字符等）；
远端 URL 拒绝内嵌凭据，和 Server reader 的仓库列表用同一条规则。

### 同步策略进配置页（C7）

`~/.config/noema/config.json` 加 `wiki.sync = { automatic, intervalMinutes }`
（schemaVersion 3 → 4，并把「支持的 schema」从白名单改成「不大于当前版本」，否则每次
升版都会把上一版判为 unsupported）。配置页新增 **Git synchronization** 分区。

**立即生效，不需要重启**：`createWikiAutoSync` 新增 `reconfigure()` 会重挂周期定时器
（而不是等旧的那个先烧完），web-host 的 `applyWikiSyncPolicy` 在开关切换时创建/关闭
调度器。关闭时用 `close({ flush: false })`——把 cadence 关掉本身不应该再触发一次网络
同步。`NOEMA_WIKI_AUTO_SYNC=0` 保留为压倒一切的诊断开关。

### 一个我自己引入的 bug

截图里那句 "next retry 9:44:06 PM" 是假的：`applySyncState` 当时是**浅合并**，而
`JSON.stringify` 会丢掉 `nextRetryAt: undefined`，于是新状态里被有意清掉的字段在
客户端一直留着。每个事件其实都携带完整状态，改成整体替换（只保留走另一条通道的
policy 字段），并且 `nextRetryAt` 只在 `retryable` 为真时才显示。
