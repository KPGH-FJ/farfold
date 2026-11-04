# P11官方历史节点接口只读证据

官方历史点接口存在，P11仍未完成。本次只读源码和公共安装材料，未增加入口、发送分支请求或操作真实Agent、账号、模型、应用及用户历史；原完成条件保持。结论与来源见[摘要](interface-summary.json)，访问回执、tag原件、必要片段和逐项hash见[证据ZIP](interface-originals.zip)。

[Codex ACP v1.13.1固定源码](https://github.com/agentclientprotocol/codex-acp/blob/b1b8490cd165c18626dc3fe83836cdacdef94cd3/src/SessionFork.ts)将消息标识解析为所属turn，再传递lastTurnId；源码参数粒度是整轮，不能称任意消息内的精确切点。[Claude ACP v0.81.2固定源码](https://github.com/agentclientprotocol/claude-agent-acp/blob/5dbb453c63a89746627799b2b06b31ba01a1b674/src/fork-session.ts)将官方消息标识映射到UUID，再调用SDK的upToMessageId；已读SDK类型说明该点包含在内。实际上下文包含与排除尚未运行验证。

不能仅凭普通fork声明及不透明meta启用历史节点。Codex缺少可识别扩展或版本不支持时可转当前复制；version1缺少有效ID、或有效ID无法解析时会报错。Claude版本不支持或ID空缺时可转当前复制；已解析但找不到UUID时会报错。所查返回对象缺少可用的所选点确认观测，不将此扩大为新增echo字段要求。Codex能力与响应的补充观察来自另一个主线commit519c267、包版本2.5.0，未混称固定v1.13.1或实际运行对象。

本机公共候选材料包含Codex ACP1.13.1及相邻Codex0.156.1、Claude ACP0.81.2及SDK0.3.280。未读取当前登记或保存的覆盖路径，实际所选、已用版本仍未知；版本、commit和源码hash仅用于证据定位，不作Agent版本pin或二进制兼容校验。当前Farfold只有当前上下文复制；官方messageId可留在视图中，未知meta保留为详情，单条消息入口仅准备新稿。

最小承接条件仍是确定可用的已选官方接口、真实节点身份和粒度，再验证原对话保留、后续上下文排除、设置/权限/文件影响及失败未知处理。可复用现有共用复制控制器，不能用本地item.id、无效点探测或当前复制代替历史分支。可选SDK内存夹具未运行：函数分支可见，但整个模块初始化的允许影响范围未闭合；未据此推断已读取账号。SDK导入、运行调用、query、Agent、模型与实际分支均为0，三项用例均未测；此实验边界不增加P11门槛。

两个adapter的固定package元数据声明Apache-2.0；本次未保存同commit的LICENSE/NOTICE原文，也未建立SDK许可。ZIP只保留来源、极短片段与事实索引，不复制完整外部模块或SDK源码，不把adapter许可套给SDK。HTTP回执只支持保存的进程退出码和body hash；两次不完整读取仅有观察笔记，不补称HTTP状态或完整失败响应已归档。
