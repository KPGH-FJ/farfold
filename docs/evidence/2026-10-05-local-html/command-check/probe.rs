mod browser_sharing;
#[path = "/Users/tw/Desktop/farfold/src-tauri/src/file_delivery.rs"]
mod file_delivery;
#[path = "/Users/tw/Desktop/farfold/src-tauri/src/file_delivery_commands.rs"]
mod file_delivery_commands;
#[path = "/Users/tw/Desktop/farfold/src-tauri/src/browser_workspace.rs"]
mod browser_workspace;
mod context;
mod acp_client {
    #[path = "/Users/tw/Desktop/farfold/src-tauri/src/acp_client/transient_mcp.rs"]
    pub(crate) mod transient_mcp;
}

use agent_client_protocol::schema::v1::McpServer;
use serde_json::{Value, json};
use std::{
    ffi::c_void,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use tauri::{Listener, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder};
type Exchange = (Value, mpsc::SyncSender<Result<Value, String>>);

unsafe extern "C" {
    fn witness_hidden() -> bool;
    fn witness_capture(parent: *mut c_void) -> bool;
    fn witness_attached() -> bool;
    fn witness_ephemeral() -> bool;
    fn witness_has_no_user_scripts() -> bool;
    fn witness_evaluate(
        context: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, bool),
    );
    fn witness_release();
}
#[derive(Clone)]
struct ProbeState {
    output: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
    report: Arc<Mutex<Value>>,
    finished: Arc<AtomicBool>,
    requests: Arc<Mutex<Option<mpsc::Sender<Exchange>>>>,
    input: Arc<Mutex<Option<Arc<Mutex<std::process::ChildStdin>>>>>,
    child: Arc<Mutex<Option<Child>>>,
    endpoint: Arc<Mutex<Option<PathBuf>>>,
    route: Arc<Mutex<Option<acp_client::transient_mcp::SessionMcpLease>>>,
}
fn require_main(view: &Webview) -> Result<(), String> {
    if browser_workspace::caller_allowed(view) {
        Ok(())
    } else {
        Err("probe caller rejected".into())
    }
}
#[tauri::command]
fn probe_latest(webview: Webview, state: State<ProbeState>) -> Result<Vec<Value>, String> {
    require_main(&webview)?;
    Ok(state.events.lock().unwrap().clone())
}
#[tauri::command]
async fn probe_capture(webview: Webview) -> Result<Value, String> {
    require_main(&webview)?;
    let parent = webview
        .app_handle()
        .get_webview_window("main")
        .ok_or("main missing")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    parent.with_webview(move |platform| {
        let result=unsafe { json!({"uniqueSibling":witness_capture(platform.inner()),"attached":witness_attached(),"ephemeral":witness_ephemeral(),"noUserScripts":witness_has_no_user_scripts()}) };
        let _=tx.send(result);
    }).map_err(|_|"witness dispatch failed")?;
    tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .map_err(|_| "witness timeout")?
        .map_err(|_| "witness cancelled".into())
}
unsafe extern "C" fn changed(context: *mut c_void, success: bool) {
    let sender = unsafe { Box::from_raw(context.cast::<tokio::sync::oneshot::Sender<bool>>()) };
    let _ = sender.send(success);
}
#[tauri::command]
async fn probe_evaluate(webview: Webview) -> Result<bool, String> {
    require_main(&webview)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview.app_handle().run_on_main_thread(move || unsafe {
        witness_evaluate(Box::into_raw(Box::new(tx)).cast(), changed);
    }).map_err(|_| "evaluation dispatch failed")?;
    tokio::time::timeout(Duration::from_secs(3), rx).await.map_err(|_| "evaluation timeout")?.map_err(|_| "evaluation cancelled".into())
}
#[tauri::command]
async fn probe_hidden(webview: Webview) -> Result<bool, String> {
    require_main(&webview)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview.app_handle().run_on_main_thread(move || { let _ = tx.send(unsafe {witness_hidden()}); }).map_err(|_| "hidden dispatch failed")?;
    tokio::time::timeout(Duration::from_secs(3), rx).await.map_err(|_| "hidden timeout")?.map_err(|_| "hidden cancelled".into())
}
const FIXTURE_ROOT: &str = "/Users/tw/Documents/Codex/2026-10-03/task-3/html-preview-20261005/command-check/fixture";
const FIXTURE_BODY: &str = "<!doctype html><html><head><meta charset='utf-8'><title>LOCAL_HTML_COMMAND_FIXTURE</title></head><body><button id='counter'>increment</button><output id='count'>0</output><canvas id='canvas' width='30' height='30'></canvas><script>window.fixtureLoaded=true;document.getElementById('counter').onclick=()=>document.getElementById('count').textContent='1';document.getElementById('canvas').getContext('2d').fillRect(0,0,10,10);</script></body></html>";
#[tauri::command]
fn probe_fixture(webview: Webview) -> Result<Value, String> {
    require_main(&webview)?;
    Ok(json!({"root":FIXTURE_ROOT,"path":format!("{FIXTURE_ROOT}/controlled.html")}))
}
#[tauri::command]
fn probe_mutate_fixture(webview: Webview) -> Result<bool, String> {
    require_main(&webview)?;
    std::fs::write(format!("{FIXTURE_ROOT}/controlled.html"), format!("{FIXTURE_BODY}<!-- CHANGED_RECEIPT -->")).map_err(|_|"fixture write failed")?;
    Ok(true)
}
#[tauri::command]
async fn probe_attached(webview: Webview) -> Result<bool, String> {
    require_main(&webview)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview
        .app_handle()
        .run_on_main_thread(move || {
            let _ = tx.send(unsafe { witness_attached() });
        })
        .map_err(|_| "witness dispatch failed")?;
    tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .map_err(|_| "witness timeout")?
        .map_err(|_| "witness cancelled".into())
}
#[tauri::command]
fn probe_connect(webview: Webview, state: State<ProbeState>) -> Result<Value, String> {
    require_main(&webview)?;
    if state.requests.lock().unwrap().is_some() {
        return Err("one connection only".into());
    }
    let app = webview.app_handle();
    let mut offer = app.state::<browser_sharing::BrowserSharing>().prepare(
        app,
        "controlled",
        Path::new("/tmp"),
    )?;
    // Consume exactly the official, typed stdio fields. Never print or persist them.
    let mut params = acp_client::transient_mcp::session_params(
        Path::new("/tmp"),
        Some("controlled-session"),
        Some(&offer),
    );
    let servers: Vec<McpServer> = serde_json::from_value(params["mcpServers"].take())
        .map_err(|_| "official MCP fields failed to decode")?;
    let [McpServer::Stdio(server)] = servers.as_slice() else {
        return Err("expected one typed stdio server".into());
    };
    let endpoint = server
        .args
        .get(1)
        .map(PathBuf::from)
        .ok_or("controlled endpoint missing")?;
    if !endpoint.is_absolute() || endpoint.file_name().is_none_or(|name| name != "mcp.sock") {
        return Err("unexpected controlled endpoint".into());
    }
    *state.endpoint.lock().unwrap() = Some(endpoint);
    let mut command = Command::new(&server.command);
    command
        .args(&server.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for env in &server.env {
        command.env(&env.name, &env.value);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "controlled helper spawn failed")?;
    let input = Arc::new(Mutex::new(child.stdin.take().ok_or("helper input missing")?));
    *state.input.lock().unwrap() = Some(input.clone());
    let mut output = BufReader::new(child.stdout.take().ok_or("helper output missing")?);
    let route = offer.bind_route("controlled-session")?;
    offer.finish_opening();
    *state.route.lock().unwrap() = Some(route);
    *state.child.lock().unwrap() = Some(child);
    let (tx, rx) = mpsc::channel::<Exchange>();
    *state.requests.lock().unwrap() = Some(tx);
    std::thread::spawn(move || {
        for (request, response) in rx {
            let outcome = (|| {
                let bytes = serde_json::to_vec(&request).map_err(|_| "request encoding failed")?;
                {
                    let mut input = input.lock().unwrap();
                    input.write_all(&bytes)
                        .and_then(|_| input.write_all(b"\n"))
                        .and_then(|_| input.flush())
                        .map_err(|_| "MCP input closed")?;
                }
                if request.get("id").is_none() {
                    return Ok(json!({"notificationSent":true}));
                }
                let mut line = String::new();
                output
                    .read_line(&mut line)
                    .map_err(|_| "MCP output failed")?;
                if line.len() > 650_000 {
                    return Err("MCP output too large".into());
                }
                serde_json::from_str(&line).map_err(|_| "MCP output ended or invalid".into())
            })();
            let _ = response.send(outcome);
        }
    });
    Ok(
        json!({"typedStdioServers":1,"sameExecutableEarlyHelper":true,"routeRetained":true,"secretsPersisted":false}),
    )
}
#[tauri::command]
async fn probe_mcp(
    webview: Webview,
    state: State<'_, ProbeState>,
    request: Value,
) -> Result<Value, String> {
    require_main(&webview)?;
    let tx = state
        .requests
        .lock()
        .unwrap()
        .clone()
        .ok_or("MCP not connected")?;
    tauri::async_runtime::spawn_blocking(move || {
        let (answer, receive) = mpsc::sync_channel(1);
        tx.send((request, answer))
            .map_err(|_| "MCP request worker ended")?;
        receive
            .recv_timeout(Duration::from_secs(12))
            .map_err(|_| "MCP response deadline")?
    })
    .await
    .map_err(|_| "MCP request worker failed")?
}
#[tauri::command]
fn probe_cancel(webview: Webview, state: State<ProbeState>, request_id: u64) -> Result<(), String> {
    require_main(&webview)?;
    let holder = state.input.lock().unwrap().clone().ok_or("MCP not connected")?;
    let mut input = holder.lock().unwrap();
    let bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":request_id}})).map_err(|_| "encode failed")?;
    input.write_all(&bytes).and_then(|_| input.write_all(b"\n")).and_then(|_| input.flush()).map_err(|_| "MCP notify failed".into())
}

#[tauri::command]
async fn probe_disconnect(webview: Webview, state: State<'_, ProbeState>) -> Result<Value, String> {
    require_main(&webview)?;
    webview
        .app_handle()
        .state::<browser_sharing::BrowserSharing>()
        .shutdown();
    state.route.lock().unwrap().take();
    state.requests.lock().unwrap().take();
    state.input.lock().unwrap().take();
    let mut child = state
        .child
        .lock()
        .unwrap()
        .take()
        .ok_or("controlled helper missing")?;
    let endpoint = state
        .endpoint
        .lock()
        .unwrap()
        .take()
        .ok_or("controlled endpoint missing")?;
    tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..60 {
            if let Some(status) = child.try_wait().map_err(|_| "helper wait failed")? {
                let parent = endpoint
                    .parent()
                    .ok_or("controlled endpoint parent missing")?;
                let absent = |path: &Path| {
                    std::fs::symlink_metadata(path)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                };
                for _ in 0..20 {
                    if absent(&endpoint) && absent(parent) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                return Ok(
                    json!({"helperExited":true,"helperExitCode":status.code(),"forced":false,
                    "socketRemoved":absent(&endpoint),"socketDirectoryRemoved":absent(parent)}),
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        Err("controlled helper did not exit within cleanup deadline".into())
    })
    .await
    .map_err(|_| "helper cleanup worker failed")?
}
#[tauri::command]
fn probe_done(webview: Webview, state: State<ProbeState>, report: Value) -> Result<(), String> {
    require_main(&webview)?;
    *state.report.lock().unwrap() = report;
    webview.app_handle().exit(0);
    Ok(())
}
const SCRIPT: &str = include_str!("workflow.js");
fn main() {
    if let Some(code) = browser_sharing::run_helper_if_requested() {
        std::process::exit(code);
    }
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() == 2, "usage: html-command-probe NEW_RESULT_JSON");
    std::fs::write(format!("{FIXTURE_ROOT}/controlled.html"), FIXTURE_BODY).expect("write synthetic HTML");
    let output = PathBuf::from(&args[1]);
    assert!(output.is_absolute() && !output.exists() && output.parent().unwrap().canonicalize().unwrap().starts_with("/Users/tw/Documents/Codex/2026-10-03/task-3/html-preview-20261005/command-check/results"),"new result path required");
    let state = ProbeState {
        output,
        events: Default::default(),
        report: Arc::new(Mutex::new(
            json!({"workflowPass":false,"error":"no main report"}),
        )),
        finished: Default::default(),
        requests: Default::default(),
        input: Default::default(),
        child: Default::default(),
        endpoint: Default::default(),
        route: Default::default(),
    };
    let setup_state = state.clone();
    let app = tauri::Builder::default()
        .manage(state.clone())
        .manage(browser_workspace::BrowserWorkspace::default())
        .manage(browser_sharing::BrowserSharing::default())
        .invoke_handler(|invoke| {
            if !browser_workspace::caller_allowed(invoke.message.webview_ref()) {
                invoke.resolver.reject("此页面不能操作应用");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                browser_workspace::browser_workspace_open,
                browser_workspace::browser_workspace_open_html,
                file_delivery_commands::file_delivery_inspect,
                file_delivery_commands::file_delivery_inspect_selected,
                file_delivery_commands::file_delivery_read_text,
                file_delivery_commands::file_delivery_copy,
                file_delivery_commands::file_delivery_export_text,
                file_delivery_commands::file_delivery_open,
                file_delivery_commands::file_delivery_reveal,
                browser_workspace::browser_workspace_navigate,
                browser_workspace::browser_workspace_resize,
                browser_workspace::browser_workspace_set_visible,
                browser_workspace::browser_workspace_snapshot,
                browser_workspace::browser_workspace_close,
                browser_sharing::browser_share_status,
                browser_sharing::browser_share_allow,
                browser_sharing::browser_share_respond,
                browser_sharing::browser_share_stop,
                probe_latest,
                probe_capture,
                probe_evaluate,
                probe_hidden,
                probe_fixture,
                probe_mutate_fixture,
                probe_attached,
                probe_connect,
                probe_mcp,
                probe_cancel,
                probe_disconnect,
                probe_done
            ];
            handler(invoke)
        })
        .setup(move |app| {
            let events = setup_state.events.clone();
            app.listen_any("browser-workspace:state", move |event| {
                if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                    events.lock().unwrap().push(value);
                }
            });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Controlled local HTML command probe")
                .inner_size(680.0, 440.0)
                .incognito(true)
                .visible(false)
                .focused(false)
                .position(-16000.0, -16000.0)
                .on_navigation(|url| url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                .on_page_load(|view, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let _ = view.eval(SCRIPT);
                    }
                })
                .build()?;
            let app_handle = app.handle().clone();
            let timeout_state = setup_state.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(55));
                if !timeout_state.finished.load(Ordering::SeqCst) {
                    *timeout_state.report.lock().unwrap() =
                        json!({"workflowPass":false,"error":"bounded probe timeout"});
                    app_handle.exit(2);
                }
            });
            Ok(())
        })
        .build(context::context())
        .expect("isolated memory context build");
    app.run(move |app,event| {
        if matches!(event,tauri::RunEvent::Exit) { app.state::<browser_sharing::BrowserSharing>().shutdown(); }
        browser_workspace::handle_run_event(app,&event);
        if matches!(event,tauri::RunEvent::Exit) && !state.finished.swap(true,Ordering::SeqCst) {
            let report=state.report.lock().unwrap().clone();
            let detached=unsafe {!witness_attached()};
            let result=json!({"pass":report["workflowPass"]==true&&detached,"report":report,"productionEvents":state.events.lock().unwrap().clone(),"nativeDetached":detached,"productionSetupUsed":false,"realAgentUsed":false,"nonPersistent":true,"networkUsed":false});
            unsafe {witness_release();}
            match std::fs::OpenOptions::new().create_new(true).write(true).open(&state.output).and_then(|mut f|f.write_all(&serde_json::to_vec_pretty(&result).unwrap())) {
                Ok(())=>eprintln!("SHARING_PROBE_RESULT pass={}",result["pass"]),Err(_)=>eprintln!("SHARING_PROBE_WRITE_ERROR")
            }
        }
    });
}
