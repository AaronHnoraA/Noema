---
name: noema-project-run
description: 按任务图谱推进工作、分派子 Agent、处理图谱异常。用于“继续这个项目”“跑完计划”“把任务派出去”。
---

# 推进

自己做：`show` 读正文、`feedback`、上次的 `sessions`，能恢复原会话就恢复。只做范围内的事，
范围外的发现用 `plan` 加任务。做不下去就 `release` 或 `state blocked` 写明卡在哪，不要占着。

协调时只路由和集成，分工按 `project-agent-management`：

1. 优先派能解锁最多下游的 `ready` 任务；先替它 `claim` 再说明。
2. 子 Agent 用 `noema:api:emacs:agent`，优先复用做过这条线的会话，写同批文件时带 `worktree`。
3. 每次 `submit` 后重读 `status`：图谱和实际产物是权威，子 Agent 说完成不算。
4. 评审派给另一个 Agent。

失败后按原因决定，不自动重放可能有副作用的操作。异常跑 `check`，按每条的 `fix` 处理。
