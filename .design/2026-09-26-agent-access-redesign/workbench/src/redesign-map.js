export const REDESIGN_ISSUES = [
  {
    issueId: "F01",
    title: "清除与卸载说明被挤成单字窄列",
    status: "observed",
    recommendation:
      "让危险操作说明以完整段落宽度呈现，操作按钮/预览另占一行；确认前持续显示可读的不可恢复提示与删除/保留范围。",
    target: "general",
  },
  {
    issueId: "F02",
    title: "命令菜单长描述覆盖相邻条目，无法可靠浏览选择",
    status: "observed",
    recommendation:
      "为长命令和长描述提供独立条目边界、足够行高及滚动；保留 Agent 内容，必要时摘要并提供完整查看。",
    target: "new",
  },
  {
    issueId: "F03",
    title: "导出后长期无结果说明，整组对话操作保持禁用",
    status: "observed",
    recommendation:
      "呈现导出进行中与终态，明确目标路径或失败原因；完成或失败后恢复相关入口。禁用其他菜单动作时说明具体原因。",
    target: "workspace",
  },
  {
    issueId: "F04",
    title: "文件预览未返回，重试与更换文件仍不能取得正文",
    status: "observed",
    recommendation:
      "先定位当前样本检查为何未结束；提供能明确结束或恢复预览的路径和结果反馈。保留真实未完成状态，不把加载标题或文件名当成功。",
    target: "workspace",
  },
  {
    issueId: "F05",
    title: "模型冲突要求重新确认，却未展示原选择与当前设置的差别",
    status: "observed",
    recommendation:
      "在冲突处列出需要确认的前后值，并为每个恢复动作写明采用哪一组配置。",
    target: "manage",
  },
  {
    issueId: "F06",
    title: "诊断预览以大量编号文件呈现，难以完成内容核对",
    status: "observed",
    recommendation:
      "在保留精确预览的同时，先给出面向用户的类别、时间范围、数量与敏感内容处理摘要，并支持紧凑浏览/展开。",
    target: "general",
  },
  {
    issueId: "F07",
    title: "受未发内容保护的对话在列表中没有对应状态",
    status: "observed",
    recommendation:
      "对含草稿或待发内容的条目显示相应状态，并提供进入该内容的明确入口；保留现有删除/归档保护。",
    target: "conversations",
  },
  {
    issueId: "F08",
    title: "收藏为零时缺少如何开始收藏的指引",
    status: "observed",
    recommendation:
      "为没有任何收藏的状态显示如何收藏及前往对话库的明确入口；仅在额外筛选造成无结果时使用清除筛选文案。",
    target: "conversations",
  },
  {
    issueId: "F09",
    title: "导入的长 Agent 列表没有名称查找入口",
    status: "observed",
    recommendation:
      "为导入选择提供名称查找，并可优先呈现已连接/最近使用项；继续明确每项当前准备状态。",
    target: "import",
  },
  {
    issueId: "F10",
    title: "只读原因提示重新检查，却没有对应的恢复入口",
    status: "observed",
    recommendation:
      "用统一中文解释未确认的内容，提供针对当前记录的检查/修复入口；明确能否只读加入，以及继续发送前还需完成什么。",
    target: "import",
  },
  {
    issueId: "F11",
    title: "导入头部占用过高，列表和正文只剩很矮视窗",
    status: "observed",
    recommendation:
      "完成查找后压缩步骤和 Agent 摘要，将主要高度给结果与正文；可提供扩大正文的阅读方式，并持续保留当前记录身份。",
    target: "import",
  },
  {
    issueId: "F12",
    title: "未配置更新通道后没有可理解的下一步",
    status: "observed",
    recommendation:
      "说明此版本不支持应用内检查的原因类别，并提供正式支持的获取更新方式或具体联系/查看说明入口；仅在状态可能改变时呈现刷新。",
    target: "general",
  },
  {
    issueId: "F13",
    title: "能力说明混合“声明”和“已验证”但未逐项区分",
    status: "observed",
    recommendation:
      "逐项说明可用能力的依据或未知状态，避免让一段总说明承担所有证据边界。",
    target: "manage",
  },
  {
    issueId: "F14",
    title: "能力名称与能力值缺少可扫描的配对层级",
    status: "observed",
    recommendation: "将能力名称和值形成清楚的逐项配对，并保留说明的次级层级。",
    target: "manage",
  },
  {
    issueId: "F15",
    title: "已有接入缺少可辨认的当前账号或来源摘要",
    status: "observed",
    recommendation:
      "展示可获取的账号或服务标识；无法获取时明确写出尚未提供身份信息，并说明当前沿用的来源。",
    target: "manage",
  },
  {
    issueId: "F16",
    title: "管理目录仍以探索和开始对话为主要语境",
    status: "observed",
    recommendation:
      "保持管理入口、页面高亮与主操作语义一致；让账号、模型和程序管理可直接辨认。",
    target: "manage",
  },
  {
    issueId: "F17",
    title: "已可使用的日常管理仍用连续准备步骤作为主动作",
    status: "observed",
    recommendation:
      "已可使用的管理状态用当前配置和明确管理动作组织页面，保留直接结束查看的出口。",
    target: "manage",
  },
  {
    issueId: "F18",
    title: "获取 API 指引要求额外输入，却没有给出可执行的获取路径",
    status: "observed",
    recommendation:
      "对可确认服务提供核实过的官方入口和下一步；未知服务明确说明需自备官方资料，避免先要求无收益的输入。",
    target: "api",
  },
  {
    issueId: "F19",
    title: "认证方式的关键说明未对齐中文界面",
    status: "observed",
    recommendation:
      "保留官方名称，同时用中文解释用途和前提；主操作采用完整、明确的单一动作句。",
    target: "manage",
  },
  {
    issueId: "F20",
    title: "自定义接入的整个弹窗滚动，首屏无提交区、底部无标题退出区",
    status: "observed",
    recommendation: "让表单内容滚动时保持必要的标题、退出与提交操作可见。",
    target: "manage",
  },
  {
    issueId: "F21",
    title: "自定义接入关闭时无提示丢弃已填写内容",
    status: "observed",
    recommendation:
      "有未保存修改时提供明确的保留/放弃选择，或在再次打开时恢复未提交草稿；关闭不应悄然丢弃输入。",
    target: "agents",
  },
  {
    issueId: "F22",
    title: "有目录空草稿的输入区无谓收窄，配置散成多行",
    status: "observed",
    recommendation:
      "使稳定空草稿和已有对话采用一致的输入区宽度与常用配置布局规则；内容栏打开导致的合理换行另行区分。",
    target: "new",
  },
  {
    issueId: "F23",
    title: "“编辑后重发”没有说明会追加为新消息",
    status: "observed",
    recommendation:
      "回填时明确“修改后作为新消息发送”，保留原消息关系，并提供退出本次编辑的清晰动作；不擅自改变追加语义。",
    target: "approval",
  },
  {
    issueId: "F24",
    title: "模型尚未选择时提示保留已有选择，且未解释读取按钮为何不可用",
    status: "observed",
    recommendation:
      "空选择状态明确要求先选模型；只在存在可保留选择时显示相应提示，并解释不可用动作的前提。",
    target: "manage",
  },
  {
    issueId: "F25",
    title: "权限菜单的键盘焦点与当前已选值缺少区分",
    status: "observed",
    recommendation:
      "在菜单内明确标出当前生效项，并让焦点和选中状态同时可辨；切换后的真实生效另行验证。",
    target: "approval",
  },
  {
    issueId: "F26",
    title: "起步说明与首次发送的文件夹前置条件冲突",
    status: "observed",
    recommendation:
      "在首次输入前明确发送所需条件与文件夹用途，使起步说明、发送动作和取消后提示一致；本项不要求增加无目录发送能力。",
    target: "new",
  },
  {
    issueId: "F27",
    title: "加载更多被压成细长按钮",
    status: "observed",
    recommendation:
      "让加载更多具有与其他次级按钮一致的高度、文字间距和命中区域，并靠近它所分页的列表。",
    target: "import",
  },
  {
    issueId: "F28",
    title: "逐条待发卡使用累计数量，容易与总数混淆",
    status: "observed",
    recommendation:
      "在队列头显示总数，在单卡用“第 1 条/第 2 条”或序号表示顺序。",
    target: "approval",
  },
  {
    issueId: "F29",
    title: "新增 API 的放弃提示提到不存在于本次流程的上次保存",
    status: "observed",
    recommendation:
      "新增和编辑的放弃提示分别说明实际保留对象，明确新配置尚未创建。",
    target: "api",
  },
  {
    issueId: "F30",
    title: "同一新建工作流交替使用“新对话”和“新会话”",
    status: "observed",
    recommendation:
      "统一 Farfold 自有的新建入口、标题与状态文案为同一用户术语。",
    target: "new",
  },
  {
    issueId: "F31",
    title: "查找只框整条消息，缺少逐处定位提示",
    status: "observed",
    recommendation:
      "突出匹配词本身，并提供可理解的当前结果位置及逐处跳转方式；验证长消息和跨屏结果。",
    target: "approval",
  },
  {
    issueId: "F32",
    title: "停止等待中的审批卡仍只显示需要批准",
    status: "risk",
    recommendation:
      "在卡片内同步等待原因与下一步，更新“需要批准”状态；保留未知结果与已停止的区别。",
    target: "approval",
  },
  {
    issueId: "F33",
    title: "附件折叠项的 AX 快照未呈现展开状态",
    status: "risk",
    recommendation:
      "验证折叠项可聚焦、可键盘操作，且辅助技术能够获取名称、角色与展开状态；有缺口时补足相应语义。",
    target: "new",
  },
  {
    issueId: "F34",
    title: "移动分组弹窗没有显示当前归属与具体对象",
    status: "risk",
    recommendation:
      "标题明确使用“移到分组”，显示所选对话摘要/当前归属，并说明选择目标的生效方式；多个对象时显示数量及可查看清单。",
    target: "conversations",
  },
  {
    issueId: "F35",
    title: "回应未知的提问卡未说明下一步",
    status: "risk",
    recommendation:
      "在卡片内交代未知意味着什么、答案已保留及可用下一步；需要外部检查时给出明确入口或指向。",
    target: "approval",
  },
  {
    issueId: "F36",
    title: "暂停待发时仍提示 Enter 发送",
    status: "risk",
    recommendation:
      "按当前状态把键盘提示改成“Enter 加入待发”等准确动作，并与按钮、恢复发送说明一致。",
    target: "approval",
  },
  {
    issueId: "F37",
    title: "编辑待发的保存动作沿用发送上箭头",
    status: "risk",
    recommendation:
      "主动作直接标“保存”，或使用明确保存图标并可见动作文字；保留暂停说明。",
    target: "approval",
  },
  {
    issueId: "F38",
    title: "全局搜索结果缺少时间和工作位置",
    status: "risk",
    recommendation:
      "在结果中显示精简工作位置与最近活动时间，必要时标注归档状态及命中字段，保留完整标题的查看方式。",
    target: "conversations",
  },
  {
    issueId: "F39",
    title: "程序页的可访问性快照同时把多个分类标为已选择",
    status: "risk",
    recommendation:
      "对照实际读屏和键盘焦点检查分类选中状态，确保当前内容只对应一个活动分类。",
    target: "manage",
  },
  {
    issueId: "F40",
    title: "附加配置只有名称与值，缺少效果和生效范围说明",
    status: "risk",
    recommendation:
      "在官方语义可验证的前提下提供简短解释与生效范围，保留原始名称；未知能力明确未知，不猜测性能或费用影响。",
    target: "new",
  },
  {
    issueId: "F41",
    title: "首发后的对话不再呈现此前的附加配置入口",
    status: "risk",
    recommendation:
      "核对会话准备前后真实可用配置；若仍可用，保留一致入口，若不可调整则说明当前值与限制，避免无解释地消失。",
    target: "approval",
  },
  {
    issueId: "F42",
    title: "密钥表单并列多个退出层级，取消的作用范围不清楚",
    status: "risk",
    recommendation:
      "用目的地或结果命名退出动作；有未保存输入时说明保留或放弃的结果。",
    target: "manage",
  },
  {
    issueId: "F43",
    title: "模型确认页未直接呈现当前服务来源",
    status: "risk",
    recommendation:
      "在模型选择和最终确认区域直接显示当前服务摘要，详细信息仍可折叠。",
    target: "new",
  },
  {
    issueId: "F44",
    title: "模型选择页不能直接核对“已有设置”的具体来源",
    status: "risk",
    recommendation:
      "优先显示 Agent 实际提供且适合展示的来源信息；若未提供则明确无法确认，并给出核对入口，不能编造账号身份。",
    target: "new",
  },
  {
    issueId: "F45",
    title: "重新下载与更新合在同一按钮，当前页面未说明目标版本",
    status: "risk",
    recommendation: "在执行前明确此次动作和目标版本，并保留取消出口。",
    target: "manage",
  },
  {
    issueId: "F46",
    title: "注册提示只有“官方渠道”，没有可执行入口",
    status: "risk",
    recommendation:
      "有可信官方链接时直接提供；无链接时明确缺少入口，并给出需要向谁获取何种账号的说明。",
    target: "manage",
  },
  {
    issueId: "F47",
    title: "历史恢复的权限提示缺少就地操作引导",
    status: "risk",
    recommendation:
      "在横幅中指向具体确认动作，并区分对话操作权限、网页读取许可和 Agent 等待回应；用真实恢复动作验证。",
    target: "approval",
  },
  {
    issueId: "F48",
    title: "模型服务与模型 API 服务的选项名称难以区分设置方式",
    status: "risk",
    recommendation:
      "用用户要进行的设置方式区分选项，例如在 Agent 中设置与选择已保存的 API 服务。",
    target: "manage",
  },
  {
    issueId: "F49",
    title: "“当前网页”输入标签没有呈现读取许可状态",
    status: "risk",
    recommendation:
      "让输入标签能简要说明网页身份与可读取状态，并能回到许可入口；保持隐藏、关闭和换页的权限边界清晰。",
    target: "new",
  },
  {
    issueId: "F50",
    title: "提醒开关看起来像静态的已关闭标签",
    status: "risk",
    recommendation:
      "采用容易识别的开关形态，或以清晰动作文字配合当前状态；确保关闭状态仍能看出可操作。",
    target: "general",
  },
];
export const REDESIGN_FAMILIES = [
  {
    id: "V01",
    title: "新建草稿",
    target: "new",
    path: "写草稿 → 选择 Agent → 选工作文件夹 → 发送",
  },
  {
    id: "V02",
    title: "对话",
    target: "approval",
    path: "打开示例对话 → 对话场景 → 审批 / 停止 / 恢复",
  },
  {
    id: "V03",
    title: "对话库",
    target: "conversations",
    path: "所有对话 → 筛选、收藏、归档和管理",
  },
  {
    id: "V04",
    title: "Agent 中心",
    target: "agents",
    path: "探索 Agent → 搜索、详情、添加",
  },
  {
    id: "V05",
    title: "通用设置",
    target: "general",
    path: "设置 → 通用 → 外观、提醒与数据",
  },
  {
    id: "V06",
    title: "中央 API",
    target: "api",
    path: "设置 → API 配置 → 新增 / 编辑服务",
  },
  {
    id: "V07",
    title: "LifeModel",
    target: "life",
    path: "设置 → LifeModel，保留未启用说明",
  },
  {
    id: "V08",
    title: "Agent 详情",
    target: "manage",
    path: "管理 Agent → 详情与能力依据",
  },
  {
    id: "V09",
    title: "自定义接入",
    target: "agents",
    path: "探索 Agent → 自定义接入 → 未保存退出保护",
  },
  {
    id: "V10",
    title: "Agent 设置外壳",
    target: "manage",
    path: "管理 Agent → 程序 / 账号与服务 / 模型",
  },
  {
    id: "V11",
    title: "设置执行/管理子界面",
    target: "manage",
    path: "Agent 设置 → 程序更新、登录或移除确认",
  },
  {
    id: "V12",
    title: "草稿 Agent/模型浮层",
    target: "new",
    path: "新对话 → Agent / 模型与来源选择",
  },
  {
    id: "V13",
    title: "配置/权限浮层",
    target: "approval",
    path: "示例对话 → 输入区权限 / 配置确认",
  },
  {
    id: "V14",
    title: "输入/附件/待发",
    target: "approval",
    path: "示例对话 → 附件、草稿和待发编辑",
  },
  {
    id: "V15",
    title: "请求/内容卡片",
    target: "approval",
    path: "示例对话 → 请求确认、问题回答和未知结果",
  },
  {
    id: "V16",
    title: "全局/对话查找",
    target: "search",
    path: "全局搜索；对话标题栏查找当前记录",
  },
  {
    id: "V17",
    title: "管理菜单/确认",
    target: "conversations",
    path: "对话库行菜单 → 重命名、移动、归档或删除",
  },
  {
    id: "V18",
    title: "带入已有对话",
    target: "import",
    path: "所有对话 → 带入已有对话 → 筛选与正文预览",
  },
  {
    id: "V19",
    title: "文件与输出栏",
    target: "workspace",
    path: "打开文件示例 → 内容栏 → 失败重试 / 版本反馈",
  },
  {
    id: "V20",
    title: "网页栏",
    target: "workspace",
    path: "草稿选 Agent 和文件夹 → 打开网页；或文件示例 → 网页",
  },
  {
    id: "V21",
    title: "设置说明/管理浮层",
    target: "general",
    path: "通用设置 → 数据范围、发送管理与说明",
  },
  {
    id: "V22",
    title: "更新/诊断",
    target: "general",
    path: "通用设置 → 更新 / 诊断预览",
  },
  {
    id: "V23",
    title: "应用级保存/退出",
    target: "exit",
    path: "体验保存、保留草稿与退出失败说明",
  },
  {
    id: "V24",
    title: "系统/外部",
    target: "external",
    path: "外部登录、系统选择器与真实窗口的交接边界",
  },
];
