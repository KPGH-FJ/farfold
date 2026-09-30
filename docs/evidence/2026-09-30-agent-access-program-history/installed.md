# 程序历史修复安装验证

候选 `8d46b23`，2026-09-30 20:13 安装，唯一 `/Applications/Farfold.app` 的 SHA256 为 `04c9077d187dbe7f52439178a3f8c2e86f9e8952618b086fd47a0cb6124e18d0`。370 个输入冻结，最后一次退出仍无源码变化；复制、签名、打包与最终工程检查见同目录收据。本页不把旧候选的请求结果合并为当前成功。

## 程序选择与保留：已测成功

1. 初始选择受管 Pi 0.87.1 的 `launch-program`。从“高级接入 → 选择已安装的程序”明确选择同一官方安装包内 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，兼容性检查后选用成功，见 `01-selected-package-entry.png` 与 `selected-package-entry.json`。未创建外部测试脚本或修改 Agent 代码。
2. 从程序列表选择受管入口，再回选日常 0.80.5。三份程序仍在列表，见 `02-old-program-three-choices.png`、`selected-managed-middle.json`、`selected-daily.json`。程序库存包含三份程序及一份接入组件；这些入口并非三份独立下载。
3. 正常退出并冷启动同一应用。日常程序选择仍在，包内官方入口仍列为未选。直接从该列表回选包内入口成功，见 `03-cold-package-retained.png`、`04-cold-package-reselected.png`、`cold-reselected-package.json`；未再次经过文件选择器或自动发现来找回它。
4. 最终从列表恢复基线受管 `launch-program`，`final-program-registration.json` 与 `after-exit-registration.json` 确认路径及非程序字段与基线一致。每次已记录选择的非程序字段摘要也均一致。

原日常别名在前片已被解析成真实路径；本片安装验证没有将该事实改写为“原别名逐字恢复”。符号链接原拼写、多次选择、旧快照、卸载幽灵和存储失败仅由[源码回归](../2026-09-30-agent-access-compatibility/program-history/README.md)验证。正式应用未执行卸载。

包内入口在程序库存中的版本显示未知，准备诊断可读取 0.87.1；没有借用 0.0.34 组件版本填充。界面截图和 AX 文本记录的范围分开；02 明确显示三份程序状态，03/04 显示保留路径及回选。

## 连接后模型读取：已测失败，原因调查中

20:17 恢复受管程序并检查连接后，Pi 显示已连接。自动模型读取及一次明确“读取模型选项”都短暂显示正在读取，随后回到未读提示，没有模型、没有错误，见 `05-model-read-empty-result.png` / `.ax.txt`。没有更换服务、模型、推理等级或发送新消息。

`model-read-protocol-metadata.json` 仅保存当前连接的白名单诊断字段：20:17:53 和 20:18:13 两次 session/new 都收到无顶层错误的响应；随后各有一个 session/set_config_option 协议错误及两个设置成功响应。元数据不含具体选项值或错误正文，不能据此确定错误原因或称模型准备成功。本候选未新增真实首发或续接成功证据。

## 数据、返回与退出

- `final-exit.json`：原 26 条会话、7 个 Agent 配置和未发字段摘要无变化，无新增会话。只有既有 `installations.v1` / `installPrevious.pi` 因明确选择更新，无新增设置键。
- `06-original-draft-retained.png`：关闭准备后返回原 Amp 草稿，仍沿用已有设置；未将 Pi 带入原稿。
- `after-exit-external.json`：既定 Pi 默认配置文件摘要及日常 CLI 元数据不变，受管目录子项未新增；不宣称完整外部文件审计。
- `cold-exit.json` / `final-exit.json`：按 PID、启动时间与命令核对，已观察的 2/4 个进程分别结束。切换及准备期间 Amp 原进程保持；短暂候选握手子进程不在该常驻进程快照计数内。
- `duplicate-cleanup.json`：只删除本次打包的确切重复 `.app`，正式应用文件摘要不变；其他 target 内容、Agent、配置和历史保留。最终正式应用已退出。

下一片修复模型读取结果丢失，并实现共用官方服务配置终端动作；全目录、登录成功及完整 J1–J6 未因此关闭。
