"""Create a privacy-reviewed UI publication without changing original evidence.

Does not run historical validation/business scripts. Input inventory and OCR were
reviewed separately; only controlled fixture screenshots/AX are copied as bytes.
"""
from pathlib import Path
import hashlib, html, json, os, re, shutil
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'docs/evidence/2026-10-08-ui-coverage-audit'
DEST = SOURCE / 'publication'
MAINT = ROOT / 'docs/maintenance/2026-10-24-evidence-preservation'
originals = sorted(p for p in SOURCE.rglob('*') if p.is_file() and DEST not in p.parents)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
source_hashes = {str(p.relative_to(SOURCE)): sha(p) for p in originals}
reports = [p for p in originals if p.suffix == '.md']
controlled = [p for p in originals if 'full-review/controlled-views/screenshots/' in str(p.relative_to(SOURCE)) and p.suffix in ('.jpg', '.txt')]
reproduction = [SOURCE/'full-review/controlled-views/state-export.test.tsx', SOURCE/'full-review/controlled-views/state-export.config.ts']
selected = reports + controlled + reproduction
mapping = {p.resolve(): DEST / ('reports' if p in reports else 'controlled' if p in controlled else 'reproduction') / p.relative_to(SOURCE) for p in selected}
rows = []
for n,p in enumerate(originals,1):
 rel = str(p.relative_to(SOURCE)); dst=mapping.get(p.resolve())
 rows.append({'id': f'file-{n:03d}', 'source':rel,'bytes':p.stat().st_size,'sourceSha256':source_hashes[rel], 'decision':'publish-sanitized-report' if p in reports else 'publish-byte-identical-controlled-fixture' if p in controlled else 'publish-byte-identical-reproduction-source' if p in reproduction else 'local-only', 'published':str(dst.relative_to(DEST)) if dst else None, 'reason': '报告保留结论与边界；路径/本机生成标识脱敏、重写导航，末尾换行统一为一个LF' if p in reports else '合成受控组件；无真实账号/历史；OCR/AX及元数据复核' if p in controlled else '测试侧导出源码，仅供追溯，未执行' if p in reproduction else '实拍/标注/预览、原始AX/动作/中间数据或旧生成程序；含/可能关联私人历史、本机路径和会话上下文，保留本地原件，不新增公开'})
by_source = {str((SOURCE/r['source']).resolve()):r for r in rows}
extra = {}
def nav(target, src, dst):
 target=target.strip().strip('<>')
 if target.startswith(('https://','http://','mailto:','#','data:')): return target
 raw = unquote(target).split('#')[0]
 if raw.startswith('/Users/'):
  match=re.search(r'/farfold/(.*)',raw)
  raw=str(ROOT/match.group(1)) if match else raw
 raw=re.sub(r':\d+$','',raw)
 resolved=(Path(raw) if raw.startswith('/') else src.parent/raw).resolve()
 if resolved in mapping:return os.path.relpath(mapping[resolved],dst.parent)
 row=by_source.get(str(resolved))
 if row:return os.path.relpath(DEST/'file-inventory.html',dst.parent)+'#'+row['id']
 # External original dependencies remain descriptive, with no active file URL.
 safe = str(resolved.relative_to(ROOT)) if resolved.is_relative_to(ROOT) else '[local-source]'
 key=hashlib.sha256(safe.encode()).hexdigest()[:16]
 extra[key]={'id':'external-'+key,'source':safe,'existsAtPublication':resolved.exists(),'decision':'not-copied','reason':'历史报告外部依赖或当时缺失产物；不复制、不视为本批验收；仓库原路径可供定位'}
 return os.path.relpath(DEST/'file-inventory.html',dst.parent)+'#external-'+key
