# -*- coding: utf-8 -*-
from html import escape as E


def build(Fig):
    rows = [
        ('01 · 安装与启动', '本机优先，缺失时按需安装；固定安装引用', '发布包 0.0.33 启动本机 Pi RPC，可指定 Pi 路径；不含 Pi 本体', '官方程序原生 acp 入口，可指定二进制路径', '适配器经 App Server；可指定 CODEX_PATH，默认包另有 Codex 依赖', '管理程序来源与连接实例；不要把 npm 默认依赖误说成本机复用'),
        ('02 · 正常任务与流式结果', '三个 Runtime 已有各自发送 / 事件入口', 'ACP prompt → Pi prompt，结果经会话事件转换', '固定标签 service 将 prompt 转 SDK session.prompt；event 转流式消息', 'main 具有 ACP 任务、事件到 App Server 的映射', '均有源码路径；仍需固定组合实机验证，握手成功不等于任务成功'),
        ('03 · 运行中插话', 'Pi steer / follow_up；Codex 原生 steering', '明确差异：忙时进入适配器队列，当前 settled 后才执行；没有原生 steer / follow_up 消息路径', '本轮没有确认等价即时插话；不把再次 prompt 当作保证', 'main 示例提供 _session/steering 扩展；不是仅实现基础 prompt 即获得', '把立即干预、结束后追加、普通发送分开建模；Pi 候选不能直接等价替换'),
        ('04 · 停止', '现有三路均有原生停止入口；停止不是撤销', 'cancel 清队列、发 abort，等 agent_settled 后结束当前 prompt', '固定标签 agent.cancel 委托 service.cancel；读到的 service 返回 UnsupportedOperationError', 'main cancel 调用 interruptSessionTurn，等待原生 turn 完成事件', 'OpenCode 停止是必须解决的接入条件；进程强退不可冒充正常取消'),
        ('05 · 权限与选择', '保留原生选项及其一次 / 会话 / 策略作用范围', 'extension select / confirm 经 requestPermission 表达；并非全是工具授权', '固定标签映射 once / always / reject；按原生请求回复', '权限扩展保留原生 optionId 与作用范围，不能按显示名称推断', 'Host 关联会话、任务、请求、连接代次；前端区分选择问题与执行授权'),
        ('06 · 文本提问与扩展界面', 'Pi input / editor / 状态组件；Codex 已接受 Plan 原生提问', '发布包 input / editor 提示不支持并取消；多种扩展 UI 没有等价映射', '本轮未确认自由文本提问的完整映射，不列为已有', 'main handleUserInput 依赖客户端表单能力；不支持时返回空 answers', 'Pi 是明确保留缺口；Codex 要实现并协商表单，保护 Other、密文、取消含义'),
        ('07 · 模型与思考等级', '原生模型目录、选择及实际能力', 'get_available_models / set_model；思考等级使用固定列表，不能等同真实支持', '固定标签目录与配置选项映射模型、variant 和 mode', 'README / main 提供模型与配置选项；依赖选定版本', '统一展示，但支持范围以运行时信息和接入组合为准；不制造假选项'),
        ('08 · Provider 一次配置', '新目标：兼容 Agent 复用同一连接，不重复录入', '模型选择不负责创建或分发共享凭据', '读取原生配置不等于同步 Farfold 的统一目录', '认证 / 模型选择不等于任意订阅跨 Agent 通用', '独立配置服务逐 Agent 投影；保留真实端点与套餐，分别记录生效结果'),
        ('09 · 新会话恢复', '新架构仍须保存原生身份并冷启动恢复；旧开发会话不迁移', 'load 使用原生会话文件，回放 get_messages；历史工具展示经过合成', '固定标签有 load / resume 和消息回放路径', 'main 存在 load / 历史合并路径；旧 Codex 组合未验证', 'Host 保存原生引用与缺失范围；打不开不新建空会话冒充恢复'),
        ('10 · 多会话与隔离', '最多两条活动任务，同工作副本互斥', 'load 执行 closeAllExcept；不能假定同一连接同时保留多个活跃 Pi', '源码有按会话记录；跨项目、配置、取消隔离未实测', '源码有会话集合；跨连接 / 原生版本组合隔离未实测', '公共客户端是一套代码；可有多个连接，建议先按会话 / 配置需要隔离进程'),
        ('11 · 代码与产物', '当前已有路径变化 / 审阅基础；完整 diff 为待补设计', 'edit / write 前后快照可产生实时 diff；历史回放不重建这些快照', '工具 / 事件及编辑权限有映射；完整历史 diff 保真未验证', 'README 提供工具 / diff 路径；历史完整性需固定组合验证', 'Agent 报告 + 真实工作区差异两条来源；shell 改文件不能只靠工具卡片'),
        ('12 · 命令、内容与本机回调', '保留已接受的日常操作；可选能力如实展示', '部分 slash / compact 与图片有映射；扩展命令被过滤；无音频、无文件/终端委托，MCP 未传入 Pi', '固定标签有命令 / compact / image / MCP 路径；官方说明部分 undo / redo 不支持', 'README 提供图片 / 命令等路径；所有扩展不可默认当标准必有', '按支持组合声明能力；只实现且验证过的本机回调才对外宣告'),
    ]
    f = Fig(1400,1090,'acp-connections-and-ownership')
    f.text(40,42,'一套 ACP 实现，可以管理多个独立连接','title')
    f.text(40,74,'建议的首轮边界 · 不新增原生旁路 · 不把一个连接当成整个工作台','small')
    f.box(40,100,1320,110,'Farfold 自有工作台',['同一套聊天、权限、提问、文件与审阅界面；按实际能力显示入口'],'green')
    f.arrow(700,212,700,243)
    f.box(40,250,1320,140,'Host：任务、身份、配置与资源的统一管理',['会话绑定：项目 / 工作副本 + Agent 安装 + 原生会话 + 连接代次','任务绑定：已生效的配置版本；保留两条活动任务与工作副本互斥'],'blue')
    f.arrow(700,392,700,423)
    f.box(40,430,1320,110,'公共 ACP 客户端：共用代码与事件规则',['握手、会话、请求 / 事件、取消、权限 / 提问、扩展协商、按能力调用本机资源'],'amber')
    for x,title,lines in [
        (40,'连接实例 A · Pi 会话',['固定适配器 + 选定本机 Pi','按需启动；独立会话与配置']),
        (490,'连接实例 B · OpenCode',['选定 OpenCode 的原生 ACP','固定版本；独立会话与配置']),
        (940,'连接实例 C · Codex',['固定适配器 + 选定 Codex','适配器内部连接 App Server'])]:
        f.arrow(x+210,545,x+210,591)
        f.box(x,600,420,140,title,lines,'white')
        f.arrow(x+210,743,x+210,789)
        f.box(x,795,420,100,'外部 Agent 本体',['保持原生循环、工具和上下文'],'green')
    f.text(40,925,'连接数量由会话需要决定；三列代表接入类型，不代表允许三个任务同时执行','small')
    f.box(40,940,1320,115,'连接与进程的数量，不等于协议种类的数量',['建议先隔离运行，后续确认安全才复用进程；Pi 候选尤其不能直接共用一个活跃连接','本机已有或 Farfold 按需安装，只改变程序来源；Farfold 对外任务通信始终走 ACP'],'amber')
    connections=f.save()

    f=Fig(1400,1390,'configuration-and-recovery-flow')
    f.text(40,42,'把“配好了”和“工作结束了”分别说清楚','title')
    f.text(40,74,'建议状态流程 · Host 记录事实，不代替 Agent 决策 · 本图没有表示已完成实现','small')
    f.group(25,98,1350,585,'A · 一次保存配置，各 Agent 分别确认生效')
    for x,title,lines in [
        (50,'已保存',['公共目录与连接记录','凭据安全存储']),
        (390,'待应用',['按兼容目标生成配置','活动任务继续旧版本']),
        (730,'已应用',['目标原生配置已确认','需要时重启自有进程']),
        (1070,'验证真实请求',['成功：请求已验证','只证明该连接与模型'])]:
        f.box(x,155,280,140,title,lines,'blue')
    for x in (335,675,1015):f.arrow(x,225,x+46,225,both=False)
    f.arrow(530,299,530,355,both=False)
    f.box(50,365,620,125,'应用失败：只标记失败的那一路',['保留旧有效配置；给出重试或修正入口','其他已生效 Agent 不被回滚成未配置'],'amber')
    f.arrow(1210,299,1210,355,both=False)
    f.box(730,365,620,125,'请求失败：保留配置与失败原因',['区分认证、额度、网络和不支持的模型','不自动换账号，不把失败误说成配置丢失'],'amber')
    f.box(50,530,1300,110,'每个目标分别记录，用户看到真实状态',['Pi 已应用 / OpenCode 待应用 / Codex 不兼容，可以同时成立；保存成功不能显示为全部可用'],'green')
    f.group(25,720,1350,625,'B · 工作、等待与断线：不重复执行、不伪造完成')
    f.box(50,780,300,120,'就绪 → 发送中',['先绑定原生身份与配置','保留草稿和本次发送记录'],'blue')
    f.arrow(355,840,422,840,both=False)
    f.box(430,780,450,120,'执行中 ↔ 等待用户',['权限 / 提问绑定准确请求','取消、超时、换连接后旧按钮失效'],'blue')
    f.arrow(885,840,952,840,both=False)
    f.box(960,780,390,120,'已结束 / 已失败',['依据原生终态或可核实退出','保留真实文件变化与原因'],'green')
    f.arrow(655,903,655,946,both=False)
    f.box(430,955,450,110,'用户停止 → 取消中',['原生确认后收敛；超时则待确认'],'amber')
    f.path('M885 1010 L1155 1010 L1155 906',both=False)
    f.text(1090,994,'确认终态','small','middle')
    f.path('M200 905 L200 1150',both=False,dash=True)
    f.text(205,1106,'失联 / 接受情况未知','small')
    f.path('M650 1070 L650 1150',both=False,dash=True)
    f.box(50,1160,1300,140,'状态待确认 → 核对原生状态，再恢复显示或结束',['发送后失联不盲目重发；不把“界面没收到”当成 Agent 没执行','崩溃后不靠 Host 日志自行续跑 Agent 循环；旧请求回复失效，磁盘改动不会因取消自动撤销'],'amber')
    flow=f.save()

    sources=[
        ('Pi 发布包元数据','https://registry.npmjs.org/pi-acp/0.0.33','只读下载并校验 npm integrity；六个关键 sourcemap 文件与本轮 main 一致，相关路径同时核对发布 JavaScript。未启动运行。'),
        ('Pi 排队、交互与 diff','https://github.com/svkozak/pi-acp/blob/main/src/acp/session.ts','运行中排队、取消等待、扩展 UI 与文件快照映射。'),
        ('Pi 恢复与连接管理','https://github.com/svkozak/pi-acp/blob/main/src/acp/agent.ts','load 的 closeAllExcept、原生历史回放和配置选项。'),
        ('OpenCode 固定标签 service','https://raw.githubusercontent.com/anomalyco/opencode/v1.15.13/packages/opencode/src/acp/service.ts','本轮读到 prompt、配置、恢复、MCP 与取消拒绝实现；由同标签 agent.ts 委托。公开源码事实，不是安装二进制实测。'),
        ('OpenCode 权限映射','https://raw.githubusercontent.com/anomalyco/opencode/v1.15.13/packages/opencode/src/acp/permission.ts','原生 once / always / reject；事件来源另见同目录 event.ts。'),
        ('OpenCode ACP 官方说明','https://opencode.ai/docs/acp/','原生启动方式与部分内置命令限制。'),
        ('Codex ACP 依赖与入口','https://github.com/agentclientprotocol/codex-acp','README、package.json；读取 main，不作为冻结发布组合。当前 Farfold Codex 0.143.0，main 依赖 ^0.153.4，兼容未证明。'),
        ('Codex 原生提问映射','https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexElicitationHandler.ts','handleUserInput 需表单能力；选择、Other 和 isSecret 元数据；未支持时返回空答案。'),
        ('Codex 权限边界','https://github.com/agentclientprotocol/codex-acp/blob/main/docs/permission-extension.md','保留原生 optionId 和作用范围；协议基础能力与扩展分开。'),
        ('Codex 插话示例','https://github.com/agentclientprotocol/codex-acp/blob/main/examples/steering.ts','_session/steering 扩展示例；仍须核验冻结 SDK / 适配器 / Agent 组合。'),
        ('Codex 取消与历史','https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAcpServer.ts','cancel 委托 interruptSessionTurn；有历史合并路径。'),
    ]
    decisions=[
        ('已收紧的公共边界','一套客户端实现、多连接实例；Host 统一准入和身份归属，各连接保留原生能力及扩展。没有恢复三套 Farfold 原生客户端。'),
        ('Pi 的候选选择尚未闭合','Registry 发布包符合复用本机程序，却缺少当前原生插话与部分扩展交互。优先查现成维护版本或推动适配器补齐；若选择维护适配器扩展，单独评估成本。不能悄悄删功能或改走原生旁路。'),
        ('OpenCode 的取消必须闭合','本轮固定标签源码存在取消不支持路径。先选定并核实具有原生 ACP 取消的官方版本，再验证任务确实停止；若没有满足版本，报告接入阻塞。Farfold 不补一条 HTTP abort 旁路，也不修改 Agent 本体。'),
        ('Codex 要冻结完整组合','已有权限、表单、插话扩展线索，但它们与当前旧二进制未证明兼容。需要固定 ACP SDK、适配器与 Codex 三者；只声明实际支持的表单和扩展。'),
        ('配置归属有明确建议','Farfold 只写自己管理的连接配置；每个目标独立记录应用结果。已有原生登录可以保留独立来源，不做隐式双向同步。活动任务绑定旧配置，新配置在安全边界生效。'),
        ('首轮范围保持克制','应用内 Host；只读文件 / diff 审阅；保留两条活动任务与工作副本互斥。完整退出不承诺继续工作。旧开发会话不迁移，保留重要配置；新会话恢复是必需项。'),
    ]
    acceptance=[
        ('发送后马上断线','先显示状态待确认，查询原生状态；没有证据时不自动补发。'),
        ('等待授权时取消或切换会话','旧请求立即失效，回复不能落到另一会话；原生是否结束单独确认。'),
        ('一个 Agent 改 Provider，另一个仍在运行','运行任务保持绑定配置；修改只在对应目标安全边界应用，显示每路结果。'),
        ('外部编辑器与 Agent 同时改文件','diff 标明比较基线；不把所有磁盘改动归给 Agent，不自动覆盖外部改动。'),
        ('升级失败或用户移动本机程序','旧可用安装保留；会话仍绑定原生身份；先修复启动引用，不伪造新会话恢复。'),
        ('新会话冷启动恢复时缺少工具细节','恢复可读取内容，明确缺失范围；不把合成工具记录当作完整执行历史。'),
    ]
    def table(headers,rs):
        return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+E(x)+'</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+E(x)+'</td>' for x in r)+'</tr>' for r in rs)+'</tbody></table></div>'
    intro='本轮继续补设计，不进入开发。最重要的变化是：从“有 ACP 入口”进一步核对“能否保留已有操作”。三路都不能仅靠握手结果标成可替换；下表把明确缺口、源码路径和未验证项分开。'
    baseline='对照基础为当前工作区 src/runtime/pi.ts、opencode.ts、codex-turn.ts、codex-interaction.ts、components/ExtensionDialog.tsx 与 INTERNAL-USE.md。类型或源码存在不等于本轮重新验证安装应用；沿用已有验收边界，未扩大图片、Codex API Key 等产品声明。'
    html='<h2 id="capabilities">6C · 三路能力保留与状态流程</h2><div class="notice">'+intro+'</div><p>'+baseline+'</p>'+table(['用户操作 / 机制','Farfold 基础或目标','Pi · 发布包 0.0.33','OpenCode · 固定标签 1.15.13','Codex ACP · 本轮 main','设计结论'],rows)
    html+='<h3>为什么共用客户端仍然会有多个连接</h3><div class="diagram">'+connections+'</div><h3>配置和任务分别怎样收敛</h3><div class="diagram">'+flow+'</div>'
    html+='<h3>这次补全后，哪些边界清楚了</h3>'+table(['事项','结论 / 建议'],decisions)
    html+='<h3>六个必须能解释清楚的失败场景</h3>'+table(['场景','要求的产品行为'],acceptance)
    html+='<p><b>评估：</b>公共 Host 与统一 ACP 的职责划分可行；“现成接入包即可无损替换三路”不成立。目前主要未决项已收敛为具体适配器能力和固定版本组合，而不是继续增加架构层数。以上是源码对照和设计推演，未做吞吐 / 并发性能压测，也没有安装候选或运行真实模型。</p>'
    html+='<details><summary>本次补查的具体来源</summary><ul>'+''.join('<li><a href="'+u+'">'+E(n)+'</a>：'+E(d)+'</li>' for n,u,d in sources)+'</ul><p>网页与包核对截至 2026-09-10。除 Pi 已检查的发布内容、OpenCode 固定标签外，其余 main 为动态线索。大型源码网络读取有截断，未以截断处推断“不存在”；负向结论只依据明确取消 / 拒绝 / 过滤分支。后续需固定文件版本与安装分发对应关系。</p></details>'
    html+='<p><a href="Farfold-三路ACP能力保留与状态流程.md">单独阅读这一补充</a></p>'
    md=['# Farfold 三路 ACP 能力保留与状态流程','2026-09-10 · 设计补充 / 修订 5',intro,baseline,'## 能力对照','\n'.join(['| 操作 | 当前基础 / 目标 | Pi | OpenCode | Codex ACP | 设计结论 |','| --- | --- | --- | --- | --- | --- |']+['| '+' | '.join(r)+' |' for r in rows]),'## 一套实现与多个连接','![连接与归属](assets/acp-connections-and-ownership.svg)','## 配置与工作状态','![状态流程](assets/configuration-and-recovery-flow.svg)','## 边界与未决项']
    md+=['### '+n+'\n'+d for n,d in decisions]
    md+=['## 失败场景']+['- '+n+'：'+d for n,d in acceptance]
    md+=['## 评估','架构方向可行，但当前候选不能直接作为三路无损替换。先闭合 Pi 原生干预 / 扩展交互、OpenCode 取消和 Codex 固定版本 / 扩展组合。共享配置与恢复已有明确建议流程，仍需后续实现验证。本轮未运行模型请求、性能压测、安装、升级或数据清理。','## 来源']+['- ['+n+']('+u+')：'+d for n,u,d in sources]
    return html,'\n\n'.join(md)
