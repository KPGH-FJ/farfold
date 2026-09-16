from pathlib import Path
from html import escape as e

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'architecture-assets'
ASSETS.mkdir(exist_ok=True)
STYLE = '''text{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;fill:#233949} .title{font-size:23px;font-weight:650}.body{font-size:18px;fill:#485c68}.small{font-size:16px;fill:#566975}.group-label{font-size:17px;font-weight:600;letter-spacing:1px}.node rect{fill:#fff;stroke:#9aacb6;stroke-width:1.6}.node.core rect{fill:#edf5f6;stroke:#60858f}.node.runtime rect{fill:#edf1f9;stroke:#778eae}.node.future rect{fill:#fffbf2;stroke:#b78132;stroke-dasharray:7 5}.node.life rect{fill:#f7f2fb;stroke:#977aaf;stroke-dasharray:7 5}.node.frozen rect{fill:#f3f3f0;stroke:#94988e;stroke-dasharray:4 4}.node{cursor:pointer;outline:none}.node:hover rect,.node:focus rect{stroke:#b55732;stroke-width:3}.edge{fill:none;stroke:#64828d;stroke-width:2;marker-end:url(#arrow)}.both{marker-start:url(#back)}.potential{stroke:#b78132;stroke-dasharray:7 5;marker-end:url(#futureArrow)}.life-edge{stroke:#977aaf;stroke-dasharray:7 5;marker-end:url(#lifeArrow)}.boundary{fill:#fcfdfd;stroke:#bacbd1;stroke-width:1.4}.future-boundary{fill:#fffefa;stroke:#d4b782;stroke-width:1.5;stroke-dasharray:9 6}'''

def start(title, desc, height=1040):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 {height}" role="img" aria-label="{e(title)}"><title>{e(title)}</title><desc>{e(desc)}</desc><style>{STYLE}</style><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#64828d"/></marker><marker id="back" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M8 0 L0 4 L8 8Z" fill="#64828d"/></marker><marker id="futureArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#b78132"/></marker><marker id="lifeArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#977aaf"/></marker></defs><rect width="1440" height="{height}" fill="#fff"/>']

def text(s,x,y,content,kind='body',anchor='start'):
    s.append(f'<text x="{x}" y="{y}" class="{kind}" text-anchor="{anchor}">{e(content)}</text>')

def node(s,x,y,w,h,title,lines=(),kind='',detail=''):
    s.append(f'<g class="node {kind}" tabindex="0" role="button" aria-label="{e(title)}，查看说明" data-title="{e(title)}" data-detail="{e(detail or "；".join(lines))}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12"/>')
    s.append(f'<text x="{x+20}" y="{y+33}" class="title" style="font-size:{19 if w <= 230 else 23}px">{e(title)}</text>')
    for n,line in enumerate(lines): text(s,x+20,y+62+n*26,line,'small' if w <= 230 else 'body')
    s.append('</g>')

def edge(s,path,kind=''):
    s.append(f'<path d="{path}" class="edge {kind}"/>')

