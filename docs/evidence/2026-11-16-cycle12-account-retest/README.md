# 第 12 周期 Amp 和 MiniMax 账号复验

2026-11-16，macOS arm64。用户确认已从独立官方入口登录 Amp，并在 MiniMax 官方设置配置小米。沿本机正式 Farfold 0.1.7，CDHash `2eff9a8676ebdb646b8f53b82523528d1aa694ea` 复验。

## MiniMax 小米新对话

Farfold 正常新对话切到自建非桌面目录。新连接首先恢复 Farfold 原来保存的 M2.7。将本次独立草稿明确选择 MiniMax 官方配置的 `mimo-v2.6-flash`，关闭并重开选择器读回所选模型和「已有设置」。首次按界面当时显示的「加入待发」出现「消息未发送」，原稿保持，对应协议未见 `session/prompt`。按钮恢复「发送」后重新核对同选项，手动发送同一测试请求一次。

实际 Farfold 回复唯一精确标记并显示已完成。对应新连接只有一次 `session/prompt`，有返回且未见工具事件。按唯一自建目录核对 Farfold 保存的同一索引和配置，服务为已有设置，模型是来源带 `custom_provider` 的小米 MiMo。使用同一登记程序的官方 `provider list --json` 校验，供应商 ID 匹配，配置主机是小米，目录含同一模型，协议为 OpenAI Chat Completions。没有取得能与这一对话原生 ID 匹配的厂商专门路由日志。验收限这条独立新对话。正常退出并更新正式版后，从侧栏冷开同一原索引，原回复、已有设置及 MiMo 可见。有一条原生 session/load，零新建、零发送。原 M2.7 对话未发送，其历史账号及额度仍按原条件核对。[原记录](../2026-11-16-cycle12-original-config/README.md)

## Amp 厂商登录和 Farfold 认证

