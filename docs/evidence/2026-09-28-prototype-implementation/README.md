# 2026-09-28 原型完整实施与安装验收

状态：本轮功能与界面改动已安装，核心真实旅程已验证；外部条件与未覆盖项仍开放，尚未宣告完整 G2/G3 或 J1–J6 通过。当前正式安装为候选五，已完成本候选部分真实路径及一次正常退出、同版本冷启动；冷恢复后续结果按下文实际观测记录。唯一正式应用仍为 `/Applications/Farfold.app`，0.1.7。保留用户试用后的两条原对话；本轮测试另建带验收标记的对话，不再次清空数据。下文时间均为 2026-09-28 CST。

## 源码与工程验证

本轮补齐完整返回路径、统一 Agent 管理/使用容器、多认证方法与官方账号入口、模型读取与实际测试分离、来源变更确认、真实结束结果、未知发送的保留/放弃、真实审批范围、文件意见按版本保存与独立找回、历史恢复资格、组合筛选、更新影响提示和原子持久自动归档活动。没有新增 Agent 执行循环、消息正文库或外部 Agent 配置写入。

第一候选 270 文件冻结见 `candidate-source.json`，全量前端 454 项通过，Rust 247 项通过、3 项忽略；类型、格式、前端打包、cargo fmt/clippy 均通过。原始日志见同目录。此工程结果不代替安装版旅程。

候选二仅补搜索输入中文确认键保护：`candidate2-source.json` / `installed-candidate2.json`。候选一 SHA `77ddac39ab0ad1688bbdc275e5f7b132bd4b4f076fb329354e073ec6d6148d8d`；候选二 SHA `a509ad8ad307ec6d7298dcc42c6eba700e036fb27ff705bcaa0e36bca29a5d5b`。每次安装前正常退出；第一候选的 8 个受跟踪进程全部结束；包签名与完整复制一致、源码无漂移、生成的重复应用已移除。

候选二走查发现的安装暂离后卡片缺进度及待发编辑提示重复，随后已进入候选三修复；进度入口定位程序步骤，保留原选择，不再次启动安装或连接。候选四继续修复准备失败自动重复读取，以及未连接时把登录能力未知误写成不支持。

| 候选 | 源码与安装证据                                                                                                                                                                                                | 当前边界                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 三   | [源码冻结](candidate3-source.json)、[02:19:58 安装回执](installed-candidate3.json)，272 个源码文件；主程序 SHA `5c60d4a2174a7017325e9bf313d5b7214b4e67613e79a8f0b9f3030ada6bc71f`                             | 签名、复制与源码匹配；安装前 12 个受跟踪进程全部结束。真实结果仅归属下面候选三条目。                                                       |
| 四   | [源码冻结](candidate4-source.json)、[02:50:43 安装回执](installed-candidate4.json)，272 个源码文件；主程序 SHA `2cdfbe6c67bdc20a14c99379db04b986232f0871056383ef372168051a026843`                             | 签名、复制与源码匹配；安装前 11 个受跟踪进程全部结束，生成的重复应用已移除。已由候选五替换。                                               |
| 五   | [03:03:08 源码冻结](candidate5-source.json)、[03:06:04 安装回执](installed-candidate5.json)，272 个文件，较候选四改变 9 个文件；主程序 SHA `8a81d4ee4ffcc6a01b766d675597b83ea2c2db1d1fc8193ba3c66d919e7103b4` | 当前正式安装。API 密钥随来源变化失效、API 列表搜索、历史准备返回的增量已审查；安装前 11 个进程结束，签名、复制及源码匹配，重复应用已移除。 |

候选五 [前端 497 项测试](frontend-tests-candidate5.log)、[类型检查](typecheck-candidate5.log)通过。[完整性核对](candidate5-integrity-check.json)确认源码无漂移、Rust 源码与候选一全量工程检查时的哈希完全相同、没有超过 1500 行的文件，审批文件与专用验收文件内容均匹配。Rust 247 项通过、3 项忽略仍引用该未变源码的原始检查，不称本次另跑了一套 Rust 测试。最终全仓格式检查回执见 `format-check-candidate5-final.log`，此前两份派生进程快照格式错误的失败日志保留。

## 已观察的安装结果（严格归属候选）

