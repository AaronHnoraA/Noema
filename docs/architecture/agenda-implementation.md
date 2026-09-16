# Noema Agenda 实装记录

设计依据：[统一 Agenda 研究](agenda-org-integration-study.md)。

## 不可退让的边界

- Markdown / `.noema` DAG 是原生数据源，不生成临时 Org 文件、Org buffer 或镜像。
- 复用 Org Agenda 的展示代码；所有来源导航和修改均通过 Noema 接口。
- 知识库常驻索引；普通项目仅在进入后索引，退出即释放监听和文档缓存。
- 文件通知及明确的保存/修改事件驱动失效；无周期扫描、后台轮询。
- 全局关注是显式 Apple promotion；Apple 通知不能激活或扫描未进入的项目。
- Web、CM6、原生 Emacs Agenda 共用任务语义；不删除现有 Web 视图。

## 实装验收（未勾选即尚未完成）

- [x] 研究、上游 clone、原生只读 UI 原型及禁止 Org 转换的测试。
- [x] 可独立测试的 scope 生命周期、缓存、增量索引和热查询。
- [x] 正式 host API：query / enter / leave / patch / notifications。
- [x] 原生 Emacs 日周、TODO、过滤、导航、完成、计划、截止、优先级。
- [x] 显式项目导航、Perspective 切换/退出与 workspace 关闭驱动 scope 生命周期。
- [ ] Remote target 侧原生来源读取、监听、写入和恢复（已接通真实网关与 helper；真实 SSH 验收待完成）。
- [x] Web Agenda 与原生入口共用 scope 和计算服务。
- [x] WorkNode Agenda 字段在 JS / Go / Elisp 读写，Go 索引迁移保留字段，DAG 和输出不丢失。
- [x] WorkNode `depends` 阻塞、完成、原生调度元数据及来源导航。
- [x] 原生 Capture、批量、自定义块、日志、项目和 Markdown 计时入口。
- [x] WorkNode 原生计时/进度，Emacs 与 Web 共用操作和报表。
- [x] 本机项目退出后的持久 clock、延迟停止回写与显式冲突处理。
- [ ] Remote 计时资源归属、归档/重复 occurrence。
- [ ] Apple EventKit helper、显式 promotion、事件通知、持久化绑定与 outbox/inbox（实现及协议替身集成通过；个人 EventKit/设备同步验收仍待完成）。
- [ ] 冲突与离线恢复、inactive project 延迟回执、不重复注入（持久驱动与真实来源集成已通过；真实 Apple/SSH 断连恢复尚未验收）。
- [ ] 性能与完整集成检查，以及真实 Emacs 中的可用演示。

原型的耗时只衡量渲染；未通过上述验收之前，不宣称完整系统已完成。

## 2026-09-16 初始实现记录

- `server/lib/agenda-index.mjs` 管理显式 scope 与 lease；通知失效、按文件重读，
  热查询不扫描、不重新解析。进入/退出重叠项目会移交监听所有权；退出中止未完成的文件遍历。
- 原生和旧 Web 计算均进入 `buildAgendaFromPlanning`，复用 Go/JS 现有日期、重复、依赖语义。
  Emacs-hosted Web 来源查询已切到注册中的 active scope；兼容的 server publication 路由维持原策略。
- `lisp/noema-agenda.el` 使用 Org Agenda 格式、排序、日期标题；自有键位及版本化 Noema 回写。
  `my/noema-roam-agenda` 默认原生，`my/noema-roam-agenda-web` 保留完整 Web 页面。
- `my/project-switch` 在模块加载后通过激活事件移交项目 lease；其他项目入口及远程适配待完成。
- `my/noema-agenda-plan-node` / `noema-set-node-agenda` 将原生元数据写入 WorkNode，
  正常 JuText 保存持久化；不用新的 prompt 指令。
- WorkNode 的重复 occurrence 尚未实现，明确拒绝 `agenda.repeat`，不会重置历史 DAG。
- 普通 Markdown 的重复任务继续使用既有 Noema 完成语义。
- Apple、远程 scope、完整 capture/clock/bulk、持久化索引及实际性能验收仍待实现。

### 已完成的验证

- `make test`：2,372 项通过；原有 heading-fold 的耗时断言在并发负载下失败。
  单独运行该文件 5/5 通过；串行全套 `npm test -- --maxWorkers=1` 为 2,373 通过、16 跳过。
- 最后新增的重复 ID 边界测试纳入定向套件：31/31 通过。
- `go test -tags fts5 ./...`、`make research-test jupyter-test agenda-test` 通过。
  原生 Agenda ERT 最终为 10/10；JuText 的 Agenda 编辑/同步/撤销/重做测试和 Roam 入口测试 3/3。
- 原生 UI 在当前 Org 9.8.7 与克隆的 Org 10.0-pre 都通过无 Org 转换测试。
- `make build install` 通过：TypeScript、Web 资源和 Go 内核已构建，安装链接已更新。
- `node scripts/check-native-agenda.mjs` 使用临时知识库和项目启动真实 host + Go 内核：
  4 条原生任务共同查询，Markdown 与 WorkNode 均成功回写，DAG/输出保留，离开项目后只剩知识库 scope。
  测试只操作自行创建的临时数据，未访问 Apple 数据或运行 Agent。