同登记的 Amp 官方 CLI 账号列表确认已保存账号。相同程序的默认列表和包含归档的列表均成功返回空数组。当前账号范围内未找到可供导出的旧厂商 T-ID。正式 Farfold 中已有一条本地 Amp 索引，按该笔索引创建时间配对一次已有设置的真实请求，原请求回执为 `auth_required`，无助手结果。它和本次 CLI 账号的采用关系不能确认；安装的适配器 0.9.0 没有有效账号或旧线程的读取入口。本轮仅做原生账号、列表和既有回执核对，零新增 Amp 模型请求。目录 0.13.0 支持其自身已存映射，厂商 T-ID 的正式带入、原文和续答仍待证明。[账号入口及来源](../2026-11-16-cycle12-amp-native/README.md) · [官方账号文档](https://ampcode.com/docs/cli#manage-cli-accounts) · [0.13.0 会话接口](https://github.com/tao12345666333/amp-acp/tree/v0.13.0#native-amp-thread-lifecycle-extension)

## Amp 的小米模型发现

用户在 Amp 配置小米 Custom URL 后，官方 CLI 只读列表确认路由启用，主机为 `api.xiaomimimo.com`，映射为 `xiaomi/mimo-v2.6-flash -> mimo-v2.6-flash`。Farfold 原来使用的 `amp-acp 0.9.0` 只显示旧档位。从正式应用「管理程序与版本」更新目录组件至 `0.13.0`，并选择用户已安装的官方 CLI `0.0.1794816357-gc47859`，旧版组件留在安装清单。官方 CLI 以已登录账号读取模型，53 项中包含该 ID。正式版 Farfold 读取成功但只显示 `Default`。

对同一已选组件、CLI 和目录做两次只读握手。正常启动只声明 `Default`。仅在第二个临时诊断进程限制读取组件自己的旧密钥文件后，返回 54 项，明确包含小米模型。文件内容未被检查或改动。组件源码会优先把旧密钥传给 CLI，此时已登录账号的模型列表未被呈现。实际采用该登录账号、Farfold 选中 MiMo 和单次真实回复仍待验证。本轮零模型请求。[目录版本与模型发现](https://github.com/tao12345666333/amp-acp/releases/tag/v0.13.0) · [组件独立密钥来源](https://github.com/tao12345666333/amp-acp/blob/v0.13.0/src/index.ts#L105-L163) · [Amp CLI 凭据优先级](https://ampcode.com/docs/cli#manage-cli-accounts)

### Amp 小米单次正式实测

用户明确批准改名备份旧组件密钥，改用其已登录的 Amp 账号。改名前后的同一文件 inode、所有者、权限、大小和修改时间一致，旧路径已空。旧 `Medium` 准备项在新版无对应选项，正式 Farfold 通过「检查模型设置」读取实际模型，在菜单搜索并选中 `mimo-v2.6-flash`。使用该 Agent 后，同一新草稿的模型选择为开启，目录 `farfold-c12-amp-mimo.Mb2NiQ5c` 为本次空白样本。

Farfold 从正常输入框发送一次。协议只记录一次 `session/prompt`，时间 `2026-11-16T10:22:35.345Z`，收到助手正文且未观察到工具事件。界面显示「已完成」，原生导出含同一测试文本和正确回复 `FF_C12_AMP_MIMO_20261116_1815_OK`。该账号的同一原线程是 `T-01a1e3e1-6bd5-7507-9526-52f83651763e`。

官方 `amp threads usage T-01a1e3e1-6bd5-7507-9526-52f83651763e --details` 的 `Model Routing` 指向已核主机为 `api.xiaomimimo.com` 的连接 `c503683d-3a56-4bdc-b8d2-06ae84d027eb`。模型 `xiaomi/mimo-v2.6-flash` 的 `Agent` 用途为 1 次，`Thread Title` 用途为 2 次，两者均指向同一连接。用量合计 28,821 token，其中输入 28,516，输出 305。此证据覆盖这条新对话的模型和实际路由。[原线程](https://ampcode.com/threads/T-01a1e3e1-6bd5-7507-9526-52f83651763e)

### Amp 原对话冷开和续答

只结束已完成的 Amp 自建测试连接，其他任务保持运行。正式 Farfold 用搜对话找到原索引，复用原目录，协议记录一次 `session/load`，无 `session/new`，回放原问题和回复。模型设置读取 `mimo-v2.6-flash` 与「沿用已有设置」。组件原 `S-mwj46ioq-5gpfrn` 继续对应原 Amp 线程 `T-01a1e3e1-6bd5-7507-9526-52f83651763e`。

新续问依赖上一条回复，正文没有复述原标记。由于该连接的待发处于暂停，确认队列只有这条新消息后按「继续发送」。同一连接记录一次 `session/prompt`。官方 Amp CLI 在登录有效时执行 `threads continue <原线程> ... --model xiaomi/mimo-v2.6-flash` 并拒绝 `--model`，原话为 `The --model flag is not enabled for your account.` 界面报未完成。之后同一原线程的官方导出仍只有原两条消息，用量维持 1 次助手和 2 次标题。未证新增推理或成功续答，原模型设置保留。官方文档把 `--model` 说明为新线程选项，当前目录组件 0.13.0 在传入原线程后仍附加它。[官方续接说明](https://ampcode.com/docs/threads#continue-a-thread-anywhere) · [组件发送参数](https://github.com/tao12345666333/amp-acp/blob/v0.13.0/src/amp-transport.ts#L205-L228)

正式 Farfold 从该失败对话执行「检查能否关闭此对话的连接」并确认关闭，界面提示连接已结束。再次打开原对话，原正文及 MiMo 配置仍可见，提示先前请求未自动重发。精确 T-ID 的官方导出字段 `meta.threadModel.model` 仍为 `xiaomi/mimo-v2.6-flash`。官方 CLI 在输入为空时，用原 T-ID 省略模型参数可返回该线程的初始化事件，无续问或模型结果。目录组件在本地 CLI 模式下选择 `Default` 会省略模型覆盖，但 Farfold 将记录该选择，需要用户明确允许再实测。[目录组件选项](https://github.com/tao12345666333/amp-acp/blob/v0.13.0/src/server.ts#L1246-L1288)

用户允许只对这条测试对话临时选择 `Default`。正式版保存后，通过原输入框发送一条依赖第一条回复的续问。协议 `session/prompt` 自 `2026-11-16T11:00:48.280Z` 发出一次，回复精确复述第一次的标记，界面显示已完成。官方导出确认同一 `T-01a1e3e1-6bd5-7507-9526-52f83651763e` 原线程，从两条消息增至四条，续问出现一次，原生保存的模型仍是 `xiaomi/mimo-v2.6-flash`。官方用量的 `Agent` 从 1 次增至 2 次，增加的 1 次同样走 `api.xiaomimimo.com` 的 `c503683d-3a56-4bdc-b8d2-06ae84d027eb`，标题推理维持两次。完成后从同一对话恢复显式 `mimo-v2.6-flash`，设置请求成功回包，界面读回原模型和 `Auto`，没有再发送。此正例限定为沿原线程模型续答，已证显式 `--model` 的原失败仍适用于当前组件和 CLI 组合。[同一原线程](https://ampcode.com/threads/T-01a1e3e1-6bd5-7507-9526-52f83651763e)

## 首条消息的状态提示

已复现错误提示的两层结果：当首条消息暂时无法执行时，通用输入框曾显示「加入待发」，实际新对话首条消息不会保留在待发队列。共用输入框在这一种新草稿入口上保持首条内容，处于该状态时使用「发送已暂停」，解除后由用户手动发送。原有对话和其他可持久化待发入口继续走原行为。未通过本次回执定位 MiniMax 当时具体触发哪个暂停条件。

本批四个关联前端测试文件共 84 项通过，类型、格式和差异检查通过。生产候选固定 2,634 项，更新唯一正式版前后 236,586 项保护数据摘要一致，重复产物已移除。[实测与安装回执](results.json)
