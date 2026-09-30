# 模型读取无结果：后续源码定位

依据候选 `8d46b23` 的 `05-model-read-empty-result.png` 和 `model-read-protocol-metadata.json`。本记录是正式应用退出后的只读调查；未新增模型请求、登录或修改外部配置。

`model-read-selection.json` 仅从 `agentSetup.v1` 提取 Pi 普通对话目录的公开选择字段：`model=deepseek/deepseek-v4-pro`、`thought_level=off`、`mode=off`，未选择 API 服务。两个 session/new 之后各有一个选项设置协议错误；现有内容无关诊断不含具体错误正文，不能把静态定位冒充收到的原始错误。

源码中存在三段可组合的失败路径：

1. 当前安装的官方 pi-acp 0.0.34 `dist/index.js` 第 2701–2734 行分别实现 `setSessionMode` 和 `setSessionConfigOption`。前者设置思考等级；后者只接受模型和思考选项 ID，不接受额外的 `mode` 选项 ID。Farfold `pump.rs` 的新对话配置恢复循环当时将全部保存字段交给 `session/set_config_option`，没有为从顶层 `modes` 合成的字段选择标准 `session/set_mode` 路径。真实 `configOptions` 中同名字段仍须走其本来接口，不能只凭字符串 `mode` 改路由。
2. `sessions.ts` 从顶层 `modes` 生成通用模式选项，交互设置时已有 `modesSeparate` 路由。但 `session_projection.ts` 收到 `config_option_update` 直接替换选项数组，会丢掉仍有效的合成模式选项；后续 `current_mode_update` 只修改已有项，不能恢复被丢掉的选项。真实事件元数据与这个顺序吻合，但其中具体值仍未捕获。
3. 后端把选项恢复错误降为 warnings 后返回实际选项；前端准备控制器继续记为 untested，并以实际选项替换其比较值。实际与原请求不一致时 `preparationMatches` 返回 false，页面以 `sameSource` 同时隐藏模型和错误，只留下“读取选项后可确认模型”。相同输入的明确重试可再次进入同一状态。

后续修复分别验证：新草稿标准模式路由与真实同名配置的区分、事件更新时保留仍有效的合成选项，以及恢复不一致时在原目标保留失败和用户原选择。不能通过吞掉错误、自动更换模型或思考等级解决；恢复的既有会话及权限保护不因本次新草稿修复放宽。

本调查确认源码反例和安装现象相符；最终根因关闭仍需要受控回归及新正式候选复验。Goose 官方配置动作与此共享准备状态的修复在下一候选实施。
