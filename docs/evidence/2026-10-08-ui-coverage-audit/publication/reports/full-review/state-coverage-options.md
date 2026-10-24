> 2026-10-24 隐私发布副本。历史结论及已测/失败/未测边界保留；本机路径和生成标识已脱敏，末尾换行统一为一个LF。实拍图、原始AX及中间数据仅本地保留，相关链接通向公开哈希清单，不表示原图已发布。

# 覆盖缺口与受控状态展示可行性

2026-10-08。对象：当前 Farfold 源码 `f720d6a77bdc4f4610c98f7b01d654dcc6d01ae3`、既有 113 组界面/条件分支清单，以及仓库已有测试、fixture、原型和冻结证据入口。113 组不是页面数，也不是覆盖率分母。

## 结论与本轮进度

1. **存在不改生产源码、不新建应用、不登录、不发送模型请求的当前组件展示途径**：两份已有 SSR 导出测试。第一阶段主线程追加授权后，本子任务执行这两份文件中名称匹配 `exports` 的用例；2 文件、6 项通过、1 项未选中。原样复制 22 份 HTML 到 [controlled-views/](../../file-inventory.html#external-1b5322552edb199e)，未改 HTML/CSS、生产组件或测试。
2. 22 份实际覆盖 **17 个接入配置静态样本 + 5 个 Composer/侧栏静态样本**，没有补齐实时审批、问题表单、完整队列、文件差异与媒体，也没有证明鼠标/键盘操作成功。
3. **22 页现已由主线程的 IAB 实际渲染并截图，本子任务已逐张目视复核**，见下方逐图记录。独立子线程自己的 IAB / 浏览器 ID 2 不可用，未绕用其他浏览器；截图操作由主线程完成。当前证据为静态组件目视，仍不是安装版或交互成功。导出时的 `receipt.json` 保留原始 `render_status: pending`，后续渲染事实以 [截图清单](../../file-inventory.html#file-127) 与本节复核为准。
4. 审批、提问、停止未知、队列编辑、diff、文件读取失败、冷历史图片等原有单测大多只生成内存字符串或调用回调断言，没有现成浏览器页。主线程随后明确扩展授权，在证据目录内新增独立当前源码导出入口，现已导出并由主线程截图 12 个关键状态 HTML，本子任务已逐张目视；范围和剩余缺口见末节，只计受控视觉。
5. 唯一旧原型有现成审批/提问/停止/恢复/成果模拟入口，但会改其自身浏览器演示存储，而且与当前生产界面有时间差。主线程已决定本轮先不启动。不得拿它代替当前源码组件或安装版。
6. 源码清点只定位覆盖条件，不据此新判 UX 缺陷。真实 Agent、原生窗口接缝、持久化、认证、错误和恢复的端到端状态仍需对应授权、环境与后续观测。

本轮证据：[导出回执与 493 个输入摘要](../../file-inventory.html#file-082)、[AgentSetup 原始导出清单](../../file-inventory.html#file-076)。回执记录了测试命令、源版本、场景与字节摘要；相关源码/配置/资源无未提交变化。正式安装版仍由主线程单列身份，不以当前源码代替。

## 产品与执行边界

- 当前产品要求状态按实际能力、选择和真实回执呈现；原型模拟不能搬入正式应用。[PRODUCT.md:51](../../file-inventory.html#external-211481d78d1a6589)、[PRODUCT.md:74](../../file-inventory.html#external-211481d78d1a6589)
- 运行、审批、停止中或结果未知时不得假装配置已生效；停止确认、历史恢复、共享许可都有各自真实证据要求。[PRODUCT.md:79](../../file-inventory.html#external-211481d78d1a6589)、[PRODUCT.md:136](../../file-inventory.html#external-211481d78d1a6589)
- 测试钩子限测试文件；不新增环境开关，不给 Agent 私有 HOME，不建立第二套产品 UI，不创建 Dev/Test/QA 应用。沿用 [AGENTS.md](../../file-inventory.html#external-a54ff182c7e8acf5)。
- 当前活动计划和状态分别维护源码与正式安装版的证据；本研究不恢复已撤销的整组六条旅程门槛。[活动计划](../../file-inventory.html#external-dcb02de40ea4c85a)、[状态](../../file-inventory.html#external-a0cf92a1f39a72be)
- 本轮过程先只读；主线程随后明确授权现有两个 SSR 导出测试、复制产物与独立浏览器渲染。本子任务执行导出、复制与失败的浏览器创建/指定浏览器连接；随后主线程完成 22 页浏览器截图，本子任务只读目视。未启动原型、正式应用、Agent、原生探针或其他测试。
- `pnpm dev` 是正常 Vite 应用入口，不是无外部调用的模拟模式；`src/main.tsx` 挂载真实 `DraftStartup/App`。当前脚本没有 Storybook/独立组件展示任务，不能把缺少 Tauri 后端的网页当作受控产品。[package.json:7](../../file-inventory.html#external-7ae45ad102eab3b6)、[src/main.tsx:17](../../file-inventory.html#external-1cd8b18798a1a103)

## 当前已准备：22 份原样 HTML

统一标记：**当前源码生产组件受控展示，非安装版／非交互成功**。以下“覆盖”是 fixture 输入与组件渲染范围；实际可见内容以新增的 22 图逐项记录为准。**已目视并不等于功能通过**，未展开、未选择、未提交的内容不能算已见。

### AgentSetup：17 个静态样本

来源：[AgentSetup.r5-render.test.tsx](../../file-inventory.html#external-74f14fe79aed1f84)。测试在自身文件内替换 transport、hook 状态与选择数据，复用真实 `AgentSetup` 子组件；外部 I/O 和执行调用有未发生断言。CSS 通过当前 `main.tsx` 依赖图展开，品牌 SVG 由既有导出器嵌入；HTML 只执行 `dialog.showModal()`，没有 React 事件处理器。[mock 边界](../../file-inventory.html#external-74f14fe79aed1f84)、[CSS/HTML 导出](../../file-inventory.html#external-74f14fe79aed1f84)、[导出断言](../../file-inventory.html#external-74f14fe79aed1f84)

| HTML | 合成状态 / 可补查的呈现 | 明确不覆盖 |
| --- | --- | --- |
| [01-account-key](../../file-inventory.html#file-059) | 账号与指定密钥方式并列；A16 | 未登录、未输入或保存密钥，品牌方法是 fixture |
| [02-terminal-api](../../file-inventory.html#file-060) | 终端设置与模型 API 方式选择；A16/A21 | 没有真实终端输出、PTY 输入或服务请求 |
| [03-three-methods](../../file-inventory.html#file-061) | 账号、终端、API 三种方式的共用选择层；A16 | 不代表任何真实 Agent 必然提供这三种方式 |
| [04-account-summary](../../file-inventory.html#file-062) | 模拟账号检查完成摘要；A17 | 无真实身份、认证或权益核验 |
| [05-terminal-summary](../../file-inventory.html#file-063) | 模拟终端设置完成摘要；A17/A18 | 未启动终端或执行设置命令 |
| [06-service-step](../../file-inventory.html#file-064) | 第二步服务身份选择；A21 | 未保存/分发凭据，未取得实际模型 |
| [07-service-summary](../../file-inventory.html#file-065) | 已选模型服务摘要；A21/A29 | 选择数据合成，不证明兼容或请求成功 |
| [08-model-step](../../file-inventory.html#file-066) | 第三步有模型列表但未选模型；A28/A29 | 无真实选项读取或确认保存 |
| [09-model-selected](../../file-inventory.html#file-067) | 已选示例模型及固定读取结果；A28 | 未切换真实模型，也非冷恢复验证 |
| [10-program-list](../../file-inventory.html#file-068) | 程序管理中两份合成安装/候选；A08/A12 | 未发现磁盘程序，未选用、卸载或更新 |
| [11-program-connected](../../file-inventory.html#file-069) | 已连接模拟状态下的程序管理；A08/A12 | 未连接真实进程，不证明忙碌门禁 |
| [12-service-editing](../../file-inventory.html#file-070) | 更换服务时重现服务选择；A21/A24 | 只导出回调后静态结果；不是用户点击或来源迁移通过 |
| [13-single-terminal](../../file-inventory.html#file-071) | 单一终端方式仍位于接入选择层；A16 | 不代表该品牌当前真实声明，未启动 PTY |
| [14-key-detail](../../file-inventory.html#file-072) | 方法密钥的独立详情页；A20 | 未读真实 Keychain，未输入或保存秘密 |
| [15-api-old-auth](../../file-inventory.html#file-073) | 无可选服务时不串入旧账号成功；A21/A29 | fixture 没有服务，不是认证过期或请求失败的实测 |
| [16-program-ready](../../file-inventory.html#file-074) | 已准备程序与折叠检查详情；A08/A10/A12 | 依赖版本、路径、结果均合成；未执行检查命令 |
| [17-program-missing](../../file-inventory.html#file-075) | 缺少程序时的安装入口；A09/A10 | 未安装、下载、取消或验证平台行为 |

17 页不含：实时认证过程、完整内嵌终端、安装进度与取消、认证未知/迟到、活跃工作阻止、真实模型测试响应。不能把它们计为 A07–A32 全组覆盖。

### Composer：5 个静态样本

来源：[Composer.visual-render.test.tsx](../../file-inventory.html#external-0a2463ae1145ef9a)。外部 Tauri/dialog/opener 调用直接抛错，测试断言没有调用。只使用内存草稿和合成 thread。[5 个输入状态](../../file-inventory.html#external-0a2463ae1145ef9a)、[导出与固定容器](../../file-inventory.html#external-0a2463ae1145ef9a)

| HTML | 合成状态 / 可补查的呈现 | 明确不覆盖 |
| --- | --- | --- |
| [01-start-light](../../file-inventory.html#file-077) | 浅色新草稿输入区与空侧栏；N01/N02 | 控制区由既有 fixture 显式拼装，不是完整 App 布局 |
| [02-start-dark](../../file-inventory.html#file-078) | 同一新草稿的深色 CSS；N01/N02 | 不证明正式应用主题切换与保存 |
| [03-thread-light](../../file-inventory.html#file-079) | 浅色已建对话、示例草稿及一个文件附件；C01/C11 | 未读取实际附件，未发送；没有完整历史正文 |
| [04-thread-dark](../../file-inventory.html#file-080) | 同一对话输入区的深色 CSS；C01/C11 | 不代表其他页面的深色或读屏合格 |
| [05-running-light](../../file-inventory.html#file-081) | `running=true` 时的停止入口；C13 | 未运行 Agent、未点击停止，未覆盖停止中/未知/已确认 |

该导出器只加载六份 CSS，并追加自身 `.visual-shell`、固定 830px 内容容器。**保持了既有导出器原样，但这一容器本身是 fixture，不是当前正式工作台的完整几何**。它适合看组件静态呈现，不能从其布局差异直接判安装版缺陷。本轮没有扩充其样式或替换控制区。

## 难到达状态：初始只读研究与原有入口

下表记录新增导出授权之前的现有入口判断。随后批准并新增的 12 个状态页见末节；它们只补受控静态展示，不改写真实行为条件。

| 清单组 | 现有生产测试 / fixture | 在本轮边界内的判断 | 未覆盖与下一条件 |
| --- | --- | --- | --- |
| C14 工具审批 | [ApprovalInput.test.tsx:40](../../file-inventory.html#external-363de6bd476339ee)：请求输入、选项、停止等待时禁用、未知后恢复；63/86/133/160 行用例 | 有可复用当前组件数据，但仅内存 markup/回调断言，没有已导出的完整 HTML | 要实际展示，需要另行授权测试侧导出包装或真实待审批请求；不得给生产 App 注入审批 |
| C15 问题表单 | [ElicitationCard.test.tsx:6](../../file-inventory.html#external-c367aa3d77527d16)：已保存答案、结果未知只读、停止期间禁用 | 当前测试存在，未形成浏览器展示页 | 尚缺字段类型组合、输入/校验、提交/取消与真实回执 |
| C12/C13 待发与停止 | [Composer.stop.test.tsx:164](../../file-inventory.html#external-07a644474a536fea)、[Composer.work.test.tsx:142](../../file-inventory.html#external-7b3c270cd423574f) | 有排队、停止中、未知、失败取消、队列编辑取消等单测；22 页只展示 running 停止入口 | 单测不是可点击评审；真实队列需任务/草稿状态及明确保存/发送边界 |
| C09/N08 配置/启动错误 | [ConfigCheckReview.test.tsx:21](../../file-inventory.html#external-d3252b826df4c7a0)、[DraftStartup.test.tsx](../../file-inventory.html#external-f2b5a0c8d77c7e31)、[Composer.work.test.tsx:102](../../file-inventory.html#external-7b3c270cd423574f) | 当前测试可定位文案分支；无现成独立视觉入口 | 不应破坏真实存储、改权限、断网络来制造错误；需要测试侧可视导出或真实自然失败 |
| F03/F06 文件差异/意见 | [FileArtifactView.test.tsx:119](../../file-inventory.html#external-8ae1a8dd931dcefd)、[FileArtifactView.feedback.test.tsx](../../file-inventory.html#external-d2d0f95f705915a1) | 真实组件以合成 old/new 文本渲染分栏、范围；内存输出，未写 HTML | 尚缺浏览器几何、选行与意见返回原草稿；不得把协议字段样本当磁盘文件证明 |
| F04/F05/F07 文件读取/失败/另存 | [OpenedFileView.test.tsx:157](../../file-inventory.html#external-4766dc34b22330cc)、[FileDeliveryActions.test.tsx](../../file-inventory.html#external-6cbf7cddd05dd1db) | 文件 inspector/dialog 已 mock；有变更、错误、超限、未激活、晚结果等单测；无现成展示页 | 真实只读预览可用明确获准样例；另存/意见/导出各自有写入，不在“完全不改用户数据”中自动包含 |
| C18/F08 图片/HTML/媒体 | [ThreadView.cold-images.test.tsx:44](../../file-inventory.html#external-df917da9e607aba2)、[FileArtifactView.test.tsx:23](../../file-inventory.html#external-8ae1a8dd931dcefd) | 可定位未打开图片与沙箱 HTML 片段；不等于图片解码或真实 HTML 运行 | 未找到当前音频/视频/PDF/Office 全类型可视 fixture；不得假设产品有完整内置格式查看器 |
| B05/B06 网页读取确认 | 旧 [desktop-render.test.tsx:154](../../file-inventory.html#external-d287f9cf7e71512e) 有生产 ThreadView、BrowserReadRequest、待发/停止及浏览器层 | **历史可复用候选，未执行**；根 Vitest 默认不包括 docs 证据，配置/输出使用旧执行路径 | 需先核旧绝对路径、当前依赖、输出归属再单独决定；不能直接从归档目录运行，不能把旧图算本轮 |
| B02/B03/F05 真实文件与 WK 接缝 | 旧 [layout-check/README.md](../../file-inventory.html#external-0ae5b420c9ba4da3) 的 build-ui / build.sh / run_probe | **不是普通 SSR**：编译 Rust/native、启动独立内存 Tauri 窗口、读合成文件；虽不注册 .app，本轮未授权且不执行 | 需要单独核当前编译输入、测试窗口/写路径及资源；不能以旧 19/19 代替当前安装版 |
| 29 家差异配置与异常 | 当前共用测试中的代表方法、合成品牌样本 | 能证明那些输入组合的代码渲染，不是全 29 项真实声明矩阵 | 每家真实声明、认证、服务、模型和恢复仍需分别取得条件与观测 |

上表研究完成后，主线程明确批准在当前证据目录内新增测试侧导出。新增入口直接渲染现有组件、复用现有 fixture、拒绝外部 I/O 并保留输入摘要；没有另写一套产品 UI，详见末节。

## 冻结证据入口为什么不能直接复用

1. [2026-10-04 visual/README.md:39](../../file-inventory.html#external-b7cba89554052d04) 明确记录：命令属于原执行目录，归档目录不应直接执行；含旧绝对源码/缓存路径。它有 6 个导出场景，但这不是本轮新导出。旧 `visual-selected` 又属于当时选择树，不能混称当前 main。
2. [2026-10-05 layout-check/README.md:3](../../file-inventory.html#external-0ae5b420c9ba4da3) 是独立 Tauri/native 接缝探针；不仅展示 DOM，还运行真实文件和 WebKit 命令。当前“只读定位 + 两个 SSR”授权不自动涵盖重建和运行它。
3. 旧 MCP/性能/审批 JSON 夹具是协议输入或历史受控记录，不是正式 App 的现成视觉开关。把它们接入 App 往往需要配置登记、启动外部进程、发请求与写元数据；不符合本轮零登录、无付费及不改用户数据的展示条件。
4. [vitest.config.ts:9](../../file-inventory.html#external-2ee894bf23aa44ff) 将当前测试限定在 `src/`、`scripts/`，明确排除独立原型及冻结研究材料。未因“文件在仓库里”就自动运行历史脚本。

## 唯一旧原型：可演示，但本轮不启动

现有入口为 [.design/workbench/README.md](../../file-inventory.html#external-56a816c7cf593497)，其公开评审路径是 `http://127.0.0.1:8847/`；这只是文档入口，**本轮没有确认服务正在运行**。

- 顶栏始终标“交互原型 / 模拟数据”，有“载入示例”。[ReviewToolbar.jsx:6](../../file-inventory.html#external-bf90a829c898e540)
- “载入示例”会明确替换当前演示中的对话、草稿、接入进度、API、分组和发送管理；因此不能称无写入，也不能未经当前演示所有者确认就覆盖。[AppV2.jsx:1335](../../file-inventory.html#external-671beabb3c8de525)
- 它使用 `farfold-workbench-review-v6` 浏览器 localStorage，并另存反馈；不读取正式配置或凭据，但仍有演示数据需要保护。[prototype-persistence.js:7](../../file-inventory.html#external-ac9578d555c604df)、[AppV2.jsx:103](../../file-inventory.html#external-671beabb3c8de525)
- 已有示例对话的“流程边界演示”支持待确认请求、等待审批、等待回答、冷历史、空闲释放、执行中丢失连接及停止确认/未知/失败。它使用模拟状态，不调用真实 Agent。[ExecutionReviewControls.jsx:202](../../file-inventory.html#external-628566ccd304a96c)
- 代码审阅、网页、文稿对照和运行输出均有内置合成材料。[workspace-scenarios.js:120](../../file-inventory.html#external-04f94ba5afb56fb4)

该原型适合讨论旧设计的任务流，不能填入“当前生产组件已见”或“正式安装版已见”。用户当前接受源码与实见分层，不等于授权用旧原型替代当前实见。

## 必须有真实条件或另行授权的状态

| 要确认的真实结果 | 最少条件 / 为什么不能用 SSR 证明 |
| --- | --- |
| 账号登录、切号、订阅/权益、Key 有效性 | 指定 Agent、来源和账号；真实官方登录或用户输入/交接。未提供凭据、手机/硬件确认不可由助手补造；有登录方式列表不等于认证完成 |
| 模型回复、工具执行、审批与提问的真实回执 | 明确授权的真实任务和选定服务/模型；可能产生额度、进程及文件写入。审批卡要由实际请求生成，批准后作用范围需独立确认 |
| 停止中/未知/已停止、迟到消息及恢复 | 真实运行工作与取消操作；必须看到请求之后的回执和后续工作状态，不能把停止按钮、模拟 stopReason 或发送 cancel 当完成 |
| 队列持久化、暂停/继续、修改与放弃 | 明确可用的测试对话/草稿与数据写入范围；继续可能真正发送，不属于纯展示。已有用户队列不可为截图造假修改 |
| 错误恢复、保存失败、退出取消 | 自然错误或隔离受控 fixture；不得破坏真实数据库、文件权限、Keychain、网络或正式安装来制造截图 |
| 文件 diff 的真实性、磁盘读取、意见与交付 | 授权样例文件与真实事件/文件回执；只读内容预览和写意见/另存/导出分开。其他格式可能仅提供默认应用打开，不等于产品内完整查看 |
| 网页读取/动作确认与撤回 | 明确页面范围、公开/本地条件和真实工具请求。普通页面打开不能证明 Agent 收到内容；允许之后的执行/撤回须再观察 |
| Agent 移除、卸载、账号退出、对话/数据清除 | 明确对象、保留/删除范围与执行授权；只看确认框并取消不能证明最终结果，不能为覆盖删除真实数据 |
| Windows、系统通知、原生选择器/窗口与可访问性 | 对应系统环境与实际操作。macOS 静态 HTML 不能推出 Windows、VoiceOver、系统送达或原生焦点行为 |

建议后续顺序：22 份当前组件 HTML 的实际渲染与目视核验已完成；接下来决定是否复用旧网页 SSR 导出器或授权测试侧补出审批/提问/diff 状态，随后按明确对象补真实任务条件。所有截图同时记录来源层级、源码/安装身份、输入与未执行项，避免“多了一张图”变成“功能已通过”。

## 本轮 22 图独立目视复核

主线程使用 IAB 打开上述原样 HTML，于 `2026-10-08T09:10:52Z–09:10:56Z` 保存 22 张截图与对应 AX。本子任务逐张通过图像查看工具观察，未操作浏览器或正式 App。[截图清单](../../file-inventory.html#file-127) 与导出回执的 22 个 HTML 一一对应，未漏项。

**渲染条件：**截图像素均为 **625 × 769**；图像解码识别为 JPEG；初次保存曾用 `.png` 后缀，主线程随后只把后缀改为 `.jpg` 并更新清单，字节没有变化。本轮保留工具原始字节，不改图、不放大重绘。AgentSetup 原导出清单中的 `1280 × 820` 是导出器声明的参考视口，不代表这批截图实际大小。当前结论只覆盖这批窄视口首屏，未验证宽窗口、缩放、字体放大、滚动、键盘焦点顺序、读屏或对比度达标。

### 可观察结论与限制

- **未发现新的确定性重叠、文字截断或页脚按钮挤失。**17 个接入弹窗的标题、主体和底部操作区均出现在截图内；3 方法并列、缺程序和模型选择等较长样本也能完整看到底部。5 个 Composer 样本中正文、附件、配置和操作按钮可分辨。
- 静态状态表达有可确认的优点：程序“已连接”仍与总体“未完成设置”分开；服务“已选择”未写成请求成功；账号样本只写“Agent 已接受授权操作”；缺服务/缺程序分别提供“添加模型 API 服务”/“安装所需程序”入口。以上只确认文字与层次出现，不能确认按钮生效。
- **需交互确认：AgentSetup 12 更换服务。**截图中模型来源已有“示例模型服务”，底部仅返回操作，没有向前操作。该页由测试捕获回调后导出，后续 React 选择/自动推进并未运行；因此只能记录这个静态状态，不能判定真实流程卡死。后续应在真实可控数据中检验保留同一服务、改选其他服务及返回后的状态。
- **待测可读性：Composer 02/04 深色样本。**侧栏次级文字、输入提示、模型/思考配置文字在截图中较暗，正文和发送按钮较醒目。没有量测对比度，且导出器只含六份 CSS；这是一项阅读风险提示，不新增可访问性不达标或安装版缺陷结论。
- **不应误计的 fixture 现象：**示例 Agent/服务/model、空侧栏但中心有合成对话、账号摘要没有真实账号、连接/认证结果由输入直接指定，均不能转写为正式产品数据错误。Composer 固定内容容器配上这批 625px 视口形成窄列，running 样本配置换行；没有实际遮盖，也不等于正式版输入卡过窄。
- **折叠内容没有被目视覆盖。**程序安装详情、程序与版本、程序检查详情、模型“查看当前选择”、可选短消息测试、更多登录选项、管理接入均未展开；不能把 DOM 中含有或 fixture 传入了这些内容算作已见。下拉菜单同样仅见收起后的值/占位文字，未见完整选项列表。

### 逐图记录

“暂无明显布局问题”只表示该图可见首屏未见明显溢出或重叠，不表示功能、品牌接入或整个条件分支通过。

| 截图 | 目视状态与实际见到的内容 | 未覆盖 / 校准 |
| --- | --- | --- |
| [A01 账号 + 密钥](../../controlled/full-review/controlled-views/screenshots/agent-setup--01-account-key.jpg) | 暂无明显布局问题；已有设置、ChatGPT 账号、OpenAI API Key 三层可分辨，登录操作在页脚可见 | 未选其他方式、未登录；不能确认这些方式是该 Agent 当前真实声明 |
| [A02 终端 + API](../../controlled/full-review/controlled-views/screenshots/agent-setup--02-terminal-api.jpg) | 暂无明显布局问题；“模型服务 / 在终端中完成设置”与“模型 API 服务”及继续按钮可见 | 未见终端、更多登录选项或任何后续页面 |
| [A03 三种方式](../../controlled/full-review/controlled-views/screenshots/agent-setup--03-three-methods.jpg) | 暂无明显布局问题；账号、终端服务、API 三块首屏均可见，页脚未被挤出 | 组合由 fixture 指定，不能作为某家三种接入均已支持的证明 |
| [A04 账号摘要](../../controlled/full-review/controlled-views/screenshots/agent-setup--04-account-summary.jpg) | 暂无明显布局问题；当前接入与“Agent 已接受授权操作”并列，继续选择模型可见 | 未展示账号身份；fixture 未提供真实身份，不能单凭本图报身份丢失 |
| [A05 终端摘要](../../controlled/full-review/controlled-views/screenshots/agent-setup--05-terminal-summary.jpg) | 暂无明显布局问题；终端设置、设置已检查及下一步清楚分层 | 无真实 PTY、命令结果或认证完成证据 |
| [A06 服务未选](../../controlled/full-review/controlled-views/screenshots/agent-setup--06-service-step.jpg) | 暂无明显布局问题；“选择一份服务”与“前往 API 配置”入口可见 | 下拉未展开、未选服务；没有前进按钮不等于死路 |
| [A07 服务摘要](../../controlled/full-review/controlled-views/screenshots/agent-setup--07-service-summary.jpg) | 暂无明显布局问题；服务名、接口类型、服务已选择及继续模型可见 | 未读取真实模型、未验证所选服务有效 |
| [A08 模型未选](../../controlled/full-review/controlled-views/screenshots/agent-setup--08-model-step.jpg) | 暂无明显布局问题；未选模型、读取说明、可选测试折叠入口与页脚均可见 | 未打开模型下拉/当前选择/测试；不以按钮颜色判断交互门禁 |
| [A09 模型已选](../../controlled/full-review/controlled-views/screenshots/agent-setup--09-model-selected.jpg) | 暂无明显布局问题；example-fast、已读取当前模型选项、重新读取与使用此 Agent 可见 | 未提交选择或请求模型；不算切换和恢复成功 |
| [A10 程序待连接](../../controlled/full-review/controlled-views/screenshots/agent-setup--10-program-list.jpg) | 暂无明显布局问题；当前程序已准备尚未连接、连接入口及管理程序折叠项可见 | **两份候选程序/版本内容未展开，不能算版本列表目视覆盖** |
| [A11 程序已连接](../../controlled/full-review/controlled-views/screenshots/agent-setup--11-program-connected.jpg) | 暂无明显布局问题；已连接与顶部未完成设置并存，下一步账号服务可见 | 这是分阶段状态，不据此报矛盾；未见忙碌限制或连接过程 |
| [A12 更换服务](../../controlled/full-review/controlled-views/screenshots/agent-setup--12-service-editing.jpg) | 需交互确认；当前服务名已选，前往 API 配置/返回可见，首屏未出现向前操作 | SSR 不运行后续 React 回调；不能判流程必卡死，需活交互检验 |
| [A13 单一终端](../../controlled/full-review/controlled-views/screenshots/agent-setup--13-single-terminal.jpg) | 暂无明显布局问题；已有设置、模型服务及继续按钮完整可见 | 更多登录选项未展开，未验证 OpenCode 当前真实方法 |
| [A14 方法密钥](../../controlled/full-review/controlled-views/screenshots/agent-setup--14-key-detail.jpg) | 暂无明显布局问题；密钥名称、API Key、取消、安全保存说明与保存入口可见 | 空表单，无秘密；未输入、校验、保存或测试 |
| [A15 无可用服务](../../controlled/full-review/controlled-views/screenshots/agent-setup--15-api-old-auth.jpg) | 暂无明显布局问题；明确“尚无可用服务”，有添加 API 服务入口；未显示旧账号成功 | 只确认这个合成状态的空态呈现，不证明真实过期/切换恢复 |
| [A16 程序准备详情入口](../../controlled/full-review/controlled-views/screenshots/agent-setup--16-program-ready.jpg) | 暂无明显布局问题；Pi 已连接、程序检查详情入口及下一步可见 | **安装详情、版本、检查详情全部收起，依赖版本和具体检查结果未见** |
| [A17 缺所需程序](../../controlled/full-review/controlled-views/screenshots/agent-setup--17-program-missing.jpg) | 暂无明显布局问题；待准备、示例程序未安装、安装所需程序与重新检查可见 | 未执行安装、下载、取消、重试；检查详情未展开 |
| [C01 新草稿浅色](../../controlled/full-review/controlled-views/screenshots/composer--01-start-light.jpg) | 暂无明显布局问题；工作文件夹入口、空输入、配置与发送入口可分辨 | fixture 固定壳体，空侧栏；未输入、选目录或发送 |
| [C02 新草稿深色](../../controlled/full-review/controlled-views/screenshots/composer--02-start-dark.jpg) | 布局完整；次级文字/提示较暗，需后续对比度及真实主题核验 | 不是已测可访问性失败；无真实主题切换 |
| [C03 对话浅色](../../controlled/full-review/controlled-views/screenshots/composer--03-thread-light.jpg) | 暂无明显布局问题；项目计划标题、文件 chip、两行草稿与发送按钮可辨认 | 中心合成对话与空侧栏不是数据同步缺陷；未读实际附件 |
| [C04 对话深色](../../controlled/full-review/controlled-views/screenshots/composer--04-thread-dark.jpg) | 布局完整，正文/发送按钮醒目；次级配置文字较暗，待核阅读性 | 未测对比度、读屏、正式主题保存；不扩展到整个深色产品 |
| [C05 运行中浅色](../../controlled/full-review/controlled-views/screenshots/composer--05-running-light.jpg) | 暂无明显遮挡；窄视口下配置换行，“停止”“待发”和排队提示仍可见 | **仅见运行中操作入口，不含队列列表、停止等待/未知/已停止，也未点任一操作** |

可追加到覆盖账本的是 A16/A20/A21/A28 等对应的**可见子状态**、程序连接/缺失摘要，以及 N01/N02/C01/C11/C13 的静态输入/附件/运行按钮呈现；不能整组打通过。审批 C14、提问 C15、停止未知、完整待发管理、文件 diff/媒体等缺口没有因这 22 图关闭。

## 与同日上一阶段 45 张安装版图的补充关系

本节交叉核对[上一阶段总报告](../README.md)、[113 组清单](../surface-inventory.md)及[原 14 图复核](../original-14-review.md)，并重点重新目视安装图 09、10、19、21、33、39、40。**45 图属于同日上一阶段正式安装版 0.1.7 / `d7e454ac`，不是本节重新操作得到的证据**；它们可以补充“曾在该安装版实际见到”的子状态，不能替代本轮活交互或证明当前源码已经安装。

| 当前受控图缺口 | 上一阶段可补充的可见内容 | 仍不能据此关闭的范围 |
| --- | --- | --- |
| 账号管理折叠内容 | [21 管理接入](../../file-inventory.html#file-298) 已展开重新连接、更换方式、退出、切账号操作；20 为已有设置摘要 | 更多登录选项仍折叠；没有真实账号身份、认证过程或任何管理动作结果 |
| 可选模型测试折叠内容 | [19 可选测试](../../file-inventory.html#file-296) 已见“尚未执行模型测试”和创建对话/额度/不附草稿说明；18 已见模型不一致提示 | **19 内层“将发送的消息”仍折叠**，不是完整消息编辑/发送表单，更不算测试请求/响应通过 |
| 模型下拉选项 | [40 草稿模型选择](../../file-inventory.html#file-317) 已见 Codex 多项模型、6 Astra 勾选及 API 服务空态 | 属于草稿选择器，不是 AgentSetup 原生 select 的展开图；未更改、保存或发送 |
| 权限菜单 | [39 草稿权限](../../file-inventory.html#file-316) 已见 3 项权限及作用范围说明 | 这是权限配置菜单，不是实时工具审批 C14；未修改或批准 |
| 发送/队列状态 | [33 消息发送管理](../../file-inventory.html#file-310) 已见按位置暂停入口及一处完整“无法读取工作设置，请重试” | 这是位置级管理，不是 C12 待发消息列表/编辑；未暂停、继续或重试，不能填补停止未知/队列回执 |
| 审批/提问 | 原 08/09 是历史对话及权限待确认；39 只有权限菜单 | 历史正文写有 request_user_input、日志含答案，不代表当前审批卡或问题表单被展示；C14/C15 仍缺 |
| 工具结果、diff、图片/媒体 | [原 09 内容栏](../../file-inventory.html#external-1fc0595a2602c6a7) 实见工具日志/原始负载；44 只见附件菜单 | 日志和附件入口不能补真实文件读取、diff、图片解码、HTML/音视频/PDF 展示或附件恢复 |
| 网页加载/共享 | [原 10 网页栏](../../file-inventory.html#external-65606ecef24fa6f4) 实见空态和打开入口 | 没有实际网页、共享范围/读取确认、动作许可、关闭撤回状态；对话里历史“rejected”文字不是本轮验证 |
| 程序版本/依赖/认证进度 | 原 06、15–17 已见程序摘要、连接前后和账号方法列表 | 上一阶段未展开版本/检查详情，也无安装进度/取消、终端认证、认证错误；本轮 22 图没有补齐这些详情 |
| API 配置与帮助 | 24–27 已见新增空表单、通用获取指南与放弃本轮未保存表单确认；原 13 有已保存服务元数据列表 | 与受控 A14 方法密钥页是不同入口；不能补真实 Key 输入、保存、验证、模型读取或测试结果 |
| 其他导航/设置 | 22/23 自定义接入空表单，28 快捷键说明，29–32 隐私/清除范围/高级设置，34/35 搜索，36 收藏，37 导入第一步，38 分组空表单，41–45 配置/命令/附件/更多菜单 | 可列为同日上一阶段代表画面；不是自定义接入成功、清除成功、全部快捷键、导入结果、队列或文件能力通过 |
| 启动/退出/保存失败、Windows、全键盘/读屏 | 45 图没有对应实际状态；33 只有一个特定工作设置读取失败 | 不能把一个失败提示推广成全部错误路径；静态深色受控图也不能替代安装版深色/可访问性验证 |

因此，上一阶段确能减少“完全没见过入口/展开说明”的空白，但**不能关闭本轮最重要的实时状态缺口：审批、问题表单、队列内容与停止未知、认证执行、真实文件/diff/媒体、网页共享请求、生命周期错误**。图 19、21、40 等补充应保留原身份与时间，不与 22 个合成静态状态混计成真实流程完成。

## 追加授权：六类关键状态的 12 份新导出

主线程批准在 `full-review/controlled-views/` 内新增独立当前源码 SSR 测试，且不得改生产源/配置/ENV/全局数据。新增 [state-export.test.tsx](../../reproduction/full-review/controlled-views/state-export.test.tsx) 与 [独立 Vitest 配置](../../reproduction/full-review/controlled-views/state-export.config.ts)；它们不进入默认根测试 include，也不改现有测试。执行 **1 文件、1 项通过**，外部 I/O 调用为零；当前 23 份 CSS 依赖原样内联，249 个来源输入留有摘要。

[12 份 HTML 目录与逐项边界](controlled-views/states/README.md) · [场景及哈希](../../file-inventory.html#file-168) · [执行回执](../../file-inventory.html#file-167)。源码仍为 `f720d6a7`，生产源码/配置状态为空；HTML 文件哈希已核验。**主线程现已完成 12 页 IAB 截图，本子任务已逐张亲眼复核；这 12 项可记为当前生产组件受控静态目视，不能记为安装版或实际业务通过。**

- 审批：待审批、停止等待禁用，各 1 页；没有批准/拒绝或真实取消。
- 结构化提问：已有单文本必填 schema、未知回复只读，各 1 页；未新造数值/布尔/多选组合，所以仍缺其他字段类型的视觉证据。
- 队列：停止暂停后 2 条待发、编辑第一条弹窗，各 1 页；只在测试内存中构造，没有发送或持久化。
- 停止/错误：停止结果未知、工作设置读取错误，各 1 页；错误来自现有 fixture，不归因于真实环境。
- diff：真实文件卡的片段差异、分栏差异子组件，各 1 页；原数据是 `old`/`new`，不是磁盘读写。
- 媒体：结构化附件收起/展开，各 1 页；使用已有有效 2×1 PNG、文本资源及不可预览资源，没有为音视频/PDF/Office 搭假播放器。

舞台只复用现有产品容器 class，没有自定义 CSS，没有重绘组件。没有 React hydration；为显示已有状态，仅 06 调原生 `dialog.showModal()`，12 将原生附件 `details.open` 设为 true。它们是明确记录的静态准备动作，不是通过实际点击验证交互。本轮目视特别保留孤立容器位置、合成英文内容和极小样例图片的限制，未将它们解读为正式 App 缺陷。

### 新增 12 图目视结果

主线程截图时间为 `2026-10-08T09:25:50Z–09:25:51Z`。[12 图清单与 AX](../../file-inventory.html#file-169)。本子任务逐张查看截图，像素均为 **625 × 769 JPEG**；没有浏览器操作。HTML 仍与导出时哈希一致。场景 manifest 已把 `rendered`/`visuallyReviewed` 补为 true；回执保留导出时 manifest 摘要并记录补充后的摘要。

| 图 | 实际看见的子状态 | 目视结论与限制 |
| --- | --- | --- |
| [01 审批待决定](../../controlled/full-review/controlled-views/screenshots/states--01-approval-pending.jpg) | 需要批准、命令、目录、完整输入折叠、批准/拒绝及原选项名 | 文本和操作完整，无裁切；完整 JSON 未展开，未选择或执行 |
| [02 审批停止等待](../../controlled/full-review/controlled-views/screenshots/states--02-approval-stop-waiting.jpg) | 同一输入保持可读，操作外观变淡 | 与 HTML disabled 属性及 fixture 一致；只展示单卡，未见全对话停止过程或解除门禁 |
| [03 文本问题](../../controlled/full-review/controlled-views/screenshots/states--03-question-pending.jpg) | 必填 answer、已填 first answer、提交与取消 | 布局完整；只覆盖一个文本字段，没有真实输入/校验/提交 |
| [04 回复未知](../../controlled/full-review/controlled-views/screenshots/states--04-question-uncertain.jpg) | “回复结果未知”、second answer 保留、操作变淡 | 布局完整，未知状态和旧值可辨；不代表真实网络/回复结果 |
| [05 暂停待发](../../controlled/full-review/controlled-views/screenshots/states--05-queue-paused.jpg) | 两条待发、逐条编辑/移除、已暂停/继续发送、保留 draft remains | 首屏完整；空历史与两条队列是合成输入，不据此报数据异常；未继续发送 |
| [06 队列编辑](../../controlled/full-review/controlled-views/screenshots/states--06-queue-editing.jpg) | **dialog 已打开**；edited A、保存后仍暂停说明、取消编辑/加入输入框和箭头按钮 | 所有内容可见、无裁切；保存操作只显示向上箭头，见下方设计建议；未保存或放弃 |
| [07 停止未知](../../controlled/full-review/controlled-views/screenshots/states--07-stop-unknown.jpg) | 结果未知、未收到停止确认/任务可能仍执行说明、重试停止、发送已暂停 | 说明和下一步同屏完整；没有“已停止”误标；未实际取消/重试 |
| [08 工作设置错误](../../controlled/full-review/controlled-views/screenshots/states--08-work-read-error.jpg) | Unable to read policy、重试和输入区 | 无裁切；英文是既有测试提供的错误字符串，不据此判正式应用自有文案违规 |
| [09 片段统一差异](../../controlled/full-review/controlled-views/screenshots/states--09-diff-fragment.jpg) | snippet.ts、删除 old/新增 new、切换/复制入口与 Agent 报告/片段行号说明 | 内容及边界说明完整；没有实际文件读取或落盘验证 |
| [10 分栏差异](../../controlled/full-review/controlled-views/screenshots/states--10-diff-split.jpg) | 修改前/修改后两栏，old/new 各一行 | 两侧可辨，无重叠；这是独立子组件，不能要求它包含父文件卡标题或整页导航 |
| [11 附件收起](../../controlled/full-review/controlled-views/screenshots/states--11-media-collapsed.jpg) | 图片、notes.md、unsupported 三个紧凑条目 | 条目完整；仅入口，不算详情内容已见 |
| [12 附件展开](../../controlled/full-review/controlled-views/screenshots/states--12-media-expanded.jpg) | **三个 details 均已展开**；图片标题、文本原样显示、不可预览提示 | 三块内容均完整；2×1 PNG 仅呈极小点，不能据此评价正常照片/大图效果或宣称媒体播放成功 |

这 12 图没有新增明确叠字、裁切或挡住主操作的布局缺陷。唯一新增**受控静态设计建议**是图 06：保存待发沿用发送式向上箭头，仅在下方小字说明“保存后仍保持暂停，不会自动发送”；可以显式标“保存待发”，降低用户对是否会立即发送的猜测。证据区域为整图归一化 `[73.8, 51.0, 7.6, 6.3]`（箭头）及 `[16.8, 58.8, 52.0, 3.5]`（说明）。这不是误发送、按钮错误或保存失败的实测，不与安装版问题混合计数。

新增可见子状态可以补到 C12（待发与编辑）、C13（停止未知/暂停）、C14（审批卡）、C15（单文本问题）、F03（差异）、C18（结构化附件）对应的“当前组件受控目视”栏。**仍没有安装版实时请求与决定、队列持久化/发送、停止回执、各类问题字段、真实磁盘差异、正常尺寸图片、音视频/PDF/Office 的完整功能验证。**

## 交接

- 已做：契约/清单/入口只读研究；两个既有目标 SSR 导出测试；22 HTML 与导出清单逐字节复制；493 源输入摘要与相关源码无脏改记录；主线程 IAB 逐页截图及本子任务 22 图独立目视；新增独立导出测试、12 个关键状态 HTML 及根线程浏览器截图/本子任务逐图目视；本文件。
- 未做：受控页交互/折叠/选择/提交；正式 App 操作；真实 Agent/模型/登录；原型/历史 native 探针；生产源码/CSS 改造。新增 12 页已截图和目视，仍没有安装版或端到端功能通过结论。
- 子线程浏览器权限问题由主线程可用 IAB 绕开，已收到并复核截图；HTML、CSS 和截图原字节保持不变。22 + 12 个当前组件受控静态场景已完成独立目视；后续只按覆盖账本保留真实交互条件，不能把静态展示计为功能完成。
