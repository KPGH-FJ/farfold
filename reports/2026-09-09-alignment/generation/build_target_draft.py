from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent.parent
parts = ['''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 1210" role="img" aria-labelledby="title desc"><title id="title">Farfold 目标架构对齐草图</title><desc id="desc">共享工作台连接公共中间层，中间层包含安装管理、工作控制和 Provider 配置，各 Agent 通过差异适配与协议客户端连接，最后由 Agent 调用模型服务。</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="none" stroke="#587482" stroke-width="1.6"/></marker></defs><style>text{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#203641} .h{font-weight:650;font-size:23px}.b{font-size:17px}.s{font-size:15px;fill:#536b76}</style><rect width="1100" height="1210" fill="#f7fafb"/>''']
def box(x,y,w,h,fill='#fff',stroke='#cad8df'):
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="15" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
def txt(x,y,s,cl='b',anchor='start'):
    parts.append(f'<text x="{x}" y="{y}" class="{cl}" text-anchor="{anchor}">{escape(s)}</text>')
def arrow(x,y,x2,y2,both=False):
    parts.append(f'<path d="M{x} {y}L{x2} {y2}" fill="none" stroke="#587482" stroke-width="2" marker-end="url(#arrow)"'+(' marker-start="url(#arrow)"' if both else '')+'/>')

box(65,30,970,150,'#e8f3f0','#83b4a6')
txt(95,68,'01  Farfold 自己的工作台','h')
txt(95,105,'共用界面：项目、会话、输入框、消息展示、状态提示')
txt(95,139,'专属交互：按所选 Agent 展示权限、模式、运行中干预等原生能力')
arrow(550,185,550,225,True)
txt(570,210,'稳定的 Farfold 内部接口','s')

box(65,235,970,370,'#edf3fa','#93aeca')
txt(95,275,'02  公共中间层：把接入和日常工作做扎实','h')
cards=[(85,'安装与版本管理',['本机已有：发现、选择、登记','没有安装：工作台按需下载','检查版本、依赖和必要适配器','不兼容：明确原因与升级路径']),
       (405,'共同工作机制',['连接、启动、断开与恢复','会话绑定、草稿、任务准入','事件分发、操作状态、诊断','统一入口，保留原生操作含义']),
       (725,'Provider 配置管理',['兼容的服务尽量只配置一次','保存地址、模型和凭据引用','按各 Agent 官方方式应用','专属账号仍走各自认证'])]
for x,title,lines in cards:
    box(x,300,290,225)
    txt(x+18,336,title,'h')
    for i,l in enumerate(lines):txt(x+18,374+i*33,l,'s')
txt(95,558,'保存 Farfold 自己的项目、安装记录与会话引用；凭据采用安全存储','s')
txt(95,585,'两种安装来源进入同一套连接流程；主安装包不携带 Agent 本体','b')

centers=[230,550,870]
arrow(550,610,550,650,True)
box(65,660,970,100,'#fff7e9','#d9bd80')
txt(550,697,'03  一套公共 ACP 客户端','h','middle')
txt(550,731,'协议握手 · 能力协商 · 会话请求 · 事件与交互 · 已支持的扩展','b','middle')
for c in centers:arrow(c,765,c,798,True)
for c,name,detail in zip(centers,['Pi ACP 适配器','OpenCode 原生 ACP','Codex ACP 适配器'],['由适配器连接 Pi','Agent 自己提供 ACP 接口','由适配器连接 Codex']):
    box(c-145,808,290,90,'#fff7e9','#d9bd80')
    txt(c,843,name,'b','middle')
    txt(c,878,detail,'s','middle')
    arrow(c,902,c,918,True)
for c,name in zip(centers,['Pi 进程','OpenCode 进程','Codex 进程']):
    box(c-145,923,290,85,'#fff','#8f9fa9')
    txt(c,958,name,'h','middle')
    txt(c,985,'来自本机安装或 Farfold 按需安装','s','middle')
    arrow(c,1013,c,1065,True)