def current():
    s=start('Farfold 当前架构','当前三 Runtime 架构。Farfold 拥有界面和 Host，Pi、OpenCode、Codex 保留独立执行循环和原生会话。LifeModel 原型冻结且可选。')
    text(s,70,63,'当前三 Runtime 架构','title'); text(s,70,91,'Farfold · 2026-09-09','small')
    s.append('<rect x="40" y="150" width="990" height="522" rx="18" class="boundary"/>')
    text(s,60,178,'FARFOLD 拥有的桌面产品','group-label')
    node(s,440,32,470,78,'用户与真实项目',['选择 Agent、发起任务、审批与干预'],'core')
    edge(s,'M675 110 V200','both'); text(s,695,139,'输入 / 进展 / 结果','small')
    node(s,70,200,930,100,'统一 Farfold 工作台',['React 19 + TypeScript · Tauri 2 macOS 外壳','项目与会话导航、模型选择、输入、工具过程、原生交互与恢复'],'core', 'App.tsx 组合 PiWorkspace、OpenCodeWorkspace 与 CodexWorkspace，复用导航、开始工作、输入与交互容器。各 Runtime 的专属操作仍由专属模块实现；Farfold 不嵌入第三方 UI。')
    edge(s,'M535 300 V351','both'); text(s,555,332,'类型化 Tauri 命令与事件','small')
    node(s,70,351,930,130,'Rust Host 公共机制',['安装与连接身份 · 会话绑定 · 自有进程生命周期','任务准入与目录排他 · 事件分发与缺口处理 · 原生交互登记 · 恢复'],'core','RuntimeSupervisor、SessionController、TurnCoordinator、RuntimeEventRouter、InteractionRegistry 共同管理 Host 职责。最多两条活动任务、同一 Working Copy 排他。控制请求被接受不等于任务完成；异常时保留未知状态。')
    edge(s,'M1000 410 H1090','both')
    node(s,1090,351,310,130,'Farfold 本地 SQLite',['Host schema 8','项目、草稿、会话与程序引用'],'core','保存 Farfold 自身的项目、工作副本、导航、草稿、安装和原生会话引用。不是 Runtime 原生历史的替代权威，也不保存模型凭据。升级需应用与数据配对恢复。')
    node(s,1090,200,310,100,'LifeModel 最简原型',['可选 · 默认关闭 · 功能冻结'],'frozen','当前保留入口和既有 opt-in、Proposal 审阅与用户批准语义。它不是完整 LifeModel System。Codex 首版既不贡献也不消费 LifeModel，普通 Runtime 工作不依赖它。')
    edge(s,'M1000 249 H1090','life-edge')
    text(s,1070,315,'可选入口，独立于基础工作','small','middle')
    for x,title,lines,detail in [
        (70,'Pi 适配器',['RPC + 同版本能力桥接'],'Pi 工作链路通过 JSONL RPC；Provider、模型、认证与资源发现经同版本能力桥接提供。保留 Pi 资源信任、转向、跟进与扩展语义。'),
        (390,'OpenCode 适配器',['HTTP 命令 + SSE 事件'],'使用官方 Server。会话、工具权限、事件、原生状态与历史核对保留 OpenCode 语义；断流不视作停止。'),
        (710,'Codex 适配器',['自有 stdio App Server'],'固定 CLI 0.143.0。复用用户选择的官方程序，独立状态与原生认证；通过官方 App Server 实现任务、命令与文件审批、Plan 提问、转向和续接。')]:
        edge(s,f'M{x+150} 481 V545','both')
        node(s,x,545,290,92,title,lines,'',detail)
    text(s,1090,527,'身份与数据边界','group-label')
    text(s,1090,561,'每个会话固定绑定一条连接')
    text(s,1090,587,'和一个 Runtime 原生会话')
    text(s,1090,623,'切换 Agent 会进入另一会话')
    text(s,1090,649,'不迁移不透明的内部状态')
    text(s,1090,695,'官方接口边界','group-label'); text(s,1090,726,'向下发命令 / 向上返原生事件','small')
    for x,protocol in [(70,'JSONL RPC / stdio'),(390,'HTTP / SSE'),(710,'JSON-RPC / stdio')]:
        edge(s,f'M{x+145} 637 V776','both'); text(s,x+160,749,protocol,'small')
    for x,title,lines in [(70,'Pi 0.84.3',['随应用提供 · 摘要固定']),(390,'OpenCode 1.15.13',['随应用提供 · 摘要固定']),(710,'Codex CLI 0.143.0',['用户程序 · 验证路径与摘要'])]:
        node(s,x,776,290,100,title,lines,'runtime','此 Runtime 独立拥有 Agent loop、原生 Session、Provider/模型、工具、权限和工作记忆。具体 UI 能力以对应适配器和已验证范围为准。')
    text(s,70,919,'各 Runtime 自己拥有 Agent loop、原生 Session、Provider / 模型、工具、权限、Skills 与工作记忆。','body')
    text(s,70,954,'Farfold 连接并呈现这些能力；不修改 Runtime，不另建 Agent 执行循环。','body')
    node(s,1090,776,310,162,'Runtime 数据与真实工作',['原生会话历史与认证','模型服务 / 本地模型','用户项目中的实际文件'],'runtime','这些资源由各 Runtime 按其原生机制使用。原生认证和历史分别保存；项目文件是用户数据。Host 的会话引用不能代替完整原生历史，Host 导出也不是完整升级备份。')
    edge(s,'M215 876 V889 H1045 V825 H1090'); edge(s,'M535 876 V889'); edge(s,'M855 876 V889')
    text(s,70,1009,'范围说明：逻辑架构图；框不代表独立服务。三路是平级选择，并发不等于协作。','small')
    s.append('</svg>'); return ''.join(s)

