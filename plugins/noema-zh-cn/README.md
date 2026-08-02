# Noema 简体中文插件

这是 Noema 插件系统的首个内置实现，迁移自
[`PWO-CHINA/noema-zh-patch`](https://github.com/PWO-CHINA/noema-zh-patch)
的 `8ff36eb0cfd07081525bb9fe8bac3137fd395a72`，
词典同步基线记录在 `zh-CN.json` 的 `meta` 字段中。

插件默认关闭，可在 Noema Configuration 的 **Plugins** 区域手动启用；
启停在重启 Noema 后生效。

翻译器会跳过 `.cm-content` 整棵子树，不修改笔记内容。原补丁与本迁移版本均按
AGPL-3.0-only 授权。
