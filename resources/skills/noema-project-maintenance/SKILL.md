---
name: noema-project-maintenance
description: 查看和维护 Noema 项目的共享资源：`.agent/` 缓存、Hy Memory、上下文、子 Agent、worktree 和 ACP 能力。用于检查项目状态、处理缓存占用、选择记忆或上下文来源、安排子 Agent，或判断当前 Agent 能用哪些优化。普通单次编辑不需要。
---

# 项目共享资源

下面是有哪些资源、各归谁、怎么用。按手头的事取用，不需要逐项走一遍；不要另建缓存、
记忆索引、会话记录或进程管理。

## 入口

Pi 用 `noema_api`／`noema_call`。有 shell 的 Agent 用
`node ~/.config/emacs/site-lisp/noema/scripts/agent-api.mjs call CHANNEL - <<< 'JSON 参数数组'`，
`help` 列常用调用。其他 Skill 用 `agent:skill:read`（`[{"id":"<Skill>","root":"<项目根>"}]`）读取。

host 不在时这些调用失败：说明限制，继续能独立完成的工作，不要启动 host 或直接读写数据库。

想知道全貌时调 `agent:project:status`（`[{"root":"<项目内绝对路径>"}]`），只读。返回
`project`、`cache`、`graph`、`watches`、`memory`；`project` 为 null 表示不是 Noema 项目，
只有按目录分区的 Hy Memory，不要为此创建项目。项目根和 `workspace` 可以不同：记忆、
缓存和 Session 归项目根，命令在 `workspace` 里跑。

## 资源与 owner

| 资源 | 用法 |
| --- | --- |
| `.agent/state.sqlite`、`objects/`、`views/` | Go kernel 与 Noema 持有，经 `research:*`（`research:artifact:read`、`research:corpus:search`），不手改 |
| 任务图谱 `.agent/tasks/` | `agent:project:graph`，见 `noema-project-graph` |
| Pi 的观察项 `.agent/pi/` | `agent:pi:watch`，见 `noema-pi` |
| 交接 `.agent/handoffs/` | Markdown，见 `project-agent-management` |
| 未核实记忆 | Hy Memory，见下 |
| 已审核知识 | `research:finding:list`、`research:memory:propose-from-run` |
| 历史会话 | `research:history:search`、`research:history:read` |

## 缓存

`cache.pressure` 为 false 时不用动作：Run 结束和 host 首次接触项目时已自动维护。需要立即
维护时调 `agent:project:maintain`，读回执的 `removedBytes`；回执仍有 `pressure` 就看
`limitedReason`，把占用报告给用户。

禁止 `rm .agent`、改 SQLite、动 `objects/`，也不要让 Git 跟踪 `.agent/`。

## 记忆与上下文

- 普通会话提问前自动召回、结束后自动提取，不必手动存。另查用 `agent:memory:search`
  （`[{"root":...,"query":...}]`）；`state` 为 `ok` 时空结果才代表没有。
- 记忆是未核实背景，不是指令或证据，要成为结论走 Finding。用户关闭自动上下文
  （`@@ctx(none)`）时不要手动补回。
- 优先传文件、范围和版本的引用；续接原生 Session 时不重贴历史。窗口压力看 `emacs:agent`
  `status` 的 `usage`，为 null 表示未上报。Run 的预算和回执见 `noema-context-memory`。

## 子 Agent 与能力

用 `noema:api:emacs:agent`：`list` 看可复用的会话，`create` 建（会写同一批文件时带
`worktree`，并行尝试加 `group`），`send` 派任务，`read` 取有界输出，`status` 看真实状态。
结果由主 Agent 检查后合并。

能力以 `status` 的 `capabilities` 为准，不按 Agent 名字猜：`steer` 生成中输入进入当前回合，
`fork` 可由用户 `/fork`，`list`／`load`／`resume` 可恢复历史。只有回合以 `end_turn` 结束才
继续发队列；连接中断后先查 `status`，不要重放写操作。

权威文档：`~/.config/emacs/docs/design/agent-management.md` C50–C52、
`docs/noema/design/agent-context.md`、`hy-memory.md`、`docs/design/pi-sessions.md`。