def future():
    s=start('Farfold 未来可能的项目架构','概念架构，非排期。已有多 Runtime Host 保留，未来可选增加交接或共享任务协作，并接入独立 LifeModel System。全部新增方向当前暂缓。',1100)
    text(s,70,59,'未来概念架构','title'); text(s,70,88,'暂缓 · 非实施计划','small')
    s.append('<rect x="40" y="150" width="990" height="616" rx="18" class="boundary"/><rect x="1070" y="150" width="340" height="616" rx="18" class="future-boundary"/>')
    node(s,440,28,470,78,'用户掌握目标、授权与选择',['基础工作持续可用 · 增益能力可选'],'core')
    edge(s,'M675 106 V205','both')
    text(s,60,179,'FARFOLD 可能的演进','group-label'); text(s,1087,179,'独立 LifeModel System · 暂缓集成','small')
    node(s,70,205,930,92,'统一个人工作台',['现有项目与会话体验 + 可选的跨 Agent 任务视图'],'core','保留独立 Farfold UI/UX。未来任务视图是候选增益，不能成为普通单 Agent 工作的前置条件。图中的新增模块是职责设想，不规定服务拆分、数据库或 API 实现。')
    node(s,70,355,440,100,'跨 Agent 任务交接',['目标、来源、成果文件、未完成事项'],'future','此前讨论的候选，当前暂缓。交接的是可检查的工作材料，不是完整原生状态或模型内部推理。需未来另行验证遗漏、文件访问、授权、返工、时间与费用。')
    node(s,560,355,440,100,'共享任务空间中的协作',['角色、消息、成果、冲突与终止条件'],'future','此前讨论的候选，当前暂缓。组织者是可选择、可更换的任务角色；各参与者保留独立 Runtime 与 Session，不必成为某个 Agent 的原生 subagent。')
    edge(s,'M290 297 V355','potential');edge(s,'M780 297 V355','potential')
    edge(s,'M290 455 V512','potential');edge(s,'M780 455 V512','potential')
    edge(s,'M70 250 H53 V550 H70'); text(s,320,490,'可选增益；普通工作可直接使用既有 Host','small')
    node(s,70,512,930,92,'保留既有 Host 与数据权责',['连接 / 会话引用 / 工作副本 / 事件 / 原生交互 / 恢复'],'core','现有 Host 仍提供基础工作控制与数据连续性。任何未来协调机制都不替代 Runtime 自己的 Agent loop，不迁移不透明原生状态，也不绕过原生工具权限。')
    for x,title,kind in [(70,'Pi 适配器',''),(310,'OpenCode 适配器',''),(550,'Codex 适配器',''),(790,'其他适配器','future')]:
        edge(s,f'M{x+105} 604 V650','potential' if kind else '')
        node(s,x,650,210,84,title,['官方接口与专属能力'] if not kind else ['候选 · 尚未启动'],kind,'保留现有三路适配器。其他 Runtime 仅为未来扩展位置，当前第四路暂缓；具体对象、接口、许可和完整能力均需另行核验。' if kind else '复用公共机制，同时保留该 Runtime 已验证的原生能力。不同接口不强行压成完全相同的能力集。')
    for x,title,kind in [(70,'Pi','runtime'),(310,'OpenCode','runtime'),(550,'Codex','runtime'),(790,'未来 Runtime','future')]:
        edge(s,f'M{x+105} 734 V846','potential' if kind=='future' else 'both')
        node(s,x,846,210,93,title,['独立 loop 与 Session'],kind)
    text(s,1070,812,'通过官方接口接入原生执行系统','small')
    text(s,70,979,'无论是否启用交接、协作或 LifeModel，基础 Runtime 工作都应独立成立。','body')
    # Optional source contribution and consumption use different paths and never bypass approval.
    node(s,1090,213,300,75,'经授权的来源证据',['独立能力一：贡献来源'],'life','Farfold 中符合条件的可追溯来源，可在授权后贡献给独立系统；也可能存在其他授权来源。不是自动上传所有原生历史。')
    node(s,1090,329,300,75,'候选理解与 Proposal',[],'life','独立 LifeModel System 负责形成候选理解。候选有来源依据；不等于自动写入正式个人模型。')
    node(s,1090,445,300,75,'用户确认、修改或拒绝',[],'life','用户审批是进入正式个人 LifeModel 的必要环节，不能被 Agent 的工具权限批准替代。')
    node(s,1090,561,300,75,'用户的个人 LifeModel',[],'life','正式模型属于用户，独立于任何 Runtime。形成质量、更新与实际效果由独立系统研究与验证，不由现有最简原型定义全部范围。')
    for a,b in [(288,329),(404,445),(520,561)]: edge(s,f'M1240 {a} V{b}','life-edge')
    text(s,1090,682,'相关性选择 → 用户预览','body');text(s,1090,711,'→ 官方上下文通道 → 合格 Runtime','small')
    edge(s,'M1240 636 V653','life-edge')
    edge(s,'M1000 252 H1090','life-edge')
    edge(s,'M1080 708 H1048 V558 H1000','life-edge')
    text(s,1090,748,'独立能力二：使用个人理解','small')
    node(s,1070,846,340,138,'更远的系统生态范围',['其他授权来源 / 其他应用出口','手机记录、插件、智能设备等'],'life','既有讨论中的远期系统设想，不是 Farfold 已交付能力，也不表示当前需要开发手机端、硬件或云平台。系统来源与出口的接口尚未在本图定义。')
    text(s,70,1045,'虚线模块与链路均为可能方向：用户已明确暂缓；本图仅用于产品与商业材料对齐。','small')
    s.append('</svg>');return ''.join(s)