- 从上述真实 API 快照进行批处理 Emacs 渲染，验证日视图、带时间任务、阻塞 checkpoint 和 TODO 块。
  当前没有已连接的图形 Emacs server，因此尚未声称完成真实窗口的性能或交互验收。

### 当前后续优先事项

1. 归档/重复 occurrence 和撤销语义。
2. 统一其余代码/导入数据边界。
3. Remote 来源真实 SSH 验收，以及 Apple 权限/设备同步与时区边界。
4. 生产热查询/渲染性能、文档恢复和真实 Emacs 窗口验收。


## 2026-09-16 多范围 Web 与源文件过滤

- Emacs-hosted Web `notes:agenda` 已切到注册中的 active scopes；原生与 Web
  使用同一个索引。每个范围的 Gantt、项目汇总、clocktable 都参与合并，
  显示 ID 使用文件限定 UID；语义写回仍保留源 ID、源位置和文件版本。
- Web Capture、批量状态、依赖和 Markdown 计时使用 scoped writer；Capture
  可写入普通项目的 `inbox.md`，不会向 `.noema` JSON 追加 Markdown。
  批量仅重基于自身产生的文件版本；重复 ID / 无法唯一定位的相同任务拒绝写回。
- Web 来源导航与原生共用 Emacs 导航函数；WorkNode 进入对应节点或无 cell 节点的 Graph。
- 文件遍历和事件入口统一排除隐藏路径，包括 `.lake/packages`。额外排除模式
  由 `my/noema-agenda-exclude-patterns` 配置，scope 根目录以上的隐藏祖先不影响显式项目。
- 此轮仍未补齐：原生 UI 的 capture/bulk/clock 键位、WorkNode clock/progress、
  inactive project 的运行中 clock 持久引用、Remote 与 Apple 桥接。
  运行中 Markdown clock 在项目退出后保留在源文件中，重新进入项目可继续管理；
  目前不声称实现全局唯一持久 clock。

### 此轮验证

- 定向 JS：111/111，覆盖多范围汇总、同文件批量重定位、Capture 目录边界、
  依赖 ID、scoped clock、隐藏路径/自定义排除和 `.config` 下的显式项目。
- 真实 host + Go 内核测试通过：Web 和原生相同 scopes；MD/WorkNode 回写；
  project Capture/batch/dependency/clock；DAG/outputs 保留；退出释放项目。
  fixture 含 `.lake/packages/mathlib/README.md`，没有进入 Agenda 或产生错误。
- `make build install`、`make research-test jupyter-test agenda-test` 通过。
- `make test` 首次运行在并发改动/负载下出现 research 模块重复声明、
  heading/drag 耗时断言及 renderer watch 时序失败。没有修改这些测试的断言。
  工作树的 research 修改稳定后，串行完整套件为 **2,390 通过、16 跳过**。
- `go test -tags fts5 ./...` 首次 model transaction 测试失败；该用例单独通过，
  随后的完整 Go 套件通过。日志保留于 `/tmp/noema-agenda-scoped-*`。
- 当前运行中的用户 host 需要重启才能加载新目录过滤；没有自动中断用户会话。


## 2026-09-16 原生操作与视图

- `c` / `C-u c` 原生 scope Capture；`m/u/U/B` 标记、清除和批量完成/属性修改；
  标记按 UID 去重，部分失败保留失败标记，并显示服务端原因。
- `D` 原生依赖选择器；`I/O` Markdown clock；`v l/k/p` 日志、clocktable、项目。
  与 Web 共用 scoped API。所有写入检查未保存源缓冲区，回调不会覆盖等待期间的新编辑。
- `s/d` 复用 Org 日历选择器，返回原生日期；`C-u s/d` 清除。`?` 显示本模式实际支持的键位。
- 刷新保留同一任务的日期和 occurrence 类型。标记只修改显示属性，不重新格式化或查询源文件。
- `scripts/check-native-agenda-actions.el` 已由真实 host 测试调用：Emacs 命令通过 HTTP
  使用同一 Agenda API，完成 capture、bulk、schedule、clock、dependency，并校验原 DAG/输出保留。
  这是实际批处理 Emacs 到 host/Go 的操作验证，尚不替代图形窗口演示。
- `scripts/benchmark-native-agenda.el` 衡量生产原生 renderer（Emacs 31.0.91 / Org 9.8.7）：
  100 / 1,000 / 5,000 条任务平均渲染 9.3 / 76.7 / 345.7 ms；单次标记 0.13 / 1.31 / 6.94 ms。
  无 source IO；数据不包括文件索引或 GUI redisplay，不能当作完整系统性能结论。

### 原生操作验证结果

- Native ERT：19/19；当前 Org 9.8.7 和克隆 Org 10.0-pre 均通过，
  包括真实 Org 日期解析器保留时间、批量部分失败、重复 occurrence 光标恢复。
- 完整 AaronEmacs 启动后检查 c/m/B/I/O/D/v l/v k 实际键绑定，通过；Evil 未覆盖它们。
- JS scoped index / clock 定向 28/28。真实 host 脚本加入批处理 Emacs 的中文 Capture、
  批量、排期、计时、依赖检查，通过。未运行 Agent，也未访问个人 Apple 数据。
