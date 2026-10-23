# Noema 仓库地图

本文回答“这段代码在哪一层、该改哪里”。编辑器与 Node host 内部的分层细节见
[current-architecture.md](current-architecture.md)；维护规则见 `AGENTS.md`；
宿主 Emacs 配置一侧的结构见 `~/.config/emacs/docs/architecture.md`。

## 运行时组成

```text
Emacs（唯一 UI）
├── lisp/noema-*.el          产品 Elisp：.noema 模型与 JuText、Graph Board、Agent、能力管理
└── xwidget/Appine 页面 ← dist/pages（由 pages/ + src/ 构建）
        │ HTTP/SSE
Node host  web-host.mjs + server/
        │ 监督、JSON
Go kernel  kernel/（二进制 noema）
```

依赖方向只能向下：页面不直接读盘，Node 插件单向调用 kernel，kernel 不依赖 Node。

## 顶层目录

| 目录 | 规模 | 职责 |
| --- | --- | --- |
| `src/` | ~50k 行 TS | 可复用渲染与编辑核心。`src/cm6/` 是 CodeMirror 6 编辑器（composition root 在 `extensions/index.ts`，渲染构件统一在 `extensions/visual/constructs/`）；其余是 Markdown/数学/TikZ/HTML 导出/Jupyter rendermime 等纯模块 |
| `pages/` | ~43k 行 TS | Emacs 宿主页面：笔记编辑页（`main.ts`）、Wiki、Agenda、Jupyter 输出、Config、Slides；宿主键盘与焦点契约（`host-keyboard.ts`、`xwidget-key-guard.ts`）；Vim 层（`vim-lite.ts`）。构建到 `dist/pages` |
| `shared/` | ~5k 行 `.mjs` | 浏览器与 Node 共用的语法/身份/宏规则，配 `*-fixtures.json` 契约（Go 侧按同一 fixture 校验） |
| `server/` | ~44k 行 `.mjs` | Node host。`Features/*/api.mjs` 是功能控制器（Assets、Emacs、Filesystem、Jupyter、Prose、Research、Session、Tasks）；`infrastructure/` 是 transport 无关的 router；`jupyter/` 是 Jupyter 协议客户端；`lib/` 是领域实现与旧 facade（仍在逐步拆入 Features） |
| `web-host.mjs` | | HTTP/SSE、静态资源、router 装配；写 `host.json` |
| `kernel/` | Go | headless 内核，派生自 SiYuan（AGPL）。`noema/` 是 Noema 自有包：`research`（WorkNode DAG、Proposal、Finding）、`wikisearch`（唯一搜索实现）、`agenda`、`planning`、`latex`、`bibliography`、`vaultgit`、`markdown`、`metadata` 等；`mcp/` 是 MCP 服务与工具；`agent/` 是 Agent 运行记录；`model/`、`api/`、`sql/`、`av/`、`treenode/` 等大多继承自上游 |
| `lisp/` | ~32k 行 Elisp | 随产品发布的 Emacs 包。`noema-research*` 是 `.noema`/JuText/Graph Board；`noema-agent-*` 是 ACP 边界、worker、worktree、会话面板；`noema-capability-*`、`noema-skill-upstream-ui` 是 Skill/MCP 管理；`noema-interaction-*` 是 CLI Agent 工作台；`noema-agenda*` 是原生 Agenda；`noema-xwidget-keys`、`noema-md-bridge` 是页面输入与文本桥 |
| `resources/` | | 共享资源的唯一来源：`katex-macros/`、`templates/`、`skills/`、拼写白名单；Emacs 配置通过 `etc/`、`templates/` 中的链接读取 |
| `jupyter/` | | kernelspec 模板与安装脚本（Emacs 的 Jupyter Board 调用） |
| `plugins/noema-copilot/` | | Copilot Node 插件，单向调用 kernel |
| `apple/` | | EventKit 辅助程序源码（`make agenda-apple-build`） |
| `browser-extension/` | | 仅做网页 capture 的 Chrome 扩展 |
| `js/`、`public/` | | 发布站点的静态脚本与资源 |
| `kernel-resources/` | | kernel 运行所需的外观与 stage 资源 |
| `vendor/` | | 以源码形式改造的第三方前端代码（`tikz-editor`、`adjustable-media-pure`） |
| `upstream/` | | 参照与包装的上游 Elisp/CLI（gptel、agent-shell、acp、magent、org-mode…），规则见 `upstream/VENDORING.md` 与 `UPSTREAMS.md` |
| `tests/` | ~300 个 | Vitest/Node 测试（TS 与 mjs），含架构守护测试；`tests/elisp/` 是全部 Elisp ERT 测试 |
| `scripts/` | | 构建、迁移、审计脚本 |
| `poc/` | | 原型（cm6-perf、org-agenda），不参与构建 |
| `docs/` | | 设计、审计与工作流文档；`architecture/` 为当前结构 |

构建产物：`dist/`（页面）、`build/`（kernel 与 apple 辅助程序）。入口见 `make help`：
`make build-web`、`make kernel-build`、`make test`、`make install`。

## 改动落点

| 想改的东西 | 落点 |
| --- | --- |
| 编辑器行为、渲染构件 | `src/cm6/`（构件走 `extensions/visual/constructs/`） |
| 某个宿主页面的 UI | `pages/` 对应入口；新页面必须调用 `installHostKeyboardBridge` |
| 浏览器与 Node 共用的语法 | `shared/` + fixture；Go 侧同步 |
| HTTP/SSE 端点 | `server/Features/<Feature>/api.mjs`，领域逻辑不再加进 `server/lib/runtime.mjs` |
| 搜索、引用文本、索引、Markdown 保存 | `kernel/noema/` 下的 Go 包 |
| `.noema` 结构与研究语义 | `kernel/noema/research` 与 `lisp/noema-research*.el`，两侧测试一起改 |
| Agent/ACP 行为 | `lisp/noema-agent-acp.el` 边界之后，不重写 gptel/agent-shell |
| Skill/MCP 能力 | `noema-capabilities.mjs` 与 `lisp/noema-capability-*`，见 `docs/capabilities.md` |
| 宏、模板、Skill 内容 | `resources/` |

## 已知结构问题

- `server/lib/` 仍承载大部分领域实现，`Features/` 迁移未完成（见
  [current-architecture.md](current-architecture.md) “Node host”）。
