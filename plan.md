# Noema × SiYuan 重构计划

> **⚠️ 2026-08-25 起，Go 内核代码位置变了**：`/Users/hc/HC/SOURCE/Noema/kernel/`（Noema 主仓库、`main` 分支），不再是 `reference/siyuan/kernel`。`app/appearance/`、`app/stage/auth.html` 作为 `kernel/` 的同级目录一起搬过来了（内核自己的相对路径和一些既有测试都假设这个同级关系）。`reference/siyuan` 还留着，保留完整的逐次 commit 历史，但不再是活跃开发的位置。详见下面 Phase 0 进度记录里的说明。

## 工作方式约定（Aaron 明确要求，持久化在这里，不要只留在对话里）

- **本文件（`/Users/hc/HC/SOURCE/Noema/plan.md`）是唯一权威、活的进度记录**，不是快照。每做完一步就更新一步（"每做一步更新一步"）——不要攒到一个大总结再补，也不要让它变成开工前那一版一次性快照后就再也不碰。
- **代码要展开进项目结构，不能只放在 `reference/` 里当参考**（"不要单单把思源代码放进 reference 里面了，而是作为项目结构展开进项目"）。`reference/siyuan` 只是原始 SiYuan checkout + fork 过程的逐次 commit 历史，不是终点。
- **搬迁方式是增量的，不是一次性大搬家**（"一点点写一点点挪"）：只把已经实际动过、验证过的部分从 `reference/siyuan` 搬进项目正式结构（目前是 `kernel/` + `app/appearance/` + `app/stage/auth.html`）；`app/pandoc/`（168MB，内核能容忍它不存在）、`app/appearance/covers/`（19MB，装饰性封面图，没有功能依赖它）、整个 `app/` 里还没碰过的 protyle/mobile 前端，都刻意留在 `reference/siyuan`，等真正开始动那部分工作时再搬，不要提前搬进来占地方。
- 这些要求本身也要留在这份文档里，供以后的会话/协作者直接看到，不用重新问一遍。

## Context

Noema 现在是：CM6 编辑器（markdown 为唯一真相源）+ Node server（`server/lib/runtime.mjs` 8,185 行，全内存扫描索引）+ Emacs xwidget 宿主 + Tauri 桌面壳。瓶颈很清楚 —— roam 层没有真正的索引（每次 `scanNotes()` 全量扫 markdown，靠 Map + JSON 持久化缓存兜底），没有块级引用，没有 FTS 搜索，没有结构化数据库视图。

SiYuan 恰好把这几件事做到了工业级：`.sy` 块树 + `blocktree.db` + `siyuan.db`（FTS5，自定义 tokenizer）+ 601 个 API + 成熟的 b3- 设计系统。但它的存储格式（`.sy` JSON，文件名即块 ID）和编辑器（protyle，contenteditable + 内核回传 HTML 打补丁）都和 Noema 的核心约束互斥。

**本次重构的目标**：以思源仓库为底座，删掉与 Noema 冲突的层（protyle / mobile / 云 / 快照同步），把 Noema 的 CM6 编辑面、私有语法、roam/agenda 语义搬进去，后端统一成 Go。要拿到的是：块引用 + SQLite/FTS5 索引与搜索 + 属性视图 + 思源的 UI 设计。要守住的是：**md 文件 + org-env(meta) 结构为真相源、git 分发、Emacs 直接编辑、CM6 手感零回归**。

---

## 关键决策（已定）