- `make test` 的并发运行出现原有 heading 耗时断言与 optimal-linebreak 时序失败；
  未放宽断言。串行全套 **2,391 通过、16 跳过**。
- `make research-test jupyter-test agenda-test`、`go test -tags fts5 ./...`、
  `make build install` 通过；原生模块字节编译无警告（产物仅在 /tmp 验证）。

## 2026-09-16 WorkNode 原生计时与进度

- `agenda.progress` 为 0–100 的百分比字符串；API 可接收数字并规范化。
  原生 `%`、批量 progress 与 Web Gantt 使用同一个版本检查写回接口。
  原生日程和任务行显示 `[37.5%]` 等进度，不改变 WorkNode 科研状态。
- `agenda.clocks` 原生保存 `{id, from, to?}` 时间段。JS / Go / Elisp
  验证稳定 ID、规范时间、结束不早于开始、节点内 ID 唯一和单一运行段。
  Go SQLite 索引、JuText 同步、结构 undo/redo、JSON 保存均保留这些字段。
- `I/O` 支持 WorkNode 和 Markdown；active scopes 之间共用计时切换。
  同一 `.noema` 中的节点使用 WorkNode ID 重定位，重复对当前唯一运行任务
  按 `I` 保留原时间段。同名节点和改名后的记录仍通过 nativeTodoId 归属；
  缺失或跨文件的原生引用产生诊断，不回退到标题匹配。
- 计时、进度编辑保留 DAG、提示词、Agent 输出、state 和 outcome。
  完成任务保留历史；移除整份 Agenda 元数据前必须停止运行中的计时。
- WorkNode 投影使用节点、边和 cell 映射，避免对每个任务重复遍历整个 DAG。

### 验证与仍待完成的边界

- JS 定向 33/33；原生 ERT 21/21（内置 Org 和 pristine clone 均验证）；
  Go 定向覆盖 75 分钟归属、改名/同名、无效引用和 SQLite 字段保留。
- 真实临时 host + Go + Emacs 命令验证 WorkNode 进度显示、计时切换/停止、
  Web Gantt 待排期项的相同进度，以及原 DAG、所有 cell/输出和科研状态保留。
- `make build install`、完整 Go、`make research-test jupyter-test agenda-test`
  通过；原生模块字节编译无警告。完整 JS 默认并发运行有一个标题折叠耗时
  断言失败（7.97ms / 6ms）；未修改该断言。串行完整套件 **2,395 通过、16 跳过**。
  日志：`/tmp/noema-agenda-work-clocks-*`。
- 仍未实现 inactive project 的持久运行引用、Remote scope 适配、Apple
  promotion/事件同步、归档/重复 occurrence 和完整 GUI 验收。时间段目前使用
  本地分钟精度日期字符串，未声称完成跨时区或夏令时切换语义。

## 2026-09-16 持久计时与延迟回写

- `server/lib/agenda-service.mjs` 在既有 scope index 外协调计时操作，
  `agenda-clock-store.mjs` 使用宿主状态目录中的 SQLite journal 保存轻量引用。
  写入意图先提交；源文件写入后按稳定计时 ID 核对回执。SQLite revision CAS
  拒绝覆盖另一个宿主的更新。完成回执从 journal 移除，历史仍保存在原生源文件。
- 退出项目和 host 重启保留运行引用；任务不会因此混入知识库日程。
  `O` 或切换计时可以停止 inactive project 的引用，保存原停止时间；
  不读取、监听或重新激活该项目。首次进入时核对并应用待写回停止时间。
- 重新进入后允许对未变化的计时段重基于新的文档版本，保留无关内容编辑。
  起始时间、任务引用、身份冲突或源解析失败不会被覆盖。未保存的 Emacs
  source buffer 会阻止写回；Web 发起的计时写回也经现有 gateway 的
  `aaronnote.agenda.protected-sources` 查询内存中的缓冲区状态。
- `v k` 显示来源文件、已记录的开始/停止时间和待处理原因；`R` 重试 active
  project 的停止写回，`K` 明确放弃待处理请求并采用已保存的源状态。
  Web Clock 提供相同行为；inactive project 不提供重试/采用源状态按钮。
  未确认的 start 不会静默丢失或自动重复创建，需查看 Clock 并处理。
- 报表在写回待处理期间采用已记录的停止时间，不继续累计该段工时。
  计时索引对身份建表；同范围查询复用计算快照；反复查询不重写 journal。
  无新周期扫描、轮询或全局 project 发现。

### 验证

- Durable service：11/11，覆盖 MD / WorkNode、inactive IO 禁止、重启、
  原停止时间、文档重定位、未保存缓冲区、源冲突、CAS、意图提交失败、
  已写源但回执丢失、已停止但 journal 确认失败、显式采用源状态。
- 真实 host + Go + Emacs 操作脚本通过；测试在退出后移走整个临时项目，
  停止计时并重启 host，再恢复目录/进入项目。记录和停止时间保留，
  没有 inactive project 激活，源 DAG、所有 cell 和输出保持一致。
- `make test`：**2,407 通过、16 跳过**（默认并发运行通过）。
  `make research-test jupyter-test agenda-test`、完整 Go 与 `make build install`
  通过。Native ERT 24/24，内置 Org 与 pristine Org clone 均验证；
  字节编译无警告。日志位于 `/tmp/noema-agenda-durable-*`。
