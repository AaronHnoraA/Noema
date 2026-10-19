# Noema 自动记忆

Noema 的普通 ACP 会话和研究 Run 共用一个项目记忆范围。会话完成后后台提取记忆；下一次提问时自动召回相关内容。ACP 的可见输入和原生会话记录保持原样，召回内容通过额外的上下文块传入。研究 Run 在冻结 RunSpec 时把召回内容纳入既有的 64 KiB 上下文预算；`@@ctx(none)` 同时关闭这部分自动上下文。

记忆只提供未核实的会话背景。研究结论仍通过 Noema 原有的 Finding 审核与证据路径；未经审核的记忆不会成为 Finding 或研究证据。对话和 Run 使用同一个 Hy Memory 索引，以 Noema 项目根目录隔离。

## 模型和数据

- 记忆提取使用 Noema Pi 已配置的 `openai-codex/gpt-5.6-luna` 与现有 Codex 登录态。Noema 的 Pi 管理器和记忆层复用同一套凭据入口；记忆请求通过短暂运行的 Pi 模型适配器发送，不保存第二份令牌，也不使用 OpenAI Platform API key。
- embedding 使用胖胖的私有 OpenAI 兼容服务：`http://10.243.90.222:19528/v1`，模型 `Xenova/bge-small-zh-v1.5`，输出 512 维。Codex 登录态本身不提供 embedding。Bearer 令牌保存在权限为 `0600` 的 `~/.config/noema/hy-memory.env`，不会写进仓库。Mac 可通过 `ssh Aaron-nas-remote cat .config/pangpang/embedding-token` 取得令牌；本机直连 ZeroTier 的 SSH 有时无法路由，因此当前使用已配置的远程 SSH 别名。更换 embedding 模型或维度时，应新建索引并迁移，不能直接在现有索引上混用向量。
- 该 Mac 上 Python 直连 ZeroTier 偶发路由错误，embedding 请求使用系统 `curl` 发送。令牌和请求体仅放在临时私有文件中，Pi 请求仍使用本机回环地址；无需驻留代理进程。
- 私有索引位于 `~/.local/share/noema/hy-memory/`。SDK 虚拟环境位于 `~/.local/share/noema/hy-memory-venv/`。不需要 Ollama 或本地模型。
- 凭据未配置时，自动记忆保持关闭；Noema 原有会话和 Run 路径照常工作。召回最多等待 3 秒，失败后跳过记忆并在 60 秒内停止重试；写入始终异步进行。服务错误不会写入会话日志。

## 安装与验证

运行 `make memory-setup` 安装固定版本的 Hy Memory SDK，再运行 `make memory-test` 检查桥接层。Emacs 的隐藏 ACP 上下文契约测试位于 `test/elisp/noema-hy-memory-tests.el`。

当前 Mac 已写入胖胖服务凭据并完成真实写入与召回验证。可用以下命令查看配置就绪状态：

```sh
~/.local/share/noema/hy-memory-venv/bin/python scripts/noema-hy-memory.py status
```

输出 `{"configured":true}` 表示接点已配置；运行时服务故障仍由 ACP 和研究 Run 接点按超时与断路策略跳过记忆。
