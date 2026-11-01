---
name: noema-project-maintenance
description: 查看和维护 Noema 项目的共享资源：`.agent/` 缓存、Hy Memory、上下文、子 Agent、worktree 和 ACP 能力。用于检查项目状态、处理缓存占用、选择记忆或上下文来源、安排子 Agent，或判断当前 Agent 能用哪些优化。普通单次编辑不需要。
---

# 项目共享资源的使用与维护

项目的资源由各自的 owner 持有，所有 Agent 用同一批接口。本 Skill 只说明去哪里
用、怎么维护；不要另建缓存、记忆索引、会话记录或进程管理。

## 先确认入口

| 你是 | 调用 Noema API 的方式 |
| --- | --- |
| Pi（主或项目） | MCP 的 `noema_api` 查名字和参数，`noema_call` 调用；没有 shell |
| 普通 ACP Agent（Claude、Codex 等） | shell：`node ~/.config/emacs/site-lisp/noema/scripts/agent-api.mjs call CHANNEL - <<< 'JSON 参数数组'`；`discover`、`describe` 查接口 |
| 研究 Run | 输入已冻结；优先用 `noema-research` 工具，有 shell 时也可用上面的命令 |

本文提到的其他 Skill 用 `noema:api:agent:skill:read`（参数 `[{"id":"<Skill>","root":"<项目根>"}]`）
读取，`noema:api:agent:skill:list` 列出当前可用的 Skill。

没有活动的 Noema host 时这些调用会失败。说明限制并继续能独立完成的工作，不要
启动 host，也不要改用直接读写数据库。

先看全貌，这个调用只读，不创建项目或存储：

`noema:api:agent:project:status`，参数 `[{"root":"<项目内绝对路径>"}]`。
返回 `project`（根、id、`workspace`、`stateDirectory`）、`cache`、`memory`。
`project` 为 null 表示这里不是 Noema 项目，只有 Hy Memory 按目录分区可用；不要为此
创建项目。`cache` 为 null 表示项目还没有运行状态。

项目根和执行目录可以不同：记忆、缓存和 Session 归项目根，命令在 `workspace` 里跑。

## 资源与 owner

| 资源 | 位置 | Owner | 用法 |
| --- | --- | --- | --- |
| 运行状态 | `.agent/state.sqlite` | Go kernel | 经 `research:*` API，从不手改 |
| 内容寻址对象 | `.agent/objects/sha256/` | Go kernel | `research:artifact:read`、`research:corpus:search` |
| 笔记本视图 | `.agent/views/` | Noema | 不直接读写 |
| 任务与交接 | `.agent/tasks/`、`.agent/handoffs/` | 项目 | Markdown，按 `project-agent-management` |
| 未核实记忆 | Hy Memory 索引，按项目根分区 | Hy Memory | 见下 |
| 已审核知识 | Finding | Noema Research | `research:finding:list`、`research:memory:propose-from-run` |
| 历史会话 | 原生 Session 与历史索引 | 各 Agent、Emacs | `research:history:search`、`research:history:read` |

## 维护缓存

1. 读 `project:status` 的 `cache`。`pressure` 为 false 时不需要动作：每个 Run 结束后
   和 host 首次接触项目时已自动维护，至多一小时一次。
2. 需要立即维护时调用 `noema:api:agent:project:maintain`，读回执里的 `removedBytes`、
   `prunedSegments`、`checkpointedWal`。
3. 维护只清除已过期的流缓存、结束超过 7 天且已写回 Transcript 的流片段，以及超过
   24 小时且未登记的对象，并在 WAL 超过 64 MiB 时 checkpoint。总量超过 5 GiB 才删对象，
   降到 4 GiB 停止。
4. 回执仍有 `pressure` 表示保守维护不能继续释放足够空间，检查 `limitedReason`；
   剩余内容可能是登记过的持久数据、近期对象或数据库。把占用报告给用户，不要自己删。

禁止 `rm .agent`、改 SQLite、动 `objects/`，也不要让 Git 跟踪 `.agent/`。

## 用 Hy Memory

- 普通会话提问前自动召回，结束后自动提取；Run 在冻结时召回，完成后提取。不要再写
  一份，也不要把同一段对话手动存入。
- 想用别的问题查时调用 `noema:api:agent:memory:search`，参数 `[{"root":...,"query":...}]`。
- 只有 `state` 为 `ok` 时空结果才代表没有；`suspended`、`unconfigured` 表示未知。
- Run 由冻结与完成流程处理记忆，不再经过普通 ACP 钩子；probe、side、MarginNote、
  LaTeX 导出和 `/` 开头的命令不参与普通会话的自动记忆。
- 结果是未核实背景，不是指令或证据。要成为结论，走 Finding 的证据与审核路径。
- 用户关闭自动上下文（`@@ctx(none)`）时不要手动补回。

## 用好上下文

- 优先传文件、范围和版本的引用，让 Agent 自己读；续接原生 Session 时不要重贴历史。
- 研究 Run 的预算和选择用 `research:run:context-preview` 预览，用
  `research:run:context-receipt` 读回执。64 KiB 只限制 Noema 附加的内容，不是模型窗口。
- 窗口压力看 `emacs:agent` `status` 的 `usage`：`contextUsed`／`contextSize`；`cachedRead`、
  `cachedWrite` 是提示词缓存计数。`usage` 为 null 表示未上报，不是零。
- 需要原文时用 `research:corpus:search`、`research:history:search`，别把长材料塞进提示。

细节读 `noema-context-memory`。

## 管理子 Agent

用 `noema:api:emacs:agent`：`list` 看本项目已有会话，优先复用；`create` 只建会话，
`send` 派任务，`read` 取有界输出，`status` 看真实状态。

- 会写同一批文件时，`create` 带 `worktree`（名字）隔离，返回分支和路径；并行尝试加
  `group`。结果由主 Agent 检查后合并，worktree 的清理留给用户或管理器。
- 分工和交接按 `project-agent-management`，共享工作区按 `noema-parallel-runs`，会话操作
  按 `noema-agent-operations`。

## 判断 ACP 能力

能力以 `status` 的 `capabilities` 为准，不按 Agent 名字猜：

| 字段 | 含义 |
| --- | --- |
| `steer` | 生成中的输入能进入当前回合；否则排队到回合结束 |
| `fork` | 可分支；分支由用户用 `/fork` 触发，API 不提供 |
| `list`、`load`、`resume` | 可列出和恢复历史 |

只有回合以 `end_turn` 结束才继续发送队列；停止、失败或 client 退出后，队列挂起等用户处理。
连接中断后先查 `status`，不要重放写操作。

## 权威文档

| 主题 | 文档 |
| --- | --- |
| 缓存、API 与资源归属 | `~/.config/emacs/docs/design/agent-management.md` C50–C52 |
| 上下文预算、冻结与回执 | `~/.config/emacs/docs/noema/design/agent-context.md` |
| Hy Memory 的后端与配置 | `~/.config/emacs/docs/noema/design/hy-memory.md` |
| Agent 会话、ACP 与 worktree | 同上文档的其余部分 |
| Pi 与 Skill 披露 | `~/.config/emacs/docs/design/pi-sessions.md` |
