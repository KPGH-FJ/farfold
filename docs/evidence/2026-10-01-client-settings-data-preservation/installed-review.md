# 组合候选安装证据独立审查

2026-10-01，仅读保存收据、01–09 AX 与相应截图，核对已冻结的 [README](README.md)、[安装记录](installed.md)和[派生比较](comparison.json)。未启动应用、Agent、测试或数据库操作，未修改源码、原始收据或被审文档。结论：未发现本次有限安装叙述与证据不符的阻断问题。

## 身份与原始证据

[工程记录](engineering.md)标明组合源码为 `6064d05`，含客户端提交 `bd65145`；[安装收据](candidate-install.json)在 19:03:31 记录正式 `/Applications/Farfold.app` 二进制 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49`，复制差异为空、签名检查退出 0。[候选清单](candidate-source.json)的 455 项输入包含客户端四文件及打开交付六文件各自冻结的相同摘要。最终 [19:25:47 退出收据](after-exit.json)仍为相同二进制与 455 输入、`sourceChanges=[]`。

重算 `comparison.json` 的 45 个输入 SHA256 全部匹配；[原始格式保留清单](raw-format-preservation.json)的八个 JSON 摘要也全部匹配。最终被审文档 SHA256 为：

| 文件            | SHA256                                                             |
| --------------- | ------------------------------------------------------------------ |
| README.md       | `4c4ff1e1e9627dcbf336b3573bd752c770c611d905e1b813ae3804907a36b98d` |
| installed.md    | `5469dbe6dabda1326bedc3d6947fcee27b8f9ffbe51c1b203c95b4d902d0d244` |
| comparison.json | `a237a7495d52ec315a4cc75ed04f9e499b9675d0fde49693cf12e17886b2744f` |

## 实际覆盖与保持范围

- [03 返回原稿 AX](03-draft-after-preparation.txt)与[04 冷启动 AX](04-cold-draft.txt)的 `CLIENTSETTINGSDRAFT20261001` 逐字一致；04 像素同时显示 Amp / Medium。02 与 [08 冷准备页](08-cold-preparation-selection.txt)明确 Medium 已读取，也明确当前选择尚无成功回复。09 AX 与像素恢复原空稿，不能把准备读取当作认证或首发成功。
- 05 与 [07 第二次冷打开](07-history-second-cold-open.txt)显示同一旧测试历史；[06 选择弹层](06-history-original-selection.txt)完整显示 `OpenCode Zen/Nemotron 3 Ultra Free`、沿用已有设置与 `build`。07 像素仅有截断模型标签，没有再次打开完整弹层。文档据此分别记录原选择与第二次历史可读，没有把历史 A/B 回复计为本轮新回复。
- [原始基线](data-before.json)为 36 索引、40 个 Agent、49 项设置。两次中间退出原未发字段保持，增加的是本片自有 `composers.new`。经 UI 清除标记后，[恢复收据](after-restoration.json)和最终退出均显示全部原设置与未发摘要保持、无新增设置/索引/未发根字段或键、容器形态一致。Agent 只比较原 40 行，回执未报告新增 Agent 行，不能扩大为全表数量或全表逐字证明。
- 重算[协议快照](protocol-metadata-final.json)：5 文件、40 启动摘要、5 initialize、5 session/new、2 session/load、4 set_config_option；prompt/authenticate/cancel/permission/list、协议错误与拒绝记录均为 0。五文件最后启动摘要均为成功、已接纳、Child 已回收、进程组结束、连接移除。signal 15 与我方 TERM 同时记录，不能将其解释为自然退出或错误原因。
- [八个采样身份](all-observed-processes.json)按 PID 与启动时间汇总，最终退出的全局身份复核为空，正式应用后代为空；这是采样范围。[重复应用清理](duplicate-app-cleanup.json)的四文件摘要与安装收据逐项相同，记录本轮 bundle 已移除、正式应用保留。

## 结论边界

正常旧记录、准备页往返、草稿标记冷恢复和普通历史打开已在本候选观察到。未知/损坏根字段拒绝及零写回只由[客户端受控证据](review.md)证明；打开交付的同步唤醒、未消费结果与迟到清理由[独立受控审查](../2026-10-01-open-delivery-order/review.md)覆盖，本轮两次普通 load 不替代预览关闭立即重开的安装旅程。

没有正式损坏注入、改后保存、登录、凭据交付、首发或续发。既有失败和主动中断在[工程记录](engineering.md)中保留，最终四并发后台复验通过不证明默认并发或非稳定 Node 探针原因已解决。无需为本轮证据一致性另改产品代码。
