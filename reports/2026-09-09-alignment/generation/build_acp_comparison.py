# -*- coding: utf-8 -*-
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'architecture-assets'

class Diagram:
    def __init__(self, w, h, title):
        self.p = [f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="{escape(title)}"><defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1L8 5L1 9" fill="none" stroke="#617680" stroke-width="1.7"/></marker></defs><style>text{{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#243b43}}.h{{font-size:23px;font-weight:650}}.b{{font-size:18px}}.s{{font-size:16px;fill:#536d77}}.tiny{{font-size:14px;fill:#536d77}}</style><rect width="{w}" height="{h}" fill="#f6f9fa"/>''']
    def text(self,x,y,t,cl='b',anchor='start'):
        self.p.append(f'<text x="{x}" y="{y}" class="{cl}" text-anchor="{anchor}">{escape(t)}</text>')
    def box(self,x,y,w,h,title,lines=(),kind='keep'):
        colors={'keep':('#eaf4ee','#91b79f'),'change':('#fff2df','#d4ad71'),'new':('#eaf1fe','#9bafe0'),'external':('#ffffff','#bac9ce')}
        fill,stroke=colors[kind]
        self.p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="13" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        self.text(x+w/2,y+32,title,'h' if w>240 else 'b','middle')
        for i,l in enumerate(lines):self.text(x+w/2,y+64+i*27,l,'s','middle')
    def arrow(self,x,y,x2,y2,both=True,dash=False):
        self.p.append(f'<path d="M{x} {y}L{x2} {y2}" fill="none" stroke="#617680" stroke-width="2" marker-end="url(#arr)"'+(' marker-start="url(#arr)"' if both else '')+(' stroke-dasharray="6 5"' if dash else '')+'/>')
    def done(self,name):
        svg=''.join(self.p)+'</svg>'
        (ASSETS/name).write_text(svg)
        return svg

d=Diagram(1500,760,'当前三种原生接口与候选统一 ACP 架构对照')
for x,title,sub in [(35,'当前：三条原生接入路径','现有源码结构 · 不是三个独立前端应用'),(785,'候选：一套 ACP 接入路径','设计讨论稿 · 尚未实施')]:
    d.text(x,38,title,'h');d.text(x,68,sub,'s')
    d.box(x,92,680,100,'Farfold 自己的工作台',['共用界面 + Agent 专属交互'],'keep')
    d.arrow(x+340,199,x+340,229)
    d.box(x,236,680,100,'公共 Host 机制',['项目 / 会话绑定 / 生命周期 / 事件通道'],'keep')

for c,title,lines,agent in [(140,'Pi 接入',['RPC / JSONL'],'Pi'),(375,'OpenCode 接入',['HTTP / SSE'],'OpenCode'),(610,'Codex 接入',['App Server'],'Codex')]:
    d.arrow(c,343,c,387)
    d.box(c-105,395,210,98,title,lines,'change')
    d.arrow(c,500,c,575)
    d.box(c-105,585,210,82,agent,['Agent 本体'],'external')
d.text(375,713,'Farfold 自己处理三种协议和相应事件映射','b','middle')
d.text(375,742,'共同基础已经存在，不需要推翻工作台','s','middle')

d.arrow(1125,343,1125,368)
d.box(785,376,680,100,'新增：公共 ACP 客户端',['握手 / 能力 / 请求 / 事件 / 权限与提问'],'new')
for c,title,lines,agent in [(890,'Pi ACP 适配器',['复用社区实现'],'Pi'),(1125,'OpenCode 原生 ACP',['由 Agent 自己提供'],'OpenCode'),(1360,'Codex ACP 适配器',['复用生态实现'],'Codex')]:
    d.arrow(c,483,c,516)
    d.box(c-105,524,210,93,title,lines,'change')
    d.arrow(c,623,c,646)
    d.box(c-105,653,210,56,agent,[],'external')
d.text(1125,742,'Farfold 统一说 ACP；底层差异由原生接口或适配器承接','s','middle')
comparison=d.done('farfold-acp-before-after.svg')

d=Diagram(1240,1390,'Farfold 统一 ACP 候选完整架构，保留新增替换边界')
d.text(45,38,'统一 ACP 后：各部分分别负责什么','h')
d.text(45,68,'绿色：保留并完善　蓝色：新增公共能力　橙色：替换 / 改造　白色：外部 Agent','s')
d.box(45,96,1100,120,'01 · 自有工作台【保留并完善】',['共用项目、会话、输入框、消息和状态展示','按 Agent 能力显示专属交互；界面仍由 Farfold 实现'],'keep')
d.arrow(595,223,595,267)
d.text(618,249,'稳定的 Farfold 内部接口','s')
d.text(45,301,'02 · 公共 Host 中间层【已有基础 + 补齐管理能力】','h')
d.box(45,322,345,214,'安装与版本【扩展】',['本机已有：发现 / 选择 / 记住','工作台：按需安装 Agent / 适配器','管理版本、依赖、升级与来源','主安装包不附带 Agent 本体'],'new')
d.box(422,322,345,214,'工作与会话【保留并完善】',['启动 / 停止 / 故障恢复','项目与原生 Session 绑定','操作状态 / 事件分发 / 诊断','Farfold 数据与原生历史分开'],'keep')
d.box(799,322,345,214,'Provider 配置【单独建设】',['兼容的模型服务只配置一次','按 Agent 官方配置方式应用','安全保存凭据引用与授权范围','专属账号仍走各自认证'],'new')
d.arrow(595,543,595,593)
d.text(617,571,'公共工作操作进入同一条通信路径','s')
d.box(45,602,1100,148,'03 · 一套公共 ACP 客户端【新增；替换三套直连通信】',['共用协议 SDK / 请求关联 / 流式事件 / 超时与断开处理','握手并读取实际能力；会话、模型选项、权限与提问按支持情况呈现','收到什么事件，就按其语义展示；未知扩展留在边界并可诊断'],'new')
d.p.append('<rect x="35" y="812" width="1120" height="307" rx="16" fill="none" stroke="#aebfc7" stroke-dasharray="7 5"/>')
for c in [217,595,973]:d.arrow(c,757,c,835)
d.box(55,844,325,100,'Pi ACP 适配器【接入】',['将 ACP 转为 Pi 的原生 RPC'],'change')
d.arrow(217,951,217,979)
d.box(55,988,325,108,'Pi 本体【保留】',['自己的 Agent 循环和原生会话','本机已有 / 按需安装'],'external')
d.box(432,844,325,252,'OpenCode 本体【保留】',['使用其原生 ACP 入口','Farfold 不再走 HTTP / SSE 直连','','自己的 Agent 循环和原生会话','本机已有 / 按需安装'],'external')
d.box(810,844,325,100,'Codex ACP 适配器【接入】',['将 ACP 转为 Codex App Server'],'change')
d.arrow(973,951,973,979)
d.box(810,988,325,108,'Codex 本体【保留】',['自己的 Agent 循环和原生会话','本机已有 / 按需安装'],'external')
# Configuration is a side path, not an ACP model gateway.
d.p.append('<path d="M1148 425H1195V1050H1159" fill="none" stroke="#617680" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arr)"/>')
d.p.append('<text x="1217" y="710" class="tiny" text-anchor="middle" transform="rotate(90 1217 710)">配置侧路：按各 Agent 官方方式应用，不由 ACP 自动共享</text>')
for c in [217,595,973]:d.arrow(c,1124,c,1190)
d.box(45,1199,1100,92,'模型服务 / Provider',['实际模型请求由 Agent 发出，Farfold 的 ACP 客户端不代替 Agent 调模型'],'external')
d.text(45,1332,'Agent 接入侧优先复用现有实现，不修改 Agent 本体；本机发现不等于接管已打开的终端。','s')
d.text(45,1362,'图中适配器为候选接入方式；具体版本、功能覆盖和旧会话恢复规则属于设计待确认项。','s')
architecture=d.done('farfold-acp-proposed-architecture.svg')

rows=[
('保留','自有工作台与合理的专属交互','共用界面继续用；把事件来源改接公共接口，不要求把所有专属组件合成一个。'),
('保留并完善','公共 Host 与数据身份','沿用项目、安装/连接、原生 Session 绑定、任务准入、草稿和诊断；适配新连接形态。'),
('新增','公共 ACP 客户端','基于现有 SDK 做一套握手、请求、事件、能力和交互处理；同时接入 Farfold 的文件/终端等必要客户端回调。'),
('新增 / 复用','Agent 注册与 ACP 接入定义','每个 Agent 声明启动命令、依赖、适配器和配置差异；优先使用已有 ACP 适配器，原生 ACP 直接接。'),
('替换','三条原生工作通信路径','Pi RPC、OpenCode HTTP/SSE、Codex App Server 的 Farfold 直连实现由 ACP 路径替代；原生协议可以继续存在于外部适配器内部。'),
('扩展','本机发现与按需安装管理','把两种安装来源接入同一套流程；补安装/依赖检查、更新、失败恢复与所有权。不是 ACP 协议自动提供的。'),
('单独建设','Provider 一次配置、多 Agent 复用','公共存储与配置入口，加各 Agent 官方配置映射；模型与认证兼容性仍按 Agent 判断。'),
('迁移后移除','被替代的旧实现与随包下载构建路径','删除重复原生通信、相应旧控制路径，以及 Pi/OpenCode 随主包分发的构建配置；保留仍需的原生配置/认证代码。用户数据不在删除范围。'),
]
table=''.join(f'<tr><td><b>{escape(a)}</b></td><td>{escape(b)}</td><td>{escape(c)}</td></tr>' for a,b,c in rows)
html='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Farfold · 统一 ACP 架构对照</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f6f9fa;color:#243b43;font:17px/1.75 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}main{max-width:1400px;margin:auto;padding:38px 28px 70px}h1{font-size:36px;line-height:1.3;margin:13px 0}h2{font-size:25px;margin:36px 0 12px}p{max-width:1050px}.eyebrow{color:#586f78;font-size:14px}.lead{font-size:20px}.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}a{color:#22655c}button,.toolbar a{font:inherit;padding:8px 15px;border:1px solid #c8d7d9;border-radius:8px;background:white;color:#22655c;text-decoration:none;cursor:pointer}.diagram{overflow:auto;border:1px solid #ccdadd;border-radius:15px;background:#f6f9fa}.diagram svg{display:block;width:100%;height:auto;min-width:1000px}.architecture{max-width:1180px;margin:auto}.notice{background:#eaf1fe;border-left:4px solid #8aa4d3;padding:15px 20px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}.card{background:white;border:1px solid #ccdadd;border-radius:12px;padding:18px}.card b{display:block;margin-bottom:8px}table{border-collapse:collapse;width:100%;background:#fff;font-size:16px}th,td{padding:14px;text-align:left;vertical-align:top;border:1px solid #d7e1e4}th{background:#edf3f5}td:first-child{width:105px}td:nth-child(2){width:245px}details{background:#fff;border:1px solid #d7e1e4;border-radius:9px;padding:12px 17px;margin:12px 0}summary{font-weight:600;cursor:pointer}li{margin:6px 0}.muted{color:#586f78;font-size:15px}.scrolltable{overflow:auto}@media(max-width:720px){main{padding:24px 14px}h1{font-size:29px}.cards{grid-template-columns:1fr}table{min-width:750px}.lead{font-size:18px}}@media print{@page{size:A3 portrait;margin:12mm}.toolbar{display:none}main{padding:0}.diagram svg{min-width:0}.diagram{overflow:visible}h2{break-after:avoid}.diagram,.card{break-inside:avoid}details{break-inside:avoid}}
</style></head><body><main><div class="eyebrow">架构讨论稿 · 2026 年 9 月 9 日 · 先设计清楚，再进入开发</div><h1>如果 Farfold 统一使用 ACP，会改变什么？</h1><p class="lead"><b>工作台继续由 Farfold 自己做；与 Agent 通信改为共用一套 ACP 客户端。</b><br>Agent 原生支持 ACP 就直接接入；不支持的，通过现有适配器转换。</p><p class="muted">ACP 指 Agent Client Protocol。统一的是通信入口与共同交互处理，不是把不同 Agent 变成同一个 Agent，也不是重新发明一个协议。</p><nav class="toolbar"><a href="#compare">当前与候选对照</a><a href="#target">完整候选架构</a><a href="#changes">新增、保留与移除</a><button onclick="window.print()">打印 / 保存 PDF</button></nav>
<h2 id="compare">1 · 先看核心差别</h2><div class="diagram" id="comparison">'''+comparison+'''</div><p class="notice">改变的是“谁负责适配”：当前由 Farfold 直接处理三种原生协议；候选方案让 Farfold 处理 ACP，原生差异由 Agent 自己或 ACP 适配器承接。适配工作减少并可复用，但没有凭空消失。</p>
<h2 id="target">2 · 放回整个产品，架构是这样</h2><p>下面是逻辑职责图，不是说每个方框都要单独做成一个服务。安装、Provider 与公共会话管理仍属于 Farfold 的 Host 中间层。</p><div class="diagram architecture" id="architecture">'''+architecture+'''</div><div class="toolbar"><a href="architecture-assets/farfold-acp-before-after.svg" download>下载对照图 SVG</a><a href="architecture-assets/farfold-acp-proposed-architecture.svg" download>下载完整架构 SVG</a></div>
<h2 id="changes">3 · 相比当前，新增、保留和移除什么</h2><div class="scrolltable"><table><thead><tr><th>变化</th><th>部分</th><th>实际意味着什么</th></tr></thead><tbody>'''+table+'''</tbody></table><p class="muted">“移除”指未来完成迁移后清理被替代代码，不是现在删除。旧会话和用户配置需要先明确兼容、保留与恢复规则。当前产品代码没有改动。</p>
<h2>4 · 这条路线带来的工作，分清三类</h2><div class="cards"><div class="card"><b>因为采用 ACP 要做的</b>公共 ACP 客户端、UI 事件与交互映射、Agent 启动定义、适配器接入、能力与扩展处理、旧会话衔接设计。</div><div class="card"><b>无论是否采用 ACP 都要做的</b>本机发现、按需安装、版本与依赖、升级处理、身份绑定、错误定位、退出与恢复。</div><div class="card"><b>来自产品目标、需另外做的</b>Provider 配置复用、已有账号与历史复用边界，以及各 Agent 专属交互的产品呈现。</div></div>
<h2>5 · 在进入开发前，继续把这些位置画清楚</h2><details open><summary>公共客户端和 Agent 专属适配，边界在哪里？</summary><p>公共客户端统一 ACP 消息和常见交互；Agent 接入定义保留启动、配置、版本和扩展差异。协议转换优先交给已有适配器。若必需能力没有标准接口或可用扩展，先明确取舍，不默认另加一条原生控制通道。</p></details><details open><summary>用户已有安装，如何连接与升级？</summary><p>找到并记住程序 → 检查版本、依赖和适配器 → 用户选用时启动 ACP 入口 → 握手并读取能力 → 完成认证 → 创建或恢复会话。握手成功不等于模型账号可用。升级自己的托管安装与升级用户本机安装分开处理；原有安装的代升级范围尚待确定。</p></details><details open><summary>原有会话和特色能力，迁移后如何保留？</summary><p>会话始终绑定 Agent 安装/连接和原生 Session。适配器是否能恢复现有 Session、原生特色如何通过 ACP 暴露与展示，需要在设计中列清。不能把更换通信接口说成历史和功能自动完整迁移。</p></details><details><summary>当前事实与候选接口的依据</summary><p>本地源码：src/App.tsx 的三个工作台组件；src-tauri/src/runtime_supervisor.rs 的公共生命周期边界；pi_runtime.rs 的 RPC 启动；opencode_runtime.rs 的服务接入；codex_runtime.rs 的 App Server 通信与共享事件。以上描述当前实现，不代表候选方案已交付。</p><ul><li><a href="https://zed.dev/docs/ai/external-agents">Zed 外部 Agent：ACP 接入与配置边界</a></li><li><a href="https://opencode.ai/docs/acp/">OpenCode 官方 ACP 入口</a></li><li><a href="https://github.com/agentclientprotocol/codex-acp">Codex ACP 适配器：连接 App Server</a></li><li><a href="https://github.com/svkozak/pi-acp">Pi 社区 ACP 适配器</a></li></ul><p>这是接口形式的依据，不是已经确认当前 Farfold 固定版本与所选适配器完全兼容。适配器版本与维护方选择尚未定案。</p></details><p class="muted">本稿仅为候选架构设计，不替代活动开发计划；不展开跨 Agent 协作、LifeModel 或商业计划书。</p></main></body></html>'''
(ROOT/'Farfold-统一ACP架构对照与设计.html').write_text(html)
print(ROOT/'Farfold-统一ACP架构对照与设计.html')