- 候选一：原两条对话与三 Agent 保留；发现筛选无结果可清除；自定义接入直达表单并聚焦；返回发现保留筛选；非秘密 API 表单关闭有放弃确认；返回草稿文字保留。Codex 官方组件安装成功、沿用现有账号，6 Astra/Ultra 准备成功；权限 Ask for approval 收到匹配设置回执。没有发送 API 密钥或代为新注册。
- 候选二：候选一全局测试草稿恢复且未自动发送；Codex 6 Astra/Ultra 准确回复 `FARFOLD-CODEX-20260928-OK`。执行指定文件写入与 sleep 45 后准确返回工具标记；切去 OpenCode 发另一请求时界面确有两条进行中，返回 Codex 历史完整。
- 候选二：OpenCode 1.18.31 默认 OpenCode Zen/Big Pickle 请求失败，界面显示错误。只读独立核对本次官方数据库：native id `ses_f1bfbe7deffevR2Aq2JwdDGTfq`，01:58:10.526 请求、01:59:29.180 结束，APIError/statusCode429/isRetryable=true；明确服务限流，零内容块、零用量。没有 Retry-After，恢复时间未知，不判定网络故障或余额不足。
- 候选二：独立新对话明确选用用户原来源 OpenCode Zen/Nemotron 3 Ultra Free，准确返回 `FARFOLD-NEMOTRON-20260928-OK`。实际 sleep 90 任务点击停止后收到已停止；已排队消息保持暂停，未自动发送。待发编辑另存未保存文字，原队列仍保留且继续发送禁用。
- 候选二：Codex 两次 apply_patch 对同一专用文件产生真实差异（V1→V2、V2→V3）；两版意见各有独立行定位。切到 V3 不带入 V2 意见，提示存在其他版本意见；另保存普通输入草稿及本轮文件附件。
- 候选三：冷恢复保留全局草稿、既有对话草稿及附件、两版文件意见、暂停队列及未保存队列编辑。只读存储摘要与安装前完全匹配，见 [冷恢复前快照](candidate3-before-cold-recovery.json)、[冷恢复后核对](after-cold-recovery.json)；这些存储回执本身不代替界面或发送保护验证。截图 [09](screenshots/09-candidate3-cold-permission-gate.jpg) 为冷恢复权限门禁，[10](screenshots/10-candidate3-recovered-queue-edit.jpg) 为恢复的队列编辑。
- 候选三：Codex 本次单次批准后，02:26 准确返回 `FARFOLD-APPROVAL-DONE`，指定 [farfold-approval.txt](installed-work/farfold-approval.txt) 内容精确匹配；审批现场见 [11](screenshots/11-candidate3-real-approval.jpg)。这不是“批准并记住”验收。Nemotron 原暂停队列经 02:25 明确继续后返回 `QUEUE-OK`，未保存的编辑仍留在输入框，没有被当作该次队列消息发送。
- 候选三：Pi 已安装，但准备模型时出现 333 次失败的自动重试、0 次模型消息；循环随后停止。Claude Subscription 终端登录退出 1；当前浏览器与回调明确给出 `access_denied / account_on_hold`，没有取得授权码。本次登录未通过，不能算 PTY 登录成功或归因于 PTY 故障；未保存 OAuth 授权链接或该页截图。
- 候选四：Pi 首次模型读取仍失败，模型→账号→模型返回保持错误；一次手动重试后总计仅 2 次 `session/new`、0 次 `session/prompt`，之后计数稳定。自动重试修复在此场景通过，模型读取未通过，详见 [只读报告](pi-candidate4-read-failure.md) 与截图 [13](screenshots/13-candidate4-pi-stable-failure.jpg)。安装的适配包要求 Pi 至少 0.81.0，本机是 0.80.5；这是未满足的兼容性要求，不是已确定的错误根因。
- 候选四：Cline 未连接时准确提示先连接读取登录方式；连接后返回 Cline、ClinePass、ChatGPTSubscription 三种真实登录方法，切到 ChatGPTSubscription 后只显示对应入口，见 [14](screenshots/14-candidate4-multiple-login-methods.jpg)。未发起认证，不能算账号接入成功。
- 候选四：仅用本轮自建验收对话创建“验收0928”组并移入两条，工作目录不变；含草稿或文件意见的对话阻止批量归档，另一条本轮 Big Pickle 失败对话可归档并恢复。未据此改变或清理用户原对话。
- 候选四：Codex 恢复原历史与 6 Astra/Ultra，最近文件 V3 的一份意见保留，权限显示待重新确认；三栏差异可读。900×620 逻辑尺寸下产物切为覆盖面板、可关闭回对话，输入与权限控件均可见，见截图 [15](screenshots/15-candidate4-restored-three-pane.jpg)、[16](screenshots/16-candidate4-narrow-artifact.jpg)、[17](screenshots/17-candidate4-narrow-composer.jpg)。这只是所示窄窗路径，不代表全部布局与键盘验收通过。

