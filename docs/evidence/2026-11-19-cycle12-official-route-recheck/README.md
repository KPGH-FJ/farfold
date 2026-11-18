# 第 12 周期 Qoder 和 Codex 官方接口复核

2026-11-19，仅核对官方发布代码、本机登记及已允许使用的自建测试记录。零模型请求。

## Qoder 的默认历史原目录

本机原登记仍用 Qoder CLI 1.1.89。官方目录现为 1.1.92，更新说明提到历史读取兼容。拆读 1.1.92 的官方 npm 发布包，默认 `session/list` 仍走 `listAll()`。发布代码的 `q8l` 只解析历史第一条记录，`readSessionMetadata` 从该记录取 `cwd`。随后读取的 `workspace-directories` 和 `projectDir` 不会补给 `cwd`。原失败样本以及仍在本机的自有 `6ba24991-5c1b-438b-a475-e8cfc833d5bf` 都以不含目录的 `active-leaf` 开头，第二条用户记录才有实际目录。

现选版本从 Farfold 明确指定原目录可准确命中。默认范围继续需要官方在回包中提供原始实际目录，或以明确可验证的读取接口取回。出现相关修复后，用同一自有样本、原目录及同批 Claude 的空对照目录零发送复验，核对原始目录、原 ID、翻页和已加入入口。 [官方目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) · [官方更新说明](https://changelog.qoder.com/cli) · [1.1.92 发布包](https://registry.npmjs.org/@qoder-ai/qodercli/-/qodercli-1.1.92.tgz) · [既有正式结果](../2026-11-17-cycle12-pi-history-scope/README.md)

## Codex 的 NEW-24 发送保护

本机登记 `codex` 使用 Codex ACP 1.13.1，内含 CLI 0.156.1。本机 `dist/index.js` 与原案归档中的 ACP 适配器字节一致。`session/load` 走 `thread/resume`，公开回包缺实际文件与网络权限的完整有效值。模式设置的回执只涉及连接内的模式选择，原普通发送时才会为 `turn/start` 传递实际参数。缓存目录现显示 2.7.0，当前运行证据仍为 1.13.1。

解除保护须同一官方连接按原对话和原目录读取完整实际文件范围、网络和审批设置，并在重开后对实际恢复提供匹配回执。列表元数据仍可只读核对。零发送的 `session/load` 可能由厂商追加设置记录，需与列表读取区分。 [原权限记录](../2026-10-09-capability-hardening/README.md) · [既有官方接口核对](../2026-10-05-mcp-file-feedback/official-merge/README.md)
