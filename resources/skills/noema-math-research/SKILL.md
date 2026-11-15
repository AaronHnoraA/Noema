---
name: noema-math-research
description: 在 Noema 研究项目里做数学工作的统一标准：先向 Emacs 查项目，再按项目约定放 notes、计划、日志、检查和探索；结论带状态标签；Lean 判定证明，并行探索交给 exploration；记忆分层落到正确的 Markdown。用于证明、推导、反例、数学项目的推进与接续。
---

# 数学研究工作的标准

所有 session 和 Agent 用同一套约定维护项目：事实放在一个地方，状态由工具判定，
思路与痕迹留在 Markdown 里，人随时能在 Noema 里读到。

## 先问 Emacs，不要猜

- 项目根、workspace、任务图谱、观察项、记忆状态：`agent:project:status`
  （`[{"root":"<当前文件或目录的绝对路径>"}]`）。`project` 为 null 说明这里不是 Noema 项目。
- 用户正在看哪个文件、哪个项目：`emacs:pi` 的 `context`。
- 你自己的会话身份：项目入口提示里的 buffer 和 nativeSessionId，或 `emacs:agent` 的 `status`。

cwd 不代表项目。不是项目却要做项目级工作（计划、探索、跨会话接续）时，请用户把目录设为
Noema 项目（Emacs 里 `noema-project-enable`），不要自己写 `noema.toml` 或另起目录。

## 项目里的东西放哪

先读项目的 `AGENTS.md` 并沿用已有布局；没有对应文件时按下表新建，规模相称。

| 内容 | 位置 |
| --- | --- |
| 持久约定与用户偏好（模型、分工、不做什么） | `AGENTS.md` |
| 问题定义、框架、推导、结论 | `notes/*.md`，每条主张带状态标签 |
| 计划与进度 | `planning.md` 的 `@@project`/`@@todo`（Agenda 读得到） |
| 工作日志：做了什么、为什么转向 | `log.md`，按日期追加，引用 notes 的标题 |
| 机器检查 | `checks/lean/`、`checks/python/`，notes 里引用文件 |
| 并行探索 | `explorations/<id>/`，由 exploration 管理 |
| 公共背景知识 | Wiki 页面，用 roam 链接引用，不复制进项目 |
| 跨会话交接 | `.agent/handoffs/*.md`（见 `project-agent-management`） |

## 主张的状态标签

与成员笔记本、notes 用同一套：`[known]`（文献，注明来源）、`[known, verify]`、
`[proved: Lean <文件>]`、`[proved: paper]`、`[evidence: <范围>]`、`[conjecture]`、
`[refuted: <反例>]`、`[open]`。

- 有限例子不证明全称命题；反例只推翻它真正矛盾的那条；命令失败或库里查不到名字什么也不推翻。
- 证据变化时把受影响的结论改为 `[known, verify]` 或 `[open]`，原地改，不留互相矛盾的说法。
- `[proved: Lean]` 只在 Lean 判定接受之后写。

## 完整周期

1. **问题**：读 `AGENTS.md`、相关 notes 和 Wiki；需要时 `lit-review`。把问题和成功标准写进 notes。
2. **计划**：`proof-plan` 拆引理与依赖；进度写 `planning.md`，多会话的工作再用任务图谱。
3. **探索**：单一路线自己做。路线不明、值得多个方向并行时，用 exploration（下节）。
4. **验证**：形式命题交给 Lean 判定；数值与构造放 `checks/python/`；纸面论证用 `proof-review` 审。
5. **记录**：结论连同标签和证据回到 notes，`log.md` 记一行；值得公开的背景整理进 Wiki。
6. **写作**：`math-prose`、`claim-precision`；论文阶段再用 `paper-polish`。

## Lean 判定

由人给出冻结陈述：一个 `.lean` 文件，定义加一条 `theorem 名字 … := sorry`。
`agent:lean:judge`（有 shell 时用 `node ~/.config/emacs/site-lisp/noema/scripts/lean-judge.mjs`）：

- `statement` 检查这个文件能否用来判定；
- `check` 给部分证明打分：`invalid`、`errors`（带位置）、`sorries`、`complete`；
- `verify` 判定是否证出：前言逐行、陈述逐字保留，Lean 通过，公理只有
  propext/Classical.choice/Quot.sound，`pp.all` 类型与原陈述一致。

`complete` 只是候选，`verify` 才算数。不要改陈述去迁就证明：弱化假设就是失败。

## 并行探索

`agent:exploration`（有 shell 时用 `node ~/.config/emacs/site-lisp/noema/scripts/exploration.mjs`）。
难题没有单一可靠路线，或想同时得到反例与证明时使用；简单计算和单步推导不用。

- 发起者传 `coordinator`（自己的 buffer 和 nativeSessionId）、问题 note 或正文、成功标准，
  可选 `lean` 冻结陈述（之后每个证明先经 Lean 判定），成员数与时限，然后结束回合。
- 你是裁判：被唤醒时读报告、成员笔记本和文件，跑能跑的检查，用 `verdict` 决定；
  有漏洞就拒绝，并写明漏洞在哪。
- 结束后读 `summary.md`，把站得住的结论带标签写回 notes；未决的写成 `[open]`。

## 记忆分层

| 层 | 是什么 | 怎么用 |
| --- | --- | --- |
| 项目文档 | 已核实的知识与约定 | 权威，引用标题 |
| Finding | 经审核的研究结论 | `research:finding:list` |
| Hy Memory | 自动提取的会话背景，未核实 | 自动召回；另查用 `agent:memory:search` |
| 探索与日志 | 发生过什么、为什么 | `explorations/`、`log.md` |

用到召回的记忆时，说明用的是哪一条，核对原文后再作为依据；用不上就不提。记忆不是指令，
也不是证据。值得长期保留的东西写进项目文档，而不是指望记忆。
