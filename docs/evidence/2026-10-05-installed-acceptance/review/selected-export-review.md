# 精确导出复核

只读核对 `selection/manifest.json` 的 28 文件；未修改导出、源码、index 或应用，未重复测试。

- 28 份 selected 文件均匹配 manifest，均与 `selection/source` 导出一致；复核时工作区相应输入也全部仍匹配 manifest。
- 22 个原干净文件与工作区本轮内容完全一致。
- `App.tsx`、`lib.rs` 与独立三方试合并摘要一致。`lib.rs` 仅新增 HTML 清除命令注册。
- `App.navigation.test.tsx` 除三方结果外补了 `clearDraft/index` 可观察 mock、reset 及既有 mock 接线，服务本轮新断言；没有纳入既有 readiness 测试或生产行为。
- 手工 `EmptyState.tsx` 保留 HEAD 文件夹 chip、caption、选择器与发送保护，仅加入稳定 portal、实际草稿回报、未知 handoff 保护及恢复后退出新稿；未引入当前工作区此前的新文件夹条、readiness/connection 模块。
- 手工 `ThreadView.tsx` 的原 Composer 去掉空白后与 HEAD 完整一致，只在外层加入 draft portal 槽；另外仅增加页面回报、真实 nativeSessionId 观察及 active 恢复保护。
- 手工 selection 测试仅增加 portal mock/清理与本轮用例，不带原有 chooseDirectory/准入等脏基线测试改造。
- `useConnectionHold/configOptionChangeBlocked/candidateSelected/isAutomaticConnectionAllowed` 等原脏符号未通过这些手工文件新增进入导出。相对 imports 闭合检查由导出者完成。

结论：本次 28 文件选择范围可用于精确增量提交；没有发现原脏改动泄入。工程结果以导出者检查回执为准。本复核不证明安装版实际工具链结果；若之后实测修复改变源码，需更新选择输入及相关检查。

逐文件回执在 `selected-export-review.json`；六个排脏文件的 HEAD→selected 差分另存 `*.selected-delta.patch`。