C,F=current(),future()
import re
def static_svg(value):
    value=re.sub(r' (?:tabindex|data-title|data-detail)="[^"]*"','',value).replace(' role="button"','').replace('，查看说明','').replace('cursor:pointer','cursor:default')
    return value
(ASSETS/'farfold-current-architecture.svg').write_text(static_svg(C))
(ASSETS/'farfold-future-architecture.svg').write_text(static_svg(F))

def panel(id,num,title,desc,svg,summary):
    return f'''<section class="diagram-section" id="{id}"><header class="section-heading"><div><p class="eyebrow">架构图 {num}</p><h2>{title}</h2><p>{desc}</p></div><button type="button" class="download" data-export="{id}">下载此图 SVG <span aria-hidden="true">↗</span></button></header><div class="diagram-wrap" tabindex="0" aria-label="{title}，小屏可横向滚动">{svg}</div><div class="inspector" aria-live="polite"><strong>{summary[0]}</strong><p>{summary[1]}</p></div></section>'''

html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Farfold 当前与未来架构图解</title><style>
:root{--ink:#233949;--muted:#586975;--line:#d8dedc;--paper:#f7f5f0;--accent:#a3492d}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:84px}body{margin:0;background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7}a{color:var(--accent)}button,a{touch-action:manipulation}button{font:inherit;cursor:pointer}a:focus-visible,button:focus-visible,[tabindex]:focus-visible{outline:3px solid #b55732;outline-offset:5px}nav{background:#f7f5f0f5;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:28px;padding:14px max(24px,calc((100vw - 1460px)/2));backdrop-filter:blur(12px)}nav a{color:var(--ink);font-size:14px;text-decoration:none}nav .brand{font-size:19px;font-weight:700;letter-spacing:-.4px;margin-right:auto}nav button{border:0;background:transparent;color:var(--ink);font-size:14px}main{max-width:1510px;margin:auto;padding:60px 26px}.eyebrow{margin:0 0 12px;color:var(--accent);font-size:12px;font-weight:700;letter-spacing:2px}h1{font-size:clamp(32px,3.9vw,54px);line-height:1.25;letter-spacing:-1px;margin:0 0 22px;font-weight:650}h2{font-size:clamp(25px,2.4vw,34px);line-height:1.3;margin:0 0 12px}h3{font-size:19px;margin:0 0 10px}.intro{max-width:1030px}.lead{font-size:19px;line-height:1.8;color:var(--muted);margin:0 0 22px}.status{border-left:3px solid #bb704d;padding:4px 0 4px 18px;font-size:14px;color:#536570;max-width:1080px}.status strong{color:var(--ink)}.legend{display:flex;gap:28px;flex-wrap:wrap;font-size:13px;margin:30px 0 0;color:var(--muted)}.legend span{display:flex;align-items:center;gap:9px}.swatch{width:28px;height:15px;border:1.5px solid #60858f;background:#edf5f6;border-radius:4px}.swatch.runtime{background:#edf1f9;border-color:#778eae}.swatch.future{background:#fffbf2;border:1.5px dashed #b78132}.swatch.frozen{background:#f3f3f0;border:1.5px dashed #94988e}.swatch.life{background:#f7f2fb;border:1.5px dashed #977aaf}.diagram-section{margin-top:64px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}.section-heading p:not(.eyebrow){max-width:1000px;margin:0;color:var(--muted);font-size:15px}.download{white-space:nowrap;background:white;border:1px solid #c6cfce;border-radius:8px;padding:10px 16px;color:var(--ink);font-size:14px}.download:hover{border-color:var(--accent);color:var(--accent)}.diagram-wrap{background:white;border:1px solid #d0d9db;border-radius:16px;overflow-x:auto;padding:8px}.diagram-wrap svg{width:100%;min-width:1000px;height:auto;display:block}.inspector{margin-top:14px;border-top:1px solid var(--line);padding:15px 2px;min-height:104px;max-width:1120px;font-size:14px}.inspector strong{font-size:16px}.inspector p{margin:6px 0 0;color:var(--muted)}.reading-note{color:var(--muted);font-size:13px;margin-top:12px}.compare{margin:48px 0 36px;padding-top:38px;border-top:1px solid var(--line)}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:15px;margin-top:24px}th,td{text-align:left;padding:16px 18px;border:1px solid var(--line);vertical-align:top}th{background:#eaf0f0;font-size:14px}td{background:#fff}td:first-child{width:18%;font-weight:600}td:nth-child(2){width:36%}.business{display:grid;grid-template-columns:1fr 1fr;gap:42px;margin:38px 0 56px}.business p{color:var(--muted);font-size:15px;margin:0}details{font-size:14px;border-top:1px solid var(--line);padding-top:18px}summary{cursor:pointer;font-weight:650}details p,details li{color:var(--muted)}code{font-size:12px;overflow-wrap:anywhere}footer{border-top:1px solid var(--line);font-size:12px;color:var(--muted);padding-top:22px;margin-top:30px;display:flex;justify-content:space-between;gap:24px}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:700px){nav{gap:16px;padding:12px 18px;flex-wrap:wrap}nav a,nav button{font-size:12px}main{padding:32px 18px}.lead{font-size:16px}.section-heading{display:block}.download{margin-top:18px}.business{grid-template-columns:1fr;gap:24px}.legend{gap:14px}.diagram-section{margin-top:40px}table{min-width:650px}footer{display:block}.inspector{min-height:150px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{@page{size:A3 landscape;margin:10mm}body{background:white}nav,.intro,.legend,.reading-note,.download,.inspector,.compare,.business,details,footer{display:none!important}main{padding:0;max-width:none}.diagram-section{margin:0;break-after:page;break-inside:avoid}.diagram-section:last-of-type{break-after:auto}.section-heading{margin-bottom:0}.section-heading h2{font-size:23px}.section-heading p:not(.eyebrow){font-size:11px}.section-heading .eyebrow{display:none}.diagram-wrap{border:0;padding:0;overflow:visible}.diagram-wrap svg{min-width:0;width:100%;max-height:240mm}}
</style></head><body><nav aria-label="文档导航"><a class="brand" href="#top">Farfold</a><a href="#current">当前架构</a><a href="#future">未来可能架构</a><a href="#evolution">演进逻辑</a><button type="button" id="print">打印两张图</button></nav><main id="top"><header class="intro"><p class="eyebrow">产品与研发对齐 / 商业计划书配套材料</p><h1>Farfold 的当前架构，<br>与未来可能的演进。</h1><p class="lead">第一张图解释 Farfold 今天如何工作；第二张图说明在现有基础上，未来可能怎样承接任务交接、协作与个人理解。用清楚的所有权和连接关系，区分现实能力与发展空间。</p><p class="status"><strong>状态更新 · 2026 年 9 月 9 日 15:58</strong><br>三路 P6 核心范围已获用户确认验收；本机应用读取为 0.1.7，活动计划仍列交付收尾。交接、协作、LifeModel System 集成及第四路目前暂缓。此页更新了早间报告的状态口径；未来图仅整理既有方向，不代表重新启动研究或开发。</p></header><div class="legend" aria-label="图例"><span><i class="swatch"></i>Farfold 现有基础</span><span><i class="swatch runtime"></i>独立 Runtime</span><span><i class="swatch future"></i>未来候选 / 暂缓</span><span><i class="swatch life"></i>可选 LifeModel 关系</span><span><i class="swatch frozen"></i>冻结原型</span></div><p class="reading-note">点击或用 Tab 选中图中模块，可在图下查看说明。小屏可横向滚动；每张图可单独下载，便于插入报告或演示文稿。</p>'''
html+=panel('current','01','当前架构：统一工作台与三个原生 Runtime','从界面、Host 到官方接口：Farfold 管理工作体验与连续性，各 Runtime 管理自己的 Agent 执行。',C,('先看所有权边界','Farfold 管界面、身份引用、工作目录、事件与恢复；各 Runtime 管 loop、原生 Session、模型、工具与权限。点击任一模块查看对应职责。'))
html+=panel('future','02','未来可能架构：工作连续性与可选个人理解','实线保留现有基础；虚线表示可能新增的职责或连接。这是概念架构，不规定具体服务拆分、接口或排期。',F,('先看哪些部分是可选的','任务交接与协作是两种候选增益，不要求先后实施，也不依赖 LifeModel。独立 LifeModel System 的来源贡献和上下文消费各自核验，正式模型写入始终经过用户批准。'))
html+='''<section class="compare" id="evolution"><p class="eyebrow">从当前到未来</p><h2>演进的是任务体验，保留的是执行权与数据边界。</h2><div class="table-scroll"><table><thead><tr><th>维度</th><th>当前基础</th><th>未来可能方向</th></tr></thead><tbody><tr><td>使用单位</td><td>一个 Farfold 会话绑定一个 Runtime 原生会话。</td><td>任务视图可以连接多个独立会话；原生会话身份仍不迁移。</td></tr><tr><td>工作连续性</td><td>标题、草稿、目录和原生 ID 续接，异常时明确恢复。</td><td>经用户选择，把目标、证据、文件和未完成事项交给另一 Agent。</td></tr><tr><td>任务组织</td><td>最多两条活动任务，同 Working Copy 排他；这是并发控制。</td><td>可选择组织者与参与者，明确分工、成果、冲突和停止条件；须另行验证。</td></tr><tr><td>个人理解</td><td>最简原型冻结、默认关闭；Codex 当前不贡献或消费。</td><td>承接独立 LifeModel System；贡献、用户审批、消费有独立边界。</td></tr><tr><td>接入扩展</td><td>Pi RPC、OpenCode HTTP/SSE、Codex stdio App Server。</td><td>未来适配器按官方能力选择接口，可能使用 SDK、RPC、Server 或 ACP；没有第四路实施承诺。</td></tr></tbody></table></div></section><section class="business"><div><h3>商业材料可以表达的价值</h3><p>当前有依据的产品定位是：把多种 Agent 放进同一个可控制、可恢复的个人工作台。未来的价值假设是减少重复说明、跨 Agent 交接的返工，以及任务上下文切换带来的负担。</p></div><div><h3>商业材料需要另外证明的部分</h3><p>接入数量不等于用户价值或竞争壁垒。交接、协作和个人理解是否提高质量、节省时间，并足以覆盖额外费用，需要真实任务比较、用户留存与付费证据支持。</p></div></section><details><summary>核对依据与当前限制</summary><p>本页核对了 AGENTS.md、PRODUCT.md、唯一活动计划、INTERNAL-USE.md，以及 App.tsx、RuntimeSupervisor、SessionController、TurnCoordinator、RuntimeEventRouter、CodexRuntime、HostStore 等当前源码。未来图沿用 9 月 7 日既有方向及本报告内容，不新增实施决策。</p><ul><li>本机安装 0.1.7，可执行 SHA-256：<code>c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820</code>。核对时 INTERNAL-USE.md 尚列旧可执行摘要，交付记录与实际安装身份仍须在收尾中对齐；本页不宣称交付收尾完成。</li><li>用户验收确认与 Agent 观察的 QA 工程证据分别成立；此轮绘图只读核对，没有重新执行模型任务。</li><li>Codex Plan 提问使用已批准的实验 API；Default 模式的开发中提问功能关闭。固定 0.143.0 的官方冷历史可能缺少命令详情；真实 API key 请求和图片输入不在当前安装能力声明内。</li><li>图中并发不代表多 Agent 协作。既有原型不代表完整 LifeModel System；任一 Runtime 都不能直接写正式个人模型。</li><li>架构框表示逻辑职责，不代表独立服务器或微服务。当前基础是本机桌面应用，不预设云端平台或远程执行。</li></ul><p>参考文档：<a href="../../AGENTS.md">开发约定</a> · <a href="../../PRODUCT.md">产品边界</a> · <a href="../../plans/runtime-neutral-lifemodel.md">活动计划</a> · <a href="Farfold-技术路径与发展规划对齐报告.md">原对齐报告（08:34 快照）</a></p></details><footer><span>Farfold · 架构图解 · 2026-09-09</span><span>离线可读 HTML / 独立 SVG / 产品对齐与商业材料</span></footer></main><script>
document.getElementById('print').addEventListener('click',()=>window.print());
document.querySelectorAll('.node').forEach(node=>{
 const choose=()=>{const panel=node.closest('.diagram-section').querySelector('.inspector');panel.querySelector('strong').textContent=node.dataset.title;panel.querySelector('p').textContent=node.dataset.detail;};
 node.addEventListener('click',choose);node.addEventListener('focus',choose);node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose();}});
});
document.querySelectorAll('[data-export]').forEach(button=>button.addEventListener('click',()=>{
 const svg=document.querySelector('#'+button.dataset.export+' svg').cloneNode(true);
 svg.querySelectorAll('.node').forEach(n=>{n.removeAttribute('tabindex');n.removeAttribute('role');n.removeAttribute('data-detail');n.removeAttribute('data-title');n.setAttribute('aria-label',n.getAttribute('aria-label').replace('，查看说明',''));});
 const blob=new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='farfold-'+button.dataset.export+'-architecture.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}));
</script></body></html>'''
# Scope marker IDs so the two inline diagrams have independent arrow definitions.
for name,svg in [('current',C),('future',F)]:
    scoped=svg
    for marker in ['arrow','back','futureArrow','lifeArrow']:
        scoped=scoped.replace(f'id="{marker}"',f'id="{name}-{marker}"').replace(f'url(#{marker})',f'url(#{name}-{marker})')
    html=html.replace(svg,scoped)
(ROOT/'Farfold-当前与未来架构图解.html').write_text(html)
print(ROOT/'Farfold-当前与未来架构图解.html')
