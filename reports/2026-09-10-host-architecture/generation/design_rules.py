# -*- coding: utf-8 -*-
from html import escape as E
from pathlib import Path

def build():
    historical=[
      ('早期 Agent 普查','../../research/2026-08-30/runtime-census-and-contract.md','17 个深度候选及当时 Registry 快照；包含固定版本与 D0–D3 证据分层。历史产品状态已过时，不作为今日支持清单。'),
      ('历史隔离验证','../../research/2026-08-31/d2-minimal-lifemodel-native-acceptance.md','可追溯早期 OpenCode、Codex、Kimi 的隔离验证。仅借用原生基础接口证据，不恢复 LifeModel 研究或额外 Runtime 开发。'),
      ('12 家工作台对照','../2026-09-09-alignment/Farfold-同类Agent工作台技术路线对照.md','比较 Host 的 ACP、混合接口、终端三种路线；回答同行怎么做，不是各 Agent 的现行兼容证明。'),
      ('公共职责清单','../2026-09-09-alignment/Farfold-公共架构职责覆盖清单.md','ACP / Host / 前端边界；本报告扩充其正常和失败流程。'),
    ]
    agent_rows=[
      ('OpenCode','官方原生 ACP；可以选定程序路径以 ACP 模式启动','文档支持工具、权限和原生配置；明确部分内置 undo/redo 命令不支持','本机程序复用有明确文档路径；固定 1.15.13 的 ACP service 源码存在取消不支持路径，必须解决；旧 HTTP/SSE 验收不替代 ACP 验收','https://opencode.ai/docs/acp/'),
      ('Codex','新维护位置 agentclientprotocol/codex-acp；适配器启动 App Server，允许指定 Codex 程序','默认 npm 包依赖一份 Codex；可以用 CODEX_PATH 指定现有程序。main 清单为适配器 1.11.0 / Codex ^0.153.4','当前 Farfold 固定 0.143.0；未证明兼容新适配器。选发布版与对应 Codex 组合，不能直接接 latest 后称为已验证','https://github.com/agentclientprotocol/codex-acp'),
      ('Pi','Registry 为 svkozak/pi-acp，固定条目 pi-acp@0.0.33；启动本机 Pi RPC，可指定程序路径','此包不嵌入 Pi SDK；README 要求已装 Pi 0.80.4+。extension select/confirm 有映射，input/editor 不支持并取消；模型选择调用 Pi RPC','已找到符合本机复用方向的候选；与固定 Pi 0.84.3 的完整行为仍未实测。无 ACP 文件/终端委托，传入 MCP 不接入 Pi；不得承诺原生交互完整保留；发布包还缺少原生 steer / follow_up 消息路径','https://github.com/agentclientprotocol/registry/blob/main/pi-acp/agent.json'),
    ]
    pi_evidence='<p>Pi 补查依据：<a href="https://github.com/agentclientprotocol/registry/blob/main/pi-acp/agent.json">Registry</a>、<a href="https://github.com/svkozak/pi-acp/blob/main/src/pi-rpc/process.ts#L118">启动源码</a>、<a href="https://github.com/svkozak/pi-acp/blob/main/src/acp/session.ts">取消与交互映射</a>、<a href="https://github.com/svkozak/pi-acp/blob/main/README.md">公开限制</a>。停止映射为原生 abort，完成依赖 agent_settled；模型目录来自原生 get_available_models。Registry 只装适配器，Pi 本体仍需已有或另行按需安装。README 与 package 的 Node 最低要求有差异，需固定运行环境。补查已只读校验 pi-acp@0.0.33 发布包的 npm integrity；六个关键 sourcemap 文件与本轮 main 对应内容一致。运行中 prompt 排队不等于原生 steer / follow_up；load 会关闭该连接其他 Pi 子进程。详见三路能力与流程。</p>'
    old_candidates='Kimi、Kiro、Cline、Cursor、Mistral Vibe、goose、Gemini、Qwen 在旧报告中有 ACP 或 Registry 入口线索；Hermes、Factory Droid、Copilot SDK、Claude Agent SDK、Amp、OpenHands 则涉及不同官方接口或包装方式。旧报告另含 Pi、OpenCode、Codex。此处只恢复旧目录，不把所有名字标成今日 ACP 兼容，也不把它们加入下一轮开发范围。'
    rules=[
      ('01 · 安装来源','Host 先列出已知位置和用户选定路径的安装；显示版本和来源；缺失时提供按需安装。复用程序和复用账号分别记录。','找不到则允许指定路径；多版本保留明确选择；不扫描读取任意账号数据。只启动选定的入口。','已对齐：本机优先 + 按需安装，主包不带 Agent。'),
      ('02 · 固定接入组合','每个安装引用明确的 Agent、适配器与依赖版本；握手确认协议和能力。','未知版本显示未验证；明确缺少必要接口则阻止开始并说明升级 / 更换选定版本路径；不偷偷走原生旁路。','待事实核查：三路的确切支持组合。'),
      ('03 · 启动与清理','Host 持有自己启动的进程，设置项目、配置目录和生命周期；ACP 成功握手后进入可工作状态。','启动超时先确认并清理本次拥有的失败进程；保留诊断。不能按程序名杀其他工具启动的进程。','建议规则；未进入实现。'),
      ('04 · 添加共享连接','一次保存端点、协议、地区 / 套餐、凭据引用与模型映射；逐 Agent 生成受管理配置。','保存、应用、需要重启、请求验证分别显示；任一路失败不显示全部成功，失败路不影响其他已生效路。','已对齐体验；具体配置接口按接入包确定。'),
      ('05 · 配置归属','Farfold 管理自己的共享连接与投影；既有原生账号可作为独立连接保留。导入已有连接须说明范围，之后一个字段只有一个写入来源。','检测到用户外部修改受管理字段时暂停覆盖，显示两份差异供选择；未管理字段保留，不双向无限同步。','建议默认；是否同步外部全局配置未获决定，默认不做。'),
      ('06 · 选择与生效','全局默认只影响新任务；会话选定的连接与模型保留。任务开始绑定生效配置版本。','任务中改设置进入待应用，不能悄悄更换当前模型或账号。原生进程配置无法隔离时，分连接运行或禁用并行切换。','作用域需按 Agent 核实；用户无需重复输入密钥。'),
      ('07 · 模型目录','品牌层归组，服务地区 / 套餐和账号连接分开；真实模型 ID、接口和能力作为底层记录。','同名不自动删；只归并有等价依据的条目。无映射时显示来源；禁止把国际站 key 自动投到另一端点。','建议规则；用户报告的 GLM 重复尚未运行复现。'),
      ('08 · 凭据维护','轮换共享连接凭据后逐目标应用；保留每一路的生效版本；原生登录按原生生命周期维护。','失效、限额、网络故障分开显示。日志、导出和错误不带密钥；移除连接不等于注销供应商账号。','实施时列精确配置保留与删除清单。'),
      ('09 · 创建与发送','选项目 / 工作副本、Agent 安装和连接，创建原生会话并保存身份后发送。共用准入限制和同工作副本互斥。','创建失败保留草稿；发送后断线且接受情况未知时不自动重发。先检查原生状态，避免同任务重复修改文件。','沿用当前最多两条活动任务的约束；未提出扩大并发。'),
      ('10 · 运行状态','统一显示：启动中、就绪、执行中、等待用户、取消中、已结束、失败或状态待确认；保留原生原因。','未知不是失败也不是已完成；新一代连接不能接受旧一代响应改变当前任务状态。','用户用语为设计稿，不新增第二个 Agent 决策循环。'),
      ('11 · 权限与提问','Agent 发起，Host 绑定到会话 / 任务 / 请求，前端显示原生选项，经 ACP 回答。','取消、退出或请求失效后旧按钮失效；不自动批准、不用普通聊天冒充原生提问。原生不提供的能力如实缺省。','必要能力由现有已接受行为表决定。'),
      ('12 · 取消与中断','用户停止后显示取消中，直到原生终态或可核实退出；记录已发生的文件变化。','超时显示状态待确认，可提供结束自有进程的明确操作；取消不等于撤销磁盘修改。','建议规则；不同 Agent 的完成信号需对应。'),
      ('13 · 事件与恢复','公共通道保留顺序、来源与连接代次；有界输出，断线后用真实快照和原生记录恢复显示。','发现缺口就标明并补读支持内容；不编造遗漏工具输出，不把持久化失败报成保存成功。','保留现有事件可靠性基础；替换原生解析。'),
      ('14 · 产物审阅','工具卡片展示 Agent 上报，文件面板展示真实工作区差异并注明比较基线；只读预览与已审阅分开。','非 Git、未跟踪、大文件、二进制、冲突与外部编辑分别处理；未知归因不标成全部由 Agent 修改。','建议首轮只读预览 / diff；编辑、提交、撤销另行决定。'),
      ('15 · 本机回调','按协商能力承接 ACP 文件与终端请求；校验路径和拥有关系，结束时释放自己创建的资源。','不支持则不宣告支持；输出截断保留提示；不能把 Host 观察或回调冒充对原生工具的完整沙箱。','依据所选适配器实际请求决定必做回调。'),
      ('16 · 新会话续接','新架构产生的会话保存安装、项目、连接与原生会话引用；重启后重新发现并续接。','认证过期先恢复连接；版本或目录变化先解释原因。打不开不悄悄新建空白会话。','必须保留日常恢复能力；不要求迁移旧开发记录。'),
      ('17 · 窗口与退出','建议应用内 Host；关闭窗口保留应用时可继续，完整退出先处理正在执行任务。','强退 / 崩溃 / 休眠后按未知状态恢复；不承诺完整退出后后台继续，不因此引入另一套控制中心。','关闭窗口是否默认后台继续仍为产品选择。'),
      ('18 · 更新与安装失败','安装内容先暂存校验，再启用选定版本；Agent / 适配器更新与主应用更新分别管理。','失败保留当前可用安装，升级不影响活动进程；用户自行升级后重新校验。应用更新保护重要配置与新产生的数据。','不自动升级用户全局程序；更新建议不是本轮执行。'),
      ('19 · 开发旧数据','本次切换不迁移开发旧会话；先列重要 Provider、端点、模型和必要设置，保留后验证可读取与可用性。','删除范围限制在明确的 Farfold 开发记录；不连带删除项目文件、独立原生历史或其他工具配置。','已对齐方向；本轮没有执行清理。'),
    ]
    def table(head,rows):return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+E(v)+'</th>' for v in head)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+E(v)+'</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table></div>'
    links='<ul>'+''.join('<li><a href="'+p+'">'+E(n)+'</a>：'+E(d)+'</li>' for n,p,d in historical)+'</ul>'
    agent_html='<div class="scroll"><table><tr><th>本轮对象</th><th>ACP 路径</th><th>已知事实</th><th>对 Farfold 的判断</th></tr>'+''.join('<tr><td><a href="'+u+'">'+E(n)+'</a></td>'+''.join('<td>'+E(v)+'</td>' for v in [a,b,c])+'</tr>' for n,a,b,c,u in agent_rows)+'</table></div>'
    intro='<div class="notice"><b>同一条工作链路保持不变：</b>工作台 → Host → 公共 ACP → 原生 ACP 入口或适配器 → Agent。按需安装与本机安装只是执行来源。以下是设计补全，未安装候选、未运行模型请求、未修改应用代码。</div>'
    criteria='<p><b>后续验证的完成标准：</b>一次录入后每个兼容 Agent 确认实际连接与模型；断线不重复执行；待答请求不串会话；取消结果可确认；文件差异来源清楚；同一安装应用冷启动后恢复新会话；升级和清理不丢重要配置。这里列的是未来验证要求，不是已经通过的结果。</p>'
    html='<h2 id="rules">6B · 找回既有调研，并补齐正常 / 失败规则</h2>'+intro+'<h3>找到的原始产出</h3>'+links+'<p>'+E(old_candidates)+'</p><h3>只对当前三路补查 ACP 路径</h3>'+agent_html+pi_evidence+'<p class="muted">上游动态 main 文档 / 清单不是已发布固定版本的兼容保证。旧报告中的“产品仍为 Pi-only”已过时；历史多接口验证也不是三路 ACP 验证。</p><h3>19 条具体设计规则</h3>'+table(['流程','正常路径','失败 / 冲突处理','状态与边界'],rules)+criteria
    md=['# Farfold 接入研究索引与设计规则补全','2026-09-10 · 设计研究；不进入开发','统一 ACP 链路保持不变。开发旧会话不迁移，只保留重要配置；新会话保存恢复必须正常。','## 找到的已有材料']
    md+=['- ['+n+']('+p+')：'+d for n,p,d in historical]
    md+=['## 旧候选范围',old_candidates,'## 当前三路的 ACP 补查']
    for n,a,b,c,u in agent_rows:md+=['### '+n,'['+a+']('+u+')。'+b+'。'+c+'。']
    md+=['Pi 详细源码：[启动](https://github.com/svkozak/pi-acp/blob/main/src/pi-rpc/process.ts#L118)、[交互与取消](https://github.com/svkozak/pi-acp/blob/main/src/acp/session.ts)、[限制](https://github.com/svkozak/pi-acp/blob/main/README.md)。Registry 包安装不包含安装 Pi 本体，已核验发布包 integrity 及六个关键文件；运行行为尚未实测。详见本报告三路能力与状态补充。']
    md+=['## 正常与失败规则','\n'.join(['| 流程 | 正常路径 | 失败 / 冲突 | 状态 |','| --- | --- | --- | --- |']+['| '+' | '.join(r)+' |' for r in rules]),'## 未来验证要求','一次录入后逐路确认实际连接与模型；断线不重发任务；权限请求不串会话；取消结果可确认；差异有基线与来源；安装应用冷启动恢复新会话；升级和清理保住配置。本轮没有运行这些验收。']
    return html,'\n\n'.join(md)