| 项 | 决定 |
|---|---|
| 存储 | `.md` + 现有 org-env/meta 结构为唯一真相源；`.sy` 只作为内存 AST，永不落盘 |
| 编辑面 | **保留 CM6，删除 `app/src/protyle/`（85,771 行）** |
| 外壳 | Emacs xwidget 为主宿主 + Tauri 独立窗口；思源的 layout/dock/menu 只在 Tauri 窗口路由启用 |
| 后端 | Go（思源 kernel 裁剪版），Node 仅保留 Jupyter / Copilot sidecar |
| 云 | 全部移除（`cloud_service.go` / `sync.go` / `lan_sync.go` / `repository.go`+dejavu / bazaar 网络层） |
| 版本历史 | git（沿用现有 `wiki-sync` / `roam-git` 语义），不用 dejavu 快照 |
| 要吃到的 | 块引用、SQLite/FTS5 索引与搜索、属性视图(attribute view)、b3- 设计系统 |

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
  src-tauri/               Noema Tauri 宿主（吸收 app/electron 能力）
  sidecar/                 Node：Jupyter + Copilot
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
| `NodeAttributeView` | `#+begin av :av-id <id>` —— AV 数据本体仍在 `data/storage/av/*.json` 侧车，块只存引用 |
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

CM6 侧新增（都是 widget/decoration 层加法，不动现有 feature 顺序 `src/cm6/extensions/index.ts`）：
- 块 ID gutter + 块引用 `((id "text"))` 的 live-preview widget（复用 `roam-link-status.ts` 的 hover/解析模式）
- `#+begin av` widget → 渲染思源 AV（复用 `app/src/protyle/render/av/` 的 ~50 个文件，这部分是**独立于 protyle 编辑面的纯渲染层**，可以单独抽出）
- `#+begin embed` widget → 走 `/api/search/searchEmbedBlock`
- 反链/大纲/图谱面板改用内核 API（`model/backlink.go`、`model/outline.go`、`model/graph.go`），删掉 `aaronnote/local-graph.ts` 的本地实现

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
- sidecar 生命周期交给 Tauri 管（Noema `src-tauri` 已有 Node sidecar 逻辑）

**API 通道映射**：Noema 现有 ~160 个 `aaronnote:api:*` 通道（wiki 31 / notes 26 / jupyter-cell 25 / jupyter 9 / emacs 8 …）迁到思源的 `POST /api/*` + `{code,msg,data}` 形状。`aaronnote/api-client.ts`(1,697) 作为唯一 facade 改一次，上层调用点不动。`server/infrastructure/api-router.mjs` 的 channel 注册模式弃用。

**验证**：agenda 全部 8 个视图与旧实现输出逐条对拍；LaTeX 导出产物字节对比；`git status` 语义与旧 wiki-sync 一致。

---

## Phase 4 — Electron → Tauri（约 3–5 周）

`app/electron/main.js`(2,763) 全部能力翻译到 `src-tauri/`（现状仅 2,484 行 / 16 个 command）。

**注意**：思源**没有 preload、没有 context isolation**，渲染进程直接 `require("electron")` + `@electron/remote`。所有这些调用点（`src/util/fetch.ts:2`、`src/index.ts:41` 等，由 `/// #if !BROWSER` 保护）必须转成 Tauri command。

需要实现的 25 个 `ipcMain` 通道 + ~40 个 `siyuan-cmd`/`siyuan-get` 子命令，按优先级：

**P0（不做就跑不起来）**：kernel 进程 spawn + 端口发现 + 退出码 20/21/24/25/26 映射；无边框窗口 + traffic-light 定位 + windowState 持久化；`showOpenDialog`/`showSaveDialog`/`showMessageBox`；`clipboardRead`；`openPath`/`showItemInFolder`；`registerGlobalShortcut`。

**P1**：`printToPDF` + `siyuan-export-pdf`（隐藏 printWin）；多窗口 `siyuan-open-window`；`siyuan-send-windows` 跨窗口广播；native 菜单 + tray；`siyuan://` protocol handler + `open-url`/`second-instance`。

**P2（可延后/放弃）**：多工作区（每工作区一个 kernel + 窗口）、自动更新、`setProxy`/header 改写、原生拼写检查、rich clipboard 三段式（MathML/Office/WPS 读取，平台相关且极琐碎）、powerMonitor 优雅关机状态机。

Emacs xwidget 路径不经过 Tauri，行为不变。

**验证**：Tauri 窗口能起 kernel、开文档、导出 PDF、全局快捷键生效；Emacs 侧 `my/noema-roam-agenda` 等公开命令全部不变。

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