- 仍待完成：其他项目入口/退出及 Remote 资源适配、Apple promotion 与
  EventKit 通知同步、归档/重复 occurrence、完整 capture 模板、跨时区语义，
  以及真实图形 Emacs 中的完整演示和性能验收。

## 2026-09-16 项目导航生命周期

- `my/project-activate` 维护明确激活的 canonical `/fs:TARGET:/root/` 身份，
  相同身份去重，退出发送 nil。身份切换不遍历文件，也不连接 target。
- 项目 switch/workbench、find/recent/buffer、根目录、Magit、vterm 成功打开后
  激活。后台 `my/with-project-root-context` 不改变激活状态。
- 使用已安装 `perspective` 包真实的 `persp-switch-hook` / `persp-killed-hook`；
  对象关联不受重命名影响，弱引用不保留已删除的 perspective。包内部
  `with-perspective` 的 NORECORD 临时切换不会触发源扫描。
- `my/project-leave` / 项目菜单 `l` 释放当前 scope、解除当前 perspective 关联，
  保留文件 buffer。关闭对应 Remote workspace 清除关联并退出，打开 workspace
  本身不触发扫描。原生 Agenda 的迟到 enter 回执会释放它获得的具体 lease。
- Agenda 消费者删除 `file-remote-p` 分支，host adapter 统一调用
  `remote-client-file-name`；canonical 本机路径及其他共享文件系统的 target
  都由 framework 决定映射。无 client placement 时在源请求前报告不可用，
  不将 target-native 路径冒充本机路径。完整 target-side source service 仍待实现。
- 配置级 Agenda 和日常使用文档已移除过时的“只有 Web Agenda”说明。

### 验证范围

- 项目 ERT 使用真实已安装 Perspective 的切换和临时上下文；Remote workspace
  实际 open/close（connect nil）验证仅关闭当前关联时退出。
- 集成 ERT 验证 project hook → canonical placement → Agenda enter → leave
  的同一 lease；native ERT 验证迟到回执释放、placement 不可用时不发送扫描请求。
- 本轮不声称完成 Remote target IO、Apple 同步或图形端完整验收。
- 项目集成 ERT **12/12**；原生 Agenda **25/25**；
  `make research-test jupyter-test agenda-test`、`make build install` 和
  真实临时 host + Go + Emacs 验证通过。原生模块字节编译无警告。
- 首次并发全量检查中 JS 三个耗时断言失败，Go 一个事务测试失败；没有修改
  断言或无关实现。降低并发后完整 Go 复核通过，JS 串行全套 **2,407 通过、
  16 跳过**。这不证明首次波动根因已消除。日志：`/tmp/noema-agenda-lifecycle-*`。

### Remote 接续约束

现有 `aaronnote.file.read/write` gateway 只接受 Markdown，读取还会建立
host 生命周期的逐文件 watch；不能直接用来扫描项目，否则会越过项目 lease
的释放边界。`readNote` 已支持该 external provider，但 Agenda 的 Markdown
mutation 和 `.noema` notebook service 仍有直接 Node 文件 IO。后续需覆盖
目录发现、版本化读取/原子写入、MD 与 WorkNode 操作、watch 释放和重连的完整
source provider 契约，沿用 Remote workspace/service/watch 所有权。只接通
remote read 或剥离 `/fs:` 前缀不能满足验收。

## 2026-09-16 原生来源计算与存储解耦

- `kernel/noema/planning/source.go` 从原来的 Markdown model 提取原生 source
  transform。现有本机 `MutateMarkdownPlanning` 调用它，继续由 model 负责锁、
  文档版本、ID 分配、初始元数据和持久化。原有共享 mutation / semantic fixtures
  验证 source、UTF-16 span、日期、重复、计时和原文保留，避免建立第二套语义。
- 新增经过原有认证边界的 `POST /api/noema/agenda/source`，只接受文档内容、
  selector 和可选 mutation，返回解析 nodes 或修改后的内容/范围。它不接收来源
  owner 权限，不访问文件、不扫描目录、不分配任务 ID，也不创建临时 Org。
  输入请求最多 32 MiB，原始文档最多 16 MiB；append-todo 的 ID 由调用方提供。
- `createKernelPlanningProvider.computeSource` 暴露该计算能力。生产
  `agendaMarkdownDocument` 将 scope 已读取并计算版本的内容交给 Go，避免再次
  打开文件；普通项目与知识库复用 Go 解析器。来源路径仅保留为投影身份。
  Go 计算失败保持显式失败，不静默降级成另一个项目扫描器。
- 修复 Go 修改返回值与 Node 版本哈希的范围差异：Go 的 `to` 是修改后片段的
  结束位置，重建完整文档哈希需按原 `source.length` 删除旧片段。旧实现会在
  任务文字长度变化后算错哈希，导致同文件批量操作的后续项错误地报告版本冲突。
- 本轮完成计算边界，尚未接通 Remote scope 的读写/监听；UI 对无 client
  placement 的 target 仍明确提示 source service 不可用。原来的 Markdown
  gateway 逐文件 watch 不能代替按 scope 释放的项目来源服务。

