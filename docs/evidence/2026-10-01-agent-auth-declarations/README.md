# 旧认证声明与当前连接的执行边界

本片修复旧环境声明或未知类型被表现为可直接登录的问题，同时阻止使用另一工作目录、API 来源或持久缓存中的声明执行登录。官方已移除实验 `env_var`，本片只保留其公开说明和不可自动执行的出口，完整 Key 交付仍未实现。见[官方范围](official-auth-scope.md)。

后端沿官方 SDK 的单次 initialize 形成一个连接所有的声明对象；公开存储与界面不暴露终端参数、环境值或执行元数据，运行材料只留在所属连接。前端按 Agent、工作目录、来源失效旧结果与旧按钮；连接状态变化只重读声明。手动明确配置及有效标准 Terminal 继续沿现有路线。具体设计与反例见[后端记录](backend.md)、[前端记录](frontend.md)、[独立审查](review.md)。

## 工程检查

- [Rust 全量](checks-full-rust.json)：427 项通过、3 项既有忽略，fmt/clippy 通过。
- [前端全量](checks-full-frontend.json)：1,091 项通过，类型检查和构建通过。
- [全仓格式](checks-full-format.json)：通过。
- [构建输入](candidate-source.json)：411 个文件；[打包前核对](before-bundle.json)没有变化，正式应用已停止。
- [操作前数据](data-before.json)：29 条会话索引、20 个 Agent、29 项设置；原未发字段仅保存摘要。

上述检查不证明真实 Agent 登录、Key 交付或消息成功。正式安装后须另记录 DeepAgents 旧声明出口、现行终端路线、返回原稿及数据/进程核对；工作区完成不等于已安装。
