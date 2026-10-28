# Farfold

Farfold 是独立的多 Agent 桌面工作台，用同一套对话、任务状态、审批和内容界面进行编程、写作、阅读与普通交流。Agent自己负责推理、工具执行、认证、模型和历史；Farfold通过官方接口启动进程、发送请求、呈现事件，不实现第二套Agent loop。

当前内部版本为 **0.1.7**，内部使用平台为macOS Apple Silicon。唯一正式应用最近安装的功能源码为 79e4219b28288d47ada603265580183cdbc694bb；Windows已有源码适配，实机另验。同一版本号不代表相同二进制，也不代表全部能力通过，当前身份与证据见[当前状态](docs/status.md)。

首批交付保持 **29家 × 八项标准**，以[产品契约](PRODUCT.md#3-当前接入完成标准)判断。目录、源码、工程检查、受控样本、正式应用分项和真实Agent工作分别记证。2026-10-09既有授权允许在账号、服务和模型选择明确且条件具备时进行有界真实验证，无需再等待笼统确认；缺少具体条件逐项交接。**NEW-24受影响的新真实发送继续暂停**。原整组六条旅程门槛不恢复，公开签名、公证、分发及更新渠道仍按用户决定后置。

- 可以先写无工作文件夹草稿；发送或使用文件入口时再明确选择位置。草稿、附件、待发和意见可保存恢复，文件需重新核验，未知结果不自动重发。
- 对话资料搜索、多个已加载对话的正文查找、明确选择的未加载官方历史读取、当前附件解析文字查找各有范围，不是全量持久全文索引。
- 从“探索Agent”准备或管理接入，不必先选项目。认证按实际需要，短消息测试可选；完成准备返回草稿，不自动发送。
- 首条消息接纳后保留Agent、服务来源与历史；模型和推理仅在安全空闲、真实回执匹配且保存后生效。已有对话的列表、正文和继续使用分别验证。
- 支持时，“复制当前对话”通过官方能力复制本次处理时的完整上下文；“用相同设置再开一段”和单消息新稿不复制完整历史，均不自动发送。
- Office、PDF及文字预览和绑定版本的意见已有实现，格式和可见范围有明确限制。文件报告不等于磁盘写入，意见加入草稿也不等于Agent已完成返工。
- 网页支持多标签、公开页和本地预览；逐页明确记住无秘密公开网址后，重启只列清单，点击才打开，旧读取许可不恢复。
- 技能/MCP清单和部分管理通过已核官方方式提供；额外技能目录只作本次发现，整份结果只读，不安装、不持久配置，也不证明当前对话采用。
- 完成通知已有独立偏好且默认关闭。正常结束条件、系统提交、实际显示、声音与点击分别判断，当前未验部分见状态页。

## 从这里开始

- [产品契约](PRODUCT.md)：产品边界、页面规则与八项接入标准。
- [当前状态](docs/status.md)：当前实现、验证层级、失败和未解决问题。
- [源码架构](docs/architecture.md)：模块职责、数据归属与生命周期。
- [内部使用说明](INTERNAL-USE.md)：操作入口、范围限制与数据位置。
- [唯一活动计划](plans/agent-access.md)：短执行入口，只安排顺序、依赖和本批出口。
- [任务要求参考](docs/agent-access-requirements.md)：按任务ID查阅151条原始要求、所属包及共同完成条件，不另行调度。
- [目录说明](docs/README.md)：当前文档、设计原型、证据与历史的分工。

## 开发

macOS开发需要Rust工具链、Xcode Command Line Tools，以及可运行Corepack/pnpm的Node环境。项目锁定pnpm 9.15.0，依赖按lockfile安装。Windows源码及验证边界见[平台说明](docs/architecture.md#平台边界)。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

开发和安装统一使用Farfold标识 ai.farfold.desktop 及同一份应用数据，不维护Dev/Test/QA应用。运行开发模式前先保存工作并正常退出已安装应用。Agent的HOME、账号、配置和历史由Agent自己管理。

本机只维护 /Applications/Farfold.app。更新按既有授权先核实无活动工作、正常退出并保留数据，再替换已验证候选，不中断活动Agent；缺少具体安全条件时再交接。安装验证后精确移除重复应用产物。不要整体清空混有历史数据备份的src-tauri/target目录。

接入使用本机已有程序或官方目录的安装方式；内置发现入口不等于缩减29项范围。所需Node等工具优先复用本机，否则按明确官方来源准备。安装、连接、认证和实际请求分别判断。

## 检查与内部打包

```sh
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

开发中先执行受影响检查；依赖闭合的一批功能稳定后统一完成完整工程检查、独立复核、正式安装与本批实际验证。相关输入变化、失败或疑点仍须必要复核，不把分项通过当整项完成。

首次了解产品范围后，续接默认读当前状态与短计划，再用 `corepack pnpm docs:task P13` 等按ID读取相关要求；NEW条目须显式指定相关包，例如 `corepack pnpm docs:task NEW-24 --package B,C,K`。工具补读已声明包依赖及普遍条件，错误ID或NEW缺少包会失败，不回退全表。参考拆分仅改变存放位置和读取策略，29家八项标准、151条完成条件及受影响契约与安全验证不变。`corepack pnpm docs:check` 检查这些文档边界和导航，不替代产品验收。

前端build不产生安装验收。内部macOS应用使用：

```sh
corepack pnpm tauri:build:internal
```

产物位于src-tauri/target/release/bundle/macos/Farfold.app，不自动替换正式应用。交付记录源码、工作区差异、应用身份、数据保持及本次实际覆盖范围；本地ad-hoc签名不代表公开分发条件。

## 开发边界与历史

改动前阅读 [AGENTS.md](AGENTS.md)。Farfold不代写Agent配置、不建私有HOME，不实现客户端文件或终端工具替Agent工作；文件查看、交付和登录终端沿各自范围运行。LifeModel仅保留默认关闭设置和空钩子，没有真实采集或注入。编辑器、多窗口、Linux、移动端及远程项目范围按产品契约。

本次整理前的三份说明已完整归档，见[2026-10-17归档索引](docs/archive/2026-10-17-documentation-alignment/INDEX.md)。其中README快照内的相对链接按原仓库根目录解析，整理前提交为e3be55b4ba5cf385cb39bdf523feb75c5a26edf6。历史记录不恢复旧授权或旧“下一步”，当前接续只看状态与活动计划。
