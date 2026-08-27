# dsh-conversation-toc

对话目录插件（conversation outline）—— 为 dsh Web GUI 提供一个「问题目录」悬浮面板：

- **只展示问题**：仅列出用户提问（`data-chat-flow-kind="user"`），不展示答案 / 工具 / 命令 / 上下文等（内容太多）。
- 每条带序号徽标与问题摘要；已折叠的问题也会展示（打开面板时自动翻页加载更早历史，把折叠在「加载更早」边界之后的问题也纳入目录）。
- **单击**任意问题，页面自动定位（滚动）到对应消息，即便该消息当前处于折叠状态。
- 当前问题有选中高亮；页面滚动时目录跟随滚动（scroll-spy），并自动把列表滚动到当前项。
- 面板默认隐藏；打开时列表已自动滚动到当前所在问题。

## 安装

```bash
# 安装进 web profile（pnpm 软链到本包）
dsh plugin --profile web add "link:<本目录绝对路径>"
```

`dsh plugin add` 会自动完成两件事：pnpm 把包写入 `dependencies`，并把本包追加进
`dsh.profile.bundles`（因为本包声明了 `dsh.bundle`），从而加载本包自带的 `cordis.patch.yml`
注册该插件行。**无需**再手动往 `cordis.patch.yml` 写 `insert` —— 重复写会导致
`duplicate loader entry id: ui-conversation-toc` 使启动失败。

安装后重启 web profile（新增插件不会热注入到已打开的页面），刷新页面后右上角会出现「目录」悬浮按钮。

## 结构

- `lib/index.js` —— host 半边（无操作，仅供 cordis 装载）。
- `lib/client.js` —— 浏览器半边（纯 DOM，无 React，无外部依赖）。
- `cordis.patch.yml` —— bundle 补丁，声明该插件行。

## 实现要点

转录区每一条消息都渲染为携带 `data-chat-anchor-key` 与 `data-chat-flow-kind` 的行，
位于 `[data-chat-flow]` 列表内，由 `[data-conversation-scroll]` 滚动容器承载。插件扫描这些行
中 `data-chat-flow-kind="user"` 的（即问题）构建目录，单击时滚动 `[data-conversation-scroll]`
到目标行（复用 shell 自身的 `flowTop` 定位公式）。较早的消息位于「加载更早」分页边界之后、
默认不在 DOM 中，打开面板时插件会自动点击该按钮逐页加载（自带锚点保持、不会跳动），使折叠的问题也进入目录。
