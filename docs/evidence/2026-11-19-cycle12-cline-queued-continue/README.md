# 第 12 周期 Cline 断线恢复后手动继续待发

2026-11-19，北京时间，macOS arm64 正式 Farfold 0.1.7，源码 `5e12e06d9`，CDHash `4e5bba7028bdabce14eb3dd531844654e8b611ce`。沿用 Cline 3.0.74 已保存的 `nvidia/nemotron-3.5-super-vl:free` 与 Act，从 Farfold 打开原自建对话 `1795066508385_b6dXM_cli`，目录为 `/private/tmp/ff-c12-n19-more.it7o60YZ/cline-retry`。样本承接[该会话的断线、热重连和冷开回执](../2026-11-19-cycle12-cline-disconnect/README.md)。

## 一次手动操作与真实回复

手动操作前，同一会话的 `unsentWork.v1` 有一条待发 B，`uncertainIndex: null`，`outcomeUnknown: true`。排序键和紧凑序列化的待发对象 SHA-256 为 `b5cbe05adaca1641708feee7c2c34751bcbbc39a48396eac924d20c2ac64ced9`。此前的正式冷开日志前 17 行零发送，SHA-256 为 `70c76ba474b2ca9f5a198a242fc345b1d56248bbf8723613847bda2da0dac9e8`。

界面只点击一次「继续发送」，出现新的 B 用户消息，待发控制收起。原连接日志 `protocol-v1-1795066740126-0.jsonl` 第 18 行在 14:12:14.224 发出唯一 `session/prompt`，第 23 行在 14:12:18.750 收到成功响应。前 23 行零新建和零取消，SHA-256 为 `e7139749921dd93b03dd278ce385881a68cb1835e2dd1da82f2b52d86bd83d9e`。队列读回为空，原 A 的 `outcomeUnknown` 保护仍保留。

Cline 原对象的官方 `1795066508385_b6dXM_cli.messages.json` 共有六条。前四条仍为原 A 用户输入、原 `run_commands` 工具调用、同一工具 `call-2d3dbf27-06a8-4cbf-bf09-1c60e497b7c0` 的结果及原助手回复。第 5 条是唯一 B 用户输入「只回复 FF_MORE_CLINE_RETRY_B。不调用工具。」，第 6 条是 Cline 的准确文字回复 `FF_MORE_CLINE_RETRY_B`。原命令只有一次工具调用，未新增工具使用，官方历史没有独立草稿内容或草稿图片。该时点官方历史 SHA-256 为 `28094e57882639cebef5e422e636da96b2eed2fdfee9ea69dba147bdab3e5c3a`。

## 原任务和带图草稿

| 核对对象       | 14:12:25 后同原对象的直接核对                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原命令启动记录 | `front-started.txt` 仍为 12 字节，修改时间 13:35:55.784，SHA-256 `536bfa0acc0eea9b675e3031f51707af0b6ad382d0eaf1d34db1247ceb0ca0a8`。                             |
| 原自然完成记录 | `front-natural.txt` 仍为 26 字节，修改时间 13:36:19.789，SHA-256 `623dbdf38b1692a28b29be81b2f0b06422f6695799d5b127ed2eba69c4041982`。                             |
| 独立带图草稿   | 可见原 `FF_MORE_CLINE_RETRY_UNSENT` 和同一 `owned.png`，只读存储的草稿文字和附件对象摘要仍为 `f9ed8d746727d0706cb5e0ec7476a2d3f0eb42d43f63327e8176bca496650113`。 |
| 草稿 PNG 缓存  | 解码的 `image/png` 为 167 字节，与本地 `owned.png` 逐字节一致，SHA-256 `3e546b0b48536ea764578d7b30300ee2e95ca52c16f623c150a0d9464f582b3d`。                       |

本批覆盖单条纯文本待发在原 ID 上手动继续、原任务不重跑，以及独立带图草稿的保存。多条待发和待发消息自身带附件仍待 Cline 实测。