box(65,1075,970,90,'#e8f3f0','#83b4a6')
txt(550,1112,'模型服务 / Provider','h','middle')
txt(550,1143,'实际模型请求由各 Agent 发出；只对兼容的 Agent 复用配置','b','middle')
txt(550,1195,'目标统一走 ACP；优先复用现有适配器。具体版本与能力覆盖仍需迁移前验证。','s','middle')
parts.append('</svg>')
svg=''.join(parts)
(ROOT/'architecture-assets/farfold-target-draft.svg').write_text(svg)
html='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Farfold 目标架构 · 对齐草图</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7fafb;color:#203641;font:17px/1.75 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}main{max-width:1160px;margin:auto;padding:36px 28px 70px}h1{font-size:34px;line-height:1.3;margin:14px 0}h2{font-size:23px;margin:30px 0 12px}.tag{font-size:13px;letter-spacing:.08em;color:#466858}.intro{max-width:850px;color:#536b76}.toolbar{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}a,button{color:#205f54}button,.toolbar a{font:inherit;background:white;border:1px solid #c6d5d9;border-radius:8px;padding:7px 15px;text-decoration:none;cursor:pointer}.diagram{overflow:auto;border:1px solid #d4dfe5;border-radius:16px}.diagram svg{display:block;width:100%;min-width:850px;height:auto}.flow{display:flex;gap:10px;align-items:stretch;flex-wrap:wrap}.step{background:#fff;border:1px solid #d4dfe5;border-radius:10px;padding:14px;flex:1;min-width:160px}.step b{display:block;color:#205f54}.note{background:#fff7e9;border-left:4px solid #c5a160;padding:15px 20px}details{padding:12px 0;border-bottom:1px solid #d4dfe5}summary{cursor:pointer;font-weight:600}li{margin:7px 0}.muted{color:#536b76;font-size:15px}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;vertical-align:top;padding:12px;border:1px solid #d4dfe5}th{background:#edf3fa}@media(max-width:600px){main{padding:22px 14px}h1{font-size:27px}table{font-size:14px}}@media print{@page{size:A3 portrait;margin:12mm}.toolbar{display:none}main{padding:0}.diagram{overflow:visible}.diagram svg{min-width:0}h2{break-after:avoid}.flow,table,details{break-inside:avoid}}
</style><main><div class="tag">讨论稿 02 · 统一 ACP · 2026 年 9 月 9 日 · 目标设计，尚未实施</div><h1>Farfold 目标架构</h1><p class="intro">一个自己的工作台，一层扎实的公共接入机制，一套公共 ACP 客户端。用户优先复用本机 Agent，也可以在工作台中按需安装；保留各 Agent 的原生能力。</p><div class="toolbar"><a href="architecture-assets/farfold-target-draft.svg" download>下载架构图 SVG</a><button onclick="window.print()">打印 / 保存 PDF</button><a href="#connection">看一次连接怎么完成</a></div><div class="diagram">'''+svg+'''</div>
<h2 id="connection">一次连接：用本机 OpenCode 举例</h2><div class="flow"><div class="step"><b>1 · 找到安装</b>找到本机程序；没有则按需安装。多个候选时选择并记住。</div><div class="step"><b>2 · 检查适配</b>检查版本、依赖与接口支持。缺少适配器或需要升级时给出处理入口。</div><div class="step"><b>3 · 启动并接通</b>选择工作时启动原生 ACP 模式或适配器，完成 ACP 握手，建立命令与事件连接。</div><div class="step"><b>4 · 开始工作</b>确认模型服务可用，创建或恢复会话；工作台收发消息和原生交互。</div></div><p class="muted">自动发现不等于同时启动所有 Agent；接入本机安装通常是用这份程序启动新进程，不是接管用户已经打开的终端。</p>
<h2>当前与目标，分开看</h2><table><tr><th>部分</th><th>当前基础</th><th>本次目标</th></tr><tr><td>工作台</td><td>一个前端，三个专属工作台组件，共享部分界面和 Host 机制。</td><td>继续共享公共部分，保留合理的原生差异；不以消除专属组件为目标。</td></tr><tr><td>通信路径</td><td>Pi RPC、OpenCode HTTP/SSE、Codex App Server。</td><td>统一由公共 ACP 客户端接入原生 ACP 或 ACP 适配器；不代表迁移已完成。</td></tr><tr><td>安装来源</td><td>Pi / OpenCode 随包；Codex 复用选定的本机安装。</td><td>主包不带 Agent 本体。统一支持本机复用与工作台按需安装。</td></tr><tr><td>Provider</td><td>配置与认证路径按 Runtime 分开。</td><td>兼容的 Provider 尽量一次配置、多个 Agent 复用。</td></tr><tr><td>公共中间层</td><td>已有生命周期、会话绑定、准入和事件通道；仍有专属控制路径。</td><td>按实际问题收敛公共机制，补齐安装来源、版本适配和配置复用。</td></tr></table>
<h2>看图时，优先对齐这三处</h2><details open><summary>已有登录、配置和历史，要复用到什么程度？</summary><p>复用程序不等于复用账号或历史。目标是减少重复操作，同时明确选择范围、不覆盖原有设置。具体边界仍需逐项确认。</p></details><details open><summary>版本不兼容，怎样处理？</summary><p>能通过升级解决的，提供升级到兼容版本的路径。Farfold 管理自己的安装；用户原有安装可提示自行升级，是否提供代升级及其范围仍待确认。</p></details><details open><summary>哪些共用，哪些保留？</summary><p>通用流程与 ACP 客户端共用；按 Agent 保留启动、配置与展示差异。优先复用现有 ACP 适配器，原生支持 ACP 的 Agent 直接接入。每个 Agent 的实际能力仍需验证，不保证任意版本、任意 Provider 都兼容。</p></details>
<p class="note">Agent 继续拥有推理循环、工具与权限行为、原生会话和工作记忆。Farfold 中间层负责接入和产品公共机制，不另建 Agent 执行循环。本图聚焦本轮基础架构，暂不展开跨 Agent 协作与 LifeModel。</p><p class="muted">依据：本轮对话共识与本次已核查源码。安装管理、Provider 复用等均为目标设计。原报告和旧架构图是此前快照；本稿用于继续对齐，不替代活动开发计划。</p></main></html>'''
(ROOT/'Farfold-目标架构对齐草图.html').write_text(html)
print(ROOT/'Farfold-目标架构对齐草图.html')
