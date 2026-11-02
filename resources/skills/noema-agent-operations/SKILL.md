---
name: noema-agent-operations
description: 在 Emacs 中创建、查找、跟进或介入正在运行的 Agent，使用真实 ACP 会话、队列和状态；也用于核对 Agent 的执行结果。普通文档写作不需要此 Skill。
---

# 操作已有 Agent

用 `noema:api:emacs:agent`，参数不确定时 describe 它。查询不启动 Agent，也不抢焦点。Emacs 拥有 ACP client、buffer、队列、
审批与原生会话；Noema 的 Research Run 有自己的执行 owner。

- 先 `list`，按项目根、target 和任务确定对象，再 `status`。后续调用同时携带
  返回的 `buffer` 和 `nativeSessionId`；名称相同不代表原来的会话仍存在。
- 接管已有工作先 `read` 有界输出并查看当前状态、排队数量和错误。复用现有
  会话，不为“介入”另开一个 Agent 或重复发送原任务。
- `status` 还返回 `capabilities`（`list`、`load`、`resume`、`fork`、`steer`）和 `usage`
  （未上报时为 null）。能力以此为准，不按 Agent 名字猜。
- 可能写同一批文件的子 Agent，`create` 带 `worktree` 隔离，并行尝试加 `group`。
- 新补充默认 `send`：忙时排队，不中断正在生成的回合。真正需要即时 steering
  时，先查看会话原生能力和当前命令；公共 API 没有 steering 参数时不能伪造。
  用户明确要求中断才走 `stop`，确认终态后再决定后续任务。
- `create` 只创建会话，不代表已派发任务；`send` 被受理、排队、开始运行和
  完成分别判断。状态未知、超时或 client 断开后先重新查询，不自动重放写操作。
- 以当前文件、范围和产物路径交付上下文。没有明确要求就保持后台；显式 `show`
  才显示窗口。隐藏窗口不停止执行；结束会话会处理未发送输入和排队任务。
- 权限、问答与审阅属于实际用户控件；不伪造 human decision API 的答案。

需要底层 ACP 的 list/load/resume、fork、权限、队列或重连语义时，按需读取
`~/.config/emacs/docs/design/agent-management.md`。Research Run 的停止与身份见
`~/.config/emacs/docs/noema/design/codex-session-lifecycle.md`。没有提供 ACP 连接
工具时，通过受支持的 Emacs API 操作，不另建连接、不编辑内部状态或 native ID。

审计执行结果时，对照用户目标、实际文件和验证回执检查结论。区分已经观察到
的问题与推测，给出文件位置、触发条件和影响；按风险先后处理。修复请求已有
授权的可逆修改直接完成。审计不自动扩大为重构、提交或另发任务。
