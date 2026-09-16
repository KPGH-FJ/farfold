# -*- coding: utf-8 -*-
from pathlib import Path
from html import escape as E

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)

class Fig:
    def __init__(self,w,h,name):
        self.name=name
        self.p=[f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="{E(name)}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1L8 5L1 9" fill="none" stroke="#647984" stroke-width="1.6"/></marker></defs><style>text{{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#213d46}}.title{{font-size:25px;font-weight:650}}.head{{font-size:21px;font-weight:650}}.body{{font-size:17px}}.small{{font-size:15px;fill:#5a727b}}</style><rect width="{w}" height="{h}" fill="#f6f9fa"/>''']
    def text(self,x,y,t,c='body',anchor='start'):
        self.p.append(f'<text x="{x}" y="{y}" class="{c}" text-anchor="{anchor}">{E(t)}</text>')
    def box(self,x,y,w,h,title,lines=(),color='blue'):
        fill,stroke={'blue':('#eaf0fc','#9daed3'),'green':('#eaf4ee','#90b69f'),'amber':('#fff1db','#d4b17a'),'white':('#fff','#b7c8ce')}[color]
        self.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="13" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        self.text(x+w/2,y+31,title,'head','middle')
        for i,l in enumerate(lines):self.text(x+w/2,y+61+26*i,l,'body','middle')
    def group(self,x,y,w,h,title):
        self.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="17" fill="none" stroke="#91aab6" stroke-dasharray="7 5"/>')
        self.text(x+18,y+29,title,'head')
    def path(self,d,both=True,dash=False):
        self.p.append(f'<path d="{d}" fill="none" stroke="#647984" stroke-width="2" marker-end="url(#arrow)"'+(' marker-start="url(#arrow)"' if both else '')+(' stroke-dasharray="6 5"' if dash else '')+'/>')
    def arrow(self,x,y,x2,y2,**kw):self.path(f'M{x} {y}L{x2} {y2}',**kw)
    def save(self):
        svg=''.join(self.p)+'</svg>'
        (ASSETS/(self.name+'.svg')).write_text(svg,encoding='utf-8')
        return svg

f=Fig(1400,1300,'host-complete')
f.text(40,39,'共同的完整职责：不修改 Agent，也需要完整的 Farfold Host','title')
f.text(40,70,'候选逻辑架构 · 方框表示职责，不要求分别部署 · 所有方案均保留 Agent 自己的循环与原生会话','small')
f.box(40,96,1320,115,'Farfold 自有工作台',['聊天与干预　｜　文件 / 差异 / 终端 / 产物　｜　项目 / 会话 / 安装 / 设置','共同组件 + 按能力启用的专属交互；所有操作经 Farfold 内部接口'],'green')
f.arrow(470,219,470,253);f.arrow(1155,219,1155,253)
f.group(40,260,860,418,'Host · 管理、状态与可靠性')
cards=[(60,312,'Agent 与安装管理',['发现 / 安装 / 版本 / 依赖','启动定义 / 适配器 / 配置规则']),
       (490,312,'项目与会话管理',['工作副本 / 身份绑定 / 历史引用','新建 / 返回 / 草稿 / 删除边界']),
       (60,432,'工作与交互控制',['任务准入 / 取消 / 待答交互','状态确认 / 进程退出 / 恢复']),
       (490,432,'统一模型服务管理',['目录 / 连接 / 模型映射 / 兼容','凭据归属 / 配置分发 / 生效状态']),
       (60,552,'事件与诊断服务',['快照 + 增量 / 顺序与缺口','错误定位 / 输出边界 / 通知']),
       (490,552,'Farfold 自有数据',['项目 / 布局 / 绑定 / 审阅记录','事务 / 迁移 / 备份与恢复'])]
for x,y,t,l in cards:f.box(x,y,390,104,t,l,'blue')
f.box(950,260,410,247,'Host · 工作环境服务',['文件读取 / 预览 / 变化观察','Git 状态 / 基线 / 实际差异','终端创建 / 输出 / 释放','资源与路径边界 / 产物定位','服务工作台，也承接 ACP 回调'],'blue')
f.arrow(1155,514,1155,569)
f.box(950,578,410,116,'实际工作目录与文件',['用户、Agent、外部工具均可能修改','保留来源，不自动归因于某次任务'],'white')
f.arrow(470,685,470,728)
f.box(40,738,860,153,'公共 ACP 客户端',['协议版本 / 认证 / 会话 / 消息 / 工具与变更事件','权限与提问 / 配置与能力 / 取消 / 扩展','Agent 请求文件或终端时，调用 Host 对应服务'],'amber')
# Route optional resource callbacks outside the management boxes.
f.path('M905 810H923V472H944',dash=True)
f.text(945,730,'虚线：按能力提供的文件 / 终端回调','small')
f.text(945,763,'Provider 配置由 Host 按原生方式应用；','small')
f.text(945,790,'不要求通过 ACP 传递模型密钥。','small')
for c in [182,470,758]:f.arrow(c,898,c,942)
for x,t,ls in [(40,'Pi ACP 适配器',['候选：已有本机 Pi 接入路径']), (328,'OpenCode ACP 入口',['原生支持，无需额外转换层']), (616,'Codex ACP 适配器',['候选：固定接入包后验证'])]:f.box(x,952,284,88,t,ls,'amber')
for c in [182,470,758]:f.arrow(c,1047,c,1080)
f.box(40,1090,860,105,'外部 Agent 本体：Pi / OpenCode / Codex',['自己的推理循环、工具决策、原生会话、权限与上下文管理','程序来自本机安装或按需安装；不修改 Agent 本体'],'white')
f.path('M905 1128H930V634H944',both=False)
f.text(970,928,'Agent 通过原生工具读写工作目录','small')
f.box(950,1060,410,135,'外部模型服务 / Provider',['实际模型调用由 Agent 完成','ACP 客户端不替代 Agent 调模型','各 Agent 原生登录仍可独立存在'],'white')
f.arrow(907,1163,942,1163)
f.text(40,1244,'两条信息来源并存：Agent 通过 ACP 报告过程；Host 直接观察文件与 Git 的实际状态。','body')
f.text(40,1276,'开发旧会话不迁移；保留重要配置，新建会话仍须可靠恢复。本图为候选设计。','small')
complete=f.save()

f=Fig(1400,610,'change-information-flow')
f.text(40,40,'用代码变更说明：信息从哪里来，谁负责展示','title')
f.text(40,72,'不需要修改 Agent；工作台把两类信息并列呈现，不把它们混成一个事实。','small')
f.box(40,127,310,113,'Agent 报告的操作',['工具状态 / 文件位置 / diff','是操作报告，可能不完整'],'amber')
f.arrow(360,183,480,183,both=False)
f.box(490,127,350,113,'ACP 客户端与事件投影',['按协议接收、关联会话与工具','保留来源、状态和扩展'],'blue')
f.arrow(850,183,970,183,both=False)
f.box(980,127,380,113,'前端：过程与工具卡片',['显示某次操作的差异与进度','权限选择经 ACP 回传 Agent'],'green')
f.box(40,330,310,113,'工作目录实际状态',['磁盘文件 / Git / 已有修改','也可能有用户或外部工具修改'],'white')
f.arrow(360,386,480,386,both=False)
f.box(490,330,350,113,'Host 文件与差异服务',['读取状态、基线和实际差异','处理未跟踪文件与冲突'],'blue')
f.arrow(850,386,970,386,both=False)
f.box(980,330,380,113,'前端：文件与审阅面板',['变更列表 / 逐行对照 / 文件定位','显示比较基线和审阅状态'],'green')
f.text(40,507,'权限批准 ≠ 文件审阅；标记已审阅 ≠ 应用修改；撤销修改需要另行定义冲突与恢复规则。','body')
f.text(40,546,'同样的方法可用于文档、图片和其他产物：Agent 报告 + Host 定位实际产物 + 合适的前端预览。','body')
f.text(40,581,'文件 / 终端回调是可选协作方式；Agent 自己执行工具时，Host 的观察不能宣称完整沙箱或执行控制。','small')
change=f.save()

f=Fig(1500,690,'host-three-options')
f.text(35,39,'三套可选形态：公共职责相同，Host 运行在哪里不同','title')
f.text(35,70,'三者都可以统一 ACP，不修改 Agent。它们是产品运行方式的选择，不是三套通信协议。','small')
for x,title,sub in [(35,'A · 应用内 Host','当前优先建议'),(535,'B · 独立本地 Host','需要后台持续工作时考虑'),(1035,'C · 服务端 Host','需要远程设备时才考虑')]:
    f.text(x,120,title,'head');f.text(x,151,sub,'small')
if True:
    f.group(35,176,430,309,'同一个桌面应用')
    f.box(55,220,390,80,'Farfold 前端',['自己的完整工作界面'],'green')
    f.arrow(250,308,250,334)
    f.box(55,345,390,116,'完整 Host + ACP 客户端',['Tauri 后端内组织公共服务','沿用本机项目、数据与配置'],'blue')
    f.arrow(250,493,250,518)
    f.box(55,530,390,69,'本机 Agent / ACP 适配器',[],'white')
    f.text(250,636,'维护最直接；退出应用结束自有进程','small','middle')
    f.text(250,663,'关闭窗口与退出应用须分别定义','small','middle')
    f.box(555,220,390,80,'Farfold 前端进程',['界面可独立退出和重新连接'],'green')
    f.arrow(750,308,750,365)
    f.box(555,375,390,110,'本地 Host 守护进程 + ACP',['独立持有会话、进程与数据','本地受控连接，不必开放网络'],'blue')
    f.arrow(750,493,750,518)
    f.box(555,530,390,69,'本机 Agent / ACP 适配器',[],'white')
    f.text(750,636,'界面退出后仍可工作；增加进程维护','small','middle')
    f.text(750,663,'需要重连、鉴权、升级和版本匹配','small','middle')
    f.box(1055,220,390,80,'桌面 / 浏览器客户端',['用户查看与操作远程工作'],'green')
    f.arrow(1250,308,1250,365)
    f.box(1055,375,390,110,'远程 Host 服务 + ACP',['项目、Agent、凭据在服务端','客户端通过认证的网络连接'],'blue')
    f.arrow(1250,493,1250,518)
    f.box(1055,530,390,69,'服务端 Agent / ACP 适配器',[],'white')
    f.text(1250,636,'支持多端访问；增加网络与远程运维','small','middle')
    f.text(1250,663,'本轮仅比较，不纳入当前开发范围','small','middle')
options=f.save()

# Each entry: user-facing capability, ownership/data, current evidence, design work/failure boundary.
groups=[('开始工作',[
('选择 Agent 与安装','Host 安装目录 + 每个 Agent 的接入定义','部分已有：Codex 本机安装校验；Pi/OpenCode 随包','补两种来源的共同管理。缺程序、缺依赖、多版本和不兼容须能解释；不静默升级用户环境。'),
('项目与工作环境','Host 项目 / 工作副本服务；实际文件系统与 Git','已有：working_copy_manager、工作副本绑定和隔离 worktree','保留。明确非 Git 目录、已有修改、文件路径与环境；同一工作副本的写入准入继续统一。'),
('账号与模型可用性','Host 配置服务 + Agent 原生认证 / Provider 接口','部分已有：三路原生配置与认证路径','补统一入口及兼容 Provider 映射。安装成功、认证成功和模型可用分别展示；不假设账号天然互通。'),
('会话与原生身份','Host 保存安装/连接/工作副本/原生 Session 对应关系','已有：records、session_binding_index、session_controller','保留身份绑定机制并适配 ACP。用户明确开发旧会话不迁移；新架构创建的会话仍须准确绑定与恢复，切换 Agent 不移植原生状态。'),
('能力与启动设置','ACP 协商 + Agent 接入定义 + 前端能力入口','部分已有：capability_authority 与各 Runtime 原生目录','将协议支持、适配器支持、Agent 版本和模型支持联合判断；不能用单一“支持”开关。'),
]),('工作与干预',[
('连接与子进程','Host 生命周期服务 + 公共 ACP 传输','已有生命周期；ACP 通信需要新增','发现不等于启动；接入本机安装不等于接管已有终端。退出、自有子进程和中断后的恢复须有明确归属。'),
('消息、附件与输出','公共工作台 → Host 准入 → ACP；事件反向返回','部分已有：Composer、草稿、原生消息与文件引用','保留并接入共同内容模型。区分路径引用、实际文件内容和图片能力；过大或不支持时保留草稿并提示。'),
('任务状态与取消','Host 操作控制 + ACP 命令和响应','已有：turn_coordinator、原生 Stop 与干预路径','保留准入与互斥。发送成功不等于 Agent 接受；取消待确认、退出和完成分别处理，不盲目重放任务。'),
('权限、提问与登录交互','Agent 发起；Host 关联待答请求；前端呈现；ACP 回传','已有：interaction_registry、原生交互组件','调整为共同生命周期与按能力呈现。会话切换、取消、超时后旧交互失效，不能重复批准。'),
('工具与计划展示','ACP 工具/计划/位置事件 → 公共显示组件','部分已有：各路工具与状态呈现','补一致的公共工具显示模型。原生用词与特殊操作保留；未上报的计划、进度或思考不能自行编造。'),
('文件与终端回调','ACP 请求 → Host 资源服务；是否使用由能力协商决定','需扩展：已有文件引用/定位，不是完整 ACP 文件/终端服务','明确何时读磁盘或编辑缓冲、路径范围、输出上限、进程清理。Native 工具仍可能绕过回调自行执行。'),
('事件可靠传递','Host 快照 + 有界事件通道 + 前端投影','已有：runtime_event_router、ui_transport、live_session_projection','保留序号、代次、缺口和来源。改为 ACP 后替换原生解析部分，不能把恢复快照当作所有遗漏消息均已重放。'),
]),('查看与审阅产物',[
('Agent 报告的改动','ACP diff / 文件位置 / 工具结果','部分已有：原生事件中有文件变更信息','补通用事件到差异卡片的映射。支持收到的完整 diff，也允许只有文件路径；不能保证所有工具均上报。'),
('工作区实际变化','Host Git 状态 / 基线 / 文件观察','已有：turn_changes、working_copy_manager','扩展逐行差异与刷新策略。区分已有修改、当前观察、未跟踪文件、重命名和冲突；不能全归因当前 Agent。'),
('文件与差异界面','前端共享文件预览、diff、定位与审阅组件','部分已有：TurnChangesSection 路径列表与审阅标记，项目文件定位','通用文件预览和逐行 diff 审阅须补产品设计。当前路径审阅不等于完整 diff 编辑器。'),
('终端与其他产物','前端显示终端输出；Host 定位文件；ACP 提供引用','部分已有：原生工具输出、结果文件链接','交互终端、图片/文档预览按本轮产品范围选择，不把所有编辑器能力都设为必做；失败保留原始结果入口。'),
('接受、拒绝与撤销','取决于修改是否落盘、原生接口及 Host 可恢复基线','待定：已有“已审阅”，不是应用/撤销修改','先区分授权、审阅、应用和恢复。撤销要考虑用户后续编辑；没有恢复依据就不能承诺一键回滚。'),
]),('离开、回来与维护',[
('历史、草稿与重启恢复','Host 本地记录 + Agent 原生历史接口','已有：草稿、会话打开、reconciler、原生续接','本次切换不迁移开发旧历史；新架构产生的会话须支持重启续接。运行中断、缺失程序或身份改变不能默默新建空会话。'),
('持久化、迁移和删除','Host 数据库；原生历史保持原生权威','已有：SQLite、导出导入、session_deletion、配对恢复','保留。清楚区分删除入口、Host 记录、原生数据、安装文件；公共显示缓存不能成为第二份原生历史权威。'),
('错误与可观测性','Host 诊断，ACP 协议错误，Agent 原生错误','已有：performance_trace、事件缺口、恢复界面等基础','补统一错误归属：安装/启动/认证/协议/任务/文件。日志脱敏且有界；错误需带用户可执行的恢复入口。'),
('通知与多会话体验','Host 会话注意状态；前端侧栏 / 系统通知','已有：session_attention 和共享导航；系统通知范围须单独确认','统一等待用户、完成与失败的显示。后台任务与窗口关闭语义取决于所选 Host 形态。'),
('配置、扩展与版本维护','Host 安装与配置服务 + Agent 原生能力','部分已有：Runtime 原生 Skills/Extensions/MCP 与版本固定策略','统一的是入口、引用和兼容判断，不把不同 Agent 的 Skills 或权限语义强行互换；更新和主应用发布分开。'),
('桌面应用壳与交付','Farfold 应用生命周期、设置与更新服务','已有：lib.rs、managed_update、update_recovery 等','保留单实例、窗口和退出规则、设置持久化与配对恢复。Agent 安装更新与主应用更新分开，未配置的更新服务不能显示为可用。'),
('界面状态与可用性','共享工作台与前端状态投影','部分已有：共享导航、输入、焦点与性能记录','明确切换会话后草稿和滚动位置、长输出性能、键盘与无障碍、空状态与错误恢复；协议兼容不能代替可用的界面。'),
])]

peers=[
('Zed','ACP 客户端接到既有编辑器服务','已读 acp.rs 的文件/终端/权限处理注册，以及 acp_thread.rs 的 diff 与事件投影。','借用文件、终端、工具卡片与差异呈现的分工；外部 Agent 的历史、checkpoint 等能力仍因集成而异。','https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs#L710'),
('Codeg','公共 Rust 核心 + 自有工作台 + ACP','官方架构明确 Host 管数据库、Git、凭据、文件与终端；源码仍有 Agent 专属配置和交互分支。','最接近 Farfold 的职责参考；桌面和独立服务复用核心，但这不要求 Farfold 同时做两种部署。','https://docs.codeg.app/reference/architecture'),
('Kandev','公共 ACP 传输 + 独立 Agent 接入定义 + 执行环境','源码 factory 限定结构化协议为 ACP；Agent 定义含发现、启动、环境、权限设置、恢复与认证。','可借鉴“共同传输”和“每个 Agent 的启动/配置差异”分离；其任务编排和远程能力不是本轮需求。','https://github.com/kdlbs/kandev/blob/main/docs/public/add-agent-cli.md'),
('JetBrains AI Assistant','外部 ACP Agent 接入已有 IDE','官方文档确认本机发现、Registry 安装/更新、自定义启动和原生认证复用路径。','借鉴安装与接入体验；不能据此认定任意外部 Agent 都获得 IDE 所有内建 AI 功能。','https://www.jetbrains.com/help/ai-assistant/acp.html'),
('Verde','独立会话守护进程 + 工作台；混合接口','项目 README 描述由会话 daemon 持有任务和终端，GUI 等作为连接它的客户端。','可作独立 Host 运行形态参考。此项依据项目说明，未安装验证后台存活与升级行为；协议选择也与候选不同。','https://github.com/JonathanRiche/verde'),
]

def source_link(path,label=None):
    return f'<a href="https://github.com/{path}">{E(label or path)}</a>'

peer_table='<table><thead><tr><th>同行</th><th>实际边界</th><th>查到的依据</th><th>借鉴与限度</th></tr></thead><tbody>'+''.join(f'<tr><td><a href="{u}">{E(n)}</a></td><td>{E(a)}</td><td>{E(b)}</td><td>{E(c)}</td></tr>' for n,a,b,c,u in peers)+'</tbody></table>'
inventory=''
for title,rows in groups:
    inventory+=f'<details class="inventory" open><summary>{E(title)} · {len(rows)} 项</summary><div class="scroll"><table><thead><tr><th>用户需要</th><th>责任与数据来源</th><th>当前源码基础</th><th>还需设计 / 异常边界</th></tr></thead><tbody>'
    inventory+=''.join('<tr class="mechanism">'+''.join(f'<td>{E(v)}</td>' for v in r)+'</tr>' for r in rows)
    inventory+='</tbody></table></div></details>'

intro='''<p class="lead">Farfold 的目标是<strong>不修改 Agent 本体，做好统一工作台和完整的 Host 服务</strong>。公共 ACP 客户端可以降低多种协议的维护成本，但完整产品还需要文件、差异、终端、安装、配置、状态与恢复机制。</p><div class="notice">这份报告把“如何连 Agent”和“如何让用户顺畅工作”放在一起设计。候选方案尚未定案；本轮只研究与制作图文，没有改动应用实现。</div>'''
problem='''<div class="cards"><article><b>问题一：边界到底是什么？</b><p>Agent 决定任务怎么做，并保有原生会话与行为。Farfold 管工作环境、界面、资源服务和运行可靠性。已有 Agent 不改源码，不代表 Farfold 只需写前端。</p></article><article><b>问题二：哪些信息从哪里来？</b><p>Agent 报告过程；Host 观察文件和 Git；用户做审阅和选择。三者要保留各自来源，才能避免把“说改了”当成“实际文件状态”。</p></article><article><b>问题三：哪些公共，哪些专属？</b><p>公共能力按职责组织，专属差异收在 Agent 接入定义和 UI 扩展里。不是为每个 Agent 重写工作台，也不要求把差异全部抹平。</p></article><article><b>问题四：怎样检查有没有遗漏？</b><p>沿“开始 → 工作与干预 → 查看产物 → 离开与回来”逐项检查。每项写明负责人、数据、界面、失败处理和当前实现状态。</p></article></div><p>术语纠正：当前 Farfold 分别接入 Pi RPC、OpenCode HTTP/SSE、Codex App Server，是实现三种现有原生接口的客户端，不是自行发明三套协议。</p>'''
recommend='''<p><strong>当前建议 A：模块化的应用内 Host + 公共 ACP。</strong>原因是 Farfold 目前专注单机 macOS，已有 Tauri 后端和持久化基础。先按职责整理完整 Host，可保留最多现有基础，避免同时引入一套后台服务的安装与升级问题。这是本报告的设计推断，尚非用户决策。</p><p>如果“彻底退出 Farfold 后，任务还必须继续”成为明确要求，再优先比较 B。若仅要求关闭窗口后继续，可先通过保留应用后台进程实现，不必立刻拆出独立 daemon。C 只在明确需要远程机器或多端访问时考虑。</p><div class="scroll"><table><thead><tr><th>选择点</th><th>A 应用内 Host</th><th>B 独立本地 Host</th><th>C 服务端 Host</th></tr></thead><tbody><tr><td>公共能力是否不同</td><td colspan="3">可以采用同一套职责与 ACP 边界；差别在生命周期、通信与部署</td></tr><tr><td>任务由谁持有</td><td>桌面应用的后端</td><td>独立本地进程</td><td>远程服务</td></tr><tr><td>用户完全退出界面应用</td><td>按既定退出策略结束任务</td><td>Host 可继续；系统休眠或 Host 退出仍会影响任务</td><td>服务端继续；网络恢复后客户端重连</td></tr><tr><td>额外工作</td><td>最少部署变化，仍要做好现有退出与恢复</td><td>守护进程启停、连接认证、协议版本匹配、双进程升级与清理</td><td>网络鉴权、文件位置、远程凭据、服务运维与多客户端同步</td></tr><tr><td>同行参照</td><td>Codeg 桌面共用核心；Zed / JetBrains 复用应用服务的思想</td><td>Verde 描述的会话 daemon；Farfold 若采用仍可统一 ACP</td><td>Codeg 独立 server；Kandev 的服务端与执行环境分工</td></tr></tbody></table></div><p class="muted">候选图是为 Farfold 推导的设计，不是将某一家同行的源码架构原样复制。B/C 也不代表同时做多个活跃控制中心。</p>'''
gaps='''<ol><li><b>协议层：</b>增加共同 ACP 客户端，替换 Farfold 内三条原生工作通信与重复事件解析；保留仍需要的原生配置映射。</li><li><b>接入管理：</b>把当前 Codex 的本机安装路径扩展成统一来源管理，补 Pi/OpenCode 的按需安装；同时管理适配器与依赖。</li><li><b>工作环境服务：</b>把已有工作副本、文件引用与 Git 状态扩展为明确的文件/差异/终端服务，按 ACP 实际能力承接客户端回调。</li><li><b>工作台：</b>补共同工具与产物展示、文件预览和逐行差异；已有路径审阅、侧栏和输入框可继续使用。专属操作继续按能力展示。</li><li><b>恢复与配置：</b>现有身份、草稿、事件缺口、并发控制、迁移和备份是需要保留的基础；新接入不得绕过它们。Provider 跨 Agent 复用见新增的统一模型服务设计；仍需验证各接入包的实际配置作用域。</li></ol><p>“覆盖清单完整”不等于“每项现在都要新增”。完整编辑器、交互终端、浏览器、Git 提交与撤销等属于可选择的工作台能力，应逐项确认本轮范围。跨 Agent 协作、LifeModel 和第四个 Runtime 不在本轮。</p>'''
decisions='''<div class="cards"><article><b>运行寿命</b><p>关闭窗口、退出应用、Agent 崩溃后分别发生什么？任务要不要继续，是 A/B 选择的主要依据。</p></article><article><b>文件与审阅深度</b><p>先支持只读文件预览和逐行 diff，还是还需要编辑、提交与撤销？“审阅”与“应用修改”必须分开。</p></article><article><b>会话与数据</b><p>已明确开发旧会话不迁移；保留 Provider 等重要配置。新建会话仍需恢复能力。实际清理先辨认数据归属，不删除项目文件或其他工具的独立数据。</p></article><article><b>认证与兼容</b><p>哪些原有账号可以复用？哪些 Provider 可以统一配置？选定哪版协议、SDK 和适配器作为兼容基线？</p></article></div><p>这些是后续对齐入口，不要求现在一次回答。对每个必要用户流程画出正常路径和失败路径，再把未确定处收敛，最后进入开发。</p>'''
sources='''<p>方法：沿用前一轮 12 个候选的筛选，本轮重点核查 Zed、Codeg、Kandev、JetBrains、Verde；其中前三者检查了关键源码，JetBrains 与 Verde 的相关运行行为主要依据官方文档/项目说明。未逐一安装同行产品，也未做稳定性排名。“已有实现”不等于商业成功或所有能力已经验证。</p><ul>
<li>Zed：<a href="https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs#L710">ACP 客户端注册文件/终端/权限处理</a>；<a href="https://github.com/zed-industries/zed/blob/main/crates/acp_thread/src/acp_thread.rs#L1833">diff 内容映射</a>；<a href="https://github.com/zed-industries/zed/blob/main/crates/acp_thread/src/acp_thread.rs#L4310">文件与终端服务</a>；<a href="https://zed.dev/docs/ai/agent-panel">面板文档及外部 Agent 能力限制</a>。不能把原生 Zed Agent 的全部 checkpoint / steering 能力套到外部 Agent。</li>
<li>Codeg：<a href="https://docs.codeg.app/reference/architecture">公共核心与部署</a>；<a href="https://docs.codeg.app/guide/git">Git 与 worktree</a>；<a href="https://github.com/xintaofei/codeg/blob/main/src-tauri/src/acp/connection.rs">ACP 连接、原生分支与配置映射</a>；<a href="https://github.com/xintaofei/codeg/blob/main/src-tauri/src/commands/file_io.rs">Host 文件输出</a>。</li>
<li>Kandev：<a href="https://github.com/kdlbs/kandev/blob/main/apps/backend/internal/agentctl/server/adapter/factory.go">结构化协议工厂</a>；<a href="https://github.com/kdlbs/kandev/blob/main/apps/backend/internal/agentctl/server/adapter/transport/acp/adapter.go">ACP 公共适配层</a>；<a href="https://github.com/kdlbs/kandev/blob/main/apps/backend/internal/agent/agents/agent.go">Agent 接入定义</a>；<a href="https://github.com/kdlbs/kandev/blob/main/docs/public/add-agent-cli.md">安装、启动、认证、能力与 MCP 的接入指南</a>。</li>
<li><a href="https://www.jetbrains.com/help/ai-assistant/acp.html">JetBrains 的外部 Agent 安装与配置</a>；<a href="https://github.com/JonathanRiche/verde">Verde 的守护进程说明</a>。不据此声称 Farfold 应复制它们的所有功能。</li>
<li>ACP：<a href="https://agentclientprotocol.com/protocol/v1/initialization">版本与能力</a>、<a href="https://agentclientprotocol.com/protocol/v1/tool-calls">工具、diff 与权限</a>、<a href="https://agentclientprotocol.com/protocol/v1/file-system">文件回调</a>、<a href="https://agentclientprotocol.com/protocol/v1/terminals">终端回调</a>。协议目录存在草案与扩展，不能与固定版本已实现能力混淆。</li>
</ul><p>源码读取说明：部分大型仓库归档下载失败，已改用官方页面与逐文件读取。Zed 的 acp_thread.rs 和 Codeg 的 connection.rs 有读取截断，仅使用实际读到的函数/分支，不据此作全仓库无遗漏或不存在某功能的断言。链接指向动态分支，后续实现前需固定源码与依赖版本。</p><p>Farfold 当前事实以本轮工作区源码为依据：App.tsx；runtime/workspace-contract.ts、use-host-workspace.ts；Rust 的 runtime_supervisor、runtime_event_router、ui_transport、interaction_registry、turn_coordinator、session_controller、session_reconciler、capability_authority；host_store 内的 records、session_binding_index、working_copy_manager、turn_changes、session_deletion、portable_export/import；project_file_reference、managed_update/update_recovery。文件定位在 Finder 中显示，不等于已有完整内嵌编辑器。</p><p>源码已有与安装应用可用严格分开：本轮未运行新的安装应用验收。现有交付记录仍以活动计划和 INTERNAL-USE.md 为准；此前 Pi 启动超时观察不在本轮解决范围。工作区已有其他改动，本轮仅写 reports 下的研究与图文。</p>'''

from design_rules import build as build_design_rules
rules_section, rules_md = build_design_rules()
from provider_review import build as build_provider_review
provider_section, stress_section, provider_md = build_provider_review(Fig)
from capability_contract import build as build_capability_contract
capability_section, capability_md = build_capability_contract(Fig)

css='''*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:#213d46;background:#f6f9fa;font:17px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}main{max-width:1450px;margin:auto;padding:38px 30px 75px}h1{font-size:36px;line-height:1.3;margin:14px 0}h2{font-size:26px;margin:38px 0 14px}p{max-width:1150px}.meta,.muted{font-size:14px;color:#607782}.lead{font-size:21px;max-width:1170px}.notice{padding:16px 20px;background:#eaf0fc;border-left:4px solid #93a9d5;margin:20px 0}.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin:23px 0}a{color:#23685a}button,.toolbar a{font:inherit;border:1px solid #b9cbd0;padding:8px 15px;border-radius:8px;background:#fff;color:#23685a;cursor:pointer;text-decoration:none}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.cards article{padding:20px;border:1px solid #cad8dd;border-radius:12px;background:white}.cards b{font-size:19px}.cards p{margin:8px 0 0}.diagram,.scroll{overflow:auto;border:1px solid #c8d8dd;border-radius:12px}.diagram svg{display:block;width:100%;height:auto;min-width:1030px}table{border-collapse:collapse;width:100%;font-size:15px;background:white}td,th{padding:13px 15px;border:1px solid #d5e0e4;text-align:left;vertical-align:top}th{background:#edf3f5}details{background:white;border:1px solid #c8d8dd;border-radius:10px;margin:16px 0;padding:14px}summary{font-size:19px;font-weight:600;cursor:pointer}details .scroll{margin-top:15px}input{font:inherit;background:white;border:1px solid #abc1c8;border-radius:8px;padding:11px 15px;width:min(600px,100%)}.inventory td:first-child{width:155px;font-weight:600}.inventory td:nth-child(2){width:240px}.inventory td:nth-child(3){width:290px}li{margin:10px 0}.empty{padding:15px;color:#607782}[hidden]{display:none!important}nav.sticky{position:sticky;top:0;z-index:2;background:#f6f9faed;padding:8px 0;backdrop-filter:blur(12px)}@media(max-width:760px){main{padding:22px 14px}h1{font-size:29px}.cards{grid-template-columns:1fr}.scroll table{min-width:980px}.lead{font-size:18px}.toolbar{gap:7px}.toolbar a{padding:5px 9px;font-size:14px}}@media print{@page{size:A3 portrait;margin:12mm}.toolbar,input,.searchlabel{display:none}main{padding:0}.diagram svg{min-width:0}.diagram{break-inside:avoid;overflow:visible}h2{break-after:avoid}details{break-inside:auto}nav.sticky{position:static}}'''
html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Farfold · Host 完整架构研究与候选方案</title><style>'''+css+'''</style></head><body><main><div class="meta">设计研究 · 2026 年 9 月 10 日 · 深入公共 Host，保留 Agent 边界</div><h1>Farfold：从统一接入，到完整工作台</h1>'''+intro+'''<nav class="toolbar sticky"><a href="#questions">问题拆解</a><a href="#peers">同行做法</a><a href="#whole">完整职责图</a><a href="#inventory">24 项机制</a><a href="#diff">代码变更</a><a href="#options">三套方案</a><a href="#gaps">差距与决策</a></nav><h2 id="questions">1 · 你真正提出的四个问题</h2>'''+problem+'''<h2 id="peers">2 · 同行共性是“完整 Host + 协议接入”，具体边界各有不同</h2><div class="scroll">'''+peer_table+'''</div><p>这些参考支持“不修改外部 Agent，通过公开接口做 Host”的方向。不同产品复用既有 IDE 服务、自己建设工作台服务，或把执行服务独立出来；没有一份所有同行完全相同的模块清单。</p><h2 id="whole">3 · 完整公共架构：把遗漏的工作环境服务画出来</h2><div class="diagram" id="complete-diagram">'''+complete+'''</div><p>图中的内部接口是 Farfold 自己的产品边界，不是又发明一套对外 Agent 协议。Host 中各项职责可以在同一个程序内实现；文件、终端等资源服务同时服务前端和按能力协商后的 ACP 回调。</p><h2 id="inventory">4 · 沿用户工作过程核对 24 项公共机制</h2><p>“已有”只指本轮看到对应源码基础；“部分已有”不表示完整产品验收通过。覆盖范围用于防遗漏，不把所有可选功能变成当前开发承诺。</p><label class="searchlabel" for="search">筛选机制，例如：会话、diff、安装、恢复</label><br><input id="search" type="search" placeholder="输入关键词筛选职责清单"><p class="muted" id="count" aria-live="polite">显示 24 项</p>'''+inventory+'''<p id="empty" class="empty" hidden>没有匹配项，请换一个关键词。</p><h2 id="diff">5 · 代码变更不只是“接收事件”</h2><div class="diagram" id="change-diagram">'''+change+'''</div><p>已有 Farfold 的路径审阅可以保留；逐行 diff、文件预览和可能的撤销需要在它上面明确设计。代码与文档产物可以共享文件能力，不必按 coding / 非 coding 切成两套前端。</p><h2 id="options">6 · 三套可能的 Host 架构</h2><div class="diagram" id="options-diagram">'''+options+'''</div>'''+recommend+'''<h2 id="gaps">7 · 相比当前，真正要补的五组工作</h2>'''+gaps+'''<h2>8 · 在开发前继续澄清的设计点</h2>'''+decisions+'''<details><summary>来源、源码证据与研究边界</summary>'''+sources+'''</details><div class="toolbar"><a href="Farfold-Host架构研究与方案.md" download>下载文字研究稿</a><a href="assets/host-complete.svg" download>完整职责图 SVG</a><a href="assets/host-three-options.svg" download>三方案图 SVG</a><button id="print">打印 / 保存 PDF</button></div><p class="muted">本研究沿用此前统一 ACP 候选，进一步补足 Host 产品职责。替代“只列几个关键词即覆盖全部”的理解，不替代活动开发计划，也不将推荐方案当作已经拍板。</p></main><script>
const q=document.querySelector('#search');q.addEventListener('input',()=>{const s=q.value.trim().toLowerCase();let total=0;document.querySelectorAll('.inventory').forEach(g=>{let n=0;g.querySelectorAll('.mechanism').forEach(r=>{const yes=r.textContent.toLowerCase().includes(s);r.hidden=!yes;if(yes)n++});g.hidden=n===0;if(s)g.open=true;total+=n});document.querySelector('#count').textContent='显示 '+total+' 项';document.querySelector('#empty').hidden=total!==0});document.querySelector('#print').addEventListener('click',()=>{document.querySelectorAll('details').forEach(d=>d.open=true);q.value='';q.dispatchEvent(new Event('input'));window.print()});
</script></body></html>'''
html=html.replace('<h2 id="options">',provider_section+'<h2 id="options">').replace('<h2 id="gaps">',stress_section+'<h2 id="gaps">')
html=html.replace('<h2 id="gaps">',rules_section+'<h2 id="gaps">')
html=html.replace('<h2 id="gaps">',capability_section+'<h2 id="gaps">')
html=html.replace('<a href="#options">三套方案</a>','<a href="#provider">模型服务</a><a href="#options">三套方案</a><a href="#stress">压力测试</a><a href="#rules">设计规则</a>')
html=html.replace('<a href="#gaps">差距与决策</a>','<a href="#capabilities">三路能力与流程</a><a href="#gaps">差距与决策</a>')
html=html.replace('设计研究 · 2026 年 9 月 10 日','设计研究 · 修订 5 · 2026 年 9 月 10 日')
(ROOT/'Farfold-Host完整架构研究与候选方案.html').write_text(html,encoding='utf-8')

md=['# Farfold Host 架构研究与候选方案','2026-09-10 · 设计研究，不进入开发',
'建议优先采用应用内模块化 Host + 公共 ACP；最终选择尚未定案。完整 Host 包括管理、状态、资源与数据服务，ACP 只承担其中的标准通信边界。',
'## 根本问题','不修改 Agent 本体，不代表只写前端。Farfold 要为用户工作提供本机资源与可靠状态，且清楚区分 Agent 上报和实际文件变化。当前是分别实现三种原生接口的客户端，不是自行发明三套协议。',
'## 同行证据']
for n,a,b,c,u in peers:md.append(f'- [{n}]({u})：{a}。{b}{c}')
md+=['## 完整逻辑架构','![完整职责](assets/host-complete.svg)','## 公共机制覆盖范围']
for title,rows in groups:
    md+=['### '+title,'\n'.join(['| 用户需要 | 责任与数据来源 | 当前源码基础 | 还需设计与异常边界 |','| --- | --- | --- | --- |']+['| '+' | '.join(r)+' |' for r in rows])]
md+=['## 代码变更信息链路','![信息来源](assets/change-information-flow.svg)','Agent 报告和 Host 实际观察分开。权限批准、文件审阅、应用修改和撤销恢复分别定义。','## 三套候选','![候选方案](assets/host-three-options.svg)',
'A：Host 在 Tauri 应用内，当前优先建议。B：独立本地 Host，适用于退出界面应用后仍需工作。C：服务端 Host，只有明确远程需求才考虑，当前不纳入开发。三者可以共用相同的 ACP 与功能职责，变化在运行归属、通信和升级复杂度。',
'关闭窗口不等于退出应用；应用内后台运行也可能满足需求。拆出 daemon 不会自动解决电脑休眠、Agent 崩溃或服务升级。',
'## 当前差距','公共 ACP 与接入管理；完整文件/终端/差异服务；共享工作台产物展示；兼容 Provider 配置复用；ACP 对既有恢复与身份机制的衔接。现有 Host 数据、工作副本、事件可靠性、交互生命周期等应保留完善，而非推倒重做。',
'## 设计待明确','退出语义；文件审阅深度；开发旧历史不迁移，保留重要配置；新会话恢复；账号复用；协议/SDK/适配器兼容基线；必要与可选工作台能力。完整编辑器、交互终端、浏览器、提交和撤销不因被列入清单就成为本轮必做。',
'## 研究边界','本轮重点读取官方文档与关键源码，未逐一安装同行应用。部分大文件和仓库下载截断，结论只使用实际读到的部分，未作全仓审计断言。当前 Farfold 的依据是工作区源码，不是新的安装应用验收；既有 Pi 启动超时观察未在本轮解决。只写 reports 下材料，不改应用实现、不替代活动计划。完整来源和源码位置见 HTML 的证据折叠区。']
md.append(provider_md)
md.append(rules_md)
md.append(capability_md)
(ROOT/'Farfold-三路ACP能力保留与状态流程.md').write_text(capability_md,encoding='utf-8')
(ROOT/'Farfold-接入研究索引与设计规则.md').write_text(rules_md,encoding='utf-8')
(ROOT/'Farfold-Host架构研究与方案.md').write_text('\n\n'.join(md),encoding='utf-8')
print(ROOT/'Farfold-Host完整架构研究与候选方案.html')