### 验证与后续边界

- Go 纯计算 API 在未注册 Markdown box、未提供文件路径的测试中解析/修改
  原生内容；共享 fixtures、调用方 ID、UTF-16、meta summary 排除和无关原文保留
  均验证。Node 定向 **30/30**，包括 logical target 与本机来源使用同一计算接口、
  不重复读取文件、断线不回退，以及版本哈希与真实写入内容一致。
- 完整 Go、`make research-test jupyter-test agenda-test`、`make build install`
  已通过。真实临时 host + Go + Emacs 验证保留 DAG/输出、持久计时和 scope 退出；
  新增 `knowledgeBatch` 验证知识库同文件两个中文任务连续完成。
- 来源识别目前保持原有语义：meta summary 过滤由 `ScanDocument` 负责，通用
  DSL scanner 本身会识别 fenced Markdown 中的命令。代码示例与可执行规划的
  边界仍需与编辑器的 Markdown 结构统一，不能把此次提取视为已解决。
- `make test` 默认并发全套 **2,409 通过、16 跳过**；没有失败项。
  日志：`/tmp/noema-agenda-source-*`。

## 2026-09-16 工作区来源服务与真实网关集成

- 新增通用 `remote-source` / `source-agent.cjs`：通过 `remote-make-process`
  将相对路径发现、SHA-256 版本读写和 `fs.watch` 放到 owning workspace target。
  hidden / dependency / 自定义 glob 在遍历之前剪枝，拒绝越界和符号链接，
  限制单文件 16 MiB。写入用相邻临时文件、再次核对版本和原子替换；不声称
  对任意外部程序持有跨进程锁。无轮询。
- `aaronnote.agenda.source` 网关方法将 client lease 绑定到来源资源；关闭 scope
  或网关断开会释放 helper 和监听。workspace recovery 替换进程，拒绝未完成
  请求并忽略旧 generation 回执。内存中的 Emacs 脏 buffer 检查支持 canonical
  与原生本机文件名的等价匹配。
- `agenda-source-transport` 是 client/target IO 边界，普通路径保留本机存储接口；
  logical 来源走同一 source protocol。`agenda-source-writer` 用已有 Go source
  计算和 WorkNode 纯函数实现 MD / DAG 捕获、修改、依赖、计时及稳定 ID。
  所有改动按源文件串行并核对 revision；批量操作返回真实内容哈希。
- 断开的单个 scope 清除旧任务并显示来源错误，不影响知识库查询；ready / rescan
  事件驱动恢复。退出后没有隐式 IO，迟到 open 回执只释放它自己的 lease。
  普通项目（本机或 routed）修改不再触发客户端知识库的 Wiki 刷新及全量失效。
- 原生 Agenda project adapter 已接受无 client placement 的 logical root。
  `.noema` prompt、cell 输出、DAG 保持原有数据，不经过任何 Org 转换。

### 当前验证边界

- 新增 `scripts/check-routed-agenda.mjs`：临时 Emacs WebSocket 网关 + target helper
  + host + Go + 原生 Agenda 命令的真实集成。验证 MD/WN 修改、Web scope、
  中文捕获、批量、依赖、clock/progress、DAG/输出保留；退出后移走项目目录，
  停表及重启仅使用持久日志，重新进入后才将原停止时间回写。
- 此检查以 `/fs:local:` 走真实协议；非本机 context 的进程路由有契约测试，
  **仍未验证真实 SSH target**，不把本机结果当完整 Remote parity。
- 来源 helper 4/4、Remote ERT 3/3、网关 ERT 7/7、来源保护 ERT 1/1；
  Node scope/transport/durable 回归 33/33，writer 并发/冲突/DAG 回归 4/4。
- Remote 严格字节编译、`make research-test jupyter-test agenda-test`、完整 Go、
  `make build install` 已通过。测试 harness 首次输出缓冲和缺少 `/fs` 注册的
  问题已修正；新测试的 TS import 与 fixture 路径问题已修正。
- 新增 writer 回归之前，默认并发全套 2,414 通过、16 跳过。补入全部用例后
  与真实 host 验证同时运行的全套有一个原有拖选性能断言失败（2,417 通过）；
  不修改断言，单独串行全套复核 **2,418 通过、16 跳过**。这仍不证明并发波动
  的根因已解决。日志：`/tmp/noema-agenda-routed-*`。
- Apple promotion、WorkNode occurrence/归档、capture 模板、跨时区、真实窗口
  和最终性能验收仍未完成，目标保持进行中。

## 2026-09-16 原生 EventKit helper 与 Emacs 客户端生命周期

- 新增 [Apple helper 协议与状态](../../apple/README.md)：Swift 直接使用 EventKit，
  JSON-lines stdio，`EKEventStoreChanged` 和系统唤醒通知驱动，无扫描定时器。
  helper 不读取项目文件、不加载 Org。macOS 14+ 可选构建产物带 usage description
  和 ad-hoc 签名，不增加 Noema.app 或第二个产品 shell。
- 支持显式授权、读取可选列表/日历、按 item ID / external ID / Noema UUID token
  核对绑定，以及带 revision 的 put/remove。通常按 ID 读取；身份失效时限定到
  选定提醒列表或最长一年的日历窗口。标题不作身份键；移动/token 改动/重复规则
  改动报冲突。范围内 missing 不视为全局删除，不删除 Noema 源。
