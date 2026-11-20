# 第 12 周期 Copilot 按工作文件夹查找

2026-11-20 09:19–09:21，北京时间。macOS arm64 正式 Farfold 0.1.7，源码 `87ac54ec2`。本机 Copilot 登记 `registry:github-copilot-cli`，保存的握手版本为 1.0.114。本次只查先前自建的文件测试对话 `129d85c1-6bd6-408f-a6b4-2b776ccc7704`，沿用既有账号与设置。 [原对话和交付证据](../2026-11-20-cycle12-native-entry/README.md#copilot-成品与冷开)

从「所有对话 → 带入已有对话」选 GitHub Copilot。先选另一个自建测试目录 `/private/tmp/ff-c12-n20-ryup8cla/cursor`，只点一次「查找对话」。界面显示「没有找到对话」，无「加载更多」。再选原目录 `/private/tmp/ff-c12-n20-ryup8cla/copilot`，只点一次「查找对话」。找到带 `FF_C12_N20_COPILOT_FILE` 标记的唯一结果，显示「已加入」，Agent 返回的位置与对话列表中的位置均为原目录。该行复选框和「加入所选」均禁用。没有打开正文、再次加入、发消息或关闭连接。

| 核对原件             | 实际结果                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 另一个目录的查询     | `protocol-v1-1795137619397-4.jsonl` 前 9 行 SHA-256 `6260de2b134facd3da5227ae6bb05f779f0213b52b5e5180f28316f45ff3c356`。第 8、9 行为 09:20:26.877 唯一列表查询及成功响应。                   |
| 原目录的查询         | `protocol-v1-1795137649262-5.jsonl` 前 9 行 SHA-256 `fee1c58882db6ef95ceb2ddab70df5d9b5fb3a384121eb2b68d9a2f47aaf3997`。第 8、9 行为 09:20:49.532 唯一列表查询及成功响应。                   |
| Farfold 会话索引     | 同 Agent、同原 ID 仍唯一。前后同一条索引及配置摘要 `bdd4fd1b48fa5eda711d1f791653b149dbdd21356c74017ef34e30d45e47cb41`。                                                                      |
| Copilot 原记录与成品 | 原 `events.jsonl` 前后均 34 行，完整 SHA-256 `e2c8ef72d8322c12c7b5a77f34b70dd64d732aa6468cf55e038f5119c7f1bfc7`。测试目录的 `input.txt` 和 `result.txt` 字节数、摘要和修改时间与原记录一致。 |

两份协议记录各一次握手和一次 `session/list`，零 `session/new`、`session/load`、`session/prompt`、审批或取消。原结果被标为已加入，依据是官方列表返回的 Agent 内原对话 ID 与 Farfold 已有索引匹配。结论限本次两个自建目录，其他历史范围、翻页和十月原样本续答仍按原条件。 [查找位置请求](../../../src/runtime/history_import.ts#L70) · [列表归属判断](../../../src-tauri/src/acp_client/session_discovery.rs#L470)