- 候选五：使用无效占位 API Key 在真实输入框输入，改变地址后 Key 清空且获取模型按钮禁用；改回原地址也不恢复 Key，见 [18](screenshots/18-candidate5-api-source-clears-key.jpg)。没有发出请求或保存配置。真实配置不足 3 条，API 列表搜索仅有单测覆盖，未冒充安装版通过。
- 候选五：历史列表中未连接 Codex→前往准备→API 设置→返回同一 Codex→连接→完成，回到原历史选择与查找范围，未自动查找，见 [19](screenshots/19-candidate5-history-preparation-return.jpg)。随后明确查找官方历史，已加入的本轮项目不能重复添加；带入一条 `FARFOLD-C7 literal reply test`，索引总数为 6。该条官方正文可读，但原模型及思考等级无法确认，界面准确保持只读并禁止续发，见 [20](screenshots/20-candidate5-import-readonly-history.jpg)。不把正文可读写成可恢复执行。
- 候选五：Codex 恢复 6 Astra/Ultra、候选四冷恢复测试草稿与 V3 意见；明确确认权限后于 03:16 发出本轮请求，真实 apply_patch 将专用文件 V3 改为 V5，外部指定 [candidate5-approval.txt](installed-work/candidate5-approval.txt) 经单次批准写入成功，内容精确匹配见 [完整性回执](candidate5-integrity-check.json)。03:20 主动停止 sleep 90 任务后，一条队列保持暂停、未发送，见 [22](screenshots/22-candidate5-codex-stopped-queue-paused.jpg)。
- 候选五：OpenCode Zen/Nemotron 于 03:18 准确回复 `FARFOLD-C5-NEMOTRON-OK`；03:19 与 Codex 两条真实任务同时进行中，见 [21](screenshots/21-candidate5-two-real-agents-running.jpg)。其 sleep 60 任务于 03:20 自然完成并返回 `FARFOLD-C5-PARALLEL-END`，在停止按钮操作前已经结束、没有收到取消，不能称已测试停止第二个任务。
- 候选五：按 Codex 同一工作位置暂停发送后，“继续发送”禁用；恢复该位置发送后，原队列仍暂停，没有自动发送，见 [23](screenshots/23-candidate5-resume-keeps-queue-paused.jpg)。更新页在没有发布通道时没有误称已是最新版。诊断导出 [33 文件压缩包](diagnostics-candidate5.zip)，[限定标记核对](diagnostics-candidate5-check.json)未发现已知正文、Key 或路径标记；这是限定检查，不是全量隐私审计。
- 候选五：03:25 已取 [冷退出前快照](candidate5-before-cold-recovery.json)；正常退出后的 [03:27 进程核对](candidate5-quit-check.json)确认 12 个受跟踪进程全部结束，随后同候选五冷启动。冷后内容核对、界面权限门禁及主动继续的真实结果见下面当前交接，不以启动成功代替续发验证。

截图 `01` 属候选一；`02`–`08` 属候选二；`09`–`12` 属候选三；`13`–`17` 属候选四；`18`–`26` 属候选五。各候选结果不得互相改标签，也不代表该候选全量通过。新修入口与关键回归已按下文实测，未覆盖的完整账号、授权与发布条件继续单列。

## 当前交接

唯一正式安装为候选五，主程序 `8a81d4ee4ffcc6a01b766d675597b83ea2c2db1d1fc8193ba3c66d919e7103b4`。本轮全部确定实现遗漏已经修复并独立复核；没有遗留运行中的验收请求。当前保留空白新对话供试用，4条本轮测试对话归入验收分组；另外带入的旧只读验收历史已归档，可恢复。用户原两条对话未清理或更改。

候选五最后冷恢复：03:29 [前后核对](candidate5-after-cold-recovery.json)确认未发送内容原始与语义摘要、逐记录、选择、6条当时索引、分组与发送管理完全一致，旧12个进程身份全部消失，同一安装SHA不变。界面打开Codex后，恢复的队列保持暂停，权限待确认；明确重新确认权限后仍需单独继续，见截图[24](screenshots/24-candidate5-cold-queue-permission-gate.jpg)。03:32主动继续后原消息准确进入历史并收到正文；消息自身写有“只有我明确继续”这一条件，模型回复“等待你明确继续。”，没有返回预设队列标记，此次不计作标记校验成功。03:34补充明确澄清后，同一冷恢复对话准确返回 `FARFOLD-C5-RESUME-OK`，见截图[26](screenshots/26-candidate5-cold-resume-reply.jpg)。未把后一结果覆盖前一实际回答。

候选五另外从新草稿确认仍是OpenCode Zen/Nemotron 3 Ultra Free，发送一条无工具首消息，03:33准确返回 `FARFOLD-C5-NEW-CONVERSATION-OK`，见截图[25](screenshots/25-candidate5-first-message.jpg)。全局原测试草稿是在完成恢复核对后主动替换并发送，非恢复丢失或自动发送。因此最终索引新增为7条、其中1条验收历史已归档；不能继续把03:29的6条快照当作最终数量。收藏增加与取消回到0，4条测试对话批量移入同一组，未影响两条用户原记录。

仍开放：Claude 当前账号被限制，未完成登录；Pi 读取模型失败且具体错误根因未取得；OpenCode Big Pickle 本轮限流未证明恢复。Cline 等新账号真实登录、用户授权的新服务密钥交付与轮换、具有更广持续授权范围的“批准并记住”、真实发布源的签名更新、按实际时间到期的自动归档仍未验收，须各自真实条件与适当授权。不能用单次批准、短请求、模拟事件、文件存在性或改库代替，也不能据当前结果宣告完整交付。

03:40 [最终只读状态](candidate5-final-state.json)确认原两条用户元数据仍精确不变，索引7条、归档1条、收藏0条、分组成员4条；输入草稿与队列为空，V3文件意见1版完整保留。发送管理均允许，应用身份一致，272个冻结文件零漂移。正式应用保持打开，未自动提交代码。
