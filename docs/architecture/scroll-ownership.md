# 视口归属：滚动只有一个主人

"点图片/表格/公式页面跳一下"、"滚动后一点击就回到滚动前"反复出现，原因不是某个组件，而是
**能移动视口的路径太多**：widget 聚焦自己的输入框、点击处理器在光标还停在旧位置时聚焦编辑器、
直接写 `scrollTop`、`element.scrollIntoView`。每次修复只堵住一条路径，另一条再把问题带回来。
现在视口只有一个主人：`src/cm6/viewport-stability.ts`。

## 契约

一次点击——打开组件、就地编辑、离开、在滚动中途点击——**不移动视口**，除非这次点击就是导航
（脚注跳到定义、目录跳到标题），或者读者自己在移动视口（滚轮、键盘、拖动、触控）。

## 主人负责什么

| 情形 | 机制 |
|---|---|
| 编辑器获得焦点 | `installFocusOwner(view)`：`view.focus()`、`contentDOM.focus()`、宿主的指针兜底聚焦都经由 `focusContent`。WebKit 在聚焦时会恢复并显示编辑器上次的 DOM 光标（即使 `preventScroll`），主人在显示过去之前把视口保持在聚焦时的位置。 |
| 点击引起的重排 | 按下时记录被按位置（pointer anchor），折叠/展开引起的高度变化后把它放回原处。 |
| 显式重排（打开公式源码、切换模式） | `preserveEditorViewport(view, update, anchor)`。 |
| 组件晚到的高度（字体、图片、图表） | ResizeObserver + 基线快照自动校正。 |
| 显式滚动请求（导航、键盘移动光标后显示光标） | 事务的 `scrollIntoView`；主人看到它就让路（不保持、不还原）。 |
| 读者的移动 | 滚轮、指针、触控、滚动键立即结束一切保持与校正。 |

## 规则（`tests/architecture-scroll.test.ts`）

- 编辑器内容的每一次聚焦都经过主人（`installFocusOwner` 在创建编辑器时安装）。
- 编辑器内的元素（表格单元格输入框、代码语言框、属性编辑器）聚焦时一律
  `focus({ preventScroll: true })`。
- 只有主人写滚动位置（`scrollTop`、`scrollTo`、`scrollBy`）。具名例外：拖动块到边缘时跟随指针
  滚动（读者自己的移动）；公式输入框内部的水平条跟随其光标（不触及页面）。
- 只有读者要求的导航调用 `element.scrollIntoView`（大纲、`[toc]` 跳转）；其他显示一律用事务的
  `scrollIntoView`，主人才能分清"跳转"和"显示光标"。

## 真实浏览器检查

`scripts/check-scroll-invariance.mjs` 在 WebKit（与 Emacs 在 macOS 上的 WKWebView 同源）里对
**每一种组件**跑同一组场景，新组件加进 fixture 即被覆盖：

1. 读者把组件滚到屏幕中部、旧光标远在屏幕外（编辑器聚焦或未聚焦）时点击组件：组件所在行不动。
2. 再点击别处的正文：被点的字留在指针下，文档不因"点了又离开"而改变。表格另外覆盖格内公式、最后一行单元格和下方正文。
3. 滚动惯性尚未停（只有 scroll 事件、没有 wheel）时点击：之后的滚动不被拉回。
4. 点击后马上用没有 wheel 的方式滚动（Emacs 滚动命令、惯性尾段）：滚动不被拉回。
5. 点击上沿已在屏幕外的高组件（大图、长表）的下半部：不滚到它的顶部。

点击的意图按组件声明：`opens`（就地编辑或显示源码）、`edits`（复选框改文档）、
`navigates`（脚注跳转，必须真的移动）。

```sh
# 只有编辑器
NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run check:scroll
# 整个应用（含宿主的焦点处理）：先 NOEMA_WEB_PORT=50999 node web-host.mjs
NOEMA_SCROLL_APP_URL=http://127.0.0.1:50999 NOEMA_SCROLL_APP_FILE=/tmp/scroll-fixture.md \
  NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run check:scroll
```

`ONLY="image,table"` 只跑部分组件；`NOEMA_SCROLL_TRACE=1` 在"未聚焦"场景里打印每次聚焦、选区写入
与滚动事件的调用栈——找"谁移动了视口"时先开它（配合 `vp build --minify false`）。

## 一次真实的根因（2026-10-17）

编辑器未聚焦时点击图片或任务框：中央点击处理器先派发新选区（未聚焦时 CM6 不写 DOM 选区），再
`contentDOM.focus({ preventScroll: true })`；WebKit 在 `focus()` 内同步恢复旧 DOM 光标并滚到它，
视口从 4655 跳到 0。修复不在这个处理器里，而在主人：所有聚焦都经过 `focusContent`。

表格内公式打开时，若以公式所在源码行作锚点，预览变成逐格编辑后该行相对表格顶端下移，页面也随之滚动；
表格入口应锚定表格起点。离开长表格时，CM6 的行高缓存会暂时与实际 DOM 相差数行，按下正文的位置
应使用 DOM 光标坐标作锚点。表格预览和逐格编辑的单元格尺寸也要由同一份结构样式定义，否则切换后
表格高度本身会变化。未聚焦时打开格内公式必须用 `view.focus()`，由 CM6 同步源码光标后再接管焦点。
