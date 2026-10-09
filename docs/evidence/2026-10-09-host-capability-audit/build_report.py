# -*- coding: utf-8 -*-
"""Build the offline evidence report from the checked audit inputs."""
import collections
import hashlib
import html
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def read(name):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def esc(value):
    return html.escape(str(value), quote=True)


def source_link(ref):
    if ref.startswith("https://"):
        return '<a href="' + esc(ref) + '" target="_blank" rel="noreferrer">' + esc(ref) + "</a>"
    match = re.fullmatch(r"(.+?):(\d+)(?:[-–](\d+))?", ref)
    path = match[1] if match else ref
    line = match[2] if match else ""
    snapshot = meta.get("referenceSnapshots", {}).get(path)
    target = ROOT / (snapshot or path)
    if not target.is_file():
        raise ValueError("Missing evidence file: " + ref)
    if line and int(line) > len(target.read_text(encoding="utf-8").splitlines()):
        raise ValueError("Evidence line out of bounds: " + ref)
    url = target.as_uri() + ("#L" + line if line else "")
    label = ref + (" · 审计时快照" if snapshot else "")
    return '<a href="' + esc(url) + '">' + esc(label) + "</a>"


meta = read("metadata.json")
items = []
for name in ("architecture.json", "product.json", "host.json"):
    data = read(name)
    items.extend(data if isinstance(data, list) else data["items"])
ids = [item["id"] for item in items]
assert len(ids) == len(set(ids)), "duplicate item ids"
states = {
    "implemented": "源码具备",
    "partial": "部分具备",
    "missing": "明确缺失",
    "unverified": "待实证",
    "decision": "范围待定",
    "deferred": "已后置 / 不在本轮",
}
impacts = {
    "host-only": "Farfold 侧",
    "official-agent-api": "官方 Agent 接口",
    "decision": "需明确边界",
    "out-of-scope": "本轮范围外",
}
required = {"id", "domain", "capability", "status", "detail", "evidence", "runtimeImpact", "followup"}
for item in items:
    assert required <= set(item), item.get("id")
    assert item["status"] in states, item
    assert item["runtimeImpact"] in impacts, item
    assert item["evidence"], item

counts = collections.Counter(item["status"] for item in items)
domains = list(dict.fromkeys(item["domain"] for item in items))
cards = []
for item in items:
    evidence = "".join("<li>" + source_link(ref) + "</li>" for ref in item["evidence"])
    search = " ".join(str(item[key]) for key in ("id", "domain", "capability", "detail", "followup"))
    cards.append(f'''<details class="item" data-status="{esc(item['status'])}" data-domain="{esc(item['domain'])}" data-impact="{esc(item['runtimeImpact'])}" data-search="{esc(search.casefold())}">
<summary><span class="id">{esc(item['id'])}</span><span class="cap">{esc(item['capability'])}<small>{esc(item['domain'])} · {esc(impacts[item['runtimeImpact']])}</small></span><span class="badge {esc(item['status'])}">{esc(states[item['status']])}</span></summary>
<div class="body"><p>{esc(item['detail'])}</p><p><b>后续核查：</b>{esc(item['followup'])}</p><ul class="evidence">{evidence}</ul></div></details>''')

peers = read("peers.json")
peer_html = ""
# Preserve the complete authored peer record, with external URLs as links.
def render_value(value):
    if isinstance(value, dict):
        return "<dl>" + "".join("<dt>" + esc(key) + "</dt><dd>" + render_value(val) + "</dd>" for key, val in value.items()) + "</dl>"
    if isinstance(value, list):
        return "<ul>" + "".join("<li>" + render_value(val) + "</li>" for val in value) + "</ul>"
    if isinstance(value, str) and value.startswith("https://"):
        return source_link(value)
    return esc(value)
peer_html = render_value(peers)

