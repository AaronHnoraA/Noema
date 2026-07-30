# CM6 性能 POC

用真实大文件测 Noema 当前 CM6 编辑路径的性能基线：`createEditor`、live preview、数学/表格/代码块 widgets 和主题样式都会参与测量。

测试文件：`roam/project/UNSW/ISO(202603)/meeting.md`（约 9400 行，1900 处数学/代码块）

## 运行方式

```sh
# 启动 POC dev server（从 Noema/ 根目录运行）
npx vite serve poc/cm6-perf --open
```

## 测量指标

打开页面后点「Load meeting.md」：

| 指标 | 含义 | PM baseline 参考 |
|---|---|---|
| `firstRender` | EditorView 构造到首帧绘制 | 待测 |
| `keystroke p50` | 20 次输入的中位 input→DOM 延迟 | 待测 |
| `scroll fps` | 2 秒滚动的平均帧率 | 待测 |

指标结果同步更新到 `docs/pm-to-cm-progress.md` 和 `docs/pm-to-cm-issues.md` 的 R3 条目。

## 关注点

- 这条路径测的是实际 Noema editor，而不是简化版 CM6 插件。
- 若 `firstRender > 300ms` 或 `keystroke p50 > 16ms` → 重新评估 decoration 重建、block widget 扫描和 assist update 调度。
- CM6 的 `EditorView.lineWrapping` + 懒渲染（viewport-only）是 PM viewport plugin 的等价物，应该对大文件友好。
