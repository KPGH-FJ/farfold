# 准备完成后的输入区修正

首次安装 `a0852672` 后的真实窗口发现：新草稿准备完成并移入对话区后，输入框缩为 320px，控件挤成多行。正式 EmptyState 编辑区与 ThreadView 挂载点的受控复现确认：空容器依内容收窄，又继承旧 `.empty-col` 的 460px / 80% 限制。

修正仅为挂载容器增加布局类和宽度、文件夹条换行规则；未改草稿、模型、权限或发送行为。独立 CSS 复核无阻断。

浏览器目视与 DOM 量测：1280×820 时输入框由 320px 恢复为 736px；900×620 时宽636px，底部工作文件夹条完整显示且无横向溢出。见 [修前](before.png)、[修后1280](after-1280.png)、[最小窗口900](after-900.png)。这是正式组件受控数据呈现，后续安装验证另记。

## 已完成安装与复查

修正源码 **`e9081b124d5965222691b7584f41070af3a6490b`** 已安装到唯一 `/Applications/Farfold.app`。前端 218 文件 / 2,523 项、类型、格式及构建重新通过；Rust 与依赖未变，沿用本轮已通过的 1,040 项 / 4 项原忽略、Clippy 和 Rust 格式证据。806 输入与提交在打包前后逐项一致；严格 ad-hoc 签名、arm64、标识、5 个包文件及 ZIP 一致，独立候选核验 17 项通过。

本轮用户保存/退出/允许安装授权持续适用；应用经 CUA Command-Q 正常退出并确认进程为零后安装。安装前后数据三树 **217,365 条目完全相同**，SHA-256 `ab551b1dc9e822fa5e616eded0f0796c54846867c41c122678bcbb2256c9d8b8`；原始清单只保留在本地 output 的0600文件。Keychain 未访问。经过正式应用/候选/ZIP三方文件比较后，仅删除可再生成的重复 bundle，归档保留。

`candidate.json` 和 `install-operation.json` 保留各自阶段的原始状态；其中未启动/数据比较待完成字段由后续 `installation/data-comparison.json` 与 `installation/installed-ui-verification.json` 接续，不是当前总状态。数据比较只覆盖正常退出至替换核验、重新启动之前的三目录内容/Unix权限；不等同于重启后所有历史与草稿逐项可用性验收，也不含Keychain。

重新打开正式应用，准备后的新草稿已显示完整宽输入框、单行工具栏和底部工作文件夹条，对话索引仍为108，沿用现有Codex / 6 Astra / Ultra选择。实际没有发送消息、改模型、登录/API或删除数据。启动应用可能正常准备当前所选Agent连接；此处不宣称真实Agent任务通过。

见[安装数据比较](installation/data-comparison.json)、[安装回执](installation/install-operation.json)、[实机观察](installation/installed-ui-verification.json)与[真实窗口截图](installation/installed-prepared.png)。首次安装对设置/提醒、Agent目录和自定义空表单的核对见[首轮安装](../installation/README.md)。

系统通知送达/声音、真实停止恢复、实际导出文件、账号/API、29家八项标准、Windows和正式签名/更新渠道仍按各自证据判断；全量键盘/读屏和所有窗口尺寸未验收。