registry = (ROOT / "src-tauri/src/acp_client/first_release.rs").read_text()
allowlist = re.findall(r'"([^"\n]+)"', registry.split("const INCLUDED:")[1].split("];", 1)[0])
assert len(allowlist) == 29 and len(set(allowlist)) == 29
catalog = (ROOT / "docs/agent-first-release.md").read_text(encoding="utf-8")
names = {}
for name, key in re.findall(r"\|\s*([^|\n]+?)\s*/\s*`([^`]+)`\s*\|", catalog):
    names[key] = name.strip()
standards = ["准备", "账号服务", "历史续用", "模型生效", "工作能力", "多任务", "停止恢复", "统一反馈"]
agent_rows = []
agent_data = []
for key in allowlist:
    label = names.get(key, key)
    agent_data.append({"id": key, "name": label, "standards": {standard: "not_revalidated_current_version" for standard in standards}})
    agent_rows.append("<tr><th>" + esc(label) + "<small>" + esc(key) + "</small></th>" + "".join('<td title="本轮未做此项逐家真实测试，旧有限证据保留原范围">待核</td>' for _ in standards) + "</tr>")
(HERE / "agent-standard-coverage.json").write_text(json.dumps({"scope":"追踪表，不是实测结果；232项没有依据本次源码盘点自动打勾。旧版本的有限成功和失败须查原证据。", "items":agent_data}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

count_html = "".join(f'<button class="stat" data-filter="{key}"><strong>{counts[key]}</strong><span>{label}</span></button>' for key, label in states.items())
option_html = "".join('<option value="' + esc(domain) + '">' + esc(domain) + "</option>" for domain in domains)
status_options = "".join(f'<option value="{key}">{label}</option>' for key, label in states.items())
impact_options = "".join(f'<option value="{key}">{label}</option>' for key, label in impacts.items())
page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Farfold · 多 Agent host 能力全域盘点</title>
<style>
:root{color-scheme:light;--ink:#20332c;--muted:#59685f;--line:#dbe4dd;--paper:#f5f7f3;--green:#236949}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:1180px;margin:auto;padding:44px 28px 90px}h1{font-size:35px;line-height:1.3;margin:10px 0 20px;letter-spacing:-1px}h2{font-size:23px;margin:0 0 18px}h3{font-size:17px}p{max-width:940px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--green)}.sub,small{color:var(--muted)}small{display:block;font-size:12px}a{color:#176440;text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}nav{display:flex;flex-wrap:wrap;gap:20px;padding:17px 0;border-block:1px solid var(--line);margin-top:28px}section{margin-top:40px;scroll-margin-top:20px}.panel{background:#fff;border:1px solid var(--line);border-radius:14px;padding:25px}.note{background:#e9f0e9;border-left:3px solid #649075;padding:14px 18px}.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:20px 0}.stat{border:1px solid var(--line);background:#fff;border-radius:10px;text-align:left;padding:15px;cursor:pointer;color:var(--ink)}.stat strong{display:block;font-size:27px}.stat span{font-size:12px}.filters{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px;margin:20px 0 12px}input,select,button{font:inherit}input,select{width:100%;min-width:0;border:1px solid #b7c8bc;border-radius:8px;background:#fff;padding:10px;color:var(--ink)}.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:15px}.actions button{background:transparent;border:1px solid #b7c8bc;padding:5px 12px;border-radius:7px;cursor:pointer}.item{background:white;border:1px solid var(--line);border-radius:10px;margin:9px 0}.item summary{display:flex;gap:15px;padding:17px 18px;align-items:center;cursor:pointer;list-style:none}.item summary:before{content:'+';font-weight:600;color:var(--green)}.item[open] summary:before{content:'−'}.id{font:12px ui-monospace,monospace;min-width:64px;color:var(--muted)}.cap{flex:1;font-weight:600}.badge{font-size:12px;white-space:nowrap;border-radius:6px;padding:3px 9px;background:#edf1ee}.partial{background:#fff0d5;color:#775116}.missing{background:#f8e2df;color:#8d382d}.unverified{background:#e4edf6;color:#355a7d}.decision{background:#eee7f6;color:#6c4d84}.deferred{background:#eee;color:#666}.implemented{background:#e6f0e6;color:#366441}.body{border-top:1px solid var(--line);padding:5px 24px 19px 58px}.evidence{font:12px/1.8 ui-monospace,monospace;padding-left:20px}.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px;vertical-align:top}td{color:var(--muted)}.grid-table td{text-align:center;white-space:nowrap}.grid-table th{min-width:170px}details.peer>summary{cursor:pointer;font-weight:600}dl{margin:0}dt{font-weight:600;font-size:13px;margin-top:13px}dd{margin-left:18px;overflow-wrap:anywhere}dd ul{padding-left:20px}footer{color:var(--muted);font-size:12px;margin-top:45px}[hidden]{display:none!important}:focus-visible{outline:3px solid #83b3d6;outline-offset:3px}@media(max-width:760px){main{padding:25px 15px}h1{font-size:28px}.stats{grid-template-columns:repeat(3,1fr)}.filters,.two{grid-template-columns:1fr}.item summary{flex-wrap:wrap;gap:8px}.id{min-width:55px}.cap{min-width:65%}.badge{margin-left:auto}.body{padding:8px 18px}.panel{padding:18px}}@media print{nav,.filters,.actions,.stats{display:none}.item{break-inside:avoid}main{max-width:none;padding:0}section{margin-top:25px}}
</style><main>
<div class="eyebrow">FARFOLD / CAPABILITY REVIEW / 2026.10.09</div>
<h1>多 Agent host 能力全域盘点</h1>
<p class="sub">当前源码、同类产品与执行边界逐项对照。共 @@COUNT@@ 个审查条目，覆盖 @@DOMAINCOUNT@@ 个分域；计数是检查范围，不是完成率。</p>
<p class="note">本次没有运行真实 Agent、登录、换号、发送模型请求或替换正式应用。源码具备、真实验证、同行声明与工程建议分别标注；不能据此宣布全部缺陷已找出或 29 家已达标。</p>
<nav><a href="#framing">比较口径</a><a href="#inventory">全部条目</a><a href="#runtime">Runtime 边界</a><a href="#worktree">工作树复杂度</a><a href="#agents">29 × 8 追踪</a><a href="#peers">同行原始核查</a></nav>
<section id="framing" class="panel"><h2>先比较同一类产品</h2><p>直接参照以支持多家外部 Agent、保留其执行循环、提供桌面会话与工作管理的产品为主。Codex、Claude Code 自家桌面只用于局部交互参考。终端看板、云执行平台、自带模型循环的产品分别分类。</p><p>本轮核查 Codeg、Harnss、Superset、Conductor 与 Vibe Kanban 的官方资料及可得源码。直接相似不代表边界相同：有的读写私有配置或正文，有的保存自己的事件账本，有的含特定程序补丁。这些做法不能直接成为 Farfold 的实现要求。详情及固定源码版本见下方同行记录。</p><p>八项接入标准保持。完整盘点不等于复制所有同行功能的并集；远程、自动化、Git管理等范围决定单列，对外分发、签名、公证、更新渠道已按用户要求后置。</p></section>
<section id="inventory"><h2>全部审查条目</h2><p>展开条目查看现状、原始源码位置与下一步。交叉领域有不同条件的条目，不能把计数加总成“缺陷数量”。“源码具备”仍需相应的真实 Agent 和平台证据。</p><div class="stats">@@STATS@@</div><div class="filters"><label>搜索<input id="query" type="search" placeholder="例如：换号、附件、停止、子任务"></label><label>状态<select id="status"><option value="">全部状态</option>@@STATUS_OPTIONS@@</select></label><label>领域<select id="domain"><option value="">全部领域</option>@@DOMAINS@@</select></label><label>执行归属<select id="impact"><option value="">全部归属</option>@@IMPACTS@@</select></label></div><div class="actions"><span id="result-count" aria-live="polite"></span><button id="expand">展开当前结果</button><button id="collapse">收起</button><button id="reset">清除筛选</button></div><div id="items">@@ITEMS@@</div></section>
<section id="runtime" class="panel"><h2>能力补齐是否会改变 Agent runtime？</h2><p>不修改第三方 Agent 或适配器源码，不重写执行循环、模型调用、压缩、停止和历史。官方操作仍会按用户意图改变会话状态、工作位置或可用工具；“不改 runtime”不等于这些操作完全不影响行为。</p><div class="table-wrap"><table><thead><tr><th>能力</th><th>允许的实现层</th><th>不能越过的边界</th></tr></thead><tbody><tr><th>预览、用量展示、通知、输入、工作树</th><td>Farfold 展示或管理自己拥有的工作环境</td><td>不宣称工作目录是安全沙箱；不迁移正在运行的原会话</td></tr><tr><th>Steer、压缩、分支、历史恢复、删除</th><td>核实并调用 Agent 官方接口</td><td>不以停止后重发伪装steer、不新建空会话伪装恢复、不自行拼接原历史</td></tr><tr><th>技能/MCP发现和配置</th><td>官方声明、接口或用户明确交接</td><td>不偷偷改私有配置；通用市场是另一个范围决定</td></tr><tr><th>网页工具</th><td>向会话提供有授权和撤回语义的host工具</td><td>增加工具会影响可用能力；不能声称所有Agent已覆盖</td></tr><tr><th>全文搜索</th><td>优先官方历史搜索或临时已加载内容</td><td>当前契约禁止建立另一份持久正文/事件账本</td></tr></tbody></table></div><p>官方接口没有提供的能力记录为不支持或待完善，不能通过补丁、私有文件解析或“假成功”填平。ACP尚未暴露，也不等于Agent本身没有：还需核官方SDK/CLI或扩展接口。</p></section>
<section id="worktree" class="panel"><h2>工作树：基础可控，完整生命周期有成本</h2><div class="table-wrap"><table><thead><tr><th>范围</th><th>复杂度判断</th><th>工作内容</th></tr></thead><tbody><tr><th>选择已有工作树</th><td>低，已有目录选择可用</td><td>识别路径和共享影响；不改变既有会话工作位置</td></tr><tr><th>创建工作树并开新对话</th><td>中等，增量可做</td><td>仓库/起点/分支校验，创建失败恢复，记录归属，正确传入工作目录</td></tr><tr><th>重启恢复与安全回收</th><td>中到高</td><td>活动进程、脏文件、未跟踪/忽略文件、未推送提交、锁、路径移动、崩溃中断、依赖与端口</td></tr><tr><th>自动合并、冲突、提交、PR</th><td>高，独立产品范围</td><td>Git工作流和外部写入责任，不能顺带加入最小工作树方案</td></tr></tbody></table></div><p>这些是工程复杂度判断，未做时间估算或原型验证。建议若纳入，只先做用户主动选择的隔离目录与可核验生命周期，暂不自动合并。工作树分离检出文件，Git配置/引用及账号、服务、端口仍可能共享。<a href="https://git-scm.com/docs/git-worktree.html">Git 官方工作树文档</a></p></section>
<section id="agents" class="panel"><h2>29 家 × 八项标准：逐家事实不能省略</h2><p>下表按当前白名单精确生成，共232个核查单元。每项“待核”表示本轮未执行同版本的逐家真实验证，不表示已测失败，也不抹去旧版本的有限成功。原始结果需结合 <a href="../../../docs/status.md">当前状态</a> 与 <a href="../../../docs/evidence/2026-10-06-macos-batch1/agent-current-summary.json">历史逐家记录</a> 阅读。</p><p>机制级源码清单不能自动替29家打勾；官方方法、版本、认证条件、模型和平台都需保持可追溯。暂不启动账号/模型实测，也不恢复旧六条旅程门槛。</p><div class="table-wrap"><table class="grid-table"><thead><tr><th>Agent</th>@@STANDARD_HEADERS@@</tr></thead><tbody>@@AGENT_ROWS@@</tbody></table></div></section>
<section id="peers" class="panel"><h2>同行核查记录</h2><p>保留分类、公开声明、源码事实、维护状态与不能照搬的差异。未安装同行或验证其可靠性，不按宣传条目数评出市场名次。</p><details class="peer"><summary>展开全部同行资料、固定源码版本与来源链接</summary>@@PEERS@@</details></section>
<footer>基线提交 @@HEAD@@ · 原能力盘点阶段仅新增证据文件，未修改产品源码、契约或活动计划。后续文档整理保留原文快照，审计中的旧文档行号指向对应快照。<br>数据文件：<a href="architecture.json">接入与执行</a> · <a href="product.json">产品能力</a> · <a href="host.json">数据、性能与工作空间</a> · <a href="peers.json">同行</a> · <a href="agent-standard-coverage.json">29家追踪</a> · <a href="validation.json">静态校验</a></footer></main>
<script>
const items=[...document.querySelectorAll('.item')], q=document.querySelector('#query'), s=document.querySelector('#status'), d=document.querySelector('#domain'), p=document.querySelector('#impact');
function filter(){const query=q.value.toLocaleLowerCase().trim();let n=0;for(const item of items){const show=(!query||item.dataset.search.includes(query))&&(!s.value||item.dataset.status===s.value)&&(!d.value||item.dataset.domain===d.value)&&(!p.value||item.dataset.impact===p.value);item.hidden=!show;if(show)n++;}document.querySelector('#result-count').textContent=n+' / '+items.length+' 条';}
[q,s,d,p].forEach(el=>el.addEventListener('input',filter));document.querySelectorAll('.stat').forEach(el=>el.addEventListener('click',()=>{s.value=el.dataset.filter;filter();}));document.querySelector('#expand').onclick=()=>items.filter(el=>!el.hidden).forEach(el=>el.open=true);document.querySelector('#collapse').onclick=()=>items.forEach(el=>el.open=false);document.querySelector('#reset').onclick=()=>{q.value=s.value=d.value=p.value='';filter();};filter();
</script></html>'''
replacements = {"COUNT": str(len(items)), "DOMAINCOUNT": str(len(domains)), "STATS": count_html, "STATUS_OPTIONS": status_options, "DOMAINS": option_html, "IMPACTS": impact_options, "ITEMS": "\n".join(cards), "STANDARD_HEADERS": "".join("<th>" + label + "</th>" for label in standards), "AGENT_ROWS": "\n".join(agent_rows), "PEERS": peer_html, "HEAD": esc(meta["head"][:12])}
for key, value in replacements.items():
    page = page.replace("@@" + key + "@@", value)
assert "@@" not in page
(HERE / "index.html").write_text(page, encoding="utf-8")
digest = hashlib.sha256()
file_count = 0
for folder in (ROOT / "src", ROOT / "src-tauri/src"):
    for path in sorted(folder.rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(ROOT)).encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            file_count += 1
prior_validation = read("validation.json") if (HERE / "validation.json").is_file() else {}
validation = {key: prior_validation[key] for key in ("browserPreview", "independentReview") if key in prior_validation}
validation.update({"auditItems":len(items),"domains":len(domains),"statusCounts":dict(counts),"uniqueIds":True,"sourceFilesAndLineBoundsChecked":True,"agentCount":29,"standardCells":232,"sourceFingerprint":{"files":file_count,"sha256":digest.hexdigest()},"newProductTestsRun":False,"realAgentTestsRun":False,"peerAppsInstalled":False,"scope":"Artifact schema, source links and exact allowlist only; no claim of end-to-end acceptance."})
(HERE / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(validation, ensure_ascii=False))
