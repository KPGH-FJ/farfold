# 首次 API 密钥提示修复：安装结果

`f5abc70` 已安装于唯一 `/Applications/Farfold.app`，二进制 `b1221e05fa461260d0f218d77995adeab68ee65f278094353317c5abf9defd58`。安装于 2026-10-01 10:33:07，10:37:23 退出核对完成。[安装收据](candidate-install.json)四文件一致、签名检查退出 0；[437 项输入](candidate-source.json)至[退出](after-exit.json)未变。

## 实际修复与检查

只有已有保存记录或本轮确有输入 Key 被清空时，才显示来源改变后的“重新填写密钥”。新表单从未填写 Key 时不误示旧密钥失效；真实来源变化仍清空当前输入，已保存来源改回也不能恢复旧 Key。见[实现/红绿](implementation.md)和[独立审查](review.md)。

[全量前端](checks-frontend-final.json)为 137 文件、1,213 项通过，类型与构建退出 0；[格式](checks-format-final.json)、[重新打包](checks-bundle-final.json)通过。125 项[后端输入逐字不变](backend-reuse.json)，复用前片 501 Rust（3 既有忽略）及 fmt/clippy。未因这处界面变化重复运行实际 Agent 服务探针。

## 同一候选的界面结果

1. 新建空表单 Chat → Messages，[首次切换](01-empty-messages.png)不再出现重新填写提示；读取、测试、保存仍禁用。
2. 仅填写公开的名称与 `https://api.example.com/v1` 占位地址，[界面要求首次 Key](02-first-key-required.png)，三项操作仍禁用。没有输入 Key、添加模型、请求、保存或触发 Keychain。
3. 格式恢复为 Chat，[改回结果](03-return-format.png)仍无旧密钥误提示、首次 Key 仍必填。清空本轮公开占位字段后正常关闭空表单，[目录仍为空](04-api-unchanged.png)。
4. [返回原 Amp 空稿](05-original-draft.png)，没有改变模型、推理选择或发送内容。

第一次键盘输入中文/冒号未完整进入表单，现场先观察到不完整地址的校验提示，再用粘贴纠正；没有网络请求，不把键盘输入工具问题当作产品失败。完整状态分别保存在各图同名 `.txt`。

正式服务目录为空，故已有保存记录的来源改回、已输入 Key 清空等路径本片限组件行为验证，不能冒充新密钥保存/交付实测。Messages 云端首发/续接和全目录账号条件仍保持未测，见[前片范围](../2026-10-01-agent-service-messages-implementation/installed.md)。

## 数据与退出

[退出核对](after-exit.json)中原 35 索引、37 份启动配置、46 项设置和所有原未发字段摘要保持，无新索引或设置。[协议元数据](protocol-metadata-final.json)仅一份 Amp 启动/准备记录，零 prompt、零 authenticate。两个[已观察进程身份](all-observed-processes.json)按 PID + 启动时间全局确认结束；正式应用后代为空。

[重复应用清理](duplicate-app-cleanup.json)核对同候选四文件后只删除精确打包副本，保留正式应用、源码、证据与用户数据。
