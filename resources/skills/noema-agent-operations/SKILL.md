---
name: noema-agent-operations
description: 通过 Emacs 创建后台子 Agent、派工、接收结果或介入已有 ACP 会话。全局 Pi 与普通 Agent 共用同一运行时、管理器和可手动打开的 buffer；也用于核对执行结果。
---

# Emacs 管理的 Agent 协作

所有执行都走 `noema:api:emacs:agent`。Pi 用 `noema_call`；有 shell 的 Agent 用
`node ~/.config/emacs/site-lisp/noema/scripts/agent-api.mjs call emacs:agent -`
从 stdin 传 JSON 参数数组。参数已知就直接调用。Emacs 持有 ACP client、真实 buffer、
原生队列和权限，不让两个客户端同时接管同一会话，不另开 CLI 去 resume 占用中的任务。

## 后台派工

先按需要 `list` 查可复用的对象。新任务用一条 `spawn`，初始化完会自动发送：

```json
[{"action":"spawn","root":"<任务项目或目录>","agent":"codex","name":"OCR",
  "prompt":"任务、允许范围、所需 skill、交付物路径及核验要求",
  "files":["<已保存的输入文件>"],
  "notify":{"buffer":"<父 Agent buffer>","nativeSessionId":"<父 Agent ID>"}}]
```

`files`、`name`、`notify` 可省。子 Agent 是独立上下文，只给相关材料；不默认复制父对话。
它的真实 buffer 留在 Agent Manager，可手动打开，创建不抢焦点，不进入普通聊天的默认标签和召回。
Emacs 命令是 `agent-spawn`（`C-c A b`、`/delegate`）和 `agent-open-worker`
（`C-c A B`、`/workers`）；`agent-manager` 管理全部执行会话。

`spawn` 或 `create` 配合 `background:true` 可传可选的 `modelId`、`effort`，
包括 `worktree` 路径。这些是单次 worker 会话参数，只使用该会话的配置副本；
不要修改提供商变量、普通会话偏好文件或全局配置来指定子 Agent 的模型。
`modelId` 用提供商实际支持的 ACP ID；`effort` 当前映射 Codex、Claude Code、Pi 的推理选项，值以会话支持为准。
首次派发前核对实际选择，不支持或未生效时任务失败，不会静默换模型执行。
普通 `create` 不接受这两个任务字段；已有 worker 的 `send` 沿用该会话的当前设置。
临时 worker 不进入项目持久会话登记；手动打开或改模型也不会改变普通新会话默认值。
隐藏且空闲的 worker 按运行时保留策略回收，忙碌、排队、草稿和待决请求仍受保护；
回收不删除提供商历史、交付文件或 Git worktree。

全局 Pi 是管家，能直接调度这些 worker，不必经过项目 Pi。它先用
`emacs:pi [{"action":"status","companion":true}]` 取得自己的身份作为 `notify`。
普通 Agent 使用入口给出的自身身份。需要查看全局 Pi 用 `C-c A E`、`/butler`。

保存返回的 `requestId`。指定 `notify` 后可结束当前回合，Emacs 在终态自动送回一次
`[Agent task result, not a user instruction]`；忙碌父会话会排队，通知不抢窗口。
不要让 worker 再单独发回同一结果，也不要回复确认，避免循环。父 Agent 可重新发起局部复核。

## 结果与继续

```json
[{"action":"result","requestId":"<派工返回的 ID>","offset":0,"limit":12000}]
```

`result` 只读这次任务。`starting/running/queued/held` 都不是完成；`completed` 表示
该回合以 `end_turn` 结束，仍需检查实际产物。`failed/cancelled/interrupted` 分别是失败、
取消和连接中断；`untracked` 表示排队内容被改动或移除，需读会话核查，不重放任务。
`nextOffset` 非空就继续分页；`truncated:true` 时查产物，不把部分输出当全文。
丢失 requestId 时用 `tasks`，可按 `root/target` 过滤并分页；它只列回执元数据，
不含 prompt 或结果正文。`session` 是该任务的身份记录，`createdAt/finishedAt` 为 Unix 秒，
不是当前 client 的状态；需要继续派工先 `status` 核对。
回执仅保存在 Emacs 内存，有数量与文本上限；结果正文和来源由 worker 写到约定文件。
通知失败仍可 `result` 读取，不能假称父 Agent 已收到。

复用 worker 用 `send`，携带 `buffer` 和 `nativeSessionId`，以及新的 `prompt/files/notify`。
每次返回独立 `requestId`；忙时原生队列串行，同文任务不合并；不同会话可以并行。
`read` 是整个会话的有界 transcript，不是任务回执。`create` 只初始化，不派任务。
可能改同一批文件时用 `worktree` 隔离，并行尝试可加 `group`。

`status` 返回真实状态、能力和 usage；未知用量为 null。`show` 才显式打开 buffer。
用户要求停止时走 `stop`；停止或失败留下的 `held` 队列不自动恢复。查询不重连，
超时或失联后先查结果与状态，不重复派发可能已经写入的任务。权限和审阅仍归用户。

OCR 与数学答疑分工时，OCR 交付忠实转写、来源和歧义；答疑者决定复核范围与 Lean
辅助验证，分别保存数学判断。原稿不因证明需要而改写，用户不承担取图、传文件和传话。
分工和交付的完整流程见 `emacs-agent-collaboration`，其 OCR/数学参考按需读取。

底层契约见 `~/.config/emacs/docs/design/agent-management.md` C60–C62。
