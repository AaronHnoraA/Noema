---
name: noema-project-review
description: 评审任务图谱里 `awaiting_review` 的任务，给出 passed 或 needs_changes。普通代码评审不需要。
---

# 评审

只判断这个任务，不动手修。`show` 读验收、`evidence` 和决定，然后看实际产物，亲自跑关键检查。

核对：验收确实满足；调用方和契约一致；新路径真被调用，mock 没被说成实际行为；失败路径与风险相称；没超范围。

`needs_changes` 的反馈要具体到文件和现象，让实现者不用问就能改。问题出在计划本身时，
告诉协调者或用户，不算返工。轮次用尽是人的决定，不要为放行而写 `passed`。