for p,dst in mapping.items():
 dst.parent.mkdir(parents=True,exist_ok=True)
 if p not in reports:shutil.copyfile(p,dst);continue
 s=p.read_text()
 def rewrite_link(match):
  label=match[1]; target=nav(match[2],p,dst)
  if label.startswith('![') and not target.split('#')[0].lower().endswith(('.jpg','.png','.jpeg','.gif','.webp','.svg')):
   label=label[1:-1]+'（原图仅本地保留）]'
  return label+'('+target+')'
 s=re.sub(r'(!?\[[^\]\n]*\])\(([^)\n]+)\)',rewrite_link,s)
 # Local author identity and unneeded generated-image job IDs are not published.
 s=re.sub(r'/Users/[^/\s`<>]+/Desktop/farfold', '[repository]',s)
 s=re.sub(r'/Users/[^/\s`<>]+/[^\s`]*','[local-path]',s)
 s=re.sub(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b','[local-generation-id]',s)
 s='> 2026-10-24 隐私发布副本。历史结论及已测/失败/未测边界保留；本机路径和生成标识已脱敏，末尾换行统一为一个LF。实拍图、原始AX及中间数据仅本地保留，相关链接通向公开哈希清单，不表示原图已发布。\n\n'+s
 dst.write_text(s.rstrip('\r\n')+'\n')
for r in rows:
 if r['published']:r['publishedSha256']=sha(DEST/r['published'])
manifest={'schema':1,'sourceDate':'2026-10-08','publicationDate':'2026-10-24','scope':'privacy-reviewed preservation, no new product acceptance','sourceFileCount':len(rows),'sourceInventoryMerkleSha256':hashlib.sha256(json.dumps(source_hashes,sort_keys=True).encode()).hexdigest(),'files':rows,'externalDependencies':list(extra.values()),'privacy':{'textFilesScanned':187,'imagesOcrScanned':137,'ocrErrors':0,'rawOcrCommitted':False,'originalsRewritten':False,'imagesEdited':False,'publishedControlledImages':34,'withheldImages':103,'limitations':'OCR可能漏字；实拍及派生图全部保守留本地，未依赖阴性OCR结果放行。仅受控合成图与AX入库；未重新运行历史业务/验证脚本。'}}
(DEST/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
css='body{font:16px/1.6 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#24242a}a{color:#4132a2}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}figure{margin:0;padding:12px;border:1px solid #ddd}img{width:100%;height:auto}small{color:#666}'
head=lambda title:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html.escape(title)+'</title><style>'+css+'</style><body>'
page=head('UI证据原件与发布清单')+'<h1>原件与隐私发布清单</h1><p><a href="index.html">返回发布入口</a> · <a href="manifest.json">完整哈希清单</a>。local-only原件未复制、未改写，继续本地保留；本页没有其私人内容。缺少原图时不能只凭文字重新进行视觉验收。</p><table><tr><th>原件</th><th>保留决定</th><th>SHA-256与说明</th></tr>'
for r in rows:
 page+='<tr id="'+r['id']+'"><td>'+html.escape(r['source'])+'</td><td>'+html.escape(r['decision'])+(('<br><a href="'+r['published']+'">发布副本</a>') if r['published'] else '')+'</td><td><code>'+r['sourceSha256']+'</code><br>'+html.escape(r['reason'])+'</td></tr>'
page+='</table><h2>历史外部依赖</h2><table>'
for r in extra.values():page+='<tr id="'+r['id']+'"><td>'+html.escape(r['source'])+'</td><td>'+html.escape(r['reason'])+'；发布时存在：'+str(r['existsAtPublication'])+'</td></tr>'
(DEST/'file-inventory.html').write_text(page+'</table></body></html>')
page=head('Farfold UI隐私发布版')+'<h1>UI/UX复核：隐私发布版</h1><p>2026-10-08历史材料，2026-10-24整理入库。原324文件保持本地原件；本次不重新执行历史测试，不升级其功能验收结论。</p><p><a href="README.md">范围说明</a> · <a href="file-inventory.html">全部原件、排除理由与哈希</a> · <a href="manifest.json">机器清单</a></p><h2>报告</h2><ul>'
for p in reports:page+='<li><a href="'+str(mapping[p.resolve()].relative_to(DEST))+'">'+html.escape(str(p.relative_to(SOURCE)))+'</a></li>'
page+='</ul><h2>受控组件图（34张）</h2><p>合成数据、无真实Agent调用，仅证明当时组件呈现；不属于正式安装或真实工作验收。图片与原件字节相同，未打码、未重绘。</p><div class="gallery">'
for p in controlled:
 if p.suffix!='.jpg':continue
 dst=mapping[p.resolve()]; ax=p.with_suffix('.ax.txt')
 page+='<figure><a href="'+str(dst.relative_to(DEST))+'"><img loading="lazy" src="'+str(dst.relative_to(DEST))+'" alt="'+html.escape(p.stem)+'"></a><figcaption>'+html.escape(p.stem)+' · <a href="'+str(mapping[ax.resolve()].relative_to(DEST))+'">合成AX</a></figcaption></figure>'
page+='</div><h2>实拍与标注图</h2><p>103张实拍、标注和画册预览未入库：其界面包含或可能关联真实历史对话、本机路径或私人上下文。原件全部留在本地；报告保留当时的成功、失败、未知和覆盖边界。需核原图时使用原件清单定位，不能把未发布图当作公开可复核图。</p></body></html>'
(DEST/'index.html').write_text(page)
(DEST/'README.md').write_text('''# UI/UX材料隐私发布版

2026-10-24整理；材料观察日期为2026-10-08。此前两份README的“6张只是重点摘选”和“特定Codex禁用观察不能泛化”修正继续成立；这里保留其对应完整文字报告、覆盖限制及可公开的受控组件材料。

- [离线发布入口](index.html)
- [原14张逐项复核与31张补查报告（隐私副本）](reports/README.md)
- [完整走查与成功、受阻、未测边界](reports/full-review/README.md)
- [134张画册的原总结（隐私副本）](reports/full-review/all-pages/README.md)
- [324个原件及发布/排除决定](file-inventory.html) · [SHA-256机器清单](manifest.json)

16份文字报告处理私人本机路径、无须发布的生成任务标识和链接导航，并将文件末尾换行统一为一个LF，不降低历史问题或验收条件；34张合成受控截图及34份对应AX逐字节保存，另保留2份测试侧导出源码。原始HTML/JS画册和中间数据不执行、不搬入此发布版。

103张实拍、AI标注及预览图，以及其他原始AX、动作/中间数据等继续本地保留。实拍包含或可能关联私人历史对话标题、历史导入内容及本机路径；报告图链接会进入哈希/排除说明，不能把它误认为可下载的原图。这里不对未入库的实拍做遮挡后发布，也未改写任何原件。完整原图复核仍需要本地原件，不能只凭此副本完成视觉验收。

检查覆盖：187个非图文件的格式/秘密模式及个人元数据扫描；全部137张图用系统Vision离线OCR，0个OCR调用失败；34张待发布合成图核对OCR、对应AX和图像元数据（无EXIF/附带文本元数据）。常见密钥与邮箱模式未命中；原始OCR含私人内容，仅本地保留。本次只整理证据，不启动Agent、不重跑旧业务或验证脚本、不改正式应用。
''')
print(json.dumps({'source':len(rows),'reports':len(reports),'controlled':len(controlled),'reproduction':len(reproduction),'publishedFiles':len(list(DEST.rglob('*'))),'originalHashesUnchanged':all(sha(SOURCE/k)==v for k,v in source_hashes.items())},ensure_ascii=False))
