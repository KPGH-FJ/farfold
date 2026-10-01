# 客户端设置与打开交付：安装版有限验证

2026-10-01 19:03–19:25，`6064d05`（含 `bd65145`）已安装到唯一 `/Applications/Farfold.app`，二进制 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49`。组合候选的 455 个输入在各阶段核对中保持，复制差异为空、签名检查通过，见[安装身份](candidate-install.json)、[源码清单](candidate-source.json)及[最终退出](after-exit.json)。本片验证正常旧记录、准备页返回、未发稿冷恢复和两次普通旧历史加载；未知根数据的拒绝与禁止写回仍是受控测试证据，没有向正式记录注入损坏。

1. 从[原 Amp 空稿](01-installed-original-draft.jpg) / [AX](01-installed-original-draft.txt)开始，只输入自有标记 `CLIENTSETTINGSDRAFT20261001`。经设置、Agent 与账号入口进入 Amp 管理，[02](02-existing-preparation.jpg) / [AX](02-existing-preparation.txt)显示原 `Medium` 已读取；暂返并继续原稿，[03](03-draft-after-preparation.jpg) / [AX](03-draft-after-preparation.txt)保留标记和已有来源。正常退出后，[04](04-cold-draft.jpg) / [AX](04-cold-draft.txt)仍保留同一稿、Amp 与 Medium。
2. 打开任务自有的 OpenCode 旧测试历史，[05](05-existing-history-open.jpg) / [AX](05-existing-history-open.txt)可读旧正文；[06](06-history-original-selection.jpg) / [AX](06-history-original-selection.txt)显示原 `OpenCode Zen/Nemotron 3 Ultra Free`、沿用已有设置及 `build`。再次正常退出并冷启动，[07](07-history-second-cold-open.jpg) / [AX](07-history-second-cold-open.txt)再次读到旧历史。本轮没有续发；画面的既有 A/B 回复与产物均为历史回放，不能计作本轮新回复。
3. 冷启动后再进入 Amp 准备页，[08](08-cold-preparation-selection.jpg) / [AX](08-cold-preparation-selection.txt)仍显示 `Medium` 已读取。最后经 UI 仅移除本片标记，[09](09-original-empty-draft-restored.jpg) / [AX](09-original-empty-draft-restored.txt)恢复原 Amp / Medium / 已有设置空稿。没有改模型、来源或账号，没有确认新的设置保存，没有登录或发送消息。

[派生比较](comparison.json)保留 45 个原输入摘要。[基线](data-before.json)有 36 条索引、40 个 Agent 与 49 项设置；两次中间退出只有自有 `composers.new` 增加，原未发字段保持。移除标记后的[恢复核对](after-restoration.json)和[最终退出](after-exit.json)中，原索引、原 40 个 Agent 摘要、全部原设置及未发字段保持，索引/设置与未发键均无新增残留，容器形态一致。Agent 比较范围是原 40 行；现有回执没有另外列出新增 Agent 行，不把原行保持扩大为全表计数证明。

[安全协议快照](protocol-metadata-final.json)的安装至退出窗口包含 5 个文件、40 条启动摘要、5 initialize、5 session/new、2 session/load、4 set_config_option；prompt、authenticate、cancel、permission 与 list 均为 0，记录拒绝数和协议错误数为 0。模型读取与普通历史加载路径在安装旅程中被触发；这些计数不覆盖所有打开交付的竞争排列，也不把启动摘要数当进程数。[实际采样](all-observed-processes.json)的 8 个身份最终均不再存在，正式应用后代列表为空；这是有限采样，不是瞬时进程普查。[重复应用清理](duplicate-app-cleanup.json)精确匹配 4 个应用文件后移除本轮 bundle，正式应用保留。

[工程记录](engineering.md)：客户端红测 2 失败/38 通过，修复后 40/40；完整前端 139 文件、1,272 项及类型/构建通过。后台最终[四并发复验](checks-rust-recheck.json)为 575 通过、3 既有忽略，fmt/clippy、[格式](checks-format-before-install.json)和[打包](checks-bundle.json)退出 0。[首次完整检查](checks-rust-final.json)的 574 通过/1 失败及[失败调查](checks-diagnosis.md)、此前[主动中断](checks-interrupted.md)原样保留，不宣称非稳定 Node 探针或默认并发问题全部修复。两实现分别见[客户端实现](implementation.md) / [审查](review.md)和[打开交付实现](../2026-10-01-open-delivery-order/implementation.md) / [审查](../2026-10-01-open-delivery-order/review.md)。

本片没有新建自有预览样本，也没有执行预览关闭后立即重开的微小窗口；其确定性受控证明只在打开交付目录。准备进度只验证正常读取和原选择保持，没有改后保存流程。坏输入的安装错误页、队列冷编辑、缺失附件、真实登录、服务交付和新请求不在本片证明内。