- 首次创建需显式 `allowCreate`，未来持久驱动必须先记录尝试。丢失回执后
  使用相同 token、禁止再次创建，存在相同对象则确认，不存在则保持未确认。
  这避免把不确定的创建结果当作不存在而反复注入。
- 日期保留 civil date、可选时间、命名时区/浮动语义和 all-day 结束边界；
  拒绝非法日期及 Sydney DST gap。更新完成项标题不重新赋值 completed，
  避免 EventKit 重置 completionDate。重复小时歧义、完整来源时间字段投影仍待验证。
- 根配置新增 `my/noema-agenda-apple-enable` / `disable`。私有桥接模块通过
  `remote-make-client-process` 创建 helper，资源属于独立 client workspace，
  与当前项目无关。gateway 禁止请求授权或隐式启动；请求拥有 deadline，
  停止/恢复拒绝 pending 并忽略旧 generation 回执。订阅由 gateway client 拥有。
- **尚未完成**：Node 宿主的 durable binding/outbox/inbox 驱动、三方字段合并、
  inactive source 延迟回写、推广/取消命令、Web/原生全局关注与冲突面板。
  当前启用 helper 不会同步已有任务，不能视为全局关注功能已经可用。

### 此轮验证

- Swift 编译/签名、civil date/DST self-test、真实 stdio 的状态/无效授权类型检查通过。
  Emacs 测试验证真实客户端进程、独立 workspace 资源、关闭/恢复、pending timer
  释放、迟到回执忽略和 subscriber 生命周期。均未请求系统权限、读取个人条目，
  未创建测试提醒/日历事件，也没有验证真实 Apple/iCloud 双向写入。
- `make test` 默认并发 **2,418 通过、16 跳过**；完整 Go、
  `make build install`、`make research-test jupyter-test agenda-test` 已通过。
  日志：`/tmp/noema-agenda-apple-*`。完整目标及 Apple 端到端验收保持未完成。

## 2026-09-16 持久全局关注、原生回写与界面闭环

- `agenda-attention-store` 使用 SQLite WAL/FULL 保存有界的绑定、外部回执和
  待发送/待回写意图；更新核对 journal revision。仅存身份与投影字段，不存
  原始 Markdown、提示词、输出或 DAG 副本。重复关闭幂等。
- `agenda-attention` 在外部副作用之前提交意图。首次注入丢失回执后按原 token
  恢复，不盲目再次创建。源端和 Apple 分别保留字段基准，避免优先级投影损耗
  引发回声写入。不同字段合并，同字段冲突保留双方。
- 源回执只确认对应的写入版本。尚未推送 Apple 的字段继续保留旧源基准；
  后续 Apple 修改使 outbox 失效时，重新合并不会吞掉原本待推送的本地修改。
  回写后立刻发生的源修改不能被误认为已同步；不确定的重复完成不会再次推进。
  确认发生于写入前的保护失败可以在保存/进入事件后重新合并，读取失败不能
  被用来推断先前写入从未发生。
- `agenda-attention-source` 只从已进入 scope 读取，按稳定 native ID 查找。
  Markdown 无 ID 时先原生补入 ID；日期、标题、完成状态按 source revision
  回写，保留正文。WorkNode 修改经原有 notebook writer，保持 cells、提示词、
  输出和 DAG。项目退出期间只更新持久回执，不打开来源。
- Native `P` 与 Web Promote 选择目标列表/日历；`v a` / Global attention
  提供同步、冲突解决、取消提升、仅解除绑定及显式源跳转。Calendar 要求
  sche/end 明确区间；提醒使用选定 ddl/sche。连接丢失时标明“已保存回执”，
  不把旧 synced 状态当成实时连接证明。
- 全局关注刷新只读 journal。原生隐藏窗口延迟刷新，请求 token 防止旧回执
  覆盖重新打开的模式；Web 不会把任务快捷键作用到旧 scope 的缓存任务。
  源跳转等待 project entry 完成，再按完整任务身份获取 source/cellIds；项目
  退出、宿主停止、被新跳转替代时取消旧回调，不通过宽松 ID 正则猜定位点。

### 验证与尚未完成的边界

- 持久同步/并发 journal 17 项、真实原生来源 4 项、Web 行操作 3 项均通过。
  包括创建回执丢失、重启、项目关闭期间手机完成、同字段冲突、不同字段并发、
  递延回执后再次变更、重复任务只推进一次、脏 buffer、原生标题及 DAG 保留。
- 原生 Agenda/全局关注契约共 31 项通过；新全局关注 5 项覆盖无 Org 来源、
  隐藏刷新、旧请求隔离、多个可选列表和显式导航。项目进入回调共用 lease、
  退出取消和迟到释放单独验证。
- 临时真实 Emacs WebSocket 网关 + Remote 来源进程 + host + Go + 原生命令
  验证通过，`durableAttention: true`。Apple 一侧是测试协议替身；未申请个人
  数据访问权限、未读写个人 EventKit 条目，也未验证 iCloud/设备传播。
