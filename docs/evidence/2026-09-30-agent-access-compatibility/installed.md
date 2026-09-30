# 同候选安装验证

代码 `6b02dae`，2026-09-30 19:22:23 安装到唯一 `/Applications/Farfold.app`。主程序 SHA256 `6e09cfc7d1a69e381113b8e09b9c7b11df4197042b3fa4ea7651d202b8a5539f`；369 个冻结输入与当前源文件一致，复制与签名通过。前端 116 文件 / 926 例、Rust 310 例通过（3 例原有手动忽略），类型、构建、格式及 clippy 通过。收据为 `candidate-source.json`、`candidate-install.json` 和 `checks-*.json`。

## 旧程序与取消

1. `01-pi-old-version.png`：程序 0.80.5、接入组件 0.0.34、官方要求 >=0.81.0；提示不满足，仍可检查连接。没有因版本要求阻止连接。
2. `02-old-pi-model-failure.png`：旧程序成功连接，但模型读取失败。界面保留真实失败，不据此认定版本是根因，未发送消息。
3. `03-cancelled-old-selection.png`：显式安装兼容候选后点击取消，返回“操作已取消，原设置保持不变”。`cancelled-pi-inventory.json` 与 `pi-inventory-before.json` 的注册字段、既有收据、受管目录清单完全一致。
4. `candidate-cancelled.json`：原 25 条会话索引、7 个 Agent 配置及原未发字段不变，仅准备页进度设置变化；本次 Pi 与 Amp 原进程均继续存在。`pi-external-after-cancel.json`：列明的四个默认配置文件存在性/摘要及日常 Pi 路径/包元数据一致。未据此声称全部外部数据零变化。

## 候选与明确选用

`04-candidate-unselected.png`：重试成功准备 0.87.1，显示“尚未选用”；旧程序仍为 0.80.5。连接中选用/卸载按钮禁用。`candidate-prepared.json`、`prepared-pi-inventory.json` 与 `pi-external-after-prepare.json` 证明原 Pi / Amp 进程保留、注册字段和原未发字段不变，仅新增受管程序记录及准备进度。

明确断开后点击“使用这份程序”，实际候选连接检查结束后保存；`05-candidate-selected.png` 显示 0.87.1 满足官方要求，组件仍为 0.0.34。收据包含官方 npm 包 0.87.1、2026-09-22 发布时间、Node >=22.19.0、实际 Node 22.22.3 与受管入口。`candidate-selected.json` 中旧 Pi 连接已回收，Amp 继续存在，原会话和原未发字段不变；Pi 注册程序路径因明确选择而改变。

`06-old-program-reselected.png` 显示切回 0.80.5 后恢复不满足要求提示，新候选保留未选。**回选暴露清单缺口**：`reselected-old-pi-inventory.json` 的路径为原 `.local/bin/pi` 所指向的实际文件，而非原别名字符串；`selection-comparison.json` 确认两者解析为同一文件。源码复核发现上次显式程序仅靠 discovery 找回，不在发现结果且无既有收据时会从列表消失。此候选不能标为完整回选通过；修复及新安装复验在 `program-history/` 独立记录。

## 模型、真实请求与冷恢复

再次明确选用 0.87.1 后，`07-new-program-models.png` 显示成功读出原有 `deepseek/DeepSeek V4 Pro` / `Thinking: off`，未修改模型或服务。只点击一次内置短测，发送标记 `FARFOLD-96807342-5d72-468b-b685-32679172d570`，要求不使用工具、不读写文件。新索引为 `pi:/Users/tw/Library/Application Support/ai.farfold.desktop/conversations:01a0f211-a0f1-7194-a8fe-83a72f89f70f`。

**短测失败**：`08-new-program-empty-reply.png` 为“已结束，但未收到可展示结果”，没有得到标记回复，不自动重试。界面启动信息 `pi v0.80.5` 来自组件 `buildStartupInfo` 直接执行 PATH 中 `pi --version`，该信息忽略用于实际进程的 `PI_ACP_PI_COMMAND`；它不能证明受管候选未被使用。精确请求原因继续单独核查，不能把模型读取成功当作请求成功。

同一应用冷启动后明确打开该测试对话，历史原消息返回，模型仍为 DeepSeek V4 Pro / off（`09-cold-history-model-preserved.png`）；没有再次发送。该结果覆盖历史恢复与模型保持，不代表续发成功。

## 保护与退出

所有关键节点的 `pi-external-after-*.json` 均显示列明的四个默认配置文件与日常 CLI 元数据一致；当前 Farfold 明确选用了独立受管程序，没有升级日常 Pi。`first-quit.json`、`final-quit.json` 分别对应两次正常退出，已观察的四个进程均不再存在，冻结源码无变化。最终原 25 条会话索引与原未发字段完整，仅新增本轮一条短测；Pi 注册选择、安装清单、准备进度和本轮测试未发状态按本次操作变化，其余 Agent 配置不变。

`duplicate-cleanup.json` 证明只删除本轮精确重复打包应用，正式应用仍存在且摘要不变。当前正式应用已退出；下一修复片不得沿用本片候选身份宣称验证通过。

## 进程证据边界

本片脚本按 PID、启动时间和执行程序识别已观察进程，父 PID 仅用于首次递归定位。退出后重新托管的子进程仍会被检查，不因父 PID 变化漏报。有限节点的进程快照不能证明采样间出现又离开的全部进程；不把旧片仅比较父 PID 的空结果扩写成更强的证明。
