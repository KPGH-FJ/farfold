# 受管安装路径：独立终审

2026-10-01 15:25。只读审查结论：当前冻结范围没有确认的阻断问题。审查者未运行 Cargo、应用或 Agent，也未修改生产源码。

## 身份与范围

[source-final.json](source-final.json) 的 14 个源码/测试文件已逐一计算摘要，与实际文件及此前已审 [patch-manifest.json](patch-manifest.json) 的 `candidateSha256` 全部一致；没有应用后生产差异。三份补丁摘要也未变化，完整 [candidate.patch](candidate.patch) 为 `22e15e0c00bfe6f4243930275bc22e206aa4547e16001c3a27bd02ddf87ad120`。最长文件 1,106 行。这份身份核对只覆盖这 14 个文件，不能代替正式候选的完整输入或安装身份。

## 已核边界

- [managed_paths.rs](../../../src-tauri/src/managed_paths.rs) 将新普通安装与伴随程序放在不同目录；`Layout::Agent` 与 `Layout::Companion` 不能互认新命名空间。合法旧 `agents/<原 ID>` 保留，两类旧收据均可核验，但旧路径、当前选择和收据不迁移。
- 旧 ID 必须是一个原文目录组件；绝对路径、逃逸组件、路径别名及任一后代目录符号链接不授予归属。根必须是精确直接子目录、普通目录且词法路径与实际路径一致。缺失根只在调用方明确允许原卸载元数据重试时成立，其父目录仍须通过同样检查。
- [installations.rs](../../../src-tauri/src/installations.rs) 根据原 `program_only` 选择布局。外部记录不会因为路径位于这些目录就新增管理权；旧新收据可各自选择与卸载。元数据失败后的原重试与最后删除收据顺序未改。
- [Kilo](../../../src-tauri/src/acp_client/auth_route.rs)、[Copilot](../../../src-tauri/src/acp_client/auth_route/copilot.rs) 和 [Goose](../../../src-tauri/src/acp_client/preparation_actions.rs) 只复用新旧根核验。原来源、版本、参数、收据与实际程序/包形状条件保留，`program_only` 仍排除组件补充，不扩大登录或配置路线。
- 新普通候选只改父目录准备；原命令、参数、环境、候选检查、提交和失败保留旧目标链路不变。伴随程序的现有编码名称和目录保持。

## 验证证据与限制

已核 [red-checks.json](red-checks.json) 及其原日志：旧实现实际为 8 失败、2 通过，均为运行后的行为断言，非编译失败。[green-checks.json](green-checks.json) 的 7 组日志与收据一致：路径 4、伴随程序 1、库存 32、路线 17、Copilot 11、配置动作 6、普通候选 2，共 73 项通过，各命令退出 0。[格式收据](fmt.json) 退出 0；审查者未重复执行这些检查。

受控测试覆盖新旧路径、命名空间互斥、祖先及根符号链接、缺失根、旧 ID 逃逸、两份收据独立选择/卸载及原认证证明。编码测试证明的是词法字符串互异，不能扩大为所有大小写不敏感文件系统的物理无碰撞证明。

本次终审和定向测试不证明 Junie 已在正式应用安装/连接成功，也不确认旧 `parse_error` 的根因。全量检查、正式候选身份与安装旅程由根任务另行留证。