- `make test` 默认并发 2,443 通过、16 跳过；完整 Go、构建/安装和原生模块
  严格字节编译通过。根配置 `make research-test jupyter-test agenda-test`
  通过，其中真实跳转的集成单测验证等候 entry、精确任务记录以及旧 scope 查询
  取消。`make agenda-apple-test` 的 Swift/进程生命周期验证亦通过。
  日志位于 `/tmp/noema-attention-receipts-*`。
- 全部目标仍未完成：真实 Apple/SSH/GUI 端到端、DST 重复小时与跨时区源
  表达、同任务同日历多个时间块、WorkNode occurrence/归档、capture 模板、
  fenced Markdown 示例分类及最终闲置/大库性能验收仍需继续。


## 2026-09-16 原生 Markdown 文档边界

- `scanPlanningDocument` / Go `ScanDocument` 在原文上标记 Markdown 代码区，
  再调用原生 planning grammar。JS 复用 CM6 使用的 Lezer Markdown；Go 的
  goldmark v1.8.6 只提供原始 byte segment，不替换 Lute 渲染 AST，不生成 Org。
- 围栏（包括嵌套 quote/list、未闭合围栏和 info string）、缩进代码、行内代码
  与转义命令不参与任务/项目/clock 索引。代码里的伪 meta/summary 分隔符不会
  改变真实摘要边界；真实任务标题中的行内代码和 proof 正文保持原文。
- 任务起点先做文档资格检查，代码中的未闭合 planning block 不能吞掉后面的
  真实块。JS/Go 共用 26 个文档 fixture；UTF-16 位置保持原文索引，包含 Unicode
  单行多任务和 CRLF。Go fixture 并行运行并通过 race detector。
- Markdown 写入、捕获、ID 定位和 clock 定位使用完整文档语义。被移动到代码
  区的旧任务不能通过位置/源文回退写入；捕获到未闭合围栏在保存前拒绝。
  CM6 当前文件 Agenda 表单等待用户期间也检查原文和任务资格，防止旧位置覆盖。
- Go 原有 span 计算逐任务重扫前缀，并逐字符分配 UTF-16 临时 slice；改为
  按有序节点累计偏移和无分配字符计数。性能数据只代表合成文档扫描，不能
  替代整库、闲置或 GUI 验收。

### 本轮未覆盖的边界

旧 Roam 当前文件/离线 TODO 正则回退仍待迁移；HTML/math、非语义 org-env
和显式导入文本的统一分类也不能仅靠本轮 CommonMark code 测试证明。
真实 Apple/SSH、归档/重复 occurrence、capture 模板和最终性能验收仍未完成。


### 本轮验证结果

- 完整 JS 套件串行运行：**2,475 通过、16 跳过**。初次与构建并行运行时，
  drag-select 测试达到 5 秒超时，HTML link-linearity 耗时比例断言失败；两文件
  单独复核 55/55 通过，最终串行全套通过。未放宽断言。
- Go 全套 `go test -tags fts5 ./...`、planning `-race`、`make build install`
  均通过。首次构建发现新测试引用的纯 mutation 模块缺失类型声明，已补齐。
- 根配置 `make research-test jupyter-test agenda-test` 全部通过。
- 真实 Emacs 网关/Remote local source process/host/Go 集成通过：知识库和
  project 来源均无代码示例，未闭合围栏 capture 拒绝且源文件字节不变；既有
  Markdown/WorkNode 修改、DAG、clock、显式关注和项目退出检查继续通过。
  `routedSource` 验证的是 `/fs:local:`，Apple 为协议替身，不能代替真实 SSH
  或个人 EventKit/iCloud 验收。
- Apple M2 Max 合成扫描 benchmark：100 个任务约 **0.236 ms**，1,000 个
  任务约 **2.545 ms**（每个任务同时配一个代码示例，后者 81 KB）；后者
  5.25 MB/op、26,083 allocations/op。扫描包含源区间分类和原生 planning，
  不含目录遍历、Go/Node 通信、依赖求值或 GUI 绘制。
- 证据：`/tmp/noema-literal-full-test-final.log`、`noema-literal-go.log`、
  `noema-literal-build-final.log`、`noema-literal-emacs.log`、
  `noema-literal-host.log`、`noema-literal-benchmark.log`。


## 2026-09-16 Roam 与原生 Agenda 的来源统一

- 删除 Roam 的 TODO 正则回扫和本地状态前缀写入。任务列表异步使用
  `agenda:query-active`，空列表是成功结果；断连保留旧视图并报告失败，
  不启动 CLI 重新遍历知识库。现有 Roam UI 保留，行身份改为原生 UID。
- 状态、元数据、依赖写入复用 `noema-agenda--patch/--write`，携带 scope、
  UID 和源版本，并沿用 modified-buffer 保护与 clean-buffer reconcile。
  旧 priority/due/scheduled UI 字段映射为 prio/ddl/sche；重复完成走同一
  semantic writer，不在 Emacs 改写字符串。依赖目标限定兼容的活动范围。
- 新 `agenda:document` 只计算调用者提供的 Markdown 快照，不按 file 身份
  打开源文件，不分配 ID，不启动 scope/watch，不把未保存任务放入索引。
  只接受 Markdown 和 16 MiB 以内的 UTF-8 内容；`.noema` 保持 WorkNode 入口。
