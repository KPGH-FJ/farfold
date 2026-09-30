# 受管卸载历史修复：安装与待补验

2026-10-01 02:07。修复已安装；真实 Auggie 更新、两份程序并存、切回原程序及原稿返回通过。卸载确认已到达，未点击最终删除，等待用户对本轮新副本的具体确认。因此卸载后的刷新与冷启动清单仍未验收，不能称本片完整完成。

## 候选与工程检查

源码提交 `423aed4ef61c67e4f1f9c70d5cd3e8866f5438a7`，正式应用 `/Applications/Farfold.app` 于 02:00:32 安装，二进制 SHA-256 为 `457edd0197b33de1972c7b7c56912f5ecb7f14074cb5254894ab983c1874d78a`。404 个输入至 02:07:14 退出观察均未变化；复制比对和签名通过。见[源码清单](candidate-source.json)、[安装收据](candidate-install.json)、[退出核对](after-pending-exit.json)。后续工作区变化不改变此候选身份。

5 项真实临时目录/SQLite 回归由失败转为通过，完整 Rust 414 项通过、3 项既有忽略，fmt/clippy 通过。前端 296 项输入集合与摘要未变，明确沿用前候选的类型检查、1,076 项测试和构建；没有重跑前端全检。仓库格式与打包通过。见[后端说明](backend.md)、[独立审查](review.md)、[Rust 收据](checks-full-rust.json)、[前端复用核对](frontend-reuse.json)、[格式](checks-format-final.json)、[打包](checks-bundle-final.json)。原始日志保留原输出；首次格式失败来自上一批新证据 JSON 的格式，修正后复检通过。

## 实际安装旅程

| 操作         | 已观察结果                                                                                                                             | 证据                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 原受管程序   | Auggie 0.36.0，原目录 `install-CUpRvu`；当前选择的卸载按钮禁用                                                                         | [01 原安装](01-original-installation.png)、[原清单](inventory-before.json)                 |
| 明确重新下载 | 新增 `install-ptB0sP`，同版 0.36.0，两份安装并存；新副本选中，原副本保留                                                               | [02 双安装](02-two-installations.png)、[新选择](inventory-new-selected.json)               |
| 切回原程序   | 经连接检查回选 `install-CUpRvu`；前一次选择记录现在指向新副本，构成本片缺陷的真实触发条件                                              | [回选收据](inventory-original-restored.json)、[数据核对](original-restored.json)           |
| 卸载确认     | 界面精确显示新副本 `install-ptB0sP` 的路径；电脑工具要求没有撤销入口的删除在执行前确认，已询问用户。未执行删除，随后取消确认并暂时返回 | [03 确认页](03-test-copy-uninstall-confirmation.png)、[待确认范围](pending-uninstall.json) |
| 返回与退出   | 返回原 Amp 空稿，未发送消息；正常退出                                                                                                  | [04 原稿](04-original-draft-preserved.png)、[退出核对](after-pending-exit.json)            |

原 29 条会话索引所核字段、16 个 Agent 启动配置与原未发字段保持。设置只有 `installations.v1`、`installPrevious.registry:auggie` 变化；没有新增会话。原 Auggie 入口文件摘要不变，新旧副本均保留，见[退出时清单](inventory-pending-exit.json)。这是所列 Farfold 元数据与公开入口文件的核对，不是外部配置或凭据全面审计。

[协议元数据](protocol-metadata-final.json)共 3 个文件，没有 prompt。观察到的应用与原 Amp 两个进程身份退出后均结束；本轮未连续采样安装检查的瞬时子进程，不声称全面进程审计。打包产生的精确重复应用已比对后移除，见[删除证明](duplicate-cleanup.json)，正式应用保留。

## 仍需完成

用户确认后，仅卸载本轮新副本 `install-ptB0sP`；核对原程序保留、前一次选择的失效命令/参数已清理、刷新及冷启动不再出现新副本。若届时安装候选变化，另记实际候选与操作收据。二进制别名、跨 Agent 引用及保存失败重试目前只有受控测试，不写成安装版实测。
