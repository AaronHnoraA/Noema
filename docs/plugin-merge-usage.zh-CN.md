# 表格、关联笔记、Agent 与中文输入

这一轮参考了 [Advanced Tables](https://github.com/tgrosinger/advanced-tables-obsidian)、[Smart Connections](https://smartconnections.app/docs/connections/)、[Claudian](https://github.com/YishenTu/claudian) 和 [Easy Typing](https://github.com/Yaozhuwa/easy-typing-obsidian)。Noema 的文件格式、Emacs Agent 会话和现有分行算法保持原样。

## 表格

Noema 原有的 Tab/Enter 单元格导航、行列增删/移动、对齐、格式化及公式仍可使用。视觉表格工具栏新增 **↑**、**↓** 和 **CSV**：先点目标列的任一单元格，再点箭头按该列排序正文行；**CSV** 复制表格到剪贴板。标题行与 Markdown 分隔行不参与排序。源码编辑时可调用 `table-sort-ascending`、`table-sort-descending`、`table-copy-csv` 命令。

排序采用数字比较或本地语言排序，同值保持原顺序。超过 100 行或源码超过 10,000 字符的表格不执行这类整表操作，以免大表格拖慢编辑。

## 中文输入

在普通 Markdown 正文中，逐字输入会自动补齐汉字与英文字母、数字之间的空格；紧跟汉字输入 `, . ! ? ; :` 时换成对应中文标点，紧跟英文输入对应全角标点时换回半角。每次转换都可用普通撤销恢复。

代码、公式、链接、图片和表格源码保持原样。粘贴、多字符替换及输入法组合过程不运行规则；没有全文自动重排，也没有改变 Noema 的分行算法。这是 Easy Typing 的高频规则子集，尚未接入它的自定义规则引擎、Tab 跳出和全文格式化。

## 相关笔记与 Agent

选中文本后可用浮动工具栏的 **… → Find related notes with Emacs Agent**，或右键 **Find related notes**；没有选区时右键会使用当前笔记。在普通 Emacs 缓冲区可以运行 `M-x noema-context-find-related`。这个动作把文件及行号引用送给已有的 Emacs ACP Agent 会话，Agent 按需查找最多八篇关联笔记并说明具体联系。它优先使用已配置的 Noema 语义检索；不可用时搜索项目笔记。

Noema 原有的 **Agent** 选区发送、**Rewrite** 的 gptel 差异审阅、`@@agent` 路由、Skills、MCP 和会话管理继续由 Emacs 工具链负责。相关笔记查询不会在后台持续索引或定时唤醒 Agent。当前还没有 Smart Connections 那种自动更新的关联侧栏，也没有把 Claudian 的独立聊天运行时嵌进网页。
