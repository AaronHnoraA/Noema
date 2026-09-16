# Org Agenda 复用原型

这是本次研究的可运行实验，**不是已接入日常配置的完整 Agenda**。
总体设计见 [统一 Agenda 研究](../../docs/architecture/agenda-org-integration-study.md)。

## 已验证的链路

```text
example.md → Noema 现有 extractTodos ─┐
                                    ├→ 原生记录 → Org Agenda 格式/排序/UI
example.noema → WorkNode.agenda ─────┘               → Noema sourceRef
```

`WorkNode.agenda` 最初是原型提案；2026-09-16 已接入生产 JS / Go / Elisp 元数据协议。
本目录仍是只读实验。正式入口及剩余工作见 [实装记录](../../docs/architecture/agenda-implementation.md)。
示例保留了 question → 两条探索分支 → checkpoint 的 DAG，并单独保存 `depends`。
一个节点绑定多个 Cell 时，只投影一条任务；原生 Agenda 可以按日期显示多条 occurrence。

原型直接复用 Org Agenda major mode、排版、日期标题、排序和过滤显示代码。
**不生成 `.org`，不使用内存 Org 源文，不调用 Org 文件扫描器，不伪造源 marker。**
上游代码未修改。
完成操作 `t` 只展示回写请求，**不会标记任何源任务完成**。
键位仅接入已审查的 UI 命令，未继承 Org 的源文写入、计时或归档入口。
`RET` 可跳回 Markdown；WorkNode 跳转需要已加载 Noema 的 Elisp API。
`g` 重绘当前记录，`f/b` 切换周，`/` 过滤（输入空字符串清除）。
重新运行 demo 才重新读取示例源文件；`q` 关闭视图。
没有后台轮询、安装钩子或 macOS 数据访问。

## 运行

在 Noema 项目根目录执行 `nvm use`，使用项目要求的 Node 26.5.0。
原型直接导入项目现有模块，需要项目依赖已安装。

```sh
node --test poc/org-agenda/snapshot.test.mjs

# 当前 Emacs 自带的 Org
emacs --batch -Q -L poc/org-agenda \
  -l noema-agenda-poc-tests -f ert-run-tests-batch-and-exit

# 克隆的 Org；先按其自己的构建规则生成 autoloads
make -C upstream/org-mode autoloads
emacs --batch -Q -L upstream/org-mode/lisp -L poc/org-agenda \
  -l noema-agenda-poc-tests -f ert-run-tests-batch-and-exit

# 独立进程做性能测量；不要同时运行别的测试
emacs --batch -Q -L poc/org-agenda -l noema-agenda-poc-benchmark.el
```

在图形 Emacs 中 `M-x load-file` 加载 `noema-agenda-poc.el`，然后
`M-x noema-agenda-poc-demo`。若 Emacs 的 PATH 尚未使用项目 Node，设置
`noema-agenda-poc-node` 为对应可执行文件路径。
演示日期固定为 **2026-09-15 开始的一周**，方便复查。

## 实验边界

- 验证 Markdown/org-env 内任务和 DAG 节点共同进入原生 Agenda、稳定身份、
  无 Org 转换、`g` 重绘、周切换、过滤、原生时间显示和请求路由。
- 仅渲染当前 `sche`/`ddl` 对应日期条目；重复规则虽然保留在记录中，
  尚未生成未来 occurrence，也未实现阻塞、计时、tags、批量写回或完整自定义视图。
- 使用现有 Markdown 扫描入口，没有新增完整 Markdown parser；现有 parser
  对所有字面区域的处理仍需生产集成阶段做跨 Go/JS 的一致性验证。
- 性能测试是单一分类、所有任务在同一天的合成数据，包含原生数据分组、
  上游格式/排序与一周视图构建；不包含知识库扫描、IPC、真实窗口绘制、macOS 同步。
- 基准结果只是直接渲染的成本，不能作为生产延迟承诺。

## 上游来源

`upstream/org-mode` 是带 Git 元数据的独立研究 checkout，未加入启动 load-path，
未升级当前会话的 Org。克隆命令与 revision 在
[upstream-revisions.json](upstream-revisions.json)。

org-reminders-cli 只作为 EventKit 研究参照，位于忽略的
`var/research/org-reminders-cli`；未编译、安装或请求系统权限。
