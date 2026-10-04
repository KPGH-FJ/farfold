mod context;
use std::{ffi::{c_char,c_void,CStr},io::Write,path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,SystemTime,UNIX_EPOCH}};
use tauri::{Manager,State,Webview,WebviewWindowBuilder,WebviewUrl,ipc::Channel};
use serde_json::{Value,json};

unsafe extern "C" { fn ff_seam_start(parent:*mut c_void,context:*mut c_void,result:extern "C" fn(*mut c_void,*const c_char)); }
#[derive(Clone)]
struct ProbeState { output:PathBuf,request_id:String,task_key:String,label:String,revision:u64,started:Arc<AtomicBool>,finished:Arc<AtomicBool>,parent_report:Arc<Mutex<Value>> }
struct NativeContext { app:tauri::AppHandle,state:ProbeState }
fn finish(app:&tauri::AppHandle,state:&ProbeState,mut result:Value) {
    if state.finished.swap(true,Ordering::SeqCst) { return; }
    let report=state.parent_report.lock().unwrap().clone();
    result["parent"]=report.clone();
    result["requestId"]=json!(state.request_id);
    result["taskKey"]=json!(state.task_key);
    result["label"]=json!(state.label);
    result["revision"]=json!(state.revision);
    result["observedAtMs"]=json!(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64);
    for key in ["url","title","text"] {result[key]=result["snapshot"][key].clone();}
    let native_ok=result["pass"]==true;
    result["pass"]=json!(native_ok && report["invokeRoundTrip"]==true && report["channelRoundTrip"]==true);
    let success=result["pass"]==true;
    let serialized=serde_json::to_vec_pretty(&result).unwrap();
    match std::fs::OpenOptions::new().create_new(true).write(true).open(&state.output).and_then(|mut file|file.write_all(&serialized)) {
        Ok(())=>eprintln!("PROBE_RESULT pass={success} output={}",state.output.display()),
        Err(error)=>{eprintln!("PROBE_RESULT_WRITE_FAILED {error}");app.exit(3);return;}
    }
    app.exit(if success {0} else {2});
}
extern "C" fn native_result(context:*mut c_void,text:*const c_char) {
    let context=unsafe {Box::from_raw(context.cast::<NativeContext>())};
    let result=if text.is_null() {json!({"pass":false,"error":"native returned no result"})} else {
        serde_json::from_slice(unsafe {CStr::from_ptr(text)}.to_bytes()).unwrap_or_else(|_|json!({"pass":false,"error":"invalid native JSON"}))
    };
    finish(&context.app,&context.state,result);
}
fn is_local_main(webview:&Webview)->bool {
    webview.label()=="main" && webview.url().is_ok_and(|url|url.scheme()=="tauri" && url.host_str()==Some("localhost"))
}
#[tauri::command]
fn probe_parent(webview:Webview,channel:Channel<String>)->Result<String,String> {
    if !is_local_main(&webview) {return Err("probe caller rejected".into());}
    // This payload and channel belong only to this probe. The >8 KiB payload
    // exercises Tauri's real channel-fetch path without touching any other app.
    channel.send(format!("SEAM_CHANNEL_CANARY:{}","x".repeat(9000))).map_err(|e|e.to_string())?;
    Ok("SEAM_INVOKE_CANARY".into())
}
#[tauri::command]
fn probe_ready(webview:Webview,state:State<ProbeState>,report:Value)->Result<(),String> {
    if !is_local_main(&webview) {return Err("probe caller rejected".into());}
    if state.started.swap(true,Ordering::SeqCst) {return Err("probe already started".into());}
    *state.parent_report.lock().unwrap()=report;
    let app=webview.app_handle().clone();
    let parent=app.get_webview_window("main").ok_or("probe main missing")?;
    let boxed=Box::new(NativeContext{app:app.clone(),state:state.inner().clone()});
    let pointer=Box::into_raw(boxed) as usize;
    parent.with_webview(move |platform|unsafe {ff_seam_start(platform.inner(),pointer as *mut c_void,native_result)}).map_err(|e|e.to_string())
}
const PARENT_SCRIPT:&str=r#"(()=>{
 if(window.__seamStarted)return; window.__seamStarted=true;
 const report={bridgePresent:!!window.__TAURI_INTERNALS__,invokeRoundTrip:false,channelRoundTrip:false};
 const core=window.__TAURI_INTERNALS__; if(!core)return;
 const done=()=>{if(report.invokeRoundTrip&&report.channelRoundTrip)core.invoke('probe_ready',{report});};
 const id=core.transformCallback(event=>{const value=event.message;if(typeof value==='string'&&value.startsWith('SEAM_CHANNEL_CANARY:')&&value.length===9020){report.channelRoundTrip=true;done();}});
 core.invoke('probe_parent',{channel:'__CHANNEL__:'+id}).then(value=>{report.invokeRoundTrip=value==='SEAM_INVOKE_CANARY';done();}).catch(error=>{document.body.textContent='Probe invoke failed';});
})()"#;
fn main() {
    let args:Vec<String>=std::env::args().collect();
    if args.len()!=6 {eprintln!("usage: seam-probe OUTPUT_JSON REQUEST_ID TASK_KEY LABEL REVISION");std::process::exit(64);}
    let output=PathBuf::from(&args[1]);
    let allowed=PathBuf::from("/Users/tw/Documents/Codex/2026-10-03/task-3");
    let output_parent=output.parent().and_then(|p|p.canonicalize().ok()).expect("existing output parent required");
    assert!(output.is_absolute() && output_parent.starts_with(&allowed) && !output.exists() && output.extension().is_some_and(|x|x=="json"),"output must be a new task-3 JSON path");
    for value in &args[2..5] {assert!(!value.is_empty()&&value.len()<=256&&!value.chars().any(char::is_control),"invalid probe identity");}
    let revision=args[5].parse::<u64>().expect("revision integer");
    let state=ProbeState{output,request_id:args[2].clone(),task_key:args[3].clone(),label:args[4].clone(),revision,started:Arc::new(AtomicBool::new(false)),finished:Arc::new(AtomicBool::new(false)),parent_report:Arc::new(Mutex::new(json!({})))};
    let setup_state=state.clone();
    let app=tauri::Builder::default()
      .manage(state)
      .invoke_handler(tauri::generate_handler![probe_parent,probe_ready])
      .setup(move |app|{
        let window=WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into()))
          .title("Controlled browser seam probe — synthetic content")
          .inner_size(680.0,440.0).incognito(true).visible(true)
          .on_navigation(|url|url.scheme()=="tauri"&&url.host_str()==Some("localhost"))
          .on_page_load(|view,payload|{if matches!(payload.event(),tauri::webview::PageLoadEvent::Finished){let _=view.eval(PARENT_SCRIPT);}})
          .build()?;
        let _=window;
        let app_handle=app.handle().clone();
        std::thread::spawn(move || {std::thread::sleep(Duration::from_secs(15));finish(&app_handle,&setup_state,json!({"pass":false,"error":"probe timed out"}));});
        Ok(())
      }).build(context::context()).expect("isolated Tauri probe build");
    app.run(|_,_|{});
}
