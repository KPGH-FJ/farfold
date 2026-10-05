# HTML 项目隔离存档修复与验证

本片修复已落入正式源码，尚未单独宣称安装版 UI 验收。未启动正式应用、Agent 或模型；未读取、修改或清除用户已有网页存档。

## 实现

- `browser_workspace_open_html` 新增必填 `projectDirectory`，由可信主界面使用当前对话工作文件夹传入。规范化真实绝对目录仅作为存储命名空间，原 `VerifiedFile` 的核实与读取边界保持不变。
- 稳定来源和 macOS 14+ 专用 WebKit 分区由「规范项目目录＋规范文件路径」派生。不同入口/路径别名在同项目复用；不同项目或不同文件隔离；改写原文件后仍可恢复存档。重命名文件或移动项目会得到新分区，不迁移旧分区。
- 公开网页仍使用独立临时分区；较旧 macOS 的本地 HTML 仍临时，并通过 `localStoragePersistent=false` 告知界面。浏览器不复用系统浏览器资料。
- 清除动作只接受当前任务的准确本地页面身份，先关闭该页面，再通过官方 `removeDataOfTypes:modifiedSince:` 清空该 UUID 分区。保留分区身份，不枚举其他分区。清理在途拒绝同一分区重新打开/重复清理，直到官方完成回调；Rust 调用超时也不提前解除保护。
- 原领先文档的 CSP、独立无应用桥 WK、网络/框架阻断和单文件内存文档保持。本地 HTML 仍不能作为公开页共享给 Agent。

## 执行证据

- `wk-seed-final.json`：真实 WK 25/25；实际页面脚本确认稳定 HTTPS 来源、localStorage、关闭重开/更新恢复，其他项目和文件隔离，公开入口临时，外部 fetch/frame 与应用桥仍被阻断。
- `wk-verify-final.json`：第二独立进程真实 WK 19/19；读取上次值 42，清除后重开为空，其他项目/文件值保留，清除期间拒绝重开和重复清除。结束仅清掉三个合成 UUID 的数据。
- `rust-project-storage-final.log`：定向 Rust 56/56；含不同 receipt root 的同文件一致、规范路径别名一致、同文件跨项目隔离、无效目录拒绝与原文件读取边界。
- `verification.json`、`final-files.json`：验证摘要与本片八个文件的前后摘要。`delta.patch` 相对断连前本片基线保留其他改动。

真实 WK 指生产 Objective-C 桥承载合成离线页面，不是正式 Farfold 界面，也不是 Agent 或真实工具发现验收。未读取实际游戏存档。仍需主流程在最终安装候选检查关闭/切换/恢复与清除确认界面。

## 已定位并修复的失败

旧 `wk-verify*.json` 保留首次失败：关闭 WK 后立刻删除整个 data store 被 WebKit 尚存的异步引用拒绝。改为只清该专用 store 数据后通过。`wk-seed.json` 的 iframe 断言曾误将被阻止后的 `about:blank` 视为失败，最终断言确认 CSP 事件和空白/空 frame；`wk-verify-4.json` 的单个失败是探针等待 block 复制了回调状态，补 `__block` 后最终 44 项通过。

独立只读复核进一步发现 `VerifiedFile.root` 随入口而异，因此改用独立项目目录；也发现 8 秒等待超时后的迟到清理风险，因此增加分区在途保护。最终只读复核确认两项闭合，无新增具体阻断。

官方边界：SDK 的 UUID 数据存储自 macOS 14 起可用；[WebKit 官方实现](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebsiteData/Cocoa/WebsiteDataStoreCocoa.mm) 表明整体 store 删除受活动页面/异步处理限制。本片没有依赖私有 API 或枚举所有 store。
