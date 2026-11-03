---
name: noema-project-docs
description: 管理 Noema 项目的 AGENTS.md、Markdown 工作记录、Wiki 知识、文档入口、项目 Skill 和能力 patch，并保持流程与产物可接续。用于项目级知识或文档结构维护，普通单篇编辑无需建立项目框架。
---

# 项目文档与 Skill

先阅读项目适用的 `AGENT.md`／`AGENTS.md` 和已有文档入口，沿用现有组织。没有必要时不创建
空模板、`.noema`、Cell、DAG 或另一份流程数据库。项目根、实际执行目录、任务
和原生 Session 分别记录，不用 cwd 或某个 buffer 名代替它们。

- 项目说明、协作约定与可复用知识保持 Markdown。`.agent/` 按需存任务、交接、
  记忆和实际产物引用；不复制整段 transcript 或维护第二份项目知识全文。
- 文档说明当前契约和可验证行为；历史记录放已有历史位置。修改实现时更新
  同一主题的权威文档，失效内容注明原因，不新增与旧入口争夺权威的说明。
- 项目 Skill 放 `.agents/skills/<id>/SKILL.md`，用名称和描述做自动发现，细节
  放相邻 references。能复用的正文留在全局库；项目差异用 Noema Skill patch，
  不把 patch 当作全局副本。全局共享、项目 patch 和独立本地副本是不同操作。
- 使用现有 Skill/MCP 管理器或能力 API 查看来源、禁用、依赖和 patch 校验。
  导入 Skill 不代表执行任务；项目禁用优先。能力解析器是唯一合并入口。
- Pack 的 `agent_catalog: true` 控制 Pi 的默认目录，项目可以 patch；它与研究 Run
  的 `packs.enabled` 分开。Skill Manager 的 Packs 页菜单 `a` 切换标记，`m` 编辑成员。
  用 API 替换定义前先读当前配置，保留其他字段；正文继续按需读单个 Skill。
- `.agent/` 的缓存与运行状态由 `noema-project-maintenance` 说明，不当作文档目录维护。
- 项目工作较大时使用 `project-agent-management` 的分工与交接指导；已有流程
  与运行 owner 保持权威。不把工作方法宣称为已实现的自动运行机制。

## 来源推动的 Wiki 维护

项目 Pi 接到新论文、数据、代码变更或其他来源时，按项目问题判断影响范围。保留
可重读的来源路径或 URL、相关版本和未核实处；原始材料是依据，Wiki 页面是可修订
的解释。`[project]` 决定工作范围，Wiki 仓库和 namespace 决定页面所在处，两者
不必相同。

用 `knowledge:search` 找已有主题、实体和综述页，读相关 Markdown 后决定更新哪些
旧页；出现值得独立维护的主题时可新建页。让页间链接和来源引用说明变化，矛盾的
结论写出差异，待核查的仍标待核查。Pi 读不到的原始文件可交给执行 Agent 核对。
明确授权的整理沿用 `agent:document:edit`，需要人判断的表述用
`agent:document:propose`；每篇独立保存和处理冲突。结束时简述已改页面、依据和
未解决项，供下一次项目维护接续。这是按任务取用的工作方法，不是自动 ingest。

按任务读这些入口：

| 主题 | 权威文档 |
| --- | --- |
| 项目、Sessions、Findings、历史、指导文件 | `~/.config/emacs/docs/noema/guide/research-workflow.md` |
| Skill、pack、patch、来源与依赖 | `~/.config/emacs/docs/noema/design/capabilities.md` |
| Markdown 扩展语法、公式、环境与属性 | `~/.config/emacs/docs/noema/design/syntax.md` |
| 版本化修改、反馈与原位审阅 | `~/.config/emacs/docs/noema/design/interaction-plan.md` |
| Wiki 搜索、页面身份和来源维护 | `~/.config/emacs/docs/noema/design/wiki-workspace.md` |

写 Noema 语法前读当前规范或 `noema-authoring-syntax`。通过文档 API 读取最新
版本；需要审阅时提出版本化修改并处理冲突。用户已授权的普通直接编辑照常
执行，不因使用此 Skill 增加确认。完成时检查链接、实际产物和未决事项。
