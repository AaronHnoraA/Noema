---
name: noema-workflow-audit
description: 审计 Noema 或 Emacs 的上下文、Agent、文档与项目工作流是否符合现有契约，找出可复现的缺陷和文档偏差。用于明确的审计或逻辑一致性检查，不替代普通任务的必要验证。
---

# 工作流审计

先从用户关心的行为和现有权威契约开始。对照实际入口、数据归属和结果，不把
他人的配置或网上 Skill 当作本项目必须照搬的设计。参考实现只提供检查线索。

按本次范围追踪一条完整路径，例如：项目选择 → 上下文 → Session → ACP
派发 → 用户输入/权限 → 结果 → 文档/记忆 → 隐藏、关闭与恢复。辨明哪些步骤
已经实现、哪些只是工作指导、哪些仍是设计缺口。

源码审计要读取所属设计与实现，并用隔离测试核对；只查会话 `status`／`context`
只能诊断现场状态。Pi 可用 `agent:document:read` 读 Markdown 设计；需要读源码或
运行检查时使用执行 Agent，交代审计范围和只读边界。工具不足时明确证据限制。

重点检查会产生实际错误的边界：项目与 target、逻辑 Session 与 native ID、
草稿与已发送任务、队列与当前回合、视图与进程、原始记忆与审核证据、全局库
与项目 patch，以及异步回调对应的 client 代际。使用已有查询、日志和隔离测试，
不向用户正在运行的 Agent 发送测试任务，不伪造人类审批。

报告具体触发条件、可观察的错误、位置与影响；区分已复现问题、证据充分的
代码缺陷和尚未证实的推测。比较设计取舍时说明契约与代价，不为风格差异报 bug。
用户要求修复时持续完成授权内的修改，验证正常路径、失败和清理，并同步权威
文档。未请求改动的审计保留为发现，不自动执行或发布。

文档入口：`~/.config/emacs/docs/README.md`。按范围读取 `design/agent-management.md`、
`design/pi-sessions.md`、`design/window-lifecycle.md`、`noema/design/agent-context.md`
或 `noema/design/capabilities.md`；`records/` 是历史材料，不替代当前契约。
