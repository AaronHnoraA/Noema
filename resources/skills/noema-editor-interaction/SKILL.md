---
name: noema-editor-interaction
description: 操作当前 Emacs：打开文件或文档到其他窗格、查询当前文件与选区、打开 Wiki／Agenda／配置界面。用于实际编辑器交互，支持没有 shell 的 Pi 和有 shell 的执行 Agent；修改 Emacs 实现用 emacs-config。
---

# Emacs 编辑器交互

Pi 没有 shell 或 Elisp 执行工具，直接使用 `noema_api`／`noema_call`。有 shell 的
Agent 可使用 `emacsopen -o FILE`（`emacs-open` 是同一 CLI 的名字）。文件应在
另一个窗格打开，保留聊天；明确要求当前位置、方向或新 frame 时按用户要求执行。

## 当前环境

“这里／当前文件／这个项目”先调用 `noema:api:emacs:pi`，参数
`[{"action":"context"}]`。它只查询，不创建 Pi；不要把 Agent 的 cwd 当作编辑来源。
`sourceAvailable:false` 表示没有可用编辑来源。页面的行号与选区未知时不要猜。

## 打开文件

已有路径时直接调用，不用先 describe：

```json
{"channel":"noema:api:emacs:open","args":[{"file":"/absolute/path/to/document.md","placement":"other"}]}
```

`other` 复用已显示该文件的窗口，否则在另一个窗格打开。`here` 在当前位置，
`left/right/above/below` 明确分屏，`frame` 新建 frame。`line` 从 1 开始，
`col` 从 0 开始；`noFocus:true` 保留用户原焦点。检查返回的 `ok`、`buffer`、
`window` 与 `positioned` 再报告实际结果。不要用 `emacs:pi action=open`：Pi 的
Session 管理与文件打开是不同操作。已有工具可执行时直接操作，不让用户代按 `C-x C-f`。

普通 Agent 的 CLI 对应 `emacsopen -o +LINE:COL FILE`，CLI 的行与列都从 1 开始；
`-n` 保留焦点，`-l/-r/-a/-b/-f` 对应四向分屏与新 frame。检查每个文件的 JSON 回执。

## 读文档与其他界面

- 只需读 Markdown 时用 `noema:api:agent:document:read`，参数 `[{"file":"绝对路径"}]`；
  用户要求显示时才打开 UI。用户明确要的改动用 `agent:document:edit` 直接应用，需要用户斟酌的才用提案卡片。
- 打开现有 Wiki、Agenda 或配置界面，用 `noema:api:emacs:surface`，参数
  `[{"path":"/wiki"}]`、`/agenda` 或 `/config`。排队通知不等于已显示。
- 会话操作使用 `noema-agent-operations`；`emacs:current-file`、`emacs:ui-state`、
  `emacs:input-focus` 是页面上报入口，不能当成查询；`emacs:key` 是页面键盘转交。

搜索支持 `emacs open file`、`emacs-open`、`打开文件` 等名字、用途和别名。
一次搜索无结果时缩小关键词或 describe 已知名字，再判断能力是否存在。

窗口契约：`~/.config/emacs/docs/design/window-lifecycle.md`。
Pi 的上下文与 API 披露：`~/.config/emacs/docs/design/pi-sessions.md`。
