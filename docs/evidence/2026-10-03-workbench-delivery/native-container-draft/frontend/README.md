# 浏览器内容栏草稿

仅创建独立前端文件，未改 `ThreadView`、`App` 或生产仓库，未运行应用、访问网站或接通 Agent。当前后端方向是独立 WK 子视图，不注册远程 Tauri webview，不向网页注入 Tauri 桥。后端隔离和整合验证完成前，本草稿不代表功能已上线。

## 文件与接缝

将以下文件保持相对位置放入现有 `src/`：

- `components/BrowserWorkspace.tsx`：现有内容栏中的正文组件。
- `browser-workspace.css`：复用 `--ink`、`--bg`、`--accent` 等现有主题变量。
- `runtime/browser_workspace.ts`：命令 DTO、注入式 client 工厂、内存页面所有权控制。
- `runtime/browser_workspace_strings.ts`：集中中文文案。

父级创建一次稳定 `client`：把已有可信 `invoke` 传给 `createBrowserWorkspaceClient`，把只面向主窗口的 `browser-workspace:state` 监听封装为 `listenState(listener)`。所有命令入参为顶层 camelCase 字段。组件不自行创建网页、使用 `eval`、写全局正文状态、保存网址或发送 Agent 消息。

```tsx
<BrowserWorkspace
  taskKey={trustedCurrentConversationKey}
  active={
    threadActive && contentPaneVisible && webpageSelected && !coveringOverlay
  }
  client={browserClient}
  onCleanupFailure={({ taskKey, retryClose }) => {
    // 在不随内容栏隐藏而卸载的位置保留错误及重试入口。
    showBrowserCloseRetry(taskKey, retryClose);
  }}
/>
```

`active` 必须包括顶层页面、内容页签及遮盖弹窗状态；独立 WK 不受 DOM/CSS 隐藏控制。父级在进入覆盖页面前应等待关闭，或确保后端首先移除子视图后再报告销毁结果。组件的清理重试只是补充，不能将卸载视为关闭成功。`onCleanupFailure` 为必填；应显示可执行的“重试关闭”，直至 `retryClose()` 成功。

## 命令契约

| 命令                         | 参数                     | 返回                       |
| ---------------------------- | ------------------------ | -------------------------- |
| `browser_workspace_open`     | `taskKey, url, bounds`   | `BrowserWorkspaceState`    |
| `browser_workspace_navigate` | `taskKey, label, url`    | `BrowserWorkspaceState`    |
| `browser_workspace_resize`   | `taskKey, label, bounds` | 无                         |
| `browser_workspace_snapshot` | `taskKey, label`         | `BrowserWorkspaceSnapshot` |
| `browser_workspace_close`    | `taskKey, label`         | 成功回执；内容忽略         |

`bounds = { x, y, width, height }` 使用相对主窗口 client 区域的**逻辑 CSS 像素**，不乘 `devicePixelRatio`。组件通过 `getBoundingClientRect()` 读取；网页存在时逐帧比较，只在坐标变化时发送单个 resize。它能覆盖内容栏移动但大小不变的情况。后端仍需限制矩形在可信主窗口内。

状态字段为 `{taskKey,label,url,phase,revision,error?}`；`phase` 为 `loading | ready | blocked | error | closed`。每次 open 必须创建唯一 label；revision 在单实例中单调递增。导航和载入事件应反映真实当前地址及状态。页面跳转被拒后用 `blocked`，禁用快照。后端错误只作诊断，组件使用固定中文错误，不直接展示任意页面/底层错误文本。

快照为 `{taskKey,label,url,title,text,observedAtMs,revision}`，revision 对应实际读取版本；后端在读取前后校验同一所有者和页面版本，并限制正文长度。组件仅在用户点击时读取，结果按纯文本渲染；导航、切换、关闭即清空。状态事件早于 open 回执时按返回 label 合并最高 revision。旧快照、旧 label 事件和旧 revision 不回填当前页面。

后端必须独立校验公开 HTTPS 目的地及每次重定向；前端 URL 校验只是输入提示。`close` 对不存在/不匹配的旧 label 必须幂等无副作用，不能关闭后来的同任务新实例。open 失败应清理已创建的子视图，不能留下没有返回 label 的可见页面。共享 IPC 隔离、外链/登录阻断、非持久存储及主窗口来源限制由后端接缝实现。

## 验证范围

已使用仓库现有依赖完成：TypeScript 严格检查、13 个所有权/版本单元测试、3 个组件静态 hook 测试（不自动打开/读取、换任务首帧无旧文字、隐藏关闭失败有重试）。组件测试不创建网页或原生视图，不能替代实际布局与 WK 集成检查。

独立复核命令（`node_modules` 仅链接到仓库已有依赖，不需要安装；不要把链接或下列检查配置复制到生产源码）：

```sh
node node_modules/typescript/bin/tsc -p tsconfig.check.json
node node_modules/vitest/vitest.mjs run --config vitest.config.mts --configLoader native
```

未做实际窗口缩放、焦点/键盘、覆盖弹窗、WK 首次加载与错误页面的视觉验证；应在后端隔离验证通过后合并检查。当前没有 Agent 分享按钮，也不声称 Agent 工具可用。

## 离线交互评审

`review.html` 是全页标明演示的独立 HTML。只含本片打开、导航、读取、关闭、切页关闭及加载失败重开；不导入生产代码，不加载真实网址，不使用 Tauri，CSP 禁止连接及内嵌页面。没有 Agent 分享、暂停或控制者切换开关。