- `F` 当前文件导航异步读取当前缓冲区（含未保存内容），使用 Go 解析与
  共用 planning projection。待回执期间编辑、改名、关闭缓冲区或重复发起
  请求会使旧结果失效；切换窗口/缓冲区后不弹出迟到选择框。
  UTF-16 位置按原缓冲区单次向前换算，emoji 和相同任务源文不导致定位偏移。
- 修复旧 `--todo-field` 用 `plistp` 判断数据形状的问题：偶数个字段的 alist
  也可能满足 `plistp`，导致源位置/日期丢失。按 keyword 判断 plist，Agenda
  读取器同时支持 hash/alist/plist。
- 新任务接口没有轮询、临时 Org 或第二套 DSL；一般 Roam 笔记管理的旧
  CLI 兼容入口没有在此轮重写。

### 验收范围与下一步

- 临时真实 host + Go + Emacs 根配置验证了未进入的 `/fs:never-entered:`
  缓冲区快照、代码示例排除、源位置、scoped 优先级和重复完成。
  计划从 2026-09-15 按 `+1w` 推进至 2026-09-22，状态恢复 todo。
- 该测试仍使用实际 Remote local 来源进程和 Apple 协议替身，不能代表真实
  SSH 或个人 EventKit/iCloud 验收。完整目标保持未完成。
- 继续补齐 capture 模板、归档/occurrence、HTML/math/导入分类、主 Agenda
  导航的重复源文情况，以及真实 GUI/设备/大库闲置性能验收。


### 本轮完整验证

- `make test` 默认并发：**2,479 通过、16 跳过**。新 snapshot 4 项测试覆盖
  只传 content 给原生计算、远端身份无 IO、无 scope/写入、拒绝 `.noema` 和
  大小/位置错误，以及内核不可用时不另启解析器。
- 根配置 `make research-test jupyter-test agenda-test` 全部通过；其中 Roam
  **48/48**，原生 Agenda/attention 31/31。`agenda-test` 现包含 Roam 回归。
  覆盖空列表、断连、未保存/缩窄 buffer、UTF-16、迟到/关闭/切换、精确重复
  源文导航、scoped 写入失败和稳定行身份。最初复核中发现并修正 alist/plist
  误判；两个旧 API mock 补上已有 timeout 可选参数，旧 writer 断言按新版
  scoped 契约更新，没有放宽源文保护。
- `make build install`、完整 `go test -tags fts5 ./...`、parens 和 diff 检查通过。
- `scripts/check-routed-agenda.mjs` 新增真实根配置 Roam 操作子进程，结果
  `roamSnapshotAndWrites: true`；同时保持 `routedSource`、`durableAttention`、
  `preservedDAG` 等既有检查通过。UI 生命周期的竞态使用 ERT 验证，批处理
  集成没有替代真实图形窗口演示。
- 日志：`/tmp/noema-roam-document-full-test.log`、`noema-roam-document-emacs.log`、
  `noema-roam-document-host.log`、`noema-roam-document-build.log`、
  `noema-roam-document-go.log`。

## 2026-09-16 共享 Capture 模板与主 Agenda 精确导航

- host 提供纯数据 capture catalogue；原生 `c` 与 Web New todo 共用 Task、
  Deadline、Appointment，并统一经 scope、路径排除、版本和源 writer 校验。
  模板可配置字段、required/defaults、knowledge-only 范围和 `%Y/%m/%d`
  目标文件，但不能执行代码、激活项目或生成临时 Org 来源。
- Web 使用一个由 Agenda 生命周期拥有的 modal。提交期间禁止重复写入；服务端
  拒绝路径、日期或版本时保留全部输入并显示错误，成功后才关闭。关闭 Agenda
  会取消表单，迟到回执不再改动 UI。
- 原生 capture 使用 Org calendar 作为输入控件，写入仍是 Markdown。失败草稿
  保留在 Agenda buffer，再按 `c` 可按新 catalogue revision 继续编辑；成功后
  清理。写入期间拒绝第二次提交，并沿用已修改源 buffer 保护。
- 主 Agenda 的 Markdown `RET` 先对当前编辑 buffer 做只读原生文档计算，再按
  稳定 ID 或唯一 live source 定位。代码示例不参与匹配；同 revision 才允许以
  原始 UTF-16 位置消歧。编辑、改名、切换窗口、新请求都会使旧回执失效。
- `.lake`、其他隐藏路径和标准依赖/构建目录在遍历和文件事件入口排除；实际
  Noema 知识库只读发现 30 个合格候选，没有依赖目录泄漏。

### 验证与剩余边界

- 隔离完整 JS：246 files / 2,489 tests 通过，7 files / 16 tests 跳过；并行
  Emacs 回归时两项已有性能阈值抖动，隔离复跑 8/8 通过。
- 原生 Agenda/attention/capture 41/41、Roam 48/48；真实 Emacs → Remote local
  source → host → Go 集成报告 `captureTemplates`、`nativeSourceNavigation`、
  `preservedDAG` 全部通过。`make build install` 和 Go `-tags fts5 ./...` 通过。
- 这仍不是完整终态：归档/refile、WorkNode occurrence/habit、原生撤销、真实
  SSH、个人 EventKit/iCloud、跨时区多事件块、图形窗口和大库闲置验收尚待完成。
