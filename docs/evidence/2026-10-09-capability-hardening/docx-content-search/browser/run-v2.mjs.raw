import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const { webkit, chromium } = await import('/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const base = 'output/2026-10-14-docx-search-browser';
const independent = 'output/2026-10-14-docx-search-independent';
const engine = process.argv[2], label = process.argv[3];
if (!['chromium','webkit'].includes(engine) || !/^run\d+$/.test(label)) throw Error('identity required');
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const scan = p => fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?scan(p+'/'+e.name):[p+'/'+e.name]);
const refs = () => Object.fromEntries([...scan('src'), ...['fixture.tsx','index.html','serve.mjs','run.mjs','captures.json','oracle.json','author.docx','second.docx','generate-fixtures.py','generate-budget.py','budget-a.docx','budget-b.docx','budget-captures.json','budget-oracle.json'].map(n=>base+'/'+n), ...['supplement-capture.json','supplement-oracle.json','image-and-cell-barriers.docx'].map(n=>independent+'/'+n), 'package.json','pnpm-lock.yaml','vite.config.ts'].sort().map(p=>[p,hash(p)]));
const result = {schema:1,engine,label,scope:'Full production App and actual production DOCX Worker; controlled Tauri capture/check returns from independently authored synthetic OOXML. No native IO, installed App, real Agent, user data or external network.',before:refs(),checks:[],errors:[],externalRequests:[],screenshots:[],scenarios:[]};
const browser = await (engine==='webkit'?webkit:chromium).launch({headless:true,executablePath:engine==='webkit'?path.resolve('output/2026-10-10-text-feedback-webkit/browsers/webkit-2336/pw_run.sh'):'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
let page, scenario='start', baseline;
const check = (name,pass,detail) => {result.checks.push({scenario,name,pass:!!pass,...detail===undefined?{}:{detail}});if(!pass)throw Error(name);};
const count = (s,cmd) => s.calls.filter(c=>c.cmd===cmd).length;
const state = () => page.evaluate(()=>window.fixture.current());
const panel = () => page.getByRole('region',{name:'查找当前附件文件',exact:true});
const button = n => panel().getByRole('button',{name:n,exact:true});
const query = () => page.getByRole('textbox',{name:'搜索所选附件内容…',exact:true});
const scope = () => page.getByRole('combobox',{name:'搜索范围',exact:true});
const box = n => panel().getByRole('checkbox',{name:new RegExp('^'+n.replaceAll('.','\\.')+'\\s')});
const mode = m => page.evaluate(m=>window.fixture.mode(m),m);
async function load(name,seed={}){
  scenario=name;if(page)await page.close();page=await browser.newPage({viewport:{width:1100,height:820}});page.setDefaultTimeout(10000);
  page.on('pageerror',e=>result.errors.push({scenario,error:String(e)}));
  await page.route('**/*',r=>r.request().url().startsWith('http://127.0.0.1:1538/')?r.continue():(result.externalRequests.push(r.request().url()),r.abort()));
  await page.addInitScript(seed=>window.fixtureSeed=seed,seed);
  await page.goto('http://127.0.0.1:1538/'+base+'/index.html');
  await page.locator('.product-navigation').getByRole('button',{name:/所有对话/}).click();
  await scope().selectOption('attachments');await panel().waitFor();baseline=await state();
}
async function choose(names,q='needle'){for(const name of names)await box(name).check();await query().fill(q);}
async function start(){await button('开始查找附件').click();await page.waitForFunction(()=>window.fixture.current().search.phase==='complete'&&!window.fixture.current().busy);}
async function shot(name){const file=base+'/'+engine+'-'+label+'-'+name+'.png';await page.screenshot({path:file});result.screenshots.push({file,sha256:hash(file)});}
async function post(){const s=await state();check('No Agent or settings-write side effects',!s.calls.some(c=>/^(session_prompt|session_open|session_load|session_set_config|history_search_)/.test(c.cmd))&&s.unexpected.length===0&&count(s,'settings_set')===count(baseline,'settings_set'),{unexpected:s.unexpected});check('Existing drafts and feedback retained exactly',s.protectedUnchanged);result.scenarios.push({name:scenario,phase:s.search.phase,rows:s.search.rows,matches:s.search.matches,bytes:s.search.bytes,workers:s.workers,maxActive:s.maxActive,calls:s.calls.filter(c=>/^file_delivery_/.test(c.cmd))});}
try {
  await load('real-docx-worker-author-text');await choose(['author.docx']);let s=await state();
  check('Query and selection do not capture files or start Workers',count(s,'file_delivery_inspect_text')===0&&count(s,'file_delivery_read_docx_search')===0&&s.workers.length===0);
  await start();s=await state();
  check('Independently authored eight real text matches found',s.search.matches===8&&s.search.rows[0].state==='searched',{matches:s.search.matches,row:s.search.rows[0]});
  check('Production DOCX Worker parsed exact controlled capture',s.workers.length===1&&s.workers[0].messages.includes('ready')&&count(s,'file_delivery_read_docx_search')===1&&count(s,'file_delivery_read_text')===0);
  check('Every DOCX hit has a separate source location',s.search.hits.every(h=>h.location&&h.source.name==='author.docx'));
  check('Hidden marker and generated headings are absent from excerpts',s.search.hits.every(h=>!JSON.stringify([h.before,h.match,h.after]).includes('HIDDEN_ONLY')));
  check('Hostile author text stays inert',await panel().locator('img,script,iframe').count()===0&&await page.evaluate(()=>window.BAD===undefined));
  check('Partial scope is visibly explained without opening details',s.search.rows[0].document?.partial===true&&await panel().getByRole('status').getByText('仅查找已提取的作者文字，存在省略内容；没有匹配不代表完整文档没有匹配。',{exact:true}).isVisible());
  await page.setViewportSize({width:780,height:760});await button('开始查找附件').focus();
  check('Narrow layout fits and keyboard focus reaches start',await button('开始查找附件').evaluate(e=>document.activeElement===e)&&await panel().evaluate(e=>e.getBoundingClientRect().right<=innerWidth+1&&e.scrollWidth<=e.clientWidth+1));
  await panel().getByRole('heading',{name:'当前文件的匹配片段',exact:true}).scrollIntoViewIfNeeded();await shot('docx-results');
  await panel().getByRole('button',{name:'前往来源附件',exact:true}).first().click();await page.getByText('已定位到来源附件；文件匹配片段仍以本次查找为准。',{exact:true}).waitFor();
  check('Navigation reaches actual source attachment after file recheck',await page.locator('[data-loaded-message="A-message"].search-match').count()===1&&await page.locator('[data-loaded-message="A-message"] [data-loaded-attachment="0"]').isVisible());await shot('source-location');await post();

  await load('two-docx-one-parser');await choose(['author.docx','second.docx']);await start();s=await state();
  check('Two selected DOCX files both finish without self-contention',s.search.rows.length===2&&s.search.rows.every(r=>r.state==='searched')&&s.search.matches===9,{rows:s.search.rows,matches:s.search.matches});
  check('Both use real Workers and bounded admitted capture concurrency',s.workers.length===2&&s.workers.every(w=>w.messages.includes('ready'))&&s.maxActive<=2);await post();

  await load('omissions-and-synthetic-text-not-searchable');await choose(['author.docx']);
  for(const term of ['HIDDEN_ONLY','LEFTRIGHT','NOTELEFTNOTERIGHT','PARALEFTPARARIGHT','continuousLayout','headingLevel']){await query().fill(term);await start();s=await state();check('No false match for '+term,s.search.matches===0&&s.search.rows[0].state==='searched');}
  await post();

  await load('independent-image-cell-and-unicode');await choose(['image-and-cell-barriers.docx'],'汉😀é');await start();s=await state();
  check('Author Unicode matches and actual UTF8 budget excludes alt/labels',s.search.matches===1&&s.search.bytes===103,{matches:s.search.matches,bytes:s.search.bytes});
  check('Image omission remains explicit partial coverage',s.search.rows[0].document?.partial===true);
  for(const term of ['ALT_ONLY','IMAGELEFTIMAGERIGHT','NOTICELEFTNOTICERIGHT','CELLLEFTCELLRIGHT','TABLEFTTABRIGHT','BREAKLEFTBREAKRIGHT','paragraph','文档文字','图片未加入']){await query().fill(term);await start();s=await state();check('Independent supplement excludes '+term,s.search.matches===0&&s.search.rows[0].state==='searched');}
  await post();

  await load('text-control-with-docx');await choose(['author.docx','a.txt']);await start();s=await state();
  check('Existing UTF8 text search and new DOCX search share one result set',s.search.matches===10&&count(s,'file_delivery_read_text')===1&&count(s,'file_delivery_read_docx_search')===1&&s.search.rows.every(r=>r.state==='searched'));
  check('Text hit shape remains unchanged',s.search.hits.filter(h=>h.source.name==='a.txt').every(h=>h.location===undefined));await post();

  await load('compressed-docx-actual-author-budget',{budget:true});await choose(['budget-a.docx','budget-b.docx','a.txt']);await start();s=await state();
  const plainBytes=s.search.rows.find(r=>r.source.name==='a.txt').file.size;
  check('Compressed small DOCX counts actual nine-million UTF8 author bytes',s.search.rows[0].state==='searched'&&s.search.rows[1].state==='skipped'&&s.search.rows[1].code==='budget'&&s.search.rows[2].state==='searched'&&s.search.bytes===9000007+plainBytes&&s.search.matches===3,{bytes:s.search.bytes,matches:s.search.matches,rows:s.search.rows});
  check('Budget control uses both real production parsers',s.workers.length===2&&s.workers.every(w=>w.messages.includes('ready')));await post();

  await load('capture-source-version-mismatch');await choose(['author.docx']);await mode({captureChanged:true});await start();s=await state();
  check('Mismatched capture cannot parse or publish',s.search.hits.length===0&&s.search.rows[0].code==='changed'&&s.workers.length===0);await post();

  for(const mutation of ['sourceChange','indexChange']){
    await load('late-docx-'+mutation);await choose(['author.docx']);await mode({hold:true,stage:'capture'});await button('开始查找附件').click();await page.waitForFunction(()=>window.fixture.current().held===1);
    await page.evaluate(m=>window.fixture[m](),mutation);await page.evaluate(()=>window.fixture.release());await page.waitForFunction(()=>!window.fixture.current().busy);s=await state();
    check('Changed owner discards late DOCX before Worker or version-publication',s.search.hits.length===0&&s.workers.length===0&&count(s,'file_delivery_check_text_revision')===0);await post();
  }

  await load('cancel-capture');await choose(['author.docx']);await mode({hold:true,stage:'capture'});await button('开始查找附件').click();await page.waitForFunction(()=>window.fixture.current().held===1);await button('取消本次附件查找').click();
  check('Cancel does not dispatch another read',count(await state(),'file_delivery_read_docx_search')===1);await page.evaluate(()=>window.fixture.release());await page.waitForFunction(()=>!window.fixture.current().busy);s=await state();
  check('Cancelled capture publishes no hits and starts no Worker',s.search.hits.length===0&&s.workers.length===0);await post();

  await load('changed-before-navigation');await choose(['author.docx']);await start();await mode({changed:true});await panel().getByRole('button',{name:'前往来源附件',exact:true}).first().click();await panel().getByRole('alert').waitFor();s=await state();
  check('Revision mismatch removes stale DOCX results before navigation',s.search.hits.length===0&&await button('开始查找附件').isEnabled()&&s.search.error==='changed');await post();
} catch(error) {
  result.failure=String(error);if(page){result.diagnostic={scenario,body:await page.locator('body').innerText().catch(()=>''),aria:await page.locator('body').ariaSnapshot().catch(()=>''),state:await state().catch(()=>null)};await shot('failure').catch(()=>{});}
} finally {
  await browser.close();result.after=refs();result.stable=JSON.stringify(result.before)===JSON.stringify(result.after);result.passed=!result.failure&&result.stable&&!result.errors.length&&!result.externalRequests.length;
  fs.writeFileSync(base+'/'+engine+'-'+label+'.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({engine,label,passed:result.passed,checks:result.checks.length,failure:result.failure,errors:result.errors,externalRequests:result.externalRequests,stable:result.stable}));process.exitCode=result.passed?0:1;
}
