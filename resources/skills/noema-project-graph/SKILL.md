---
name: noema-project-graph
description: 项目开发规范：用 `.agent/tasks/` 的任务图谱记录要做什么、按什么顺序、谁在做、为什么。开始多步工作、接手项目、派子 Agent 或记录决定时使用；单步小改动不需要。
---

# 项目任务图谱

开发规范，不是服务。图谱是 Agent 自己维护的项目缓存，数据全在 `.agent/tasks/`：
`<id>.md` 是任务定义，`journal.jsonl` 是只追加的事实，状态都从日志算出。
规则由工具执行：被拒绝时读错误信息，`status`、`show`、`check` 的 `advice`、`fix` 会说下一步。

入口：
- 有 shell：`node ~/.config/emacs/site-lisp/noema/scripts/project-graph.mjs help`，不需要 host。
- Pi：`noema_call` 调 `noema:api:agent:project:graph`，参数 `[{"root":"…","op":"status"}]`。

循环：`status` → `next` → `claim` → 工作 → `note` → `submit` → `check`。

判断工具替不了你：
- 只记值得留下的：`note --kind decision` 写为什么，`--kind commit --refs <sha>` 记提交。不写流水。
- 规划读 `noema-project-plan`，推进和分派读 `noema-project-run`，评审读 `noema-project-review`。
- `evidence` 写实际运行了什么、结果如何；没验证就如实写。消除警告不是目标。
- 任务完成不等于结论成立：知识进项目文档，研究结论走 Finding。
- 不手改 `journal.jsonl`，不另建清单；缓存与记忆见 `noema-project-maintenance`。
