mod context;
#[path = "/Users/tw/Desktop/farfold/src-tauri/src/browser_workspace.rs"]
mod browser_workspace;

use serde_json::{Value, json};
use std::{ffi::c_void, io::Write, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{Listener, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder};

unsafe extern "C" {
    fn witness_capture(parent: *mut c_void) -> bool;
    fn witness_attached() -> bool;
    fn witness_ephemeral() -> bool;
    fn witness_has_no_user_scripts() -> bool;
    fn witness_release();
}
#[derive(Clone)]
struct ProbeState {
    output: PathBuf,
    mode: String,
    events: Arc<Mutex<Vec<Value>>>,
    report: Arc<Mutex<Value>>,
    cleanup: Arc<Mutex<Vec<Value>>>,
    finished: Arc<AtomicBool>,
}
fn require_main(view: &Webview) -> Result<(), String> {
    if browser_workspace::caller_allowed(view) { Ok(()) } else { Err("probe caller rejected".into()) }
}
#[tauri::command]
fn probe_latest(webview: Webview, state: State<ProbeState>) -> Result<Vec<Value>, String> {
    require_main(&webview)?;
    Ok(state.events.lock().unwrap().clone())
}
#[tauri::command]
async fn probe_capture(webview: Webview) -> Result<Value, String> {
    require_main(&webview)?;
    let parent=webview.app_handle().get_webview_window("main").ok_or("main missing")?;
    let (tx,rx)=tokio::sync::oneshot::channel();
    parent.with_webview(move |platform| {
        let result=unsafe { json!({"uniqueSibling":witness_capture(platform.inner()),"attached":witness_attached(),"ephemeral":witness_ephemeral(),"noUserScripts":witness_has_no_user_scripts()}) };
        let _=tx.send(result);
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(Duration::from_secs(3),rx).await.map_err(|_|"witness timeout")?.map_err(|_|"witness cancelled".into())
}
#[tauri::command]
async fn probe_attached(webview: Webview) -> Result<bool, String> {
    require_main(&webview)?;
    let (tx,rx)=tokio::sync::oneshot::channel();
    webview.app_handle().run_on_main_thread(move || {let _=tx.send(unsafe {witness_attached()});}).map_err(|e|e.to_string())?;
    tokio::time::timeout(Duration::from_secs(3),rx).await.map_err(|_|"witness timeout")?.map_err(|_|"witness cancelled".into())
}
#[tauri::command]
fn probe_done(webview: Webview, state: State<ProbeState>, report: Value) -> Result<(), String> {
    require_main(&webview)?;
    *state.report.lock().unwrap()=report;
    let app=webview.app_handle();
    if state.mode=="destroy" {
        app.get_webview_window("main").ok_or("main missing")?.destroy().map_err(|e|e.to_string())?;
    } else { app.exit(0); }
    Ok(())
}
const SCRIPT: &str=r#"(async()=>{
 if(window.__commandProbeStarted)return; window.__commandProbeStarted=true;
 const invoke=(name,args={})=>window.__TAURI_INTERNALS__.invoke(name,args);
 const report={workflowPass:false,steps:[],source:'unchanged production Rust command handlers',networkTarget:'https://example.com/'};
 const must=(value,label)=>{report.steps.push({label,pass:!!value});if(!value)throw new Error(label);};
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function ready(label){const until=Date.now()+20000;while(Date.now()<until){const events=await invoke('probe_latest');const event=events.filter(x=>x.label===label).at(-1);if(event?.phase==='ready')return event;if(event?.phase==='error'||event?.phase==='blocked')throw new Error('page '+event.phase+': '+event.error);await sleep(50);}throw new Error('ready event timeout');}
 try {
   const args={taskKey:'command-probe-task',url:'https://example.com/',bounds:{x:20,y:90,width:600,height:280}};
   const opened=await invoke('browser_workspace_open',args);report.opened=opened;
   must(opened.taskKey===args.taskKey&&!!opened.label,'actual main invoke open');
   report.ready=await ready(opened.label);must(report.ready.phase==='ready','actual native ready event');
   report.witness=await invoke('probe_capture');must(report.witness.uniqueSibling&&report.witness.attached&&report.witness.ephemeral&&report.witness.noUserScripts,'independent ephemeral sibling');
   report.snapshot=await invoke('browser_workspace_snapshot',{taskKey:args.taskKey,label:opened.label});
   must(report.snapshot.url==='https://example.com/'&&report.snapshot.title.length>0&&report.snapshot.text.length>0&&report.snapshot.label===opened.label,'actual WK snapshot returned through command');
   await invoke('browser_workspace_close',{taskKey:args.taskKey,label:opened.label});
   must(!(await invoke('probe_attached')),'close ACK after native detachment');
   let staleRejected=false;try{await invoke('browser_workspace_snapshot',{taskKey:args.taskKey,label:opened.label});}catch(error){staleRejected=true;report.staleError=String(error);}
   must(staleRejected,'closed owner cannot read');
   report.reopened=await invoke('browser_workspace_open',args);report.secondReady=await ready(report.reopened.label);
   must(report.reopened.label!==opened.label,'fresh owner after acknowledged close');
   report.exitWitness=await invoke('probe_capture');must(report.exitWitness.attached&&report.exitWitness.uniqueSibling,'active browser exists before lifecycle cleanup');
   report.workflowPass=true;
 } catch(error) {report.error=String(error);}
 await invoke('probe_done',{report});
})()"#;

fn main() {
    let args:Vec<String>=std::env::args().collect();
    assert!(args.len()==3 && ["destroy","exit"].contains(&args[2].as_str()),"usage: command-probe NEW_RESULT_JSON destroy|exit");
    let output=PathBuf::from(&args[1]);
    assert!(output.is_absolute() && !output.exists() && output.parent().unwrap().canonicalize().unwrap().starts_with("/Users/tw/Documents/Codex/2026-10-03/task-3/browser-integration-20261004/command-validation/results") && output.extension().is_some_and(|x|x=="json"),"new probe result path required");
    let state=ProbeState{output,mode:args[2].clone(),events:Default::default(),report:Arc::new(Mutex::new(json!({"workflowPass":false,"error":"no main report"}))),cleanup:Default::default(),finished:Default::default()};
    let setup_state=state.clone();
    let app=tauri::Builder::default()
        .manage(state.clone())
        .manage(browser_workspace::BrowserWorkspace::default())
        .invoke_handler(|invoke| {
            if !browser_workspace::caller_allowed(invoke.message.webview_ref()) {invoke.resolver.reject("此页面不能操作应用");return true;}
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>)->bool=tauri::generate_handler![browser_workspace::browser_workspace_open,browser_workspace::browser_workspace_navigate,browser_workspace::browser_workspace_resize,browser_workspace::browser_workspace_snapshot,browser_workspace::browser_workspace_close,probe_latest,probe_capture,probe_attached,probe_done];
            handler(invoke)
        })
        .setup(move |app| {
            let events=setup_state.events.clone();
            app.listen_any("browser-workspace:state",move |event| {
                if let Ok(value)=serde_json::from_str::<Value>(event.payload()) {events.lock().unwrap().push(value);}
            });
            WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into()))
                .title("Controlled production-command probe — example.com only")
                .inner_size(680.0,440.0).incognito(true).visible(true)
                .on_navigation(|url|url.scheme()=="tauri"&&url.host_str()==Some("localhost"))
                .on_page_load(|view,payload| {if matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){let _=view.eval(SCRIPT);}})
                .build()?;
            let app_handle=app.handle().clone();let timeout_state=setup_state.clone();
            std::thread::spawn(move || {std::thread::sleep(Duration::from_secs(55));if !timeout_state.finished.load(Ordering::SeqCst){*timeout_state.report.lock().unwrap()=json!({"workflowPass":false,"error":"bounded probe timeout"});app_handle.exit(2);}});
            Ok(())
        }).build(context::context()).expect("isolated memory context build");
    app.run(move |app,event| {
        browser_workspace::handle_run_event(app,&event);
        let label=match &event {tauri::RunEvent::Exit=>Some("Exit"),tauri::RunEvent::WindowEvent{label,event:tauri::WindowEvent::Destroyed,..} if label=="main"=>Some("main Destroyed"),_=>None};
        if let Some(event_name)=label {
            state.cleanup.lock().unwrap().push(json!({"event":event_name,"nativeDetached":unsafe {!witness_attached()}}));
        }
        if matches!(event,tauri::RunEvent::Exit) && !state.finished.swap(true,Ordering::SeqCst) {
            let report=state.report.lock().unwrap().clone();let events=state.events.lock().unwrap().clone();let cleanup=state.cleanup.lock().unwrap().clone();
            let expected=if state.mode=="destroy" {"main Destroyed"}else{"Exit"};
            let cleanup_ok=cleanup.iter().any(|x|x["event"]==expected&&x["nativeDetached"]==true);
            let result=json!({"pass":report["workflowPass"]==true&&cleanup_ok,"mode":state.mode,"report":report,"productionEvents":events,"cleanup":cleanup,"productionSetupUsed":false,"nonPersistent":true});
            unsafe {witness_release();}
            match std::fs::OpenOptions::new().create_new(true).write(true).open(&state.output).and_then(|mut f|f.write_all(&serde_json::to_vec_pretty(&result).unwrap())) {
                Ok(())=>eprintln!("COMMAND_PROBE_RESULT pass={} mode={}",result["pass"],state.mode),Err(e)=>eprintln!("COMMAND_PROBE_WRITE_ERROR {e}")
            }
        }
    });
}
