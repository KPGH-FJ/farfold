# 积累代码的提交与推送检查

2026-09-30 用户明确要求提交并推送当前积累的 Farfold 工作。起点为本地 `main` / `eefa4dfaaaf47b2f802d040b96cba82e6d3b807f`，远端 `main` / `c2f33eae110346aa13f5742747d54d81c0842c80`，已有 59 个未推送提交。目标是保存当前产品实现、认可原型及验收证据；完整 G2/G3 和 J1–J6 继续保持未完成。

## 本轮工程检查

| 检查                                                                        | 本轮结果                         | 原始输出                                                |
| --------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `corepack pnpm format:check`                                                | 通过                             | [frontend-format.txt](checks/frontend-format.txt)       |
| `corepack pnpm typecheck`                                                   | 通过                             | [frontend-typecheck.txt](checks/frontend-typecheck.txt) |
| `corepack pnpm test`                                                        | 110 文件、881 项通过             | [frontend-test.txt](checks/frontend-test.txt)           |
| `corepack pnpm build`                                                       | 通过；保留现有大包提示           | [frontend-build.txt](checks/frontend-build.txt)         |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | 通过                             | [backend-fmt.txt](checks/backend-fmt.txt)               |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings` | 通过                             | [backend-clippy.txt](checks/backend-clippy.txt)         |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked`                  | 252 项通过、0 失败、3 项原有忽略 | [backend-test.txt](checks/backend-test.txt)             |
| 当前原型 Node 测试                                                          | 478 项通过                       | [prototype-tests.txt](checks/prototype-tests.txt)       |
| 当前原型 Vite 打包                                                          | 通过；保留现有大包提示           | [prototype-build.txt](checks/prototype-build.txt)       |

集中用户文案检查随前端全量测试通过。补充发布说明与授权记录后，[全仓格式复查](checks/format-final.txt)再次通过。以上是本轮重新执行的工程检查；原型检查仅验证模拟原型。

## 安装身份与证据边界

本轮只读核对候选七的 349 个冻结源码文件，内容全部一致；唯一 `/Applications/Farfold.app` 的四个记录文件摘要一致，签名复核通过。没有修改生产源码、重装应用、发送真实 Agent 消息或改变用户选择。[身份核对](install-identity.json)记录本轮结果；此前的真实操作继续使用[候选七原始记录](../2026-09-30-prototype-fidelity/full-pass/candidate7-ui.md)，不重新标记为本轮旅程通过。

新账号、新密钥及轮换、记住批准、真实签名更新、实际期限归档、完整键盘与全面性能仍未完成验证；外部 Agent 和服务的限制保持原结论。

## 发布内容

产品实现、当前原型和验收证据分别提交；既有 59 个提交保持原历史。发布到现有私有仓库 `KPGH-FJ/farfold` 的 `main`，使用普通推送并核对远端提交一致。生成目录、依赖、应用产物、用户配置与凭据不纳入提交。原始证据保留；发布内容扫描不等于完整用户历史或秘密审计。

- 产品实现：`de74f37`。
- 当前原型与旧设计清理：`c2690c5`。
- 验收证据与本轮检查：包含本目录的独立后续提交。

[发布内容审查](publish-safety.json)覆盖既有 59 个提交的新增对象、当前文件、两份诊断包、244 个原始日志和全部 1,128 张去重截图的本机识别；未发现真实密钥、令牌或私钥。[明确日志清单](approved-evidence-logs.txt)仅用于纳入已审查的日志，不改变全局忽略规则。五张既有验收截图包含账户邮箱元数据，按本轮授权保留在同一私有仓库，摘要未复制邮箱原文。原稿保护文件已经确认仅含受控验收标记；两个嵌套验收 Git 项目保持忽略。

补充 `git diff --cached --check` 对原始证据报告 1,037 处尾空格，全部属于日志、补丁、可访问性导出、TAP 和一份已冻结且排除格式化的观察文档；生产源码与原型提交均通过该检查。为保留原始捕获字节没有改写这些材料；[定位与处理结论](raw-evidence-whitespace.json)保留退出码 2，没有将这项补充检查写为通过。仓库规定的七项工程检查均通过。
