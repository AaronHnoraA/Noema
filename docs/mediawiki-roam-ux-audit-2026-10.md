# Noema Wiki / Roam 创建与管理交互审计（对照 MediaWiki）

审计日期：2026-10-07。范围是 Emacs 宿主中的 Markdown Wiki / Roam node 从创建、长期维护到合并、删除、恢复的完整生命周期；依据当前源码、现有文档、62 项聚焦测试和临时 Wiki 仓库复现。没有在真实 Emacs 窗口内进行鼠标、触控板或输入法验收，因此以下“手感”判断均标明其可验证的交互路径，不把代码推断写成现场观察。

## 从 MediaWiki 取什么

MediaWiki 的 [`LinkRenderer`](https://github.com/wikimedia/mediawiki/blob/beaec89b6eeed6f496b3bd2fba8982ae124ff1c0/includes/Linker/LinkRenderer.php#L159-L185) 按目标是否存在生成已知或缺失链接；缺失链接的 URL 带 `action=edit&redlink=1`，点击即进入该目标的创建路径（[源码](https://github.com/wikimedia/mediawiki/blob/beaec89b6eeed6f496b3bd2fba8982ae124ff1c0/includes/Linker/LinkRenderer.php#L324-L349)，[用户文档](https://www.mediawiki.org/wiki/Help:Starting_a_new_page)）。其价值是**链接本身就是建页入口**，无需先去全局“新建”再抄标题。

MediaWiki 的页签和工具对应当前页面：Read/Edit/History/Discussion 有明确的页面身份，[历史可以读某版并比较两版](https://www.mediawiki.org/wiki/Help:History)，[What links here](https://www.mediawiki.org/wiki/Help:What_links_here) 在当前页工具中。Vector 允许把页面工具和目录固定或收起，但收起后仍可打开（[配置源码说明](https://github.com/wikimedia/mediawiki-skins-Vector/blob/2a230d4b091895b4ff82673e99c6f8fd2b89d4c0/doc/configuration/configuration.md)）。

Noema 应复用这三条交互原则，而不是复制 MediaWiki 的存储和语法。Noema 的 Markdown 文件与 Git 仓库是事实来源，`wiki.db` 是可重建投影；页面路径、逻辑 namespace、public/private 分区和稳定 ID 是不同维度（[现有约定](wiki-workspace.md)）。MediaWiki 把注册的 namespace 作为页面标题前缀；Noema 已把冒号保留为 namespace 分隔符，且允许多个仓库共享 namespace（[MediaWiki namespace 文档](https://www.mediawiki.org/wiki/Help:Namespaces)，[Noema 解析](../shared/wiki-link.mjs)）。因此 Noema 的缺页创建必须显式处理仓库和隐私歧义。

## 实际断点（按优先级）

| 优先级 | 路径与证据 | 用户感受到的问题 | 修正方向 |
| --- | --- | --- | --- |
| P0 | `[[新页]]` 补全提供 Create，但插入标题链接后仅打开 `/wiki?new=1&title=…&source=…`；创建成功只打开新文件、刷新索引（[`wiki-completion.ts`](../aaronnote/wiki-completion.ts)、[`main.ts`](../aaronnote/main.ts)、[`wiki-main.ts`](../aaronnote/wiki-main.ts)）。 | 新页已经有稳定 ID，原链接仍是可歧义的标题；作者要返回手改，最关键的“写下链接 → 得到页面”闭环未完成。 | 建页成功后按原始源码跨度验证并把**那条来源链接**升级为稳定 `roam://id`，保留原显示文字和一次撤销；失败时明确显示“页已创建，来源链接未更新”。 |
| P0 | 缺失链接点击在编辑器中用 `window.location.assign(/wiki?new=1…)`，补全 Create 却用 `api.emacs.openSurface`（[`main.ts` 第 1277、7035 行](../aaronnote/main.ts)）。 | 两个相同意图打开方式不同；点击路径离开来源编辑页，使光标、未保存内容和创建后回写难以维持。 | 两条入口共用一个 `CreateIntent`，由 Emacs 宿主打开创建工作台，保留来源页。 |
| P0 | 带 namespace 的标题由 `showNewPage` 找到**第一个**同名 namespace 仓库；来源仓库预填只在没有指定 namespace 时执行（[`wiki-main.ts` 第 1494 行](../aaronnote/wiki-main.ts)）。 | public/private 或多个 vault 同 namespace 时，预选结果可能与来源页不一致；作者很容易在错误分区创建。 | 显式分区优先；否则先用来源仓库；若仍有多个候选，要求选择并显示 public/private、仓库路径、最终文件路径。禁止以数组顺序作决定。 |
| P1 | Emacs 原生 `my/noema-roam-new` 只给 vault 相对路径、title/kind/template/tags；Wiki 的 `my/noema-wiki-new-page` 则打开另一套 Web 表单（[`init-md-roam.el`](../../../lisp/roam/init-md-roam.el)、[`init-aaronnote.el`](../../../lisp/roam/init-aaronnote.el)）。 | “新建 Roam 节点”和“新建 Wiki 页”是两种概念和窗口；前者没有多仓库、namespace、分区的可见决策。 | 统一创建意图与后端 API。Emacs 原生工作台可保留其键盘交互，但 Wiki 布局下必须展示同一套仓库、namespace、路径预览和验证规则；Legacy 布局沿用单 vault 默认。 |
| P1 | Wiki 页签写着 Discussion / Edit / View history，事件却分别进入 All pages / New page / Recent pages（[`wiki-main.ts` 第 83–93、1707 行](../aaronnote/wiki-main.ts)）。真实单页历史在页面列表的“••• → Operation → Page history”（同文件第 699、1565、1590 行）。 | 当前页身份与按钮文案不符；历史必须返回列表查找。 | 全局 Wiki 首页只显示真实的全局导航。进入页面后提供基于 page ID 的 Read/Edit/History、Backlinks/Manage；没有 Discussion 模型就不显示该页签。 |
| P1 | `Recent` 按文件 `mtimeMs` 排页；Git 历史按仓库 checkpoint 展示（[`wiki-main.ts` 第 628、771、1590 行](../aaronnote/wiki-main.ts)，[Wiki 同步约定](wiki-workspace.md)）。 | “Recent changes / View history”暗示逐次编辑记录，实际是最近修改文件或 Git 批次；自动保存与 checkpoint 间的差别不可见。 | 明确命名“最近修改的页面”和“Git 检查点历史”；当前页增加“未检查点更改”的 diff 入口，历史说明时间粒度。无需为每次按键造提交。 |
| P1 | 1439px 以下右侧工具栏被隐藏，CSS/事件预留 `data-toggle-tools`，但页面模板没有该按钮（[`wiki.css` 第 354–362 行](../aaronnote/wiki.css)，[`wiki-main.ts` 第 32–48、1793–1807 行](../aaronnote/wiki-main.ts)）。 | 常见窄窗口中 Appearance、Page tools、Index、快捷键整栏无法再打开。 | 增加真实工具按钮，配套焦点、Escape 与 `aria-expanded`；页面操作需另有稳定入口。 |
| P2 | 页面卡片可聚焦，卡片上监听任意冒泡 Enter 来打开页面，内部“•••”按钮的 Enter 也会触发卡片处理（[`wiki-main.ts` 第 699–738 行](../aaronnote/wiki-main.ts)）。 | 键盘打开管理菜单时，页也会被打开；DOM 冒泡小复现已确认。 | 只在事件目标就是卡片时处理 Enter，并给卡片明确的链接/按钮语义。 |
| P2 | 搜索无结果只显示“换个词或去工作台建页”；工作台未预填搜索词（[`wiki-main.ts` 第 810–819 行](../aaronnote/wiki-main.ts)）。 | 从搜索到建页要重新输入标题。 | 显示“创建〈当前搜索词〉”，复用同一创建意图，并先提示可同名的其他 namespace/仓库页面。 |

## 建议的统一建页契约

1. `[[标题]]`、`[[namespace:标题]]`、`[[public/namespace:标题]]`，以及 `[标签](roam://wiki/标题)` 都保留现有语法。补全、缺页链接点击、搜索空结果、Wanted 报告、Emacs `new page` 命令都构造同一个 `CreateIntent`：来源文件与客户端、来源链接的精确源码跨度/原文/可见标签、目标文本、是否显式指定分区和 namespace。纯全局新建没有来源链接。
2. 工作台先查索引：若同作用域已有唯一页面，默认“打开现有页 / 插入该页稳定链接”；若歧义，列出 public/private、仓库、namespace、文件路径供选择。确实要建新页时，预填优先级为“链接显式分区与 namespace → 来源仓库/目录 → 创建 profile”。仓库选项显示隐私分区；提交前展示完整目标路径、稳定 ID 将如何写入 metadata、原链接将变成什么。
3. 创建走唯一的 Wiki 写入边界，先校验目标路径和重复标题。成功返回 `{id,file,repositoryId,namespace}` 后，来源编辑器只在**当前源码仍与意图原文匹配**时做一个 CM6 ChangeSet，保留链接标签：`[[Math:Tensor]] → [[roam://<id>|Math:Tensor]]`；`[张量](roam://wiki/Math:Tensor) → [张量](roam://<id>)`。再沿现有 SaveDrain/CAS 保存并刷新索引。不要绕过实时编辑器直接改来源文件，也不要整篇重序列化 Markdown。
4. 创建窗口取消时保留原红链。若创建成功但来源已改、原页已关、保存冲突或写回失败，新页不回滚；记录可恢复的 pending-link 操作，显示来源位置与“重试替换 / 复制稳定链接 / 保持原标题链接”。绝不因匹配到同名文本就替换别处。完成来源链接保存后再把焦点交给新页。
5. 页面管理以稳定 page ID 为上下文，读页可直接进 History、Backlinks、Move/Rename、Copy、Trash。移动/改名保持 ID；合并保留重定向；删除继续展示反向链接及回收路径。Git 仍承担协作与长期历史，Wiki 索引仍是派生视图。

### 最小验收场景

- private/Research 与 public/Research 都存在：从 private 来源输入 `[[Research:新页]]`，预选 private 来源仓库且明确显示分区；输入 `[[public/Research:新页]]` 只能在 public 候选中选择。
- 同标题已存在于别的仓库：先列候选，不静默新建或指向第一个；选既有页时原链接变为其稳定 ID。
- 创建时来源页继续编辑、原链接被删除或移动、创建窗取消、建页成功但来源保存冲突：均不丢原编辑内容，不替换不相干链接，失败可恢复。
- 显式标签、中文标题、块片段、Legacy 单 vault、Wiki 多仓库和 public 页面指向 private 页均有独立检查；后者须提示发布后的缺失目标。
- 键盘能从链接到工作台、切换仓库、提交或取消，再回到原链接/新页；窄窗口能重新打开工具栏。页面管理菜单的 Enter 只开菜单。

## 一个 node 的完整生命周期

一个 node 的状态应让作者能辨认：**待创建 → 活跃维护 →（移动/复制/合并）→ 活跃或重定向 → 回收站 → 恢复或最终清理**。复制产生新 ID，是另一条生命周期；移动保持 ID；合并后的重复页不应假装还承载原正文。长期维护没有“完成”按钮，作者会反复从链接、搜索、反向链接、标签、最近修改和历史回到同一页。

| 阶段 | 当前用户操作与反馈 | 判断与应达到的手感 |
| --- | --- | --- |
| 发起 | 在链接补全、缺页点击、Wanted、全局新建和 Emacs 原生 Roam 命令之间切换；入口传递的来源上下文不一致。 | **断裂。**一个建页意图应贯穿发现、选择现有页或创建、来源链接升级和返回来源。见上文 P0。 |
| 定位与创建 | 表单可填 title、仓库、namespace、目录、文件名、kind、tags；后端只拒绝物理路径冲突，不阻止同一逻辑作用域的同名页。 | **部分合理。**多仓库选择是必要的；提交前要展示完整路径与分区，查同名页，解释“新 ID / 既有 ID”。创建成功应说明来源链接是否已更新。 |
| 撰写与回访 | Markdown 是真相，CM6 保存走版本比对；列表、搜索、反向链接、标签可找回页面。页面级管理入口主要藏在 All pages / Recent 卡片的 `•••`。 | **基础可靠、入口分散。**编辑器的版本冲突保护值得保留；打开页面时应直接看到身份、所在仓库、出入链、未解决链接、未检查点修改及 History/Manage。 |
| 整理元数据 | 标题可在 Markdown metadata 手改；Tags、Namespaces 视图可批量改名。批量操作逐个直接写文件，不做一组文件的预览、版本前置条件或失败回滚。 | **有冲突风险。**批量修改前展示受影响页、保护打开中的草稿并报告部分成功；需要明确是“改标签/namespace”还是“改页面标题”。单页 metadata 编辑继续遵循普通保存的版本比对。 |
| 改名与移动 | “Move or rename” 表单只能改仓库、namespace、目录和文件名；后端保持 `title` 不变，只写新 `namespace`。移动保持 ID。 | **文案与结果不符。**把“改标题”作为独立字段；保留旧标题为 alias 或提供可审阅的旧链修复。移动前预览目标路径、受影响相对资源和跨仓库历史边界。完成后打开新位置并给出可回退操作。 |
| 复制 | 新 ID、复制正文和页面专属资源；选 public 仓库时不要求隐私确认，直接复制 private 内容。 | **高风险。**即使 `private: true` 阻止站点目录收录，内容仍进入 public Git 仓库。private→public 的复制必须有与移动同等的边界审查，显示实际发布状态；复制后打开新页。 |
| 合并 | 选择任意另一页并输入 `MERGE`；重复页正文被覆盖为跳转说明，保留页只增加重复页 title alias；原稳定 ID 指向跳转文件。 | **不符合“合并”预期。**当前更像“将 B 替换为指向 A 的占位页”，正文没有合入；同 namespace 同仓库的原标题链接会在 A 的 alias 与 B 的 title 之间变歧义。先预览两页差异、正文/资源处置及链接解析结果，再允许保存跳转。跨 public/private 合并须检查发布后的目标可达性。 |
| 历史与恢复版本 | “Page history”列 Git commit，支持单 commit diff 和恢复为工作区修改；没有当前未提交 diff 或任选两版比较。 | **模型合理、操作不完整。**清楚区分自动保存、Git 检查点、同步；让用户看恢复将覆盖什么并能在恢复后检查。MediaWiki 的历史页可选择两版比较，Undo 以可检查的编辑形式呈现（[History](https://www.mediawiki.org/wiki/Help:History)、[Reverting](https://www.mediawiki.org/wiki/Help:Reverting)）；Noema 可用 Git + CM6 实现相同的“先看差异再决定”原则。 |
| 删除与复活 | 删除前显示反向链接**数量**，但提示“reviewing the backlinks”时没有列出反向链接；页面及专属资源进入系统 Trash，索引随之失去该 page ID。没有 Wiki 回收站/恢复操作；历史版本恢复 API 要先找到仍在索引里的页。 | **只做了一半的可逆删除。**确认前列出具体反向链接和公开引用；删除后保留含原仓库、相对路径、ID、资源映射的恢复记录，提供“撤销删除 / 从 Trash 恢复”。恢复先检查原路径冲突，再带原 ID 复原并重建索引。 |

### 已复现的生命周期断点

1. **合并语义与链接完整性（P0）。**临时同仓库建 `Survivor`、`Duplicate`，在后者加唯一段落后调用 `mergeWikiPages`。结果两份当前 Markdown 都没有该段落；`resolveWikiLink(index, "Duplicate")` 为 `ambiguous`；`roam://<duplicate-id>` 解析到重复页的跳转文件，编辑器直接打开该文件，并不自动追踪 `redirect_to`。源码见 [`mergeWikiPages`](../server/lib/wiki-workspace.mjs)、[`resolveWikiLink`](../server/lib/wiki-workspace.mjs) 与 [`openExternalUrl`](../aaronnote/main.ts)。这可能让作者以为正文已合并；若此前没有 Git 检查点，该段落还可能无从恢复。若真正目标只是建立重定向，界面应明确说“替换重复页正文”，不能叫 Merge。
2. **private→public 的复制与移动（P0）。**`copyWikiPage` 没有分区确认；`moveWikiPage` 虽要求输入 `MOVE PRIVATE TO PUBLIC`，却只改 namespace 和路径，保留 `private: true`。临时仓库复现：移动或复制后的文件位于 public Git 仓库，`publicWikiNotes(index)` 却不收录。用户既可能误判为已公开，也可能把私有内容写入可同步的公开仓库。跨分区操作应以**仓库放置**和**站点可见性**两个独立结果预览；`private: true` 的处理必须由用户明确决定，复制也须受同一隐私门控。
3. **删除后缺少产品内恢复（P1）。**`deleteWikiPage` 返回 Trash 位置并移走页面；随后 `restoreWikiPageVersion(pageId, sha)` 报 `Unknown Wiki page`，因为它先从当前索引查 ID。这个 API 是“恢复现存页的旧 Git 版本”，不是“从 Trash 复活”；目前没有相应 Wiki 操作。临时仓库验证了该调用序列。对照 MediaWiki 的删除页可由有权限的人在专门的恢复入口查看、恢复历史（[Undelete](https://www.mediawiki.org/wiki/Help:Undelete)）；Noema 应用本地 Trash 清单承接，而非复制 MediaWiki 权限模型。
4. **移动后的 Git 历史与资源（P1）。**同仓库重命名可借 `git log --follow` 追溯；跨仓库移动采用拷贝到新仓库再删旧文件，新仓库的页历史不能自然显示旧仓库的 commit。操作日志记有 `dependencies`，但页面管理对话框不展示依赖清单；移动只跟随页面 ID 所有的 `images/`、`attachments/` 目录，其他相对链接和 include 可能失效。应在确认前列出实际受影响路径，并为跨仓库前史提供跳转到原仓库历史的来源记录。MediaWiki 的移动操作保留页历史并建立旧标题跳转，且可反向移动（[Moving a page](https://www.mediawiki.org/wiki/Help:Moving_a_page)）；Noema 的稳定 ID 能免除多数内部链接改写，但文件相对引用与 Git 仓库边界仍要显式处理。
5. **操作结束反馈（P1）。**`applyPageOperation` 在 move/copy/merge 后关闭弹窗并刷新列表，不打开目标页，也不显示成功摘要；删除只显示 Trash 路径。作者无法立刻确认新位置、链接状态、公开状态或下一步。每个结果应给目标页入口、ID/路径/分区摘要以及可执行的恢复或修复动作。

### 实施顺序与验收

先修会改变数据含义的操作：合并改为预览且不静默丢正文；跨分区复制/移动共用发布审查；删除建立可发现的恢复记录。随后统一创建意图、单页管理入口、真正的标题改名与旧链兼容。最后打磨历史比较、批量标签/namespace 的进度与局部失败反馈。不要为了模仿 MediaWiki 引入另一套数据库权威：所有修复仍写 Markdown/Git，`wiki.db` 仍只做投影。

最小端到端验收：从 `[[新页]]` 建页后原链成为稳定 ID；改标题、移动仓库后这条链仍开同一页；复制得到独立 ID 且 public/private 结果可预期；合并预览能明确决定重复页正文去向、原标题无歧义；删除前能点开反向链接，删后能在 Emacs 中按原 ID 与资源恢复；恢复旧 Git 版不会静默覆盖当前草稿。持续维护半年后，用户仍能从页面直接看到状态、关系与历史，不必先记住它在哪个仓库或列表里。

## 验证与限制

`npm test -- tests/wiki-completion.test.ts tests/wiki-workspace.test.ts tests/wiki-version-control.test.ts tests/save-drain.test.ts`：4 文件、62 项通过。用 happy-dom 触发“•••”按钮的冒泡 Enter，父卡片处理器也运行。本轮另用临时 Wiki 仓库调用真实创建、合并、移动、复制、删除 API，核对上面的正文、链接、分区与恢复结果；测试仓库已删除。现有自动测试覆盖索引、创建 API、版本控制和保存队列的局部契约，**没有**覆盖跨 Emacs 窗口的创建后回写，也没有完整的“创建→维护→移动→合并/删除→恢复”流程测试。审计没有在真实 Emacs 窗口做输入验收；本轮只形成审计和验收设计，没有修改产品行为，也未碰工作区已有的研究相关未提交改动。

## 2026-10-07 实施补记

随后按此审计修改了产品代码。缺页链接通过 Emacs 宿主打开带来源意图的创建工作台；仓库、namespace、目录可在创建前修改，创建后仅在来源链接原文仍匹配时升级为稳定 ID。已有同作用域页面可直接复用。页面工具提供移动/改名、复制、合并、Git 历史、删除和 Wiki Trash 恢复；合并前展示两页 Markdown，合并正文后保留重定向与原文存档。移动或复制到 public 仓库需要显式确认；可能断开的非专属相对资源会阻止搬迁。

对照 [MediaWiki 建页](https://www.mediawiki.org/wiki/Help:Starting_a_new_page)、[移动](https://www.mediawiki.org/wiki/Help:Moving_a_page)、[重定向](https://www.mediawiki.org/wiki/Help:Redirects)、[反向链接](https://www.mediawiki.org/wiki/Help:What_links_here)、[历史](https://www.mediawiki.org/wiki/Help:History)，保留了“链接就是入口、身份跨改名稳定、关系与历史贴近页面、危险操作可回看”的逻辑。关键词自动连链属于 [LinkTitles 扩展](https://www.mediawiki.org/wiki/Extension:LinkTitles)的可选行为，并非 MediaWiki 核心建页语义。Noema 采用手动发起、逐条确认、一次可撤销的当前页扫描；不同仓库与 namespace 的同名候选明确列出，不在保存时或渲染时悄悄插链。

限制：来源编辑窗口若在创建完成前关闭，创建后的链接升级事件无法送达；文件跨 Git 仓库移动后，新仓库的 Git 历史不会自动包含旧仓库的提交。两者需单独的持久化意图和跨仓库历史入口，不能把现有临时广播或新仓库 `git log` 称为完整的跨窗口/跨仓库历史保证。
